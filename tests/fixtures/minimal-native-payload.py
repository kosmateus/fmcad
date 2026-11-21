DOC_NAME = ""


def run(context: str) -> None:
    result = FMCAD.call(
        "shape.box",
        {"name": "PayloadBox", "width": "10 mm", "depth": "12 mm", "height": "14 mm"},
    )
    FMCAD.emit(result)
