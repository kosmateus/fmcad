import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { object } from "./contracts.js";

/** Opt-in test log of the final body, without transport credentials. */
export function captureTestWire(body: Buffer): void {
  const directory = process.env["FMCAD_TEST_WIRE_DIRECTORY"];
  if (!directory) return;
  const rpc = object(JSON.parse(body.toString("utf8")));
  const params = object(rpc["params"]);
  const args = object(params["arguments"]);
  if (
    rpc["method"] !== "tools/call" ||
    params["name"] !== "execute_python" ||
    typeof args["code"] !== "string"
  )
    return;
  const hash = createHash("sha256").update(body).digest("hex");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, `${hash}.json`), body, { mode: 0o600 });
  writeFileSync(join(directory, `${hash}.py`), args["code"], { mode: 0o600 });
}
