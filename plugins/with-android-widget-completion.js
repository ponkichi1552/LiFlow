const fs = require('node:fs');
const path = require('node:path');
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

function protectWidgetReceiver(manifest) {
  const receivers = manifest.manifest.application?.[0]?.receiver ?? [];
  const receiver = receivers.find(value => ['.NextChoreWidgetProvider', 'jp.jphacks.tkb2633.NextChoreWidgetProvider'].includes(value.$['android:name']));
  if (!receiver) throw new Error('LiFlow widget provider must exist before applying its private broadcast boundary');
  receiver.$['android:exported'] = 'false';
  return manifest;
}

module.exports = function withAndroidWidgetCompletion(config) {
  config = withAndroidManifest(config, mod => { mod.modResults = protectWidgetReceiver(mod.modResults); return mod; });
  return withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const androidPackage = AndroidConfig.Package.getPackage(modConfig);
      if (androidPackage !== 'jp.jphacks.tkb2633') {
        throw new Error('Widget completion database bridge expects android.package jp.jphacks.tkb2633');
      }

      const packageDirectory = path.join(
        modConfig.modRequest.platformProjectRoot,
        'app/src/main/java',
        ...androidPackage.split('.')
      );
      const providerPath = path.join(packageDirectory, 'NextChoreWidgetProvider.kt');
      const helperPath = path.join(packageDirectory, 'WidgetCompletionDatabase.kt');
      const templatePath = path.join(__dirname, 'android/WidgetCompletionDatabase.kt');

      if (!fs.existsSync(providerPath)) {
        throw new Error('expo-widgets did not generate NextChoreWidgetProvider.kt before the completion bridge');
      }

      fs.copyFileSync(templatePath, helperPath);
      fs.writeFileSync(providerPath, `package ${androidPackage}

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import java.util.concurrent.Executors
import expo.modules.widgets.ExpoWidgetsAppWidgetProvider

class NextChoreWidgetProvider : ExpoWidgetsAppWidgetProvider("NextChoreWidget") {
  companion object { private val inputs = Executors.newSingleThreadExecutor() }
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == "expo.modules.widgets.ACTION_WIDGET_INTERACTION"
      && intent.getStringExtra("expo.modules.widgets.extra.SOURCE") == "NextChoreWidget") {
      val target = intent.getStringExtra("expo.modules.widgets.extra.TARGET")
      if (target?.startsWith("complete:") == true) {
        val pending = goAsync()
        inputs.execute {
          val accepted = runCatching { WidgetCompletionDatabase.enqueue(context, target.removePrefix("complete:")) }.getOrDefault(false)
          Handler(Looper.getMainLooper()).post {
            try {
              deliver(context, intent, accepted)
            } finally { pending.finish() }
          }
        }
        return
      }
    }
    super.onReceive(context, intent)
  }
  private fun deliver(context: Context, intent: Intent, accepted: Boolean) {
    if (accepted) super.onReceive(context, intent)
    context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { launchIntent ->
      launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      context.startActivity(launchIntent)
    }
  }
}
`);

      return modConfig;
    },
  ]);
};
module.exports.protectWidgetReceiver = protectWidgetReceiver;
