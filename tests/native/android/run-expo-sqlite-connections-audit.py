"""Check the installed Expo SQLite binding in a disposable DB, without starting Planner.

This is a native connection-boundary test, not an end-to-end JS async-queue test.
It terminates the target process for instrumentation; run after user operations settle.
"""
import argparse
import hashlib
import os
import re
from pathlib import Path
import subprocess
import tempfile
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--apk', type=Path, help='Exact installed, debug-signed normal Release APK.')
parser.add_argument('--build-only', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
output = Path(args.output).resolve()
if output == root or root in output.parents:
    raise SystemExit('Use a private output directory outside the source checkout.')
if not args.build_only and (not args.apk or not args.apk.is_file()):
    raise SystemExit('The exact installed normal Release APK is required.')
output.mkdir(parents=True, exist_ok=True)
sdk = Path(os.environ.get('ANDROID_HOME', str(Path.home() / 'Library/Android/sdk')))
java = Path(os.environ['JAVA_HOME']) / 'bin'
version = lambda path: tuple(int(n) for n in re.findall(r'\d+', path.name))
build = max((sdk / 'build-tools').iterdir(), key=version)
android = max((sdk / 'platforms').glob('android-*/android.jar'), key=lambda path: version(path.parent))
adb = sdk / 'platform-tools/adb'
package = 'jp.jphacks.tkb2633.sqliteconnectionsaudit'
target = 'jp.jphacks.tkb2633'


def run(argv, **kwargs):
    return subprocess.run([str(value) for value in argv], check=True, **kwargs)


def device(*argv):
    return run([adb, '-s', args.serial, *argv], capture_output=True, text=True).stdout


if not args.build_only:
    paths = device('shell', 'pm', 'path', target).splitlines()
    bases = [line.removeprefix('package:') for line in paths if line.endswith('/base.apk')]
    if len(bases) != 1 or not re.fullmatch(r'/data/app/[a-zA-Z0-9_=/+.-]+/base\.apk', bases[0]):
        raise SystemExit('Cannot identify the installed normal app; no operation performed.')
    actual = device('shell', 'sha256sum', bases[0]).split()[0]
    expected = hashlib.sha256(args.apk.read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit('Installed APK differs from the supplied artifact; no operation performed.')
    if device('shell', 'pm', 'list', 'packages', package).strip():
        raise SystemExit('An audit package already exists; preserve it and choose a clean test opportunity.')

# A fresh compilation directory prevents an older harness class from entering the APK.
with tempfile.TemporaryDirectory(prefix='sqlite-connections-build-', dir=output) as folder:
    work = Path(folder)
    classes = work / 'classes'
    dex = work / 'dex'
    classes.mkdir()
    dex.mkdir()
    run([java / 'javac', '-source', '8', '-target', '8', '-cp', android, '-d', classes,
         Path(__file__).with_name('ExpoSqliteConnectionsAudit.java')])
    manifest = work / 'AndroidManifest.xml'
    manifest.write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{package}">
<uses-sdk android:minSdkVersion="29" android:targetSdkVersion="37"/>
<application android:label="LiFlow isolated SQLite connection audit" android:testOnly="true"/>
<instrumentation android:name="{package}.ExpoSqliteConnectionsAudit" android:targetPackage="{target}"/>
</manifest>''')
    apk = output / 'expo-sqlite-connections-audit.apk'
    run([build / 'aapt2', 'link', '-I', android, '--manifest', manifest, '-o', apk])
    run([build / 'd8', '--lib', android, '--min-api', '29', '--output', dex, *classes.rglob('*.class')])
    with zipfile.ZipFile(apk, 'a') as archive:
        archive.write(dex / 'classes.dex', 'classes.dex')
    # The repository's public development key only. Production signing is unsupported.
    run([build / 'apksigner', 'sign', '--ks', root / 'android/app/debug.keystore',
         '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android', apk])
if args.build_only:
    raise SystemExit(0)
run([adb, '-s', args.serial, 'install', '-r', '-t', apk])
try:
    observed = run([adb, '-s', args.serial, 'shell', 'am', 'instrument', '-w',
                    package + '/' + package + '.ExpoSqliteConnectionsAudit'],
                   capture_output=True, text=True, timeout=90)
    (output / 'native-connections.log').write_text(observed.stdout + observed.stderr)
    print(observed.stdout, flush=True)
    required = ['result=PASS', 'nativeConnectionCases=4', 'nativeConnectionsClosed=true',
                'existingDatabaseOpened=false', 'mainApplicationStarted=false',
                'disposableDatabaseCleaned=true', 'INSTRUMENTATION_CODE: -1']
    if any(marker not in observed.stdout for marker in required):
        raise SystemExit('The native connection audit did not pass.')
finally:
    # Only the newly installed helper is removed. The normal app/data stay in place.
    run([adb, '-s', args.serial, 'uninstall', package])
