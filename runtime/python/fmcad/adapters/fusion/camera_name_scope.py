"""Private scope for alias callbacks that use only the Design and its root."""


class CadContext:
    def __init__(self, design: "adsk.fusion.Design") -> None:
        self.design = design
        self.root = design.rootComponent
