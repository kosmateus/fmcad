import type { PythonJson, PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact";

const payload: PythonJson = { operation: "fixture", data: [true, null, "日本語"] };
void payload;

// @ts-expect-error SDK-like callbacks are not JSON DTOs.
const opaque: PythonJson = { nativeHandle: () => 1 };
void opaque;

declare const artifact: PreparedPythonArtifact;
// @ts-expect-error Final bytes cannot be rebound after checking.
artifact.bytes = [1];
// @ts-expect-error Source units cannot be changed by instance binding.
artifact.units[0]!.source = "pass";
