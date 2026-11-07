/// <reference lib="dom" />

export { ControlCenterApp } from "./app.js";
export type { ControlCenterOptions } from "./app.js";

import { ControlCenterApp } from "./app.js";

if (typeof document !== "undefined") {
  const mount = document.getElementById("app");
  if (mount) new ControlCenterApp(mount);
}
