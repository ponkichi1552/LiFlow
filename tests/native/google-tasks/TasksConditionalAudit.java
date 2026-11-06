package jp.jphacks.tkb2633.tasksaudit;

import android.accounts.Account;
import android.app.Activity;
import android.app.Application;
import android.app.Instrumentation;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.util.Base64;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;
import com.google.android.gms.tasks.Tasks;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Explicit real-provider probe. No credential or personal payload is exported or written. */
public final class TasksConditionalAudit extends Instrumentation {
  private static final String SCOPE = "https://www.googleapis.com/auth/tasks";
  private String token;
  private final Bundle result = new Bundle();
  private int staleStatus = -1;
  private boolean preserved;
  private boolean freshDeleted;
  private boolean cleaned;
  @Override public void callApplicationOnCreate(Application application) {
    // This provider-only probe needs the existing target Context/UID, not a
    // React Native launch. Keep the test APK's unshrunk dependency classes out
    // of the application's R8-internal startup and do not start business work.
  }
  @Override public void onCreate(Bundle args) {
    super.onCreate(args);
    start();
  }
  @Override public void onStart() {
    String listId = null; String title = "LiFlow conditional-delete QA " + UUID.randomUUID();
    String stage = "target_context";
    try {
      Context context = getTargetContext();
      if (!"jp.jphacks.tkb2633".equals(context.getPackageName())) throw new IllegalStateException();
      // Read the SDK's existing encrypted account selection in this same signer/UID.
      // Never create/delete a key, change the selection, or request interactive consent.
      KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
      stage = "existing_keystore";
      if (!store.containsAlias("google_signin_secure_key")) throw new IllegalStateException();
      SecretKey key = (SecretKey) store.getKey("google_signin_secure_key", null);
      SharedPreferences preferences = context.getSharedPreferences("google_signin_prefs", Context.MODE_PRIVATE);
      stage = "existing_account_selection";
      String user = decrypt(key, preferences.getString(hash("last_signed_in_user_id"), null));
      String email = decrypt(key, preferences.getString(hash(user), null));
      if (!email.contains("@")) throw new IllegalStateException();
      AuthorizationRequest request = AuthorizationRequest.builder().setRequestedScopes(Collections.singletonList(new Scope(SCOPE)))
        .setAccount(new Account(email, "com.google")).build();
      stage = "existing_authorization";
      AuthorizationResult auth = Tasks.await(Identity.getAuthorizationClient(context).authorize(request), 20, TimeUnit.SECONDS);
      if (auth.hasResolution() || auth.getAccessToken() == null || auth.getAccessToken().isEmpty()) {
        result.putString("authorization", "existing_grant_unavailable");
        return;
      }
      token = auth.getAccessToken(); result.putString("authorization", "existing_grant_only");
      stage = "synthetic_list_creation";
      Response list = request("POST", "/users/@me/lists", new JSONObject().put("title", title), null);
      if ((list.code != 200 && list.code != 201) || !title.equals(list.body.optString("title"))) throw new IllegalStateException();
      listId = list.body.getString("id"); if (listId.isEmpty()) throw new IllegalStateException();
      String base = "/lists/" + encode(listId) + "/tasks";
      stage = "synthetic_task_creation";
      Response task = request("POST", base, new JSONObject().put("title", "LiFlow synthetic concurrency probe"), null);
      if (task.code != 200 && task.code != 201) throw new IllegalStateException();
      String id = task.body.getString("id"); String path = base + "/" + encode(id);
      Response before = request("GET", path, null, null); String etag = before.body.getString("etag");
      if (before.code != 200 || !strong(etag)) throw new IllegalStateException();
      Response complete = request("PATCH", path, new JSONObject().put("status", "completed"), null);
      if (complete.code != 200) throw new IllegalStateException();
      Response intervening = request("GET", path, null, null);
      if (intervening.code != 200 || !"completed".equals(intervening.body.optString("status"))
        || etag.equals(intervening.body.optString("etag"))) throw new IllegalStateException();
      stage = "conditional_delete";
      staleStatus = request("DELETE", path, null, etag).code;
      Response after = request("GET", path, null, null);
      preserved = after.code == 200 && !after.body.optBoolean("deleted") && "completed".equals(after.body.optString("status"));
      if (staleStatus == 412 && preserved && strong(after.body.optString("etag"))) freshDeleted = request("DELETE", path, null, after.body.getString("etag")).code == 204;
    } catch (Throwable error) {
      // Exception text and provider bodies can contain credentials or account labels.
      result.putString("probe", "incomplete");
      result.putString("stage", stage);
      result.putString("errorClass", error.getClass().getSimpleName());
    } finally {
      if (listId != null && token != null) try {
        String path = "/users/@me/lists/" + encode(listId); Response own = request("GET", path, null, null);
        if (own.code == 200 && listId.equals(own.body.optString("id")) && title.equals(own.body.optString("title"))) cleaned = request("DELETE", path, null, null).code == 204;
      } catch (Exception ignored) { /* Keep an uncertain synthetic list. */ }
      token = null;
      result.putInt("staleDeleteStatus", staleStatus); result.putBoolean("completionPreserved", preserved);
      result.putBoolean("freshDeleteSucceeded", freshDeleted); result.putBoolean("cleanupSucceeded", cleaned);
      result.putString("result", staleStatus == 412 && preserved && freshDeleted && cleaned ? "PASS" : "NOT_PASS");
      finish(Activity.RESULT_OK, result);
    }
  }
  private static String hash(String value) throws Exception {
    byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
    // Match the installed SDK's storage-key encoding; no credential value leaves this UID.
    return Base64.encodeToString(bytes, Base64.NO_WRAP | Base64.URL_SAFE | Base64.NO_PADDING);
  }
  private static String decrypt(SecretKey key, String text) throws Exception {
    if (text == null) throw new IllegalStateException(); String[] parts = text.split(":"); if (parts.length != 2) throw new IllegalStateException();
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
    return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
  }
  private static String encode(String value) throws Exception { return URLEncoder.encode(value, "UTF-8").replace("+", "%20"); }
  private static boolean strong(String value) { return value != null && value.matches("\"[\\x21\\x23-\\x7e]{1,500}\""); }
  private static final class Response { int code; JSONObject body = new JSONObject(); }
  private Response request(String method, String path, JSONObject body, String etag) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL("https://tasks.googleapis.com/tasks/v1" + path).openConnection();
    try {
      connection.setConnectTimeout(15000); connection.setReadTimeout(15000); connection.setInstanceFollowRedirects(false); connection.setRequestMethod(method);
      connection.setRequestProperty("Authorization", "Bearer " + token); if (etag != null) connection.setRequestProperty("If-Match", etag);
      if (body != null) { byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8); connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json"); connection.setFixedLengthStreamingMode(bytes.length);
        try (java.io.OutputStream stream = connection.getOutputStream()) { stream.write(bytes); } }
      Response result = new Response(); result.code = connection.getResponseCode();
      if (result.code >= 200 && result.code < 300 && result.code != 204) try (InputStream stream = connection.getInputStream()) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int count;
        while ((count = stream.read(buffer)) != -1) { if (bytes.size() + count > 32768) throw new IllegalStateException(); bytes.write(buffer, 0, count); }
        result.body = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
      }
      return result;
    } finally { connection.disconnect(); }
  }
}
