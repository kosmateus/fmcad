/**
 * Private native QUERY composition. Run only after the existing native guard
 * authenticated the current carrier; this fragment never creates authority.
 * Original fence/receipt/MAC fields are returned unchanged. The additional
 * successor proof is read from the SAME SQLite snapshot, never caller JSON.
 */
export const runtimeRootSuccessorQueryPython = `
def _fmcad_query_runtime_root(authority, request):
    import copy
    import hashlib
    from lib.admission_json import decode_json
    from lib.request_admission import AdmissionStore, AdmissionError, _encode
    from lib.rebaseline_fence import _exact, _request_id, _runtime
    from lib.rebaseline_fence_store import (
        _verify_runtime, active_head, head, _row, _response, _table, _database,
    )

    def refuse():
        raise AdmissionError("Runtime root successor proof refused")

    def generation(value):
        _exact(value, ("instance", "epoch"))
        if any(not isinstance(x, str) or not x for x in value.values()):
            refuse()
        return _encode(value)

    _exact(request, ("requestId",))
    request_id = _request_id(request["requestId"])
    current = copy.deepcopy(_runtime(authority.runtime))
    with AdmissionStore(authority.database, instance=current["generation"]["instance"],
                        epoch=current["generation"]["epoch"], create=False) as store:
        with store._transaction(read_snapshot=True):
            _verify_runtime(store, authority)
            active = active_head(store)
            row = _row(store, request_id, authority) if _table(store, "provision_fences") else None
            if row is None:
                if active is not None:
                    refuse()
                result = dict(kind="fmcad-provision-fence", version=1, state="absent",
                              requestId=request_id, successor=None)
            else:
                pointer = head(store)
                if pointer is None or pointer[0] != request_id:
                    refuse()
                binding = decode_json(row[1])
                if binding.get("requestId") != request_id:
                    refuse()
                original_generation = generation(binding["generation"])
                current_generation = generation(current["generation"])
                if (binding["physicalRuntime"] != current["physicalRuntime"]
                        or binding["endpointURL"] != current["endpointURL"]):
                    refuse()
                retirement = None
                if _table(store, "provision_fence_retirements"):
                    retirement = store._db.execute(
                        "SELECT handoff_id,next_instance,next_epoch FROM provision_fence_retirements "
                        "WHERE request_id=?", (request_id,),
                    ).fetchone()
                if row[4] == "consumed":
                    # Validate the stored originals before _response MACs them.
                    receipt = decode_json(row[6])
                    if row[6] != _encode(receipt):
                        refuse()
                    _exact(receipt, ("kind", "version", "fence", "activation", "consumedBy"))
                    if (not isinstance(receipt["consumedBy"], str) or not receipt["consumedBy"]
                            or not _table(store, "provision_fence_audit")):
                        refuse()
                    # Match the original consume, not a later consume-resume
                    # or the operator performing this read of the old root.
                    consumers = store._db.execute(
                        "SELECT operator_id,writer_generation FROM provision_fence_audit "
                        "WHERE request_id=? AND action='consume'", (request_id,),
                    ).fetchall()
                    if consumers != [(receipt["consumedBy"], "")]:
                        refuse()
                    approval = receipt["activation"]
                    _exact(approval, ("requestId", "fenceNonce", "newHead",
                                      "publicationDigest", "record", "initiatorOperatorId"))
                    publication = decode_json(row[5])
                    activation = decode_json(publication["activationBytes"])
                    if (receipt["kind"] != "fmcad-rebaseline-consumed"
                            or type(receipt["version"]) is not int or receipt["version"] != 1
                            or receipt["fence"] != binding
                            or approval["requestId"] != request_id
                            or approval["fenceNonce"] != binding["fenceNonce"]
                            or approval["initiatorOperatorId"] != binding["initiatorOperatorId"]
                            or approval["publicationDigest"] != hashlib.sha256(row[5].encode("utf-8")).hexdigest()
                            or approval["newHead"] != activation["newHead"]
                            or approval["record"] != activation["record"]
                            or approval["record"] != publication["record"]):
                        refuse()
                if original_generation == current_generation:
                    if retirement is not None or binding["handoffId"] != current["handoffId"]:
                        refuse()
                    result = dict(_response(row, authority), successor=None)
                else:
                    if row[4] != "consumed" or retirement is None or active is not None:
                        refuse()
                    history = {
                        _encode(dict(instance=i, epoch=e))
                        for i, e in store._db.execute("SELECT instance,epoch FROM generation_history")
                    }
                    edges, incoming, identifiers = {}, {}, set()
                    for handoff_id, raw in store._db.execute("SELECT id,result FROM physical_handoffs"):
                        value = decode_json(raw)
                        _exact(value, ("handoffId", "generation", "nextGeneration", "state"))
                        source, target = generation(value["generation"]), generation(value["nextGeneration"])
                        if (value["state"] != "committed" or value["handoffId"] != handoff_id
                                or not isinstance(handoff_id, str) or not handoff_id
                                or handoff_id in identifiers or raw != _encode(value)
                                or source == target or source not in history or target not in history
                                or source in edges or target in incoming):
                            refuse()
                        identifiers.add(handoff_id)
                        edges[source] = value
                        incoming[target] = source
                    # All ordinary commits must form unambiguous acyclic paths.
                    checked = set()
                    for start in edges:
                        visited, cursor = set(), start
                        while cursor in edges and cursor not in checked:
                            if cursor in visited:
                                refuse()
                            visited.add(cursor)
                            cursor = generation(edges[cursor]["nextGeneration"])
                        checked.update(visited)
                    chain, cursor = [], original_generation
                    while cursor != current_generation:
                        value = edges.get(cursor)
                        if value is None:
                            refuse()
                        chain.append(value)
                        cursor = generation(value["nextGeneration"])
                    if (not chain or current_generation in edges
                            or chain[0]["handoffId"] != retirement[0]
                            or chain[0]["nextGeneration"] != dict(instance=retirement[1], epoch=retirement[2])
                            or chain[-1]["handoffId"] != current["handoffId"]):
                        refuse()
                    database = _database(store)
                    if any(type(database[key]) is not int or database[key] < 0
                           for key in ("device", "inode")):
                        refuse()
                    result = dict(_response(row, authority), successor=dict(
                        kind="fmcad-runtime-root-successor-v1", version=1, requestId=request_id,
                        retirement=dict(handoffId=retirement[0], nextGeneration=chain[0]["nextGeneration"]),
                        handoffs=chain, currentRuntime=current,
                        database=dict(path=database["path"], device=str(database["device"]),
                                      inode=str(database["inode"])),
                    ))
            # Revalidate the process and named DB inode at the snapshot boundary.
            # This detects a replaced file even though SQLite still holds its FD.
            _verify_runtime(store, authority)
            if authority.runtime != current:
                refuse()
            return result
`;
