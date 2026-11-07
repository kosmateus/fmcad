import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { DataImportFiles } from "../../../core/src/ports/data-import-files";

export const dataImportFiles: DataImportFiles = {
  cwd: () => process.cwd(),
  isAbsolute: (value) => path.isAbsolute(value),
  resolve: (...values) => path.resolve(...values),
  extension: (value) => path.extname(value).toLowerCase(),
  exists: (value) => fs.existsSync(value),
  stat: (value) => {
    const stat = fs.statSync(value);
    return { regular: stat.isFile(), size: stat.size };
  },
  snapshot: (value) => {
    const bytes = fs.readFileSync(value);
    return {
      text: bytes.toString("utf8"),
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  },
};
