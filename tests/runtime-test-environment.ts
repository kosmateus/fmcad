import * as fs from "node:fs";
import path from "node:path";

const directoryKeys = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
] as const;
const clearedKeys = [
  "FMCAD_CONFIG",
  "FMCAD_PYTHON",
  "WSL_DISTRO_NAME",
] as const;
type IsolatedEnvironment = { restore(): void };

export function isolateRuntimeTestEnvironment(
  root: string,
): IsolatedEnvironment {
  const directories: Record<(typeof directoryKeys)[number], string> = {
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
    XDG_STATE_HOME: path.join(root, "xdg", "state"),
    XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
    XDG_DATA_HOME: path.join(root, "xdg", "data"),
  };
  for (const directory of Object.values(directories))
    fs.mkdirSync(directory, { recursive: true });

  const previous = new Map<string, string | undefined>();
  for (const key of directoryKeys) {
    previous.set(key, process.env[key]);
    process.env[key] = directories[key];
  }
  for (const key of clearedKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  return {
    restore() {
      for (const key of [...directoryKeys, ...clearedKeys]) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
