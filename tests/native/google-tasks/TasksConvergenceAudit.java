package jp.jphacks.tkb2633.tasksconvergence;

import android.accounts.Account;
import android.app.Activity;
import android.app.Application;
import android.app.Instrumentation;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
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
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Explicit real-provider probe. No credential or personal payload is exported or written. */
public final class TasksConvergenceAudit extends Instrumentation {
  private static final String SCOPE = "https://www.googleapis.com/auth/tasks";
  private String token;
  private String mappingBefore;
  private final Bundle result = new Bundle();
  @Override public void callApplicationOnCreate(Application application) {
    // This provider-only probe needs the existing target Context/UID, not a
    // React Native launch. Keep the test APK's unshrunk dependency classes out
    // of the application's R8-internal startup and do not start business work.
  }
  @Override public void onCreate(Bundle args) {
    super.onCreate(args);
    mappingBefore = args == null ? null : args.getString("mappingBefore");
    start();
  }
  @Override public void onStart() {
    String stage = "target_context";
    try {
      Long cutoff = mappingBefore == null ? null : java.time.Instant.parse(mappingBefore).toEpochMilli();
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
      stage = "readonly_local_scope";
      File directory = new File(context.getNoBackupFilesDir(), "LiFlowSharedSQLite");
      File[] files = directory.listFiles(); if (files == null) throw new IllegalStateException();
      JSONArray scopes = new JSONArray();
      for (File file: files) {
        if (!file.getName().matches("group-v2-[a-f0-9]{64}\\.db")) continue;
        try (SQLiteDatabase db=SQLiteDatabase.openDatabase(file.getPath(), null, SQLiteDatabase.OPEN_READONLY | SQLiteDatabase.NO_LOCALIZED_COLLATORS)) {
          try (Cursor table=db.rawQuery("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sharing_v2_private_google_control'", null)) { if (!table.moveToFirst()) continue; }
          JSONObject state;
          try (Cursor c=db.rawQuery("SELECT state_json FROM sharing_v2_private_google_control WHERE singleton=1",null)) { if(!c.moveToFirst())continue;state=new JSONObject(c.getString(0)); }
          if (!state.optBoolean("enabled") || !user.equals(state.optString("accountSubject")) || state.optString("taskListId").isEmpty()) continue;
          String selectedList = state.getString("taskListId");
          Map<String,String> local = new HashMap<>();
          Map<String,JSONObject> linkMetadata = new HashMap<>();
          try(Cursor c=db.rawQuery("SELECT schedule_entry_id,link_json FROM sharing_v2_private_google_links",null)) {
            while(c.moveToNext()) { JSONObject link = new JSONObject(c.getString(1)); local.put(c.getString(0),link.getString("googleTaskId")); linkMetadata.put(c.getString(0),link); }
          }
          stage = "readonly_provider_pages";
          Map<String,JSONObject> tasks = new HashMap<>(); Map<String,Set<String>> markers = new HashMap<>(); Set<String> cursors = new HashSet<>(); String cursor=null; int pages=0;
          do {
            String query="?maxResults=100&showCompleted=true&showHidden=true&showDeleted=true&fields="+encode("nextPageToken,items(id,notes,status,deleted,due)")+(cursor==null?"":"&pageToken="+encode(cursor));
            Response page=get("/lists/"+encode(selectedList)+"/tasks"+query);
            if(page.code!=200)throw new IllegalStateException();
            JSONArray items=page.body.optJSONArray("items");
            if(items!=null)for(int i=0;i<items.length();i++){
              JSONObject task=items.getJSONObject(i);String id=task.getString("id");tasks.put(id,task);
              if(!task.optBoolean("deleted")) {
                Matcher match=Pattern.compile("(?:^|\\n)LiFlow occurrence: ([a-f0-9]{64})(?:$|\\n)").matcher(task.optString("notes"));
                if(match.find()) {String marker=match.group(1);Set<String> ids=markers.get(marker);if(ids==null){ids=new HashSet<>();markers.put(marker,ids);}ids.add(id);}
              }
            }
            cursor=page.body.optString("nextPageToken",null);pages++;
            if(cursor!=null&&(!cursors.add(cursor)||pages>=30))throw new IllegalStateException();
          }while(cursor!=null);
          int duplicate=0,matched=0,missing=0,completed=0,live=0; List<String> links=new ArrayList<>(), provider=new ArrayList<>(); JSONArray watched=new JSONArray();
          List<String> baselineLinks=new ArrayList<>(), baselineProvider=new ArrayList<>(); JSONArray newMappings=new JSONArray();
          for(Set<String> ids:markers.values())if(ids.size()>1)duplicate++;
          for(Map.Entry<String,String> entry:local.entrySet()){
            JSONObject task=tasks.get(entry.getValue());if(task==null)missing++;else matched++;
            links.add(hash(entry.getKey())+":"+hash(entry.getValue()));
            // Export only the two already observed built-in QA controls. Other
            // chore names, account labels, raw IDs and provider bodies stay here.
            JSONObject link=linkMetadata.get(entry.getKey());String title=link.optString("lastSyncedTitle");
            if(cutoff != null) {
              long created = java.time.Instant.parse(link.getString("createdAt")).toEpochMilli();
              String pair=hash(entry.getKey())+":"+hash(entry.getValue());
              if(created < cutoff) {
                baselineLinks.add(pair);
                if(task!=null)baselineProvider.add(hash(entry.getValue())+":"+task.optString("status")+":"+task.optBoolean("deleted")+":"+task.optString("due"));
              } else {
                JSONObject added=new JSONObject();added.put("mappingDigest",hash(pair));added.put("createdAt",link.getString("createdAt"));
                added.put("linkedDueDate",link.optString("lastSyncedDueDate"));added.put("providerStatus",task==null?"missing":task.optString("status"));
                added.put("providerDueDate",task==null?"":task.optString("due"));added.put("providerDeleted",task!=null&&task.optBoolean("deleted"));
                newMappings.put(added);
              }
            }
            if("洗濯・しみ抜き".equals(title)||"衣類を洗濯して干す".equals(title)||"洗面所掃除".equals(title)) {
              JSONObject detail=new JSONObject();detail.put("control","洗面所掃除".equals(title)?"washbasin":"laundry");
              detail.put("entryDigest",hash(entry.getKey()));detail.put("taskDigest",hash(entry.getValue()));
              detail.put("linkedDueDate",link.optString("lastSyncedDueDate"));detail.put("lastSyncedStatus",link.optString("lastSyncedStatus"));
              detail.put("pendingStatus",link.optString("pendingStatus"));detail.put("providerStatus",task==null?"missing":task.optString("status"));
              detail.put("providerDueDate",task==null?"":task.optString("due"));watched.put(detail);
            }
          }
          for(Map.Entry<String,JSONObject> entry:tasks.entrySet()){
            JSONObject task=entry.getValue();if(!task.optBoolean("deleted")){live++;if("completed".equals(task.optString("status")))completed++;}
            provider.add(hash(entry.getKey())+":"+task.optString("status")+":"+task.optBoolean("deleted")+":"+task.optString("due"));
          }
          Collections.sort(links);Collections.sort(provider);JSONObject row=new JSONObject();
          row.put("accountDigest",hash(user));row.put("taskListDigest",hash(selectedList));row.put("localLinks",local.size());row.put("localLinkDigest",hash(links.toString()));
          row.put("matchedLinks",matched);row.put("missingLinks",missing);row.put("providerLiveTasks",live);row.put("providerCompletedTasks",completed);row.put("providerMarkerCount",markers.size());row.put("duplicateLiveMarkers",duplicate);row.put("providerDigest",hash(provider.toString()));row.put("providerPages",pages);row.put("localStatus",state.optString("status"));row.put("localErrorCode",state.optString("lastErrorCode"));
          row.put("lastAttemptAt",state.optString("lastAttemptAt"));row.put("lastSuccessfulSyncAt",state.optString("lastSuccessfulSyncAt"));
          row.put("nextRetryAt",state.optString("nextRetryAt"));row.put("retryCount",state.optInt("retryCount"));row.put("watchedControls",watched);
          if(cutoff != null) {
            Collections.sort(baselineLinks);Collections.sort(baselineProvider);row.put("mappingBefore",mappingBefore);
            row.put("baselineMappingCount",baselineLinks.size());row.put("baselineMappingDigest",hash(baselineLinks.toString()));
            row.put("baselineProviderDigest",hash(baselineProvider.toString()));row.put("newMappings",newMappings);
          }
          scopes.put(row);
        }
      }
      result.putString("evidenceJSON",scopes.toString());result.putString("probe","readonly_complete");
    } catch (Throwable error) {
      // Exception text and provider bodies can contain credentials or account labels.
      result.putString("probe", "incomplete");
      result.putString("stage", stage);
      result.putString("errorClass", error.getClass().getSimpleName());
    } finally {
      token = null;
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
  private static final class Response { int code; JSONObject body = new JSONObject(); }
  private Response get(String path) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL("https://tasks.googleapis.com/tasks/v1" + path).openConnection();
    try {
      connection.setConnectTimeout(15000); connection.setReadTimeout(15000); connection.setInstanceFollowRedirects(false); connection.setRequestMethod("GET");
      connection.setRequestProperty("Authorization", "Bearer " + token);
      Response result = new Response(); result.code = connection.getResponseCode();
      if (result.code >= 200 && result.code < 300 && result.code != 204) try (InputStream stream = connection.getInputStream()) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int count;
        while ((count = stream.read(buffer)) != -1) { if (bytes.size() + count > 2000000) throw new IllegalStateException(); bytes.write(buffer, 0, count); }
        result.body = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
      }
      return result;
    } finally { connection.disconnect(); }
  }
}
