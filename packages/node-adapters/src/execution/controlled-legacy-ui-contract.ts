import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decodeAdmissionJson } from "./admission-json";
import { validateControlledHostUiImage } from "./controlled-host-ui";
import type { ControlledProcess } from "./controlled-fusion-launch-types";

/** Original OS observations are data, never a serialized SDK/UI grant. */
export interface LegacyControl {
  runtimeId: string;
  parent: string | null;
  id: string;
  name: string;
  class: string;
  type: string;
  pid: number;
  enabled: boolean;
  offscreen: boolean;
  selected: boolean | null;
  value: string | null;
  readOnly: boolean | null;
  toggle: "On" | "Off" | "Indeterminate" | null;
  x: number | null;
  y: number | null;
  width: number;
  height: number;
}
export interface LegacyUiCapture {
  process: ControlledProcess;
  mainHwnd: string;
  mode: "main" | "preferences" | "manager";
  dialogHwnd: string | null;
  controls: LegacyControl[];
  treeSelection: { tree: string; rows: string[] } | null;
  image: { width: number; height: number; png: string } | null;
}
export const legacyDialogId = "QTApplication.Nu::QTScriptsManagerDialog";
export const legacyTreeId = `${legacyDialogId}.QTabWidget.qt_tabwidget_stackedwidget.Nu::QTScriptsManagerAddInsTab.QTreeView`;
const keys = (value: object, expected: string) => {
  if (Object.keys(value).sort().join() !== expected)
    throw new Error("Partial/extended legacy UI observation");
};
export function readLegacyUiCapture(
  raw: string,
  process: ControlledProcess,
): LegacyUiCapture {
  const c = decodeAdmissionJson(raw) as LegacyUiCapture;
  if (!c || typeof c !== "object") throw new Error("Missing legacy capture");
  keys(c, "controls,dialogHwnd,image,mainHwnd,mode,process,treeSelection");
  if (!c.process || typeof c.process !== "object")
    throw new Error("Missing original process");
  keys(c.process, "birth,pid");
  keys(process, "birth,pid");
  if (
    !isDeepStrictEqual(c.process, process) ||
    !Number.isSafeInteger(process.pid) ||
    process.pid <= 0 ||
    !/^[1-9][0-9]*$/.test(process.birth) ||
    !/^[1-9][0-9]*$/.test(c.mainHwnd) ||
    !["main", "preferences", "manager"].includes(c.mode) ||
    !Array.isArray(c.controls) ||
    c.controls.length < 1 ||
    c.controls.length > 1200
  )
    throw new Error("Wrong process/partial legacy capture");
  const ids = new Set<string>();
  for (const x of c.controls) {
    if (!x || typeof x !== "object") throw new Error("Missing legacy control");
    keys(
      x,
      "class,enabled,height,id,name,offscreen,parent,pid,readOnly,runtimeId,selected,toggle,type,value,width,x,y",
    );
    if (
      ["runtimeId", "id", "name", "class", "type"].some(
        (k) => typeof x[k as keyof LegacyControl] !== "string",
      ) ||
      !x.runtimeId ||
      x.runtimeId.length > 512 ||
      ids.has(x.runtimeId) ||
      (x.parent !== null &&
        (typeof x.parent !== "string" || !ids.has(x.parent))) ||
      x.pid !== process.pid ||
      typeof x.enabled !== "boolean" ||
      typeof x.offscreen !== "boolean" ||
      ![null, true, false].includes(x.selected) ||
      ![null, true, false].includes(x.readOnly) ||
      (x.value !== null && typeof x.value !== "string") ||
      ![null, "On", "Off", "Indeterminate"].includes(x.toggle) ||
      !Number.isFinite(x.width) ||
      !Number.isFinite(x.height) ||
      x.width < 0 ||
      x.height < 0 ||
      [x.x, x.y].some(
        (n) => !(x.offscreen && n === null) && !Number.isFinite(n),
      )
    )
      throw new Error("Foreign/ambiguous/partial legacy control");
    ids.add(x.runtimeId);
  }
  const roots = c.controls.filter((x) => x.parent === null);
  const expectedRoot =
    c.mode === "main"
      ? ["QTApplication.MW1_0", "Nu::QTMainWindow"]
      : c.mode === "preferences"
        ? ["QTApplication.Nu::QTPreferencesDialog", "Nu::QTPreferencesDialog"]
        : [legacyDialogId, "Nu::QTScriptsManagerDialog"];
  if (
    roots.length !== 1 ||
    roots[0] !== c.controls[0] ||
    roots[0]!.id !== expectedRoot[0] ||
    roots[0]!.class !== expectedRoot[1] ||
    roots[0]!.type !== "ControlType.Window"
  )
    throw new Error("Foreign/ambiguous scoped legacy window");
  if (c.treeSelection !== null) {
    keys(c.treeSelection, "rows,tree");
    if (
      !ids.has(c.treeSelection.tree) ||
      !Array.isArray(c.treeSelection.rows) ||
      c.treeSelection.rows.length > 1200 ||
      c.treeSelection.rows.some(
        (id) => typeof id !== "string" || !ids.has(id),
      ) ||
      new Set(c.treeSelection.rows).size !== c.treeSelection.rows.length
    )
      throw new Error("Partial native tree selection");
  }
  if (c.mode === "main") {
    if (c.dialogHwnd !== null || c.image !== null || c.treeSelection !== null)
      throw new Error("Unexpected dialog in main observation");
  } else {
    if (!c.dialogHwnd || !/^[1-9][0-9]*$/.test(c.dialogHwnd) || !c.image)
      throw new Error("Missing original dialog image/identity");
    keys(c.image, "height,png,width");
    if (typeof c.image.png !== "string")
      throw new Error("Missing original PNG");
    const png = Buffer.from(c.image.png, "base64");
    if (png.toString("base64") !== c.image.png)
      throw new Error("Partial original PNG");
    validateControlledHostUiImage(png, { main: c.image });
  }
  return c;
}
export function oneLegacyControl(
  c: LegacyUiCapture,
  check: (x: LegacyControl) => boolean,
) {
  const matches = c.controls.filter(check);
  if (matches.length !== 1)
    throw new Error("Unique scoped legacy control required");
  return matches[0]!;
}
export function visibleLegacyControl(x: LegacyControl) {
  if (!x.enabled || x.offscreen || x.width <= 0 || x.height <= 0)
    throw new Error("Visible enabled legacy control required");
  return x;
}
export function requireLegacyEntry(c: LegacyUiCapture, entry: string) {
  if (c.mode !== "manager") throw new Error("Actual legacy manager required");
  const dialog = visibleLegacyControl(
    oneLegacyControl(
      c,
      (x) =>
        x.parent === null &&
        x.id === legacyDialogId &&
        x.class === "Nu::QTScriptsManagerDialog" &&
        x.name === "Skrypty i dodatki" &&
        x.type === "ControlType.Window",
    ),
  );
  const descendants = (x: LegacyControl, ancestor: LegacyControl): boolean => {
    if (x.parent === null) return false;
    if (x.parent === ancestor.runtimeId) return true;
    return descendants(
      c.controls.find((y) => y.runtimeId === x.parent)!,
      ancestor,
    );
  };
  visibleLegacyControl(
    oneLegacyControl(
      c,
      (x) =>
        descendants(x, dialog) &&
        x.id === `${legacyDialogId}.QTabWidget.qt_tabwidget_tabbar` &&
        x.name === "Dodatki" &&
        x.type === "ControlType.TabItem" &&
        x.selected === true,
    ),
  );
  const tree = visibleLegacyControl(
    oneLegacyControl(
      c,
      (x) =>
        descendants(x, dialog) &&
        x.id === legacyTreeId &&
        x.class === "QTreeView" &&
        x.type === "ControlType.Tree",
    ),
  );
  const rows = c.controls.filter(
    (x) =>
      descendants(x, tree) &&
      x.type === "ControlType.TreeItem" &&
      x.selected === true,
  );
  if (
    rows.length !== 1 ||
    c.treeSelection?.tree !== tree.runtimeId ||
    !isDeepStrictEqual(c.treeSelection.rows, [rows[0]!.runtimeId])
  )
    throw new Error("Native tree/row selection disagreement");
  const row = visibleLegacyControl(rows[0]!);
  if (row.id !== legacyTreeId || row.name !== "AutodeskFusionMCP")
    throw new Error("Selected category/foreign entry refused");
  const label = oneLegacyControl(
    c,
    (x) =>
      descendants(x, dialog) &&
      x.name === "Pełna ścieżka" &&
      x.class === "QLabel" &&
      x.type === "ControlType.Text",
  );
  const siblings = c.controls.filter((x) => x.parent === label.parent);
  const field = siblings[siblings.indexOf(label) + 1];
  if (
    !field ||
    field.class !== "QPlainTextEdit" ||
    field.type !== "ControlType.Edit" ||
    field.id !== `${legacyDialogId}.QPlainTextEdit` ||
    field.readOnly !== true ||
    typeof field.value !== "string" ||
    !field.value ||
    path.win32.normalize(field.value).toLowerCase() !==
      path.win32.normalize(entry).toLowerCase()
  )
    throw new Error("Selected readonly labeled entry path differs");
  const tool = visibleLegacyControl(
    oneLegacyControl(
      c,
      (x) =>
        descendants(x, dialog) &&
        x.id === `${legacyDialogId}.QToolButton` &&
        x.class === "QToolButton" &&
        x.type === "ControlType.Button",
    ),
  );
  if (tool.name !== "Uruchom") throw new Error("Debug is not reviewed Run");
  const startup = oneLegacyControl(
    c,
    (x) =>
      descendants(x, dialog) &&
      x.id === `${legacyDialogId}.QCheckBox` &&
      x.name === "Uruchom przy starcie" &&
      x.type === "ControlType.CheckBox" &&
      x.class === "QCheckBox",
  );
  if (startup.toggle !== "Off") throw new Error("Startup must remain OFF");
  return { row, field, tool, startup, dialog, tree };
}
