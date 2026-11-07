"""Native external-reference guard case in the owned primary scratch document."""
DOC_NAME = "FMCAD_iw7_6_native_f18c621 v1"


def run(context):
    import adsk.core
    data_file = adsk.core.Application.get().data.findFileById(
        'urn:adsk.wipprod:dm.lineage:-Xc3uxdkR2mKxth6MOEItw')
    if data_file is None:
        raise RuntimeError('owned external source file lookup returned null')
    root = FMCAD.root
    existing = [root.occurrences.item(i) for i in range(root.occurrences.count)
                if root.occurrences.item(i).isReferencedComponent]
    if len(existing) > 1:
        raise RuntimeError('scratch contains more than one external source; inspect before continuing')
    if existing:
        external = existing[0]
    else:
        external = root.occurrences.addByInsert(data_file, adsk.core.Matrix3D.create(), True)
        if external is None or not external.isReferencedComponent:
            raise RuntimeError('SDK did not create the requested external occurrence')
    reference = {'token': external.entityToken, 'kind': 'occurrence',
                 'name': external.name, 'path': external.fullPathName}
    component = {'token': external.component.entityToken, 'kind': 'component',
                 'name': external.component.name}
    rejected = {}
    for operation, data in (
            ('occurrence.duplicate', {'occurrence': reference, 'copyMode': 'linked', 'destination': 'root'}),
            ('occurrence.add', {'component': component, 'copyMode': 'linked', 'destination': 'root'})):
        try:
            FMCAD.call(operation, data)
        except (ValueError, TypeError) as error:
            rejected[operation] = str(error)
        else:
            raise RuntimeError(operation + ' accepted an external referenced component')
    if len(rejected) != 2 or not all('External' in value for value in rejected.values()):
        raise RuntimeError('external guards did not provide explicit rejection: ' + str(rejected))
    return {'scratchOnly': True, 'externalOccurrencePath': external.fullPathName,
            'isReferencedComponent': external.isReferencedComponent, 'rejected': rejected}
