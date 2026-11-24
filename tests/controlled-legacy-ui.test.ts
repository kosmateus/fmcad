import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createControlledLegacyHostUi,
  controlledLegacyUiAuditPaths,
} from "../packages/node-adapters/src/execution/controlled-legacy-ui";
import type {
  ControlledNativeAdapter,
  ControlledFile,
} from "../packages/node-adapters/src/execution/controlled-fusion-launch-types";
import type { ControlledUiEntryIntentV2 } from "../packages/node-adapters/src/execution/controlled-ui-intent-v2";
import {
  readLegacyUiCapture,
  requireLegacyEntry,
  type LegacyUiCapture,
} from "../packages/node-adapters/src/execution/controlled-legacy-ui-contract";

const process = { pid: 34496, birth: "134399170899524665" };
const entry = "C:\\owned\\AutodeskFusionMCP\\AutodeskFusionMCP.py";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=";
function fixture(): LegacyUiCapture {
  const control = (
    runtimeId: string,
    parent: string | null,
    id: string,
    name: string,
    type: string,
    className = "",
  ) => ({
    runtimeId,
    parent,
    id,
    name,
    type,
    class: className,
    pid: process.pid,
    enabled: true,
    offscreen: false,
    selected: null,
    value: null,
    readOnly: null,
    toggle: null,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  const base = "QTApplication.Nu::QTScriptsManagerDialog";
  const tree = `${base}.QTabWidget.qt_tabwidget_stackedwidget.Nu::QTScriptsManagerAddInsTab.QTreeView`;
  return {
    process,
    mainHwnd: "243009868",
    mode: "manager",
    dialogHwnd: "6818720",
    image: { width: 1, height: 1, png },
    controls: [
      control(
        "dialog",
        null,
        base,
        "Skrypty i dodatki",
        "ControlType.Window",
        "Nu::QTScriptsManagerDialog",
      ),
      {
        ...control(
          "tab",
          "dialog",
          `${base}.QTabWidget.qt_tabwidget_tabbar`,
          "Dodatki",
          "ControlType.TabItem",
        ),
        selected: true,
      },
      control("tree", "dialog", tree, "", "ControlType.Tree", "QTreeView"),
      {
        ...control(
          "entry",
          "tree",
          tree,
          "AutodeskFusionMCP",
          "ControlType.TreeItem",
        ),
        selected: true,
      },
      control(
        "label",
        "dialog",
        `${base}.QLabel`,
        "Pełna ścieżka",
        "ControlType.Text",
        "QLabel",
      ),
      {
        ...control(
          "path",
          "dialog",
          `${base}.QPlainTextEdit`,
          "",
          "ControlType.Edit",
          "QPlainTextEdit",
        ),
        value: entry,
        readOnly: true,
      },
      control(
        "run",
        "dialog",
        `${base}.QToolButton`,
        "Uruchom",
        "ControlType.Button",
        "QToolButton",
      ),
      {
        ...control(
          "startup",
          "dialog",
          `${base}.QCheckBox`,
          "Uruchom przy starcie",
          "ControlType.CheckBox",
          "QCheckBox",
        ),
        toggle: "Off",
      },
    ],
    treeSelection: { tree: "tree", rows: ["entry"] },
  };
}
test("Qt legacy entry is bound to its active tree selection and separate readonly labeled path, not row Name", () => {
  const value = fixture();
  const capture = readLegacyUiCapture(JSON.stringify(value), process);
  assert.equal(requireLegacyEntry(capture, entry).row.runtimeId, "entry");
});
test("actual .16 disagreement and category-with-enabled-Run are DENY, not synthetic vendor PASS", () => {
  const value = fixture();
  value.controls.push({
    ...value.controls[3]!,
    runtimeId: "previous",
    name: "Moje dodatki",
    selected: false,
  });
  value.treeSelection!.rows = ["previous"];
  assert.throws(() => requireLegacyEntry(value, entry), /selection/i);
  const category = fixture();
  category.controls[3]!.name = "Moje dodatki";
  category.controls[5]!.value = "";
  assert.throws(() => requireLegacyEntry(category, entry), /entry|path/i);
});

/** Process-boundary fixture, NOT Windows UIA/Fusion or a vendor qualification. */
function portFixture(
  t: { after(fn: () => void): void },
  scenario = "ready",
  originalLegacy: "On" | "Off" = "Off",
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-ui-port-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const bin = path.join(root, "os-helper");
  const config = path.join(root, "fixture.json");
  const statePath = path.join(root, "state.json");
  const eventsPath = path.join(root, "events.jsonl");
  const nativeDirectory = "C:\\owned\\AutodeskFusionMCP";
  const nativeAudit = "C:\\private\\ui";
  const paths = {
    profile: "C:\\private\\profile.json",
    profileBackup: "C:\\private\\backup.json",
    intent: "C:\\private\\intent.json",
    receiptDirectory: "C:\\private\\receipts",
    entry: "C:\\private\\receipts\\entry.json",
    returned: "C:\\private\\receipts\\returned.json",
    launchJournal: "C:\\private\\launch.json",
    launchAttempt: "C:\\private\\launch-attempt.json",
    sourceClosure: "C:\\private\\closure.json",
    transcript: "C:\\private\\transcript.json",
    provision: "C:\\private\\provision.json",
  };
  const mappings: Record<string, string> = {};
  for (const n of [
    ...Object.values(paths),
    ...controlledLegacyUiAuditPaths(nativeAudit, paths.intent),
    entry,
    `${nativeDirectory}\\AutodeskFusionMCP.manifest`,
  ])
    mappings[n] = path.join(root, `original-${Object.keys(mappings).length}`);
  const write = (nativePath: string, b: Uint8Array) => {
    const mapped = mappings[nativePath];
    assert.ok(mapped);
    fs.writeFileSync(mapped, b, { flag: "wx" });
  };
  write(entry, Buffer.from("# benign entry data; never imported\n"));
  write(
    `${nativeDirectory}\\AutodeskFusionMCP.manifest`,
    Buffer.from('{"type":"addin","runOnStartup":true}'),
  );
  const profileBytes = Buffer.from(
    JSON.stringify({
      loadedScripts: [
        {
          name: "AutodeskFusionMCP",
          path: entry,
          location: 3,
          isRemoved: false,
          isFavorite: false,
          runOnStartup: false,
        },
      ],
    }),
  );
  write(paths.profile, profileBytes);
  const files = {
    "AutodeskFusionMCP.py": hash(fs.readFileSync(mappings[entry]!)),
    "AutodeskFusionMCP.manifest": hash(
      fs.readFileSync(
        mappings[`${nativeDirectory}\\AutodeskFusionMCP.manifest`]!,
      ),
    ),
  };
  const manager = fixture();
  const prefs: LegacyUiCapture = {
    process,
    mainHwnd: "243009868",
    mode: "preferences",
    dialogHwnd: "700",
    treeSelection: null,
    image: { width: 1, height: 1, png },
    controls: [
      {
        ...manager.controls[0]!,
        runtimeId: "prefs",
        id: "QTApplication.Nu::QTPreferencesDialog",
        name: "Preferencje",
        class: "Nu::QTPreferencesDialog",
      },
      {
        ...manager.controls[1]!,
        parent: "prefs",
        runtimeId: "api",
        name: "API",
        type: "ControlType.TreeItem",
        id: "QTApplication.Nu::QTPreferencesDialog.QTreeView",
      },
      {
        ...manager.controls[0]!,
        parent: "prefs",
        runtimeId: "group",
        type: "ControlType.Group",
        id: "QTApplication.Nu::QTPreferencesDialog.QFrame.scrollArea1.qt_scrollarea_viewport.BaseWidget1",
      },
      {
        ...manager.controls[4]!,
        parent: "group",
        runtimeId: "legacy-label",
        name: "Starsze okno dialogowe Skrypty",
        y: 10,
      },
      {
        ...manager.controls[7]!,
        parent: "group",
        runtimeId: "legacy",
        name: "",
        x: 7,
        y: 10,
        toggle: "Off",
      },
      {
        ...manager.controls[6]!,
        parent: "prefs",
        runtimeId: "apply",
        name: "Zastosuj",
        class: "QPushButton",
        enabled: false,
      },
      {
        ...manager.controls[6]!,
        parent: "prefs",
        runtimeId: "cancel",
        name: "Anuluj",
        class: "QPushButton",
      },
      {
        ...manager.controls[6]!,
        parent: "group",
        runtimeId: "debug-port",
        id: "QTApplication.Nu::QTPreferencesDialog.QFrame.scrollArea1.qt_scrollarea_viewport.BaseWidget1.QSpinBox",
        name: "",
        class: "QSpinBox",
        type: "ControlType.Spinner",
        y: 30,
        value: "9000",
        readOnly: false,
      },
    ],
  };
  const main: LegacyUiCapture = {
    process,
    mainHwnd: "243009868",
    mode: "main",
    dialogHwnd: null,
    treeSelection: null,
    image: null,
    controls: [
      {
        ...manager.controls[0]!,
        runtimeId: "main",
        id: "QTApplication.MW1_0",
        name: "Owned fixture",
        class: "Nu::QTMainWindow",
      },
    ],
  };
  fs.writeFileSync(
    statePath,
    JSON.stringify({ mode: "main", legacy: originalLegacy, pending: false }),
  );
  fs.writeFileSync(
    config,
    JSON.stringify({ main, manager, prefs, mappings, scenario }),
  );
  fs.writeFileSync(
    bin,
    `#!${processExecutable()}\n` +
      String.raw`
const fs=require('node:fs');
const cfg=JSON.parse(fs.readFileSync(__CONFIG__,'utf8'));
const statePath=__STATE__,eventsPath=__EVENTS__;
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);
process.stdin.on('end',()=>{
 const r=JSON.parse(input),state=JSON.parse(fs.readFileSync(statePath,'utf8'));
 const c=structuredClone(cfg[state.mode]);
 if(c.mode==='preferences'){
  c.controls.find(x=>x.runtimeId==='legacy').toggle=state.legacy;
  c.controls.find(x=>x.runtimeId==='apply').enabled=state.pending;
  c.controls.find(x=>x.runtimeId==='debug-port').value=state.externalPreference?'9001':'9000';
 }
 if(c.mode==='manager'){
  if(cfg.scenario==='stale') {
   c.controls.push({...c.controls.find(x=>x.runtimeId==='entry'),runtimeId:'previous',name:'Moje dodatki',selected:false});
   c.treeSelection.rows=['previous'];
  }
  if(cfg.scenario==='debug') {c.controls.find(x=>x.runtimeId==='run').name='Debuguj';c.controls.find(x=>x.runtimeId==='run').enabled=false;}
  if(cfg.scenario==='debugEnabled') c.controls.find(x=>x.runtimeId==='run').name='Debuguj';
  if(cfg.scenario==='disabledRun') c.controls.find(x=>x.runtimeId==='run').enabled=false;
  if(cfg.scenario==='category') {c.controls.find(x=>x.runtimeId==='entry').name='Moje dodatki';c.controls.find(x=>x.runtimeId==='path').value='';c.controls.find(x=>x.runtimeId==='startup').enabled=false;}
  if(cfg.scenario==='foreign') c.controls.find(x=>x.runtimeId==='entry').pid=999;
  if(cfg.scenario==='foreignWindow') c.controls[0].class='ForeignDialog';
  if(cfg.scenario==='wrongBirth') c.process.birth='999';
  if(cfg.scenario==='duplicate') c.controls.push({...c.controls.find(x=>x.runtimeId==='run'),runtimeId:'run-copy'});
  if(cfg.scenario==='stalePath') c.controls.find(x=>x.runtimeId==='path').value='C:\\other\\AutodeskFusionMCP.py';
 }
 if(r.action!=='capture'){
  if(r.action==='start' && cfg.scenario==='lateProfileIdentity'){
   const p=cfg.mappings[r.profile.nativePath];fs.writeFileSync(p+'.replacement',fs.readFileSync(p));fs.renameSync(p+'.replacement',p);
  }
  for(const f of [...r.originals,r.attempt,r.intent,r.profile].filter(Boolean)){
   const p=cfg.mappings[f.nativePath],s=fs.statSync(p,{bigint:true});
   const identity=s.dev+':'+s.ino+':'+s.size+':'+s.mtimeNs+':'+s.ctimeNs;
   const hash=require('node:crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');
   if(identity!==f.identity || hash!==f.sha256) throw Error('Native original identity/hash changed; no input');
  }
  fs.writeFileSync(cfg.mappings[r.dispatchPath],JSON.stringify(r.attempt),{flag:'wx'});
  fs.appendFileSync(eventsPath,JSON.stringify({action:r.action})+'\n');
  switch(r.action){
   case 'openPreferences':state.mode='prefs';break;
   case 'openManager':state.mode='manager';break;
   case 'cancelPreferences':case 'closeManager':state.mode='main';break;
   case 'toggleLegacy':state.legacy=state.legacy==='Off'?'On':'Off';state.pending=true;break;
    case 'applyLegacy':state.pending=false;break;
    case 'selectEntry':if(cfg.scenario==='externalPreference')state.externalPreference=true;break;
  }
  fs.writeFileSync(statePath,JSON.stringify(state));
  if(r.action==='start' && cfg.scenario==='unknownInput') process.exit(7);
 }
 process.stdout.write(JSON.stringify({capture:c,inputDelivered:r.action!=='capture'}));
});
`
        .replace("__CONFIG__", JSON.stringify(config))
        .replace("__STATE__", JSON.stringify(statePath))
        .replace("__EVENTS__", JSON.stringify(eventsPath)),
    { mode: 0o700 },
  );
  fs.writeFileSync(`${bin}.config`, "owned helper config");
  const stamp = (p: string) => {
    const s = fs.statSync(p, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  };
  const read = (n: string): ControlledFile => {
    const p = mappings[n];
    assert.ok(p);
    const b = fs.readFileSync(p);
    return { nativePath: n, sha256: hash(b), identity: stamp(p), bytes: b };
  };
  let revoked = false,
    sourceRevoked = false;
  const native: ControlledNativeAdapter = {
    paths,
    installedDirectory: nativeDirectory,
    installedSource: "a".repeat(40),
    installedBuild: "b".repeat(64),
    installedFiles: files,
    nativePathMappings: mappings,
    preflight: async () => {},
    requestNormalCloseAndWait: async () => {
      throw new Error("No Fusion lifecycle in this fixture");
    },
    confirmDead: async () => {
      throw new Error("No Fusion lifecycle");
    },
    readProfileAfterDeath: async () => {
      throw new Error("No profile mutation");
    },
    applyProfileAfterDeath: async () => {
      throw new Error("No profile mutation");
    },
    launch: async () => {
      throw new Error("No process launch");
    },
    assertProcess: async (p) => {
      assert.deepEqual(p, process);
    },
    readOriginal: async (n) => read(n),
    publishOriginal: async (n, b) => {
      write(n, b);
      return read(n);
    },
    assertOriginal: async (f) => {
      const actual = read(f.nativePath);
      assert.equal(actual.identity, f.identity, "native file identity changed");
      assert.equal(actual.sha256, f.sha256);
    },
    assertSource: async () => {
      if (sourceRevoked) throw new Error("source revoked");
      for (const [n, h] of Object.entries(files))
        assert.equal(read(`${nativeDirectory}\\${n}`).sha256, h);
    },
    captureSynchronousFence: (originals) => {
      const bound = originals.map((f) => ({
        path: mappings[f.nativePath]!,
        stamp: stamp(mappings[f.nativePath]!),
        hash: f.sha256,
      }));
      return () => {
        for (const f of bound) {
          assert.equal(stamp(f.path), f.stamp, "mapped identity changed");
          assert.equal(hash(fs.readFileSync(f.path)), f.hash);
        }
      };
    },
    awaitReceipts: async () => {
      throw new Error("Input is NOT a startup receipt");
    },
  };
  const pins = {
    powershell: "C:\\tools\\powershell.exe",
    mappedPowershell: bin,
    powershellSha256: hash(fs.readFileSync(bin)),
    powershellConfigSha256: hash(fs.readFileSync(`${bin}.config`)),
    executable: "C:\\vendor\\Fusion360.exe",
    executableSha256: "c".repeat(64),
    vendorFiles: ["NuBase10.dll", "XLayerUI10.dll"].map((n) => ({
      nativePath: `C:\\vendor\\${n}`,
      sha256: "d".repeat(64),
      identity: "vendor-original",
    })),
    auditDirectory: nativeAudit,
  };
  const ui = createControlledLegacyHostUi(pins, native, {
    fence: () => {
      if (revoked) throw new Error("lease revoked");
    },
    assertCurrent: async () => {
      if (revoked) throw new Error("lease revoked");
    },
  });
  return {
    ui,
    pins,
    native,
    mappings,
    read,
    statePath,
    root,
    events: () =>
      fs.existsSync(eventsPath)
        ? fs
            .readFileSync(eventsPath, "utf8")
            .trim()
            .split("\n")
            .map((s) => JSON.parse(s) as { action: string })
        : [],
    revoke: () => {
      revoked = true;
    },
    revokeSource: () => {
      sourceRevoked = true;
    },
    intent: (
      version: 2 | 1 = 2,
      change?: (intent: ControlledUiEntryIntentV2) => void,
    ) => {
      const intent: ControlledUiEntryIntentV2 = {
        kind: "fmcad-bootstrap-entry-intent",
        version: 2,
        nonce: "e".repeat(32),
        purpose: "isolated-stdout-v1",
        engineVersion: 2,
        process,
        executable: { path: pins.executable, sha256: pins.executableSha256 },
        installed: {
          directory: nativeDirectory,
          source: native.installedSource,
          files,
        },
        profile: { path: paths.profile, sha256: read(paths.profile).sha256 },
        receipts: {
          directory: paths.receiptDirectory,
          entry: "entry.json",
          returned: "returned.json",
        },
      };
      change?.(intent);
      write(paths.intent, Buffer.from(JSON.stringify({ ...intent, version })));
      return read(paths.intent);
    },
  };
}
// Avoid shadowing the exact Fusion process fixture constant.
function processExecutable() {
  return globalThis.process.execPath;
}

test("whole legacy port prepares separate Qt row/path, delivers only one benign reviewed input, then restores original presentation", async (t) => {
  const f = portFixture(t);
  const prepared = await f.ui.prepareExactHost({ process, entry });
  assert.equal(prepared.selectedEntry, entry);
  assert.equal(JSON.parse(fs.readFileSync(f.statePath, "utf8")).legacy, "On");
  const delivered = await f.ui.startReviewedFork({
    process,
    entry,
    intent: f.intent(),
  });
  assert.equal(
    JSON.parse(Buffer.from(delivered.reference.bytes).toString()).startupProven,
    false,
  );
  await assert.rejects(
    f.ui.startReviewedFork({
      process,
      entry,
      intent: f.read(f.native.paths.intent),
    }),
    /replay|revoked|required/,
  );
  await f.ui.restorePresentation();
  assert.equal(JSON.parse(fs.readFileSync(f.statePath, "utf8")).legacy, "Off");
  assert.equal(JSON.parse(fs.readFileSync(f.statePath, "utf8")).mode, "main");
  assert.equal(f.events().filter((x) => x.action === "start").length, 1);
});
for (const scenario of [
  "stale",
  "category",
  "stalePath",
  "debug",
  "debugEnabled",
  "disabledRun",
  "foreign",
  "foreignWindow",
  "wrongBirth",
  "duplicate",
]) {
  test(`whole port DENY ${scenario}: zero Start; known owned presentation is restored, foreign/unknown UI is not clicked`, async (t) => {
    const f = portFixture(t, scenario);
    await assert.rejects(f.ui.prepareExactHost({ process, entry }));
    assert.equal(
      f.events().some((x) => x.action === "start"),
      false,
    );
    if (["foreign", "foreignWindow", "wrongBirth"].includes(scenario)) {
      const count = f.events().length;
      await assert.rejects(f.ui.restorePresentation());
      assert.equal(f.events().length, count);
    } else {
      await f.ui.restorePresentation();
      assert.equal(
        JSON.parse(fs.readFileSync(f.statePath, "utf8")).legacy,
        "Off",
      );
      assert.equal(
        JSON.parse(fs.readFileSync(f.statePath, "utf8")).mode,
        "main",
      );
    }
  });
}
for (const guard of [
  "lease",
  "source",
  "native identity",
  "manifest identity",
]) {
  test(`whole port revokes ${guard} before input and permanently refuses replay`, async (t) => {
    const f = portFixture(t);
    await f.ui.prepareExactHost({ process, entry });
    const intent = f.intent();
    if (guard === "lease") f.revoke();
    else if (guard === "source") f.revokeSource();
    else {
      const old =
        f.mappings[
          guard === "manifest identity"
            ? `${f.native.installedDirectory}\\AutodeskFusionMCP.manifest`
            : entry
        ]!;
      fs.writeFileSync(`${old}-replacement`, fs.readFileSync(old));
      fs.renameSync(`${old}-replacement`, old);
    }
    const actions = f.events().length;
    await assert.rejects(f.ui.startReviewedFork({ process, entry, intent }));
    await assert.rejects(
      f.ui.startReviewedFork({ process, entry, intent }),
      /replay|revoked/,
    );
    assert.equal(f.events().length, actions);
  });
}
test("same-byte replacement profile after GUI is freshly rebound, never an old File ID pin", async (t) => {
  const f = portFixture(t);
  await f.ui.prepareExactHost({ process, entry });
  const intent = f.intent(),
    old = f.read(f.native.paths.profile);
  const mapped = f.mappings[f.native.paths.profile]!;
  fs.writeFileSync(`${mapped}-replacement`, fs.readFileSync(mapped));
  fs.renameSync(`${mapped}-replacement`, mapped);
  const fresh = f.read(f.native.paths.profile);
  assert.notEqual(old.identity, fresh.identity);
  const delivered = await f.ui.startReviewedFork({ process, entry, intent });
  assert.equal(
    JSON.parse(Buffer.from(delivered.reference.bytes).toString()).profile
      .identity,
    fresh.identity,
  );
  await f.ui.restorePresentation();
});
test("audited v2 UI intent is mandatory: isolated v1 and wrong exact executable are refused before Start", async (t) => {
  for (const wrong of ["v1", "executable", "purpose"]) {
    const f = portFixture(t);
    await f.ui.prepareExactHost({ process, entry });
    const intent = f.intent(wrong === "v1" ? 1 : 2, (value) => {
      if (wrong === "executable")
        Object.assign(value.executable, { sha256: "f".repeat(64) });
      if (wrong === "purpose")
        Object.assign(value, { purpose: "bootstrap-entry-data-v1" });
    });
    await assert.rejects(
      f.ui.startReviewedFork({ process, entry, intent }),
      /intent|isolated/,
    );
    assert.equal(
      f.events().some((x) => x.action === "start"),
      false,
    );
    await f.ui.restorePresentation();
  }
});
test("UNKNOWN after one benign dispatch retains durable attempts, restores known presentation and never repeats input", async (t) => {
  const f = portFixture(t, "unknownInput");
  await f.ui.prepareExactHost({ process, entry });
  const intent = f.intent();
  await assert.rejects(
    f.ui.startReviewedFork({ process, entry, intent }),
    /UNKNOWN/,
  );
  await assert.rejects(
    f.ui.startReviewedFork({ process, entry, intent }),
    /replay|revoked/,
  );
  assert.ok(
    fs.existsSync(
      f.mappings[`${intent.nativePath}.legacy-start-attempt.json`]!,
    ),
  );
  assert.ok(
    fs.existsSync(
      f.mappings[`${intent.nativePath}.legacy-start-attempt.json.dispatch`]!,
    ),
  );
  await f.ui.restorePresentation();
  assert.equal(f.events().filter((x) => x.action === "start").length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.statePath, "utf8")).legacy, "Off");
});
test("concurrent callers permanently revoke the first pending Start before dispatch", async (t) => {
  const f = portFixture(t);
  await f.ui.prepareExactHost({ process, entry });
  const intent = f.intent();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const boundary = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.native.assertSource = async () => {
    entered();
    await blocked;
  };
  const first = f.ui.startReviewedFork({ process, entry, intent });
  await boundary;
  await assert.rejects(
    f.ui.startReviewedFork({ process, entry, intent }),
    /revoked|replay/,
  );
  release();
  await assert.rejects(first, /revoked|replay/);
  assert.equal(
    f.events().some((x) => x.action === "start"),
    false,
  );
});
test("original legacy ON is preserved without toggling an unrelated presentation preference", async (t) => {
  const f = portFixture(t, "ready", "On");
  await f.ui.prepareExactHost({ process, entry });
  await f.ui.restorePresentation();
  assert.equal(f.events().filter((x) => x.action === "toggleLegacy").length, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.statePath, "utf8")).legacy, "On");
});
test("native profile identity changed after the fresh Node read refuses before benign Start", async (t) => {
  const f = portFixture(t, "lateProfileIdentity");
  await f.ui.prepareExactHost({ process, entry });
  const intent = f.intent();
  await assert.rejects(
    f.ui.startReviewedFork({ process, entry, intent }),
    /identity|UNKNOWN/,
  );
  assert.equal(
    f.events().some((x) => x.action === "start"),
    false,
  );
  await f.ui.restorePresentation();
});
test("read-only inspection never opens/closes another manager or enables Start", async (t) => {
  const f = portFixture(t);
  fs.writeFileSync(
    f.statePath,
    JSON.stringify({ mode: "manager", legacy: "On", pending: false }),
  );
  const observed = await f.ui.inspectExactHost({ process, entry });
  assert.equal(observed.selectedEntry, entry);
  await assert.rejects(
    f.ui.startReviewedFork({ process, entry, intent: f.intent() }),
    /prepared/,
  );
  await f.ui.restorePresentation();
  assert.equal(f.events().length, 0);
  assert.equal(
    JSON.parse(fs.readFileSync(f.statePath, "utf8")).mode,
    "manager",
  );
});
test("an asynchronous rejected lease fence is consumed and refuses before OS observation", async (t) => {
  const f = portFixture(t);
  const ui = createControlledLegacyHostUi(f.pins, f.native, {
    fence: () => Promise.reject(new Error("not a synchronous lease")),
    assertCurrent: async () => {
      throw new Error("must not reach async lease");
    },
  });
  await assert.rejects(
    ui.inspectExactHost({ process, entry }),
    /Synchronous held/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.events().length, 0);
});
test("restoration preserves an unrelated external preference and refuses a false all-restored claim", async (t) => {
  const f = portFixture(t, "externalPreference");
  await f.ui.prepareExactHost({ process, entry });
  await assert.rejects(
    f.ui.restorePresentation(),
    /Unexpected API preference delta/,
  );
  const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.equal(state.legacy, "Off");
  assert.equal(state.mode, "main");
  assert.equal(state.externalPreference, true);
  const count = f.events().length;
  await assert.rejects(
    f.ui.restorePresentation(),
    /External API preference delta retained/,
  );
  assert.equal(f.events().length, count);
});
