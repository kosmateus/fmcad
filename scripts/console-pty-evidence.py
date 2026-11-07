"""Capture the actual CLI's PTY output, decode VT cells, then rasterize them.

No SDK or live broker actions. --presence-fixture uses a private fake IPC server.
--source-fixture uses an explicitly synthetic local
project to test source-preview safety and mouse/scroll; other captures use real
passive project data.
"""
import argparse
import codecs
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import pyte

parser = argparse.ArgumentParser()
parser.add_argument("--project")
parser.add_argument("--output", required=True)
parser.add_argument("--width", type=int, default=200)
parser.add_argument("--height", type=int, default=52)
parser.add_argument("--source-fixture", action="store_true")
parser.add_argument("--response-fixture", action="store_true")
parser.add_argument("--presence-fixture", action="store_true")
parser.add_argument("--tabs", default="1,2,3,4,5")
parser.add_argument("--task-id")
args = parser.parse_args()
if args.response_fixture:
    args.source_fixture = True
root = Path(__file__).resolve().parent.parent
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)

with tempfile.TemporaryDirectory(prefix="fmcad-pty-evidence-") as temporary:
    temporary = Path(temporary)
    config_path = Path(os.environ.get("FMCAD_CONFIG", Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "fmcad/config.json"))
    cfg = json.loads(config_path.read_text()) if config_path.exists() else {}
    cfg["console"] = {"language": "pl", "color": "auto", "frames": "unicode"}
    source_file = marker = before = before_mtime = None
    publisher = None
    if args.presence_fixture:
        project = temporary / "client-presence-fixture"
        (project / ".cad/logs").mkdir(parents=True)
        cfg["routing"] = "queue"
        cfg["console"]["language"] = "en"
    elif args.source_fixture:
        project = temporary / "source-preview-fixture"
        direct = project / ".cad/telemetry/direct"
        direct.mkdir(parents=True)
        source_file = project / "preview_fixture.py"
        marker = project / "MUST_NOT_EXECUTE"
        source_file.write_text("from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('BAD')\n\ndef area(a,b):\n return a*b\n" + "\n".join("value_" + str(i) + "=" + str(i) for i in range(180)) + "\n")
        before = hashlib.sha256(source_file.read_bytes()).hexdigest()
        before_mtime = source_file.stat().st_mtime_ns
        birth_fields = Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()
        birth = Path("/proc/sys/kernel/random/boot_id").read_text().strip() + ":" + birth_fields[19]
        sid = "11111111-1111-4111-8111-111111111111"
        (direct / (sid + ".json")).write_text(json.dumps({"version": 1, "id": sid, "pid": os.getpid(), "birth": birth,
            "project": str(project), "observedAt": int(time.time() * 1000), "sequence": 1, "operations": [{"id": "source-fixture", "sessionId": sid,
            "state": "running", "label": "run preview_fixture.py", "startedAt": int(time.time() * 1000), "sourcePath": str(source_file), "sourceHash": before}]}))
        cfg["routing"] = "direct"
        if args.response_fixture:
            queue = temporary / "private-state/fmcad/queue"
            job_dir = queue / "jobs/source-fixture"
            job_dir.mkdir(parents=True)
            (queue / "queue-state.json").write_text(json.dumps({"version": 1, "paused": False, "jobs": {
                "source-fixture": {"id": "source-fixture", "state": "succeeded", "clientId": "mcp-stdio:fixture-client", "startedAt": 1792508794000, "finishedAt": 1792508796000,
                    "request": {"kind": "command", "cwd": str(project), "argv": ["run", str(source_file)]}}}}))
            log_dir = project / ".cad/logs"
            log_dir.mkdir(parents=True)
            (log_dir / "fmcad.log").write_text("2026-10-20T20:00:00Z INFO heartbeat synthetic latest event\n" * 3000)
            (log_dir / "fmcad-2026-10-20_15.log").write_text("\n".join([
                "2026-10-20T15:06:34Z INFO job_running job=source-fixture",
                "2026-10-20T15:06:35Z INFO job_sending job=source-fixture",
                "2026-10-20T15:06:36Z INFO job_succeeded job=source-fixture", ""]))
            result_dir = project / ".cad/results/source-fixture"
            result_dir.mkdir(parents=True)
            (result_dir / "stdout.txt").write_text(json.dumps({"success": True, "document": "Fixture Fusion document",
                "result": {"count": 42, "modified": False, "note": "Synthetic offline response", "items": list(range(100))}}))
            (result_dir / "stderr.txt").write_text("Synthetic diagnostic stream; not a Fusion result.\n")
            cfg["routing"] = "queue"
    else:
        if not args.project:
            parser.error("--project required for real-data captures")
        project = Path(args.project).resolve()
    private_config = temporary / "config.json"
    private_config.write_text(json.dumps(cfg))
    private_config.chmod(0o600)
    env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", FMCAD_CONFIG=str(private_config))
    env.pop("NO_COLOR", None)
    if args.source_fixture or args.presence_fixture:
        env["XDG_STATE_HOME"] = str(temporary / "private-state")
        env["FMCAD_ROUTING"] = "queue" if args.response_fixture or args.presence_fixture else "direct"
    if args.presence_fixture:
        code = """
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {queueDirectory,queueSocket}=require(ROOT+'/src/queue-connection');
const {QueueClient}=require(ROOT+'/src/queue-client');
const {processBirth}=require(ROOT+'/src/queue-instance');
const dir=queueDirectory();fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'queue-state.json'),JSON.stringify({version:1,paused:false,jobs:{}}));
fs.writeFileSync(path.join(dir,'broker.lock'),JSON.stringify({pid:process.pid,birth:processBirth(),nonce:'offline-fixture',protocol:2}));
const server=net.createServer(socket=>socket.once('data',()=>socket.end(JSON.stringify({ok:true,result:{id:'fixture-job'}})+'\\n')));
server.listen(queueSocket(dir),async()=>{try{const c=new QueueClient('mcp-stdio:live-fixture');await c.register();
await c.call('submit',{request:{kind:'rpc',cwd:process.cwd()}});console.log('READY');}
catch(e){console.error(e);process.exit(1)}});
let closing=false;const shutdown=()=>{if(closing)return;closing=true;fs.unlinkSync(path.join(dir,'broker.lock'));server.close(()=>process.exit(0))};
process.stdin.resume();process.stdin.once('data',shutdown);process.stdin.once('end',shutdown);
""".replace("ROOT", json.dumps(str(root)))
        publisher = subprocess.Popen(["node", "-e", code], cwd=project, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if not select.select([publisher.stdout], [], [], 8)[0] or publisher.stdout.readline().strip() != b"READY":
            publisher.kill()
            publisher.wait()
            raise AssertionError("Presence fixture did not register")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", args.height, args.width, 0, 0))
    child = subprocess.Popen(["node", str(root / "bin/fmcad.js"), "console", "--project", str(project)], cwd=root,
        stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    screen = pyte.Screen(args.width, args.height)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    raw = bytearray()

    def pump(seconds=0.2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.02)[0]:
                try:
                    data = os.read(master, 262144)
                except OSError:
                    return
                raw.extend(data)
                stream.feed(decoder.decode(data))

    def key(text, seconds=0.25):
        os.write(master, text.encode())
        pump(seconds)

    def click(x, y):
        key(f"\x1b[<0;{x+1};{y+1}M", 0.1)
        key(f"\x1b[<0;{x+1};{y+1}m", 0.25)

    def find(text, start=0):
        for y, line in enumerate(screen.display):
            if y < start:
                continue
            x = line.find(text)
            if x >= 0:
                return x, y
        raise AssertionError("Visible text not found: " + text)

    def text():
        return "\n".join(screen.display)

    def capture(name):
        cells = [[{"char": screen.buffer[y][x].data, "attr": {"color": screen.buffer[y][x].fg,
            "bgColor": screen.buffer[y][x].bg, "bold": screen.buffer[y][x].bold, "inverse": screen.buffer[y][x].reverse}}
            for x in range(args.width)] for y in range(args.height)]
        file = output / (name + ".png")
        subprocess.run([sys.executable, str(root / "scripts/console-rasterize.py"), str(file)],
            input=json.dumps({"width": args.width, "height": args.height, "cells": cells}), text=True, check=True)
        (output / (name + ".txt")).write_text(text())
        print(file)

    try:
        pump(2.6)
        assert child.poll() is None
        active_x, active_y = find('[1] Overview' if args.presence_fixture else '[1] Przegląd')
        active_background = screen.buffer[active_y][active_x].bg
        if args.presence_fixture:
            assert "presence confirmed (process)" in text(), text()
            capture("pty-presence-confirmed-overview")
            key("2")
            assert "mcp-stdio:live-fixture" in text()
            capture("pty-presence-confirmed-client")
            publisher.stdin.write(b"quit\n")
            publisher.stdin.flush()
            assert publisher.wait(timeout=5) == 0
            key("1")
            key("r")
            assert "0 online · 1 offline" in text(), text()
            assert "presence confirmed (process)" not in text()
            capture("pty-presence-offline-overview")
        elif args.source_fixture:
            key("3")
            if args.response_fixture:
                assert "py · preview_fixture.py" in text()
                assert "Rozpoczęto wykonanie" in text(), text()
                capture("pty-tasks-source-response-fixture")
                key("/")
                key("preview_fixture")
                key("\r")
                assert "Filtry (1)" in text()
                capture("pty-active-filters-fixture")
                x, y = find("[x] Resetuj filtry")
                click(x + 2, y)
                assert "Resetuj filtry" not in text()
                x, y = find("Logi zadania")
                click(x + 2, y)
                pump(2.2)
                assert "Rozpoczęto wykonanie" in text(), text()
                capture("pty-task-archive-logs-fixture")
                key("3")
            key("p", 1.0)
            assert "Black + Pygments" in text(), text()[:1000]
            assert "def area(a, b):" in text()
            capture("pty-source-fixture")
            click(20, 2)  # Background tab under modal: must not click through.
            assert "Black + Pygments" in text()
            key("\x1b[C")
            assert "Kolumna: 9" in text()
            key("\x1b[D")
            key("\x1b[<65;90;18M")
            key("\x1b[F")
            assert "value_179" in text()
            key("\x1b[H")
            # Drag the real scrollbar thumb down, then release it.
            modal_width = min(144, args.width - 4)
            bar_x = (args.width - modal_width) // 2 + modal_width - 2
            key(f"\x1b[<0;{bar_x};9M")
            key(f"\x1b[<32;{bar_x};{args.height-7}M")
            key(f"\x1b[<0;{bar_x};{args.height-7}m")
            assert "value_179" in text()
            key("\x1b", 0.5)
            if args.response_fixture:
                key("y", 0.8)
                assert "ZAPISANA ODPOWIEDŹ" in text(), text()
                assert "Synthetic offline response" in text()
                assert "/.cad/results/source-fixture/stdout.txt" in text()
                capture("pty-response-fixture")
                key("\x1b[F")
                assert "99" in text()
                key("\x1b[H")
                key("\t")
                assert "Synthetic diagnostic stream" in text()
                key("\x1b", 0.5)
                key("\r")
                key("y", 0.8)
                assert "ZAPISANA ODPOWIEDŹ" in text()
                key("\x1b", 0.5)
                assert not (queue / "broker.lock").exists()
                key("2")
                assert "Tylko historia" in text()
                assert "MCP stdio" in text()
                assert "nie śledzi obecności" in text()
                capture("pty-clients-history-fixture")
                key("\t")
                key("\x1b[F")
                assert "job_running" in text(), text()
            assert hashlib.sha256(source_file.read_bytes()).hexdigest() == before
            assert source_file.stat().st_mtime_ns == before_mtime
            assert not marker.exists()
        else:
            for tab, name in [(1, "overview"), (2, "agents"), (3, "tasks"), (4, "logs"), (5, "system")]:
                if str(tab) not in args.tabs.split(','):
                    continue
                label = {1: "[1] Przegląd", 2: "[2] Klienci", 3: "[3] Zadania", 4: "[4] Logi", 5: "[5] System"}[tab]
                x, y = find(label)
                click(x + 2, y)
                x, y = find(label)
                assert screen.buffer[y][x].bg == active_background, "Mouse tab selection failed"
                if tab in (2, 3):
                    x, y = find("Historia", 4)
                    click(x + 2, y)
                if tab == 3 and args.task_id:
                    key("/")
                    key(args.task_id)
                    key("\r", 0.5)
                pump(0.3)
                assert "ENOENT" not in text()
                capture("pty-" + name)
                if tab == 3 and args.task_id:
                    x, y = find("[x] Resetuj filtry")
                    click(x + 2, y)
                    assert "Resetuj filtry" not in text()
                    capture("pty-tasks-reset")
        key("q")
        pump(0.3)
        assert child.wait(timeout=5) == 0
        assert b"\x1b[?1049l" in raw
        assert b"\x1b[?1002l" in raw
        (output / ("pty-source-result.json" if args.source_fixture else "pty-result.json")).write_text(json.dumps({
            "source": "Actual CLI PTY output decoded by pyte", "fixture": args.source_fixture or args.presence_fixture,
            "project": str(project), "columns": args.width, "rows": args.height, "mouseTabs": not (args.source_fixture or args.presence_fixture),
            "clientPresenceLifecycle": args.presence_fixture,
            "sourceNeverExecuted": not marker.exists() if marker else None,
            "sourceFileUnchanged": hashlib.sha256(source_file.read_bytes()).hexdigest() == before if source_file else None,
            "exitCode": child.returncode, "preferencesForCapture": {"language": "pl", "color": "auto", "frames": "unicode"}}, indent=2))
    finally:
        if publisher is not None and publisher.poll() is None:
            publisher.kill()
            publisher.wait()
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
