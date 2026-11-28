import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { responseRecoveryTurnSource } from "../live-response-recovery";

test("recovery accepts peer focus and rejects same-turn foreign changes", () => {
  for (const [body, expected] of [
    ["own.isModified = True\nprint('target-result')", "target-result"],
    ["peer.isModified = True", "Non-target document changed"],
    ["app.documents.remove(peer)", "Non-target document changed"],
    ["raise ValueError('original failure')", "original failure"],
  ] as const) {
    const source = responseRecoveryTurnSource(body, "own");
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
from types import SimpleNamespace
own = SimpleNamespace(creationId='own', name='Own', isSaved=False, isModified=False, dataFile=None)
peer = SimpleNamespace(creationId='new-peer', name='Independent peer', isSaved=False, isModified=False, dataFile=None)
app = SimpleNamespace(documents=[own, peer], activeDocument=peer)
adsk = SimpleNamespace(core=SimpleNamespace(Application=SimpleNamespace(get=lambda: app)))
${source}
`,
      ],
      { encoding: "utf8" },
    );
    if (expected === "target-result") {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /target-result/);
    } else {
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(expected), result.stderr);
    }
  }
});

test("recovery target readback and turn fence pass production Python admission", async () => {
  const root = path.resolve(__dirname, "../../..");
  const load = createRequire(path.join(root, "package.json"));
  const { createPythonChecker } = load(
    "./packages/node-adapters/dist/python/checker",
  ) as typeof import("../../packages/node-adapters/src/python/checker");
  const { preparePythonArtifact } = load(
    "./packages/node-adapters/dist/python/artifact",
  ) as typeof import("../../packages/node-adapters/src/python/artifact");
  const typingRoot = path.join(root, "dist/runtime/python/typing");
  const checker = createPythonChecker({
    typingRoot,
    definitionsRoot: typingRoot,
    pythonPlatform: "Windows",
  });
  const body = responseRecoveryTurnSource(
    `a=adsk.core.Application.get()
owned=[d for d in a.documents if d.creationId=="own"]
assert len(owned)==1 and owned[0].name=="Own" and not owned[0].isSaved
d=owned[0]
design=cast(adsk.fusion.Design, d.products.itemByProductType('DesignProductType'))
assert design is not None
p=design.userParameters.itemByName('LostAckCounter')
assert p is not None and design.userParameters.count==1
assert abs(p.value-0.7)<1e-9
print(json.dumps(dict(count=design.userParameters.count,value=p.value)))`,
    "own",
  );
  const result = await checker.check({
    artifact: preparePythonArtifact([
      {
        id: "recovery-turn",
        filename: "recovery.py",
        role: "user",
        source: `import adsk.core, adsk.fusion, json
from typing import cast
DOC_NAME = None
def run(context: str):
${body
  .split("\n")
  .map((line) => "    " + line)
  .join("\n")}
run("")
`,
      },
    ]),
    context: { kind: "run" },
  });
  assert.equal(result.status, "passed", JSON.stringify(result));
});
