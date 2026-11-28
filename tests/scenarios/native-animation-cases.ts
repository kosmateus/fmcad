import assert from "node:assert/strict";
import path from "node:path";
import type { Scenario } from "./runner";
import { NativeProbe } from "./native-probe";

export const nativeAnimationCapability = "native-animation-joint-frames";
interface Ref extends Record<string, unknown> {
  kind: string;
  token: string;
}
interface CameraFrame {
  index: number;
  timeSeconds: number;
  camera: { eye: number[]; target: number[]; up: number[] };
}
interface Results {
  "animation.sequence": {
    frameCount: number;
    trackCount: number;
    fps: number;
    nativeStoryboardActionsCreated: boolean;
    frames: CameraFrame[];
    affected: unknown[];
  };
  "component.create": { occurrence: Ref };
  "assembly.ground": { grounded: boolean };
  "joint.revolute": { asBuilt: boolean; type: string; joint: Ref };
  "joint.inspect": { motionType: string; rotationValue: number };
  "animation.joints": {
    status: string;
    passed: boolean;
    samples: { fraction: number; joints: { rotationValue: number }[] }[];
    restored: boolean;
    restoreErrors: unknown[];
    nativeStoryboardActionsCreated: boolean;
    frameFiles: string[];
  };
  "animation.export": {
    status: string;
    frameCount: number;
    fps: number;
    durationSeconds: number;
    fileWritten: boolean;
    playable: boolean;
    film: string | null;
  };
}
interface ProbeReadback {
  existing: string[];
  frames: {
    path: string;
    bytes: number;
    width: number;
    height: number;
    sha256: string;
  }[];
  exists: boolean;
  size: number;
  prefix: string;
  removed: string[];
  remaining: string[];
}
function required<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value!;
}
/** Native joint/PNG/optional encoder evidence. The model never advertises this capability. */
export function nativeAnimationScenarios(owners = 2): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-animation-methods-" + index,
    scope: "exclusive-instance",
    requires: ["documents", nativeAnimationCapability, "original-user-view"],
    async run(session) {
      const probe = new NativeProbe(
        session,
        "native-animation-methods",
        "LIVE_ANIM_SEQ ",
      );
      const name = session.document.name;
      let frameFileCleanup = false;
      const check = probe.check.bind(probe),
        validated = probe.validated.bind(probe);
      const script = (body: string, readOnly = true) =>
        probe.script<ProbeReadback>(body, readOnly);
      const cad = <K extends keyof Results>(
        operation: K,
        data: Record<string, unknown> = {},
        allowBlocked = false,
      ): Promise<Results[K]> =>
        probe.cad<Results[K]>(operation, data, allowBlocked);
      const runCase = async (
        name: string,
        operations: string[],
        fn: () => Promise<unknown>,
      ): Promise<void> => {
        try {
          const result = await fn();
          probe.observations.push({
            phase: name,
            result: { operations, result },
          });
        } finally {
          probe.persist();
        }
      };
      try {
        await runCase(
          "deterministic-camera-frame-manifest",
          ["animation.sequence"],
          async () => {
            const sequence = await cad("animation.sequence", {
              schemaVersion: 1,
              tracks: [
                {
                  type: "camera",
                  phase: "camera-move",
                  from: {
                    eye: ["0 cm", "0 cm", "30 cm"],
                    target: ["0 cm", "0 cm", "0 cm"],
                    up: [0, 0, 1],
                  },
                  to: {
                    eye: ["10 cm", "0 cm", "30 cm"],
                    target: ["0 cm", "0 cm", "0 cm"],
                    up: [0, 0, 1],
                  },
                },
              ],
              phases: ["camera-move"],
              duration: "1 s",
              fps: 2,
              easing: "linear",
            });
            check(
              "animation.sequence",
              "three evaluated frames for one second at 2 fps",
              sequence.frameCount,
              3,
            );
            check(
              "animation.sequence",
              "declared track count",
              sequence.trackCount,
              1,
            );
            check("animation.sequence", "fps preserved", sequence.fps, 2);
            check(
              "animation.sequence",
              "no native storyboard action authored",
              sequence.nativeStoryboardActionsCreated,
              false,
            );
            check(
              "animation.sequence",
              "frame indices are deterministic",
              sequence.frames.map((frame) => frame.index).join(","),
              "0,1,2",
            );
            [0, 0.5, 1].forEach((time, index) =>
              check(
                "animation.sequence",
                "frame " + index + " time seconds",
                required(sequence.frames[index]).timeSeconds,
                time,
                1e-9,
              ),
            );
            [0, 5, 10].forEach((eyeX, index) =>
              check(
                "animation.sequence",
                "frame " + index + " interpolated camera eye x cm",
                required(sequence.frames[index]).camera.eye[0],
                eyeX,
                1e-9,
              ),
            );
            check(
              "animation.sequence",
              "camera eye z remains 30 cm",
              required(sequence.frames[1]).camera.eye[2],
              30,
              1e-9,
            );
            check(
              "animation.sequence",
              "camera target remains at origin",
              required(sequence.frames[1]).camera.target.join(","),
              "0,0,0",
            );
            check(
              "animation.sequence",
              "camera up vector remains stable",
              required(sequence.frames[1]).camera.up.join(","),
              "0,0,1",
            );
            check(
              "animation.sequence",
              "read-only operation has no affected entities",
              sequence.affected.length,
              0,
            );
            validated("animation.sequence");
          },
        );

        if (!probe.uncertain)
          await runCase(
            "native-joint-track-sampling-frame-export-and-restoration",
            [
              "component.create",
              "assembly.ground",
              "joint.revolute",
              "joint.inspect",
              "animation.joints",
              "animation.export",
            ],
            async () => {
              const anchor = (
                await cad("component.create", { name: "AnimationAnchor" })
              ).occurrence;
              const arm = (
                await cad("component.create", { name: "AnimationArm" })
              ).occurrence;
              check(
                "component.create",
                "anchor occurrence reference returned",
                anchor.kind,
                "occurrence",
              );
              check(
                "component.create",
                "arm occurrence reference returned",
                arm.kind,
                "occurrence",
              );
              validated("component.create", true);

              const grounded = await cad("assembly.ground", {
                occurrence: anchor,
              });
              check(
                "assembly.ground",
                "anchor occurrence is grounded",
                grounded.grounded,
                true,
              );
              validated("assembly.ground");

              const made = await cad("joint.revolute", {
                name: "AnimationHinge",
                occurrenceOne: anchor,
                occurrenceTwo: arm,
                point: "origin",
                axis: "Z",
              });
              check(
                "joint.revolute",
                "revolute as-built joint returned",
                made.asBuilt,
                true,
              );
              check(
                "joint.revolute",
                "revolute motion type returned",
                made.type,
                "revolute",
              );
              const joint = made.joint;
              validated("joint.revolute");

              const before = await cad("joint.inspect", { joint });
              check(
                "joint.inspect",
                "native joint inspection reports revolute motion",
                before.motionType,
                "RevoluteJointMotion",
              );
              check(
                "joint.inspect",
                "native initial rotation is zero radians",
                before.rotationValue,
                0,
                1e-9,
              );
              validated("joint.inspect");

              assert.ok(
                path.win32.isAbsolute(probe.directory),
                "Fusion temp directory must be an absolute native path.",
              );
              const framePaths = Array.from({ length: 3 }, (_, index) =>
                path.win32.join(
                  probe.directory,
                  `${name}_animation_frame_${String(index).padStart(3, "0")}.png`,
                ),
              );
              const videoPath = path.win32.join(
                probe.directory,
                `${name}_animation_film.mp4`,
              );
              probe.observations.push({
                phase: "owned-animation-files",
                result: [...framePaths, videoPath],
              });
              const targetCheck =
                await script(`targets = ${JSON.stringify([...framePaths, videoPath])}
existing = [path for path in targets if os.path.lexists(path)]
print('LIVE_ANIM_SEQ ' + json.dumps({"targets": targets, "existing": existing}))`);
              assert.deepEqual(
                targetCheck.existing,
                [],
                "A unique animation output path unexpectedly exists.",
              );

              let samplingSettled = false;
              try {
                const sampled = await cad("animation.joints", {
                  tracks: [
                    { joint, rotation: { from: "0 deg", to: "90 deg" } },
                  ],
                  frameCount: 3,
                  confirm: true,
                  restore: true,
                  frameFiles: framePaths,
                  width: 64,
                  height: 64,
                });
                samplingSettled = true;
                check(
                  "animation.joints",
                  "sampler status is pass",
                  sampled.status,
                  "pass",
                );
                check(
                  "animation.joints",
                  "sampler passed flag is true",
                  sampled.passed,
                  true,
                );
                check(
                  "animation.joints",
                  "three requested frames were measured",
                  sampled.samples.length,
                  3,
                );
                [0, 0.5, 1].forEach((fraction, index) =>
                  check(
                    "animation.joints",
                    "sample " + index + " fraction",
                    required(sampled.samples[index]).fraction,
                    fraction,
                    1e-9,
                  ),
                );
                [0, Math.PI / 4, Math.PI / 2].forEach((rotation, index) =>
                  check(
                    "animation.joints",
                    "sample " + index + " actual joint rotation radians",
                    required(required(sampled.samples[index]).joints[0])
                      .rotationValue,
                    rotation,
                    1e-8,
                  ),
                );
                check(
                  "animation.joints",
                  "joint values restored in finally",
                  sampled.restored,
                  true,
                );
                check(
                  "animation.joints",
                  "joint restore has no errors",
                  sampled.restoreErrors.length,
                  0,
                );
                check(
                  "animation.joints",
                  "no storyboard actions are authored",
                  sampled.nativeStoryboardActionsCreated,
                  false,
                );
                check(
                  "animation.joints",
                  "exact native frame target list returned",
                  sampled.frameFiles
                    .map((file) => path.win32.normalize(file))
                    .join("\n"),
                  framePaths
                    .map((file) => path.win32.normalize(file))
                    .join("\n"),
                );
                validated("animation.joints");

                const frameProof =
                  await script(`paths = ${JSON.stringify(framePaths)}
rows = []
for filename in paths:
    assert os.path.dirname(os.path.abspath(filename)) == os.path.abspath(${JSON.stringify(probe.directory)})
    with open(filename, 'rb') as stream:
        content = stream.read()
    assert content[:8] == b'\\x89PNG\\r\\n\\x1a\\n' and content[12:16] == b'IHDR'
    width, height = struct.unpack('>II', content[16:24])
    assert (width, height) == (64, 64) and len(content) > 24
    rows.append(dict(path=filename, bytes=len(content), width=width, height=height, sha256=hashlib.sha256(content).hexdigest()))
print('LIVE_ANIM_SEQ ' + json.dumps({"frames": rows}))`);
                probe.observations.push({
                  phase: "native-animation-frames",
                  result: frameProof.frames,
                });
                check(
                  "animation.joints",
                  "three nonempty 64×64 native PNG frames read back",
                  frameProof.frames.length,
                  3,
                );

                const exported = await cad(
                  "animation.export",
                  {
                    schemaVersion: 1,
                    frames: sampled.frameFiles,
                    output: videoPath,
                    encoder: { name: "ffmpeg" },
                    fps: 3,
                    confirm: true,
                  },
                  true,
                );
                if (exported.status === "pass") {
                  check(
                    "animation.export",
                    "encoded film frame count",
                    exported.frameCount,
                    3,
                  );
                  check(
                    "animation.export",
                    "encoded film fps",
                    exported.fps,
                    3,
                  );
                  check(
                    "animation.export",
                    "encoded film duration seconds",
                    exported.durationSeconds,
                    1,
                    1e-9,
                  );
                  check(
                    "animation.export",
                    "film file is written and nonempty",
                    exported.fileWritten && exported.playable,
                    true,
                  );
                  assert.ok(typeof exported.film === "string");
                  check(
                    "animation.export",
                    "reported film path matches the exact target",
                    path.win32.normalize(exported.film),
                    path.win32.normalize(videoPath),
                  );
                  validated("animation.export");
                } else {
                  check(
                    "animation.export",
                    "missing optional ffmpeg returns explicit blocked",
                    exported.status,
                    "blocked",
                  );
                  check(
                    "animation.export",
                    "blocked export does not claim a file",
                    exported.fileWritten,
                    false,
                  );
                  check(
                    "animation.export",
                    "blocked export is not marked playable",
                    exported.playable,
                    false,
                  );
                  check(
                    "animation.export",
                    "blocked export records no film path",
                    exported.film,
                    null,
                  );
                  check(
                    "animation.export",
                    "blocked export reports the input frame count",
                    exported.frameCount,
                    3,
                  );
                }
                const videoProof =
                  await script(`filename = ${JSON.stringify(videoPath)}
exists = os.path.isfile(filename)
size = os.path.getsize(filename) if exists else 0
prefix = open(filename, 'rb').read(12) if exists else b''
print('LIVE_ANIM_SEQ ' + json.dumps({"exists": exists, "size": size, "prefix": prefix.hex()}))`);
                if (exported.status === "pass") {
                  check(
                    "animation.export",
                    "native film exists after pass",
                    videoProof.exists,
                    true,
                  );
                  check(
                    "animation.export",
                    "native MP4 contains an ftyp box",
                    videoProof.prefix.slice(8, 16),
                    "66747970",
                  );
                  check(
                    "animation.export",
                    "native film file is nonempty",
                    videoProof.size > 24,
                    true,
                  );
                } else
                  check(
                    "animation.export",
                    "blocked encode leaves no film file",
                    videoProof.exists,
                    false,
                  );

                const after = await cad("joint.inspect", { joint });
                check(
                  "joint.inspect",
                  "native joint readback matches pre-sample rotation",
                  after.rotationValue,
                  before.rotationValue,
                  1e-9,
                );
                validated("joint.inspect");
              } catch (error) {
                const sampleMethod = probe.methods.findLast(
                  (row) => row.operation === "animation.joints",
                );
                const settled =
                  sampleMethod &&
                  !["invoked", "blocked", "unknown"].includes(
                    sampleMethod.status,
                  );
                samplingSettled = samplingSettled || !!settled;
                throw error;
              } finally {
                if (samplingSettled && !probe.uncertain && !frameFileCleanup) {
                  const cleanup = await script(
                    `owned = ${JSON.stringify([...framePaths, videoPath])}
root = os.path.abspath(${JSON.stringify(probe.directory)})
for filename in owned:
    assert os.path.dirname(os.path.abspath(filename)) == root
    assert os.path.basename(filename).startswith(${JSON.stringify(name + "_animation_")})
    if os.path.lexists(filename):
        assert os.path.isfile(filename) and not os.path.islink(filename), 'Owned frame path is not a regular file'
        os.remove(filename)
remaining = [filename for filename in owned if os.path.lexists(filename)]
assert not remaining
print('LIVE_ANIM_SEQ ' + json.dumps({"removed": owned, "remaining": remaining}))`,
                    false,
                  );
                  frameFileCleanup = true;
                  probe.observations.push({
                    phase: "animation-file-cleanup",
                    result: cleanup,
                  });
                }
              }
              const exportResult = probe.methods.findLast(
                (item) => item.operation === "animation.export",
              );
              return exportResult?.status === "blocked"
                ? {
                    status: "pass-with-expected-block",
                    blockedOperations: ["animation.export"],
                  }
                : {};
            },
          );
      } finally {
        probe.persist();
      }
    },
  }));
}
