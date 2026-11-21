import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual as same } from "node:util";
import type { Reference } from "./queue-epoch-successor-types";
import type { Instance } from "../queue-broker-ports";
import type { SavedRequest } from "../../packages/core/src/application/cad/saved-fixture-contracts";
import { assertFrozenMetadataRequest } from "./queue-frozen-metadata-profile";

const load = createRequire(
  path.join(__dirname, "../../queue-epoch-successor.js"),
);
const { openIsolatedEpoch } = load(
  "./queue-isolated-epoch",
) as typeof import("../queue-isolated-epoch");
const lineage = load(
  "./queue-epoch-lineage",
) as typeof import("../queue-epoch-lineage");
const saved = load("./queue-saved-first-save-evidence") as Pick<
  ReturnType<typeof import("./library-saved-runtime").createSavedRuntime>,
  "readSavedPublication"
>;
const firstSave = load("./queue-saved-first-save") as Pick<
  ReturnType<typeof import("./library-saved-runtime").createSavedRuntime>,
  "firstSaveAdmission" | "markerFile"
>;
const api = load("./queue-instance") as {
  hash(value: string): string;
  readJson(file: string): unknown;
};

function fail(): never {
  throw Object.assign(
    new Error(
      "The exact authority-created and first-published metadata fixture is required",
    ),
    {
      code: "FROZEN_METADATA_DOCUMENT_UNPROVEN",
      notStarted: true,
    },
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) fail();
  return value;
}

/** Only the already-supported, receipt-bound first save may prepare the fixture. */
export function proveFrozenFirstSave(
  root: string,
  authority: Reference,
  input: unknown,
): void {
  const state = openIsolatedEpoch(root, { recover: false });
  const epoch = state.epoch;
  if (!epoch || !same(epoch.succession, authority)) fail();
  state.assertEpoch(false);
  const scope = lineage.successionAuthority(root, authority).authority[
    "frozenMetadata"
  ];
  if (scope === undefined) fail();
  const value = object(input);
  const payload = object(value["payload"]);
  const argv = value["argv"];
  const inputFiles = value["inputFiles"];
  if (
    !Array.isArray(argv) ||
    !argv.every((arg) => typeof arg === "string") ||
    (inputFiles !== undefined && !Array.isArray(inputFiles))
  )
    fail();
  const request: SavedRequest = {
    ...value,
    kind: text(value["kind"]),
    clientId: text(value["clientId"]),
    requestId: text(value["requestId"]),
    ownerToken: text(value["ownerToken"]),
    argv,
    payload: {
      ...payload,
      kind: text(payload["kind"]),
      operation: text(payload["operation"]),
      doc: text(payload["doc"]),
      docId: text(payload["docId"]),
      data: payload["data"],
    },
    ...(inputFiles === undefined ? {} : { inputFiles }),
  };
  const grantFile = firstSave.markerFile(epoch);
  // The existing validator checks exact destination authority, native receipt,
  // one save request, source/build, typed invocation and the immutable marker.
  const grant = api.readJson(grantFile) as Parameters<
    typeof firstSave.firstSaveAdmission
  >[2];
  const identity = object(api.readJson(path.join(epoch.root, "instance.json")));
  firstSave.firstSaveAdmission(epoch, request, grant, {
    sourceCommit: text(identity["sourceCommit"]),
    buildHash: text(identity["buildHash"]),
  });
}

/** Read existing authenticated creation/save evidence; this never adopts a document. */
export function proveFrozenMetadataDocument(
  root: string,
  authority: Reference,
  request: {
    clientId: string;
    clientTokenHash: string;
    requestId: string;
    fileId: string;
    version: number;
  },
  observed?: Instance,
) {
  const state = openIsolatedEpoch(root, { recover: false });
  const epoch = state.epoch;
  if (
    !epoch ||
    !same(epoch.succession, authority) ||
    state.data.blocked ||
    state.data.localUnknown ||
    state.data.controlBlocked
  )
    fail();
  state.assertEpoch(state.admissionMode === "normal-multidocument");
  const origin = lineage.successionAuthority(root, authority);
  const profile = origin.authority["frozenMetadata"];
  if (profile === undefined) fail();
  assertFrozenMetadataRequest(profile, {
    clientId: request.clientId,
    requestId: request.requestId,
    kind: "rpc",
    metadata: true,
  });
  if (request.clientId === epoch.ownerClientId) {
    if (request.clientTokenHash !== epoch.ownerTokenHash) fail();
  } else {
    const file = path.join(
      epoch.root,
      `access-${api.hash(request.clientId + "\0" + request.clientTokenHash)}.json`,
    );
    const grant: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !grant ||
      typeof grant !== "object" ||
      !("epochId" in grant) ||
      grant.epochId !== epoch.epochId ||
      !("clientId" in grant) ||
      grant.clientId !== request.clientId ||
      !("clientTokenHash" in grant) ||
      grant.clientTokenHash !== request.clientTokenHash ||
      !("document" in grant) ||
      !same(grant.document, epoch.document)
    )
      fail();
  }
  // This validator retains checked save receipts, first-save worker death,
  // origin creation ID, destination, and an independently observed publication.
  const publication = saved.readSavedPublication(root, epoch);
  const target = publication.value.publication.observation;
  if (
    !target ||
    target.creationId !== epoch.document.creationId ||
    typeof target.fileId !== "string" ||
    !target.fileId ||
    target.version !== 1 ||
    request.fileId !== target.fileId ||
    request.version !== target.version
  )
    fail();
  if (observed !== undefined) {
    const identity = observed.documentState?.state?.identity;
    if (
      !identity ||
      typeof identity !== "object" ||
      !("creationId" in identity) ||
      identity.creationId !== target.creationId ||
      !("fileId" in identity) ||
      identity.fileId !== target.fileId ||
      !("version" in identity) ||
      identity.version !== target.version
    )
      fail();
  }
  return Object.freeze({
    creationId: target.creationId,
    fileId: target.fileId,
    version: target.version,
    authority,
    publication: publication.reference,
  });
}
