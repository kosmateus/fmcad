import * as fs from "node:fs";
import path from "node:path";

export const liveScenarioArtifactRootEnv = "FMCAD_LIVE_SCENARIO_ARTIFACT_ROOT";

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative))
  );
}

/** Keep source/runtime resolution local while allowing an explicit live campaign root. */
export function scenarioArtifactRoot(
  projectRoot: string,
  mode: "fusion" | "simulator",
  env: NodeJS.ProcessEnv = process.env,
): string {
  const local = path.resolve(projectRoot, ".test-artifacts/scenarios"),
    selected = env[liveScenarioArtifactRootEnv];
  if (mode !== "fusion" || selected === undefined) return local;
  if (!selected.trim() || !path.isAbsolute(selected))
    throw new Error(
      liveScenarioArtifactRootEnv + " must be an absolute directory",
    );

  const candidate = path.resolve(selected);
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(
      liveScenarioArtifactRootEnv + " must name a regular directory",
    );
  if (fs.realpathSync(candidate) !== candidate)
    throw new Error(
      liveScenarioArtifactRootEnv + " must name a canonical directory",
    );
  const project = fs.realpathSync(projectRoot);
  if (contains(project, candidate) || contains(candidate, project))
    throw new Error(
      liveScenarioArtifactRootEnv +
        " must be separate from the source checkout",
    );
  if (
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw new Error(
      liveScenarioArtifactRootEnv + " must be private to the current user",
    );
  fs.accessSync(
    candidate,
    fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
  );
  return candidate;
}
