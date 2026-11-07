"""Read-only qualification for a test-only external source file."""
DOC_NAME = "FMCAD_iw7_6_native_f18c621 v1"


def run(context):
    import adsk.core
    application = adsk.core.Application.get()
    data_file = application.data.findFileById('urn:adsk.wipprod:dm.lineage:-Xc3uxdkR2mKxth6MOEItw')
    if data_file is None:
        raise RuntimeError('owned external source file lookup returned null')
    occurrences = FMCAD.root.occurrences
    return {'scratchOnly': True, 'sourceFileId': data_file.id,
            'sourceFileName': data_file.name,
            'hasAddByInsert': callable(getattr(occurrences, 'addByInsert', None)),
            'designName': FMCAD.doc.name}
