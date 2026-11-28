import type { PayloadDefinition } from "@fmcad/core";
import type { CanonicalPayloadDefinition } from "./registered-payload.js";

const camera = "runtime/python/fmcad/adapters/fusion/camera_read.py";
const core = "assets/cad/core.py";
const fields = "runtime/python/fmcad/domain/values.py";

/** Projection is live camera state: all three supported projections are reachable. */
export const cameraSaveHandlerPlan = {
  roots: ["_camera_read"],
  conditions: {},
  definitions: [
    {
      symbol: "_camera_read",
      sourceId: "camera.save",
      dependencies: [
        { symbol: "_camera_active_viewport" },
        { symbol: "_camera_pose" },
        { symbol: "_cad_cast" },
      ],
    },
    {
      symbol: "_camera_active_viewport",
      sourceId: "camera.viewport",
      dependencies: [],
    },
    {
      symbol: "_camera_document_identity",
      sourceId: "camera.identity",
      dependencies: [],
    },
    {
      symbol: "_camera_pose",
      sourceId: "camera.state",
      dependencies: [
        { symbol: "_camera_document_identity" },
        { symbol: "_cad_xyz" },
        { symbol: "_cad_cast" },
        { symbol: "adsk" },
      ],
    },
    { symbol: "_cad_xyz", sourceId: "camera.xyz", dependencies: [] },
    { symbol: "_cad_cast", sourceId: "camera.cast", dependencies: [] },
    { symbol: "adsk", sourceId: "camera.adsk", dependencies: [] },
  ],
} as const satisfies {
  roots: readonly string[];
  conditions: Readonly<Record<string, boolean>>;
  definitions: readonly PayloadDefinition[];
};

export const cameraSaveCanonicalSources = [
  { id: "camera.save", filename: camera, symbol: "_camera_read" },
  {
    id: "camera.viewport",
    filename: camera,
    symbol: "_camera_active_viewport",
  },
  {
    id: "camera.identity",
    filename: camera,
    symbol: "_camera_document_identity",
  },
  { id: "camera.state", filename: camera, symbol: "_camera_pose" },
  { id: "camera.xyz", filename: core, symbol: "_cad_xyz" },
  {
    id: "camera.cast",
    filename: core,
    symbol: "_cad_cast",
    importName: "typing.cast",
  },
  {
    id: "camera.adsk",
    filename: core,
    symbol: "adsk",
    importName: "adsk.core",
  },
] as const satisfies readonly CanonicalPayloadDefinition[];

/** Definitions used by the strict checker when checking the public program. */
export const cameraSaveTypingSources: readonly CanonicalPayloadDefinition[] = [
  {
    id: "typing.mapping",
    filename: fields,
    symbol: "Mapping",
    importName: "collections.abc.Mapping",
  },
  {
    id: "typing.sequence",
    filename: fields,
    symbol: "Sequence",
    importName: "collections.abc.Sequence",
  },
  {
    id: "typing.alias",
    filename: fields,
    symbol: "TypeAlias",
    importName: "typing.TypeAlias",
  },
  {
    id: "typing.typevar",
    filename: fields,
    symbol: "TypeVar",
    importName: "typing.TypeVar",
  },
  {
    id: "typing.literal",
    filename: fields,
    symbol: "Literal",
    importName: "typing.Literal",
  },
  ...["JsonValue", "JsonObject", "JsonRecord", "_CadItem"].map((symbol) => ({
    id: "typing." + symbol,
    filename: fields,
    symbol,
  })),
  {
    id: "typing.checking",
    filename: core,
    symbol: "_CAD_TYPE_CHECKING",
    importName: "typing.TYPE_CHECKING",
  },
  {
    id: "typing.protocol",
    filename: core,
    symbol: "_CadProtocol",
    importName: "typing.Protocol",
  },
  {
    id: "typing.dict",
    filename: core,
    symbol: "_CadTypedDict",
    importName: "typing.TypedDict",
  },
  {
    id: "typing.camera-literal",
    filename: camera,
    symbol: "_IoCameraLiteral",
    importName: "typing.Literal",
    guard: "_CAD_TYPE_CHECKING",
  },
  {
    id: "typing.camera-optional",
    filename: camera,
    symbol: "_IoCameraNotRequired",
    importName: "typing.NotRequired",
    guard: "_CAD_TYPE_CHECKING",
  },
  ...["_IoCameraState"].map((symbol) => ({
    id: "typing." + symbol,
    filename: camera,
    symbol,
    guard: "_CAD_TYPE_CHECKING",
  })),
];
