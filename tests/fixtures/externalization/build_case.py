"""Create small owned native sources/assemblies for component.externalize tests.

Create a blank document in the owned folder through the existing document CLI,
then run this builder once and save the resulting model explicitly. This script creates only
in that exact active fixture document; it never saves,
uploads, deletes, or closes it. No IDs or project names are embedded here.
"""
ARGS = []
DOC_NAME = ''


def run(_context):
    import adsk.core
    import adsk.fusion
    import math

    if not isinstance(ARGS, dict) or set(ARGS) - {
            'role', 'prefix', 'targetProjectId', 'targetFolderId','driverName', 'driverExpression', 'driverUnit',
            'makeDriverBody', 'components', 'boundaries'}:
        raise ValueError('Expected role/prefix and explicit optional fixture declarations')
    role = ARGS.get('role')
    prefix = ARGS.get('prefix')
    if role not in ('driver', 'module', 'assembly') or not isinstance(prefix, str) or not prefix:
        raise ValueError('role must be driver, module or assembly and prefix must be nonempty')
    design = FMCAD.design
    root = FMCAD.root
    doc=FMCAD.doc;file=doc.dataFile
    if not isinstance(ARGS.get('targetProjectId'),str) or not ARGS['targetProjectId'] or \
            not isinstance(ARGS.get('targetFolderId'),str) or not ARGS['targetFolderId']:
        raise ValueError('Fixture builder requires its exact owned projectId and folderId')
    if file is None or file.parentProject.id!=ARGS['targetProjectId'] or file.parentFolder.id!=ARGS['targetFolderId'] or \
            doc.isModified or file.isComplete is not True or file.isReadOnly is not False:
        raise ValueError('Fixture builder target is not the exact saved, clean, complete and writable owned document')
    if design.timeline.markerPosition != design.timeline.count or design.snapshots.hasPendingSnapshot:
        raise ValueError('Fixture build requires end-of-history and no pending position snapshot')
    if root.occurrences.count or root.bRepBodies.count or design.userParameters.count or design.timeline.count:
        raise ValueError('Fixture builder requires a fresh blank native design')

    driver = None
    if ARGS.get('driverName') is not None:
        if not isinstance(ARGS.get('driverName'), str) or not isinstance(ARGS.get('driverExpression'), str) or \
                not isinstance(ARGS.get('driverUnit'), str):
            raise ValueError('Driver requires exact name, expression and unit strings')
        driver = design.userParameters.add(ARGS['driverName'],
            adsk.core.ValueInput.createByString(ARGS['driverExpression']), ARGS['driverUnit'],
            'Generic externalization integration driver')
        if driver is None:
            raise RuntimeError('Native driver parameter creation returned no object')
        driver.isFavorite = True

    def attributes(entity, rows):
        for group, name, value in rows:
            old = entity.attributes.itemByName(group, name)
            if old is not None:
                if old.value != value:
                    raise ValueError('Fixture attribute collision differs from requested role')
            else:
                entity.attributes.add(group, name, value)

    def add_box(component_ref, name, width, depth, height, role_name):
        result = FMCAD.call('shape.box', {'name': name, 'width': width, 'depth': depth,
                                          'height': height}, component=component_ref)
        component = FMCAD.resolve(component_ref, 'component')
        body_refs = result.get('bodies') if isinstance(result, dict) else None
        if not isinstance(body_refs, list) or len(body_refs) != 1:
            raise RuntimeError('Native fixture body was not uniquely created as a solid')
        body = FMCAD.resolve(body_refs[0], 'body')
        if body.parentComponent != component or not body.isSolid:
            raise RuntimeError('Native fixture body was not uniquely created as a solid')
        attributes(component, [('FMCAD_EXTERNALIZATION_FIXTURE', 'role', role_name)])
        attributes(body, [('FMCAD_EXTERNALIZATION_FIXTURE', 'role', role_name)])
        return {'operationResult': result, 'bodyName': body.name,
                'volumeInternal': float(body.volume), 'faces': int(body.faces.count),
                'edges': int(body.edges.count)}

    if role in ('driver','module'):
        if driver is None:
            raise ValueError('driver/module role requires driverName/driverExpression/driverUnit')
        body = None
        if role=='module' or ARGS.get('makeDriverBody') is True:
            body = FMCAD.call('shape.box', {'name': prefix + '_body',
                'width': driver.name, 'depth': '10 mm', 'height': '10 mm'})
            attributes(root,[('FMCAD_EXTERNALIZATION_FIXTURE','role',role)])
        return {'role': role, 'driver': {'name': driver.name, 'expression': driver.expression,
                'unit': driver.unit, 'favorite': bool(driver.isFavorite)},
                'body': body, 'health': FMCAD.call('history.check', {})}

    components = ARGS.get('components')
    if not isinstance(components, list) or not components:
        raise ValueError('assembly role requires a nonempty components array')
    created = []
    native_components = {}
    native_occurrences = {}
    for spec in components:
        if not isinstance(spec, dict) or set(spec) - {
                'name', 'itemId', 'role', 'width', 'depth', 'height', 'placement', 'repeatTranslations'} or \
                not all(isinstance(spec.get(key), str) and spec[key] for key in
                        ('name', 'role', 'width', 'depth', 'height')):
            raise ValueError('Each component requires exact name/role and dimensional expressions')
        added = FMCAD.call('component.create', {'name': spec['name'],
            **({'placement': spec['placement']} if spec.get('placement') is not None else {})})
        component_ref, occurrence_ref = added.get('component'), added.get('occurrence')
        if not component_ref or not occurrence_ref:
            raise RuntimeError('Native component creation returned incomplete references')
        component = FMCAD.resolve(component_ref, 'component')
        occurrence = FMCAD.resolve(occurrence_ref, 'occurrence')
        native_components[spec['name']] = component
        native_occurrences[spec['name']] = [occurrence]
        body = add_box(component_ref, spec['name'] + '_body', spec['width'], spec['depth'],
                       spec['height'], spec['role'])
        attributes(occurrence, [('FMCAD_EXTERNALIZATION_FIXTURE', 'role', spec['role']),
                                ('FMCAD_EXTERNALIZATION_FIXTURE', 'instance', spec['name'] + ':0')])
        native = getattr(occurrence, 'nativeObject', None) or occurrence
        attributes(native, [('FMCAD_EXTERNALIZATION_FIXTURE', 'native_role', spec['role'])])
        occurrences = [{'component': component_ref, 'occurrence': occurrence_ref,
                        'path': occurrence.fullPathName, 'body': body,
                        'transform': list(occurrence.transform2.asArray())}]
        repeats = spec.get('repeatTranslations', [])
        if not isinstance(repeats, list):
            raise ValueError('repeatTranslations must be an array of explicit root translations')
        for index, translation in enumerate(repeats, 1):
            if not isinstance(translation, list) or len(translation) != 3 or \
                    not all(isinstance(value, str) and value for value in translation):
                raise ValueError('Each repeat translation requires three length expressions')
            duplicate = FMCAD.call('occurrence.add', {'component': component_ref, 'copyMode': 'linked',
                'placement': {'translation': translation}})
            repeated = FMCAD.resolve(duplicate['occurrence'], 'occurrence')
            attributes(repeated, [('FMCAD_EXTERNALIZATION_FIXTURE', 'role', spec['role']),
                                  ('FMCAD_EXTERNALIZATION_FIXTURE', 'instance', spec['name'] + ':' + str(index))])
            repeated_native = getattr(repeated, 'nativeObject', None) or repeated
            attributes(repeated_native, [('FMCAD_EXTERNALIZATION_FIXTURE', 'native_role', spec['role'])])
            occurrences.append({'component': component_ref, 'occurrence': duplicate['occurrence'],
                'path': repeated.fullPathName, 'transform': list(repeated.transform2.asArray())})
            native_occurrences[spec['name']].append(repeated)
        created.append({'name': spec['name'], 'itemId':spec.get('itemId',spec['name']),
            'role': spec['role'], 'component': component_ref,
            'inventory': {'bodies': int(component.bRepBodies.count), 'occurrences': int(component.allOccurrences.count),
                'history': int(component.features.count + component.sketches.count)}, 'instances': occurrences})

    def occurrence_ref(occurrence):
        component = occurrence.component
        return {'token': str(occurrence.entityToken), 'kind':'occurrence', 'name':str(occurrence.name),
            'component':{'token':str(component.entityToken),'kind':'component','name':str(component.name)},
            'path':str(occurrence.fullPathName)}

    def joint_origin(component, name, frame=None):
        frame={} if frame is None else frame
        if not isinstance(frame,dict) or set(frame)-{'xAxis','zAxis','offsetX','offsetY','offsetZ','angle'}:
            raise ValueError('Fixture origin frame needs explicit native axes and optional expressions')
        x_axis,z_axis=frame.get('xAxis','x'),frame.get('zAxis','z')
        if x_axis not in ('x','y','z') or z_axis not in ('x','y','z') or x_axis==z_axis:
            raise ValueError('Fixture origin axes must be distinct native axes')
        if any(not isinstance(frame[key],str) or not frame[key] for key in ('offsetX','offsetY','offsetZ','angle') if key in frame):
            raise ValueError('Fixture origin offsets/angle require expressions')
        origin = component.jointOrigins.itemByName(name)
        if origin is not None:
            return origin
        geometry = adsk.fusion.JointGeometry.createByPoint(component.originConstructionPoint)
        input = component.jointOrigins.createInput(geometry)
        input.xAxisEntity = getattr(component,x_axis+'ConstructionAxis')
        input.zAxisEntity = getattr(component,z_axis+'ConstructionAxis')
        for key in ('offsetX','offsetY','offsetZ','angle'):
            if key in frame:setattr(input,key,adsk.core.ValueInput.createByString(frame[key]))
        origin = component.jointOrigins.add(input)
        if origin is None:
            raise RuntimeError('Native fixture JointOrigin creation returned no object')
        origin.name = name
        return origin

    boundary_results = []
    nominal_readbacks=[]
    for spec in ARGS.get('boundaries', []):
        allowed = {'id','kind','one','two','oneIndex','twoIndex','oneItemId','twoItemId','axis','angle','offset','isFlipped','limits',
                   'oneFrame','twoFrame','rotationValue'}
        if not isinstance(spec, dict) or set(spec)-allowed or not all(isinstance(spec.get(k),str) and spec[k]
                for k in ('id','kind','one','two')):
            raise ValueError('Boundary fixture requires id/kind/two exact component names')
        if spec['kind'] not in ('asBuiltRigid','rigid','revolute'):
            raise ValueError('Fixture supports asBuiltRigid, rigid and revolute boundary kinds')
        if 'rotationValue' in spec and (spec['kind']!='revolute' or type(spec['rotationValue']) not in (int,float) or
                                       not math.isfinite(spec['rotationValue'])):
            raise ValueError('Fixture nominal rotation requires a finite revolute value in radians')
        if spec['kind']=='asBuiltRigid' and any(key in spec for key in ('oneFrame','twoFrame')):
            raise ValueError('As-built rigid fixture does not use JointOrigin frames')
        one_rows=native_occurrences.get(spec['one']);two_rows=native_occurrences.get(spec['two'])
        if one_rows is None or two_rows is None:
            raise ValueError('Boundary fixture component is not in the local assembly')
        one_index=spec.get('oneIndex',0);two_index=spec.get('twoIndex',0)
        if type(one_index) is not int or type(two_index) is not int or not (0<=one_index<len(one_rows)) or not (0<=two_index<len(two_rows)):
            raise ValueError('Boundary fixture instance index is outside the captured component instances')
        one_occurrence,two_occurrence=one_rows[one_index],two_rows[two_index]
        if spec['kind']=='asBuiltRigid':
            joint_input=root.asBuiltJoints.createInput(one_occurrence,two_occurrence,None)
            joint_input.setAsRigidJointMotion()
            joint=root.asBuiltJoints.add(joint_input)
        else:
            one_origin=joint_origin(native_components[spec['one']],spec['id']+'_one',spec.get('oneFrame'))
            two_origin=joint_origin(native_components[spec['two']],spec['id']+'_two',spec.get('twoFrame'))
            first=one_origin.createForAssemblyContext(one_occurrence)
            second=two_origin.createForAssemblyContext(two_occurrence)
            joint_input=root.joints.createInput(first,second)
            if spec['kind']=='rigid':
                joint_input.setAsRigidJointMotion()
            else:
                axis=spec.get('axis')
                if axis not in ('x','y','z'):
                    raise ValueError('Fixture revolute axis must be an explicit nonzero X/Y/Z direction')
                direction=getattr(adsk.fusion.JointDirections,axis.upper()+'AxisJointDirection')
                joint_input.setAsRevoluteJointMotion(direction)
            if hasattr(joint_input,'angle'):joint_input.angle=adsk.core.ValueInput.createByString(spec.get('angle','0 deg'))
            if hasattr(joint_input,'offset'):joint_input.offset=adsk.core.ValueInput.createByString(spec.get('offset','0 mm'))
            if hasattr(joint_input,'isFlipped'):joint_input.isFlipped=bool(spec.get('isFlipped',False))
            joint=root.joints.add(joint_input)
            if spec.get('limits') and spec['kind']=='revolute':
                allowed_limits={'minimumValue','maximumValue','restValue','isMinimumValueEnabled',
                    'isMaximumValueEnabled','isRestValueEnabled'}
                if not isinstance(spec['limits'],dict) or set(spec['limits'])!=allowed_limits:
                    raise ValueError('Fixture revolute limits require explicit values and all enabled flags')
                if any(type(spec['limits'][key]) is not float and type(spec['limits'][key]) is not int
                       for key in ('minimumValue','maximumValue','restValue')) or \
                        any(type(spec['limits'][key]) is not bool for key in
                            ('isMinimumValueEnabled','isMaximumValueEnabled','isRestValueEnabled')):
                    raise ValueError('Fixture revolute limit values/flags have invalid types')
                limits_data=spec['limits']
                if not all(math.isfinite(float(limits_data[key])) for key in ('minimumValue','maximumValue','restValue')) or \
                        limits_data['minimumValue']>limits_data['maximumValue'] or \
                        limits_data['isMinimumValueEnabled'] and limits_data['restValue']<limits_data['minimumValue'] or \
                        limits_data['isMaximumValueEnabled'] and limits_data['restValue']>limits_data['maximumValue']:
                    raise ValueError('Fixture revolute limits are inconsistent')
                limits=joint.jointMotion.rotationLimits
                for key,value in spec['limits'].items():setattr(limits,key,value)
                if any(abs(float(getattr(limits,key))-value)>1e-4 if key in
                       ('minimumValue','maximumValue','restValue') else getattr(limits,key)!=value
                       for key,value in spec['limits'].items()):
                    raise RuntimeError('Fixture revolute stored limits failed native readback')
        if joint is None or int(joint.healthState)!=0:
            raise RuntimeError('Fixture boundary joint failed native health validation')
        if 'rotationValue' in spec:
            joint.jointMotion.rotationValue=float(spec['rotationValue'])
            nominal_readbacks.append((joint,float(spec['rotationValue'])))
        joint.name=spec['id']
        item_ids={row['name']:row['itemId'] for row in created}
        endpoints=[]
        for component_name,component_occurrence,instance_index,item_key,origin_name in (
                (spec['one'],one_occurrence,one_index,'oneItemId',spec['id']+'_one'),
                (spec['two'],two_occurrence,two_index,'twoItemId',spec['id']+'_two')):
            endpoint={}
            item_id=spec.get(item_key)
            if item_id is not None:
                if not isinstance(item_id,str) or not item_id or item_id not in item_ids.values():
                    raise ValueError(item_key+' must identify an externalization item in this fixture')
                endpoint.update(itemId=item_id,instanceIndex=instance_index)
            else:
                endpoint['occurrence']=occurrence_ref(component_occurrence)
            if spec['kind']!='asBuiltRigid':endpoint['originName']=origin_name
            endpoints.append(endpoint)
        joint_ref=FMCAD._context.ref(joint)
        boundary_results.append({'id':spec['id'],'joint':joint_ref,'endpoints':endpoints})

    if design.snapshots.hasPendingSnapshot:
        if not design.snapshots.add():raise RuntimeError('Fixture nominal position snapshot was not captured')
    if not design.computeAll():
        raise RuntimeError('Fixture baseline recompute failed')
    if any(abs(joint.jointMotion.rotationValue-wanted)>1e-9 for joint,wanted in nominal_readbacks):
        raise RuntimeError('Fixture nonzero nominal rotation failed post-compute readback')
    for row in created:
        for observation,occurrence in zip(row['instances'],native_occurrences[row['name']]):
            observation['transform']=list(occurrence.transform2.asArray())
    health = FMCAD.call('history.check', {})
    if health.get('status') != 'pass' or health.get('healthy') is not True:
        raise RuntimeError('Fixture baseline native history is unhealthy')
    return {'role': role, 'document': FMCAD.doc.name, 'identity': {
        'creationId': FMCAD.doc.creationId, 'fileId': FMCAD.doc.dataFile.id if FMCAD.doc.dataFile else None,
        'version': int(FMCAD.doc.dataFile.versionNumber) if FMCAD.doc.dataFile else None,
        'projectId': FMCAD.doc.dataFile.parentProject.id if FMCAD.doc.dataFile else None,
        'folderId': FMCAD.doc.dataFile.parentFolder.id if FMCAD.doc.dataFile else None},
        'driver': None if driver is None else {'name': driver.name, 'expression': driver.expression,
            'unit': driver.unit, 'favorite': bool(driver.isFavorite)},
        'components': created, 'boundaries':boundary_results, 'history': health}
