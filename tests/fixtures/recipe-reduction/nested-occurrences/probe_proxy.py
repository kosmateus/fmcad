"""Read-only qualification of root-context proxy creation for owned scratch."""
DOC_NAME = "FMCAD_iw7_6_native_f18c621 v1"


def run(context):
    parent = FMCAD.resolve('IW76_Parent:1', 'occurrence')
    matches = [FMCAD.root.allOccurrences.item(i)
               for i in range(FMCAD.root.allOccurrences.count)
               if FMCAD.root.allOccurrences.item(i).fullPathName == 'IW76_Parent:1+IW76_Source:2']
    if len(matches) != 1:
        raise RuntimeError('expected one existing nested source proxy, got ' + str(len(matches)))
    proxy = matches[0]
    native = getattr(proxy, 'nativeObject', None) or proxy
    reconstructed = native.createForAssemblyContext(parent)
    return {'scratchOnly': True, 'path': proxy.fullPathName,
            'enumeratedToken': proxy.entityToken,
            'reconstructedPath': reconstructed.fullPathName,
            'reconstructedToken': reconstructed.entityToken,
            'assemblyContext': reconstructed.assemblyContext.fullPathName}
