package jp.jphacks.tkb2633.sqliteconnectionsaudit;

import android.app.Application;
import android.app.Instrumentation;
import android.os.Bundle;
import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.util.List;
import java.util.UUID;

/** The installed Expo native SQLite binding, in an exclusively created disposable DB.
 * This verifies the native engine/connection boundary, not the JS async queue. */
public final class ExpoSqliteConnectionsAudit extends Instrumentation {
  private Class<?> databaseType, statementType;
  private Object a, b;
  private File directory;
  private String stage = "nativeBinding";
  @Override public void callApplicationOnCreate(Application app) { }
  @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
  private Object invoke(Object target, String name, Class<?>[] types, Object... args) throws Exception {
    return target.getClass().getMethod(name, types).invoke(target, args);
  }
  private int exec(Object db, String sql) throws Exception { return (Integer)invoke(db, "sqlite3_exec", new Class<?>[] { String.class }, sql); }
  private void ok(Object db, String sql) throws Exception { if (exec(db, sql) != 0) throw new IllegalStateException("native SQL rejected"); }
  private void rejects(Object db, String sql, int primaryCode) throws Exception {
    try {
      check((exec(db, sql) & 255) == primaryCode);
    } catch (InvocationTargetException error) {
      // Expo throws instead of returning an SQLite error. Check its exact native
      // code before another SQL statement can replace the connection error state.
      if (!"expo.modules.sqlite.SQLiteErrorException".equals(error.getCause().getClass().getName())) throw error;
      String detail = (String)invoke(db, "convertSqlLiteErrorToString", new Class<?>[0]);
      java.util.regex.Matcher code = java.util.regex.Pattern.compile("^Error code (\\d+):").matcher(detail);
      check(code.find() && (Integer.parseInt(code.group(1)) & 255) == primaryCode);
    }
  }
  private Object scalar(Object db, String sql) throws Exception {
    Object statement = statementType.getDeclaredConstructor().newInstance();
    try {
      int result = (Integer)invoke(db, "sqlite3_prepare_v2", new Class<?>[] { String.class, statementType }, sql, statement);
      if (result != 0 || (Integer)invoke(statement, "sqlite3_step", new Class<?>[0]) != 100) throw new IllegalStateException("native row unavailable");
      return ((List<?>)invoke(statement, "getColumnValues", new Class<?>[0])).get(0);
    } finally {
      invoke(statement, "sqlite3_finalize", new Class<?>[0]); invoke(statement, "close", new Class<?>[0]);
    }
  }
  private long number(Object db, String sql) throws Exception { return ((Number)scalar(db, sql)).longValue(); }
  private void check(boolean value) { if (!value) throw new IllegalStateException("native isolation mismatch"); }
  private boolean close(Object db) {
    if (db == null) return true;
    boolean closed = true;
    try { if ((Integer)invoke(db, "sqlite3_get_autocommit", new Class<?>[0]) == 0) ok(db, "ROLLBACK"); } catch (Exception error) { closed = false; }
    try { if ((Integer)invoke(db, "sqlite3_close", new Class<?>[0]) != 0) closed = false; } catch (Exception error) { closed = false; }
    try { invoke(db, "close", new Class<?>[0]); } catch (Exception error) { closed = false; }
    return closed;
  }
  @Override public void onStart() {
    Bundle report = new Bundle();
    try {
      ClassLoader loader = getTargetContext().getClassLoader();
      // This provider-only harness deliberately skips MainApplication.onCreate.
      // Initialize only the official native-library loader, not React or Planner.
      Class.forName("com.facebook.soloader.SoLoader", true, loader)
        .getMethod("init", android.content.Context.class, int.class).invoke(null, getTargetContext(), 0);
      databaseType = Class.forName("expo.modules.sqlite.NativeDatabaseBinding", true, loader);
      statementType = Class.forName("expo.modules.sqlite.NativeStatementBinding", true, loader);
      directory = new File(getTargetContext().getCacheDir(), "liflow-native-sqlite-audit-" + UUID.randomUUID());
      check(directory.mkdir()); String path = new File(directory, "isolated.db").getPath();
      a = databaseType.getDeclaredConstructor().newInstance(); b = databaseType.getDeclaredConstructor().newInstance();
      check((Integer)invoke(a, "sqlite3_open", new Class<?>[] { String.class }, path) == 0);
      check((Integer)invoke(b, "sqlite3_open", new Class<?>[] { String.class }, path) == 0);
      ok(a, "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=25; CREATE TABLE state(id INTEGER PRIMARY KEY,value INTEGER); INSERT INTO state VALUES(1,0);");
      ok(b, "PRAGMA busy_timeout=25;");
      report.putString("sqliteVersion", String.valueOf(scalar(a, "SELECT sqlite_version()")));
      check("wal".equals(scalar(a, "PRAGMA journal_mode")));
      stage = "externalCommitInvalidation";
      long version = number(a, "PRAGMA data_version"); ok(b, "UPDATE state SET value=1");
      check(number(a, "PRAGMA data_version") != version); check(number(a, "SELECT value FROM state") == 1);
      stage = "staleSnapshotPromotion";
      ok(a, "BEGIN"); check(number(a, "SELECT value FROM state") == 1);
      ok(b, "UPDATE state SET value=2"); check(number(a, "SELECT value FROM state") == 1);
      rejects(a, "UPDATE state SET value=99", 5);
      ok(a, "ROLLBACK"); check(number(a, "SELECT value FROM state") == 2);
      stage = "writeIsolation";
      ok(a, "BEGIN; UPDATE state SET value=3"); check(number(b, "SELECT value FROM state") == 2);
      rejects(b, "UPDATE state SET value=4", 5); ok(a, "ROLLBACK");
      check(number(b, "SELECT value FROM state") == 2);
      stage = "readOnlyPeer";
      ok(b, "PRAGMA query_only=ON; BEGIN"); check(number(b, "SELECT value FROM state") == 2);
      rejects(b, "UPDATE state SET value=5", 8); ok(b, "COMMIT");
      check(number(a, "SELECT value FROM state") == 2);
      check(number(a, "PRAGMA query_only") == 0);
      report.putString("result", "PASS"); report.putInt("nativeConnectionCases", 4);
      report.putBoolean("mainApplicationStarted", false); report.putBoolean("existingDatabaseOpened", false);
    } catch (Throwable error) {
      Throwable cause = error instanceof InvocationTargetException ? ((InvocationTargetException)error).getCause() : error;
      report.putString("result", "FAIL"); report.putString("stage", stage); report.putString("errorClass", cause.getClass().getSimpleName());
      while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
      report.putString("rootErrorClass", cause.getClass().getSimpleName());
      report.putBoolean("nativeLoaderUninitialized", cause.getMessage() != null && cause.getMessage().contains("NativeLoader has not been initialized"));
    } finally {
      boolean closedA = close(a), closedB = close(b); boolean cleaned = closedA && closedB;
      report.putBoolean("nativeConnectionsClosed", closedA && closedB);
      if (directory != null && directory.exists()) {
        for (String name : new String[] { "isolated.db", "isolated.db-wal", "isolated.db-shm" }) {
          File file = new File(directory, name); if (file.exists() && !file.delete()) cleaned = false;
        }
        if (!directory.delete()) cleaned = false;
      }
      report.putBoolean("disposableDatabaseCleaned", cleaned); if (!cleaned) report.putString("result", "FAIL"); finish(-1, report);
    }
  }
}
