const fs = require('node:fs/promises');
const path = require('node:path');
const { withAndroidManifest, withAppDelegate, withDangerousMod, withMainApplication } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

// Exclusions without <include> preserve the existing personal-data backup policy.
const excludes = ['SecureStore', 'google_signin_prefs.xml', 'google_signin_secure_prefs.xml']
  .map((name) => `    <exclude domain="sharedpref" path="${name}" />`).join('\n');
const backupRules = `<?xml version="1.0" encoding="utf-8"?>\n<full-backup-content>\n${excludes}\n</full-backup-content>\n`;
const extractionRules = `<?xml version="1.0" encoding="utf-8"?>\n<data-extraction-rules>\n  <cloud-backup>\n${excludes}\n  </cloud-backup>\n  <device-transfer>\n${excludes}\n  </device-transfer>\n</data-extraction-rules>\n`;

function androidStorage(source) {
  return mergeContents({ tag: 'liflow-sharing-private-storage', src: source, anchor: /DefaultNewArchitectureEntryPoint\.releaseLevel = try/u,
    offset: 0, comment: '//', newSrc: `    val sharingMarker = java.io.File(filesDir, "SQLite/shared-location.json")
    try {
      val sharedDirectory = java.io.File(noBackupFilesDir, "LiFlowSharedSQLite")
      check(sharedDirectory.isDirectory || sharedDirectory.mkdirs())
      check(sharingMarker.parentFile!!.isDirectory || sharingMarker.parentFile!!.mkdirs())
      val expectedMarker = org.json.JSONObject().put("policyVersion", 1).put("platform", "android")
        .put("databaseDirectory", sharedDirectory.canonicalPath).toString()
      if (!sharingMarker.isFile || sharingMarker.length() != expectedMarker.toByteArray().size.toLong() || sharingMarker.readText() != expectedMarker) {
        val temporaryMarker = java.io.File(sharingMarker.parentFile, "shared-location.tmp")
        temporaryMarker.writeText(expectedMarker)
        check(temporaryMarker.renameTo(sharingMarker))
      }
    } catch (_: Exception) {
      // Fail closed for sharing only. Never remove a database or interrupt personal mode.
      sharingMarker.delete()
    }` }).contents;
}

function iosStorage(source) {
  let contents = mergeContents({ tag: 'liflow-sharing-private-storage-method', src: source,
    anchor: /class AppDelegate[^\n]*\{/u, offset: 1, comment: '//', newSrc: `  private func initializeLiFlowSharedStorage() {
    let manager = FileManager.default
    guard let documents = manager.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
    let sqlite = documents.appendingPathComponent("SQLite", isDirectory: true)
    let marker = sqlite.appendingPathComponent("shared-location.json")
    do {
      var shared = sqlite.appendingPathComponent("shared", isDirectory: true)
      try manager.createDirectory(at: shared, withIntermediateDirectories: true)
      if try shared.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup != true {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try shared.setResourceValues(values)
      }
      guard try shared.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true else {
        try? manager.removeItem(at: marker)
        return
      }
      try manager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: shared.path)
      if let data = try? Data(contentsOf: marker),
         let saved = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
         saved["policyVersion"] as? Int == 1, saved["platform"] as? String == "ios",
         saved["databaseDirectory"] as? String == shared.path {
        return
      }
      let data = try JSONSerialization.data(withJSONObject: ["policyVersion": 1, "platform": "ios", "databaseDirectory": shared.path])
      try data.write(to: marker, options: .atomic)
    } catch {
      try? manager.removeItem(at: marker)
    }
  }
` }).contents;
  contents = mergeContents({ tag: 'liflow-sharing-private-storage-start', src: contents,
    anchor: /let delegate = ReactNativeDelegate\(\)/u, offset: 0, comment: '//',
    newSrc: '    initializeLiFlowSharedStorage()' }).contents;
  return contents;
}

function withSharingPrivateStorage(config) {
  config = withMainApplication(config, (mod) => {
    if (mod.modResults.language !== 'kt') throw new Error('Sharing storage requires the SDK58 Kotlin MainApplication.');
    mod.modResults.contents = androidStorage(mod.modResults.contents); return mod;
  });
  config = withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== 'swift') throw new Error('Sharing storage requires the SDK58 Swift AppDelegate.');
    mod.modResults.contents = iosStorage(mod.modResults.contents); return mod;
  });
  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) throw new Error('Sharing backup policy needs an Android application.');
    application.$['android:fullBackupContent'] = '@xml/liflow_backup_rules';
    application.$['android:dataExtractionRules'] = '@xml/liflow_data_extraction_rules';
    return mod;
  });
  return withDangerousMod(config, ['android', async (mod) => {
    const directory = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/res/xml');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'liflow_backup_rules.xml'), backupRules);
    await fs.writeFile(path.join(directory, 'liflow_data_extraction_rules.xml'), extractionRules);
    return mod;
  }]);
}

module.exports = withSharingPrivateStorage;
module.exports.androidStorage = androidStorage;
module.exports.iosStorage = iosStorage;
module.exports.backupRules = backupRules;
module.exports.extractionRules = extractionRules;
