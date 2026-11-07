import type {
  DocumentCommandPorts,
  DocumentReply,
} from "../../../core/src/application/documents/commands";
import { pythonLiteral } from "../python/artifact.js";

export function documentCommandPorts(
  call: DocumentCommandPorts["call"],
  toWindowsPath: (path: string) => string,
): DocumentCommandPorts {
  const script = (code: string): Promise<DocumentReply> =>
    call(
      { featureType: "script", object: { script: code } },
      "fusion_mcp_execute",
    );
  return {
    call,
    newDocument(name) {
      return script(
        "import adsk.core\n\nNAME: str = " +
          pythonLiteral(name) +
          '\n\ndef run(_context: str) -> None:\n    app = adsk.core.Application.get()\n    doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)\n    if NAME:\n        doc.name = NAME\n    print("CREATED_DOC name=" + doc.name)\n',
      );
    },
    download(file, output) {
      const winPath =
        output && /\.[A-Za-z0-9]{1,5}$/.test(output)
          ? toWindowsPath(output)
          : toWindowsPath(output || process.cwd()) +
            "\\" +
            String(file.name).replace(/[\\/:*?"<>|]/g, "_");
      return script(
        "import adsk.core\nfrom typing import cast as _doc_cast\n\nFILE_ID: str = " +
          pythonLiteral(file.id) +
          "\nDIR_PATH: str = " +
          pythonLiteral(winPath) +
          '\n\ndef run(_context: str) -> None:\n    app = adsk.core.Application.get()\n    f = _doc_cast("adsk.core.DataFile | None", app.data.findFileById(FILE_ID))\n    if f is None:\n        print("ERROR file not found by id")\n        return\n    if not f.download(DIR_PATH, None):\n        print("ERROR download failed (note: Fusion files like F3D cannot be downloaded)")\n        return\n    print("DOWNLOADED path=" + DIR_PATH)\n',
      );
    },
  };
}
