package jp.jphacks.tkb2633.calendarowned;

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
public final class CalendarOwnedEventAudit extends Instrumentation {
  private static final String SCOPE = "https://www.googleapis.com/auth/calendar.events";
  private String token; private String wanted; private boolean seriesInstances;
  private final Bundle result = new Bundle();
  @Override public void callApplicationOnCreate(Application application) {
    // This provider-only probe needs the existing target Context/UID, not a
    // React Native launch. Keep the test APK's unshrunk dependency classes out
    // of the application's R8-internal startup and do not start business work.
  }
  @Override public void onCreate(Bundle args) {
    super.onCreate(args); wanted=args.getString("ownedTitle"); seriesInstances="1".equals(args.getString("seriesInstances"));
    start();
  }
  @Override public void onStart() {
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
      stage="readonly_exact_owned_event";
      if(wanted==null||!wanted.matches("LiFlow-QA-20261106-[a-f0-9]{10}"))throw new IllegalArgumentException();
      File file=new File(context.getFilesDir(),"SQLite/housework.db");String localId=null,calendarId=null,googleId=null;JSONObject local=null,proof=new JSONObject();
      try(SQLiteDatabase db=SQLiteDatabase.openDatabase(file.getPath(),null,SQLiteDatabase.OPEN_READONLY|SQLiteDatabase.NO_LOCALIZED_COLLATORS)){
        try(Cursor c=db.rawQuery("SELECT control_json FROM calendar_google_control WHERE singleton=1",null)){
          if(!c.moveToFirst())throw new IllegalStateException();JSONObject control=new JSONObject(c.getString(0));
          if(!control.optBoolean("enabled")||!user.equals(control.optString("subject")))throw new IllegalStateException();
        }
        try(Cursor c=db.rawQuery("SELECT id,revision,deleted,definition_json FROM calendar_events WHERE definition_json LIKE ? LIMIT 6",new String[]{"%"+wanted+"%"})){
          while(c.moveToNext()){
            JSONObject body=new JSONObject(c.getString(3));if(!wanted.equals(body.optString("title")))continue;
            if(localId!=null)throw new IllegalStateException();localId=c.getString(0);local=body;
            proof.put("localRevision",c.getInt(1));proof.put("localDeleted",c.getInt(2)==1);
          }
        }
        if(localId==null)throw new IllegalStateException();proof.put("localEventDigest",hash(localId));
        for(String keyName:new String[]{"startDate","endDate","startMinute","endMinute","allDay","timeZone","recurrence","untilDate","customRecurrence"})proof.put(keyName,local.opt(keyName));
        try(Cursor c=db.rawQuery("SELECT calendar_id,google_id,etag,local_revision,conflict_json,pending_json FROM calendar_google_links WHERE event_id=? AND subject=? AND anchor_date='' AND active=1 AND read_only=0",new String[]{localId,user})){
          if(!c.moveToFirst())throw new IllegalStateException();calendarId=c.getString(0);googleId=c.getString(1);
          proof.put("localEtagDigest",c.isNull(2)?JSONObject.NULL:hash(c.getString(2)));proof.put("syncedRevision",c.getInt(3));proof.put("conflict",!c.isNull(4));proof.put("pending",!c.isNull(5));if(c.moveToNext())throw new IllegalStateException();
        }
        if(seriesInstances) {
          if(!"2026-11-10".equals(local.optString("startDate"))||!"2026-11-24".equals(local.optString("untilDate"))||!"biweekly".equals(local.optString("recurrence")))throw new IllegalArgumentException();
          try(Cursor c=db.rawQuery("SELECT revision,override_json FROM calendar_event_exceptions WHERE event_id=? AND anchor_date='2026-11-24'",new String[]{localId})) {
            if(c.moveToFirst()) {
              proof.put("finalExceptionRevision",c.getInt(0));proof.put("finalExceptionCancelled",c.isNull(1));
              if(!c.isNull(1))proof.put("finalExceptionLocation",new JSONObject(c.getString(1)).optString("location"));
              if(c.moveToNext())throw new IllegalStateException();
            }
          }
          try(Cursor c=db.rawQuery("SELECT local_revision,conflict_json,pending_json,etag FROM calendar_google_links WHERE event_id=? AND subject=? AND anchor_date='2026-11-24' AND active=1",new String[]{localId,user})) {
            if(c.moveToFirst()) {proof.put("finalExceptionSyncedRevision",c.getInt(0));proof.put("finalExceptionConflict",!c.isNull(1));proof.put("finalExceptionPending",!c.isNull(2));proof.put("finalExceptionEtagDigest",c.isNull(3)?JSONObject.NULL:hash(c.getString(3)));if(c.moveToNext())throw new IllegalStateException();}
          }
        }
      }
      stage="readonly_provider_owned_event";
      Response page=get("/calendars/"+encode(calendarId)+"/events/"+encode(googleId)+"?timeZone=Asia%2FTokyo");
      if(page.code!=200||!googleId.equals(page.body.optString("id"))||!wanted.equals(page.body.optString("summary")))throw new IllegalStateException();
      proof.put("providerStatus",page.code);proof.put("providerEventDigest",hash(googleId));proof.put("providerEtagDigest",hash(page.body.getString("etag")));
      proof.put("providerStart",page.body.getJSONObject("start"));proof.put("providerEnd",page.body.getJSONObject("end"));proof.put("providerCancelled","cancelled".equals(page.body.optString("status")));
      proof.put("providerLocation",page.body.optString("location"));proof.put("providerNotes",page.body.optString("description"));proof.put("providerRecurrence",page.body.optJSONArray("recurrence"));
      if(seriesInstances) {
        stage="readonly_exact_synthetic_series_instances";
        // One bounded GET of this exact known QA series only. Never query the
        // calendar's other events or export creator/attendee/account fields.
        String fields="nextPageToken,items(id,recurringEventId,summary,status,start,end,originalStartTime,location,etag)";
        Response instances=get("/calendars/"+encode(calendarId)+"/events/"+encode(googleId)+"/instances?timeMin=2026-11-09T00%3A00%3A00Z&timeMax=2026-12-10T00%3A00%3A00Z&timeZone=Asia%2FTokyo&showDeleted=true&maxResults=50&fields="+encode(fields));
        if(instances.code!=200||instances.body.has("nextPageToken"))throw new IllegalStateException();
        JSONArray items=instances.body.optJSONArray("items"),details=new JSONArray();
        if(items!=null)for(int i=0;i<items.length();i++) {
          JSONObject item=items.getJSONObject(i);boolean cancelled="cancelled".equals(item.optString("status"));
          if(!googleId.equals(item.optString("recurringEventId"))||!cancelled&&!wanted.equals(item.optString("summary")))throw new IllegalStateException();
          JSONObject detail=new JSONObject();detail.put("eventDigest",hash(item.getString("id")));detail.put("cancelled",cancelled);
          if(item.has("etag"))detail.put("etagDigest",hash(item.getString("etag")));
          for(String field:new String[]{"start","end","originalStartTime","location"})detail.put(field,item.opt(field));
          details.put(detail);
        }
        proof.put("providerInstances",details);
      }
      proof.put("readOnly",true);result.putString("evidenceJSON",proof.toString());result.putString("probe","readonly_complete");
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
    HttpURLConnection connection = (HttpURLConnection) new URL("https://www.googleapis.com/calendar/v3" + path).openConnection();
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
