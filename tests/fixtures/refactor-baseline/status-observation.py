"""Observe the complete generated status script against the offline Fusion model."""
import contextlib
import io
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "support/fusion-simulator"))
import adsk.core

request = json.load(sys.stdin)
app = adsk.core.Application.get()
document = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
document.creationId = "creation-fixture"
project = app.data.dataProjects.item(0)
project.id = "project-fixture"
document.saveAs("Synthetic Model", project.rootFolder, "", "")
document.dataFile.id = "urn:fixture:file"
document.isModified = request.get("modified", False)
other = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
save_calls = app.data.save_calls
namespace = {}
output = io.StringIO()
error = None
with contextlib.redirect_stdout(output):
    try:
        exec(compile(request["script"], "<prepared-status>", "exec"), namespace)
        namespace["run"]("")
    except Exception as caught:
        error = {"type": type(caught).__name__, "message": str(caught)}
print(json.dumps({
    "stdout": output.getvalue(),
    "error": error,
    "activeUnchanged": app.activeDocument is other,
    "modified": document.isModified,
    "additionalSaves": app.data.save_calls - save_calls,
    "documentCount": app.documents.count,
}))
