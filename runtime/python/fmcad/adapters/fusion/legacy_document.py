"""Document selection shared by legacy SDK command adapters."""
from typing import Callable, cast
import adsk.core
import adsk.fusion


def _err(msg: str) -> None:
    print("ERROR " + msg)


def _design(doc_name: str) -> "adsk.fusion.Design | None":
    app = adsk.core.Application.get()
    if not doc_name:
        _err("document commands require a document name")
        return None
    matches = [d for d in app.documents if d.name.lower() == doc_name.lower()]
    if not matches:
        _err("document not open: " + doc_name)
        return None
    if len(matches) != 1:
        _err("document name is ambiguous: " + doc_name)
        return None
    doc = matches[0]
    if not doc.activate():
        _err("document activation failed: " + doc_name)
        return None
    active = cast("adsk.core.Document | None", app.activeDocument)
    if active is None or active.creationId != doc.creationId:
        _err("active document identity changed: " + doc_name)
        return None
    design_cast = cast("Callable[[object], adsk.fusion.Design | None]", getattr(adsk.fusion.Design, "cast"))
    design = design_cast(app.activeProduct)
    if design is None:
        _err("document is not a design: " + doc_name)
        return None
    print("DOC name=" + doc.name)
    return design
