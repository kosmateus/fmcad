"""Public selection-rule handlers and registry ownership."""

if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'selection-rules'


def selection_rule_define(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _selection_rules_define(ctx, data)


def selection_rule_inspect(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _selection_rules_inspect(ctx, data)


def selection_rule_resolve(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _selection_rules_resolve(ctx, data)


def selection_rule_check(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _selection_rules_check(ctx, data)


def selection_rule_define_internal(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _selection_rules_define_internal(ctx, data)


def selection_rule_inspect_internal(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _selection_rules_manifest_internal(ctx, data, 'inspect')


def selection_rule_resolve_internal(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _selection_rules_manifest_internal(ctx, data, 'resolve')


def selection_rule_check_internal(ctx: "CadContext", data: "JsonObject") -> "JsonRecord":
    return _selection_rules_manifest_internal(ctx, data, 'check')


CAD_HANDLERS.update({
    'selection.rule.define': selection_rule_define,
    'selection.rule.inspect': selection_rule_inspect,
    'selection.rule.resolve': selection_rule_resolve,
    'selection.rule.check': selection_rule_check,
    'selection.rule.define_internal': selection_rule_define_internal,
    'selection.rule.inspect_internal': selection_rule_inspect_internal,
    'selection.rule.resolve_internal': selection_rule_resolve_internal,
    'selection.rule.check_internal': selection_rule_check_internal,
})
