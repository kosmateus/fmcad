"""Explicitly capture pending positions in the owned .6 test document."""
DOC_NAME = "FMCAD_iw7_6_native_f18c621 v1"


def run(context):
    snapshots = FMCAD.design.snapshots
    before = bool(snapshots.hasPendingSnapshot)
    if before:
        created = snapshots.add()
        if created is None:
            raise RuntimeError('native snapshot add returned null; inspect owned scratch')
    after = bool(snapshots.hasPendingSnapshot)
    if after:
        raise RuntimeError('pending positions remain after explicit snapshot capture')
    return {'scratchOnly': True, 'hadPendingSnapshot': before, 'hasPendingSnapshot': after}
