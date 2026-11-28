"""Residual SDK reads for {query:{kind:'component',scope:{component:'root'}}."""


def _camera_default_tolerance(design: "adsk.fusion.Design", expression: str, units: str) -> float:
    manager = design.unitsManager
    if not manager.isValidExpression(expression, units):
        raise ValueError('Invalid or incompatible expression %r for units %r' % (expression, units))
    if manager.isValidExpression(expression, 'cm/cm'):
        raise ValueError('Dimensionless expression cannot implicitly acquire units: ' + expression)
    value = manager.evaluateExpression(expression, units)
    if not math.isfinite(value):
        raise ValueError('Expression evaluated to a non-finite value: ' + expression)
    return value


def _camera_bound_root_query(design: "adsk.fusion.Design", root: "adsk.fusion.Component",
                             doc: "adsk.core.Document", assert_identity: "Callable[[], None]") -> "adsk.fusion.Component":
    tolerance = _camera_default_tolerance(design, '0.001 mm', 'cm')
    angle = _camera_default_tolerance(design, '0.01 deg', 'rad')
    if tolerance < 0 or not 0 <= angle <= math.pi / 2:
        raise ValueError('Tolerances must be nonnegative; angleTolerance must be at most 90 deg')
    assert_identity()
    if getattr(root, 'isValid', True) is False:
        raise ValueError('Invalid entity; re-query current topology')
    # Owner, frame label, ref and describe touch native getters/equality. Keep
    # their ordering (including repeated reads which can raise), not the DTOs.
    _ = root.objectType, root.objectType, root == root, root == root, root.objectType
    if hasattr(root, 'isValid'):
        _ = root.isValid
    bounds = None
    if hasattr(root, 'boundingBox'):
        bounds = _cad_cast('adsk.core.BoundingBox3D | None', getattr(root, 'boundingBox'))
        if bounds is not None:
            # Component.boundingBox has one SDK type. Preserve the native
            # objectType read from fusion_json, not its unrelated type dispatch.
            _ = bounds.objectType
            low, high = _cad_xyz(bounds.minPoint), _cad_xyz(bounds.maxPoint)
            if not all(math.isfinite(v) for v in low + high):
                raise ValueError('Non-finite value cannot be serialized')
        _ = root.objectType
    _ = root.objectType, root.objectType, root.objectType, root.objectType, root == root
    if bounds is not None:
        _ = root.objectType
    _ = root.objectType
    file = doc.dataFile
    _ = doc.name, getattr(doc, 'creationId', None), getattr(file, 'id', None), getattr(file, 'versionNumber', None), root == root
    assert_identity()
    return root
