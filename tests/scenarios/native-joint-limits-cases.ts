import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Scenario } from "./runner";
import { record, number } from "./contracts";
import { values } from "./native-modeling-support";
import { NativeProbe } from "./native-probe";
export const nativeJointLimitsCapability = "native-joint-limit-transfer";
const helpers = `import adsk.core, adsk.fusion, json, math
app = adsk.core.Application.get()
def environment():
    return dict(documents=sorted([dict(creationId=d.creationId, name=d.name, saved=d.isSaved, modified=d.isModified) for d in app.documents], key=lambda d:d['creationId']), active=app.activeDocument.creationId if app.activeDocument else None, workspace=app.userInterface.activeWorkspace.id)
VALUES = ('minimumValue', 'maximumValue', 'restValue')
FLAGS = ('isMinimumValueEnabled', 'isMaximumValueEnabled', 'isRestValueEnabled')
def read_limits(m):
    return {a:{p:getattr(getattr(m,a+'Limits'),p) for p in VALUES+FLAGS} for a in ('rotation','slide') if hasattr(m,a+'Limits')}
def state(d):
    r = d.rootComponent
    return dict(joints=[dict(name=j.name, limits=read_limits(j.jointMotion), values={p:getattr(j.jointMotion,p) for p in ('rotationValue','slideValue') if hasattr(j.jointMotion,p)}) for j in r.asBuiltJoints], matrices=[list(o.transform2.asArray()) for o in r.occurrences], timeline=d.timeline.count, pending=d.snapshots.hasPendingSnapshot)
`;
const emit = (expr: string) => `print('LIMITS_PROBE ' + json.dumps(${expr}))`;
const spec = (axis: string) => ({
  minimumValue: axis === "rotation" ? "-90 deg" : "-10 mm",
  maximumValue: axis === "rotation" ? "90 deg" : "20 mm",
  restValue: axis === "rotation" ? "10 deg" : "2 mm",
  isMinimumValueEnabled: true,
  isMaximumValueEnabled: true,
  isRestValueEnabled: true,
});
function field(value: unknown, ...keys: (string | number)[]): unknown {
  return keys.reduce<unknown>(
    (current, key) =>
      typeof key === "number" ? values(current)[key] : record(current)[key],
    value,
  );
}
export function nativeJointLimitsScenarios(owners = 10): Scenario[] {
  return Array.from({ length: owners }, (_, index) =>
    ["diagnose", "verify"].map((mode): Scenario => ({
      id: "native-joint-limits-" + mode + "-" + index,
      scope: "exclusive-instance",
      requires: [
        "documents",
        nativeJointLimitsCapability,
        "original-user-view",
      ],
      async run(session) {
        const probe = new NativeProbe(
          session,
          "native-joint-limits",
          "LIMITS_PROBE ",
          helpers,
        );
        const run: { mode: string; cases: unknown[]; separateRead?: unknown } =
          { mode, cases: [] };
        const persist = () =>
          fs.writeFileSync(
            path.join(session.directory, "joint-limits.json"),
            JSON.stringify(
              {
                retainedSource: "tests/live-joint-limits-probe.js",
                owner: session.report.owner,
                run,
              },
              null,
              2,
            ) + "\n",
            { mode: 0o600 },
          );
        const script = async (
          label: string,
          body: string,
          owned = true,
          readOnly = true,
        ) => {
          if (!owned)
            throw new Error("Native joint probes require the owned fixture");
          return probe.script(
            `doc=app.activeDocument
assert app.userInterface.activeCommand in ('','SelectCommand')
d=adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
${body}`,
            readOnly,
          );
        };
        const cad = async (
          operation: string,
          data: Record<string, unknown>,
        ) => {
          const { output } = await probe.invoke(operation, data);
          if (output["success"] !== true)
            throw new Error(JSON.stringify(output));
          return output;
        };
        try {
          if (run.mode === "diagnose") {
            run.cases = values(
              await script(
                "native-transfer-and-setter-orders",
                `r = d.rootComponent
rows = []
for kind in ('Revolute','Slider','Cylindrical'):
    one = r.occurrences.addNewComponent(adsk.core.Matrix3D.create())
    two = r.occurrences.addNewComponent(adsk.core.Matrix3D.create())
    one.isGrounded = True
    inp = r.asBuiltJoints.createInput(one,two,adsk.fusion.JointGeometry.createByPoint(r.originConstructionPoint))
    assert getattr(inp,'setAs'+kind+'JointMotion')(adsk.fusion.JointDirections.ZAxisJointDirection)
    axes = ('rotation','slide') if kind == 'Cylindrical' else ('rotation',) if kind == 'Revolute' else ('slide',)
    for a in axes:
        l = getattr(inp.jointMotion,a+'Limits')
        for p,v in zip(VALUES,(-math.pi/2,math.pi/2,math.pi/18) if a == 'rotation' else (-1,2,.2)): setattr(l,p,v)
        for p in FLAGS: setattr(l,p,True)
    before = read_limits(inp.jointMotion)
    j = r.asBuiltJoints.add(inp)
    row = dict(kind=kind,input=before,postAdd=read_limits(j.jointMotion),orders=[])
    for order in ('values_then_flags','flags_then_values'):
        for a in axes:
            l = getattr(j.jointMotion,a+'Limits')
            for p in FLAGS: setattr(l,p,False)
            values = dict(zip(VALUES,(-math.pi/2,math.pi/2,math.pi/18) if a == 'rotation' else (-1,2,.2)))
            steps = []
            assignments = list(values.items()) + [(p,True) for p in FLAGS] if order == 'values_then_flags' else [(p,True) for p in FLAGS] + list(values.items())
            for p,v in assignments:
                setattr(l,p,v)
                steps.append(dict(property=p,value=v,actual=read_limits(j.jointMotion)))
            row['orders'].append(dict(axis=a,order=order,steps=steps))
    rows.append(row)
${emit("rows")}`,
                true,
                false,
              ),
            );
            run.separateRead = await script(
              "separate-native-getters",
              emit("state(d)"),
            );
          } else {
            const anchor = field(
              await cad("component.create", { name: "anchor" }),
              "result",
              "occurrence",
            );
            await cad("assembly.ground", { occurrence: anchor });
            for (const kind of ["revolute", "slider", "cylindrical"]) {
              const occurrence = field(
                await cad("component.create", { name: kind }),
                "result",
                "occurrence",
              );
              const axes =
                kind === "cylindrical"
                  ? ["rotation", "slide"]
                  : [kind === "slider" ? "slide" : "rotation"];
              const limits = Object.fromEntries(axes.map((a) => [a, spec(a)]));
              const made = await cad("joint." + kind, {
                name: kind,
                occurrenceOne: occurrence,
                occurrenceTwo: anchor,
                point: "origin",
                axis: "Z",
                limits,
                confirm: true,
              });
              const joint = { token: field(made, "result", "joint", "token") };
              const created = await script(
                "native-created-" + kind,
                emit("state(d)"),
              );
              const check = (actual: unknown, edited: boolean) => {
                for (const a of axes) {
                  const expected =
                    a === "rotation"
                      ? [
                          -Math.PI / 2,
                          Math.PI / 2,
                          edited ? Math.PI / 12 : Math.PI / 18,
                        ]
                      : [-1, 2, edited ? 0.3 : 0.2];
                  for (const [i, p] of [
                    "minimumValue",
                    "maximumValue",
                    "restValue",
                  ].entries())
                    assert.ok(
                      Math.abs(
                        number(field(actual, a, p)) - number(expected[i]),
                      ) < 1e-10,
                      `${kind} ${a} ${p}: ${field(actual, a, p)}`,
                    );
                  for (const p of [
                    "isMinimumValueEnabled",
                    "isMaximumValueEnabled",
                    "isRestValueEnabled",
                  ])
                    assert.equal(field(actual, a, p), true);
                }
              };
              check(
                field(values(field(created, "joints")).at(-1), "limits"),
                false,
              );
              await cad("joint.limits", {
                joint,
                confirm: true,
                limits: Object.fromEntries(
                  axes.map((a) => [
                    a,
                    {
                      restValue: a === "rotation" ? "15 deg" : "3 mm",
                      isRestValueEnabled: true,
                    },
                  ]),
                ),
              });
              const edited = await script(
                "native-edited-" + kind,
                emit("state(d)"),
              );
              check(
                field(values(field(edited, "joints")).at(-1), "limits"),
                true,
              );
              let rejected = 0;
              for (const a of axes)
                for (const v of a === "rotation"
                  ? ["-91 deg", "91 deg"]
                  : ["-11 mm", "21 mm"]) {
                  await assert.rejects(
                    () =>
                      cad("joint.drive", {
                        joint,
                        ...(kind === "cylindrical"
                          ? { rotation: "20 deg", slide: "5 mm" }
                          : {}),
                        [a]: v,
                      }),
                    /outside joint limits/,
                  );
                  assert.deepEqual(
                    await script("rejection-no-change", emit("state(d)")),
                    edited,
                  );
                  rejected++;
                }
              run.cases.push({
                kind,
                created,
                edited,
                rejected,
                status: "pass",
              });
              persist();
            }
          }
        } finally {
          persist();
        }
      },
    })),
  ).flat();
}
