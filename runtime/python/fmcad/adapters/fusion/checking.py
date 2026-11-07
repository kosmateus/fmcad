"""GM37 checks, evidence and release: check.set, evidence package/check, deliver.

``check.set`` extends the existing scalar ``check`` engine with richer
scalar/vector/count/Boolean predicates, dependency ordering and distinct
outcomes (pass / fail / error / missing / stale / skipped). It reuses the
existing ``check`` handler through ``ctx.call`` for scalar measurements rather
than duplicating it. ``evidence.package`` and ``evidence.check`` compose a
manifest of declared models/drawings/images/films and report completeness,
staleness and missing evidence. ``deliver`` is the acceptance command: it
composes existing checks and evidence, and returns ``success: false`` on any
fail/blocked/unknown. An empty required checklist is an error. A failed test
is never conflated with an execution error, missing data or stale evidence, and
a source document marked ``valid: true`` or CHECKED_DOCUMENT never counts as
model acceptance.
"""
def _checking_contract(ctx: "CadContext", operation: str, result: "JsonObject", status: str = 'pass',
                       acceptance: bool = False, limitations: "Sequence[str]" = ()) -> "JsonObject":
    identity = None
    if hasattr(ctx, 'doc') and getattr(getattr(ctx, 'doc', None), 'name', None) is not None:
        identity = {'name': ctx.doc.name}
    return checking_contract(identity, operation, result, status, acceptance, limitations)


def _checking_contract_builder(ctx: "CadContext") -> "_CheckingContract":
    def build(operation: str, result: "JsonObject", *, status: str = 'pass', acceptance: bool = False,
              limitations: "Sequence[str]" = ()) -> "JsonObject":
        return _checking_contract(ctx, operation, result, status, acceptance, limitations)
    return build


def _evaluate_predicate(ctx: "CadContext", predicate: "JsonObject") -> "JsonObject":
    def scalar_measurement(data: "JsonObject") -> "JsonObject":
        return _cad_cast("JsonObject", ctx.call('check', data))
    return checking_predicate(predicate, scalar_measurement)


def _check_set(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    def evaluate(predicate: "JsonObject") -> "JsonObject":
        return _evaluate_predicate(ctx, predicate)
    return checking_set(data, evaluate, _checking_contract_builder(ctx))


def _evidence_package(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    return checking_evidence_package(data, _checking_contract_builder(ctx))


def _evidence_check(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    return checking_evidence_check(data, _checking_contract_builder(ctx))


def _deliver(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    def dispatch(operation: str, data: "JsonObject") -> "JsonObject":
        return _cad_cast("JsonObject", ctx.call(operation, data))
    return checking_deliver(data, dispatch, _checking_contract_builder(ctx))


CAD_HANDLERS.update({
    'check.set': _check_set,
    'evidence.package': _evidence_package,
    'evidence.check': _evidence_check,
    'deliver': _deliver,
})
