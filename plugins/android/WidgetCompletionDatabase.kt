package jp.jphacks.tkb2633

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/** A private, durable input queue. Only the authorized JS transaction writes completion/history/Tasks state. */
internal object WidgetCompletionDatabase {
  fun enqueue(context: Context, scheduleEntryId: String): Boolean {
    if (scheduleEntryId.isEmpty() || scheduleEntryId.length > 1024) return false
    val text = context.getSharedPreferences("expo.modules.widgets", Context.MODE_PRIVATE)
      .getString("__expo_widgets_NextChoreWidget_props", null) ?: return false
    val props = JSONObject(text)
    val now = System.currentTimeMillis()
    val scope = props.optString("widgetAccountScope")
    val household = props.optString("householdCreatedAt")
    if (household.isEmpty()) return false
    if (scope.isEmpty() || scope.length > 160 || props.optBoolean("subscriptionLocked") || props.optBoolean("contentStale")) return false
    if (props.optBoolean("subscriptionEnforced") && !props.has("accessUntil")) return false
    if (props.has("accessUntil") && (!props.optDouble("accessUntil").isFinite() || now >= props.optDouble("accessUntil"))) return false
    if (!props.has("contentUntil") || now >= props.optDouble("contentUntil") || !props.optDouble("contentUntil").isFinite()) return false
    if (!props.has("publishedAtMs") || !props.optDouble("publishedAtMs").isFinite() || now < props.optDouble("publishedAtMs")) return false
    val selectedZone = if (props.has("displayTimeZone")) {
      val name = props.optString("displayTimeZone")
      if (!TimeZone.getAvailableIDs().contains(name)) return false
      TimeZone.getTimeZone(name)
    } else TimeZone.getDefault()
    val formatter = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    formatter.timeZone = selectedZone
    val localDate = formatter.format(Date(now))
    if (props.optString("displayDate") != localDate) return false
    val chores = props.optJSONArray("chores") ?: return false
    val chore = (0 until chores.length()).map { chores.getJSONObject(it) }
      .firstOrNull { it.optString("id") == scheduleEntryId && !it.optBoolean("completed") } ?: return false
    val capturedEntry = chore.optJSONObject("entry") ?: return false
    if (capturedEntry.optString("id") != scheduleEntryId || capturedEntry.optString("householdId") != "local-household") return false
    val databaseFile = File(context.filesDir, "SQLite/housework.db")
    if (!databaseFile.exists()) return false
    val database = SQLiteDatabase.openDatabase(databaseFile.path, null, SQLiteDatabase.OPEN_READWRITE)
    try {
      // Android's setter still returns one row; execSQL rejects it even though desktop SQLite accepts it.
      database.rawQuery("PRAGMA busy_timeout=250", null).use { it.moveToFirst() }
      database.beginTransaction()
      try {
        val target = database.rawQuery(
          """SELECT e.entry_json, h.created_at FROM chore_schedule_entries e
            JOIN chore_definitions d ON d.id=e.chore_id AND d.household_id=e.household_id
            JOIN households h ON h.id=e.household_id
            WHERE e.id=? AND d.enabled=1 AND e.household_id='local-household'""",
          arrayOf(scheduleEntryId)
        ).use { cursor -> if (!cursor.moveToFirst()) null else Pair(cursor.getString(0), cursor.getString(1)) } ?: return false
        val currentEntry = JSONObject(target.first)
        if (target.second != household || currentEntry.optString("choreId") != capturedEntry.optString("choreId")
          || currentEntry.optString("cycleBaseDate") != capturedEntry.optString("cycleBaseDate")) return false
        database.execSQL("""CREATE TABLE IF NOT EXISTS native_widget_completion_intents (
          operation_id TEXT PRIMARY KEY NOT NULL, operation_json TEXT NOT NULL)""")
        val count = database.rawQuery("SELECT count(*) FROM native_widget_completion_intents", null).use { it.moveToFirst(); it.getInt(0) }
        if (count >= 1000) return false
        val id = "completion-intent.${UUID.randomUUID()}"
        val operation = JSONObject().put("id", id).put("accountScope", scope).put("householdCreatedAt", target.second)
          .put("acceptedAtMs", now).put("completedLocalDate", localDate).put("timeZone", selectedZone.id)
          .put("entry", capturedEntry).put("completionGeneration", chore.optLong("completionGeneration", 0))
        database.execSQL("INSERT INTO native_widget_completion_intents(operation_id,operation_json) VALUES (?,?)", arrayOf(id, operation.toString()))
        database.setTransactionSuccessful()
      } finally { database.endTransaction() }
    } finally { database.close() }
    return true
  }
}
