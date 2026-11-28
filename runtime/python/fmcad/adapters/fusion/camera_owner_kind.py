"""Only the kind distinctions consumed by root ownership and alias eligibility."""


def _cad_kind(entity: "adsk.core.Base") -> str:
    name = _cad_type(entity)
    return {'Component': 'component', 'Occurrence': 'occurrence',
            'ConstructionPlane': 'plane', 'ConstructionAxis': 'axis',
            'ConstructionPoint': 'point', 'SketchPoint': 'point',
            'UserParameter': 'parameter', 'ModelParameter': 'parameter'}.get(name, name)
