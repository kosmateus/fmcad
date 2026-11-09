import { execFileSync } from "node:child_process";
import { record } from "../../../core/src/application/cad/contracts";
export interface StopOwnerResult {
  originalDead: true;
  signalsSent: number;
}
export interface StopPreflight {
  pidfd: true;
  signal: "SIGTERM";
  maxAttemptsPerExecution: 2;
}
// A Linux pidfd, not a PID-only kill, binds both TERM attempts to one process.
// The legacy broker handles its first TERM by refusing cooperative close. The
// explicitly approved external migration may then send the second TERM to that
// SAME pidfd. No SIGKILL, process-group signal, debugger, Fusion or SDK access.
const source = String.raw`
import os, sys, json, signal, select, re
x = json.load(sys.stdin)
def birth(pid):
    try:
        with open('/proc/%d/stat' % pid) as f: s = f.read()
        v = s[s.rfind(')') + 2:].split()
        if v[0] in ('Z', 'X'): return None
        with open('/proc/sys/kernel/random/boot_id') as f: boot = f.read().strip()
        return boot + ':' + v[19]
    except FileNotFoundError: return None
def receipt(name):
    p = os.path.join(x['audit'], name + '.json')
    if os.path.exists(p):
        with open(p) as f: old = json.load(f)
        if old != x['owner']: raise RuntimeError('Signal receipt owner conflict')
        return False
    with open(p, 'x') as f:
        os.chmod(p, 0o600)
        json.dump(x['owner'], f); f.flush(); os.fsync(f.fileno())
    fd = os.open(x['audit'], os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
    return True
o = x['owner']
if birth(o['pid']) != o['birth']:
    print(json.dumps({'originalDead': True, 'signalsSent': 0})); sys.exit(0)
fd = os.pidfd_open(o['pid'])
try:
    if birth(o['pid']) != o['birth']: raise RuntimeError('PID birth changed before pidfd binding')
    poll = select.poll(); poll.register(fd, select.POLLIN)
    if os.path.exists(os.path.join(x['audit'], 'stop-refused.json')):
        raise RuntimeError('Original process refused two completed TERM attempts; explicit inspection required')
    sent = 0
    previous = [int(m.group(1)) for name in os.listdir(x['audit'])
                for m in [re.fullmatch(r'term-(\d+)-intent\.json', name)] if m]
    first = max(previous, default=0) + 1
    for n in (first, first + 1):
        if poll.poll(0): break
        if receipt('term-%d-intent' % n):
            signal.pidfd_send_signal(fd, signal.SIGTERM)
            sent += 1
            receipt('term-%d-sent' % n)
        if poll.poll(2500): break
    if not poll.poll(0):
        receipt('stop-refused')
        raise RuntimeError('Exact broker retained after two TERM attempts; no further signal allowed')
    receipt('original-dead')
    print(json.dumps({'originalDead': True, 'signalsSent': sent}))
finally: os.close(fd)
`;

export function stopOwner(
  owner: unknown,
  audit: string,
  python = "python3",
): StopOwnerResult {
  const result: unknown = JSON.parse(
    execFileSync(python, ["-I", "-B", "-c", source], {
      input: JSON.stringify({ owner, audit }),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 65536,
    }),
  );
  if (
    !record(result) ||
    result["originalDead"] !== true ||
    typeof result["signalsSent"] !== "number" ||
    !Number.isSafeInteger(result["signalsSent"]) ||
    result["signalsSent"] < 0 ||
    result["signalsSent"] > 2
  )
    throw new Error("Exact pidfd termination evidence required");
  return { originalDead: true, signalsSent: result["signalsSent"] };
}
export function stopOwnerPreflight(python = "python3"): StopPreflight {
  const result: unknown = JSON.parse(
    execFileSync(
      python,
      [
        "-I",
        "-B",
        "-c",
        "import os,signal,json; assert hasattr(signal,'pidfd_send_signal'); fd=os.pidfd_open(os.getpid()); os.close(fd); print(json.dumps({'pidfd':True,'signal':'SIGTERM','maxAttemptsPerExecution':2}))",
      ],
      { encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
    ),
  );
  if (
    !record(result) ||
    result["pidfd"] !== true ||
    result["signal"] !== "SIGTERM" ||
    result["maxAttemptsPerExecution"] !== 2
  )
    throw new Error("Exact pidfd capability evidence required");
  return { pidfd: true, signal: "SIGTERM", maxAttemptsPerExecution: 2 };
}
