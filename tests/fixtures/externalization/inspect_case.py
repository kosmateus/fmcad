"""Read-only identity, history, geometry, joints and metadata snapshot for a case."""
ARGS = []
DOC_NAME = ''


def assert_boundary_snapshot(actual, expected, linear_tolerance, angular_tolerance):
    """Fixture assertion against caller-captured, explicitly mapped source joints."""
    import math
    if not isinstance(expected,list) or not expected:
        raise ValueError('Expected boundary snapshot must be nonempty')
    if not all(math.isfinite(v) and v>=0 for v in (linear_tolerance,angular_tolerance)):
        raise ValueError('Boundary comparison needs finite explicit tolerances')
    names=[row['name'] for row in expected]
    assert len(names)==len(set(names)) and len(actual)==len(expected), 'Boundary inventory differs'
    for before in expected:
        assert before['collection'] in ('joints','asBuiltJoints') and before['motionType'] in (0,1), 'Unsupported fixture boundary form or DOF'
        assert before['collection']!='asBuiltJoints' or before['motionType']==0, 'Unsupported as-built revolute fixture'
        matches=[row for row in actual if row['name']==before['name']]
        assert len(matches)==1, 'Boundary identity is absent or ambiguous'
        after=matches[0]
        assert after['healthState']==0, 'Boundary health differs'
        for key in ('collection','motionType','endpoints'):
            assert after[key]==before[key], 'Boundary '+key+' differs'
        assert sorted(tuple(a) for a in after['attributes'])==sorted(tuple(a) for a in before['attributes']), 'Boundary attributes differ'
        if before['collection']=='joints':
            for key in ('angle','offset','isFlipped','originTypes'):
                assert after[key]==before[key], 'Boundary '+key+' differs'
            assert before['originTypes']==['adsk::fusion::JointOrigin']*2, 'Fixture requires captured JointOrigin frames'
            assert len(before['originFrames'])==len(after['originFrames'])==2
            for a,b in zip(before['originFrames'],after['originFrames']):
                assert isinstance(a,list) and isinstance(b,list) and len(a)==len(b)==16 and all(math.isfinite(v) for v in a+b), 'Boundary origin frame coverage differs'
                translation=math.sqrt(sum((a[i]-b[i])**2 for i in (3,7,11)))
                trace=sum(a[i]*b[i] for i in (0,1,2,4,5,6,8,9,10))
                rotation=math.acos(max(-1,min(1,(trace-1)/2)))
                assert translation<=linear_tolerance and rotation<=angular_tolerance, 'Boundary origin frame differs'
        if before['motionType']==1:
            assert after['rotationAxis']==before['rotationAxis'], 'Revolute axis differs'
            assert abs(after['rotationValue']-before['rotationValue'])<=angular_tolerance, 'Revolute nominal differs'
            for key in ('minimumValue','maximumValue','restValue'):
                assert abs(after['rotationLimits'][key]-before['rotationLimits'][key])<=angular_tolerance, 'Stored revolute limit differs'
            for key in ('isMinimumValueEnabled','isMaximumValueEnabled','isRestValueEnabled'):
                assert after['rotationLimits'][key]==before['rotationLimits'][key], 'Revolute enabled flag differs'


def assert_group_feature_snapshot(actual, expected):
    """Feature-row proof only; the separate physical driver/restore probe is mandatory."""
    if not isinstance(expected,list) or not expected:
        raise ValueError('Expected grouped feature snapshot must be nonempty')
    owners={row['component'] for row in expected}
    observed=[row for row in actual if row['component'] in owners]
    assert len(observed)==len(expected), 'Grouped native feature inventory differs'
    identities=[(row['component'],row['name']) for row in expected]
    assert len(identities)==len(set(identities)), 'Expected grouped feature identity is ambiguous'
    for before in expected:
        matches=[row for row in observed if (row['component'],row['name'])==(before['component'],before['name'])]
        assert len(matches)==1, 'Grouped native feature absent or ambiguous'
        after=matches[0]
        assert after['healthState']==0 and after['isSuppressed'] is False, 'Grouped native history unhealthy'
        for key in ('type','parameters','isSuppressed'):
            assert after[key]==before[key], 'Grouped native '+key+' differs'


def run(_context):
    if not isinstance(ARGS,dict) or set(ARGS)-{'projectId','folderId','fileId','version','creationId','compact',
            'expectedBoundaries','linearTolerance','angularTolerance','expectedGroupFeatures'} or \
            not {'projectId','folderId','fileId','version','creationId'}.issubset(ARGS) or \
            not all(isinstance(ARGS[key],str) and ARGS[key] for key in ('projectId','folderId','fileId','creationId')) or \
            type(ARGS['version']) is not int or ARGS['version']<1:
        raise ValueError('Readback requires the exact owned project/folder/file/version/creationId pin')
    design = FMCAD.design
    root = FMCAD.root
    document = FMCAD.doc
    data_file = document.dataFile
    if data_file is None or document.creationId!=ARGS['creationId'] or data_file.id!=ARGS['fileId'] or \
            int(data_file.versionNumber)!=ARGS['version'] or data_file.parentProject.id!=ARGS['projectId'] or \
            data_file.parentFolder.id!=ARGS['folderId']:
        raise ValueError('Readback document differs from the exact owned fixture pin')
    components = [root]
    for occurrence in root.allOccurrences:
        if occurrence.component not in components:
            components.append(occurrence.component)

    def attributes(entity):
        return sorted((a.groupName,a.name,a.value) for a in entity.attributes)

    bodies = []
    for component in components:
        for body in component.bRepBodies:
            bounds = body.boundingBox
            bodies.append({'token': str(body.entityToken), 'componentToken': str(component.entityToken),
                'component': str(component.name), 'name': str(body.name),
                'isSolid': bool(body.isSolid), 'volumeCm3': float(body.volume),
                'faces': int(body.faces.count), 'edges': int(body.edges.count),
                'boundsCm': [[float(bounds.minPoint.x),float(bounds.minPoint.y),float(bounds.minPoint.z)],
                             [float(bounds.maxPoint.x),float(bounds.maxPoint.y),float(bounds.maxPoint.z)]],
                'materialId': body.material.id if body.material else None,
                'attributes': attributes(body)})
    features = [{'component': str(component.name), 'name': str(feature.name),
        'type': str(feature.objectType), 'healthState': int(feature.healthState),
        'isSuppressed': bool(feature.isSuppressed), 'message': str(feature.errorOrWarningMessage),
        'parameters': [{'name': str(p.name), 'expression': str(p.expression), 'unit': str(p.unit)}
                       for p in feature.parameters] if hasattr(feature,'parameters') else None}
        for component in components for feature in component.features]
    sketches = [{'component': str(component.name), 'name': str(sketch.name),
        'fullyConstrained': bool(sketch.isFullyConstrained), 'curves': int(sketch.sketchCurves.count),
        'constraints': int(sketch.geometricConstraints.count), 'dimensions': int(sketch.sketchDimensions.count)}
        for component in components for sketch in component.sketches]
    occurrences = []
    for occurrence in root.allOccurrences:
        native = getattr(occurrence,'nativeObject',None) or occurrence
        reference = occurrence.documentReference if occurrence.isReferencedComponent else None
        occurrences.append({'path': str(occurrence.fullPathName),
            'component': str(occurrence.component.name), 'definitionToken': str(occurrence.component.entityToken),
            'referencedFileId': reference.dataFile.id if reference else None,
            'referencedVersion': int(reference.version) if reference else None,
            'isReferencedComponent': bool(occurrence.isReferencedComponent), 'isDerived': bool(occurrence.isDerived),
            'isGrounded': bool(occurrence.isGrounded), 'isGroundToParent': bool(occurrence.isGroundToParent),
            'worldPose': list(occurrence.transform2.asArray()), 'attributes': attributes(occurrence),
            'nativeAttributes': attributes(native), 'componentAttributes': attributes(occurrence.component)})
    joints = []
    for component in components:
        for collection_name in ('joints','asBuiltJoints'):
            for joint in getattr(component,collection_name):
                row={'ref': FMCAD._context.ref(joint), 'owner': str(component.name),
                    'collection': collection_name, 'name': str(joint.name),
                    'type': str(joint.objectType), 'healthState': int(joint.healthState),
                    'motionType': int(joint.jointMotion.jointType),
                    'endpoints': [o.fullPathName if o else None for o in
                        (joint.occurrenceOne,joint.occurrenceTwo)], 'attributes': attributes(joint)}
                for field in ('angle','offset'):
                    if hasattr(joint,field): row[field]=str(getattr(joint,field).expression)
                if collection_name=='joints':
                    row['isFlipped']=bool(joint.isFlipped)
                    origins=[joint.geometryOrOriginOne,joint.geometryOrOriginTwo]
                    row['originTypes']=[origin.objectType for origin in origins]
                    row['originFrames']=[list((getattr(origin,'nativeObject',None) or origin).transform.asArray())
                        if origin.objectType=='adsk::fusion::JointOrigin' else None for origin in origins]
                if int(joint.jointMotion.jointType)==1:
                    motion=joint.jointMotion
                    limits=motion.rotationLimits
                    row['rotationAxis']=int(motion.rotationAxis)
                    row['rotationValue']=float(motion.rotationValue)
                    row['rotationLimits']={key:getattr(limits,key) for key in
                        ('minimumValue','maximumValue','restValue','isMinimumValueEnabled','isMaximumValueEnabled','isRestValueEnabled')}
                joints.append(row)
    boundary_verified=None
    if 'expectedBoundaries' in ARGS:
        if not all(isinstance(ARGS.get(key),str) and ARGS[key] for key in ('linearTolerance','angularTolerance')):
            raise ValueError('Expected boundaries require explicit linearTolerance/angularTolerance')
        assert_boundary_snapshot(joints,ARGS['expectedBoundaries'],FMCAD.length(ARGS['linearTolerance']),FMCAD.angle(ARGS['angularTolerance']))
        boundary_verified=True
    group_features_verified=None
    if 'expectedGroupFeatures' in ARGS:
        assert_group_feature_snapshot(features,ARGS['expectedGroupFeatures'])
        group_features_verified=True
    health = FMCAD.call('history.check', {})
    if ARGS.get('compact') is True:
        return {'identity': {'creationId': document.creationId, 'fileId': data_file.id,
                'version': int(data_file.versionNumber), 'projectId': data_file.parentProject.id,
                'folderId': data_file.parentFolder.id, 'isComplete': bool(data_file.isComplete),
                'isReadOnly': bool(data_file.isReadOnly), 'isModified': bool(document.isModified)},
            'timeline': {'markerPosition': int(design.timeline.markerPosition), 'count': int(design.timeline.count)},
            'health': {'healthy': health.get('healthy'), 'status': health.get('status')},
            'bodies': [{'token': row['token'], 'componentToken': row['componentToken'],
                'component': row['component'], 'name': row['name'], 'isSolid': row['isSolid'],
                'volumeCm3': row['volumeCm3'], 'materialId': row['materialId']} for row in bodies],
            'occurrences': [{'ref': {'token': str(o.entityToken), 'kind': 'occurrence',
                'path': str(o.fullPathName)}, 'path': str(o.fullPathName),
                'component': str(o.component.name), 'definitionToken': str(o.component.entityToken),
                'referencedFileId': o.documentReference.dataFile.id if o.isReferencedComponent else None,
                'referencedVersion': int(o.documentReference.version) if o.isReferencedComponent else None,
                'worldPose': list(o.transform2.asArray())}
                for o in root.allOccurrences],
            'joints': [{'ref': row['ref'], 'owner': row['owner'],
                'collection': row['collection'], 'name': row['name'],
                'motionType': row['motionType'], 'endpoints': row['endpoints'],
                 **{key: row[key] for key in ('angle','offset','isFlipped','originTypes','originFrames','rotationAxis','rotationValue','rotationLimits')
                   if key in row}} for row in joints],
            'parameters': [{'name': p.name, 'expression': p.expression,
                'unit': p.unit, 'value': float(p.value), 'isFavorite': bool(p.isFavorite)}
                for p in design.userParameters],
            'derivedParameters': [{'name': p.name, 'expression': p.expression,
                'unit': p.unit, 'value': float(p.value)} for p in design.derivedParameters],
            'boundarySnapshotVerified':boundary_verified,'groupFeatureSnapshotVerified':group_features_verified,'readOnlyObservation': True}
    return {'document': document.name,
        'identity': {'creationId': document.creationId, 'fileId': data_file.id if data_file else None,
            'version': int(data_file.versionNumber) if data_file else None,
            'projectId': data_file.parentProject.id if data_file else None,
            'folderId': data_file.parentFolder.id if data_file else None,
            'isComplete': bool(data_file.isComplete) if data_file else None,
            'isReadOnly': bool(data_file.isReadOnly) if data_file else None,
            'isModified': bool(document.isModified)},
        'timeline': {'markerPosition': int(design.timeline.markerPosition), 'count': int(design.timeline.count)},
        'health': health, 'bodies': bodies, 'features': features, 'sketches': sketches,
        'occurrences': occurrences, 'joints': joints,
        'parameters': [{'name': str(parameter.name), 'expression': str(parameter.expression),
            'unit': str(parameter.unit), 'value': float(parameter.value), 'isFavorite': bool(parameter.isFavorite)}
            for parameter in design.userParameters],
        'derivedParameters': [{'name': str(parameter.name), 'expression': str(parameter.expression),
            'unit': str(parameter.unit), 'value': float(parameter.value)} for parameter in design.derivedParameters],
        'boundarySnapshotVerified':boundary_verified,'groupFeatureSnapshotVerified':group_features_verified,'readOnlyObservation': True}
