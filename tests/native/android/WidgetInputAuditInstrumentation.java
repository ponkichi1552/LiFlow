package jp.jphacks.tkb2633.widgetaudit;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Bundle;
import jp.jphacks.tkb2633.WidgetCompletionDatabase;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;
import java.util.TimeZone;

/** The actual Release-compiled bridge runs in a separate audit APK against system SQLite, never the user's app data. */
public final class WidgetInputAuditInstrumentation extends Instrumentation {
  private int checks = 0;
  @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
  private void check(boolean condition) { checks++; if (!condition) throw new AssertionError("check " + checks); }
  private int count(SQLiteDatabase db, String table) {
    try (Cursor rows = db.rawQuery("SELECT count(*) FROM " + table, null)) { rows.moveToFirst(); return rows.getInt(0); }
  }
  @Override public void onStart() {
    Context owner = getTargetContext(); String nonce = UUID.randomUUID().toString();
    File directory = new File(owner.getFilesDir(), "widget-input-audit-" + nonce);
    String preferenceName = "widget-input-audit-" + nonce;
    Bundle result = new Bundle(); SQLiteDatabase db = null; int outcome = Activity.RESULT_CANCELED;
    try {
      File sql = new File(directory, "SQLite"); check(sql.mkdirs());
      final SharedPreferences preferences = owner.getSharedPreferences(preferenceName, Context.MODE_PRIVATE);
      Context isolated = new ContextWrapper(owner) {
        @Override public File getFilesDir() { return directory; }
        @Override public SharedPreferences getSharedPreferences(String name, int mode) { return preferences; }
      };
      db = SQLiteDatabase.openOrCreateDatabase(new File(sql, "housework.db"), null);
      db.execSQL("CREATE TABLE households(id TEXT PRIMARY KEY,created_at TEXT)");
      db.execSQL("CREATE TABLE chore_definitions(id TEXT PRIMARY KEY,household_id TEXT,enabled INTEGER)");
      db.execSQL("CREATE TABLE chore_schedule_entries(id TEXT PRIMARY KEY,household_id TEXT,chore_id TEXT,entry_json TEXT)");
      for (String table : new String[] { "chore_completions", "chore_state", "google_task_links" }) db.execSQL("CREATE TABLE " + table + "(marker TEXT)");
      db.execSQL("INSERT INTO households VALUES('local-household','2026-11-05T00:00:00Z')");
      db.execSQL("INSERT INTO chore_definitions VALUES('chore','local-household',1)");
      String day = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
      JSONObject entry = new JSONObject().put("id", "row").put("choreId", "chore").put("householdId", "local-household")
        .put("cycleBaseDate", day).put("windowStart", day).put("windowEnd", day).put("suggestedDate", day)
        .put("status", "scheduled").put("assignedMemberIds", new JSONArray());
      db.execSQL("INSERT INTO chore_schedule_entries VALUES('row','local-household','chore',?)", new Object[] { entry.toString() });
      long start = System.currentTimeMillis();
      JSONObject props = new JSONObject().put("widgetAccountScope", "synthetic-owner").put("subscriptionEnforced", true)
        .put("householdCreatedAt", "2026-11-05T00:00:00Z")
        .put("accessUntil", start + 120000).put("contentUntil", start + 120000).put("publishedAtMs", start - 1000).put("displayDate", day)
        .put("chores", new JSONArray().put(new JSONObject().put("id", "row").put("completed", false).put("completionGeneration", 7).put("entry", entry)));
      String key = "__expo_widgets_NextChoreWidget_props";
      check(preferences.edit().putString(key, props.toString()).commit());
      check(WidgetCompletionDatabase.INSTANCE.enqueue(isolated, "row"));
      check(count(db, "native_widget_completion_intents") == 1);
      for (String table : new String[] { "chore_completions", "chore_state", "google_task_links" }) check(count(db, table) == 0);
      try (Cursor rows = db.rawQuery("SELECT operation_id,operation_json FROM native_widget_completion_intents", null)) {
        check(rows.moveToFirst()); JSONObject operation = new JSONObject(rows.getString(1));
        check(rows.getString(0).equals(operation.getString("id"))); check(operation.getString("accountScope").equals("synthetic-owner"));
        check(operation.getString("householdCreatedAt").equals("2026-11-05T00:00:00Z"));
        check(operation.getJSONObject("entry").toString().equals(entry.toString()));
        check(operation.getLong("acceptedAtMs") >= start && operation.getLong("acceptedAtMs") <= System.currentTimeMillis());
        check(operation.getString("completedLocalDate").equals(day));
        check(operation.getLong("completionGeneration") == 7);
      }
      String[] fields = { "accessUntil", "contentUntil", "publishedAtMs", "displayDate", "widgetAccountScope", "subscriptionLocked", "contentStale", "householdCreatedAt" };
      Object[] values = { start - 1, start - 1, "NaN", "2000-01-01", "", true, true, "2000-01-01T00:00:00Z" };
      for (int i = 0; i < fields.length; i++) {
        JSONObject invalid = new JSONObject(props.toString()).put(fields[i], values[i]);
        check(preferences.edit().putString(key, invalid.toString()).commit());
        check(!WidgetCompletionDatabase.INSTANCE.enqueue(isolated, "row"));
        check(count(db, "native_widget_completion_intents") == 1);
      }
      JSONObject noEntitlement = new JSONObject(props.toString()); noEntitlement.remove("accessUntil");
      check(preferences.edit().putString(key, noEntitlement.toString()).commit()); check(!WidgetCompletionDatabase.INSTANCE.enqueue(isolated, "row"));
      check(preferences.edit().putString(key, props.toString()).commit());
      db.execSQL("UPDATE chore_definitions SET enabled=0"); check(!WidgetCompletionDatabase.INSTANCE.enqueue(isolated, "row"));
      db.execSQL("UPDATE chore_definitions SET enabled=1"); check(!WidgetCompletionDatabase.INSTANCE.enqueue(isolated, "missing"));
      JSONObject replaced = new JSONObject(entry.toString()).put("cycleBaseDate", "2099-01-01");
      db.execSQL("UPDATE chore_schedule_entries SET entry_json=?", new Object[] { replaced.toString() });
      check(!WidgetCompletionDatabase.INSTANCE.enqueue(isolated, "row"));
      check(count(db, "native_widget_completion_intents") == 1);
      db.execSQL("UPDATE chore_schedule_entries SET entry_json=?", new Object[] { entry.toString() });
      for (String zone : new String[] { "Pacific/Kiritimati", "Pacific/Pago_Pago" }) {
        SimpleDateFormat ownFormat = new SimpleDateFormat("yyyy-MM-dd", Locale.US); ownFormat.setTimeZone(TimeZone.getTimeZone(zone));
        String ownDay = ownFormat.format(new Date());
        JSONObject own = new JSONObject(props.toString()).put("displayTimeZone", zone).put("displayDate", ownDay);
        check(preferences.edit().putString(key, own.toString()).commit()); check(WidgetCompletionDatabase.INSTANCE.enqueue(isolated, "row"));
        try (Cursor rows = db.rawQuery("SELECT operation_json FROM native_widget_completion_intents ORDER BY rowid DESC LIMIT 1", null)) {
          check(rows.moveToFirst()); JSONObject operation = new JSONObject(rows.getString(0));
          check(operation.getString("completedLocalDate").equals(ownDay)); check(operation.getString("timeZone").equals(zone));
        }
      }
      int retained = count(db, "native_widget_completion_intents");
      for (Object zone : new Object[] { "Invalid/Zone", "", JSONObject.NULL, 42 }) {
        JSONObject invalid = new JSONObject(props.toString()).put("displayTimeZone", zone);
        check(preferences.edit().putString(key, invalid.toString()).commit()); check(!WidgetCompletionDatabase.INSTANCE.enqueue(isolated, "row"));
        check(count(db, "native_widget_completion_intents") == retained);
      }
      result.putString("result", "PASS"); result.putInt("checks", checks); result.putInt("api", android.os.Build.VERSION.SDK_INT);
      outcome = Activity.RESULT_OK;
    } catch (Throwable error) {
      result.putString("result", "FAIL"); result.putString("failure", error.getClass().getSimpleName()); result.putInt("checks", checks);
      // Only this synthetic APK's private fixture is used; no user content or credentials enter the message.
      if (error instanceof android.database.SQLException) result.putString("sqliteFailure", error.getMessage());
    } finally {
      if (db != null) db.close();
      owner.deleteSharedPreferences(preferenceName);
      SQLiteDatabase.deleteDatabase(new File(directory, "SQLite/housework.db")); new File(directory, "SQLite").delete(); directory.delete();
    }
    finish(outcome, result);
  }
}
