"""Compile a tiny same-signer instrumentation APK; exercise only a fresh private fixture directory."""
import argparse
import hashlib
import os
import re
from pathlib import Path
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--build-only', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
output = Path(args.output).resolve()
if root == output or root in output.parents:
    raise SystemExit('Use a private output directory outside the source checkout.')
output.mkdir(parents=True, exist_ok=True)
sdk = Path(os.environ.get('ANDROID_HOME', str(Path.home() / 'Library/Android/sdk')))
java = Path(os.environ['JAVA_HOME']) / 'bin'
version = lambda path: tuple(int(n) for n in re.findall(r'\d+', path.name))
tools = max((sdk / 'build-tools').iterdir(), key=version)
android = max((sdk / 'platforms').glob('android-*/android.jar'), key=lambda path: version(path.parent))
classes = output / 'classes'
classes.mkdir(exist_ok=True)
def run(arguments):
    subprocess.run([str(item) for item in arguments], check=True)
run([java / 'javac', '-source', '8', '-target', '8', '-cp', str(android) + os.pathsep + str(root / 'android/app/build/tmp/kotlin-classes/release'),
     '-d', classes, Path(__file__).with_name('WidgetInputAuditInstrumentation.java')])
manifest = output / 'AndroidManifest.xml'
manifest.write_text('''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="jp.jphacks.tkb2633.widgetaudit">
<uses-sdk android:minSdkVersion="24" android:targetSdkVersion="37"/><application android:label="LiFlow isolated widget audit" android:testOnly="true"/>
<instrumentation android:name="jp.jphacks.tkb2633.widgetaudit.WidgetInputAuditInstrumentation" android:targetPackage="jp.jphacks.tkb2633.widgetaudit"/></manifest>''')
apk = output / 'widget-input-audit.apk'
run([tools / 'aapt2', 'link', '-I', android, '--manifest', manifest, '-o', apk])
dex = output / 'dex'
dex.mkdir(exist_ok=True)
# R8 can inline the production bridge. Test the exact unminified Release compiler output in this separate APK.
bridge = root / 'android/app/build/tmp/kotlin-classes/release/jp/jphacks/tkb2633/WidgetCompletionDatabase.class'
template = root / 'plugins/android/WidgetCompletionDatabase.kt'
generated = root / 'android/app/src/main/java/jp/jphacks/tkb2633/WidgetCompletionDatabase.kt'
if template.read_bytes() != generated.read_bytes() or bridge.stat().st_mtime < generated.stat().st_mtime:
    raise SystemExit('Regenerate and compile the current widget bridge before running its device audit.')
print('bridgeSha256=' + hashlib.sha256(bridge.read_bytes()).hexdigest(), flush=True)
print('templateSha256=' + hashlib.sha256(template.read_bytes()).hexdigest(), flush=True)
stdlib = max((Path.home() / '.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib').glob('*/*/kotlin-stdlib-*.jar'), key=lambda path: version(path.parent.parent))
run([tools / 'd8', '--lib', android, '--min-api', '24', '--output', dex, *classes.rglob('*.class'), bridge, stdlib])
with zipfile.ZipFile(apk, 'a') as archive:
    archive.write(dex / 'classes.dex', 'classes.dex')
run([tools / 'apksigner', 'sign', '--ks', root / 'android/app/debug.keystore', '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android', apk])
if args.build_only:
    raise SystemExit(0)
adb = sdk / 'platform-tools/adb'
run([adb, '-s', args.serial, 'install', '-r', '-t', apk])
try:
    completed = subprocess.run([str(adb), '-s', args.serial, 'shell', 'am', 'instrument', '-w',
                                'jp.jphacks.tkb2633.widgetaudit/jp.jphacks.tkb2633.widgetaudit.WidgetInputAuditInstrumentation'],
                               check=True, capture_output=True, text=True)
    print(completed.stdout)
    if 'result=PASS' not in completed.stdout or 'INSTRUMENTATION_CODE: -1' not in completed.stdout:
        raise SystemExit('Native widget input audit did not pass.')
finally:
    # Remove only this separate, just-installed test APK. Never uninstall or clear jp.jphacks.tkb2633.
    run([adb, '-s', args.serial, 'uninstall', 'jp.jphacks.tkb2633.widgetaudit'])
