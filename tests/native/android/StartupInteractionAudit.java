package jp.jphacks.tkb2633.startupaudit;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.app.KeyguardManager;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.os.PowerManager;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Read-only UI navigation. No Planner database, account, completion or draft is changed. */
public final class StartupInteractionAudit extends Instrumentation {
  private static final String APP = "jp.jphacks.tkb2633";
  private UiAutomation ui;
  private long queryMilliseconds;
  private int queryAttempts;
  private int beforeTapDelayMs;
  private boolean equal(CharSequence value, String expected) { return value != null && expected.contentEquals(value); }
  private AccessibilityNodeInfo root() {
    AccessibilityNodeInfo value = ui.getRootInActiveWindow();
    if (value == null) return null;
    if (!equal(value.getPackageName(), APP)) { value.recycle(); return null; }
    return value;
  }
  private AccessibilityNodeInfo find(AccessibilityNodeInfo node, String label, boolean suffix, boolean clickable) {
    if (node == null) return null;
    CharSequence description = node.getContentDescription(), text = node.getText();
    boolean match = suffix ? description != null && description.toString().endsWith(label)
      : equal(description, label) || equal(text, label);
    if (match && node.isVisibleToUser() && node.isEnabled() && (!clickable || node.isClickable())) return node;
    for (int i = 0; i < node.getChildCount(); i++) {
      AccessibilityNodeInfo child = node.getChild(i);
      AccessibilityNodeInfo found = find(child, label, suffix, clickable);
      if (found != null) { node.recycle(); return found; }
    }
    node.recycle(); return null;
  }
  private AccessibilityNodeInfo waitFor(String label, boolean suffix, boolean clickable, long timeout) throws Exception {
    long until = SystemClock.elapsedRealtime() + timeout;
    do {
      long queryStarted = SystemClock.elapsedRealtime();
      AccessibilityNodeInfo found = find(root(), label, suffix, clickable);
      queryMilliseconds += SystemClock.elapsedRealtime() - queryStarted; queryAttempts++;
      if (found != null) return found;
      SystemClock.sleep(32);
    } while (SystemClock.elapsedRealtime() < until);
    throw new Exception("expected LiFlow surface did not appear");
  }
  private String shell(String command) throws Exception {
    try (ParcelFileDescriptor descriptor = ui.executeShellCommand(command);
         FileInputStream stream = new FileInputStream(descriptor.getFileDescriptor()); ByteArrayOutputStream result = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[4096]; int count;
      while ((count = stream.read(buffer)) != -1) { if (result.size() + count > 16384) throw new Exception("unexpected shell result size"); result.write(buffer, 0, count); }
      return result.toString("UTF-8");
    }
  }
  private long reportedMilliseconds(String output, String name) throws Exception {
    Matcher match = Pattern.compile("(?m)^" + name + ":\\s*(\\d+)\\s*$").matcher(output);
    if (!match.find()) throw new Exception("native launch timing was not reported"); return Long.parseLong(match.group(1));
  }
  @Override public void onCreate(Bundle args) {
    super.onCreate(args);
    beforeTapDelayMs = args == null ? 0 : Integer.parseInt(args.getString("beforeTapDelayMs", "0"));
    if (beforeTapDelayMs < 0 || beforeTapDelayMs > 20000) throw new IllegalArgumentException("Invalid read-only observation delay");
    start();
  }
  @Override public void onStart() {
    Bundle report = new Bundle(); JSONArray results = new JSONArray();
    String stage = "automation";
    PowerManager.WakeLock awake = null;
    try {
      ui = getUiAutomation();
      PowerManager power = (PowerManager)getContext().getSystemService(android.content.Context.POWER_SERVICE);
      awake = power.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, "LiFlowAudit:readOnlyStartup");
      awake.acquire(240000);
      if (((KeyguardManager)getContext().getSystemService(android.content.Context.KEYGUARD_SERVICE)).isKeyguardLocked()) throw new Exception("device requires its owner to unlock");
      for (int run = 1; run <= 3; run++) {
        stage = "launch";
        shell("am force-stop " + APP);
        queryMilliseconds = 0; queryAttempts = 0;
        long started = SystemClock.elapsedRealtime();
        String launch = shell("am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n " + APP + "/.MainActivity");
        long nativeFirstDraw = reportedMilliseconds(launch, "TotalTime");
        stage = "visibleChore"; AccessibilityNodeInfo chore = waitFor("の説明を開く", true, true, 45000);
        long ready = SystemClock.elapsedRealtime(); long homeQueries = queryMilliseconds; int homeAttempts = queryAttempts;
        // Let the app's ordinary cold verification run; never force a sync or a worker.
        SystemClock.sleep(beforeTapDelayMs);
        if (beforeTapDelayMs > 0) {
          chore.recycle(); stage = "currentChoreAfterObservation";
          chore = waitFor("の説明を開く", true, true, 15000);
        }
        long tapStarted = SystemClock.elapsedRealtime(); long tapUnixMs = System.currentTimeMillis();
        stage = "choreClick"; boolean dispatched = chore.performAction(AccessibilityNodeInfo.ACTION_CLICK); chore.recycle();
        if (!dispatched) throw new Exception("chore navigation click was not accepted");
        stage = "explanationHeading"; AccessibilityNodeInfo heading = waitFor("家事の説明", false, false, 45000); heading.recycle();
        long explanation = SystemClock.elapsedRealtime();
        stage = "procedure"; AccessibilityNodeInfo steps = waitFor("家事の手順", false, false, 15000); steps.recycle();
        JSONObject value = new JSONObject(); value.put("run", run); value.put("launchToChoreAvailableMs", ready - started);
        value.put("choreTapToExplanationMs", explanation - tapStarted); value.put("launchToExplanationMs", explanation - started);
        value.put("beforeTapDelayMs", beforeTapDelayMs);
        value.put("tapUnixMs", tapUnixMs); value.put("explanationUnixMs", System.currentTimeMillis());
        value.put("appPid", shell("pidof " + APP).trim());
        value.put("withinOneSecond", ready - started <= 1000); value.put("readOnlyNavigation", true);
        value.put("screenInteractive", power.isInteractive()); results.put(value);
        value.put("nativeFirstDrawMs", nativeFirstDraw); value.put("homeAccessibilityQueryMs", homeQueries); value.put("homeQueryAttempts", homeAttempts);
        stage = "backToHome"; ui.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
        waitFor("の説明を開く", true, true, 15000).recycle();
      }
      report.putString("result", "PASS"); report.putString("observations", results.toString());
      report.putString("method", "separate native instrumentation; OS first draw (may be splash) is separate from actual accessible chore and click to explanation; includes shell and accessibility waits");
    } catch (Throwable error) {
      report.putString("result", "FAIL"); report.putString("errorClass", error.getClass().getSimpleName());
      report.putString("stage", stage);
      report.putString("observations", results.toString());
    } finally { if (awake != null && awake.isHeld()) awake.release(); finish(-1, report); }
  }
}
