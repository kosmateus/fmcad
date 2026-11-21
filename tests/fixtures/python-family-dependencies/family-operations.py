DOC_NAME = "FamilyDependencyContracts"


def run(context):
    for operation in (
        "shape.box",
        "shape.helix",
        "model.thread",
        "component.create",
        "component.inspect",
        "document.status",
        "visibility.show",
        "inspect.pack",
        "measure.diameter",
        "frame.context_audit",
        "selection.rule.define",
        "geometry.delta",
        "measure.section-series",
        "fastener.measured-check",
        "mechanism.drive-test",
        "sketch.coordinate-check",
        "measure.baseline.inspect",
    ):
        FMCAD.call(operation, {})
