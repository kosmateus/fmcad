"""Bounded Linux/WSL offline children only. Never supervise Fusion itself."""
import datetime
import array
from contextlib import ExitStack
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid
from diagnostics import DiagnosticStream, redact_diagnostic

DEFAULT_TIMEOUT_MS = 0


def timeout_seconds(value=None):
    value = float(value if value is not None else os.environ.get('FMCAD_OFFLINE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS))
    if not math.isfinite(value) or value < 0:
        raise ValueError('offline timeout must be finite nonnegative milliseconds (zero means unlimited)')
    return value / 1000


def event(stage, status, started, **details):
    record = dict(timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  stage=stage, status=status, elapsedSeconds=round(time.monotonic() - started, 6), **details)
    print(redact_diagnostic(json.dumps(record)), file=sys.stderr, flush=True)
    return record


def timed_stage(stage, function, *args, **kwargs):
    started = time.monotonic()
    event(stage, 'started', started)
    try:
        value = function(*args, **kwargs)
    except BaseException:
        event(stage, 'failed', started)
        raise
    event(stage, 'completed', started)
    return value


def run_offline(command, *, log_parent, stage, input_text=None, timeout=None, cwd=None, debug=None,
                max_output_bytes=128 * 1024 * 1024):
    """Pump nonblocking pipes; only redacted diagnostic copies reach disk.

    Raw input/stdout and incomplete diagnostic lines stay bounded in memory;
    overflow fails closed without a raw disk spill.

    Only the new session/group is signalled. SIGTERM/SIGINT of this supervisor
    triggers the same cleanup. Normal exit also cleans up leftover descendants.
    Explicitly fail closed where POSIX group cleanup is unavailable.
    """
    if not sys.platform.startswith('linux') or not Path('/proc/self/stat').is_file():
        raise RuntimeError('Offline process-group supervision requires Linux/WSL with /proc')
    if not isinstance(command, (list, tuple)) or not command or not all(isinstance(arg, str) for arg in command):
        raise ValueError('Offline command must be a nonempty argv string list; no shell')
    if isinstance(max_output_bytes, bool) or not isinstance(max_output_bytes, int) or max_output_bytes <= 0:
        raise ValueError('Offline output limit must be a positive integer')
    source_bytes = (input_text or '').encode('utf-8')
    if len(source_bytes) > 128 * 1024 * 1024:
        raise ValueError('Offline input exceeds limit')
    import fcntl
    import termios
    debug = os.environ.get('FMCAD_OFFLINE_DEBUG') == 'true' if debug is None else debug
    budget = timeout_seconds() if timeout is None else float(timeout)
    if not math.isfinite(budget) or budget < 0:
        raise ValueError('offline timeout seconds must be finite and nonnegative')
    started = time.monotonic()
    deadline = started + budget if budget else float('inf')
    inherited = os.environ.get('FMCAD_OFFLINE_DEADLINE_MONOTONIC')
    if inherited:
        inherited = float(inherited)
        if not math.isfinite(inherited):
            raise ValueError('Invalid inherited offline deadline')
        deadline = min(deadline, inherited)
    if deadline <= started:
        raise TimeoutError('Offline pipeline deadline exhausted; no child started')
    folder = Path(log_parent) / ('execution-' + uuid.uuid4().hex)
    folder.mkdir(mode=0o700)
    folder_inode = folder.lstat()
    active = folder / 'active.json'
    checkpoint = active.open('x+')
    checkpoint.write('{}')
    checkpoint.flush()
    checkpoint_inode = os.fstat(checkpoint.fileno())
    events = (folder / 'events.jsonl').open('x')
    created_inodes = {'events.jsonl': os.fstat(events.fileno())}
    def report(status, **details):
        record = event(stage, status, started, **details)
        events.write(redact_diagnostic(json.dumps(record)) + '\n')
        events.flush()
    interrupted = []
    previous = {}
    child = None
    owned = {}
    cleaned = False
    timed_out = False
    pipes = []
    captures = []
    raw_stdout = bytearray()
    sanitized_stderr = []
    source_offset = 0
    output_bytes = 0
    output_exceeded = False
    def capture_chunk(chunk, capture, raw):
        nonlocal output_bytes, output_exceeded
        output_bytes += len(chunk)
        if output_bytes > max_output_bytes:
            output_exceeded = True
            return
        if raw:
            raw_stdout.extend(chunk)
        capture.feed(chunk)
    def pump():
        nonlocal source_offset
        moved = False
        if child.stdin and not child.stdin.closed:
            try:
                if source_offset < len(source_bytes):
                    source_offset += os.write(child.stdin.fileno(), source_bytes[source_offset:source_offset+65536])
                    moved = True
                if source_offset == len(source_bytes):
                    child.stdin.close()
            except BlockingIOError:
                pass
            except BrokenPipeError:
                child.stdin.close()
        for stream, capture, raw in captures:
            if stream.closed:
                continue
            try:
                chunk = os.read(stream.fileno(), 65536)
            except BlockingIOError:
                continue
            if chunk:
                moved = True
                capture_chunk(chunk, capture, raw)
            else:
                stream.close()
        return moved
    def interrupt(signum, frame):
        nonlocal timed_out
        if signum == signal.SIGALRM:
            timed_out = True
        else:
            interrupted.append(signum)
    def group_signal(signum):
        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            pass
    def discover():
        processes = process_snapshot()
        if not owned and child.pid in processes:
            owned[child.pid] = processes[child.pid][2]
        changed = True
        while changed:
            changed = False
            for pid, (_, parent, identity) in processes.items():
                if pid not in owned and parent in owned and processes.get(parent, (None, None, None))[2] == owned[parent]:
                    owned[pid] = identity
                    changed = True
    def owned_running(signum=None):
        running = False
        for pid, (state, _, identity) in process_snapshot().items():
            if owned.get(pid) == identity and state not in ('Z', 'X'):
                running = True
                if signum is not None:
                    try:
                        os.kill(pid, signum)
                    except ProcessLookupError:
                        pass
        return running
    try:
        # Defer the command alarm while owning a group, including cleanup. An
        # asynchronous exception must not interrupt termination/checkpoint rules.
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
            previous[signum] = signal.signal(signum, interrupt)
        env = dict(os.environ, PYTHONUNBUFFERED='1')
        if math.isfinite(deadline):
            env['FMCAD_OFFLINE_DEADLINE_MONOTONIC'] = str(deadline)
        else:
            env.pop('FMCAD_OFFLINE_DEADLINE_MONOTONIC', None)
        # Sanitize the copy in memory before even creating its file.
        sanitized_input = []
        DiagnosticStream(sanitized_input.append).feed(source_bytes, final=True)
        with (folder / 'stdin.txt').open('x', encoding='utf-8') as source:
            created_inodes['stdin.txt'] = os.fstat(source.fileno())
            source.write(''.join(sanitized_input))
        with (folder / 'stdout.txt').open('x', encoding='utf-8') as out, (folder / 'stderr.txt').open('x', encoding='utf-8') as err, ExitStack() as capture_end:
            created_inodes.update({'stdout.txt': os.fstat(out.fileno()), 'stderr.txt': os.fstat(err.fileno())})
            def write_out(text):
                out.write(text)
                out.flush()
            def write_err(text):
                sanitized_stderr.append(text)
                err.write(text)
                err.flush()
                if os.environ.get('FMCAD_PROGRESS_EVENTS') == '1':
                    for line in text.splitlines(keepends=True):
                        try:
                            value = json.loads(line)
                            progress = isinstance(value, dict) and 'stage' in value and 'status' in value
                        except ValueError:
                            progress = line.startswith('image.optimize: ')
                        if progress:
                            print(line, end='', file=sys.stderr, flush=True)
            child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     bufsize=0, cwd=cwd, env=env, start_new_session=True)
            pipes = [child.stdin, child.stdout, child.stderr]
            for stream in pipes:
                os.set_blocking(stream.fileno(), False)
            captures = [(child.stdout, DiagnosticStream(write_out), True),
                        (child.stderr, DiagnosticStream(write_err), False)]
            for _, capture, _ in captures:
                capture_end.callback(capture.feed, b'', final=True)
            discover()
            checkpoint.seek(0)
            checkpoint.write(json.dumps({'pid': child.pid, 'pgid': child.pid}))
            checkpoint.truncate()
            checkpoint.flush()
            report('started', pid=child.pid, pgid=child.pid,
                   timeoutSeconds=deadline-started if math.isfinite(deadline) else None, logs=str(folder))
            heartbeat = started + 10
            while child.poll() is None:
                discover()
                moved = pump()
                now = time.monotonic()
                timed_out = timed_out or now >= deadline
                if timed_out or interrupted or output_exceeded:
                    break
                if now >= heartbeat:
                    report('running', supervisorHeartbeat=True, pid=child.pid, remainingSeconds=max(0, deadline-now) if math.isfinite(deadline) else None)
                    heartbeat = now + 10
                if not moved:
                    time.sleep(min(.05, max(0, deadline-now)))
            timed_out = timed_out or time.monotonic() >= deadline
            # Clean the entire owned group, even if its leader already exited.
            cleanup_started = time.monotonic()
            discover()
            group_signal(signal.SIGTERM)
            owned_running(signal.SIGTERM)
            cleanup_end = time.monotonic() + 1
            while time.monotonic() < cleanup_end:
                pump()
                child.poll()
                discover()
                try:
                    os.killpg(child.pid, 0)
                except ProcessLookupError:
                    if not owned_running():
                        break
                time.sleep(.02)
            # Nested supervisors own separate sessions. Freeze known parents,
            # collect their children, then kill identity-checked local PIDs too.
            owned_running(signal.SIGSTOP)
            discover()
            group_signal(signal.SIGKILL)
            owned_running(signal.SIGKILL)
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                report('cleanup_unconfirmed', pid=child.pid)
                raise RuntimeError('Owned child did not reap within cleanup bound; inspect ' + str(folder))
            # Reaping the leader alone does not prove its descendants stopped.
            # Linux/WSL exposes process-group members, including stubborn children.
            if not Path('/proc').is_dir():
                raise RuntimeError('Cannot confirm offline descendants stopped; retained checkpoint ' + str(active))
            stop_deadline = time.monotonic() + 1
            while group_running(child.pid) or owned_running():
                pump()
                if time.monotonic() >= stop_deadline:
                    raise RuntimeError('Offline descendants still running; retained checkpoint ' + str(active))
                time.sleep(.02)
            cleaned = True
            # No EOF wait: terminated writers leave a finite kernel pipe buffer.
            # An unobserved inherited writer must not extend our cleanup bound.
            for stream, capture, raw in captures:
                if not stream.closed:
                    available = array.array('i', [0])
                    fcntl.ioctl(stream.fileno(), termios.FIONREAD, available, True)
                    left = available[0]
                    while left:
                        chunk = os.read(stream.fileno(), min(left, 65536))
                        if not chunk:
                            break
                        left -= len(chunk)
                        capture_chunk(chunk, capture, raw)
        status = 'interrupted' if interrupted else 'timed_out' if timed_out else 'output_limit' if output_exceeded else 'completed' if child.returncode == 0 else 'failed'
        report(status, returncode=child.returncode, logs=str(folder), cleanup='confirmed',
               cleanupSeconds=round(time.monotonic() - cleanup_started, 6))
        result = subprocess.CompletedProcess(command, 130 if interrupted else 124 if timed_out else 125 if output_exceeded else child.returncode,
            raw_stdout.decode('utf-8', errors='replace').replace('\r\n', '\n').replace('\r', '\n'),
            ''.join(sanitized_stderr))
        result.log_directory = str(folder)
        result.cleanup_bytes_freed = 0
        return result
    except BaseException:
        report('cleanup_unconfirmed' if child is not None and not cleaned else 'failed',
               timedOut=timed_out, interrupted=bool(interrupted), cleanup='confirmed' if cleaned else 'unconfirmed',
               logs=str(folder))
        raise
    finally:
        try:
            if child is not None and not cleaned:
                group_signal(signal.SIGKILL)
                owned_running(signal.SIGKILL)
                try:
                    child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    pass
        finally:
            for stream in pipes:
                stream.close()
            for signum, handler in previous.items():
                signal.signal(signum, handler)
            events.close()
            checkpoint.close()
        if cleaned:
            from generated_cleanup import collect, identity
            # A replaced checkpoint or diagnostic is not ours, even at the same name.
            checkpoint_identity = identity(active) if active.exists() else None
            if checkpoint_identity and checkpoint_identity[:2] == [checkpoint_inode.st_dev, checkpoint_inode.st_ino]:
                collect({str(active): checkpoint_identity}, [folder])
            if not debug and 'result' in locals() and result.returncode == 0:
                owned = {}
                for name, initial in created_inodes.items():
                    try:
                        current = identity(folder / name)
                    except FileNotFoundError:
                        continue
                    if current and current[:2] == [initial.st_dev, initial.st_ino]:
                        owned[str(folder / name)] = current
                _, freed = collect(owned, [folder])
                # Bytes are transport metadata only; never a disk cleanup report.
                if 'result' in locals():
                    result.cleanup_bytes_freed = freed
                from generated_cleanup import collect_directories
                collect_directories({str(folder): [folder_inode.st_dev, folder_inode.st_ino]}, [folder])


def group_running(pgid):
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            fields = path.read_text().rsplit(') ', 1)[1].split()
            if int(fields[2]) == pgid and fields[0] not in ('Z', 'X'):
                return True
        except (FileNotFoundError, ProcessLookupError):
            pass
    return False


def process_snapshot():
    """Linux/WSL ancestry and start ticks, scoped by the caller to its child."""
    processes = {}
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            fields = path.read_text().rsplit(') ', 1)[1].split()
            processes[int(path.parent.name)] = (fields[0], int(fields[1]), fields[19])
        except (FileNotFoundError, ProcessLookupError):
            pass
    return processes


def call_offline(module, function, args, *, log_parent, kwargs=None):
    payload = json.dumps(dict(module=module, function=function, args=args, kwargs=kwargs or {}), default=str, allow_nan=False)
    result = run_offline([sys.executable, '-B', str(Path(__file__).with_name('offline_worker.py'))],
                         log_parent=log_parent, stage=module + '.' + function, input_text=payload)
    global cleanup_bytes_freed
    cleanup_bytes_freed += result.cleanup_bytes_freed
    if result.returncode:
        error = TimeoutError if result.returncode == 124 else RuntimeError
        raise error(f'Offline {module}.{function} stopped ({result.returncode}); ' +
                    (f'inspect retained logs {result.log_directory}' if Path(result.log_directory).exists()
                     else result.stderr[-4000:]))
    def finite_number(text):
        value = float(text)
        if not math.isfinite(value):
            raise ValueError('Non-finite offline worker JSON output')
        return value
    def invalid_constant(text):
        raise ValueError('Non-finite offline worker JSON output')
    return json.loads(result.stdout, parse_float=finite_number, parse_constant=invalid_constant)


cleanup_bytes_freed = 0
