import { createHash } from "node:crypto";
import type { PreparedPythonArtifact } from "../../../core/src/domain/python-artifact.js";
import { preparePythonArtifact } from "./artifact.js";
import { provePythonSourceEffects } from "./source-effects.js";
import type { ReadonlyMetadataSnapshotV1 } from "./trusted-metadata-snapshot.js";

/**
 * Consumer-side plain-data shape only. It neither produces nor authenticates a
 * snapshot; the trusted metadata producer/ROOT owns those responsibilities.
 */
export type ReadonlyMetadataContextSnapshotV1 = ReadonlyMetadataSnapshotV1;

export interface ReadonlyMetadataContextManifestV1 {
  readonly profileVersion: "readonly-metadata-context-v1";
  readonly engineVersion: "python-source-effects-v2";
  readonly sourceSha256: string;
  readonly resourceSha256: string;
  readonly standaloneProgramSha256: string;
  readonly entrypoint: "_fmcad_readonly_metadata_environment";
  readonly entrypointInputs: readonly [
    "trusted ReadonlyMetadataSnapshotV1 producer output",
    "sourceSha256 from this prepared user unit",
  ];
  readonly snapshotSchema: "readonly-metadata-snapshot-v1";
  readonly userImports: readonly [
    "adsk",
    "adsk.core",
    "inspect",
    "json",
    "sys",
  ];
  readonly readableFields: readonly [
    "app.documents",
    "app.activeDocument",
    "document.creationId",
    "document.name",
    "document.isSaved",
    "document.isModified",
    "document.dataFile.id",
    "len(inspect.stack())",
    "sys.stdout",
    "sys.stderr",
    "json.dumps",
  ];
  readonly grantsSdkAccess: false;
  readonly grantsPythonExecution: false;
}

export type ReadonlyMetadataContextPreparation =
  | {
      readonly status: "prepared";
      readonly manifest: ReadonlyMetadataContextManifestV1;
      readonly artifact: PreparedPythonArtifact;
    }
  | {
      readonly status: "unsupported";
      readonly sourceSha256: string;
      readonly engineVersion: "python-source-effects-v2";
      readonly profileVersion: "readonly-metadata-context-v1";
      readonly reasons: readonly string[];
    };

const profileVersion = "readonly-metadata-context-v1" as const;
const engineVersion = "python-source-effects-v2" as const;
const entrypoint = "_fmcad_readonly_metadata_environment" as const;
const hash = (source: string): string =>
  createHash("sha256").update(source).digest("hex");

/**
 * A bounded metadata façade resource for a future trusted compiler profile.
 * This returns data/code only: it does not run the user source, read Fusion, or
 * turn a snapshot or digest into an SDK/Python grant.
 */
export function prepareReadonlyMetadataContext(
  source: string,
): ReadonlyMetadataContextPreparation {
  const sourceSha256 = hash(source);
  const pins = { sourceSha256, engineVersion, profileVersion };
  const unsupported = (reasons: readonly string[]) =>
    Object.freeze({
      ...pins,
      status: "unsupported" as const,
      reasons: Object.freeze([...reasons]),
    });

  const proof = provePythonSourceEffects(source);
  if (proof.status !== "proven") return unsupported(proof.reasons);
  if (
    proof.engineVersion !== engineVersion ||
    proof.sourceSha256 !== sourceSha256 ||
    proof.effect !== "stdout-and-readonly-metadata"
  )
    return unsupported(["Source analysis engine or source binding differs"]);

  try {
    const resource = readonlyMetadataContextResource;
    const resourceSha256 = hash(resource);
    const artifact = preparePythonArtifact(
      [
        {
          id: "readonly-metadata-context",
          filename: "<readonly-metadata-context>",
          source: resource,
          role: "runtime",
        },
        {
          id: "readonly-metadata-user",
          filename: "<readonly-metadata-user>",
          source,
          role: "user",
          embedded: true,
        },
      ],
      {
        context: {
          profileVersion,
          engineVersion,
          sourceSha256,
          resourceSha256,
          snapshotSchema: "readonly-metadata-snapshot-v1",
          entrypoint,
          entrypointInputs: [
            "trusted ReadonlyMetadataSnapshotV1 producer output",
            "sourceSha256 from this prepared user unit",
          ] as const,
          grantsSdkAccess: false,
          grantsPythonExecution: false,
        },
      },
    );
    const runtime = artifact.units.find(
      (unit) => unit.id === "readonly-metadata-context",
    );
    const user = artifact.units.find(
      (unit) => unit.id === "readonly-metadata-user",
    );
    if (
      artifact.script !== resource ||
      runtime?.source !== resource ||
      user?.source !== source ||
      user.sha256 !== sourceSha256
    )
      return unsupported([
        "Prepared resource or original source binding differs",
      ]);

    const manifest: ReadonlyMetadataContextManifestV1 = Object.freeze({
      profileVersion,
      engineVersion,
      sourceSha256,
      resourceSha256,
      standaloneProgramSha256: artifact.sha256,
      entrypoint,
      entrypointInputs: Object.freeze([
        "trusted ReadonlyMetadataSnapshotV1 producer output",
        "sourceSha256 from this prepared user unit",
      ] as const),
      snapshotSchema: "readonly-metadata-snapshot-v1",
      userImports: Object.freeze([
        "adsk",
        "adsk.core",
        "inspect",
        "json",
        "sys",
      ] as const),
      readableFields: Object.freeze([
        "app.documents",
        "app.activeDocument",
        "document.creationId",
        "document.name",
        "document.isSaved",
        "document.isModified",
        "document.dataFile.id",
        "len(inspect.stack())",
        "sys.stdout",
        "sys.stderr",
        "json.dumps",
      ] as const),
      grantsSdkAccess: false,
      grantsPythonExecution: false,
    });
    return Object.freeze({
      status: "prepared",
      manifest,
      artifact,
    });
  } catch {
    return unsupported(["Readonly metadata resource preparation failed"]);
  }
}

/**
 * This resource runs only in the future compiler-owned environment. Its
 * argument must be the plain output of the separate trusted snapshot producer;
 * the function itself is not a snapshot producer or an authority check.
 */
export const readonlyMetadataContextResource = String.raw`
from __future__ import annotations
import builtins as _fmcad_host_builtins
import inspect as _fmcad_host_inspect
import io as _fmcad_host_io
import json as _fmcad_host_json
import types as _fmcad_host_types
from typing import TYPE_CHECKING, cast
if TYPE_CHECKING:
    from io import StringIO as _FmcadStringIO

_METADATA_BINDING_KEYS = (
    "requestId", "requestSha256", "sourceSha256", "nativeSessionId",
    "hostGeneration", "resourceHash", "wireHash",
)
_METADATA_DOCUMENT_KEYS = (
    "creationId", "name", "isSaved", "isModified", "dataFile",
)

def _fmcad_metadata_record(
    value: object,
    keys: tuple[str, ...],
    message: str,
) -> dict[str, object]:
    if type(value) is not dict:
        raise ValueError(message)
    record = cast("dict[str, object]", value)
    if len(record) != len(keys) or any(key not in record for key in keys):
        raise ValueError(message)
    return record

class _FmcadDataFile:
    __slots__ = ("_id",)

    def __init__(self, file_id: str) -> None:
        self._id = file_id

    @property
    def id(self) -> str:
        return self._id

class _FmcadDocument:
    __slots__ = ("_creation_id", "_name", "_is_saved", "_is_modified", "_data_file")

    def __init__(
        self,
        creation_id: str,
        name: str,
        is_saved: bool,
        is_modified: bool,
        data_file: _FmcadDataFile | None,
    ) -> None:
        self._creation_id = creation_id
        self._name = name
        self._is_saved = is_saved
        self._is_modified = is_modified
        self._data_file = data_file

    @property
    def creationId(self) -> str:
        return self._creation_id

    @property
    def name(self) -> str:
        return self._name

    @property
    def isSaved(self) -> bool:
        return self._is_saved

    @property
    def isModified(self) -> bool:
        return self._is_modified

    @property
    def dataFile(self) -> _FmcadDataFile | None:
        return self._data_file

class _FmcadApplication:
    __slots__ = ("_documents", "_active_document")

    def __init__(
        self,
        documents: tuple[_FmcadDocument, ...],
        active_document: _FmcadDocument | None,
    ) -> None:
        self._documents = documents
        self._active_document = active_document

    @property
    def documents(self) -> tuple[_FmcadDocument, ...]:
        return self._documents

    @property
    def activeDocument(self) -> _FmcadDocument | None:
        return self._active_document

def _fmcad_metadata_text(value: object, identity: bool = False) -> str:
    if type(value) is not str or len(value) > 8192 or (identity and not value):
        raise ValueError("Unsupported readonly metadata text")
    return value

def _fmcad_metadata_digest(value: object) -> str:
    if type(value) is not str or len(value) != 64:
        raise ValueError("Unsupported readonly metadata digest")
    if any(character not in "0123456789abcdef" for character in value):
        raise ValueError("Unsupported readonly metadata digest")
    return value

def _fmcad_metadata_row(value: object) -> _FmcadDocument:
    row = _fmcad_metadata_record(
        value, _METADATA_DOCUMENT_KEYS,
        "Unsupported readonly metadata document fields",
    )
    creation_id = _fmcad_metadata_text(row["creationId"], True)
    name = _fmcad_metadata_text(row["name"])
    is_saved = row["isSaved"]
    is_modified = row["isModified"]
    if type(is_saved) is not bool or type(is_modified) is not bool:
        raise ValueError("Unsupported readonly metadata flags")
    file_value = row["dataFile"]
    data_file = None
    if file_value is not None:
        if is_saved is not True:
            raise ValueError("Unsupported readonly metadata file identity")
        file_row = _fmcad_metadata_record(
            file_value, ("id",), "Unsupported readonly metadata file identity",
        )
        data_file = _FmcadDataFile(_fmcad_metadata_text(file_row["id"], True))
    return _FmcadDocument(creation_id, name, is_saved, is_modified, data_file)

def _fmcad_metadata_snapshot(
    snapshot: object,
    expected_source_sha256: str,
) -> _FmcadApplication:
    metadata_snapshot = _fmcad_metadata_record(
        snapshot,
        ("schema", "binding", "documents", "activeDocument"),
        "Unsupported readonly metadata snapshot fields",
    )
    if metadata_snapshot["schema"] != "readonly-metadata-snapshot-v1":
        raise ValueError("Unsupported readonly metadata snapshot schema")
    metadata_binding = _fmcad_metadata_record(
        metadata_snapshot["binding"],
        _METADATA_BINDING_KEYS,
        "Unsupported readonly metadata binding fields",
    )
    _fmcad_metadata_text(metadata_binding["requestId"], True)
    _fmcad_metadata_digest(metadata_binding["requestSha256"])
    source_sha256 = _fmcad_metadata_digest(metadata_binding["sourceSha256"])
    if source_sha256 != expected_source_sha256:
        raise ValueError("Readonly metadata source binding differs")
    _fmcad_metadata_text(metadata_binding["nativeSessionId"], True)
    _fmcad_metadata_text(metadata_binding["hostGeneration"], True)
    _fmcad_metadata_digest(metadata_binding["resourceHash"])
    _fmcad_metadata_digest(metadata_binding["wireHash"])
    values_value = metadata_snapshot["documents"]
    if type(values_value) is not list:
        raise ValueError("Unsupported readonly metadata document inventory")
    values = cast("list[object]", values_value)
    if len(values) > 1024:
        raise ValueError("Unsupported readonly metadata document inventory")
    documents = tuple(_fmcad_metadata_row(value) for value in values)
    by_identity = {document.creationId: document for document in documents}
    if len(by_identity) != len(documents):
        raise ValueError("Duplicate readonly metadata document identity")
    active_value = metadata_snapshot["activeDocument"]
    active_document = None
    if active_value is not None:
        observed_active = _fmcad_metadata_row(active_value)
        active_document = by_identity.get(observed_active.creationId)
        if active_document is None:
            active_document = observed_active
        elif (
            active_document.name != observed_active.name
            or active_document.isSaved is not observed_active.isSaved
            or active_document.isModified is not observed_active.isModified
            or (
                active_document.dataFile.id
                if active_document.dataFile is not None else None
            ) != (
                observed_active.dataFile.id
                if observed_active.dataFile is not None else None
            )
        ):
            raise ValueError("Active document metadata differs from inventory")
    return _FmcadApplication(documents, active_document)

def _fmcad_private_json_dumps(
    value: object,
    *,
    ensure_ascii: bool = True,
    sort_keys: bool = False,
    indent: int | str | None = None,
    separators: tuple[str, str] | None = None,
    allow_nan: bool = True,
) -> str:
    return _fmcad_host_json.dumps(
        value,
        ensure_ascii=ensure_ascii,
        sort_keys=sort_keys,
        indent=indent,
        separators=separators,
        allow_nan=allow_nan,
    )

def _fmcad_private_stack() -> tuple[None, ...]:
    # Drop this helper's own frame and return no live FrameInfo references.
    return tuple(None for _frame in _fmcad_host_inspect.stack()[1:])

def _fmcad_readonly_metadata_environment(
    snapshot: object,
    expected_source_sha256: str,
) -> tuple[dict[str, object], _FmcadStringIO, _FmcadStringIO]:
    application = _fmcad_metadata_snapshot(snapshot, expected_source_sha256)
    class _Application:
        @staticmethod
        def get() -> _FmcadApplication:
            return application
    stdout = _fmcad_host_io.StringIO()
    stderr = _fmcad_host_io.StringIO()
    adsk = _fmcad_host_types.ModuleType("adsk")
    core = _fmcad_host_types.ModuleType("adsk.core")
    _fmcad_host_builtins.setattr(adsk, "core", core)
    _fmcad_host_builtins.setattr(core, "Application", _Application)
    inspect = _fmcad_host_types.ModuleType("inspect")
    _fmcad_host_builtins.setattr(inspect, "stack", _fmcad_private_stack)
    json = _fmcad_host_types.ModuleType("json")
    _fmcad_host_builtins.setattr(json, "dumps", _fmcad_private_json_dumps)
    sys = _fmcad_host_types.ModuleType("sys")
    _fmcad_host_builtins.setattr(sys, "stdout", stdout)
    _fmcad_host_builtins.setattr(sys, "stderr", stderr)
    modules = {
        "adsk": adsk,
        "adsk.core": core,
        "inspect": inspect,
        "json": json,
        "sys": sys,
    }
    def private_import(
        name: str,
        globals: dict[str, object] | None = None,
        locals: dict[str, object] | None = None,
        fromlist: tuple[str, ...] = (),
        level: int = 0,
    ) -> object:
        if level != 0 or name not in modules:
            raise ImportError("Unsupported readonly metadata import")
        module = modules[name]
        if fromlist:
            for member in fromlist:
                if member != "*" and member not in module.__dict__:
                    raise ImportError("Unsupported readonly metadata import member")
            return module
        return adsk if name == "adsk.core" else module
    def private_print(
        *args: object,
        sep: str | None = " ",
        end: str | None = "\n",
        file: _FmcadStringIO | None = None,
        flush: bool = False,
    ) -> None:
        target = stdout if file is None else file
        if target is not stdout and target is not stderr:
            raise TypeError("Readonly metadata output supports only private streams")
        _fmcad_host_builtins.print(
            *args, sep=sep, end=end, file=target, flush=flush,
        )
    user_builtins: dict[str, object] = {
        "__import__": private_import,
        "print": private_print,
        "len": len,
        "str": str,
        "int": int,
        "float": float,
        "bool": bool,
        "object": object,
        "sorted": sorted,
        "list": list,
        "tuple": tuple,
        "range": range,
        "type": type,
        "ValueError": ValueError,
        "RuntimeError": RuntimeError,
        "AssertionError": AssertionError,
        "Exception": Exception,
        "enumerate": enumerate,
        "abs": abs,
        "min": min,
        "max": max,
    }
    namespace: dict[str, object] = {"__builtins__": user_builtins}
    return namespace, stdout, stderr
`;
