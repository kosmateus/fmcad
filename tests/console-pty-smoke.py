"""Offline PTY smoke. Uses fixture projects/config; never connects to Fusion."""
import fcntl
import json
import os
import pathlib
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
import codecs
import re
try:
    import pyte
except ImportError:
    pyte = None


def run_case(root, rows, columns, action, language):
    project = root / ("project-" + action)
    logs = project / ".cad" / "logs"
    logs.mkdir(parents=True)
    (logs / "fmcad.log").write_text("2026-10-20T12:00:00Z INFO fixture job=fixture-1 test event\n")
    config = root / (action + ".json")
    config.write_text(json.dumps({"routing": "direct", "console": {"language": language}}))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    env = dict(os.environ, TERM="xterm-256color", LANG="en_US.UTF-8", FMCAD_CONFIG=str(config), XDG_STATE_HOME=str(root / "state"))
    process = subprocess.Popen(["node", "bin/fmcad.js", "console", "--project", str(project)], stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    output = bytearray()
    screen = pyte.Screen(columns, rows) if pyte else None
    stream = pyte.Stream(screen) if screen else None
    decoder = codecs.getincrementaldecoder('utf-8')('replace')

    def displayed():
        text = ' '.join(screen.display) if screen else re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', output.decode('utf-8', 'replace'))
        return ' '.join(text.split())

    def shows(text):
        actual = displayed()
        return text in actual if screen else ''.join(text.split()) in ''.join(actual.split())

    def pump(seconds=0.15):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([master], [], [], 0.02)[0]:
                try:
                    chunk = os.read(master, 65536)
                    output.extend(chunk)
                    if stream:
                        stream.feed(decoder.decode(chunk))
                except OSError:
                    return

    def key(value):
        os.write(master, value.encode())
        pump()

    try:
        pump(0.4)
        for value in ["2", "3", "4", "5", "v", "?", "2", "\x1b", "4", "/", "fixture", "\r", "f", "\x1b", " ", " ", "l"]:
            key(value)
        key("b")
        pump()
        assert shows("Pauza brokera niedostępna" if language == "pl" else "Broker pause unavailable")
        key("\x1b")
        pump(0.4)
        key("\r")
        assert shows("WPIS LOGU" if language == "pl" else "LOG ENTRY")
        key("\x1b[F")
        key("\x1b[H")
        key("\x1b")
        pump(0.4)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        process.send_signal(signal.SIGWINCH)
        pump()
        if action == "q":
            key("4")
            key("e")
            key(str(root / "visible.jsonl"))
            key("\r")
            assert (root / "visible.jsonl").exists()
            key(",")
            for value in ["\x1b[C", "\t", "\x1b[C", "\t", "\x1b[C", "\t", "\r"]:
                key(value)
            assert json.loads(config.read_text())["console"]["version"] == 1
        if action == "sigterm":
            process.send_signal(signal.SIGTERM)
        else:
            key("q" if action == "q" else "\x03")
        pump(0.4)
        assert process.wait(timeout=4) == 0
        assert b"fmcad console" in output
        assert b"\x1b[?1049h" in output and b"\x1b[?1049l" in output
        assert not (root / "state/fmcad/queue/broker.lock").exists()
        print(f"PASS {columns}x{rows} {language} {action}: navigation, modal isolation, direct mode, resize, cleanup")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)


with tempfile.TemporaryDirectory(prefix="console-pty-") as directory:
    root = pathlib.Path(directory)
    for case in [(24, 80, "q", "pl"), (30, 110, "ctrlc", "en"), (40, 140, "sigterm", "pl")]:
        run_case(root, *case)
