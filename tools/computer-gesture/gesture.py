#!/usr/bin/env python3
"""Reusable macOS drag input; compiled artifacts stay outside the repository."""
from pathlib import Path
import fcntl
import hashlib
import json
import os
import signal
import subprocess
import sys

source = Path(__file__).with_name('Gesture.swift')
external = Path('/Volumes/DockerExternal/LiFlowColdStorage/ToolCaches/computer-gesture')
cache = Path(os.environ.get('LIFLOW_GESTURE_CACHE', str(external if external.parent.parent.exists() else Path('/tmp/liflow-computer-gesture-cache'))))
cache.mkdir(parents=True, exist_ok=True)
arguments = sys.argv[1:]
if arguments and arguments[0] == 'resume':
    if len(arguments) != 3 or arguments[2] not in ['held', 'moved']:
        raise SystemExit('resume SESSION_DIRECTORY held|moved')
    root = Path(arguments[1]).resolve()
    phase = json.loads((root / 'phase.json').read_text())
    if phase['phase'] != arguments[2]:
        raise SystemExit('The requested checkpoint is not active')
    os.kill(phase['pid'], 0)
    (root / ('continue-' + arguments[2])).touch(exist_ok=False)
    print(json.dumps({'resumed': arguments[2]}))
    raise SystemExit(0)
binary = cache / ('gesture-' + hashlib.sha256(source.read_bytes()).hexdigest()[:16])
if not binary.exists():
    temporary = binary.with_suffix('.' + str(os.getpid()))
    subprocess.run(['swiftc', '-swift-version', '5', '-O', str(source), '-o', str(temporary)], check=True)
    temporary.replace(binary)
with (cache / 'mouse.lock').open('w') as lock:
    if arguments and arguments[0] == 'drag':
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('Another tool drag still owns the mouse')
    process = subprocess.Popen([str(binary), *arguments])
    try:
        raise SystemExit(process.wait())
    except KeyboardInterrupt:
        process.send_signal(signal.SIGINT)
        process.wait(timeout=3)
        raise SystemExit(130)
