"""CONSENT-ONLY synthetic qualification; this module has no import-time effects.

Load with the canonical prepared cad-v1 artifact after registry integration.
Call qualify_regional_geometry(consent=True) ONLY after explicit user approval,
through the shared queue and with an exact --doc/--doc-id target. This creates
one unsaved synthetic document, never saves/cloud-uploads it, closes it without
saving, and restores the previous active document. No product bodies are edited.

Returned failures/unknowns are qualification failures, not an accepted mock proof.
The invalid-empty kernel case is deliberately recorded instead of assumed empty.
"""


def qualify_regional_geometry(consent=False):
    if consent is not True:
        raise RuntimeError('Explicit consent to native synthetic-document qualification is required')
    import adsk.core
    import adsk.fusion
    app = adsk.core.Application.get()
    original = app.activeDocument
    original_modified = original.isModified if original is not None else None
    scratch = None
    report = {'qualification': 'failed', 'nativeBuild': app.version, 'cases': [],
              'restored': False, 'syntheticDocumentClosed': False,
              'limitations': ['Kernel-failure injection in offline tests is not native kernel qualification.']}
    try:
        scratch = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
        design = adsk.fusion.Design.cast(scratch.products.itemByProductType('DesignProductType'))
        design.designType = adsk.fusion.DesignTypes.DirectDesignType
        root = design.rootComponent
        ctx = CadContext(scratch.name, resolved_doc=scratch)
        manager = adsk.fusion.TemporaryBRepManager.get()
        point, vector = adsk.core.Point3D.create, adsk.core.Vector3D.create

        def box(name, lo, hi, component=None):
            component = component or root
            center = [(a + b) / 2 for a, b in zip(lo, hi)]
            size = [b - a for a, b in zip(lo, hi)]
            geometry = adsk.core.OrientedBoundingBox3D.create(
                point(*center), vector(1, 0, 0), vector(0, 1, 0), *size)
            base = component.features.baseFeatures.add()
            if base is None or base.startEdit() is not True:
                raise RuntimeError('Native synthetic base-feature edit did not start')
            try:
                body = component.bRepBodies.add(manager.createBox(geometry), base)
            finally:
                if base.finishEdit() is not True:
                    raise RuntimeError('Native synthetic base-feature edit did not finish')
            if body is None:
                raise RuntimeError('Native synthetic box construction failed')
            body.name = name
            return ctx.ref(body)

        before = box('regional-before', (0, 0, 0), (2, 2, 2))
        after = box('regional-after', (0, 0, 0), (3, 2, 2))
        allowed = box('regional-allowed', (2, 0, 0), (3, 2, 2))
        hole = box('regional-hole', (2, .5, .5), (3, 1.5, 1.5))
        overlap_a = box('regional-overlap-a', (2, 0, 0), (3, 1.5, 2))
        overlap_b = box('regional-overlap-b', (2, .5, 0), (3, 2, 2))
        sector_a = box('regional-sector-a', (2, 0, 0), (3, .5, 2))
        sector_b = box('regional-sector-b', (2, 1.5, 0), (3, 2, 2))
        shifted = box('regional-equal-volume-shift', (1, 0, 0), (3, 2, 2))
        extra = box('regional-external-edit', (0, 0, 0), (3, 3, 2))
        mm_equal = box('regional-unit-equivalent', (0, 0, 0),
                       tuple(ctx.length('20 mm') for _ in range(3)))
        matrix = adsk.core.Matrix3D.create()
        first_instance = root.occurrences.addNewComponent(matrix)
        first_instance.component.name = 'regional-instance-component'
        native_copy = ctx.resolve(box('regional-instance-body', (0, 0, 0), (2, 2, 2),
                                      first_instance.component), 'body')
        translated = adsk.core.Matrix3D.create()
        translated.translation = vector(1, 0, 0)
        second_instance = root.occurrences.addExistingComponent(first_instance.component, translated)
        first_proxy = ctx.ref(native_copy.createForAssemblyContext(first_instance))
        second_proxy = ctx.ref(native_copy.createForAssemblyContext(second_instance))
        frame = {'space': 'assembly', 'component': ctx.ref(root)}

        def check(name, expected, target=after, mask=None, protected=None, budget=None):
            request = {'before': before, 'after': target, 'frame': frame,
                       'allowed': mask if mask is not None else {'include': [allowed]}}
            if protected is not None:
                request['protected'] = protected
            if budget is not None:
                request['operationBudget'] = budget
            saved = [(body, body.entityToken, body.revisionId, body.volume)
                     for component in design.allComponents for body in component.bRepBodies]
            poses = [(occurrence, list(occurrence.transform2.asArray())) for occurrence in root.allOccurrences]
            result = ctx.call('geometry.compare-region', request)
            unchanged = all(body.isValid and body.entityToken == token and
                            body.revisionId == revision and body.volume == volume
                            for body, token, revision, volume in saved) and all(
                                occurrence.isValid and list(occurrence.transform2.asArray()) == pose
                                for occurrence, pose in poses)
            report['cases'].append({'name': name, 'expected': expected, 'result': result,
                                    'sourceBodiesUnchanged': unchanged,
                                    'qualified': result['status'] == expected and unchanged})

        check('allowed-change', 'pass')
        check('identical-solid-empty-difference', 'pass', target=before)
        check('additional-outside-edit', 'fail', target=extra)
        check('equal-volume-different-shape', 'fail', target=shifted)
        check('overlapping-mask-union', 'pass', mask={'include': [overlap_a, overlap_b]})
        check('hole-not-filled', 'fail', mask={'include': [allowed], 'exclude': [hole]})
        check('missing-sector', 'fail', mask={'include': [sector_a, sector_b]})
        check('protected-overrides-allowed', 'fail', protected={'include': [allowed]})
        check('budget-is-not-proof', 'unknown', budget=1)
        check('millimeter-centimeter-unit-equivalence', 'pass', target=mm_equal)
        check('first-instance-qualified', 'pass', target=first_proxy)
        check('second-instance-not-conflated', 'fail', target=second_proxy)
        report['qualification'] = 'pass' if all(case['qualified'] for case in report['cases']) else 'failed'
    except Exception as exc:
        report['error'] = str(exc)
    finally:
        try:
            if scratch is not None:
                report['syntheticDocumentClosed'] = scratch.close(False) is True
            if original is not None:
                original.activate()
            report['restored'] = (app.activeDocument == original and
                                  (original is None or original.isModified == original_modified))
        except Exception as exc:
            report['restoreError'] = str(exc)
        if not report['restored'] or not report['syntheticDocumentClosed']:
            report['qualification'] = 'failed'
    return report
