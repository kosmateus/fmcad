"""Geometry shapes: application; retained cad-v1 shared namespace."""
# Registry ownership is set here, before the compatibility facade executes.
if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'shapes'


@_cad_scoped_step('shape', native_only=True)
def _shapes_recipe(ctx: "CadContext", data: "JsonObject", mode: str) -> "JsonValue":
    if mode == 'helix' and any(k in data for k in ('pitch', 'turns', 'radius')):
        raise ValueError('Helix pitch/turns generation is unimplemented: TemporaryBRepManager.createHelixWire takes numeric values and creates only a temporary wire; the documented CoilFeatures collection exposes no add/createInput. No parametric sampled spline is substituted. Supply an existing helical path instead.')
    if mode == 'bolt_circle' and 'entities' not in data:
        return _shapes_generated_cut(ctx, data, mode)
    if mode == 'slot' and 'profile' not in data:
        return _shapes_generated_cut(ctx, data, mode)
    if (mode == 'revolved_profile' and 'profileData' in data) or (mode == 'route' and 'waypoints' in data):
        return _shapes_data_recipe(ctx, data, mode)
    if 'name' in data:
        _shapes_reserve(ctx, [data['name']])
    if mode in ('box', 'cylinder', 'tube', 'ring', 'cone'):
        return _shapes_primitive(ctx, data, mode)
    if mode == 'revolved_profile':
        _model_fields(data, ('profile', 'axis'), ('angle', 'name', 'operation'))
        _shapes_native(ctx, data['profile'], 'profile')
        _shapes_native(ctx, data['axis'])
        angle = data.get('angle', '360 deg')
        if not 0 < ctx.angle(angle) <= 2 * math.pi:
            raise ValueError('angle must be greater than zero and at most 360 deg')
        return ctx.call('model.revolve', dict(data, angle=angle))
    if mode in ('slot', 'rib', 'web'):
        _model_fields(data, ('profile', 'thickness'), ('name', 'operation', 'symmetric'))
        _shapes_native(ctx, data['profile'], 'profile')
        if ctx.length(data['thickness']) <= 0:
            raise ValueError('thickness must be positive')
        payload = dict(data)
        payload['distance'] = payload.pop('thickness')
        payload.setdefault('operation', 'cut' if mode == 'slot' else 'join')
        return ctx.call('model.extrude', payload)
    if mode in ('bolt_circle', 'slot_pattern'):
        required = ('entities', 'axis', 'quantity') if mode == 'bolt_circle' else ('entities', 'direction', 'quantity', 'distance')
        optional = ('name', 'angle') if mode == 'bolt_circle' else ('name', 'distanceType')
        _model_fields(data, required, optional)
        if not isinstance(data['entities'], list) or not data['entities']:
            raise ValueError('entities must contain explicit seed feature references')
        for ref in data['entities']:
            _shapes_native(ctx, ref, 'feature')
        _shapes_native(ctx, data['axis' if mode == 'bolt_circle' else 'direction'])
        quantity = data['quantity']
        _shapes_count(ctx, quantity)
        if mode == 'bolt_circle':
            if not 0 < ctx.angle(data.get('angle', '360 deg')) <= 2 * math.pi:
                raise ValueError('angle must be in (0, 360 deg]')
        elif ctx.length(data['distance']) <= 0:
            raise ValueError('distance must be positive')
        return ctx.call('pattern.circular' if mode == 'bolt_circle' else 'pattern.rectangular', data)
    _model_fields(data, ('profile', 'path'), ('name', 'operation', 'twist', 'taper'))
    _shapes_native(ctx, data['profile'], 'profile')
    _model_path(ctx, data['path'])
    for key in ('twist', 'taper'):
        if key in data:
            ctx.angle(data[key])
    return ctx.call('model.sweep', data)


def _shapes_handler(mode: str) -> "CadHandler":
    def handler(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
        return _shapes_recipe(ctx, data, mode)
    return handler


def _shapes_gm10_handler(mode: str) -> "CadHandler":
    def handler(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
        return _shapes_gm10(ctx, data, mode)
    return handler


CAD_HANDLERS.update({'shape.' + mode: _shapes_handler(mode) for mode in (
    'box', 'cylinder', 'tube', 'ring', 'cone', 'revolved_profile', 'bolt_circle',
    'slot', 'slot_pattern', 'rib', 'web', 'route', 'helix')})


CAD_HANDLERS.update({'shape.' + mode: _shapes_gm10_handler(mode) for mode in (
    'annular_segment', 'arc_strip', 'can', 'impeller', 'boss_pattern')})

globals().__setitem__('_FMCAD_GEOMETRY_LOADED', (*globals().get('_FMCAD_GEOMETRY_LOADED', ()), 'shapes'))
