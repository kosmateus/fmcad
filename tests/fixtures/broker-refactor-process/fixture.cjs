"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { start } = require("./channel.cjs");

async function fixture(t, crash = "none") {
  const directory = fs.mkdtempSync(
    path.join(
      fs.existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir(),
      "fmcad-process-contract-",
    ),
  );
  const env = { ...process.env };
  for (const [key, relative] of Object.entries({
    HOME: "home",
    XDG_CONFIG_HOME: "config",
    XDG_STATE_HOME: "state",
    XDG_CACHE_HOME: "cache",
    XDG_DATA_HOME: "data",
  })) {
    env[key] = path.join(directory, relative);
    fs.mkdirSync(env[key], { recursive: true });
  }
  for (const key of ["FMCAD_CONFIG", "FMCAD_PYTHON", "WSL_DISTRO_NAME"])
    delete env[key];
  const dir = path.join(env.XDG_STATE_HOME, "fmcad", "queue");
  const processes = [];
  t.after(async () => {
    // Producer credentials, state, documents and artifacts all belong to this
    // fixture. Never inspect/kill a shared broker or delete a resource by name.
    await Promise.all(processes.map((process) => process.kill()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function broker(mode = "none", expectReady = true) {
    const process = start("broker.cjs", [dir, mode], env);
    processes.push(process);
    if (expectReady) await process.event("ready");
    return process;
  }
  const server = await broker(crash);
  async function producer(tag) {
    const project = path.join(directory, "project-" + tag);
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(project, tag + ".py"),
      "# PROCESS_" + tag + "\ndef run(context: str) -> None:\n    pass\n",
    );
    const process = start("producer.cjs", [project, tag], env);
    processes.push(process);
    const ready = await process.event("ready");
    if (ready.dir !== dir)
      throw new Error("Producer did not use isolated broker directory");
    return process;
  }
  const [a, b] = await Promise.all([producer("A"), producer("B")]);
  return { directory, dir, server, a, b, broker };
}
module.exports = { fixture };
