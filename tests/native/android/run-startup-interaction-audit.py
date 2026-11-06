"""Measure a preserved installed Release with a separate read-only UI instrumentation APK."""
import argparse, os, re, subprocess, zipfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--serial',required=True);p.add_argument('--output',required=True);p.add_argument('--build-only',action='store_true');p.add_argument('--before-tap-delay-ms',type=int,default=0);a=p.parse_args()
if not 0<=a.before_tap_delay_ms<=20000:raise SystemExit('Observation delay must be between0 and20000ms')
root=Path(__file__).resolve().parents[3];out=Path(a.output).resolve()
if root==out or root in out.parents:raise SystemExit('Output must be outside the source checkout')
out.mkdir(parents=True,exist_ok=True);sdk=Path(os.environ.get('ANDROID_HOME',str(Path.home()/'Library/Android/sdk')));java=Path(os.environ['JAVA_HOME'])/'bin'
version=lambda path:tuple(int(n) for n in re.findall(r'\d+',path.name))
tools=max((sdk/'build-tools').iterdir(),key=version);android=max((sdk/'platforms').glob('android-*/android.jar'),key=lambda x:version(x.parent))
classes=out/'classes';classes.mkdir(exist_ok=True)
def run(argv):subprocess.run([str(x) for x in argv],check=True)
run([java/'javac','-source','8','-target','8','-cp',android,'-d',classes,Path(__file__).with_name('StartupInteractionAudit.java')])
package='jp.jphacks.tkb2633.startupaudit';manifest=out/'AndroidManifest.xml'
manifest.write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{package}"><uses-sdk android:minSdkVersion="24" android:targetSdkVersion="37"/><uses-permission android:name="android.permission.WAKE_LOCK"/><application android:label="LiFlow read-only startup audit" android:testOnly="true"/><instrumentation android:name="{package}.StartupInteractionAudit" android:targetPackage="{package}"/></manifest>''')
apk=out/'startup-interaction-audit.apk';run([tools/'aapt2','link','-I',android,'--manifest',manifest,'-o',apk]);dex=out/'dex';dex.mkdir(exist_ok=True)
run([tools/'d8','--lib',android,'--min-api','24','--output',dex,*classes.rglob('*.class')])
with zipfile.ZipFile(apk,'a') as z:z.write(dex/'classes.dex','classes.dex')
run([tools/'apksigner','sign','--ks',root/'android/app/debug.keystore','--ks-key-alias','androiddebugkey','--ks-pass','pass:android',apk])
if a.build_only:raise SystemExit(0)
adb=sdk/'platform-tools/adb';run([adb,'-s',a.serial,'install','-r','-t',apk])
try:
 r=subprocess.run([str(adb),'-s',a.serial,'shell','am','instrument','-w','-e','beforeTapDelayMs',str(a.before_tap_delay_ms),package+'/'+package+'.StartupInteractionAudit'],capture_output=True,text=True,timeout=360)
 (out/'native-observations.log').write_text(r.stdout+r.stderr);print(r.stdout,flush=True);r.check_returncode()
 if 'result=PASS' not in r.stdout or 'INSTRUMENTATION_CODE: -1' not in r.stdout:raise SystemExit('Read-only startup/interaction audit did not pass')
finally:run([adb,'-s',a.serial,'uninstall',package])
