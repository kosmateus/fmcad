import type { BundleModule } from "./bundle.js";

/** Isolated family graph; canonical bundle wiring remains a separate slot. */
export const nativeDriveHandlers = Object.freeze([
  "mechanism.drive-test",
  "mechanism.motion-link.create",
] as const);

export const nativeDriveBundleManifest: readonly BundleModule[] =
  Object.freeze(
    [
      {
        id: "native-drive-domain",
        path: "runtime/python/fmcad/domain/native_drive.py",
        dependencies: [],
      },
      {
        id: "native-drive-application",
        path: "runtime/python/fmcad/application/native_drive.py",
        dependencies: ["native-drive-domain"],
      },
      {
        id: "native-drive-fusion",
        path: "runtime/python/fmcad/adapters/fusion/native_drive.py",
        dependencies: [
          "core",
          "assembly",
          "native-drive-domain",
          "native-drive-application",
        ],
      },
      {
        id: "native-drive-handlers",
        path: "runtime/python/fmcad/application/native_drive_handlers.py",
        dependencies: ["native-drive-fusion"],
        owner: "native-drive",
      },
    ].map((item) =>
      Object.freeze({
        ...item,
        dependencies: Object.freeze(item.dependencies),
      }),
    ),
  );

/** Add driver-only motion testing and native MotionLink authoring once. */
export function withNativeDrive(
  manifest: readonly BundleModule[],
): readonly BundleModule[] {
  if (
    manifest.some((item) =>
      nativeDriveBundleManifest.some(
        (module) => module.id === item.id || module.path === item.path,
      ),
    )
  )
    throw new Error("Native-drive modules are already present");
  return Object.freeze([...manifest, ...nativeDriveBundleManifest]);
}
