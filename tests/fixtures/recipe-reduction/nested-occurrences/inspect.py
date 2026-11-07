"""Read-only reconcile helper for the owned iw7.6 scratch document."""
DOC_NAME = "FMCAD_iw7_6_native_f18c621 v1"


def run(context):
    root = FMCAD.root
    occurrences = []
    for index in range(root.allOccurrences.count):
        occurrence = root.allOccurrences.item(index)
        occurrences.append({'path': occurrence.fullPathName,
                            'component': occurrence.component.name,
                            'external': occurrence.isReferencedComponent,
                            'grounded': getattr(occurrence, 'isGrounded', None),
                            'groundToParent': getattr(occurrence, 'isGroundToParent', None),
                            'transform': list(occurrence.transform2.asArray())})
    return {'scratchOnly': True, 'hasPendingSnapshot': FMCAD.design.snapshots.hasPendingSnapshot,
            'occurrences': [{'path': row['path'], 'component': row['component'],
                             'transform': row['transform']} for row in occurrences
                            if any(token in row['component'] for token in ('Source', 'Moving', 'Target', 'ParentSpace', 'RootSpace', 'External'))],
            'componentNames': [FMCAD.design.allComponents.item(i).name
                               for i in range(FMCAD.design.allComponents.count)]}
