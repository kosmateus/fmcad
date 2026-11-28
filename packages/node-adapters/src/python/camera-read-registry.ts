import type { PayloadDefinition } from "@fmcad/core";
import type { CanonicalPayloadDefinition } from "./registered-payload.js";

const camera = "runtime/python/fmcad/adapters/fusion/camera_read.py";
const core = "assets/cad/core.py";
const fields = "runtime/python/fmcad/domain/values.py";

/** Projection is live camera state: all three supported projections are reachable. */
export const cameraSaveHandlerPlan = {
  roots: ["_io_camera_save"],
  conditions: {},
  definitions: [
    {
      symbol: "_io_camera_save",
      sourceId: "camera.save",
      dependencies: [
        { symbol: "_cad_fields" },
        { symbol: "_io_camera_viewport" },
        { symbol: "_io_camera_state" },
        { symbol: "_cad_cast" },
      ],
    },
    {
      symbol: "_io_camera_viewport",
      sourceId: "camera.viewport",
      dependencies: [],
    },
    {
      symbol: "_io_camera_identity",
      sourceId: "camera.identity",
      dependencies: [],
    },
    {
      symbol: "_io_camera_state",
      sourceId: "camera.state",
      dependencies: [
        { symbol: "_io_camera_identity" },
        { symbol: "_cad_xyz" },
        { symbol: "_cad_require_result" },
        { symbol: "_cad_cast" },
        { symbol: "adsk" },
      ],
    },
    { symbol: "_cad_fields", sourceId: "camera.fields", dependencies: [] },
    { symbol: "_cad_xyz", sourceId: "camera.xyz", dependencies: [] },
    {
      symbol: "_cad_require_result",
      sourceId: "camera.require-result",
      dependencies: [],
    },
    { symbol: "_cad_cast", sourceId: "camera.cast", dependencies: [] },
    { symbol: "adsk", sourceId: "camera.adsk", dependencies: [] },
  ],
} as const satisfies {
  roots: readonly string[];
  conditions: Readonly<Record<string, boolean>>;
  definitions: readonly PayloadDefinition[];
};

export const cameraSaveCanonicalSources = [
  { id: "camera.save", filename: camera, symbol: "_io_camera_save" },
  { id: "camera.viewport", filename: camera, symbol: "_io_camera_viewport" },
  { id: "camera.identity", filename: camera, symbol: "_io_camera_identity" },
  { id: "camera.state", filename: camera, symbol: "_io_camera_state" },
  { id: "camera.fields", filename: fields, symbol: "_cad_fields" },
  { id: "camera.xyz", filename: core, symbol: "_cad_xyz" },
  {
    id: "camera.require-result",
    filename: core,
    symbol: "_cad_require_result",
  },
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
  ...["_IoCameraReadContext", "_IoCameraState"].map((symbol) => ({
    id: "typing." + symbol,
    filename: camera,
    symbol,
    guard: "_CAD_TYPE_CHECKING",
  })),
];
