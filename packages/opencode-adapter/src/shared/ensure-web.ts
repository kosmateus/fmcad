import type { Dependencies } from "./contracts.js";

/** Schedule optional web setup without delaying tools or affecting CAD calls. */
export function requestWebEnsure(dependencies: Dependencies): void {
  if (!dependencies.ensureWeb) return;
  queueMicrotask(() => {
    void Promise.resolve()
      .then(() => dependencies.ensureWeb?.())
      .catch(() => {
        try {
          dependencies.diagnostic?.(
            "Control Center could not be ensured; fmcad tools remain available.",
          );
        } catch {
          // Diagnostics must not affect the host adapter or CAD results.
        }
      });
  });
}
