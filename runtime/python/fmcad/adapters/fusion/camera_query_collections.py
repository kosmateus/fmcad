"""Collection reads for fixed-kind queries. The registry selects individual methods."""


class _CameraQueryCollections:
    @staticmethod
    def component(ctx: "CadContext", c: "adsk.fusion.Component") -> "Sequence[CadEntity]":
        return _cad_items(ctx.design.allComponents)

    @staticmethod
    def parameter(ctx: "CadContext", c: "adsk.fusion.Component") -> "Sequence[CadEntity]":
        return _cad_items(ctx.design.allParameters)

    @staticmethod
    def body(ctx: "CadContext", c: "adsk.fusion.Component") -> "Sequence[CadEntity]":
        return _cad_items(c.bRepBodies)

    @staticmethod
    def sketch(ctx: "CadContext", c: "adsk.fusion.Component") -> "Sequence[CadEntity]":
        return _cad_items(c.sketches)

    @staticmethod
    def feature(ctx: "CadContext", c: "adsk.fusion.Component") -> "Sequence[CadEntity]":
        return _cad_items(c.features)

    @staticmethod
    def plane(ctx: "CadContext", c: "adsk.fusion.Component") -> "Sequence[CadEntity]":
        return _cad_items(c.constructionPlanes)

    @staticmethod
    def axis(ctx: "CadContext", c: "adsk.fusion.Component") -> "Sequence[CadEntity]":
        return _cad_items(c.constructionAxes)

    @staticmethod
    def point(ctx: "CadContext", c: "adsk.fusion.Component") -> "Sequence[CadEntity]":
        result: list[adsk.core.Base] = list(_cad_items(c.constructionPoints))
        for sketch in _cad_items(c.sketches):
            result.extend(_cad_items(sketch.sketchPoints))
        return result

    @staticmethod
    def face(ctx: "CadContext", c: "adsk.fusion.Component") -> "Sequence[CadEntity]":
        return [item for body in _cad_items(c.bRepBodies) for item in _cad_items(body.faces)]

    @staticmethod
    def edge(ctx: "CadContext", c: "adsk.fusion.Component") -> "Sequence[CadEntity]":
        return [item for body in _cad_items(c.bRepBodies) for item in _cad_items(body.edges)]

    @staticmethod
    def vertex(ctx: "CadContext", c: "adsk.fusion.Component") -> "Sequence[CadEntity]":
        return [item for body in _cad_items(c.bRepBodies) for item in _cad_items(body.vertices)]

    @staticmethod
    def profile(ctx: "CadContext", c: "adsk.fusion.Component") -> "Sequence[CadEntity]":
        return [p for sketch in _cad_items(c.sketches) for p in _cad_items(sketch.profiles)]


    @staticmethod
    def enumerate(ctx: "CadContext", kind: "str | None", component: "adsk.fusion.Component | None",
                  occurrence: "adsk.fusion.Occurrence | None") -> "Sequence[CadEntity]":
        read = _cad_cast('Callable[[CadContext, adsk.fusion.Component], Sequence[CadEntity]]',
                         getattr(_CameraQueryCollections, _cad_cast(str, kind)))
        entities = read(ctx, component or ctx.component)
        return entities if occurrence is None else [_cad_context_proxy(ctx, entity, occurrence) for entity in entities]


_cad_context_entities = _CameraQueryCollections.enumerate
