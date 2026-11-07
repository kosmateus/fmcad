// Private workspace factories; the published root owns composition and loading.
export type { Dependencies, Invocation, Presence } from "./shared/contracts";
import type { Dependencies } from "./shared/contracts";

export async function createV1Adapter(dependencies: Dependencies) {
  return (await import("./v1/index.js")).createV1(dependencies);
}

export async function createV2Adapter(dependencies: Dependencies) {
  return (await import("./v2/index.js")).createV2(dependencies);
}
