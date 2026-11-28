"""Explicit fake SDK for the actual generated bound readiness program, no sockets."""
import builtins
import importlib
import io
import json
import os
from pathlib import Path
import sys
import types

request = json.load(sys.stdin)
scenario = request.get("scenario", "valid")
events = []
original_open = builtins.open

def fake_open(name, *args, **kwargs):
    if name == "/proc/self/stat":
        return io.StringIO("991 (fake readiness) " + " ".join(["S"] + ["0"] * 18 + ["1"]))
    if name == "/proc/sys/kernel/random/boot_id":
        return io.StringIO("fakeboot\n")
    return original_open(name, *args, **kwargs)

builtins.open = fake_open
os.getpid = lambda: 991

class Script:
    def __init__(self, index):
        self.index = index

    def __getattribute__(self, name):
        if name in ("folder", "location", "isAddIn", "isRunOnStartup",
                    "isRunning", "isVisible", "manifestContent"):
            events.append(name)
        return object.__getattribute__(self, name)

    @property
    def folder(self):
        if scenario == "folder-null":
            return None
        if scenario == "folder-relative":
            return "relative"
        if scenario == "getter-failure":
            raise RuntimeError("owned getter failure")
        return "/owned/script-" + str(self.index)

    @property
    def location(self):
        return 999 if scenario == "unknown-enum" else 2

    @property
    def isAddIn(self):
        return 1 if scenario == "boolean-int" else self.index == 0

    @property
    def isRunOnStartup(self):
        assert self.index == 0, "SDK startup getter is invalid for ordinary scripts"
        return None if scenario == "startup-null" else False

    @property
    def isRunning(self):
        return None if scenario == "running-null" else self.index == 0

    @property
    def isVisible(self):
        if scenario == "visible-missing":
            raise AttributeError("isVisible unavailable")
        return self.index == 0

    @property
    def manifestContent(self):
        if scenario == "manifest-budget":
            return '{"x":"' + "x" * (256 * 1024) + '"}'
        if scenario == "audit-budget":
            return '{"x":"' + "x" * (256 * 1024 - 100) + '"}'
        if scenario == "manifest-exact":
            return '{"x":"' + "x" * (256 * 1024 - 8) + '"}'
        return {
            "manifest-null": None, "manifest-empty": "", "manifest-number": 12,
            "manifest-bad": "{", "manifest-duplicate": '{"x":1,"x":2}',
            "manifest-nonfinite": '{"x":NaN}', "manifest-overflow": '{"x":1e999}',
            "manifest-array": "[]",
        }.get(scenario, '{"custom":"żółć 日本語","number":1.25}')

    def run(self, *args):
        raise AssertionError("No Script.run")

    def stop(self):
        raise AssertionError("No Script.stop")

class Scripts:
    reads = 0

    @property
    def count(self):
        events.append("count")
        self.reads += 1
        if scenario == "count-null": return None
        if scenario == "count-bool": return True
        if scenario == "count-negative": return -1
        if scenario == "count-budget": return 1025
        if scenario == "count-change" and self.reads > 1: return 3
        if scenario == "empty": return 0
        if scenario == "max-count": return 1024
        return 17 if scenario == "audit-budget" else 2

    def item(self, index):
        events.append("item")
        return None if scenario == "item-null" else Script(index)

    def addExisting(self, *args):
        raise AssertionError("No addExisting")

class Api:
    reads = 0

    @property
    def defaultPathForScriptsAndAddIns(self):
        events.append("apiParent")
        self.reads += 1
        if scenario == "parent-null": return None
        return "/owned/changed" if scenario == "parent-change" and self.reads > 1 else "/owned/api-parent"

class App:
    version = "fake-startup-sdk-1"
    userInterface = types.SimpleNamespace(activeCommand="SelectCommand")
    documents = types.SimpleNamespace(count=0, item=lambda _: None)

    def __init__(self):
        self.collection = Scripts()
        self.api = Api()

    @property
    def preferences(self):
        events.append("preferences")
        if scenario == "unsupported-sdk":
            raise AttributeError("apiPreferences unavailable")
        return types.SimpleNamespace(apiPreferences=self.api)

    @property
    def scripts(self):
        events.append("scripts")
        return None if scenario == "scripts-null" else self.collection

app = App()
core = types.ModuleType("adsk.core")
core.Application = types.SimpleNamespace(get=lambda: app)
core.ScriptSourceLocations = types.SimpleNamespace(**{
    name: index for index, name in enumerate((
        "AppStoreScriptSourceLocation", "OtherInstalledScriptSourceLocation",
        "UserDefinedScriptSourceLocation", "InternalScriptSourceLocation",
        "SamplesScriptSourceLocation", "LinkedScriptSourceLocation"))})
if scenario == "enum-missing":
    del core.ScriptSourceLocations.LinkedScriptSourceLocation
if scenario == "enum-bool":
    core.ScriptSourceLocations.LinkedScriptSourceLocation = True
adsk = types.ModuleType("adsk")
adsk.core = core
sys.modules.update({"adsk": adsk, "adsk.core": core})

reference = None
if request.get("reference"):
    package = types.ModuleType("audit_reference")
    package.__path__ = [str(Path(request["reference"]).parents[1])]
    sys.modules["audit_reference"] = package
    dispatch = types.ModuleType("audit_reference.fusion_bridge.dispatch")
    dispatch.assert_startup_queue = lambda entry: None
    sys.modules["audit_reference.fusion_bridge.dispatch"] = dispatch
    module = importlib.import_module("audit_reference.lib.startup_audit")
    try:
        reference = {"audit": module._capture(app, types.SimpleNamespace(assert_not_refused=lambda: None))}
    except Exception as error:
        reference = {"refused": type(error).__name__, "message": str(error)}
    app = App()
    events.clear()

try:
    namespace = {"__name__": "__main__"}
    exec(compile(request["script"], "<actual-readiness-program>", "exec"), namespace)
    namespace["run"](None)
finally:
    print("FAKE_STARTUP_REPORT " + json.dumps({"events": events, "reference": reference}))
