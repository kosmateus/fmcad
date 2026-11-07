"""Short synthetic process trees for timeout tests; no image/CAD imports."""
import os
import signal
import subprocess
import sys
import time

mode = sys.argv[1]
if mode in ('tree', 'leader-exit'):
    child = subprocess.Popen([sys.executable, __file__, 'stubborn'])
    print('descendant=' + str(child.pid), flush=True)
    if mode == 'leader-exit':
        time.sleep(.1)
        raise SystemExit(0)
if mode == 'stubborn':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
print('pid=' + str(os.getpid()), flush=True)
print('retained diagnostic', file=sys.stderr, flush=True)
if mode == 'fail':
    raise SystemExit(7)
if mode != 'success':
    time.sleep(8)
