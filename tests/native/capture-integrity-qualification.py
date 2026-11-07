"""Opt-in fixture creator. Do not run without separate Fusion authorization."""
import adsk.core
import adsk.fusion
import builtins
import json
import uuid

ARGS = {}
DOC_NAME = ''
AUTHORIZATION = 'I authorize native capture-integrity qualification'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def add_unsaved_design(app, name, role, asymmetric, owned_documents):
    doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
    row = {'document': doc, 'name': name, 'creationId': doc.creationId,
           'role': role, 'isSaved': doc.isSaved, 'isModified': doc.isModified}
    owned_documents.append(row)
    doc.name = name
    design = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
    require(design is not None, 'Synthetic document is not a Fusion Design')
    body = None
    if asymmetric:
        manager = adsk.fusion.TemporaryBRepManager.get()
        point = adsk.core.Point3D.create
        vector = adsk.core.Vector3D.create

        def box(center, size):
            bounds = adsk.core.OrientedBoundingBox3D.create(
                point(*center), vector(1, 0, 0), vector(0, 1, 0), *size)
            return manager.createBox(bounds)

        body = box((1.5, 1, 0.5), (3, 2, 1))
        require(manager.booleanOperation(
            body, box((3.6, 0.4, 0.5), (0.8, 0.8, 0.5)),
            adsk.fusion.BooleanTypes.UnionBooleanType), 'Could not create synthetic side lug')
        cutter = manager.createCylinderOrCone(point(1.2, 1.4, -0.1), 0.18,
                                              point(1.2, 1.4, 1.1), 0.18)
        require(manager.booleanOperation(
            body, cutter, adsk.fusion.BooleanTypes.DifferenceBooleanType),
            'Could not create synthetic bore')
    elif role == 'SYMMETRIC':
        manager = adsk.fusion.TemporaryBRepManager.get()
        bounds = adsk.core.OrientedBoundingBox3D.create(
            adsk.core.Point3D.create(0, 0, 0),
            adsk.core.Vector3D.create(1, 0, 0),
            adsk.core.Vector3D.create(0, 1, 0), 2, 2, 2)
        body = manager.createBox(bounds)
        require(body is not None, 'Could not create symmetric cube fixture')
    if body is not None:
        base = design.rootComponent.features.baseFeatures.add()
        require(base.startEdit(), 'Could not start synthetic base feature')
        design.rootComponent.bRepBodies.add(body, base)
        require(base.finishEdit(), 'Could not finish synthetic base feature')
    return doc


def run(_context):
    require(ARGS.get('authorization') == AUTHORIZATION and ARGS.get('action') == 'create',
            'Explicit user authorization and action=create are required')
    app = adsk.core.Application.get()
    require(app.userInterface.activeCommand in ('', 'SelectCommand'),
            'Finish interactive Fusion commands before preparing fixtures')
    require(not hasattr(builtins, '_FMCAD_CAPTURE_INTEGRITY'),
            'A previous capture-integrity fixture set still requires cleanup')
    token = uuid.uuid4().hex[:12]
    state = {
        'token': token,
        'documents': [],
        'stage': 'creating',
    }
    builtins._FMCAD_CAPTURE_INTEGRITY = state
    try:
        for role, asymmetric in (('BLANK', False), ('ASYMMETRIC', True),
                                 ('SYMMETRIC', False)):
            name = 'FMCAD_CAPTURE_' + token + '_' + role
            require(not any(doc.name == name for doc in app.documents),
                    'Generated native scratch name already exists; refusing to adopt it')
            add_unsaved_design(app, name, role, asymmetric, state['documents'])
        target_row = next(row for row in state['documents'] if row['role'] == 'ASYMMETRIC')
        section_name = 'FMCAD_CAPTURE_SECTION_' + token
        try:
            design = adsk.fusion.Design.cast(
                target_row['document'].products.itemByProductType('DesignProductType'))
            sections = design.analyses.sectionAnalyses
            section_input = sections.createInput(design.rootComponent.xYConstructionPlane, 0.0)
            section = sections.add(section_input)
            require(section is not None, 'Could not create synthetic section analysis')
            section.name = section_name
            state['sectionName'] = section_name
        except Exception as error:
            state['sectionName'] = None
            state['sectionSetupError'] = str(error)
        for row in state['documents']:
            row['isSaved'] = row['document'].isSaved
            row['isModified'] = row['document'].isModified
            design = adsk.fusion.Design.cast(
                row['document'].products.itemByProductType('DesignProductType'))
            bodies = design.rootComponent.bRepBodies
            row['geometryReadback'] = {'bodyCount': bodies.count}
            if row['role'] in ('ASYMMETRIC', 'SYMMETRIC'):
                require(bodies.count == 1, 'Synthetic solid fixture must contain exactly one native body')
                body = bodies.item(0)
                require(body.isValid and body.volume > 0,
                        'Synthetic solid fixture body is invalid or has zero volume')
                bounds = body.boundingBox
                row['geometryReadback'].update({
                    'bodyValid': body.isValid,
                    'volume': body.volume,
                    'minimum': list(bounds.minPoint.asArray()),
                    'maximum': list(bounds.maxPoint.asArray()),
                })
            else:
                require(bodies.count == 0, 'Blank synthetic fixture unexpectedly contains a solid body')
        state['stage'] = 'ready'
        print('FMCAD_RESULT ' + json.dumps({
            'status': 'ready',
            'token': token,
            'fusionBuild': app.version,
            'documents': [{
                'name': row['name'], 'creationId': row['creationId'],
                'role': row['role'],
                'isSaved': row['document'].isSaved,
                'isModified': row['document'].isModified,
                'geometryReadback': row['geometryReadback'],
            } for row in state['documents']],
            'sectionName': state.get('sectionName'),
            'sectionSetupError': state.get('sectionSetupError'),
            'activeFixture': state['documents'][-1]['name'],
            'saved': False,
        }))
    except Exception:
        state['stage'] = 'creation-failed-cleanup-required'
        raise
