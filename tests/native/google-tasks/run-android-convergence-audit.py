"""Explicit live Google probe using only the installed app's existing grant, in its UID.

The separate same-signer test APK is removed afterwards. LiFlow and its data remain.
No tokens, account labels, credential files, or provider bodies leave the phone.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--build-only', action='store_true')
parser.add_argument('--apk', type=Path)
parser.add_argument('--mapping-before', help='Optional UTC snapshot time; compare the digest of mappings created before it.')
args = parser.parse_args()
if args.mapping_before:
    from datetime import datetime
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z', args.mapping_before):
        raise SystemExit('Mapping snapshot must be an exact UTC ISO timestamp.')
    datetime.fromisoformat(args.mapping_before.replace('Z', '+00:00'))
root = Path(__file__).resolve().parents[3]
output = Path(args.output).resolve()
if root == output or root in output.parents:
    raise SystemExit('Use an output directory outside the checkout.')
output.mkdir(parents=True, exist_ok=True)
sdk = Path(os.environ.get('ANDROID_HOME', str(Path.home() / 'Library/Android/sdk')))
java = Path(os.environ['JAVA_HOME']) / 'bin'
version = lambda path: tuple(int(n) for n in re.findall(r'\d+', path.name))
build = max((sdk / 'build-tools').iterdir(), key=version)
android = max((sdk / 'platforms').glob('android-*/android.jar'), key=lambda path: version(path.parent))
cache = Path.home() / '.gradle/caches/modules-2/files-2.1'
jars = []
for group, name, suffix in [
    ('com.google.android.gms', 'play-services-auth', '.aar'),
    ('com.google.android.gms', 'play-services-auth-base', '.aar'),
    ('com.google.android.gms', 'play-services-base', '.aar'),
    ('com.google.android.gms', 'play-services-basement', '.aar'),
    ('com.google.android.gms', 'play-services-tasks', '.aar'),
    ('androidx.collection', 'collection-jvm', '.jar'),
    ('androidx.core', 'core', '.aar'),
    ('org.jetbrains.kotlin', 'kotlin-stdlib', '.jar'),
]:
    directory = max((cache / group / name).iterdir(), key=version)
    archive = next(path for path in directory.glob('*/*') if path.name == name + '-' + directory.name + suffix)
    if suffix == '.aar':
        jar = output / (name + '.jar')
        with zipfile.ZipFile(archive) as source:
            jar.write_bytes(source.read('classes.jar'))
    else:
        jar = archive
    jars.append(jar)

def run(arguments, **kwargs):
    return subprocess.run([str(item) for item in arguments], check=True, **kwargs)

classes = output / 'classes'
classes.mkdir(exist_ok=True)
run([java / 'javac', '-source', '8', '-target', '8', '-cp', os.pathsep.join(map(str, [android, *jars])),
     '-d', classes, Path(__file__).with_name('TasksConvergenceAudit.java')])
manifest = output / 'AndroidManifest.xml'
manifest.write_text('''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="jp.jphacks.tkb2633.tasksconvergence">
<uses-sdk android:minSdkVersion="29" android:targetSdkVersion="37"/><uses-permission android:name="android.permission.INTERNET"/>
<application android:label="LiFlow synthetic Google probe" android:testOnly="true"/>
<instrumentation android:name="jp.jphacks.tkb2633.tasksconvergence.TasksConvergenceAudit" android:targetPackage="jp.jphacks.tkb2633"/></manifest>''')
apk = output / 'tasks-convergence-audit.apk'
run([build / 'aapt2', 'link', '-I', android, '--manifest', manifest, '-o', apk])
dex = output / 'dex'
dex.mkdir(exist_ok=True)
run([build / 'd8', '--lib', android, '--min-api', '29', '--output', dex, *classes.rglob('*.class'), *jars])
with zipfile.ZipFile(apk, 'a') as target:
    for item in dex.glob('classes*.dex'):
        target.write(item, item.name)
run([build / 'apksigner', 'sign', '--ks', root / 'android/app/debug.keystore', '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android', apk])
if args.build_only:
    raise SystemExit(0)
adb = sdk / 'platform-tools/adb'
if not args.apk or not args.apk.is_file(): raise SystemExit('Exact installed normal APK required')
import hashlib
read = lambda *a: subprocess.run([str(adb), '-s', args.serial, *a],check=True,capture_output=True,text=True).stdout
paths=[s[len('package:'):] for s in read('shell','pm','path','jp.jphacks.tkb2633').splitlines() if s.endswith('/base.apk')]
assert len(paths)==1 and read('shell','sha256sum',paths[0]).split()[0]==hashlib.sha256(args.apk.read_bytes()).hexdigest(),'Installed normal APK mismatch'
active=read('shell','dumpsys','jobscheduler').split('Active jobs:',1)[1].split('\nmReady',1)[0]
assert not any('jp.jphacks.tkb2633/' in s for s in active.splitlines() if 'Slot #' in s),'Target worker executing; do not interrupt'
assert not read('shell','pm','list','packages','jp.jphacks.tkb2633.tasksconvergence').strip(),'Preserve existing helper'
run([adb, '-s', args.serial, 'install', '-r', '-t', apk])
try:
    extra = ['-e', 'mappingBefore', args.mapping_before] if args.mapping_before else []
    result = run([adb, '-s', args.serial, 'shell', 'am', 'instrument', '-w', *extra,
                  'jp.jphacks.tkb2633.tasksconvergence/jp.jphacks.tkb2633.tasksconvergence.TasksConvergenceAudit'], capture_output=True, text=True)
    # Only our fixed fields are printed. An Android framework failure is retained as a code.
    lines = [line for line in result.stdout.splitlines() if re.match(
        r'INSTRUMENTATION_(?:RESULT: (?:authorization|probe|stage|errorClass|evidenceJSON)=|CODE:)', line)]
    print('\n'.join(lines), flush=True)
    if not any(line.startswith('INSTRUMENTATION_RESULT: evidenceJSON=') for line in lines):
        raise SystemExit('Probe did not return its own evidence fields.')
finally:
    run([adb, '-s', args.serial, 'uninstall', 'jp.jphacks.tkb2633.tasksconvergence'])
