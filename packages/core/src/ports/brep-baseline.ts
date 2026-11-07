/** Native handles never cross this boundary. Each body owns one exact payload. */
export interface BrepBaselineManifest {
  version: 1;
  scope: "durable";
  source: { document: string; version: string };
  frame:
    string | { space: string; component: string | Record<string, unknown> };
  bodies: Array<{
    role: string;
    body: string;
    instance: string;
    pose: number[];
  }>;
}

export interface BrepBaselineReference {
  version: 1;
  scope: "durable";
  owner: string;
  id: string;
  sha256: string;
}

export interface BrepBaselineArtifacts {
  publish(
    manifest: BrepBaselineManifest,
    exactBodies: readonly Uint8Array[],
  ): BrepBaselineReference;
  read(reference: BrepBaselineReference): {
    manifest: BrepBaselineManifest;
    exactBodies: Uint8Array[];
    bodyPayloads: Array<{ role: string; bytes: number; sha256: string }>;
  };
}
