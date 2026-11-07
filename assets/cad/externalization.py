"""Native external-effect primitives. No undo, model replay or cloud deletion."""
import hashlib
import json
import math
import os
import sys
import time
import types

_EXTERNAL_PROBE_RESTORE_RESERVE_MS = 60000


class _ExternalTimelineRestoreError(RuntimeError):
    pass


def _external_require(value, message):
    if not value:
        raise ValueError(message)
    return value


def _external_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _external_folder(app, destination):
    project = _cad_unique([p for p in _references_items(app.data.dataProjects)
                           if p.id == destination['projectId']], 'destination project')
    pending, found, seen = [project.rootFolder], [], set()
    while pending:
        folder = pending.pop()
        if folder.id in seen: continue
        seen.add(folder.id)
        if folder.id == destination['folderId']: found.append(folder)
        pending.extend(_references_items(folder.dataFolders))
    return _cad_unique(found, 'exact destination folder')


def _external_collision(folder, name):
    _external_require(not any(f.name == name for f in _references_items(folder.dataFiles)),
                      'Declared new filename already exists; no overwrite/name-only reuse')


def _external_refresh_complete(file):
    if file.isComplete is True:return True
    file.refresh(None)
    return False


def _external_document(app, pin, allow_open=False, readonly=False, editable=False):
    candidates = []
    for doc in _references_items(app.documents):
        file = getattr(doc, 'dataFile', None)
        if file is None or file.id != pin['fileId'] or file.parentProject.id != pin['projectId']: continue
        if file.versionNumber != pin['version']: continue
        if pin.get('creationId') and doc.creationId != pin['creationId']: continue
        top = None
        try: doc.allDocumentReferences.count; top = True
        except RuntimeError as error:
            if 'non-top-level document' in str(error): top = False
            else: raise
        candidates.append((doc, top))
    if pin.get('context')=='topLevel':
        candidates = [(d,t) for d,t in candidates if t is True]
    if len(candidates) > 1:
        return None, {'status':'ambiguous','candidates':[_references_document_identity(d) for d,t in candidates]}
    if candidates:
        doc = candidates[0][0]
        if editable and doc.dataFile.isReadOnly:
            return None, {'status':'blocked','reason':'editableOwnerUnavailable'}
        if not editable or candidates[0][1]:
            return doc, {'status':'resolved','identity':_references_document_identity(doc),'lifecycleEffects':[]}
    if not allow_open or readonly:
        return None, {'status':'unavailable','reason':'exactPinnedDocumentNotLoaded','lifecycleEffects':[]}
    file = _references_project_file(app, pin['projectId'], pin['fileId'], pin['version'])
    if not _external_refresh_complete(file):
        return None, {'status':'pendingPublication','reason':'pinnedSourceIncomplete','lifecycleEffects':[]}
    if editable and file.isReadOnly:
        return None, {'status':'blocked','reason':'editableOwnerUnavailable','lifecycleEffects':[]}
    doc = _cad_require_result(app.documents.open(file, True), 'Open exact owned pinned source')
    actual = _references_document_identity(doc)
    _external_require(actual['fileId'] == pin['fileId'] and actual['version'] == pin['version'] and
                      actual['projectId'] == pin['projectId'], 'Opened document differs from exact pin')
    lifecycle=[{'action':'opened','docid':doc.creationId,'openedByOperation':True,'identity':actual}]
    try:doc.allDocumentReferences.count;top_level=True
    except RuntimeError as error:
        if 'non-top-level document' in str(error):top_level=False
        else:raise
    if (editable or pin.get('context')=='topLevel') and not top_level:
        return None, {'status':'blocked','reason':'openedPinnedDocumentIsNotTopLevel','identity':actual,
                      'lifecycleEffects':lifecycle}
    if editable and doc.dataFile.isReadOnly:
        return None, {'status':'blocked','reason':'editableOwnerUnavailable','identity':actual,
                      'lifecycleEffects':lifecycle}
    return doc, {'status':'resolved','identity':actual,'lifecycleEffects':lifecycle}


def _external_ctx(doc):
    return CadContext(doc.name, project_id=doc.dataFile.parentProject.id if doc.dataFile else None,
                      doc_id=doc.creationId, doc_file_id=doc.dataFile.id if doc.dataFile else None, resolved_doc=doc)


def _external_owned_document(runtime,pin):
    # Reuse an actual handle already qualified and captured by this operation,
    # not a fresh guess between an editor and same-file reference buffers.
    pool=[entry.get('targetDoc') for entry in runtime['items'].values()]
    pool.extend([runtime['source'].doc, runtime['target'].doc if runtime['target'] else None])
    found=[]
    for doc in pool:
        if doc is None or not doc.isValid or doc in found:continue
        file=doc.dataFile
        if file is None or file.id!=pin['fileId'] or file.parentProject.id!=pin['projectId'] or file.versionNumber!=pin['version']:continue
        if pin.get('creationId') and doc.creationId!=pin['creationId']:continue
        doc.allDocumentReferences.count
        found.append(doc)
    if len(found)==1:return found[0],{'status':'resolved','identity':_references_document_identity(found[0]),'lifecycleEffects':[]}
    if len(found)>1:return None,{'status':'ambiguous','candidates':[_references_document_identity(d) for d in found],'lifecycleEffects':[]}
    return _external_document(runtime['source'].app,pin,allow_open=True,editable=False)


def _external_pin(file, creation=None):
    return {'fileId':file.id,'projectId':file.parentProject.id,'version':int(file.versionNumber),
            **({'creationId':creation} if creation else {})}


def _external_occurrence(ctx, ref):
    try:
        entity = ctx.resolve(ref, 'occurrence')
    except Exception:
        # Fusion can return a fresh exact token that findEntityByToken does not
        # resolve in a later RPC. Reconcile only inside the pinned root context.
        token = ref.get('token') if isinstance(ref, dict) else None
        _external_require(isinstance(token, str) and token,
                          'Unresolved occurrence has no exact native token')
        component_ref = ref.get('component') if isinstance(ref, dict) else None
        component_token = component_ref.get('token') if isinstance(component_ref, dict) else None
        path = ref.get('path') if isinstance(ref, dict) else None
        candidates = [o for o in _references_items(ctx.root.allOccurrences)
                      if (str(o.entityToken) == token or
                          (path and component_token and o.fullPathName == path and
                           str(o.component.entityToken) == component_token)) and
                      (not path or o.fullPathName == path) and
                      (not component_token or str(o.component.entityToken) == component_token)]
        entity = _cad_unique(candidates, 'Exact root-context occurrence token/path')
    native = getattr(entity, 'nativeObject', None) or entity
    matches = [o for o in _references_items(ctx.root.allOccurrences)
               if (getattr(o, 'nativeObject', None) or o) == native]
    path = ref.get('path') if isinstance(ref, dict) else None
    if path: matches = [o for o in matches if o.fullPathName == path]
    elif getattr(entity, 'assemblyContext', None) is not None:
        matches = [o for o in matches if o.fullPathName == entity.fullPathName]
    return _cad_unique(matches, 'root-context externalization occurrence')


def _external_joint(ctx, ref):
    try:
        return ctx.resolve(ref)
    except Exception:
        token = ref.get('token') if isinstance(ref, dict) else None
        _external_require(isinstance(token, str) and token,
                          'Unresolved boundary joint has no exact native token')
        candidates = [joint for component in _references_own_components(ctx.root)
                      for collection in (component.joints, component.asBuiltJoints)
                      for joint in _references_items(collection)
                      if str(joint.entityToken) == token]
        return _cad_unique(candidates, 'Exact native boundary-joint token')


def _external_disjoint_instances(instances, authorized_paths):
    result=[];seen=set()
    for occurrence in instances:
        path=occurrence.fullPathName
        if path in seen:continue
        _external_require(not any(path==prior or path.startswith(prior+'+') or prior.startswith(path+'+')
                                  for prior in authorized_paths),
                          'Expanded instancePolicy overlaps another authorized extraction scope')
        seen.add(path);authorized_paths.append(path);result.append(occurrence)
    return result


def _external_destination(ctx, data):
    target = data.get('destination', 'root')
    parent_occ = None if target == 'root' else _assembly_root_occurrence(ctx, target)
    parent = ctx.root if parent_occ is None else parent_occ.component
    paths = [''] if parent_occ is None else _assembly_paths(ctx, parent)
    _external_require(len(paths) == 1 or data.get('sharedParentPolicy', 'reject') == 'allInstances',
                      'Repeated destination requires sharedParentPolicy:allInstances')
    _external_require('placementSpace' not in data or 'placement' in data, 'placementSpace without placement')
    if parent_occ is not None and 'placement' in data:
        _external_require(data.get('placementSpace') in ('root','parent'), 'Nested placement needs placementSpace')
    matrix = _assembly_matrix(ctx, data.get('placement', {}))
    if parent_occ is not None and data.get('placementSpace') == 'root':
        matrix = _entity_matrix(_entity_multiply(_entity_inverse(_entity_occurrence_matrix(ctx, parent_occ)), matrix.asArray()))
    return parent, parent_occ, matrix, paths


def _external_insert_reconcile(ctx,file,parent_paths,before_tokens):
    occurrences=_references_items(ctx.root.allOccurrences)
    matched=[];candidates=[]
    for parent_path in parent_paths:
        rows=[]
        for occurrence in occurrences:
            if occurrence.entityToken in before_tokens or not occurrence.isReferencedComponent:continue
            parent=occurrence.fullPathName.rsplit('+',1)[0] if '+' in occurrence.fullPathName else ''
            if parent!=parent_path:continue
            ref=occurrence.documentReference
            if ref.dataFile.id==file.id and ref.dataFile.versionNumber==file.versionNumber:rows.append(occurrence)
        candidates.extend(rows)
        if len(rows)!=1:return {'status':'unresolved','occurrences':candidates}
        matched.append(rows[0])
    return {'status':'matched','occurrences':matched}


def _external_insert_delta(ctx,parent_paths,local):
    if parent_paths==['']:return local
    parent=_external_destination_parent(ctx,parent_paths[0])
    world=list(_entity_occurrence_matrix(ctx,parent))
    # addByInsert applies a root-space delta to the parent's placement, unlike
    # addNewComponent's parent-space initial transform. Keep the public plan in
    # parent space and convert only at this native call boundary.
    values=_entity_multiply(_entity_multiply(world,list(local.asArray())),_entity_inverse(world))
    result=adsk.core.Matrix3D.create()
    _external_require(result.setWithArray(values),'Native insertion delta matrix rejected')
    return result


def _external_insert(ctx, data, project_id=None, native_matrix=None):
    _cad_fields(data, ('source','confirm'), ('destination','placement','placementSpace','name','sharedParentPolicy'))
    ctx.require_confirm(data)
    _cad_fields(data['source'], ('dataFileId','version'))
    version = data['source']['version']
    _external_require(type(version) is int and version > 0, 'source.version must be a positive exact version')
    project_id = project_id or getattr(getattr(getattr(ctx.doc,'dataFile',None),'parentProject',None),'id',None)
    _external_require(project_id, 'Saved destination or explicit compose destination project required')
    file = _references_project_file(ctx.app, project_id, data['source']['dataFileId'], version)
    _external_require(file.isComplete, 'Source is not cloud complete')
    _external_require(not ctx.doc.dataFile or file.id != ctx.doc.dataFile.id, 'External reference cycle')
    parent, parent_occ, matrix, parent_paths = _external_destination(ctx,data)
    if native_matrix is not None or isinstance(matrix,(list,tuple)):
        values=native_matrix if native_matrix is not None else matrix
        matrix=adsk.core.Matrix3D.create()
        _cad_require_result(matrix.setWithArray(values),'Set exact external insertion transform')
    _assembly_capture_ready(ctx)
    # Native authoritative forward graph, not childReferences, proves no cycle.
    graph = _references_collect_graph({'root':_external_pin(file),'policy':'preserve','lifecycle':'openOwned',
                                       'allowedProjectIds':[project_id]})
    _external_require(graph['graphComplete'], 'Source graph unavailable; cannot prove insertion cycle safety')
    _external_require(all(e.get('scopeProjectAllowed') is True for e in graph.get('edges',[])),
                      'Source graph has out-of-project edges; insertion cycle coverage is incomplete')
    if ctx.doc.dataFile:
        _external_require(all(d['fileId'] != ctx.doc.dataFile.id for d in graph['documents']), 'External reference cycle')
    activation_effects=_external_activate(ctx)
    before_tokens={o.entityToken for o in _references_items(ctx.root.allOccurrences)}
    local_matrix=list(matrix.asArray())
    matrix=_external_insert_delta(ctx,parent_paths,matrix)
    reconciled=False
    try:
        occurrence = _cad_require_result(parent.occurrences.addByInsert(file,matrix,True), 'Native external insertion')
    except Exception as error:
        observation=_external_insert_reconcile(ctx,file,parent_paths,before_tokens)
        if observation['status']!='matched':
            return {'status':'unknown','partial':bool(observation['occurrences']),'noReplay':True,
                    'reason':'Native insertion raised and exact new target contexts could not be uniquely reconciled: '+
                            type(error).__name__+': '+str(error),
                    'observedCandidates':[ctx.ref(o) for o in observation['occurrences']],
                    'lifecycleEffects':[*(graph.get('lifecycleEffects',[])),*activation_effects]}
        occurrence=observation['occurrences'][0];reconciled=True
    try:
        ref = occurrence.documentReference
        if ref.dataFile.versionNumber != version:
            ref.version = version
        _external_require(ref.dataFile.id == file.id and ref.dataFile.versionNumber == version and occurrence.isReferencedComponent,
                          'Inserted native reference differs from requested exact pin')
        if data.get('name'): occurrence.name = data['name']
        native = getattr(occurrence,'nativeObject',None) or occurrence
        actual = [o for o in _references_items(ctx.root.allOccurrences) if (getattr(o,'nativeObject',None) or o) == native]
        _external_require(len(actual)==len(parent_paths), 'Inserted occurrence context coverage mismatch')
        return {'status':'complete','occurrences':[ctx.ref(o) for o in actual],
                'paths':[o.fullPathName for o in actual], 'fileId':file.id,'version':version,
                 'worldPoses':[list(_entity_occurrence_matrix(ctx,o)) for o in actual],
                 'parentLocalMatrix':local_matrix,'nativeInsertDelta':list(matrix.asArray()),
                'isReferencedComponent':True,'lifecycleEffects':[*(graph.get('lifecycleEffects',[])),*activation_effects],
                'reconciledAfterException':reconciled}
    except Exception as error:
        return {'status':'failed','retainedOccurrence':ctx.ref(occurrence),'partial':True,
                'reason':str(error),'noReplay':True,
                'lifecycleEffects':[*(graph.get('lifecycleEffects',[])),*activation_effects]}


def _external_attributes(entity):
    return sorted((a.groupName,a.name,a.value) for a in _references_items(entity.attributes))


def _external_parent_namespace_values(ctx,parent_occurrence,declarations):
    if not declarations:return []
    owner=parent_occurrence if parent_occurrence is not None else ctx.root
    attributes={(group,name):value for group,name,value in _external_attributes(owner)}
    result=[]
    for declaration in declarations:
        values=[]
        for name in declaration['keys']:
            key=(declaration['group'],name)
            _external_require(key in attributes,'Caller identity attribute is missing from the exact parent context')
            values.append((name,attributes[key]))
        result.append({'group':declaration['group'],'values':values})
    return result


def _external_parent_context_match(source_ctx,target_ctx,target_parent,source_instance):
    target_token=target_parent.entityToken if target_parent is not None else None
    same_document=(source_ctx.doc.creationId==target_ctx.doc.creationId and
                   source_ctx.doc.dataFile.id==target_ctx.doc.dataFile.id)
    if same_document and source_instance.get('parentToken')==target_token:return True
    declarations=source_instance.get('callerNamespaceSpecs',[])
    if not declarations:return False
    try:
        return _external_parent_namespace_values(target_ctx,target_parent,declarations)==source_instance.get('callerNamespaces')
    except Exception:
        return False


def _external_destination_parent(ctx,path):
    if not path:return None
    return _cad_unique([o for o in _references_items(ctx.root.allOccurrences) if o.fullPathName==path],
                       'exact destination parent context')


def _external_stage_insert_plan(ctx,source_ctx,spec,mapping,index,tolerance):
    destination=spec.get('destinationOccurrence','root')
    destination_data={'destination':destination,'sharedParentPolicy':spec.get('sharedParentPolicy','reject')}
    if spec.get('placement') is not None:
        destination_data.update(placement=spec['placement'],placementSpace=spec.get('placementSpace'))
    parent,parent_occ,base_matrix,parent_paths=_external_destination(ctx,destination_data)
    parents=[(path,_external_destination_parent(ctx,path)) for path in parent_paths]
    source_by_parent={}
    if mapping and len(parent_paths)>1 and len(mapping)>1:
        _external_require(len(mapping)==len(parent_paths),
                          'Repeated destination mapping requires one explicit source context per target parent')
        used=set()
        for path,target_parent in parents:
            candidates=[i for i,row in enumerate(mapping)
                if _external_parent_context_match(source_ctx,ctx,target_parent,row)]
            _external_require(len(candidates)==1 and candidates[0] not in used,
                              'Repeated destination parents require unique callerNamespaces or same-document parent identity')
            source_by_parent[path]=candidates[0];used.add(candidates[0])
        _external_require(len(used)==len(mapping),'Repeated destination mapping did not cover every selected source context')
    elif mapping and len(mapping)>1 and index>=len(mapping):
        _external_require(False,'Selected source instance mapping is exhausted')
    elif mapping and len(mapping)>1 and len(parent_paths)==1:
        source_by_parent[parent_paths[0]]=index
    elif mapping:
        source_by_parent.update((path,0) for path in parent_paths)

    placement=spec.get('placement')
    placement_world=_assembly_matrix(ctx,placement).asArray() if placement is not None else None
    local_matrices=[];expected_world={}
    for path,target_parent in parents:
        parent_world=list(_entity_occurrence_matrix(ctx,target_parent)) if target_parent is not None else list(adsk.core.Matrix3D.create().asArray())
        if mapping and placement is None:
            row=mapping[source_by_parent[path]]
            local=_entity_multiply(_entity_inverse(parent_world),row['worldPose'])
        elif placement is not None and spec.get('placementSpace')=='root' and target_parent is not None:
            local=_entity_multiply(_entity_inverse(parent_world),placement_world)
        else:
            local=list(base_matrix.asArray())
        local_matrices.append((path,local,parent_world))
    _external_require(bool(local_matrices),'Destination has no authorized parent contexts')
    chosen=local_matrices[0][1]
    for path,local,parent_world in local_matrices[1:]:
        linear,angular=_measure_pose_delta(chosen,local)
        _external_require(linear<=tolerance['linear'] and angular<=tolerance['angular'],
                          'Shared destination contexts need different local transforms; explicit partitioning is required')
    for path,local,parent_world in local_matrices:
        expected_world[path]=_entity_multiply(parent_world,chosen)
    return {'destination':destination,'parent':parent,'parentOccurrence':parent_occ,'parentPaths':parent_paths,
            'matrix':_entity_matrix(chosen),'sourceByParent':source_by_parent,'expectedWorld':expected_world}


def _external_existing_derive(ctx,pin):
    matches=[]
    for feature in _references_items(ctx.root.features.deriveFeatures):
        if bool(feature.isSuppressed):continue
        try:
            reference=feature.documentReference
            source_file=reference.dataFile
            file_id=source_file.id
            try:version=int(reference.version)
            except RuntimeError:
                # Same conservative saved-forward-edge evidence used by .10.
                # A cold version getter error is not proof of a broken link.
                refs=list(_references_items(ctx.doc.documentReferences))
                for owner in _references_own_components(ctx.root):
                    for derive in _references_items(owner.features.deriveFeatures):
                        if not derive.isSuppressed and not any(r==derive.documentReference for r in refs):
                            refs.append(derive.documentReference)
                count=sum(r.dataFile.id==file_id for r in refs)
                evidence=_references_edge_version(ctx.doc,reference,file_id,count)
                version=evidence['baselineVersion']
                _external_require(type(version) is int,'Saved Derive version evidence is unresolved')
        except Exception as error:
            raise ValueError('Existing owned Derive identity is unresolved; refusing to create/reselect: '+
                             type(error).__name__+': '+str(error))
        if file_id!=pin['fileId']:continue
        if version!=pin['version']:
            raise ValueError('Existing owned Derive pins another source version; routine refresh belongs to references.refresh')
        matches.append(feature)
    _external_require(len(matches)<=1,'Ambiguous existing owned Derive for exact source pin')
    return matches[0] if matches else None


def _external_ensure_attributes(entity,attributes):
    for group,name,value in attributes:
        current=entity.attributes.itemByName(group,name)
        if current is not None:
            _external_require(current.value==value,'Existing native attribute differs from declared source metadata')
        else:entity.attributes.add(group,name,value)


def _external_joint_present(ctx,token):
    return any(joint.entityToken==token for component in _references_own_components(ctx.root)
        for collection in (component.joints,component.asBuiltJoints) for joint in _references_items(collection))


def _external_delete_joint_checkpoint(ctx,joint,token):
    error=None;returned=None
    try:returned=joint.deleteMe()
    except Exception as exc:error=type(exc).__name__+': '+str(exc)
    present=_external_joint_present(ctx,token)
    if not present:return {'status':'removed','reconciledAfterException':error is not None or returned is not True,
                          'submitError':error}
    return {'status':'retained','reconciledAfterException':False,'submitError':error,
            'reason':'Native joint delete was not observed; original remains present'}


def _external_occurrence_present(ctx,captured):
    return any(o.entityToken==captured['token'] or
        (o.fullPathName==captured['path'] and o.component.entityToken==captured['definition'])
        for o in _references_items(ctx.root.allOccurrences))


def _external_delete_occurrence_checkpoint(ctx,occurrence,captured):
    error=None;returned=None
    try:returned=occurrence.deleteMe()
    except Exception as exc:error=type(exc).__name__+': '+str(exc)
    if not _external_occurrence_present(ctx,captured):
        return {'status':'removed','reconciledAfterException':error is not None or returned is not True,
                'submitError':error}
    return {'status':'retained','reconciledAfterException':False,'submitError':error,
            'reason':'deleteMe returned/raised but the exact local occurrence still exists'}


def _external_parameter_reference(entity):
    attributes=getattr(entity,'attributes',None)
    return attributes is not None and any(a.groupName=='fmcad.externalization' and a.name=='role' and
        a.value=='declaredParameterReference' for a in _references_items(attributes))


def _external_physical_occurrences(component):
    rows=_references_items(component.allOccurrences)
    excluded=[o.fullPathName for o in rows if _external_parameter_reference(o)]
    return [o for o in rows if not any(o.fullPathName==p or o.fullPathName.startswith(p+'+') for p in excluded)]


def _external_native_features(component):
    return [f for f in _references_items(component.features) if not _external_parameter_reference(f)]


def _external_inventory(component):
    occurrences = _external_physical_occurrences(component)
    components = [component]
    for o in occurrences:
        if o.component not in components: components.append(o.component)
    return {'bodies':sum(c.bRepBodies.count for c in components),'occurrences':len(occurrences),
            'history':sum(len(_external_native_features(c)) + c.sketches.count for c in components)}


def _external_health(component):
    for c in [component]+[o.component for o in _references_items(component.allOccurrences)]:
        for f in _references_items(c.features):
            _external_require(not f.isSuppressed and f.healthState == adsk.fusion.FeatureHealthStates.HealthyFeatureHealthState,
                              'Unhealthy/suppressed native history requires explicit repair/grouping before installation')


def _external_feature_inputs(feature):
    kind=_cad_type(feature)
    if kind=='ExtrudeFeature':
        profile=feature.profile
        profiles=_references_items(profile) if hasattr(profile,'count') else [profile]
        return [p.parentSketch for p in profiles]
    if kind=='CombineFeature':return [feature.targetBody]+_references_items(feature.toolBodies)
    if kind in ('RectangularPatternFeature','CircularPatternFeature'):
        _external_require(hasattr(feature,'inputEntities'),'Pattern input coverage unavailable; explicit grouping/repair required')
        return _references_items(feature.inputEntities)
    if kind=='CutPasteBody':
        _external_require(hasattr(feature,'sourceBodies'),'CutPaste native source context unavailable; no automatic repair')
        return _references_items(feature.sourceBodies)
    if kind=='DeriveFeature':
        _external_require(feature.documentReference.dataFile is not None,'Unresolved external Derive input')
        return []
    raise ValueError('Unsupported native feature input coverage: '+str(kind))


def _external_input_owner(entity):
    native=getattr(entity,'nativeObject',None) or entity
    owner=getattr(native,'parentComponent',None)
    return owner if owner is not None else getattr(getattr(native,'body',None),'parentComponent',None)


def _external_feature_input_owners(feature,allow_timeline=False):
    try:return [_external_input_owner(e) for e in _external_feature_inputs(feature)]
    except RuntimeError as error:
        if not allow_timeline or _cad_type(feature)!='CombineFeature' or "Didn't roll editing feature back" not in str(error):raise
    # Combine input bodies are evaluated before their consuming feature. Capture
    # stable component owners there, then restore the exact caller marker.
    timeline=feature.parentComponent.parentDesign.timeline;marker=timeline.markerPosition
    try:
        _external_require(feature.timelineObject.rollTo(True),'Cannot inspect native Combine inputs before feature')
        return [_external_input_owner(e) for e in _external_feature_inputs(feature)]
    finally:
        try:
            timeline.markerPosition=marker
            _external_require(timeline.markerPosition==marker,'Combine input inspection failed to restore timeline marker')
        except Exception as error:
            raise _ExternalTimelineRestoreError(str(error)) from error


def _external_dependency_coverage(component, allowed,defer_combine=False,allow_timeline=False):
    components=[component]+[o.component for o in _references_items(component.allOccurrences)]
    owners=list(allowed)+components
    for owner in components:
        for feature in _references_items(owner.features):
            if defer_combine and _cad_type(feature)=='CombineFeature':continue
            for input_owner in _external_feature_input_owners(feature,allow_timeline):
                _external_require(input_owner in owners,'Cross-component dependency requires an explicit same-parent extraction group')


def _external_content_fingerprint(ctx):
    return _external_digest({'metadata':_references_metadata(ctx.design,ctx.root),
        'parameters':_references_parameters(ctx.design),'history':_external_history_signature(ctx.root),
        'joints':_external_internal_joints(ctx.root),
        'marker':ctx.design.timeline.markerPosition,'count':ctx.design.timeline.count})


def _external_fingerprint(ctx):
    if not ctx.doc.isValid:return 'closed-owned-editor'
    return _external_digest({'identity':_references_document_identity(ctx.doc),
                             'content':_external_content_fingerprint(ctx)})


def _external_inplace_save_is_settled(runtime):
    try:
        if not runtime.get('saveAttempted') or runtime.get('saveFileId') is None:return False
        ctx=runtime['source'];doc=ctx.doc;file=doc.dataFile
        return (file is not None and file.id==runtime['saveFileId'] and
            file.parentProject.id==runtime['saveProjectId'] and
            int(file.versionNumber)==int(runtime['saveBaseline'])+1 and file.isComplete is True and
            doc.creationId==runtime['saveCreationId'] and doc.isModified is False and
            _external_content_fingerprint(ctx)==runtime['saveContentFingerprint'])
    except Exception:return False


def _external_inplace_save_is_pending(runtime,data):
    try:
        if data['phase']!='finalize' or not runtime.get('saveAttempted'):return False
        entry=runtime['items'][data['itemId']]
        receipt=data['result']['byItem'][data['itemId']]['phaseResults']['finalize'].get('receipt') or {}
        checks=(len(entry['baseline']['bodies'])+1)*len(entry['staged'])
        if receipt.get('saveAccepted') is not True or receipt.get('cursor',0)<=checks+1:return False
        ctx=runtime['source'];doc=ctx.doc;file=doc.dataFile
        return (file is not None and file.id==runtime['saveFileId'] and file.parentProject.id==runtime['saveProjectId'] and
            doc.creationId==runtime['saveCreationId'] and int(file.versionNumber) in
                (int(runtime['saveBaseline']),int(runtime['saveBaseline'])+1) and
            _external_content_fingerprint(ctx)==runtime['saveContentFingerprint'])
    except Exception:return False


def _external_probe_refresh_checkpoint(runtime,data):
    """Allow only the pinned .10 driver-refresh checkpoint that this probe submitted."""
    try:
        if data.get('phase')!='verify:assembly':return False
        item_id=data['itemId']
        probes=[p for p in data['manifest'].get('probes',[]) if p['itemId']==item_id and
                p.get('scope','assembly')=='assembly']
        if len(probes)!=1:return False
        probe=probes[0];state=runtime.get('probes',{}).get(probe['probeId'])
        if state is None:return False
        ctx=runtime['target'] or runtime['source'];doc=ctx.doc;file=doc.dataFile
        if state.get('stage')=='baselineObserve':
            if data['manifest']['mode'] not in ('copyAndReplace','replaceFromExisting','replaceExternal'):
                return False
            local=state.get('localResult') or {}
            binding=next((row for row in runtime.get('derivedBindings',[])
                          if row.get('sourceFileId')==state['source']['fileId'] and
                          row.get('consumerAlias') in [p['consumerAlias'] for p in data['manifest'].get('parameterBindings',[])]),None)
            return (file is not None and file.id==data['manifest']['source']['fileId'] and
                doc.creationId==data['manifest']['source']['creationId'] and
                int(file.versionNumber)>int(state.get('targetBaseline',0)) and file.isComplete is True and
                doc.isModified is False and (local.get('restored') is True or
                    state.get('localProbeDeferred') is True and
                    runtime['probeHandles'][probe['probeId']].doc.isModified is False and
                    runtime['probeHandles'][probe['probeId']].doc.dataFile.versionNumber==state['source']['version']) and
                all(check.get('passed') is True for check in local.get('restoredGeometryChecks',[])) and
                binding is not None)
        if state.get('stage') not in ('refreshPlan','refreshApply','verifyConsumer'):return False
        if (file is None or not file.isComplete or doc.isModified or
                file.id!=state['targetPin']['fileId']):return False
        refresh_receipt=(data.get('result',{}).get('byItem',{}).get(item_id,{}).get('phaseResults',{})
            .get('verify',{}).get('assembly',{}).get('receipt',{}).get('refreshReceipt'))
        refreshed_row=None
        if state.get('stage')=='verifyConsumer':
            if not refresh_receipt or refresh_receipt.get('success') is not True or \
                    refresh_receipt.get('allIntendedReferencesCurrent') is not True:return False
            rows=[row for row in refresh_receipt.get('completed',[])
                  if row.get('fileId')==state['targetPin']['fileId'] and row.get('coldVerified') is True]
            if len(rows)!=1:return False
            refreshed_row=rows[0]
            if int(file.versionNumber)!=int(refreshed_row['resultingVersion']):return False
        elif int(file.versionNumber)!=int(state['targetPin']['version']):
            return False
        if state.get('stage')=='refreshApply' and (not refresh_receipt or
                refresh_receipt.get('invocationStatus')!='complete' or not refresh_receipt.get('planId')):
            return False
        baseline={edge['edgeId']:edge for edge in state.get('baselineEdges',[]) if edge.get('ownerFileId',file.id)==file.id}
        current_rows=_references_current_edges(ctx)
        current={edge['edgeId']:edge for edge in current_rows}
        if len(current)!=len(current_rows) or set(current)!=set(baseline):return False
        producer_id=state['source']['fileId'];restoring=state.get('restoring') is True
        applied_version=state.get('consumerAppliedVersion') if restoring else None
        for edge_id,row in current.items():
            old=baseline[edge_id]
            if row.get('sourceFileId')!=old.get('sourceFileId') or row.get('kind')!=old.get('kind'):
                return False
            if row.get('sourceFileId')==producer_id:
                if state.get('stage')=='verifyConsumer':
                    expected_baseline=state.get('publishedVersion')
                    expected_latest=state.get('publishedVersion')
                elif restoring:
                    expected_baseline=applied_version;expected_latest=state.get('publishedVersion')
                else:
                    expected_baseline=old.get('baselineVersion');expected_latest=state.get('publishedVersion')
                if expected_baseline is None or row.get('baselineVersion')!=expected_baseline or \
                        row.get('latestVersion')!=expected_latest:
                    return False
            elif row.get('baselineVersion')!=state.get('appliedVersions',{}).get(row['sourceFileId'],old.get('baselineVersion')) or \
                    row.get('latestVersion')!=state.get('appliedVersions',{}).get(row['sourceFileId'],old.get('latestVersion')):
                return False
            if row.get('versionSource')=='unresolved':return False
        if state.get('stage') in ('refreshPlan','refreshApply'):
            entry=runtime['items'][item_id]
            original=entry.get('originals') or []
            if len(original)!=1 or entry.get('baseline') is None:return False
            for check in range(len(entry['baseline']['bodies'])+1):
                _external_compare(entry['baseline'],original[0].component,check,runtime['tolerance'],entry['spec'])
            return True
        return refreshed_row is not None
    except Exception:
        return False


def _external_bodies(component):
    result = [(('root',i),b) for i,b in enumerate(_references_items(component.bRepBodies))]
    for index,occ in enumerate(_external_physical_occurrences(component)):
        for j,b in enumerate(_references_items(occ.component.bRepBodies)):
            result.append((('occurrence',index,j),b))
    return result


def _external_snapshot(component):
    _external_health(component)
    manager=adsk.fusion.TemporaryBRepManager.get()
    return {'inventory':_external_inventory(component),'joints':_external_internal_joints(component),
        'history':_external_history_signature(component),
        'bodies':[(key,manager.copy(body),body.material.id,_external_attributes(body)) for key,body in _external_bodies(component)],
        'attributes':_external_attributes(component),
        'occurrences':[{'index':i,'componentToken':o.component.entityToken,'token':o.entityToken,
            'nativeToken':_references_native_occurrence_token(getattr(o,'nativeObject',None) or o),'path':o.fullPathName,
            'pose':list(o.transform2.asArray()),'attrs':_external_attributes(o),
            'nativeAttrs':_external_attributes(getattr(o,'nativeObject',None) or o),
            'componentAttrs':_external_attributes(o.component)} for i,o in enumerate(_external_physical_occurrences(component))]}


def _external_compare(snapshot, component, check, tolerance, mappings=None):
    _external_health(component)
    _external_require(_external_inventory(component)==snapshot['inventory'], 'Source-bound inventory/history differs')
    _external_require('history' in snapshot and _external_history_signature(component)==snapshot['history'], 'Native feature history differs or its baseline is unavailable')
    _external_require('joints' in snapshot and _external_internal_joints(component)==snapshot['joints'], 'Internal native joint state/limits differ or baseline is unavailable')
    bodies = _external_bodies(component)
    mappings=mappings or {}
    if mappings.get('bodyMap'):
        mapping=mappings['bodyMap']
        _external_require(len(mapping)==len(bodies) and {r['sourceIndex'] for r in mapping}==set(range(len(bodies))) and
            {r['targetIndex'] for r in mapping}==set(range(len(bodies))),'Body map must bijectively cover the captured inventory')
        bodies=[bodies[next(r['targetIndex'] for r in mapping if r['sourceIndex']==i)] for i in range(len(bodies))]
    if check < len(snapshot['bodies']):
        key,old,material,attrs=snapshot['bodies'][check]
        _external_require(check < len(bodies) and (mappings.get('bodyMap') or bodies[check][0]==key), 'Body mapping cardinality mismatch')
        new=bodies[check][1]
        _external_require(new.material.id==material and _external_attributes(new)==attrs, 'Body material/native attributes differ')
        manager=adsk.fusion.TemporaryBRepManager.get()
        difference=[]
        for a,b in ((old,new),(new,old)):
            temp=manager.copy(a)
            _external_require(manager.booleanOperation(temp,manager.copy(b),adsk.fusion.BooleanTypes.DifferenceBooleanType), 'CSG operation failed')
            difference.append(float(temp.volume))
        _external_require(max(difference)<=tolerance['volume'], 'Bidirectional CSG mismatch')
        return {'checkId':'body:'+str(check),'passed':True,'differencesInternal':difference}
    actual=_external_physical_occurrences(component)
    if mappings.get('occurrenceMap'):
        mapping=mappings['occurrenceMap']
        _external_require(len(mapping)==len(actual) and {r['sourceIndex'] for r in mapping}==set(range(len(actual))) and
            {r['targetIndex'] for r in mapping}==set(range(len(actual))),'Occurrence map must bijectively cover distinct captured contexts')
        actual=[actual[next(r['targetIndex'] for r in mapping if r['sourceIndex']==i)] for i in range(len(actual))]
    _external_require(_external_attributes(component)==snapshot['attributes'], 'Component attributes differ')
    _external_require(len(actual)==len(snapshot['occurrences']), 'Occurrence map incomplete')
    for before,after in zip(snapshot['occurrences'],actual):
        _external_require(_external_attributes(after)==before['attrs'] and
            _external_attributes(getattr(after,'nativeObject',None) or after)==before['nativeAttrs'] and
            _external_attributes(after.component)==before['componentAttrs'], 'Context/native/component attributes differ')
        linear,angular=_measure_pose_delta(before['pose'],list(after.transform2.asArray()))
        _external_require(linear<=tolerance['linear'] and angular<=tolerance['angular'], 'Occurrence pose mismatch')
    return {'checkId':'history:poses:attributes','passed':True}


def _external_registry(create=False):
    name='_fmcad_externalization_runtime'
    if name not in sys.modules and create:
        module=types.ModuleType(name);module.operations={};sys.modules[name]=module
    return getattr(sys.modules.get(name),'operations',{})


def _external_history_signature(component):
    components=[component]
    for occurrence in _external_physical_occurrences(component):
        if occurrence.component not in components:components.append(occurrence.component)
    return [_external_component_history(c) for c in components]


def _external_component_history(component):
    features=[]
    for feature in _external_native_features(component):
        parameters=None
        if hasattr(feature,'parameters'):
            parameters=[(str(parameter.name),str(parameter.expression),str(parameter.unit))
                        for parameter in _references_items(feature.parameters)]
        features.append({'type':_cad_type(feature),'name':str(feature.name),
            'suppressed':bool(feature.isSuppressed),'healthState':int(feature.healthState),
            'parameters':parameters})
    sketches=[]
    for sketch in _references_items(component.sketches):
        sketches.append({'name':str(sketch.name),'isFullyConstrained':bool(sketch.isFullyConstrained),
            'curves':int(sketch.sketchCurves.count),'constraints':int(sketch.geometricConstraints.count),
            'dimensions':int(sketch.sketchDimensions.count)})
    return {'features':features,'sketches':sketches}


def _external_internal_joints(component,components=None):
    if components is None:
        components=[component]
        for occurrence in _external_physical_occurrences(component):
            if occurrence.component not in components:components.append(occurrence.component)
    result=[]
    for index,owner in enumerate(components):
        if owner is None:continue
        local=_references_items(owner.allOccurrences)
        def endpoint(occurrence):
            if occurrence is None:return None
            native=getattr(occurrence,'nativeObject',None) or occurrence
            matches=[i for i,o in enumerate(local) if (getattr(o,'nativeObject',None) or o)==native]
            return _cad_unique(matches,'closed internal-joint endpoint context')
        for collection in (owner.joints,owner.asBuiltJoints):
            for joint in _references_items(collection):
                motion=joint.jointMotion;kind=int(motion.jointType)
                _external_require(kind in (0,1,2,3),'Unqualified internal joint motion type')
                row={'owner':index,'name':joint.name,'form':_cad_type(joint),'kind':kind,
                     'endpoints':[endpoint(joint.occurrenceOne),endpoint(joint.occurrenceTwo)],'attrs':_external_attributes(joint)}
                for key in ('offset','angle'):
                    if hasattr(joint,key):row[key]=getattr(joint,key).expression
                if hasattr(joint,'isFlipped'):row['isFlipped']=bool(joint.isFlipped)
                for prefix in (('rotation',) if kind==1 else ('slide',) if kind==2 else ('rotation','slide') if kind==3 else ()):
                    row[prefix+'Value']=float(getattr(motion,prefix+'Value'))
                    limits=getattr(motion,prefix+'Limits')
                    row[prefix+'Limits']={key:getattr(limits,key) for key in
                        ('minimumValue','maximumValue','restValue','isMinimumValueEnabled','isMaximumValueEnabled','isRestValueEnabled')}
                result.append(row)
    return result


def _external_initial(data):
    lifecycle_effects=[]
    try:return _external_initial_impl(data,lifecycle_effects)
    except Exception as error:
        if not lifecycle_effects:raise
        return {'_externalPending':{'status':'blocked','notStarted':True,
            'receipt':{'cursor':0,'reason':type(error).__name__+': '+str(error)},
            'lifecycleEffects':lifecycle_effects}}


def _external_initial_impl(data,lifecycle_effects):
    m=data['manifest'];app=adsk.core.Application.get()
    source_item_ids={item['itemId'] for item in m['items'] if item.get('dataFileId')==m['source']['fileId']}
    probe_uses_owner=any((probe['source'].get('fileId')==m['source']['fileId'] or
        probe['source'].get('itemId') in source_item_ids) for probe in m.get('probes',[]))
    if m['mode']=='composeNew' and probe_uses_owner:
        _external_require(False,'composeNew driver probes cannot publish the preserved source document')
    source_editable=m['mode']!='composeNew'
    doc,resolved=_external_document(app,m['source'],allow_open=True,
        readonly=data.get('outerReadOnly',False),editable=source_editable)
    lifecycle_effects.extend(resolved.get('lifecycleEffects',[]))
    if doc is None and resolved.get('status')=='pendingPublication':
        return {'_externalPending':{'status':'pending','receipt':{'cursor':0,'reason':'sourcePublicationPending',
            'preflightPending':True,'sourcePin':_external_pin(_references_project_file(app,m['source']['projectId'],
                m['source']['fileId'],m['source']['version']))},'waitingPublication':True,
            'lifecycleEffects':lifecycle_effects}}
    _external_require(doc is not None, 'Exact saved source owner unavailable: '+str(resolved))
    _external_require(not doc.isModified and (not source_editable or not doc.dataFile.isReadOnly),
                       'Source recovery baseline must be saved and writable for this mode')
    if not _external_refresh_complete(doc.dataFile):
        return {'_externalPending':{'status':'pending','receipt':{'cursor':0,'reason':'sourcePublicationPending',
            'preflightPending':True,'sourcePin':_external_pin(doc.dataFile)},
            'waitingPublication':True,'lifecycleEffects':lifecycle_effects}}
    ctx=_external_ctx(doc);_assembly_capture_ready(ctx)
    _external_require(_references_feature_health(ctx)['healthy'],'Source recovery history is not healthy')
    runtime={'requestHash':data['requestHash'],'sessionNonce':data['sessionNonce'],'processId':os.getpid(),
        'source':ctx,'sourceFingerprint':_external_fingerprint(ctx),'items':{},'effects':{},'target':None,
        'initialLifecycleEffects':lifecycle_effects,
        'tolerance':{'linear':ctx.length(m['linearTolerance']),'angular':ctx.angle(m['angularTolerance']),
            'volume':ctx.design.unitsManager.evaluateExpression(m['volumeTolerance'],'cm^3')},'compensation':None}
    _external_require(all(math.isfinite(v) and v>=0 for v in runtime['tolerance'].values()), 'Tolerances must be finite and nonnegative')
    if m['mode']=='composeNew':
        folder=_external_folder(app,m['destinationDocument']);_external_collision(folder,m['destinationDocument']['name'])
    selected=[];authorized_instance_paths=[];definitions={}
    groups={g['id']:g for g in m.get('extractionGroups',[])}
    for spec in m['items']:
        target_project=m['destinationDocument']['projectId'] if m['mode']=='composeNew' else m['source']['projectId']
        if spec.get('dataFileId'):
            _external_require(spec['projectId']==target_project,'Pinned reused source must belong to the destination project')
        else:
            _external_require(spec['destination']['projectId']==target_project,'New native copy destination must match the assembly project')
        refs=groups[spec['groupId']]['members'] if spec.get('groupId') else ([spec['selection']] if 'selection' in spec else [])
        roots=[_external_occurrence(ctx,r) for r in refs]
        for occurrence in roots:
            _external_require(all(not (occurrence.fullPathName==old or occurrence.fullPathName.startswith(old+'+') or old.startswith(occurrence.fullPathName+'+')) for old in selected),'Overlapping/ancestor selections')
            selected.append(occurrence.fullPathName)
        if roots:
            external=spec.get('definitionPolicy','local')=='external'
            _external_require(all(o.isReferencedComponent==external for o in roots),'Explicit local/external definition policy mismatch')
            _external_require(m['mode']=='replaceExternal' or not external or m['mode']=='composeNew','Local retirement cannot target external definitions')
            if m['mode']=='replaceExternal':_external_require(external,'replaceExternal requires external-definition policy')
            if spec.get('groupId'):
                _external_require(spec['instancePolicy']=='selected',
                    'Extraction groups require explicit selected sibling membership; implicit allInstances group expansion is unsupported')
                parents={o.fullPathName.rsplit('+',1)[0] if '+' in o.fullPathName else '' for o in roots}
                _external_require(len(parents)==1,'Extraction group requires same-parent siblings')
            component=roots[0].component
            for root in roots:_external_dependency_coverage(root.component,[o.component for o in roots],
                defer_combine=bool(spec.get('groupId')))
            instances=[o for o in _references_items(ctx.root.allOccurrences) if o.component==component] if spec['instancePolicy']=='allInstances' else roots
            instances=_external_disjoint_instances(instances,authorized_instance_paths)
            if m['mode']!='composeNew' and spec.get('destinationOccurrence') not in (None,'root'):
                destination_parent=_assembly_root_occurrence(ctx,spec['destinationOccurrence'])
                _external_require(all(destination_parent.fullPathName!=o.fullPathName and
                    not destination_parent.fullPathName.startswith(o.fullPathName+'+') for o in instances),
                    'Insertion destination cannot be inside a selected externalization item')
            if m['mode']=='composeNew' and spec.get('placement') is not None:
                _external_require(len(instances)==1,'Explicit composeNew placement requires one selected source instance per item')
            # Equality, not Python wrapper id, defines the shared-native scope.
            for o in instances:
                peers=[p for p in _references_items(ctx.root.allOccurrences) if (getattr(p,'nativeObject',None) or p)==(getattr(o,'nativeObject',None) or o)]
                _external_require(all(p.fullPathName in [i.fullPathName for i in instances] for p in peers),'Shared-parent write would affect outside authorized instanceMap')
            baseline=_external_snapshot(component) if not spec.get('groupId') else None
            if baseline is not None:_external_require(baseline['inventory']==m['expectedInventory'][spec['itemId']],'Declared source inventory differs')
        else:
            instances=[];component=None;baseline=None
        if spec.get('dataFileId'):
            file=_references_project_file(app,spec['projectId'],spec['dataFileId'],spec['version'])
            target_pin=_external_pin(file)
            if spec.get('creationId'):target_pin['creationId']=spec['creationId']
            if spec.get('context'):target_pin['context']=spec['context']
        else:
            folder=_external_folder(app,spec['destination']);_external_collision(folder,spec['destination']['fileName'])
            target_pin=None
        key=(component.entityToken if component else spec['dataFileId'],m['source']['version'])
        owner=definitions.setdefault(key,spec['itemId'])
        if owner!=spec['itemId']:
            previous=next(i for i in m['items'] if i['itemId']==owner)
            _external_require(previous.get('destination')==spec.get('destination'), 'One native definition cannot declare competing copies')
        namespace_specs=[declaration for declaration in m.get('callerNamespaces',[])
                         if declaration['itemId']==spec['itemId']]
        runtime['items'][spec['itemId']]={'spec':spec,'component':component,'originals':instances,'baseline':baseline,
            'definitionOwner':owner,'targetPin':target_pin,'future':None,'staged':[],
            'instanceMap':[{'source':ctx.ref(o),'token':o.entityToken,'definition':o.component.entityToken,
            'path':o.fullPathName,'worldPose':list(_entity_occurrence_matrix(ctx,o)),
            'parentToken':o.assemblyContext.entityToken if o.assemblyContext is not None else None,
            'parentWorldPose':list(_entity_occurrence_matrix(ctx,o.assemblyContext)) if o.assemblyContext is not None else
                list(adsk.core.Matrix3D.create().asArray()),
            'callerNamespaceSpecs':namespace_specs,
            'callerNamespaces':_external_parent_namespace_values(ctx,o.assemblyContext,namespace_specs),
            'fileId':o.documentReference.dataFile.id if o.isReferencedComponent else None,
            'version':int(o.documentReference.version) if o.isReferencedComponent else None,
            'grounded':bool(o.isGrounded),'groundToParent':bool(o.isGroundToParent),
            'attributes':_external_attributes(o),'nativeAttributes':_external_attributes(getattr(o,'nativeObject',None) or o)} for o in instances]}
        runtime['items'][spec['itemId']]['retireMap']=list(runtime['items'][spec['itemId']]['instanceMap'])
    selected_owners=[]
    for entry in runtime['items'].values():
        for occurrence in entry['originals']:
            selected_owners.extend([occurrence.component]+[o.component for o in _references_items(occurrence.component.allOccurrences)])
    if m['mode'] in ('copyAndReplace','replaceFromExisting','replaceExternal'):
        for component in _references_own_components(ctx.root):
            if component in selected_owners:continue
            for feature in _references_items(component.features):
                _external_require(not any(owner in selected_owners for owner in _external_feature_input_owners(feature)),
                    'Outside feature consumes selected geometry; explicit closed extraction group/interface required')
    _external_preflight_boundaries(runtime,m)
    for entry in runtime['items'].values():
        if entry['spec'].get('groupId'):
            group=groups[entry['spec']['groupId']]
            entry['baseline']=_external_group_snapshot(ctx,[_external_occurrence(ctx,r) for r in group['members']])
            _external_require(entry['baseline']['inventory']==m['expectedInventory'][entry['spec']['itemId']],'Declared group inventory differs')
            path=entry['originals'][0].fullPathName.rsplit('+',1)[0] if '+' in entry['originals'][0].fullPathName else ''
            pose=list(_entity_occurrence_matrix(ctx,_external_occurrence(ctx,{'path':path}))) if path else list(adsk.core.Matrix3D.create().asArray())
            entry['instanceMap']=[{'source':None,'token':None,'definition':group['id'],'path':path,'worldPose':pose,
                'attributes':[],'nativeAttributes':[],'grounded':False,'groundToParent':False}]
    return runtime


def _external_result(status,cursor,**values):
    return {'status':status,'receipt':{'cursor':cursor,**values}}


def _external_copy(runtime,data,entry,cursor):
    spec=entry['spec'];ctx=runtime['source']
    if spec.get('dataFileId'):
        return _external_result('notApplicable',1,reuse=entry['targetPin'],reason='exactPinnedReuse')
    if entry['definitionOwner']!=spec['itemId']:
        owner=runtime['items'][entry['definitionOwner']]
        if owner['targetPin'] is None:return _external_result('blocked',cursor,reason='sharedDefinitionCopyPending')
        entry['targetPin']=owner['targetPin']
        return _external_result('complete',1,reuse=entry['targetPin'],sharedDefinitionOwner=entry['definitionOwner'])
    if spec.get('groupId'):
        return _external_group_copy(runtime,data,entry,cursor)
    if cursor==0:
        effects=_external_activate(ctx)
        folder=_external_folder(ctx.app,spec['destination']);_external_collision(folder,spec['destination']['fileName'])
        return _external_with_lifecycle(_external_begin_copy(runtime,data,entry,ctx,entry['component'],
            spec['destination'],folder,'component','future',cursor),effects)
    return _external_future(entry,cursor,spec['destination'])


def _external_event_matches(intent,event):
    destination=intent['destination']
    return (event.get('projectId')==destination['projectId'] and event.get('folderId')==destination['folderId'] and
            event.get('description')==intent['description'])


def _external_copy_events(job):
    rows=[row for row in job['events'] if _external_event_matches(job['intent'],row)]
    ids={row['fileId'] for row in rows}
    if len(ids)>1:return {'status':'unknown','reason':'copyNonceMatchedMultipleFiles'}
    if any(row['status'].get('isError') is True for row in rows):
        return {'status':'failed','reason':'copyCompletionEventFailed'}
    # DataEventArgs properties are not populated on every event. Status is a
    # diagnostic, not the completion proof: exact nonce-bound identity plus a
    # fresh DataFile.isComplete read supplies that independently below.
    versions={row['version'] for row in rows}
    if len(versions)>1:return {'status':'unknown','reason':'copyCompletionEventVersionDrift'}
    if job.get('observationFailed'):return {'status':'unknown','reason':'copyCompletionEventReadbackFailed'}
    if not rows:return {'status':'pending'}
    return {'status':'correlated','fileId':rows[0]['fileId'],'version':rows[0]['version'],'events':rows}


def _external_capture_copy_status(args):
    row={'status':{},'statusReadContext':'notify'};field='args.isValid'
    try:
        _external_require(args.isValid,'Completion event arguments are no longer valid')
        field='args.status';status=args.status
        for key in ('isError','isWarning','isOK'):
            field='status.'+key;row['status'][key]=bool(getattr(status,key))
    except Exception as error:
        row['statusReadError']=type(error).__name__+': '+str(error)
        row['statusReadErrorAt']=field
    return row


def _external_copy_disarm(job):
    if job.get('disarmed'):return
    for event,handler in job['handlers']:
        _external_require(event.remove(handler),'Unable to remove this copy completion handler')
    job['disarmed']=True


def _external_begin_copy(runtime,data,entry,ctx,component,destination,folder,purpose,slot,cursor):
    elapsed=(time.monotonic()-data.get('_copyStepStartedAt',time.monotonic()))*1000
    available=min(data.get('remainingMs',0),data.get('copyRpcBudgetMs',54000))-elapsed-2000
    if available<=0:return _external_result('pending',cursor,stopReason='budgetExhausted',reason='budgetExhausted')
    intent=data.get('copyIntent')
    if not intent:return {**_external_result('blocked',cursor,notStarted=True,reason='Missing durable new-copy intent'),'notStarted':True}
    _external_require(intent['operationId']==data['operationId'] and intent['itemId']==entry['spec']['itemId'] and
        intent['purpose']==purpose and intent['destination']==destination,'Copy intent differs from the declared native action')
    pin=intent['source'];actual=ctx.doc.dataFile
    _external_require(actual.id==pin['fileId'] and actual.versionNumber==pin['version'] and
        actual.parentProject.id==pin['projectId'] and (not pin.get('creationId') or ctx.doc.creationId==pin['creationId']),
        'Copy intent source differs from the exact saved source')
    _external_require(len(intent['nonce'])==64 and all(c in '0123456789abcdef' for c in intent['nonce']) and
        intent['description']==intent['finalDescription']+' [fmcad-copy:'+intent['nonce']+']','Invalid private copy nonce description')
    if purpose=='component':_external_require(intent['component']==entry['spec']['selection'] and component==entry['component'],'Copy component binding differs')
    elif purpose=='groupParent':
        group=next(g for g in data['manifest']['extractionGroups'] if g['id']==entry['spec']['groupId'])
        _external_require(intent['component']=={'parentOf':group['members']},'Group parent binding differs')
    else:_external_require(component.entityToken==intent['component']['token'],'Staged group component binding differs')
    _external_require(entry.get(slot) is None and entry.get(slot+'Observer') is None,'Copy was already submitted or armed; no replay')
    job={'intent':intent,'events':[],'handlers':[],'diagnostics':[],'disarmed':False,'submitted':False}
    entry[slot+'Observer']=job
    class Handler(adsk.core.DataEventHandler):
        def __init__(self,event_name):
            super().__init__();self.event_name=event_name
        def notify(self,args):
            correlated=False;field='file'
            try:
                file=args.file
                if file is None:return
                field='scope';project_id=file.parentProject.id;folder_id=file.parentFolder.id
                if project_id!=destination['projectId'] or folder_id!=destination['folderId']:return
                field='description';description=file.description
                if description!=intent['description']:return
                correlated=True
                field='fileIdentity'
                row={'event':self.event_name,'fileId':file.id,'version':int(file.versionNumber),
                    'projectId':project_id,'folderId':folder_id,'name':file.name,
                    'description':description,'isComplete':bool(file.isComplete),'status':{}}
                if len(job['events'])>=32:raise ValueError('Copy completion event observation limit exceeded')
                job['events'].append(row)
                # Snapshot primitives during dispatch; event args and Status
                # wrappers have no documented lifetime after notify returns.
                row.update(_external_capture_copy_status(args))
            except Exception as error:
                if correlated:job['observationFailed']=True
                if len(job['diagnostics'])<32:job['diagnostics'].append(self.event_name+': '+field+': '+type(error).__name__+': '+str(error))
    try:
        for name in ('dataFileComplete','dataFileCopyComplete'):
            event=getattr(ctx.app,name);handler=Handler(name)
            _external_require(event.add(handler),'Copy completion event registration failed')
            job['handlers'].append((event,handler))
    except Exception:
        _external_copy_disarm(job)
        raise
    before=_external_fingerprint(ctx);started=time.monotonic()
    job['submitted']=True
    entry[slot]=component.saveCopyAs(destination['fileName'],folder,intent['description'],'')
    _external_require(entry[slot] is not None,'Native copy submission returned no future')
    deadline=started+min(30000,available)/1000
    while time.monotonic()<deadline:
        adsk.doEvents()
        if entry[slot].uploadState!=adsk.core.UploadStates.UploadProcessing or job['events']:break
        time.sleep(.1)
    _external_require(_external_fingerprint(ctx)==before,'Copy submission changed the saved source')
    return {**_external_result('pending',cursor+1,accepted=True,copyIntent=intent,
        initiatingPumpMs=int((time.monotonic()-started)*1000),sourceUnchanged=True),
        'uploadStatus':'pending','rawUploadState':{'value':int(entry[slot].uploadState),'name':str(entry[slot].uploadState)},
        'lifecycleEffects':[{'action':'copyObserverArmed','nonce':intent['nonce'],
            'events':['dataFileComplete','dataFileCopyComplete'],'owned':True}]}


def _external_future(entry,cursor,destination):
    future=entry.get('future')
    job=entry.get('futureObserver');observed=_external_copy_events(job) if job else {'status':'pending'}
    raw=future.uploadState if future is not None else None
    descriptor={'value':int(raw),'name':str(raw)} if raw is not None else None
    event_diagnostic=observed.get('reason')
    primary_only=(raw==adsk.core.UploadStates.UploadFinished and
        observed.get('reason')=='copyCompletionEventReadbackFailed')
    if observed['status']=='failed' and raw==adsk.core.UploadStates.UploadFinished:
        return {**_external_result('unknown',cursor,reason='Contradictory native copy receipts'),'uploadStatus':'unknown','rawUploadState':descriptor}
    if observed['status'] in ('unknown','failed') and not primary_only:
        if observed['status']=='failed':_external_copy_disarm(job)
        return {**_external_result(observed['status'],cursor,reason=observed['reason'],copyEvents=job['events']),
            'uploadStatus':observed['status'],'rawUploadState':descriptor}
    event_file=None
    if observed['status']=='correlated':
        event_file=adsk.core.Application.get().data.findFileById(observed['fileId'])
        _external_require(event_file is not None and event_file.id==observed['fileId'] and
            int(event_file.versionNumber)==observed['version'],'Correlated copy file identity/version changed')
    if raw==adsk.core.UploadStates.UploadFailed and event_file is not None:
        return {**_external_result('unknown',cursor,reason='Contradictory native copy receipts'),'uploadStatus':'unknown','rawUploadState':descriptor}
    if raw==adsk.core.UploadStates.UploadFailed:
        if job:_external_copy_disarm(job)
        return {**_external_result('failed',cursor,reason='nativeUploadFailed'),'uploadStatus':'failed','rawUploadState':descriptor}
    if raw==adsk.core.UploadStates.UploadProcessing and event_file is None:
        return {**_external_result('pending',cursor,accepted=True),'uploadStatus':'pending','rawUploadState':descriptor,'waitingPublication':True}
    if future is None and event_file is None:return {**_external_result('unknown',cursor,reason='lostNativeFuture'),'uploadStatus':'unknown'}
    if raw not in (None,adsk.core.UploadStates.UploadFinished,adsk.core.UploadStates.UploadProcessing):
        return {**_external_result('unknown',cursor,reason='unrecognizedNativeUploadState'),'uploadStatus':'unknown','rawUploadState':descriptor}
    file=future.dataFile if raw==adsk.core.UploadStates.UploadFinished else event_file
    if file is not None and event_file is not None:
        _external_require(file.id==event_file.id and file.versionNumber==observed['version'],'Future and event copy identity differ')
    _external_require(file is not None and file.parentProject.id==destination['projectId'] and
        file.parentFolder.id==destination['folderId'] and file.name==destination['fileName'],'Copy future resolved wrong immutable identity')
    if job:_external_require(file.description==job['intent']['description'],'Copy nonce description readback differs')
    entry['targetPin']=_external_pin(file)
    if not file.isComplete:
        file.refresh(None)
        return {**_external_result('pending',cursor,target=entry['targetPin']),'uploadStatus':'pending','rawUploadState':descriptor,'waitingPublication':True}
    if job:
        job['filePin']=entry['targetPin'];_external_copy_disarm(job)
    return {**_external_result('complete',cursor+1,target=entry['targetPin'],
        **({'copyCompletion':{'method':'future' if raw==adsk.core.UploadStates.UploadFinished else 'correlatedEvent',
            'intent':job['intent'],'events':job['events'],'rawUploadState':descriptor,'observerDisarmed':job['disarmed'],
            'descriptionVerified':True,'eventQualification':observed['status'],
            'eventDiagnostic':event_diagnostic,'diagnostics':job['diagnostics']}} if job else {})),
        'uploadStatus':'complete','rawUploadState':descriptor,
        **({'lifecycleEffects':[{'action':'copyObserverDisarmed','nonce':job['intent']['nonce'],'owned':True}]} if job else {})}


def _external_verify(runtime,data,entry,cursor):
    phase=data['phase'];pin=entry['targetPin'];ctx=runtime['source'];effects=[]
    if entry.get('baseline') is not None and cursor>=len(entry['baseline']['bodies'])+1:
        return _external_probe_step(runtime,data,entry,cursor)
    if phase=='verify:sources':
        _external_require(pin is not None,'No completed native source file')
        file=_references_project_file(ctx.app,pin['projectId'],pin['fileId'],pin['version'])
        if not _external_refresh_complete(file):
            return {**_external_result('pending',cursor,target=_external_pin(file),reason='pendingPublication'),
                    'waitingPublication':True}
        doc,lifecycle=_external_document(ctx.app,pin,allow_open=True,readonly=data.get('outerReadOnly',False),editable=False)
        if doc is None:return _external_result('blocked',cursor,reason=lifecycle)
        effects=lifecycle['lifecycleEffects'];component=_external_ctx(doc).root
        _external_health(component)
        # A declared group already inspected Combine owners in its isolated
        # parent copy. Do not roll (and dirty) the final child during read-only
        # verification; exact history/geometry and declared driver checks follow.
        grouped_coverage=bool(entry['spec'].get('groupId') and entry.get('groupDependencyCoverage'))
        _external_dependency_coverage(component,[component],defer_combine=grouped_coverage)
        entry['targetDoc']=doc
        if entry['baseline'] is None:
            _external_require(_external_inventory(component)==data['manifest']['expectedInventory'][entry['spec']['itemId']],'Reused source inventory differs')
            entry['baseline']=_external_snapshot(component)
    else:
        _external_require(entry['staged'],'Assembly verification requires actual staged instances')
        component=entry['staged'][0].component
        if entry['spec'].get('groupId'):_external_group_context_attributes(ctx,entry)
    baseline=entry['baseline'];count=len(baseline['bodies'])+1
    if cursor<count:
        check=_external_compare(baseline,component,cursor,runtime['tolerance'],entry['spec'])
        probes=[p for p in data['manifest'].get('probes',[]) if p['itemId']==entry['spec']['itemId'] and
                p.get('scope','assembly')==phase.split(':')[1]]
        return {**_external_result('pending' if cursor+1<count or probes else 'complete',cursor+1,checks=[check],
            sourceFingerprint=runtime['sourceFingerprint'],target=pin,
            remainingCheckIds=['body:'+str(i) if i<len(baseline['bodies']) else 'history:poses:attributes' for i in range(cursor+1,count)]),
            'completedChecks':1,'lifecycleEffects':effects}
    return _external_probe_step(runtime,data,entry,cursor)


def _external_activate(ctx):
    _external_require(ctx.app.userInterface.activeCommand in ('','SelectCommand'),'Interactive command active')
    if ctx.app.activeDocument==ctx.doc:return []
    identity=_references_document_identity(ctx.doc)
    _external_require(ctx.doc.activate() and ctx.app.activeDocument==ctx.doc,'Activate exact operation-owned document')
    return [{'action':'activated','docid':ctx.doc.creationId,'openedByOperation':False,'identity':identity}]


def _external_with_lifecycle(result,effects):
    if effects:result['lifecycleEffects']=[*(result.get('lifecycleEffects') or []),*effects]
    return result


def _external_close_owned_clean_doc(ctx,pin):
    doc=ctx.doc;app=ctx.app
    _external_require(doc.isValid and doc.dataFile is not None and
        doc.dataFile.id==pin['fileId'] and int(doc.dataFile.versionNumber)==int(pin['version']) and
        doc.dataFile.isComplete is True and doc.dataFile.isReadOnly is False and doc.isModified is False,
        'Driver probe may close only its exact saved, complete, clean editable consumer')
    _external_require(app.userInterface.activeCommand in ('','SelectCommand'),
                      'Interactive command active; retain the owned consumer editor')
    same_file=[candidate for candidate in _references_items(app.documents)
        if getattr(getattr(candidate,'dataFile',None),'id',None)==pin['fileId'] and
        int(candidate.dataFile.versionNumber)==int(pin['version'])]
    _external_require(len(same_file)==1 and same_file[0].creationId==doc.creationId,
                      'Duplicate consumer editor context; no close by title or file ID')
    identity=_references_document_identity(doc)
    _external_require(doc.close(False) is True,'Close exact owned clean consumer editor returned false')
    _external_require(not any(candidate.creationId==identity['creationId'] and
        getattr(getattr(candidate,'dataFile',None),'id',None)==pin['fileId']
        for candidate in _references_items(app.documents)),
        'Exact owned consumer editor remains after close request')
    return {'action':'closed','docid':identity['creationId'],'openedByOperation':False,
            'identity':identity,'owned':True}


def _external_target(runtime,data):
    m=data['manifest'];source=runtime['source']
    if m['mode']!='composeNew':return source,[]
    if runtime['target'] is not None:
        _external_require(runtime['target'].doc.isValid,'Created target handle lost; no second target')
        return runtime['target'],[]
    _external_require(not data.get('outerReadOnly'),'Read-only caller forbids target creation')
    folder=_external_folder(source.app,m['destinationDocument']);_external_collision(folder,m['destinationDocument']['name'])
    doc=source.app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
    _external_require(doc is not None,'New target creation unconfirmed')
    # Retain the exact new identity before any subsequent cloud submission.
    runtime['target']=_external_ctx(doc);runtime['targetCreationId']=doc.creationId
    design=runtime['target'].design
    if design.designType!=adsk.fusion.DesignTypes.ParametricDesignType:
        design.designType=adsk.fusion.DesignTypes.ParametricDesignType
    _external_require(design.designType==adsk.fusion.DesignTypes.ParametricDesignType,
                      'composeNew requires a native parametric target design')
    return runtime['target'],[{'action':'created','docid':doc.creationId,'createdByOperation':True,
                               'identity':{'creationId':doc.creationId,'fileId':None}}]


def _external_stage_insert_plan(ctx,source_ctx,spec,mapping,index,tolerance):
    destination=spec.get('destinationOccurrence','root')
    request={'destination':destination,'sharedParentPolicy':spec.get('sharedParentPolicy','reject')}
    if spec.get('placement') is not None:
        request.update(placement=spec['placement'],placementSpace=spec.get('placementSpace'))
    parent,parent_occ,base_matrix,parent_paths=_external_destination(ctx,request)
    parents=[(path,_external_destination_parent(ctx,path)) for path in parent_paths]
    source_by_parent={}
    if mapping and len(parent_paths)>1 and len(mapping)>1:
        _external_require(len(mapping)==len(parent_paths),
                          'Repeated destination context needs one selected source instance per target parent')
        used=set()
        for path,target_parent in parents:
            matches=[i for i,row in enumerate(mapping)
                     if _external_parent_context_match(source_ctx,ctx,target_parent,row)]
            _external_require(len(matches)==1 and matches[0] not in used,
                              'Repeated destination parents require unique native context or callerNamespaces mapping')
            source_by_parent[path]=matches[0];used.add(matches[0])
        _external_require(len(used)==len(mapping),'Repeated destination map omitted a selected source context')
    elif mapping and len(parent_paths)==1 and len(mapping)>1:
        _external_require(index<len(mapping),'Selected source instance map exhausted')
        source_by_parent[parent_paths[0]]=index
    elif mapping:
        for path in parent_paths:source_by_parent[path]=0

    placement=spec.get('placement')
    placement_world=_assembly_matrix(ctx,placement).asArray() if placement is not None else None
    local_by_parent=[]
    for path,target_parent in parents:
        parent_world=list(_entity_occurrence_matrix(ctx,target_parent)) if target_parent is not None else list(adsk.core.Matrix3D.create().asArray())
        if placement is not None and spec.get('placementSpace')=='root' and target_parent is not None:
            local=_entity_multiply(_entity_inverse(parent_world),placement_world)
        elif placement is not None:
            local=placement_world
        elif mapping:
            row=mapping[source_by_parent[path]]
            local=_entity_multiply(_entity_inverse(parent_world),row['worldPose'])
        else:
            local=list(base_matrix.asArray())
        local_by_parent.append((path,local,parent_world))
    _external_require(bool(local_by_parent),'Destination has no authorized parent contexts')
    matrix=local_by_parent[0][1]
    for path,local,parent_world in local_by_parent[1:]:
        linear,angular=_measure_pose_delta(matrix,local)
        _external_require(linear<=tolerance['linear'] and angular<=tolerance['angular'],
                          'Shared parent contexts require incompatible local transforms; split the mapping')
    expected_world={path:_entity_multiply(parent_world,matrix) for path,local,parent_world in local_by_parent}
    return {'destination':destination,'parentPaths':parent_paths,'sourceByParent':source_by_parent,
            'matrix':_entity_matrix(matrix),'expectedWorld':expected_world}


def _external_stage(runtime,data,entry,cursor):
    ctx,effects=_external_target(runtime,data);effects.extend(_external_activate(ctx))
    if effects:return {**_external_result('pending',cursor+1,targetCreationId=ctx.doc.creationId),'lifecycleEffects':effects}
    if not runtime.get('bindingsCreated'):
        return _external_with_lifecycle(_external_bindings_stage(runtime,data,entry,cursor),effects)
    if data['manifest']['mode']=='replaceExternal':
        return _external_with_lifecycle(_external_replace_stage(runtime,data,entry,cursor),effects)
    index=len(entry['staged']);spec=entry['spec'];mapping=entry['instanceMap']
    if index<max(1,len(mapping)):
        placement=spec.get('placement');space=spec.get('placementSpace')
        try:plan=_external_stage_insert_plan(ctx,runtime['source'],spec,mapping,index,runtime['tolerance'])
        except Exception as error:
            return _external_with_lifecycle(_external_result('blocked',cursor,notStarted=True,
                reason='stageInsertPreflight: '+type(error).__name__+': '+str(error)),effects)
        payload={'source':{'dataFileId':entry['targetPin']['fileId'],'version':entry['targetPin']['version']},
                 'destination':plan['destination'],'sharedParentPolicy':spec.get('sharedParentPolicy','reject'),'confirm':True}
        if placement is not None:payload.update(placement=placement,placementSpace=space)
        destination_project=ctx.doc.dataFile.parentProject.id if ctx.doc.dataFile else data['manifest']['destinationDocument']['projectId']
        try:inserted=_external_insert_matrix(ctx,payload,plan['matrix'],destination_project)
        except Exception as error:
            return _external_with_lifecycle(_external_result('blocked',cursor,notStarted=True,
                reason='stageInsertPreflight: '+type(error).__name__+': '+str(error)),effects)
        if inserted['status']!='complete':
            state='unknown' if inserted['status']=='unknown' else 'failed'
            return _external_with_lifecycle(_external_result(state,cursor+1,partial=inserted.get('partial') is True,
                                    insertion=inserted,noReplay=True),effects)
        actuals=[_external_occurrence(ctx,ref) for ref in inserted['occurrences']]
        entry['staged'].extend(actuals)
        try:
            for actual in actuals:
                parent_path=actual.fullPathName.rsplit('+',1)[0] if '+' in actual.fullPathName else ''
                _external_require(parent_path in plan['expectedWorld'],'Inserted occurrence has no explicit destination context receipt')
                if mapping:
                    if len(mapping)==1:row=mapping[0]
                    else:
                        source_index=plan['sourceByParent'].get(parent_path)
                        _external_require(source_index is not None,'Inserted occurrence has no source-context map')
                        row=mapping[source_index]
                    _external_ensure_attributes(actual,row['attributes'])
                    native=getattr(actual,'nativeObject',None) or actual
                    _external_ensure_attributes(native,row['nativeAttributes'])
                    actual.isGrounded=row['grounded'];actual.isGroundToParent=row['groundToParent']
                expected_world=plan['expectedWorld'][parent_path]
                linear,angular=_measure_pose_delta(expected_world,list(_entity_occurrence_matrix(ctx,actual)))
                _external_require(linear<=runtime['tolerance']['linear'] and angular<=runtime['tolerance']['angular'],
                                  'Staged world pose differs from the exact source/destination transform mapping')
            if spec.get('groupId'):_external_group_context_attributes(ctx,entry,apply=True)
        except Exception as error:
            return _external_with_lifecycle(_external_result('failed',cursor+1,partial=True,
                insertion=inserted,stagedRefs=[ctx.ref(o) for o in actuals],
                postcheckError=type(error).__name__+': '+str(error),noReplay=True),effects)
        return _external_with_lifecycle(_external_result('pending',cursor+1,instanceMap=[ctx.ref(o) for o in entry['staged']]),
                                        [*effects,*(inserted.get('lifecycleEffects',[]))])
    needed={endpoint['itemId'] for row in runtime['boundaries'] for endpoint in row['spec']['endpoints'] if endpoint.get('itemId')}
    awaiting=[item_id for item_id in needed if not runtime['items'][item_id]['staged']]
    if awaiting:return _external_with_lifecycle({**_external_result('pending',cursor+1,localStaged=True,awaitingItems=awaiting),'defer':True},effects)
    if all(e['staged'] for e in runtime['items'].values()):
        for row in runtime['boundaries']:
            if row['new'] is None:
                before=_assembly_pose_snapshot(ctx)
                row['rebuildBeforePoses']=before;row['rebuildStepId']=data['stepId']
                joint=_external_rebuild_joint(runtime,ctx,row)
                _external_require(ctx.design.computeAll(),'Boundary recompute failed')
                after=_assembly_pose_snapshot(ctx)
                _external_require(set(before)==set(after),'Boundary changed occurrence inventory')
                for key in before:
                    linear,angular=_measure_pose_delta(before[key],after[key])
                    _external_require(linear<=runtime['tolerance']['linear'] and angular<=runtime['tolerance']['angular'],'Boundary moved protected nominal pose')
                return _external_with_lifecycle(_external_result('pending',cursor+1,boundary=joint,
                    positionSnapshot=row.get('positionSnapshot')),effects)
        runtime['boundariesCreated']=True
    _external_require(ctx.design.computeAll(),'Stage recompute failed')
    entry['stagedRefs']=[ctx.ref(o) for o in entry['staged']]
    return _external_with_lifecycle(_external_result('complete',cursor+1,localStaged=True,awaitingItems=[],
        instanceMap=entry['stagedRefs'],targetCreationId=ctx.doc.creationId),effects)


def _external_retire(runtime,data,entry,cursor):
    _external_require(data['manifest']['mode'] in ('copyAndReplace','replaceFromExisting'),'Retire not applicable')
    ctx=runtime['source'];lifecycle_effects=_external_activate(ctx)
    for row in sorted(runtime['boundaries'],key=lambda r:r['old'].timelineObject.index if r['old'].isValid else -1,reverse=True):
        if not row['detached'] and any(e.get('itemId')==entry['spec']['itemId'] for e in row['spec']['endpoints']):
            _external_require(row['new'] is not None and row['new'].isValid,'Mapped replacement boundary is not verified')
            deletion=_external_delete_joint_checkpoint(ctx,row['old'],row['token'])
            if deletion['status']!='removed':
                return _external_with_lifecycle(_external_result('failed',cursor+1,partial=bool(entry.get('retiredCount',0) or
                    any(boundary['detached'] for boundary in runtime['boundaries'])),removedJoint=row['token'],
                    deletion=deletion,noReplay=True),lifecycle_effects)
            row['detached']=True;return _external_with_lifecycle(_external_result('pending',cursor+1,removedJoint=row['token']),lifecycle_effects)
    originals=entry['originals'];retire_map=entry.get('retireMap',entry['instanceMap'])
    retired=entry.setdefault('retiredIndices',set(range(entry.get('retiredCount',0))))
    remaining=[i for i in range(len(originals)) if i not in retired]
    if remaining:
        index=remaining[0]
        old=originals[index]
        _external_require(old.isValid and not old.isReferencedComponent,'Retire requires mapped original local instance')
        captured=retire_map[index]
        native=getattr(old,'nativeObject',None) or old
        peers=[i for i in remaining if originals[i].isValid and
               (getattr(originals[i],'nativeObject',None) or originals[i])==native]
        deletion=_external_delete_occurrence_checkpoint(ctx,native,captured)
        if deletion['status']!='removed':
            return _external_with_lifecycle(_external_result('failed',cursor+1,partial=bool(index or any(boundary['detached'] for boundary in runtime['boundaries'])),
                removedToken=captured['token'],deletion=deletion,noReplay=True),lifecycle_effects)
        absent=[i for i in peers if not _external_occurrence_present(ctx,retire_map[i])]
        _external_require(len(absent)==len(peers),'Shared native retirement did not remove every authorized context')
        retired.update(absent);entry['retiredCount']=len(retired)
        return _external_with_lifecycle(_external_result('pending',cursor+1,removedToken=captured['token'],
            removedTokens=[retire_map[i]['token'] for i in absent],
            reconciledAfterException=deletion['reconciledAfterException']),lifecycle_effects)
    return _external_with_lifecycle(_external_result('complete',cursor,removed=[row['token'] for row in retire_map]),lifecycle_effects)


def _external_finalize(runtime,data,entry,cursor):
    ctx=runtime['target'] or runtime['source'];lifecycle_effects=_external_activate(ctx)
    _external_require(data['manifest'].get('save') is True,'Finalize requires authorized save')
    if cursor==0:
        lifecycle_effects.extend(_external_verify_copy_descriptions(ctx,entry))
        for row in runtime['boundaries']:
            if not any(e.get('itemId')==entry['spec']['itemId'] for e in row['spec']['endpoints']):continue
            joint=row['new'];_external_require(joint is not None and joint.isValid,'Verified boundary missing at finalize')
            if data['manifest']['mode'] in ('copyAndReplace','replaceFromExisting'):
                _external_require(not _external_joint_present(ctx,row['token']),'Original boundary remains before final naming')
            others=[j for collection in (ctx.root.joints,ctx.root.asBuiltJoints) for j in _references_items(collection)
                    if j!=joint and j.name==row['name']]
            _external_require(not others,'Final boundary name collides with an unrelated joint')
            joint.name=row['name'];_external_require(joint.name==row['name'],'Final boundary name readback differs')
            _external_boundary_readback(runtime,ctx,row)
        if entry['spec'].get('name'):
            for occurrence in entry['staged']:occurrence.name=entry['spec']['name']
        for occurrence in entry['staged']:_external_health(occurrence.component)
        return _external_with_lifecycle(_external_result('pending',1,namingComplete=True),lifecycle_effects)
    # Finalize's post-metadata checks obey the same per-check bound as verify.
    per_instance=len(entry['baseline']['bodies'])+1
    count=per_instance*len(entry['staged'])
    if 1<=cursor<=count:
        occurrence=entry['staged'][(cursor-1)//per_instance]
        check=_external_compare(entry['baseline'],occurrence.component,(cursor-1)%per_instance,runtime['tolerance'],entry['spec'])
        check['checkId']='final:'+str(cursor-1)+':'+check['checkId']
        return _external_with_lifecycle({**_external_result('pending',cursor+1,checks=[check]),'completedChecks':1},lifecycle_effects)
    if cursor==count+1:
        before=ctx.doc.dataFile.versionNumber if ctx.doc.dataFile else 0
        runtime['saveBaseline']=before
        if ctx.doc.dataFile:
            if not ctx.doc.isModified:return _external_with_lifecycle(
                _external_result('complete',cursor+1,file=_external_pin(ctx.doc.dataFile),unchanged=True),lifecycle_effects)
            runtime['saveAttempted']=True;runtime['saveFileId']=ctx.doc.dataFile.id
            runtime['saveProjectId']=ctx.doc.dataFile.parentProject.id
            runtime['saveCreationId']=ctx.doc.creationId
            runtime['saveContentFingerprint']=_external_content_fingerprint(ctx)
            accepted=ctx.doc.save('Externalization '+data['operationId'])
        else:
            dest=data['manifest']['destinationDocument'];folder=_external_folder(ctx.app,dest);_external_collision(folder,dest['name'])
            _external_require(ctx.doc.creationId==runtime['targetCreationId'],'Created target identity changed')
            runtime['saveContentFingerprint']=_external_content_fingerprint(ctx)
            accepted=ctx.doc.saveAs(dest['name'],folder,'Native externalization '+data['operationId'],'')
        _external_require(accepted,'Final save not accepted')
        return _external_result('pending',cursor+1,saveAccepted=True,creationId=ctx.doc.creationId)
    file=ctx.doc.dataFile
    if file is None or not file.isComplete or ctx.doc.isModified or file.versionNumber<=runtime['saveBaseline']:
        if file is not None:file.refresh(None)
        return {**_external_result('pending',cursor,saveAccepted=True),'waitingPublication':True}
    expected=data['manifest']['destinationDocument'] if data['manifest']['mode']=='composeNew' else None
    if expected:
        _external_require(file.parentProject.id==expected['projectId'] and file.parentFolder.id==expected['folderId'] and
                          file.name==expected['name'],'Saved target is outside declared destination')
        _external_require(runtime['source'].doc.isModified is False and
            runtime['source'].doc.dataFile.id==data['manifest']['source']['fileId'],
            'composeNew must retain the unmodified original source')
    else:_external_require(file.id==data['manifest']['source']['fileId'],'Finalize changed original lineage')
    return _external_with_lifecycle(_external_result('complete',cursor+1,file=_external_pin(file),cloudComplete=True,
        targetTimeline=ctx.design.timeline.count,retainedChildHistory=entry['baseline']['inventory']['history'],
        sourceUnchanged=data['manifest']['mode']!='composeNew' or runtime['source'].doc.isModified is False,
        referenceHelpers=runtime.get('referenceHelpers',[])),lifecycle_effects)


def _external_verify_copy_descriptions(ctx,entry):
    effects=[]
    for slot,pin in (('future',entry.get('targetPin')),('groupParentFuture',entry.get('groupParentPin'))):
        job=entry.get(slot+'Observer')
        if not job:continue
        copy_pin=job.get('filePin') or {}
        _external_require(pin and copy_pin.get('fileId')==pin['fileId'] and
            copy_pin.get('projectId')==pin['projectId'] and copy_pin['version']<=pin['version'],
                          'Copy metadata requires its exact confirmed file identity')
        file=_references_project_file(ctx.app,copy_pin['projectId'],copy_pin['fileId'],copy_pin['version'])
        _external_require(file.isComplete,'Copy metadata owner is unavailable')
        # The description is version-specific: Document.save descriptions on
        # later owned versions do not replace the immutable copy-version marker.
        _external_require(file.description==job['intent']['description'],'Copy description changed outside this operation')
        effects.append({'action':'copyDescriptionVerified','fileId':file.id,'version':int(file.versionNumber),
            'property':'description','markerRetained':True,'owned':True})
    return effects


def _external_inspect_finalize_save(runtime,data,pending):
    """Reconcile a composeNew SaveAs exception only from exact saved native readback."""
    stage='preconditions'
    try:
        manifest=data['manifest'];result=data['result']
        if manifest['mode']!='composeNew' or any(
                manifest.get(key) for key in ('parameterBindings','rootDatums','boundaries','probes')):
            return {'diagnostic':'reconciliationScopeNotQualified'}
        item_id=pending.get('itemId')
        if pending.get('phase')!='finalize' or item_id not in runtime['items']:
            return {'diagnostic':'pendingStepNotFinalSave'}
        entry=runtime['items'][item_id]
        baseline=entry.get('baseline');staged=entry.get('staged') or []
        if baseline is None or not staged:return {'diagnostic':'stagedCoverageMissing'}
        state=result['byItem'][item_id]['phaseResults']['finalize']
        per_instance=len(baseline['bodies'])+1;count=per_instance*len(staged)
        prior_reconciliation=(state.get('status')=='complete' and
            (state.get('receipt') or {}).get('reconciledAfterException') is True and
            state['receipt'].get('cursor')==count+2)
        if not prior_reconciliation and (state.get('status') not in ('pending','unknown') or
                (state.get('receipt') or {}).get('cursor')!=count+1):
            return {'diagnostic':'finalChecksNotAtSaveCheckpoint'}
        expected=['final:'+str(i)+':'+('body:'+str(i%per_instance) if i%per_instance<len(baseline['bodies']) else 'history:poses:attributes')
                  for i in range(count)]
        checks=(state.get('receipt') or {}).get('checks') or []
        if prior_reconciliation:checks=[check for check in checks if check.get('checkId','').startswith('final:')]
        if [check.get('checkId') for check in checks]!=expected or any(check.get('passed') is not True for check in checks):
            return {'diagnostic':'finalChecksIncompleteOrFailed'}
        destination=manifest['destinationDocument'];app=runtime['source'].app
        stage='readRetainedTargetDocument'
        # SaveAs can change creationId even when its retained native document
        # survives. Resolve through that exact object, never a name candidate.
        target=runtime['target'].doc;file=target.dataFile
        if file is None:return {'diagnostic':'savedTargetFileAbsentOrAmbiguous'}
        if (file.isComplete is not True or file.name!=destination['name'] or file.parentProject.id!=destination['projectId'] or
                file.parentFolder.id!=destination['folderId']):return {'diagnostic':'savedTargetIdentityOrCloudIncomplete'}
        if int(file.versionNumber)!=int(runtime.get('saveBaseline',0))+1:
            return {'diagnostic':'savedTargetUnexpectedVersion'}
        stage='findExactOpenTargetDocument'
        docs=[doc for doc in _references_items(app.documents)
              if doc==target and getattr(getattr(doc,'dataFile',None),'id',None)==file.id and not doc.isModified]
        if len(docs)!=1:return {'diagnostic':'savedTargetDocumentUnavailableOrAmbiguous'}
        doc=docs[0]
        if doc.isSaved is not True or doc.dataFile.versionNumber!=file.versionNumber:
            return {'diagnostic':'savedTargetDocumentVersionMismatch'}
        stage='verifyUnchangedSource'
        source=runtime['source'].doc
        if (source.isModified or source.dataFile.id!=manifest['source']['fileId'] or
                int(source.dataFile.versionNumber)!=manifest['source']['version'] or
                _external_fingerprint(runtime['source'])!=runtime['sourceFingerprint']):
            return {'diagnostic':'sourceRecoveryBaselineChanged'}
        stage='verifySavedTargetGeometry'
        target_ctx=_external_ctx(doc);_external_health(target_ctx.root)
        if runtime.get('saveContentFingerprint') is not None and \
                _external_content_fingerprint(target_ctx)!=runtime['saveContentFingerprint']:
            return {'diagnostic':'savedTargetContentChanged'}
        pin=entry['targetPin']
        occurrences=_references_items(target_ctx.root.allOccurrences);matches=[]
        for retained in staged:
            found=[o for o in occurrences if o==retained and o.isReferencedComponent and
                o.documentReference.dataFile.id==pin['fileId'] and int(o.documentReference.version)==pin['version']]
            if len(found)!=1 or any(found[0]==previous for previous in matches):
                return {'diagnostic':'savedTargetLinkCoverageMismatch'}
            matches.append(found[0])
        final_checks=[]
        for instance,occurrence in enumerate(matches):
            plan=_external_stage_insert_plan(target_ctx,runtime['source'],entry['spec'],entry.get('instanceMap',[]),instance,runtime['tolerance'])
            linear,angular=_measure_pose_delta(plan['expectedWorld'][''],list(_entity_occurrence_matrix(target_ctx,occurrence)))
            if linear>runtime['tolerance']['linear'] or angular>runtime['tolerance']['angular']:
                return {'diagnostic':'savedTargetWorldPoseChanged'}
            for check in range(per_instance):
                checked=_external_compare(baseline,occurrence.component,check,runtime['tolerance'],entry['spec'])
                final_checks.append({**checked,'instanceIndex':instance})
        if any(check.get('passed') is not True for check in final_checks):
            return {'diagnostic':'savedTargetFinalChecksFailed'}
        # Other items retain their own finalize phase, but the save checkpoint
        # covers a shared document: recheck every staged definition now.
        for other_id,other in runtime['items'].items():
            if other_id==item_id:continue
            other_baseline=other.get('baseline');other_staged=other.get('staged') or []
            if not other_staged:continue
            if other_baseline is None:return {'diagnostic':'savedTargetOtherItemIncomplete'}
            for occurrence in other_staged:
                other_pin=other['targetPin']
                if (not occurrence.isValid or not occurrence.isReferencedComponent or
                    occurrence.documentReference.dataFile.id!=other_pin['fileId'] or
                    int(occurrence.documentReference.version)!=other_pin['version']):
                    return {'diagnostic':'savedTargetOtherItemIdentityChanged'}
                for check in range(len(other_baseline['bodies'])+1):
                    _external_compare(other_baseline,occurrence.component,check,runtime['tolerance'],other['spec'])
        identity=_references_document_identity(doc)
        if identity.get('fileId')!=file.id or identity.get('projectId')!=destination['projectId'] or \
                identity.get('version')!=file.versionNumber:return {'diagnostic':'savedTargetReadbackIdentityMismatch'}
        receipt={**(state.get('receipt') or {}),'cursor':count+2,'file':_external_pin(file),
            'cloudComplete':True,'targetTimeline':target_ctx.design.timeline.count,
            'retainedChildHistory':baseline['inventory']['history'],'sourceUnchanged':True,
            'savedDocument':identity,'reconciledAfterException':True,'savedTargetFingerprint':_external_fingerprint(target_ctx),
            'checks':[*(state.get('receipt') or {}).get('checks',[]),*[
                {**check,'checkId':'saved:'+check['checkId']} for check in final_checks]]}
        return {'stepId':pending['stepId'],'terminal':True,
                'result':{'status':'complete','receipt':receipt}}
    except Exception as error:
        return {'diagnostic':stage+': '+type(error).__name__+': '+str(error)}


def _external_error_site(error):
    frames=[];trace=error.__traceback__
    while trace is not None:
        frames.append({'function':trace.tb_frame.f_code.co_name,'line':trace.tb_lineno})
        trace=trace.tb_next
    return frames


def _external_observe_accepted_save_as(runtime,data):
    pending=runtime.get('acceptedSaveAsObservation')
    if pending is None:return None
    if data['phase']!='finalize' or data['itemId']!=pending['itemId']:
        return _external_result('blocked',0,notStarted=True,reason='Accepted SaveAs must settle before another action')
    target=runtime['target'];doc=target.doc;destination=data['manifest']['destinationDocument']
    cursor=pending['cursor']
    try:
        _external_require(doc.isValid and doc.creationId==pending['creationId'],'Accepted SaveAs native document changed')
        _external_require(_external_fingerprint(runtime['source'])==runtime['sourceFingerprint'],'Preserved source changed during SaveAs')
        _external_require(_external_content_fingerprint(target)==runtime['saveContentFingerprint'],'Created target content changed during SaveAs')
        file=doc.dataFile
        if file is None or not file.isComplete or doc.isModified:
            return {**_external_result('pending',cursor,saveAccepted=True),'waitingPublication':True}
        _external_require(file.parentProject.id==destination['projectId'] and file.parentFolder.id==destination['folderId'] and
            file.name==destination['name'] and int(file.versionNumber)==runtime['saveBaseline']+1,'Accepted SaveAs destination/version changed')
        fingerprint=_external_fingerprint(target)
    except RuntimeError as error:
        # A known accepted save is observed only; never resubmit or guess IDs.
        return {**_external_result('pending',cursor,saveAccepted=True,observationError=str(error),
            errorSite=_external_error_site(error)),'waitingPublication':True}
    except ValueError as error:
        return _external_result('blocked',cursor,notStarted=True,reason=str(error))
    runtime['targetFingerprint']=fingerprint
    runtime.pop('acceptedSaveAsObservation')
    return None


def _external_refresh_internal(action,data):
    data={**data,'_copyStepStartedAt':time.monotonic()}
    operations=_external_registry(action!='inspect');opid=data['operationId']
    runtime=operations.get(opid)
    if action=='inspect':
        if runtime is None:
            doc,identity=_external_document(adsk.core.Application.get(),data['manifest']['source'],allow_open=False,editable=False)
            return {'status':'unavailable','terminal':False,'reason':'runtimeLost','sourceObservation':identity,'lifecycleEffects':[]}
        _external_require(runtime['requestHash']==data['requestHash'] and runtime['sessionNonce']==data['sessionNonce'],'Operation runtime identity mismatch')
        if runtime.get('preflightPending'):
            return {'status':'observed','terminal':False,'preflightPending':True,'processId':runtime.get('processId'),
                    'lifecycleEffects':[]}
        pending=data.get('result',{}).get('pending')
        receipt=runtime['effects'].get(pending['stepId']) if pending else None
        source_observation={}
        try:
            source_observation={'recordedFingerprint':runtime['sourceFingerprint'],
                'observedFingerprint':_external_fingerprint(runtime['source']),
                'identity':_references_document_identity(runtime['source'].doc)}
        except Exception as error:
            source_observation={'recordedFingerprint':runtime.get('sourceFingerprint'),
                'readbackError':type(error).__name__+': '+str(error)}
        driver_states=[]
        for probe_id,state in runtime.get('probes',{}).items():
            if state.get('stage') not in ('refreshPlan','refreshApply','verifyConsumer'):continue
            try:
                edges=_references_current_edges(runtime['target'] or runtime['source'])
                edge_fields=('edgeId','kind','ownerFileId','sourceFileId','baselineVersion','dataFileVersion',
                    'latestVersion','versionSource','latestVersionSource','latestVersionError','getterError')
                driver_states.append({'probeId':probe_id,'stage':state['stage'],'restoring':state.get('restoring',False),
                    'publishedVersion':state.get('publishedVersion'),'consumerAppliedVersion':state.get('consumerAppliedVersion'),
                    'targetPin':state.get('targetPin'),
                    'baselineEdges':[{k:row.get(k) for k in edge_fields} for row in state.get('baselineEdges',[])],
                    'currentEdges':[{k:row.get(k) for k in edge_fields} for row in edges]})
            except Exception as error:
                driver_states.append({'probeId':probe_id,'stage':state['stage'],
                    'edgeReadbackError':type(error).__name__+': '+str(error)})
        if driver_states:source_observation['driverRefreshStates']=driver_states
        if not receipt or receipt.get('terminal') is not True:
            # Reconcile only this proven read-only failure site, never an
            # arbitrary exception/absence-of-change after a native submission.
            error=str((receipt or {}).get('error',''))
            if (pending and pending.get('phase')=='finalize' and
                    error=='ValueError: Copy description changed outside this operation' and
                    not runtime.get('saveAttempted') and
                    source_observation.get('observedFingerprint')==source_observation.get('recordedFingerprint')):
                entry=runtime['items'][pending['itemId']]
                state=data['result']['byItem'][pending['itemId']]['phaseResults']['finalize']
                if (state.get('receipt') or {}).get('cursor')==0:
                    # This exact guard precedes all finalize metadata/model/save
                    # writes. Verify the original copy versions, never reset the
                    # failed receipt or re-submit an earlier modeling step.
                    evidence=_external_verify_copy_descriptions(runtime['target'] or runtime['source'],entry)
                    return {'status':'observed','stepId':pending['stepId'],'terminal':True,
                        'result':{**_external_result('blocked',0,notStarted=True,reason=error,
                            copyVersionEvidence=evidence),'notStarted':True},
                        'sourceObservation':source_observation,'lifecycleEffects':[], 'modelMutationSubmitted':False}
            if (pending and pending.get('phase')=='verify:assembly' and
                    error=='ValueError: Exact owned consumer editor remains after close request'):
                states=[s for s in runtime.get('probes',{}).values() if
                    s.get('stage') in ('publishObserve','restoreObserve') and
                    s.get('publishedVersion')==s.get('source',{}).get('version')]
                if len(states)==1:
                    pin=states[0]['source'];app=runtime['source'].app
                    present=[d for d in _references_items(app.documents) if
                        getattr(getattr(d,'dataFile',None),'id',None)==pin['fileId']]
                    file=_references_project_file(app,pin['projectId'],pin['fileId'],pin['version'])
                    if not present and file.isComplete and file.versionNumber==pin['version']:
                        cursor=(data['result']['byItem'][pending['itemId']]['phaseResults']['verify']['assembly'].get('receipt') or {}).get('cursor',0)
                        return {'status':'observed','stepId':pending['stepId'],'terminal':True,
                            'result':_external_result('pending',cursor,producerCloseObserved=True,publishedSource=pin),
                            'sourceObservation':source_observation,'lifecycleEffects':[]}
            if (pending and pending.get('phase')=='verify:assembly' and
                    error=='ValueError: Entity token: expected one match, found 0' and
                    not runtime.get('probes') and
                    source_observation.get('observedFingerprint')==source_observation.get('recordedFingerprint')):
                entry=runtime['items'][pending['itemId']]
                cursor=(data['result']['byItem'][pending['itemId']]['phaseResults']['verify']['assembly'].get('receipt') or {}).get('cursor',0)
                probes=[p for p in data['manifest'].get('probes',[]) if p['itemId']==pending['itemId'] and
                        p.get('scope','assembly')=='assembly']
                if probes and cursor==len(entry['baseline']['bodies'])+1:
                    # At this exact checkpoint token resolution occurs in the
                    # read-only check preflight, before source activation/state.
                    return {'status':'observed','stepId':pending['stepId'],'terminal':True,
                        'result':{**_external_result('blocked',cursor,notStarted=True,reason=error),'notStarted':True},
                        'sourceObservation':source_observation,'lifecycleEffects':[], 'modelMutationSubmitted':False}
            if (pending and pending.get('phase')=='stage' and
                    error.startswith('ValueError: Existing owned Derive identity is unresolved; refusing to create/reselect:') and
                    source_observation.get('observedFingerprint')==source_observation.get('recordedFingerprint') and
                    source_observation.get('identity',{}).get('modified') is False):
                cursor=(data['result']['byItem'][pending['itemId']]['phaseResults']['stage'].get('receipt') or {}).get('cursor',0)
                return {'status':'observed','stepId':pending['stepId'],'terminal':True,
                    'result':{**_external_result('blocked',cursor,notStarted=True,reason=error),'notStarted':True},
                    'sourceObservation':source_observation,'lifecycleEffects':[], 'modelMutationSubmitted':False}
            reconciled=_external_inspect_finalize_save(runtime,data,pending or {})
            if reconciled and reconciled.get('terminal') is True:
                return {**reconciled,'status':'observed','processId':runtime['processId'],
                    'lifecycleEffects':[],'compensation':runtime['compensation']}
            if reconciled:receipt={**(receipt or {}),'inspectionDiagnostic':reconciled['diagnostic']}
        return {**(receipt or {}),'status':'observed','processId':runtime['processId'],
                'lifecycleEffects':[],'compensation':runtime['compensation'],
                'sourceObservation':source_observation}
    if runtime is None:
        prior_states=[s for item in data['result']['byItem'].values()
            for s in [item['phaseResults']['copy'],item['phaseResults']['stage']]]
        progressed=[s for s in prior_states if s['status']!='notStarted']
        safe_preflight=bool(progressed) and all(
            s['status']=='pending' and (s.get('receipt') or {}).get('preflightPending') is True or
            s['status']=='blocked' and (s.get('receipt') or {}).get('notStarted') is True and
                (s.get('receipt') or {}).get('cursor')==0 for s in progressed)
        if progressed and not safe_preflight:
            return _external_result('unknown',0,reason='runtimeLost; no recreation')
        try:runtime=_external_initial(data)
        except _ExternalTimelineRestoreError as error:return _external_result('unknown',0,reason=str(error))
        except Exception as error:return _external_result('blocked',0,reason=type(error).__name__+': '+str(error),notStarted=True)
        if runtime.get('_externalPending') is not None:
            initial_output=runtime['_externalPending']
            if initial_output.get('status')=='pending' and initial_output.get('receipt',{}).get('preflightPending') is True:
                operations[opid]={'requestHash':data['requestHash'],'sessionNonce':data['sessionNonce'],
                                  'preflightPending':True,'sourcePin':initial_output['receipt'].get('sourcePin')}
            return initial_output
        operations[opid]=runtime
    elif runtime.get('preflightPending'):
        try:initialized=_external_initial(data)
        except _ExternalTimelineRestoreError as error:return _external_result('unknown',0,reason=str(error))
        except Exception as error:return _external_result('blocked',0,reason=type(error).__name__+': '+str(error),notStarted=True)
        if initialized.get('_externalPending') is not None:
            initial_output=initialized['_externalPending']
            if initial_output.get('status')!='pending' or initial_output.get('receipt',{}).get('preflightPending') is not True:
                operations.pop(opid,None)
            return initial_output
        runtime=initialized;operations[opid]=runtime
    _external_require(runtime['requestHash']==data['requestHash'] and runtime['sessionNonce']==data['sessionNonce'],'Immutable operation mismatch')
    step_id=data['stepId']
    if step_id in runtime['effects']:
        return _external_result('unknown',0,reason='Effect already submitted; inspect original receipt, never replay')
    observed=_external_observe_accepted_save_as(runtime,data)
    if observed is not None:
        runtime['effects'][step_id]={'stepId':step_id,'terminal':True,'result':observed}
        return observed
    initial_effects=runtime.pop('initialLifecycleEffects',[])
    entry=runtime['items'][data['itemId']]
    phase=data['phase']
    if runtime['sourceFingerprint']!=_external_fingerprint(runtime['source']):
        if phase=='finalize' and (_external_inplace_save_is_settled(runtime) or _external_inplace_save_is_pending(runtime,data)):
            runtime['sourceFingerprint']=_external_fingerprint(runtime['source'])
        elif phase.startswith('verify:') and _external_probe_refresh_checkpoint(runtime,data):
            runtime['sourceFingerprint']=_external_fingerprint(runtime['source'])
        else:
            return _external_with_lifecycle(_external_result('blocked',0,notStarted=True,
                reason='staleEvidence: source changed outside operation'),initial_effects)
    if runtime['target'] is not None and runtime.get('targetFingerprint') is not None:
        current_target_fingerprint=_external_fingerprint(runtime['target'])
        if runtime['targetFingerprint']!=current_target_fingerprint:
            saved_receipts=[row['phaseResults']['finalize'] for row in data['result']['byItem'].values()]
            target_save={**runtime,'source':runtime['target']}
            reconciled=(phase=='finalize' and (_external_inplace_save_is_settled(target_save) or
                _external_inplace_save_is_pending(target_save,data))) or any(row['status']=='complete' and
                (row.get('receipt') or {}).get('reconciledAfterException') is True and
                row['receipt'].get('savedTargetFingerprint')==current_target_fingerprint for row in saved_receipts)
            if not reconciled:
                for saved_id,saved_item in data['result']['byItem'].items():
                    saved=saved_item['phaseResults']['finalize'];proof=saved.get('receipt') or {}
                    if saved['status']!='complete' or proof.get('reconciledAfterException') is not True or 'savedTargetFingerprint' in proof:continue
                    observed=_external_inspect_finalize_save(runtime,data,{'phase':'finalize','itemId':saved_id,'stepId':None})
                    if observed.get('terminal') is True and observed['result']['receipt'].get('savedTargetFingerprint')==current_target_fingerprint:
                        reconciled=True;break
            if not reconciled:
                return _external_with_lifecycle(_external_result('blocked',0,notStarted=True,
                    reason='staleEvidence: created target changed outside operation'),initial_effects)
            runtime['targetFingerprint']=current_target_fingerprint
    state=data['result']['byItem'][data['itemId']]['phaseResults']
    state=state['verify'][phase.split(':')[1]] if phase.startswith('verify:') else state[phase]
    cursor=(state.get('receipt') or {}).get('cursor',0)
    if data.get('outerReadOnly') and not phase.startswith('verify:'):
        return _external_result('blocked',cursor,reason='outerReadOnly')
    runtime['effects'][step_id]={'stepId':step_id,'terminal':False,'nativeOutcome':'unknown'}
    try:
        function={'copy':_external_copy,'verify:sources':_external_verify,'verify:assembly':_external_verify,
            'stage':_external_stage,'retire':_external_retire,'finalize':_external_finalize}[phase]
        output=function(runtime,data,entry,cursor)
        output=_external_with_lifecycle(output,initial_effects)
        accepted_save_as=(data['manifest']['mode']=='composeNew' and phase=='finalize' and runtime.get('saveBaseline')==0 and
            output['status']=='pending' and output['receipt'].get('saveAccepted') is True)
        if accepted_save_as:
            runtime['acceptedSaveAsObservation']={'itemId':data['itemId'],'cursor':output['receipt']['cursor'],
                'creationId':output['receipt']['creationId']}
            output['waitingPublication']=True
        try:
            runtime['sourceFingerprint']=_external_fingerprint(runtime['source'])
            if runtime['target'] is not None:runtime['targetFingerprint']=_external_fingerprint(runtime['target'])
        except RuntimeError as error:
            if not accepted_save_as:raise
            output['receipt']['observationError']=type(error).__name__+': '+str(error)
            output['receipt']['errorSite']=_external_error_site(error)
            output['waitingPublication']=True
        runtime['effects'][step_id]={'stepId':step_id,'terminal':output['status']!='unknown','result':output}
        return output
    except Exception as error:
        # Do not reinterpret an exception after native entry as notStarted.
        geometry_read=phase.startswith('verify:') and cursor<len((entry.get('baseline') or {}).get('bodies',[]))+1
        output=_external_with_lifecycle(_external_result('failed' if geometry_read else 'unknown',cursor,
            reason=type(error).__name__+': '+str(error),errorSite=_external_error_site(error)),initial_effects)
        if geometry_read:runtime['effects'][step_id]={'stepId':step_id,'terminal':True,'result':output}
        else:runtime['effects'][step_id]['error']=output['receipt']['reason']
        return output


def _external_insert_matrix(ctx,data,matrix,project_id):
    return _external_insert(ctx,data,project_id,matrix)


def _external_boundary_endpoint_preflight(endpoint,item_ids,group_ids,datum_names):
    _cad_fields(endpoint,(),('itemId','instanceIndex','memberIndex','relativePath','occurrence','originName','rootDatum','componentOrigin'))
    identities=[key for key in ('itemId','occurrence','rootDatum') if endpoint.get(key) is not None]
    _external_require(len(identities)==1,'Boundary endpoint requires exactly one itemId, occurrence or rootDatum identity')
    _external_require(endpoint.get('componentOrigin') is None or type(endpoint['componentOrigin']) is bool,
                      'componentOrigin must be boolean')
    if endpoint.get('itemId'):
        _external_require(endpoint['itemId'] in item_ids,'Unknown boundary itemId')
        _external_require(not ('instanceIndex' in endpoint and 'memberIndex' in endpoint),
                          'Boundary endpoint cannot combine instanceIndex and memberIndex')
        _external_require('memberIndex' not in endpoint or endpoint['itemId'] in group_ids,
                          'memberIndex is only valid for an extraction-group item')
        if endpoint['itemId'] in group_ids:
            _external_require(isinstance(endpoint.get('relativePath'),str) and endpoint['relativePath'] and
                              'instanceIndex' not in endpoint,
                              'Grouped boundary requires an exact member relativePath, not a staged instance index')
        for key in ('instanceIndex','memberIndex'):
            if key in endpoint:_external_require(type(endpoint[key]) is int and endpoint[key]>=0,key+' must be a nonnegative index')
        if 'relativePath' in endpoint:
            _external_require(isinstance(endpoint['relativePath'],str) and endpoint['relativePath'],
                              'relativePath must be an exact nonempty child path')
    elif endpoint.get('occurrence') is not None:
        occurrence=endpoint['occurrence']
        _external_require(isinstance(occurrence,dict) and occurrence.get('kind')=='occurrence' and
                          isinstance(occurrence.get('token'),str) and occurrence['token'] and
                          isinstance(occurrence.get('path'),str) and occurrence['path'],
                          'Outside boundary occurrence requires an exact token, kind and context path')
        _external_require(not any(key in endpoint for key in ('instanceIndex','memberIndex','relativePath')),
                          'Occurrence endpoint cannot use item-relative indexes or paths')
    else:
        _external_require(isinstance(endpoint['rootDatum'],str) and endpoint['rootDatum'] in datum_names,
                          'Boundary rootDatum must name a declared root datum')
        _external_require(not any(key in endpoint for key in ('instanceIndex','memberIndex','relativePath','occurrence','originName')),
                          'rootDatum endpoint cannot include another context identity')


def _external_validate_root_datums(ctx,manifest):
    names=set();available=set()
    if manifest['mode']!='composeNew':
        available.update(str(p.name) for p in _references_items(ctx.design.allParameters) if getattr(p,'name',None))
    available.update(binding['consumerAlias'] for binding in manifest.get('parameterBindings',[])
                     if isinstance(binding,dict) and isinstance(binding.get('consumerAlias'),str))
    for datum in manifest.get('rootDatums',[]):
        _cad_fields(datum,('name','offsetX','offsetY','offsetZ','angle','isFlipped','xAxis','zAxis','parameters'))
        _external_require(isinstance(datum['name'],str) and datum['name'] and datum['name'] not in names,
                          'Root datum names must be unique and nonempty')
        names.add(datum['name'])
        if manifest['mode']!='composeNew':
            _external_require(ctx.root.jointOrigins.itemByName(datum['name']) is None,
                              'Root datum name already exists in the mutable destination')
        _external_require(all(isinstance(datum[key],str) and datum[key] for key in ('offsetX','offsetY','offsetZ','angle')),
                          'Root datum offsets and angle require explicit expressions')
        _external_require(type(datum['isFlipped']) is bool,'Root datum isFlipped must be boolean')
        _external_require(datum['xAxis'] in ('x','y','z') and datum['zAxis'] in ('x','y','z') and
                          datum['xAxis']!=datum['zAxis'],'Finite root-origin datum requires distinct declared native root axes')
        _external_require(isinstance(datum['parameters'],list),'Root datum needs explicit expression dependency map')
        local_names=set()
        for parameter in datum['parameters']:
            _cad_fields(parameter,('name','expression','unit','dependsOn'))
            _external_require(isinstance(parameter['name'],str) and parameter['name'] and parameter['name'] not in local_names,
                              'Datum parameter names must be unique and nonempty')
            _external_require(isinstance(parameter['expression'],str) and parameter['expression'] and
                              isinstance(parameter['unit'],str),'Datum parameter needs an explicit expression and unit')
            dependencies=parameter['dependsOn']
            _external_require(isinstance(dependencies,list) and all(isinstance(name,str) and name for name in dependencies) and
                              len(set(dependencies))==len(dependencies),'Datum dependsOn must be unique parameter names')
            _external_require(all(name in available for name in dependencies),'Datum dependency map is not topologically ordered')
            if manifest['mode']!='composeNew':
                existing=ctx.design.userParameters.itemByName(parameter['name'])
                if existing is not None:
                    _external_require(existing.expression==parameter['expression'] and existing.unit==parameter['unit'],
                                      'Root datum parameter conflicts with the saved destination precondition')
            local_names.add(parameter['name']);available.add(parameter['name'])


def _external_preflight_boundaries(runtime,manifest):
    ctx=runtime['source'];declared={};runtime['boundaries']=[];runtime['boundariesCreated']=False
    roots=[o.fullPathName for entry in runtime['items'].values() for o in entry['originals']]
    item_ids=set(runtime['items']);group_ids={item['itemId'] for item in manifest['items'] if item.get('groupId')}
    _external_validate_root_datums(ctx,manifest)
    boundary_ids=set();datum_names={datum['name'] for datum in manifest.get('rootDatums',[])}
    for spec in manifest.get('boundaries',[]):
        _cad_fields(spec,('id','joint','endpoints'))
        _external_require(isinstance(spec['id'],str) and spec['id'] and spec['id'] not in boundary_ids,
                          'Boundary id must be unique and nonempty')
        boundary_ids.add(spec['id'])
        _external_require(isinstance(spec['endpoints'],list) and len(spec['endpoints'])==2,'Boundary needs two explicit endpoint mappings')
        for endpoint in spec['endpoints']:
            _external_boundary_endpoint_preflight(endpoint,item_ids,group_ids,datum_names)
        joint=_external_joint(ctx,spec['joint'])
        _external_require(_cad_type(joint) in ('Joint','AsBuiltJoint'),'Unsupported native joint form')
        kind=int(joint.jointMotion.jointType)
        _external_require(kind in (0,1),'Only native rigid and revolute migration boundaries are supported')
        _external_require(joint.healthState==0,'Unhealthy boundary joint')
        _external_require(joint.entityToken not in declared,'Duplicate boundary mapping')
        declared[joint.entityToken]=spec
        row={'spec':spec,'old':joint,'token':joint.entityToken,'kind':kind,'form':_cad_type(joint),
             'name':joint.name,'attrs':_external_attributes(joint),'detached':False,'new':None,
             'offset':joint.offset.expression if hasattr(joint,'offset') else None,
             'angle':joint.angle.expression if hasattr(joint,'angle') else None,
             'flipped':bool(joint.isFlipped) if hasattr(joint,'isFlipped') else None,
             'endpoints':[]}
        if row['form']=='AsBuiltJoint':
            _external_require(all(endpoint.get('itemId') or endpoint.get('occurrence') for endpoint in spec['endpoints']),
                              'As-built boundaries require mapped occurrence endpoints, not JointOrigin datums')
        for index,endpoint in enumerate(spec['endpoints']):
            old=getattr(joint,'occurrenceOne' if index==0 else 'occurrenceTwo')
            if endpoint.get('itemId'):
                item=runtime['items'][endpoint['itemId']]
                number=endpoint.get('memberIndex',endpoint.get('instanceIndex',0))
                _external_require(type(number) is int and 0<=number<len(item['originals']),'Boundary instance index outside captured instanceMap')
                _external_require(old==item['originals'][number],'Boundary mapping does not identify the captured endpoint')
            else:
                _external_require(endpoint.get('rootDatum') or endpoint.get('occurrence'),'Outside endpoint needs exact occurrence or declared rootDatum')
                if endpoint.get('occurrence'):_external_require(_external_occurrence(ctx,endpoint['occurrence'])==old,'Outside endpoint mismatch')
            if row['form']=='Joint':
                geometry=getattr(joint,'geometryOrOriginOne' if index==0 else 'geometryOrOriginTwo')
                if _cad_type(geometry)=='JointOrigin':
                    _external_require(endpoint.get('originName') or endpoint.get('rootDatum'),'Native JointOrigin requires an explicit target origin mapping')
                    row['endpoints'].append({'transform':list((getattr(geometry,'nativeObject',None) or geometry).transform.asArray())})
                else:
                    native=getattr(geometry.entityOne,'nativeObject',None) or geometry.entityOne
                    _external_require(old is not None and native==old.component.originConstructionPoint and endpoint.get('componentOrigin') is True,
                                      'Only declared component-origin JointGeometry is supported')
                    row['endpoints'].append({'componentOrigin':True})
            else:row['endpoints'].append({})
            if old is not None:
                row['endpoints'][-1].update(componentAttributes=_external_attributes(old.component),componentName=old.component.name)
        if kind==1:
            motion=joint.jointMotion
            row['rotationAxis']=motion.rotationAxis;row['rotationValue']=float(motion.rotationValue)
            directions=adsk.fusion.JointDirections
            _external_require(row['rotationAxis'] in (directions.XAxisJointDirection,directions.YAxisJointDirection,directions.ZAxisJointDirection),
                              'Custom direction entity must be represented by an explicitly mapped JointOrigin frame before migration')
            row['limits']={key:getattr(motion.rotationLimits,key) for key in
                ('minimumValue','maximumValue','restValue','isMinimumValueEnabled','isMaximumValueEnabled','isRestValueEnabled')}
            _external_require(row['form']=='Joint','As-built arbitrary-axis revolute is not a qualified SDK form; use a regular native boundary')
        runtime['boundaries'].append(row)
    # Boundary coverage is explicit; never silently drop an unmapped source joint.
    for component in _references_own_components(ctx.root):
        for collection in (component.joints,component.asBuiltJoints):
            for joint in _references_items(collection):
                endpoint_paths=[o.fullPathName for o in (joint.occurrenceOne,joint.occurrenceTwo) if o is not None]
                touches=any(any(p==r or p.startswith(r+'+') for r in roots) for p in endpoint_paths)
                internal=any(component==entry['component'] for entry in runtime['items'].values())
                if touches and not internal:_external_require(joint.entityToken in declared,'Affected boundary joint omitted from immutable interface map')
    for binding in manifest.get('parameterBindings',[]):
        _cad_fields(binding,('source','sourceParameter','consumerAlias'),('nativeDerivedParameter','unit','existingExpression','targetItemId'))
        if binding.get('targetItemId'):
            _external_require(binding['targetItemId'] in runtime['items'] and manifest.get('save') is True,
                              'Item binding requires an authorized target item and publication')
        source=binding['source']
        if 'itemId' in source:
            _cad_fields(source,('itemId',));_external_require(source['itemId'] in runtime['items'],'Unknown binding source itemId')
        else:
            _cad_fields(source,('projectId','dataFileId','version'),('creationId','context'))
            _external_require(type(source['version']) is int and source['version']>0,'Binding source must pin an exact version')
            _external_require(source.get('context') in (None,'topLevel'),'Binding source context must be topLevel when specified')
        if manifest['mode']!='composeNew' and not binding.get('targetItemId'):
            existing=ctx.design.userParameters.itemByName(binding['consumerAlias'])
            if existing is not None:
                _external_require(binding.get('existingExpression')==existing.expression,'Existing alias requires its exact declared expression precondition')
def _external_bindings_stage(runtime,data,entry,cursor):
    ctx=runtime['target'] or runtime['source'];m=data['manifest']
    publication=runtime.get('itemBindingPublication')
    if publication:
        owner=publication['ctx'];item=runtime['items'][publication['itemId']]
        effects=_external_activate(owner)
        if not publication['submitted'] and owner.doc.isModified:
            publication['submitted']=True
            _external_require(owner.doc.save('Authorized native item parameter binding '+data['operationId']),
                              'Item binding save not accepted')
            return _external_with_lifecycle(_external_result('pending',cursor+1,itemBindingSaveAccepted=True),effects)
        file=owner.doc.dataFile
        if owner.doc.isModified or not file.isComplete or publication['submitted'] and file.versionNumber<=publication['beforeVersion']:
            _external_refresh_complete(file)
            return {**_external_result('pending',cursor,itemBindingPublication=True),'waitingPublication':True}
        _external_require(file.id==publication['fileId'],'Item binding changed lineage')
        item['targetPin']=_external_pin(file,owner.doc.creationId)
        item['targetPin']['context']='topLevel'
        effects.append(_external_close_owned_clean_doc(owner,item['targetPin']))
        runtime['itemBindingPublication']=None
        return _external_with_lifecycle(_external_result('pending',cursor+1,
            itemBindingPublication={'itemId':publication['itemId'],'file':item['targetPin'],'cloudComplete':True}),effects)
    done=runtime.setdefault('bindingProgress',set());bindings=runtime.setdefault('derivedBindings',[])
    for index,spec in enumerate(m.get('parameterBindings',[])):
        key='parameter:'+str(index)
        if key in done:continue
        target_item=runtime['items'].get(spec.get('targetItemId'))
        target_effects=[]
        if target_item is not None:
            target_pin=target_item.get('targetPin')
            if target_pin is None:return {**_external_result('pending',cursor+1,awaitingItems=[spec['targetItemId']]),'defer':True}
            target_doc,target_effect=_external_owned_document(runtime,target_pin)
            _external_require(target_doc is not None and not target_doc.isModified,
                              'Item binding requires its exact clean owned saved editor')
            ctx=_external_ctx(target_doc);target_effects=target_effect.get('lifecycleEffects',[])
        source=spec['source']
        if source.get('itemId') and runtime['items'][source['itemId']]['targetPin'] is None:
            return {**_external_result('pending',cursor+1,localStaged=False,awaitingItems=[source['itemId']]),'defer':True}
        pin=_external_source_pin(runtime,source,True)
        source_file=_references_project_file(ctx.app,pin['projectId'],pin['fileId'],pin['version'])
        if not _external_refresh_complete(source_file):
            return {**_external_result('pending',cursor,target=_external_pin(source_file),reason='pendingPublication'),
                    'waitingPublication':True}
        doc,effect=_external_owned_document(runtime,pin)
        _external_require(doc is not None,str(effect));sd=_external_ctx(doc).design
        parameters=[p for p in _references_items(sd.userParameters) if p.name==spec['sourceParameter'] and p.isFavorite]
        parameter=_cad_unique(parameters,'exact exported favorite USER parameter')
        if 'unit' in spec:_external_require(spec['unit']==parameter.unit,'Declared binding unit differs from exported parameter')
        before_alias=ctx.design.userParameters.itemByName(spec['consumerAlias'])
        if before_alias is not None and (before_alias.expression!=spec.get('existingExpression') or
                before_alias.unit!=parameter.unit or abs(before_alias.value-parameter.value)>=1e-9):
            return _external_with_lifecycle({**_external_result('blocked',cursor,notStarted=True,
                reason='Existing alias does not match its declared precondition',
                observedExpression=before_alias.expression),'notStarted':True},target_effects+effect.get('lifecycleEffects',[]))
        _external_health(ctx.root);activation_effects=_external_activate(ctx)
        derive_key=(ctx.doc.creationId,pin['fileId'],pin['version'])
        feature=runtime.setdefault('deriveSources',{}).get(derive_key)
        if feature is None:
            try:feature=_external_existing_derive(ctx,pin)
            except ValueError as error:
                return _external_with_lifecycle({**_external_result('blocked',cursor,notStarted=True,reason=str(error)),
                    'notStarted':True},[*effect.get('lifecycleEffects',[]),*activation_effects])
        if feature is None:
            marker=ctx.design.timeline.markerPosition
            before_helpers={o.entityToken for o in _references_items(ctx.root.occurrences)}
            try:
                ctx.design.timeline.markerPosition=0
                inp=ctx.root.features.deriveFeatures.createInput(sd)
                inp.isIncludeFavoriteParameters=True;inp.isIncludeComponentParameters=False
                inp.sourceEntities=[inp.sourceDesign.rootComponent]
                feature=_cad_require_result(ctx.root.features.deriveFeatures.add(inp),'Create initial native Derive')
                feature.attributes.add('fmcad.externalization','role','declaredParameterReference')
            finally:ctx.design.timeline.markerPosition=ctx.design.timeline.count if marker==0 else min(marker+1,ctx.design.timeline.count)
            runtime['deriveSources'][derive_key]=feature
            for occurrence in _references_items(ctx.root.occurrences):
                if occurrence.entityToken not in before_helpers:
                    _external_require(occurrence.isDerived,'Unexpected non-Derive occurrence created by parameter binding')
                    _external_ensure_attributes(occurrence,[('fmcad.externalization','role','declaredParameterReference')])
                    runtime.setdefault('referenceHelpers',[]).append({'ref':ctx.ref(occurrence),'source':pin,
                        **({'ownerFileId':ctx.doc.dataFile.id} if target_item is not None else {}),
                        'role':'reference','bodyDefinitions':occurrence.component.bRepBodies.count})
        actual=[p for p in _references_items(ctx.design.derivedParameters) if p.deriveFeature==feature]
        if spec.get('nativeDerivedParameter'):actual=[p for p in actual if p.name==spec['nativeDerivedParameter']]
        else:
            # Cardinality is authoritative for a single exported parameter. For
            # multi-parameter sources callers must map observed names explicitly.
            _external_require(len([p for p in _references_items(sd.userParameters) if p.isFavorite])==1,
                              'Multiple favorite parameters require explicit actual nativeDerivedParameter mapping; no suffix guessing')
        dp=_cad_unique(actual,'actual created DerivedParameter')
        _external_require(dp.unit==parameter.unit and abs(dp.value-parameter.value)<1e-9,'Native binding value/unit differs from independent source')
        alias=ctx.design.userParameters.itemByName(spec['consumerAlias'])
        if alias is not None:
            _external_require(alias.expression==spec.get('existingExpression') and alias.unit==parameter.unit and
                              abs(alias.value-parameter.value)<1e-9,'Existing alias does not match its declared precondition')
            if alias.expression!=dp.name:alias.expression=dp.name
        else:alias=ctx.design.userParameters.add(spec['consumerAlias'],adsk.core.ValueInput.createByString(dp.name),parameter.unit,'Native external interface')
        _external_require(alias.expression==dp.name and abs(alias.value-parameter.value)<1e-9,'Alias is not a verified native binding')
        bindings.append({'sourceFileId':pin['fileId'],'sourceParameter':parameter.name,'nativeDerivedParameter':dp.name,
            'consumerAlias':alias.name,'featureToken':feature.entityToken,
            **({'targetItemId':spec['targetItemId'],'ownerFileId':ctx.doc.dataFile.id} if target_item is not None else {})})
        if target_item is not None:
            _external_require(ctx.design.computeAll(),'Item binding recompute failed')
            runtime['itemBindingPublication']={'ctx':ctx,'itemId':spec['targetItemId'],
                'fileId':ctx.doc.dataFile.id,'beforeVersion':ctx.doc.dataFile.versionNumber,'submitted':False}
        done.add(key)
        return _external_with_lifecycle(_external_result('pending',cursor+1,binding=bindings[-1]),
                                        [*target_effects,*effect.get('lifecycleEffects',[]),*activation_effects])
    for index,spec in enumerate(m.get('rootDatums',[])):
        key='datum:'+str(index)
        if key in done:continue
        for p in spec['parameters']:
            _external_require(all(ctx.design.allParameters.itemByName(name) is not None for name in p['dependsOn']), 'Datum dependency map is not topologically ordered')
            existing=ctx.design.userParameters.itemByName(p['name'])
            if existing:_external_require(existing.expression==p['expression'] and existing.unit==p['unit'],'Conflicting datum parameter')
            else:ctx.design.userParameters.add(p['name'],adsk.core.ValueInput.createByString(p['expression']),p['unit'],'Declared root datum')
        _external_require(ctx.root.jointOrigins.itemByName(spec['name']) is None,'Root datum collision')
        geometry=adsk.fusion.JointGeometry.createByPoint(ctx.root.originConstructionPoint)
        inp=ctx.root.jointOrigins.createInput(geometry)
        inp.xAxisEntity=getattr(ctx.root,spec['xAxis']+'ConstructionAxis');inp.zAxisEntity=getattr(ctx.root,spec['zAxis']+'ConstructionAxis')
        for prop in ('offsetX','offsetY','offsetZ','angle'):setattr(inp,prop,adsk.core.ValueInput.createByString(spec[prop]))
        inp.isFlipped=spec['isFlipped'];origin=ctx.root.jointOrigins.add(inp);origin.name=spec['name']
        done.add(key);return _external_with_lifecycle(_external_result('pending',cursor+1,datum=ctx.ref(origin)),
                                                       _external_activate(ctx))
    runtime['bindingsCreated']=True
    return _external_with_lifecycle(_external_result('pending',cursor+1,parameterBindings=bindings),_external_activate(ctx))


def _external_endpoint(runtime,ctx,endpoint,captured,require_geometry=True):
    if endpoint.get('rootDatum'):
        _external_require(require_geometry,'As-built boundary endpoints require occurrence contexts, not root datums')
        origin=_cad_require_result(ctx.root.jointOrigins.itemByName(endpoint['rootDatum']),'Declared root datum')
        if captured.get('transform'):
            linear,angular=_measure_pose_delta(captured['transform'],list(origin.transform.asArray()))
            _external_require(linear<=runtime['tolerance']['linear'] and angular<=runtime['tolerance']['angular'],'Declared root datum differs from the captured source frame')
        return origin,None
    if endpoint.get('itemId'):
        item=runtime['items'][endpoint['itemId']]
        if item.get('spec',{}).get('groupId'):
            _external_require(len(item['staged'])==1 and endpoint.get('relativePath'),
                              'Grouped endpoint requires one staged group and an explicit member path')
            i=0
        else:i=endpoint.get('instanceIndex',0)
        _external_require(i<len(item['staged']),'Endpoint target instance not staged')
        occ=item['staged'][i]
    else:occ=_external_occurrence(ctx,endpoint['occurrence'])
    if endpoint.get('relativePath'):
        occ=_cad_unique([o for o in _references_items(ctx.root.allOccurrences)
            if o.fullPathName==occ.fullPathName+'+'+endpoint['relativePath']],'explicit mapped child endpoint')
        _external_require(occ.component.name==captured['componentName'],'Mapped child definition name differs from source provenance')
    _external_require(_external_attributes(occ.component)==captured.get('componentAttributes',_external_attributes(occ.component)),
                      'Mapped endpoint component attributes differ')
    if not require_geometry:return None,occ
    if endpoint.get('componentOrigin'):
        return adsk.fusion.JointGeometry.createByPoint(occ.component.originConstructionPoint.createForAssemblyContext(occ)),occ
    origin=_cad_require_result(occ.component.jointOrigins.itemByName(endpoint['originName']),'Mapped target JointOrigin')
    linear,angular=_measure_pose_delta(captured['transform'],list(origin.transform.asArray()))
    _external_require(linear<=runtime['tolerance']['linear'] and angular<=runtime['tolerance']['angular'],'Target origin frame differs from captured source')
    return origin.createForAssemblyContext(occ),occ


def _external_boundary_readback(runtime,ctx,row):
    joint=row['new'];_external_require(joint.healthState==0 and int(joint.jointMotion.jointType)==row['kind'],
                                      'Final boundary health/type differs')
    endpoints=[_external_endpoint(runtime,ctx,s,c,require_geometry=row['form']!='AsBuiltJoint')
               for s,c in zip(row['spec']['endpoints'],row['endpoints'])]
    _external_require([joint.occurrenceOne,joint.occurrenceTwo]==[value[1] for value in endpoints],
                      'Final boundary endpoint context differs')
    _external_require(_external_attributes(joint)==row['attrs'],'Final boundary attributes differ')
    for key in ('offset','angle'):
        if row.get(key) is not None:_external_require(getattr(joint,key).expression==row[key],'Final boundary expression differs')
    if row.get('flipped') is not None:_external_require(bool(joint.isFlipped)==row['flipped'],'Final boundary flip differs')
    if row['kind']==1:
        motion=joint.jointMotion
        _external_require(int(motion.rotationAxis)==int(row['rotationAxis']) and
            abs(motion.rotationValue-row['rotationValue'])<=runtime['tolerance']['angular'],'Final revolute axis/nominal differs')
        _external_require(all(getattr(motion.rotationLimits,k)==v for k,v in row['limits'].items()),'Final revolute stored limits differ')


def _external_rebuild_joint(runtime,ctx,row):
    endpoints=[_external_endpoint(runtime,ctx,s,c,require_geometry=row['form']!='AsBuiltJoint')
               for s,c in zip(row['spec']['endpoints'],row['endpoints'])]
    if row['form']=='AsBuiltJoint':
        _external_require(row['kind']==0 and all(o is not None for g,o in endpoints),'Unsupported as-built boundary form')
        inp=ctx.root.asBuiltJoints.createInput(endpoints[0][1],endpoints[1][1],None)
        inp.setAsRigidJointMotion();joint=ctx.root.asBuiltJoints.add(inp)
    else:
        inp=ctx.root.joints.createInput(endpoints[0][0],endpoints[1][0])
        if row['kind']==0:inp.setAsRigidJointMotion()
        else:inp.setAsRevoluteJointMotion(row['rotationAxis'])
        inp.offset=adsk.core.ValueInput.createByString(row['offset']);inp.angle=adsk.core.ValueInput.createByString(row['angle']);inp.isFlipped=row['flipped']
        joint=ctx.root.joints.add(inp)
    _external_require(joint is not None and joint.healthState==0,'Boundary reconstruction failed')
    joint.name=row['name']
    for index,target in enumerate(endpoints):
        actual=getattr(joint,'occurrenceOne' if index==0 else 'occurrenceTwo')
        _external_require((actual is None and target[1] is None) or actual==target[1],
                          'Rebuilt joint endpoint context differs from the explicit mapping')
    _external_ensure_attributes(joint,row['attrs'])
    if hasattr(joint,'isFlipped'):
        _external_require(bool(joint.isFlipped)==row['flipped'],'Rebuilt joint flip state differs')
    for key in ('offset','angle'):
        if row.get(key) is not None:
            _external_require(getattr(joint,key).expression==row[key],'Rebuilt joint expression differs for '+key)
    if row['kind']==1:
        limits=joint.jointMotion.rotationLimits
        _external_require(int(joint.jointMotion.rotationAxis)==int(row['rotationAxis']),
                          'Rebuilt revolute axis differs')
        for key in ('minimumValue','maximumValue','restValue','isMinimumValueEnabled','isMaximumValueEnabled','isRestValueEnabled'):
            setattr(limits,key,row['limits'][key])
        joint.jointMotion.rotationValue=row['rotationValue']
        _external_require(all(getattr(limits,k)==v for k,v in row['limits'].items()),'Enabled or disabled stored revolute limits differ')
        _external_require(abs(float(joint.jointMotion.rotationValue)-row['rotationValue'])<=runtime['tolerance']['angular'],
                          'Rebuilt revolute nominal value differs after assignment')
        if ctx.design.snapshots.hasPendingSnapshot:
            row['positionSnapshot']=_assembly_capture(ctx,ctx.design.designType==adsk.fusion.DesignTypes.ParametricDesignType)
    row['new']=joint
    return ctx.ref(joint)


def _external_replacement_index(ctx,file):
    by_parent={};by_token={}
    for occurrence in _references_items(ctx.root.allOccurrences):
        by_token[occurrence.entityToken]=occurrence
        if not occurrence.isReferencedComponent:continue
        ref=occurrence.documentReference
        if ref.dataFile.id!=file.id or ref.dataFile.versionNumber!=file.versionNumber:continue
        parent=occurrence.assemblyContext
        parent_token=parent.entityToken if parent is not None else None
        by_parent.setdefault(parent_token,[]).append((occurrence,list(_entity_occurrence_matrix(ctx,occurrence))))
    return {'byParent':by_parent,'byToken':by_token}


def _external_replacement_observation(ctx,file,captured,old,tolerance,index=None):
    index=index if index is not None else _external_replacement_index(ctx,file)
    targets=[]
    for occurrence,pose in index['byParent'].get(captured.get('parentToken'),[]):
        linear,angular=_measure_pose_delta(captured['worldPose'],pose)
        if linear<=tolerance['linear'] and angular<=tolerance['angular']:
            targets.append((occurrence,occurrence.fullPathName==captured['path']))
    exact=[row for row in targets if row[1]]
    if len(exact)==1:return {'status':'replaced','occurrence':exact[0][0],'pathMatched':True}
    if len(exact)>1:return {'status':'ambiguous','candidates':[ctx.ref(row[0]) for row in exact]}
    if len(targets)==1:
        try:
            if old.isValid:
                ref=old.documentReference
                if ref.dataFile.id==captured.get('fileId') and int(ref.version)==captured.get('version'):
                    return {'status':'ambiguous','candidates':[ctx.ref(targets[0][0]),ctx.ref(old)]}
        except Exception:pass
        return {'status':'replaced','occurrence':targets[0][0],'pathMatched':False}
    if len(targets)>1:return {'status':'ambiguous','candidates':[ctx.ref(row[0]) for row in targets]}
    try:
        if old.isValid:
            ref=old.documentReference
            if ref.dataFile.id==captured.get('fileId') and int(ref.version)==captured.get('version'):
                return {'status':'originalRetained','occurrence':ctx.ref(old)}
    except Exception:
        pass
    return {'status':'unknown','candidates':[]}


def _external_replace_stage(runtime,data,entry,cursor):
    ctx=runtime['source']
    affected=[r for r in runtime['boundaries'] if any(e.get('itemId')==entry['spec']['itemId'] for e in r['spec']['endpoints'])]
    pending=sorted([r for r in affected if not r['detached']],key=lambda r:r['old'].timelineObject.index,reverse=True)
    if pending:
        row=pending[0];deletion=_external_delete_joint_checkpoint(ctx,row['old'],row['token'])
        if deletion['status']!='removed':
            return _external_result('failed',cursor+1,partial=any(boundary['detached'] for boundary in affected),
                detachedJoint=row['token'],deletion=deletion,noReplay=True)
        row['detached']=True
        return _external_result('pending',cursor+1,detached=row['token'],
            reconciledAfterException=deletion['reconciledAfterException'])
    replaced_by_index=entry.setdefault('replacedByIndex',{i:o for i,o in enumerate(entry['staged'])})
    remaining=[i for i in range(len(entry['originals'])) if i not in replaced_by_index]
    if remaining:
        index=remaining[0]
        old=entry['originals'][index];captured=entry['instanceMap'][index]
        _external_require(old.isValid and old.isReferencedComponent,'replaceExternal requires a current external occurrence')
        native=getattr(old,'nativeObject',None) or old
        peers=[i for i in remaining if entry['originals'][i].isValid and
               (getattr(entry['originals'][i],'nativeObject',None) or entry['originals'][i])==native]
        paths=[entry['instanceMap'][i]['path'] for i in peers]
        outside={o.entityToken:list(_entity_occurrence_matrix(ctx,o)) for o in _references_items(ctx.root.allOccurrences)
            if not any(o.fullPathName==path or o.fullPathName.startswith(path+'+') for path in paths)}
        file=_references_project_file(ctx.app,entry['targetPin']['projectId'],entry['targetPin']['fileId'],entry['targetPin']['version'])
        _external_require(file.id!=captured.get('fileId') or file.versionNumber!=captured.get('version'),
                          'replaceExternal target is already the selected source version')
        submit_error=None
        try:submitted=old.replace(file,False)
        except Exception as error:submitted=None;submit_error=type(error).__name__+': '+str(error)
        replacement_index=_external_replacement_index(ctx,file)
        observation=_external_replacement_observation(ctx,file,captured,old,runtime['tolerance'],replacement_index)
        if observation['status']=='originalRetained':
            return _external_result('failed',cursor+1,notStarted=True,replaceReturned=submitted is False,
                reason='Native replacement left the pinned original occurrence in place',submitError=submit_error,
                originalRetained=observation['occurrence'],noReplay=True)
        if observation['status']!='replaced':
            return _external_result('unknown',cursor,reason='Native replacement outcome could not be uniquely reconciled',
                submitError=submit_error,observation=observation,noReplay=True)
        new=observation['occurrence']
        current=replacement_index['byToken']
        for token,pose in outside.items():
            _external_require(token in current,'Unexpected outside occurrence loss after replace')
            linear,angular=_measure_pose_delta(pose,list(_entity_occurrence_matrix(ctx,current[token])))
            _external_require(linear<=runtime['tolerance']['linear'] and angular<=runtime['tolerance']['angular'],'Replacement changed protected outside pose')
        observations={index:observation}
        for peer in peers:
            if peer==index:continue
            observations[peer]=_external_replacement_observation(ctx,file,entry['instanceMap'][peer],entry['originals'][peer],runtime['tolerance'],replacement_index)
            _external_require(observations[peer]['status']=='replaced','Shared native replacement context is unresolved; no replay')
        for peer,observed in observations.items():
            _external_ensure_attributes(observed['occurrence'],entry['instanceMap'][peer]['attributes'])
            replaced_by_index[peer]=observed['occurrence']
        entry['staged']=[replaced_by_index[i] for i in sorted(replaced_by_index)]
        return _external_result('pending',cursor+1,replaced=ctx.ref(new),nativeReplaceAll=False,
            replacedContexts=[ctx.ref(observations[i]['occurrence']) for i in sorted(observations)],
            reconciledAfterException=submit_error is not None or submitted is not True,
            submitError=submit_error,pathMatched=observation['pathMatched'])
    for row in affected:
        if row['new'] is None:return _external_result('pending',cursor+1,binding=_external_rebuild_joint(runtime,ctx,row))
    _external_require(ctx.design.computeAll(),'Replacement recompute failed')
    entry['stagedRefs']=[ctx.ref(o) for o in entry['staged']]
    return _external_result('complete',cursor+1,instanceMap=entry['stagedRefs'],retire='notApplicable')


def _external_group_context_attributes(ctx,entry,apply=False):
    baseline=entry['baseline']['occurrences']
    for group in entry['staged']:
        members=[o for o in _references_items(ctx.root.allOccurrences) if o.fullPathName.startswith(group.fullPathName+'+')]
        _external_require(len(members)==len(baseline),'Grouped root-context coverage changed')
        mapped=[]
        for before in baseline:
            after=_cad_unique([o for o in members if _external_attributes(o.component)==before['componentAttrs']],
                              'grouped root-context member provenance')
            _external_require(after not in mapped,'Grouped root-context map is not bijective');mapped.append(after)
            _external_require(_external_attributes(getattr(after,'nativeObject',None) or after)==before['nativeAttrs'],
                'Grouped native occurrence attributes changed')
            if apply:_external_ensure_attributes(after,before['attrs'])
            _external_require(_external_attributes(after)==before['attrs'],'Grouped root-context occurrence attributes differ')


def _external_group_combine_provenance(ctx,members):
    """Closed direct-sibling, single-body inputs; never infer a missing input."""
    result=[];owners=[o.component for o in members]
    for owner_index,owner in enumerate(owners):
        for feature_index,feature in enumerate(_references_items(owner.features)):
            if _cad_type(feature)!='CombineFeature':continue
            marker=ctx.design.timeline.markerPosition
            try:
                _external_require(feature.timelineObject.rollTo(True),'Cannot capture grouped Combine provenance')
                inputs=[feature.targetBody]+_references_items(feature.toolBodies);mapped=[]
                for body in inputs:
                    native=getattr(body,'nativeObject',None) or body
                    index=_cad_unique([i for i,c in enumerate(owners) if c==native.parentComponent],'closed Combine input owner')
                    bodies=_references_items(owners[index].bRepBodies)
                    _external_require(len(bodies)==1 and bodies[0]==native,'Grouped Combine requires unambiguous single-body input provenance')
                    mapped.append({'memberIndex':index,'bodyAttrs':_external_attributes(native),'material':native.material.id})
                result.append({'memberIndex':owner_index,'featureIndex':feature_index,'name':feature.name,
                    'operation':int(feature.operation),'keepTools':bool(feature.isKeepToolBodies),'inputs':mapped})
            finally:
                ctx.design.timeline.markerPosition=marker
                _external_require(ctx.design.timeline.markerPosition==marker,'Group provenance marker restore failed')
    return result


def _external_group_rebind_combines(ctx,entry):
    members=_external_physical_occurrences(ctx.root);baseline=entry['baseline']['occurrences']
    _external_require(len(members)==len(baseline),'Grouped Combine occurrence provenance changed')
    identities=[tuple(tuple(a) for a in row['componentAttrs']) for row in baseline]
    _external_require(all(identities) and len(set(identities))==len(identities),
        'Grouped Combine requires distinct captured component attributes for input mapping')
    members=[_cad_unique([o for o in members if _external_attributes(o.component)==before['componentAttrs']],
        'copied group member provenance') for before in baseline]
    for before,after in zip(baseline,members):
        # saveCopyAs of the enclosing component can drop occurrence attributes
        # too. Restore only after component provenance is uniquely established.
        _external_ensure_attributes(getattr(after,'nativeObject',None) or after,before['nativeAttrs'])
        _external_ensure_attributes(after,before['attrs'])
    effects=[]
    for row in entry['groupCombineInputs']:
        feature=members[row['memberIndex']].component.features.item(row['featureIndex'])
        _external_require(_cad_type(feature)=='CombineFeature' and feature.name==row['name'] and
            int(feature.operation)==row['operation'] and bool(feature.isKeepToolBodies)==row['keepTools'],
            'Original grouped Combine feature identity changed')
        if feature.healthState==adsk.fusion.FeatureHealthStates.HealthyFeatureHealthState:continue
        marker=ctx.design.timeline.markerPosition
        try:
            _external_require(feature.timelineObject.rollTo(True),'Cannot rebind original grouped Combine')
            bodies=[]
            for source in row['inputs']:
                candidates=_references_items(members[source['memberIndex']].component.bRepBodies)
                _external_require(len(candidates)==1,'Grouped Combine input mapping is ambiguous')
                body=candidates[0]
                _external_require(_external_attributes(body)==source['bodyAttrs'] and body.material.id==source['material'],
                    'Grouped Combine input provenance differs')
                bodies.append(body)
            feature.targetBody=bodies[0]
            tools=adsk.core.ObjectCollection.create()
            for body in bodies[1:]:tools.add(body)
            feature.toolBodies=tools
        finally:
            ctx.design.timeline.markerPosition=marker
            _external_require(ctx.design.timeline.markerPosition==marker,'Group rebind marker restore failed')
        _external_require(ctx.design.computeAll(),'Grouped Combine rebind recompute failed')
        effects.append({'feature':row['name'],'originalTypedInputsRebound':True})
    _external_health(ctx.root)
    return effects


def _external_group_copy(runtime,data,entry,cursor):
    spec=entry['spec'];ctx=runtime['source'];m=data['manifest']
    group=next(g for g in m['extractionGroups'] if g['id']==spec['groupId'])
    originals=[_external_occurrence(ctx,ref) for ref in group['members']]
    parent_path=originals[0].fullPathName.rsplit('+',1)[0] if '+' in originals[0].fullPathName else ''
    parent=ctx.root if not parent_path else _external_occurrence(ctx,{'path':parent_path}).component
    dest=spec['destination'];stage_dest={**dest,'fileName':dest['fileName']+'__'+data['operationId']+'__staging'}
    if cursor==0:
        effects=_external_activate(ctx)
        folder=_external_folder(ctx.app,stage_dest);_external_collision(folder,stage_dest['fileName'])
        result=_external_begin_copy(runtime,data,entry,ctx,parent,stage_dest,folder,'groupParent','groupParentFuture',cursor)
        if result['receipt'].get('accepted'):result['receipt']['isolatedParentCopyAccepted']=True
        return _external_with_lifecycle(result,effects)
    if cursor==1:
        temporary={'future':entry.get('groupParentFuture'),'futureObserver':entry.get('groupParentFutureObserver')}
        result=_external_future(temporary,1,stage_dest)
        if result['status']!='complete':return result
        entry['groupParentPin']=temporary['targetPin']
        return _external_with_lifecycle(_external_result('pending',2,parentCopy=temporary['targetPin'],
            parentCopyCompletion=result['receipt'].get('copyCompletion')),result.get('lifecycleEffects',[]))
    if cursor==2:
        doc,effect=_external_document(ctx.app,entry['groupParentPin'],allow_open=True,editable=True)
        _external_require(doc is not None,str(effect));entry['groupDoc']=doc
        gd=_external_ctx(doc);activation_effects=_external_activate(gd)
        members=[_cad_unique([o for o in _references_items(gd.root.occurrences) if
            o.component.name==old.component.name and _external_attributes(o)==_external_attributes(old)],
            'isolated copied group member provenance') for old in originals]
        owners=[o.component for o in members]
        # Native Combine input getters need a rolled timeline. Inspect them in
        # the isolated parent copy, never dirty the saved original for a read.
        for member in members:_external_dependency_coverage(member.component,owners,allow_timeline=True)
        for owner in _references_own_components(gd.root):
            if owner in owners:continue
            for feature in _references_items(owner.features):
                _external_require(not any(c in owners for c in _external_feature_input_owners(feature,True)),
                    'Outside copied feature consumes the extraction group')
        entry['groupDependencyCoverage']={'parentCopy':dict(entry['groupParentPin']),
            'members':[gd.ref(member) for member in members]}
        entry['groupCombineInputs']=_external_group_combine_provenance(gd,members)
        marker=gd.design.timeline.markerPosition
        try:
            gd.design.timeline.markerPosition=0
            enclosing=gd.root.occurrences.addNewComponent(adsk.core.Matrix3D.create())
            enclosing.component.name=group['id']
        finally:gd.design.timeline.moveToEnd()
        entry['groupOccurrence']=enclosing;entry['groupMoved']=[]
        return _external_with_lifecycle(_external_result('pending',3,createdGroup=gd.ref(enclosing),creationId=doc.creationId,
            dependencyCoverage=entry['groupDependencyCoverage']),
                                        [*effect.get('lifecycleEffects',[]),*activation_effects])
    if cursor<3+len(originals):
        gd=_external_ctx(entry['groupDoc']);activation_effects=_external_activate(gd)
        old=originals[cursor-3]
        candidates=[o for o in _references_items(gd.root.occurrences) if o.component.name==old.component.name and
            _external_attributes(o)==_external_attributes(old)]
        moved=_cad_unique(candidates,'isolated copied group member provenance')
        _external_require(_external_inventory(moved.component)==_external_inventory(old.component),'Isolated copy inventory changed')
        context_attributes=_external_attributes(moved)
        native_attributes=_external_attributes(getattr(moved,'nativeObject',None) or moved)
        moved=_cad_require_result(moved.moveToComponent(entry['groupOccurrence']),'Move isolated group member only')
        _external_ensure_attributes(getattr(moved,'nativeObject',None) or moved,native_attributes)
        _external_ensure_attributes(moved,context_attributes)
        _external_require(_external_attributes(moved)==context_attributes and
            _external_attributes(getattr(moved,'nativeObject',None) or moved)==native_attributes,
            'Moved isolated group member attributes differ')
        entry['groupMoved'].append(moved)
        return _external_with_lifecycle(_external_result('pending',cursor+1,moved=gd.ref(moved),sourceUnchanged=True),activation_effects)
    final_cursor=3+len(originals)
    if cursor==final_cursor:
        gd=_external_ctx(entry['groupDoc']);activation_effects=_external_activate(gd)
        _external_require(gd.design.computeAll(),'Grouped native context recompute failed')
        _external_health(entry['groupOccurrence'].component)
        entry['groupSaveBaseline']=int(gd.doc.dataFile.versionNumber)
        _external_require(gd.doc.save('Verified isolated extraction group'),'Save grouped staging')
        return _external_with_lifecycle(_external_result('pending',cursor+1,stagingSaveAccepted=True),activation_effects)
    if cursor==final_cursor+1:
        doc=entry['groupDoc']
        if doc.isModified or not doc.dataFile.isComplete or doc.dataFile.versionNumber<=entry['groupSaveBaseline']:
            doc.dataFile.refresh(None)
            return {**_external_result('pending',cursor),'waitingPublication':True}
        entry['component']=entry['groupOccurrence'].component
        entry['groupParentPin']=_external_pin(doc.dataFile,doc.creationId)
        return _external_result('pending',cursor+1,stagingSource=entry['groupParentPin'],
            stagingComponent=_external_ctx(doc).ref(entry['component']))
    if cursor==final_cursor+2:
        folder=_external_folder(ctx.app,dest);_external_collision(folder,dest['fileName'])
        _external_require(_external_inventory(entry['component'])==m['expectedInventory'][spec['itemId']],'Grouped declared inventory mismatch')
        for check in range(len(entry['baseline']['bodies'])+1):
            _external_compare(entry['baseline'],entry['component'],check,runtime['tolerance'])
        result=_external_begin_copy(runtime,data,entry,_external_ctx(entry['groupDoc']),entry['component'],
            dest,folder,'groupChild','future',cursor)
        if result['receipt'].get('accepted'):result['receipt']['groupCopyAccepted']=True
        return result
    if cursor==final_cursor+3:
        result=_external_future(entry,cursor,dest)
        if result['status']=='complete' and entry.get('groupCombineInputs'):
            result['status']='pending'
        return result
    if cursor==final_cursor+4:
        doc,lifecycle=_external_document(ctx.app,entry['targetPin'],allow_open=True,editable=True)
        _external_require(doc is not None,str(lifecycle));entry['groupChildDoc']=doc
        child=_external_ctx(doc);effects=[*lifecycle.get('lifecycleEffects',[]),*_external_activate(child)]
        rebindings=_external_group_rebind_combines(child,entry)
        for check in range(len(entry['baseline']['bodies'])+1):
            _external_compare(entry['baseline'],child.root,check,runtime['tolerance'])
        return _external_with_lifecycle(_external_result('pending',cursor+1,typedInputRebindings=rebindings),effects)
    if cursor==final_cursor+5:
        doc=entry['groupChildDoc'];entry['groupChildSaveBaseline']=int(doc.dataFile.versionNumber)
        if not doc.isModified:return _external_result('complete',cursor+1,target=entry['targetPin'],unchanged=True)
        _external_require(doc.save('Publish original grouped Combine input bindings'),'Grouped child save not accepted')
        return _external_result('pending',cursor+1,groupChildSaveAccepted=True)
    doc=entry['groupChildDoc']
    if doc.isModified or not doc.dataFile.isComplete or doc.dataFile.versionNumber<=entry['groupChildSaveBaseline']:
        return {**_external_result('pending',cursor),'waitingPublication':True}
    _external_require(doc.dataFile.id==entry['targetPin']['fileId'],'Grouped child save changed lineage')
    entry['targetPin']=_external_pin(doc.dataFile,doc.creationId)
    return _external_result('complete',cursor+1,target=entry['targetPin'],typedInputsPublished=True)


def _external_group_snapshot(ctx, roots):
    manager=adsk.fusion.TemporaryBRepManager.get();rows=[];bodies=[];definitions=[]
    parent=roots[0].assemblyContext
    inverse=_entity_inverse(_entity_occurrence_matrix(ctx,parent)) if parent else list(adsk.core.Matrix3D.create().asArray())
    occurrences=[]
    for root in roots:
        occurrences.append(root)
        occurrences.extend(o for o in _references_items(ctx.root.allOccurrences) if o.fullPathName.startswith(root.fullPathName+'+'))
    for index,occ in enumerate(occurrences):
        _external_health(occ.component)
        if occ.component not in definitions:definitions.append(occ.component)
        rows.append({'index':index,'componentToken':occ.component.entityToken,'token':occ.entityToken,
            'nativeToken':_references_native_occurrence_token(getattr(occ,'nativeObject',None) or occ),'path':occ.fullPathName,
            'pose':_entity_multiply(inverse,_entity_occurrence_matrix(ctx,occ)),
            'attrs':_external_attributes(occ),'nativeAttrs':_external_attributes(getattr(occ,'nativeObject',None) or occ),
            'componentAttrs':_external_attributes(occ.component)})
        for number,body in enumerate(_references_items(occ.component.bRepBodies)):
            bodies.append((('occurrence',index,number),manager.copy(body),body.material.id,_external_attributes(body)))
    return {'inventory':{'bodies':sum(c.bRepBodies.count for c in definitions),'occurrences':len(occurrences),
            'history':sum(c.features.count+c.sketches.count for c in definitions)},'bodies':bodies,'attributes':[],'occurrences':rows,
            'history':[{'features':[],'sketches':[]}]+[_external_component_history(c) for c in definitions],
            'joints':_external_internal_joints(None,[None]+definitions)}


def _external_restore_local(ctx, expressions):
    errors=[]
    for name,expression in expressions.items():
        try:ctx.design.userParameters.itemByName(name).expression=expression
        except Exception as error:errors.append({'parameter':name,'error':str(error)})
    try:_external_require(ctx.design.computeAll(),'Local restore recompute failed')
    except Exception as error:errors.append({'stage':'compute','error':str(error)})
    for name,expression in expressions.items():
        try:_external_require(ctx.design.userParameters.itemByName(name).expression==expression,'Expression restore readback differs')
        except Exception as error:errors.append({'parameter':name,'stage':'readback','error':str(error)})
    return errors


def _external_source_pin(runtime,source,binding=False):
    if 'itemId' in source:
        _cad_fields(source,('itemId',))
        _external_require(source['itemId'] in runtime['items'],'Unknown source itemId')
        pin=runtime['items'][source['itemId']]['targetPin']
        _external_require(pin is not None,'Source item copy/reuse not yet complete')
        return dict(pin)
    key='dataFileId' if binding else 'fileId'
    _cad_fields(source,('projectId',key,'version'),('creationId','context'))
    _external_require(type(source['version']) is int and source['version']>0,'Source version must be a positive integer')
    _external_require(source.get('context') in (None,'topLevel'),'Source context must be topLevel when specified')
    return {'projectId':source['projectId'],'fileId':source[key],'version':source['version'],
            **({'creationId':source['creationId']} if source.get('creationId') else {}),
            **({'context':source['context']} if source.get('context') else {})}


def _external_probe_local_budget(remaining_ms,reserve_ms):
    remaining=int(remaining_ms)
    reserve=int(reserve_ms)
    if remaining<=reserve:return None
    return remaining-reserve


def _external_rebind_probe_measurement(ctx,entry,check,error):
    measurement=check.get('measurement',{}) if isinstance(check,dict) else {}
    data=measurement.get('data',{}) if isinstance(measurement,dict) else {}
    ref=data.get('ref') if isinstance(data,dict) else None
    declared=ref.get('component') if isinstance(ref,dict) else None
    rows=entry.get('instanceMap') or []
    definition_token=str(rows[0].get('definition')) if rows else None
    if (str(measurement.get('operation'))!='measure.volume' or not isinstance(ref,dict) or
            not isinstance(declared,dict) or not isinstance(declared.get('token'),str) or
            declared['token']!=definition_token or 'Entity token' not in str(error)):
        raise error
    components=[c for c in _references_own_components(ctx.root) if str(c.entityToken)==definition_token]
    component=_cad_unique(components,'Pinned probe definition in consumer context')
    bodies=_references_items(component.bRepBodies)
    _external_require(len(bodies)==1 and entry['baseline']['inventory']['bodies']==1,
                      'Expired probe body token needs one exact selected-definition body')
    current=dict(check);current['measurement']={**measurement,'data':{**data,'ref':ctx.ref(bodies[0])}}
    return current,{'method':'selectedDefinitionUniqueBody','itemId':entry['spec']['itemId'],
        'componentToken':definition_token,'bodyToken':str(bodies[0].entityToken)}


def _external_staged_probe_check(ctx,entry,check):
    measurement=check.get('measurement',{});payload=measurement.get('data',{});ref=payload.get('ref')
    if not isinstance(ref,dict) or 'itemId' not in ref:return check
    _cad_fields(ref,('itemId','bodyIndex'),('instanceIndex',))
    _external_require(ref['itemId']==entry['spec']['itemId'],'Probe item ref is outside declared scope')
    index=ref.get('instanceIndex',0);body_index=ref['bodyIndex'];refs=entry.get('stagedRefs',[])
    _external_require(type(index) is int and 0<=index<len(refs) and type(body_index) is int and body_index>=0,
                      'Probe staged instance/body index is invalid')
    occurrence=_external_occurrence(ctx,{'token':refs[index]['token'],'kind':'occurrence'})
    _external_require(occurrence.isReferencedComponent and occurrence.documentReference.dataFile.id==entry['targetPin']['fileId'] and
        occurrence.documentReference.dataFile.versionNumber==entry['targetPin']['version'],'Probe staged source version differs from confirmed receipt')
    _external_require(body_index<occurrence.component.bRepBodies.count,'Probe body index exceeds staged definition')
    body=occurrence.component.bRepBodies.item(body_index).createForAssemblyContext(occurrence)
    # Linked root component tokens may not resolve in the assembly design.
    # Pin the body token in its exact occurrence context instead of serializing
    # that redundant, unresolvable component token through ctx.ref(body).
    body_ref={'token':body.entityToken,'kind':'body',
              'occurrence':{'token':occurrence.entityToken,'kind':'occurrence'}}
    return {**check,'measurement':{**measurement,'data':{**payload,'ref':body_ref}}}


def _external_probe_measure_check(ctx,entry,check):
    check=_external_staged_probe_check(ctx,entry,check)
    try:return _measure_check(ctx,check)
    except Exception as error:
        rebound,evidence=_external_rebind_probe_measurement(ctx,entry,check,error)
        result=_measure_check(ctx,rebound);result['entityResolution']=evidence
        return result


def _external_validate_probe_checks(ctx,probe,entry):
    if probe.get('scope','assembly')=='assembly':
        for check in probe['checks']:
            check=_external_staged_probe_check(ctx,entry,check)
            try:_measure_validate_parameter_check(ctx,check)
            except Exception as error:
                rebound,evidence=_external_rebind_probe_measurement(ctx,entry,check,error)
                _measure_validate_parameter_check(ctx,rebound)
                entry.setdefault('probeReferenceResolutions',[]).append(evidence)


def _external_probe_refresh_bindings(derived_bindings,current_edges):
    result=[]
    for binding in derived_bindings:
        matches=[]
        for edge in current_edges:
            if edge.get('kind')!='derive' or edge.get('sourceFileId')!=binding.get('sourceFileId') or \
                    edge.get('edgeIdentityUnique') is not True:
                continue
            if binding.get('ownerFileId') and edge.get('ownerFileId')!=binding['ownerFileId']:continue
            sources={row.get('name') for row in edge.get('sourceParameters',[])}
            derived={row.get('name') for row in edge.get('derivedParameters',[])}
            if binding.get('sourceParameter') in sources and binding.get('nativeDerivedParameter') in derived:
                matches.append(edge)
        _external_require(len(matches)==1,
                          'Saved consumer graph must uniquely identify each declared driver binding edge')
        edge=matches[0]
        result.append({'edgeId':edge['edgeId'],'sourceFileId':edge['sourceFileId'],
            'sourceParameter':binding['sourceParameter'],
            'nativeDerivedParameter':binding['nativeDerivedParameter'],
            'consumerAlias':binding['consumerAlias']})
    return result


def _external_close_probe_children(runtime,manifest,app):
    effects=[]
    item_ids={b['targetItemId'] for b in manifest.get('parameterBindings',[]) if b.get('targetItemId')}
    for item_id in sorted(item_ids):
        pin={**runtime['items'][item_id]['targetPin'],'context':'topLevel'}
        doc,observation=_external_document(app,pin,allow_open=False,editable=True)
        if doc is None:
            _external_require(observation.get('status')=='unavailable','Owned probe child editor is ambiguous')
            continue
        effects.append(_external_close_owned_clean_doc(_external_ctx(doc),pin))
    return effects


def _external_probe_validate_ui_targets(probe,pin,doc):
    if probe['refresh'].get('nativeFallback','never')!='qualifiedOnce':return
    file_id=pin['fileId'];creation_id=doc.creationId;name=doc.name
    for key,expected_name in (('driverUiLeases',name),
                              ('restoreUiLeases',_external_next_saved_name(name,pin['version']))):
        entry=probe['refresh'][key].get(file_id)
        _external_require(entry is not None,'Request-bound '+key+' lacks the exact saved consumer fileId')
        target=entry['target']
        _external_require(target.get('fileId')==file_id and target.get('creationId')==creation_id and
                          target.get('name')==expected_name,
                          key+' target differs from the current/next exact saved consumer editor')


def _external_next_saved_name(name,version):
    import re
    match=re.fullmatch(r'(.+) v(\d+)',str(name))
    _external_require(match is not None and int(match.group(2))==int(version),
                      'Saved consumer name/version suffix is not qualified for request-bound UI')
    return match.group(1)+' v'+str(int(version)+1)


def _external_probe_refresh_bindings_payload(bindings):
    return [{name:row[name] for name in
        ('edgeId','sourceParameter','nativeDerivedParameter','consumerAlias')}
        for row in bindings]


def _external_probe_refresh_plan_request(data,probe,state,key):
    target=state.get('targetPin') or {}
    source=state.get('source') or {}
    published=state.get('publishedVersion')
    _external_require(all(target.get(name) for name in ('projectId','fileId')) and
                      type(target.get('version')) is int and target['version']>0,
                      'Driver refresh requires the exact saved consumer baseline pin')
    _external_require(source.get('fileId') and type(published) is int and published>0 and
                      source.get('version')==published,
                      'Driver refresh requires the exact settled producer publication receipt')
    suffix='restore' if state.get('restoring') else 'driver'
    return {'schemaVersion':1,'phase':'plan',
        'root':{name:target[name] for name in ('projectId','fileId','version')},
        'policy':'latest','lifecycle':'openOwned','durability':'cold',
        'reportPath':probe['refresh']['reportPath'],
        'nativeFallback':probe['refresh'].get('nativeFallback','never'),
        'parameterBindings':_external_probe_refresh_bindings_payload(state.get('refreshBindings',[])),
        'requestId':data['operationId']+'_'+key+'_'+suffix+'_plan'}


def _external_probe_validate_refresh_plan(state,plan):
    expected={row['edgeId'] for row in state.get('refreshBindings',[])
              if row.get('sourceFileId')==state['source']['fileId']}
    actual={edge['edgeId'] for edge in plan.get('edges',[])
            if edge.get('kind')=='derive' and edge.get('sourceFileId')==state['source']['fileId']}
    _external_require(bool(expected) and actual==expected,
                      'Consumer plan omitted or changed the declared published driver binding edge')
    for edge in plan.get('edges',[]):
        if edge['sourceFileId']==state['source']['fileId']:
            _external_require(edge['targetVersion']==state['publishedVersion'],
                              'Consumer plan did not pin this exact producer publication')
        else:
            baseline=next((e for e in state['baselineEdges'] if e['edgeId']==edge['edgeId']),None)
            expected=state.get('appliedVersions',{}).get(edge['sourceFileId'],baseline['baselineVersion'] if baseline else None)
            _external_require(baseline and expected==edge['targetVersion'],
                              'Unrelated dependency drift during driver publication')


def _external_probe_refresh_apply_request(data,probe,state,key,plan):
    planned=state.get('refreshRequest') or {}
    target=state.get('targetPin') or {}
    _external_require(plan and plan.get('planId') and plan.get('invocationStatus')=='complete',
                      'Missing successful immutable consumer refresh plan')
    _external_require(plan.get('root')==planned.get('root') and planned.get('root')==
                      {name:target.get(name) for name in ('projectId','fileId','version')},
                      'Consumer refresh plan differs from the exact saved consumer baseline')
    suffix='restore' if state.get('restoring') else 'driver'
    request={'schemaVersion':1,'phase':'apply','confirm':True,
        'root':dict(planned['root']),'reportPath':planned['reportPath'],
        'planId':plan['planId'],'requestId':data['operationId']+'_'+key+'_'+suffix+'_apply',
        'policy':planned['policy'],'lifecycle':planned['lifecycle'],
        'durability':planned['durability'],'nativeFallback':planned['nativeFallback'],
        'parameterBindings':list(planned['parameterBindings'])}
    lease_key='restoreUiLeases' if state.get('restoring') else 'driverUiLeases'
    if probe['refresh'].get(lease_key):
        request['uiLeases']=probe['refresh'][lease_key]
    return request


def _external_probe_step(runtime,data,entry,cursor):
    probes=[p for p in data['manifest'].get('probes',[]) if p['itemId']==entry['spec']['itemId'] and
            p.get('scope','assembly')==data['phase'].split(':')[1]]
    completed=runtime.setdefault('completedProbes',set())
    remaining=[p for p in probes if p['probeId'] not in completed]
    if not remaining:return _external_result('complete',cursor,sourceFingerprint=runtime['sourceFingerprint'],target=entry['targetPin'])
    _external_require(not data.get('outerReadOnly'),'Read-only caller forbids declared driver writes')
    probe=remaining[0];key=probe['probeId'];ctx=runtime['target'] or runtime['source']
    state=runtime.setdefault('probes',{}).get(key)
    if state is None:
        probe_step_started=time.monotonic()
        reserve=_EXTERNAL_PROBE_RESTORE_RESERVE_MS if probe.get('scope','assembly')=='assembly' else 0
        local_budget=_external_probe_local_budget(data['remainingMs'],reserve)
        if local_budget is None:
            return _external_result('pending',cursor,reason='budgetExhausted',stopReason='budgetExhausted',
                restorationReserveMsPlanned=reserve,restorationReserveMsUsed=0)
        try:_external_validate_probe_checks(ctx,probe,entry)
        except Exception as error:
            return {**_external_result('blocked',cursor,notStarted=True,
                reason='Probe check preflight: '+type(error).__name__+': '+str(error)),'notStarted':True}
        source=_external_source_pin(runtime,probe['source'])
        producer_file=_references_project_file(ctx.app,source['projectId'],source['fileId'],source['version'])
        if not _external_refresh_complete(producer_file):
            return {**_external_result('pending',cursor,target=_external_pin(producer_file),reason='pendingPublication'),
                    'waitingPublication':True}
        doc,effect=_external_owned_document(runtime,source)
        _external_require(doc is not None and not doc.isModified and doc.dataFile.isReadOnly is False,
                          'Probe source must be a unique clean editable authorized owner')
        source_ctx=_external_ctx(doc);parameter=source_ctx.design.userParameters.itemByName(probe['parameter'])
        probe_activation=_external_activate(source_ctx)
        if probe.get('scope','assembly')=='assembly':
            _external_require(not ctx.doc.dataFile or ctx.doc.dataFile.id!=source['fileId'],'Cross-file probe needs a distinct producer; use scope:sources for local tests')
        _external_require(parameter is not None and parameter.unit and parameter.unit.lower()!='text',
                          'Probe requires a dimensional continuous scalar USER parameter; discrete/unitless count probes are not supported')
        units=source_ctx.design.unitsManager
        values=[units.evaluateExpression(probe[name],parameter.unit) for name in ('minimum','expression','maximum')]
        _external_require(all(math.isfinite(v) for v in values) and values[0]<=values[1]<=values[2] and values[0]<values[2],'Probe outside declared continuous range')
        if probe.get('scope','assembly')=='assembly':
            # Even a locally restored producer edit dirties the source editor.
            # Save/capture/close the consumer BEFORE any producer setter so its
            # baseline cannot serialize a live, modified reference buffer.
            state={'stage':'baselineSave','source':dict(source),
                'originalExpressions':{parameter.name:parameter.expression},'probeId':key,
                'localResult':None,'localProbeDeferred':True,'changed':False,'targetPin':None,
                'publishedVersion':None,'restorationReserveMsPlanned':reserve,'restorationReserveMsUsed':0}
            runtime['probes'][key]=state;runtime.setdefault('probeHandles',{})[key]=source_ctx
            runtime['compensation']={k:v for k,v in state.items() if k!='localResult'}
            return _external_with_lifecycle(_external_result('pending',cursor+1,localProbeDeferred=True,
                compensation=runtime['compensation']),[*effect.get('lifecycleEffects',[]),*probe_activation])
        baseline=_external_snapshot(source_ctx.root)
        topology=lambda: [(key,body.faces.count,body.edges.count) for key,body in _external_bodies(source_ctx.root)]
        before_topology=topology();restored_checks=[]
        def check_changed(*unused):
            return topology()==before_topology
        def check_restored(*unused):
            errors=[]
            for index in range(len(baseline['bodies'])+1):
                try:restored_checks.append(_external_compare(baseline,source_ctx.root,index,runtime['tolerance']))
                except Exception as error:errors.append(str(error))
            return not errors
        local_budget=_external_probe_local_budget(data['remainingMs']-int((time.monotonic()-probe_step_started)*1000),reserve)
        if local_budget is None:
            return _external_with_lifecycle(_external_result('pending',cursor,reason='budgetExhausted',stopReason='budgetExhausted',
                restorationReserveMsPlanned=reserve,restorationReserveMsUsed=0),
                [*effect.get('lifecycleEffects',[]),*probe_activation])
        local=_measure_parameter_test(source_ctx,{'confirm':True,'timeBudgetMs':local_budget,
            'cases':[{'id':key,'assign':[{'parameter':probe['parameter'],'expression':probe['expression']}],
                      'checks':probe['checks'] if probe.get('scope')=='sources' else []}]},check_changed,check_restored)
        local['restoredGeometryChecks']=restored_checks
        if entry.get('probeReferenceResolutions'):
            local['probeReferenceResolutions']=list(entry['probeReferenceResolutions'])
        if local.get('status')=='partial' and local.get('restored') is True and local.get('budgetExhausted') is True:
            return _external_with_lifecycle(_external_result('pending',cursor,reason='budgetExhausted',stopReason='budgetExhausted',
                localProbe=local,restorationReserveMsPlanned=reserve,restorationReserveMsUsed=0),
                [*effect.get('lifecycleEffects',[]),*probe_activation])
        if local.get('passed') is not True:
            return _external_with_lifecycle(_external_result('failed',cursor,reason='Local probe/mandatory restore did not pass',localResult=local),
                [*effect.get('lifecycleEffects',[]),*probe_activation])
        state={'stage':'baselineSave','source':dict(source),'originalExpressions':{parameter.name:parameter.expression},
            'probeId':key,'localResult':local,'changed':False,'targetPin':None,'publishedVersion':None}
        state['restorationReserveMsPlanned']=reserve
        state['restorationReserveMsUsed']=0
        runtime['probes'][key]=state;runtime.setdefault('probeHandles',{})[key]=source_ctx
        if probe.get('scope')=='sources':state['stage']='localSave'
        runtime['compensation']={k:v for k,v in state.items() if k!='localResult'}
        return _external_with_lifecycle(_external_result('pending',cursor+1,localProbe=local,compensation=runtime['compensation']),
            [*effect.get('lifecycleEffects',[]),*probe_activation])
    source_ctx=runtime['probeHandles'][key]
    observed=(data.get('result',{}).get('byItem',{}).get(entry['spec']['itemId'],{}).get('phaseResults',{}).
              get('verify',{}).get(data['phase'].split(':')[1],{}).get('receipt') or {})
    if state['stage'] in ('publishObserve','restoreObserve') and observed.get('producerCloseObserved') is True:
        _external_require(observed.get('publishedSource')==state['source'],'Closed producer receipt identity differs')
        _external_require(not any(getattr(getattr(d,'dataFile',None),'id',None)==state['source']['fileId']
            for d in _references_items(source_ctx.app.documents)),'Producer reopened after close reconciliation')
        state['restoring']=state['stage']=='restoreObserve';state['stage']='refreshPlan'
        runtime['compensation'].update(stage='restorePublished' if state['restoring'] else 'published',pending=False,
            publishedVersion=state['publishedVersion'])
        return _external_result('pending',cursor+1,publishedSource=state['source'],compensation=runtime['compensation'])
    if state['stage']=='localProbe':
        _external_require(not ctx.doc.isValid,'Consumer must be closed before producer probe setters')
        _external_require(not source_ctx.doc.isModified and source_ctx.doc.dataFile.versionNumber==state['source']['version'],
                          'Producer changed before the deferred local probe')
        budget=_external_probe_local_budget(data['remainingMs'],state['restorationReserveMsPlanned'])
        if budget is None:return _external_result('pending',cursor,stopReason='budgetExhausted',reason='budgetExhausted')
        activation_effects=_external_activate(source_ctx)
        baseline=_external_snapshot(source_ctx.root)
        topology=lambda:[(key,b.faces.count,b.edges.count) for key,b in _external_bodies(source_ctx.root)]
        before=topology();restored=[]
        def changed(*unused):return topology()==before
        def restore(*unused):
            errors=[]
            for index in range(len(baseline['bodies'])+1):
                try:restored.append(_external_compare(baseline,source_ctx.root,index,runtime['tolerance']))
                except Exception as error:errors.append(str(error))
            return not errors
        local=_measure_parameter_test(source_ctx,{'confirm':True,'timeBudgetMs':budget,'cases':[
            {'id':key,'assign':[{'parameter':probe['parameter'],'expression':probe['expression']}],'checks':[]}]},changed,restore)
        local['restoredGeometryChecks']=restored;state['localResult']=local
        if local.get('passed') is not True:
            return _external_with_lifecycle(_external_result('failed',cursor,reason='Deferred local probe/restore failed',localResult=local),activation_effects)
        state['localProbeDeferred']=False;state['stage']='publish'
        return _external_with_lifecycle(_external_result('pending',cursor+1,localProbe=local),activation_effects)
    if state['stage']=='localSave':
        activation_effects=_external_activate(source_ctx)
        state['sourceBaseline']=source_ctx.doc.dataFile.versionNumber
        if not source_ctx.doc.isModified:
            completed.add(key);runtime['compensation']=None
            return _external_with_lifecycle(_external_result('pending',cursor+1,probePassed=True,restored=True,
                localResult=state['localResult']),activation_effects)
        _external_require(source_ctx.doc.save('Restored local native driver '+key),'Local restore publication not accepted')
        state['stage']='localObserve'
        return _external_with_lifecycle(_external_result('pending',cursor+1,localRestorePublication=True),activation_effects)
    if state['stage']=='localObserve':
        file=source_ctx.doc.dataFile
        if source_ctx.doc.isModified or not file.isComplete or file.versionNumber<=state['sourceBaseline']:
            file.refresh(None)
            return {**_external_result('pending',cursor),'waitingPublication':True}
        if entry['targetPin']['fileId']==file.id:entry['targetPin']=_external_pin(file)
        completed.add(key);runtime['compensation']=None
        return _external_result('pending',cursor+1,probePassed=True,restored=True,localResult=state['localResult'],effectiveSource=_external_pin(file))
    if state['stage']=='baselineSave':
        reserve=state.get('restorationReserveMsPlanned',0)
        if data.get('remainingMs',0)<=reserve:
            return _external_result('pending',cursor,reason='budgetExhausted',stopReason='budgetExhausted',
                restorationReserveMsPlanned=reserve,restorationReserveMsUsed=0)
        # Verification owns the explicitly authorized publication, not finalize.
        activation_effects=_external_activate(ctx)
        state['targetBaseline']=ctx.doc.dataFile.versionNumber if ctx.doc.dataFile else 0
        state['baselineSaveSubmitted']=False
        if ctx.doc.dataFile:
            if ctx.doc.isModified:
                _external_require(ctx.doc.save('Driver baseline '+key),'Save driver baseline')
                state['baselineSaveSubmitted']=True
        else:
            dest=data['manifest']['destinationDocument'];folder=_external_folder(ctx.app,dest);_external_collision(folder,dest['name'])
            _external_require(ctx.doc.saveAs(dest['name'],folder,'Driver baseline '+key,''),'Save exact created driver target')
            state['baselineSaveSubmitted']=True
        state['stage']='baselineObserve'
        return _external_with_lifecycle(_external_result('pending',cursor+1,compensation=runtime['compensation']),activation_effects)
    if state['stage']=='baselineObserve':
        file=ctx.doc.dataFile
        if file is None or ctx.doc.isModified or not file.isComplete:
            if file:file.refresh(None)
            return {**_external_result('pending',cursor,compensation=runtime['compensation']),'waitingPublication':True}
        try:
            latest=_references_project_file(ctx.app,file.parentProject.id,file.id)
            # Refreshing the cloud lineage can replace the document's DataFile
            # wrapper. Re-read doc.dataFile before pinning; the prior wrapper
            # may still describe the pre-save version.
            file=ctx.doc.dataFile or file
            current_version=int(file.versionNumber);latest_version=int(latest.versionNumber)
        except Exception as error:
            if file:file.refresh(None)
            return {**_external_result('pending',cursor,compensation=runtime['compensation'],
                waitingPublication=True,baselineReadError=type(error).__name__+': '+str(error))}
        if state.get('baselineSaveSubmitted'):
            if latest_version<=int(state.get('targetBaseline',0)):
                file.refresh(None)
                return {**_external_result('pending',cursor,compensation=runtime['compensation']),
                    'waitingPublication':True}
            if latest_version!=int(state['targetBaseline'])+1:
                return _external_with_lifecycle(_external_result('blocked',cursor,notStarted=True,
                    reason='consumerBaselineRevisionDrift',baselineVersion=int(state['targetBaseline']),
                    latestVersion=latest_version),[])
        elif latest_version!=current_version:
            return _external_result('blocked',cursor,notStarted=True,reason='olderRevisionOpen',
                openVersion=current_version,latestVersion=latest_version)
        lifecycle=[]
        if latest_version!=current_version:
            # Cloud completion can precede replacement of the editor DataFile
            # wrapper. Observe that same save; never close on a transient old pin.
            return {**_external_result('pending',cursor,baselineVersion=current_version,
                latestVersion=latest_version,reason='pendingPublication'),'waitingPublication':True}
        state['targetBaseline']=int(file.versionNumber)
        state['targetPin']=_external_pin(file,ctx.doc.creationId)
        graph=_references_collect_graph({'root':{k:state['targetPin'][k] for k in ('projectId','fileId','version')},
            'policy':'preserve','lifecycle':'openOwned','allowedProjectIds':[state['targetPin']['projectId']]})
        _external_require(graph.get('graphComplete') is True,'Probe baseline dependency graph is incomplete')
        lifecycle.extend(graph.get('lifecycleEffects',[]))
        state['baselineEdges']=graph['edges']
        state['refreshBindings']=_external_probe_refresh_bindings(
            [{**row,'ownerFileId':row.get('ownerFileId',state['targetPin']['fileId'])}
             for row in runtime.get('derivedBindings',[])],state['baselineEdges'])
        _external_probe_validate_ui_targets(probe,state['targetPin'],ctx.doc)
        state['stage']='localProbe' if state.get('localProbeDeferred') else 'publish'
        if data['manifest']['mode'] in ('copyAndReplace','replaceFromExisting','replaceExternal') and ctx is runtime['source']:
            lifecycle.append(_external_close_owned_clean_doc(ctx,state['targetPin']))
        elif data['manifest']['mode']=='composeNew' and ctx is runtime['target']:
            lifecycle.append(_external_close_owned_clean_doc(ctx,state['targetPin']))
        return _external_with_lifecycle(_external_result('pending',cursor+1,
            consumerBaseline=state['targetPin'],compensation=runtime['compensation']),lifecycle)
    if state['stage'] in ('publish','restorePublish'):
        restoring=state['stage']=='restorePublish'
        reserve=state.get('restorationReserveMsPlanned',0)
        if not restoring and data.get('remainingMs',0)<=reserve:
            return _external_result('pending',cursor,reason='budgetExhausted',stopReason='budgetExhausted',
                restorationReserveMsPlanned=reserve,restorationReserveMsUsed=0)
        if not restoring and state.get('restorationStartedAt') is None:
            state['restorationStartedAt']=time.monotonic()
        forward_deadline=time.monotonic()+max(0,float(data['remainingMs']))/1000.0
        activation_effects=_external_activate(source_ctx)
        original={name:source_ctx.design.userParameters.itemByName(name).expression for name in state['originalExpressions']}
        state['sourceBaseline']=source_ctx.doc.dataFile.versionNumber
        runtime['compensation']={**state['source'],'probeId':key,'originalExpressions':state['originalExpressions'],
            'stage':'restorePublishing' if restoring else 'publishing','pending':True}
        entered_save=False
        try:
            assignments=state['originalExpressions'] if restoring else {probe['parameter']:probe['expression']}
            for name,expression in assignments.items():source_ctx.design.userParameters.itemByName(name).expression=expression
            _external_require(source_ctx.design.computeAll(),'Probe recompute failed')
            _external_require(restoring or time.monotonic()<forward_deadline,'budgetExhaustedBeforePublication')
            entered_save=True
            _external_require(source_ctx.doc.save('Authorized driver '+('restore ' if restoring else 'publish ')+key),'Probe save not accepted')
        except Exception as error:
            if entered_save:raise
            restore_errors=_external_restore_local(source_ctx,original)
            if str(error)=='budgetExhaustedBeforePublication' and not restore_errors:
                return _external_result('pending',cursor+1,reason='budgetExhausted',budgetExceeded=True,restored=True,
                    restorationReserveMs=state.get('restorationReserveMs',60000),restoreErrors=[])
            return _external_result('failed',cursor,primaryError=str(error),restoreErrors=restore_errors,
                compensation=runtime['compensation'],restored=not restore_errors)
        state['stage']='restoreObserve' if restoring else 'publishObserve'
        return _external_with_lifecycle(_external_result('pending',cursor+1,compensation=runtime['compensation']),activation_effects)
    if state['stage'] in ('publishObserve','restoreObserve'):
        file=source_ctx.doc.dataFile
        if source_ctx.doc.isModified or not file.isComplete or file.versionNumber<=state['sourceBaseline']:
            file.refresh(None)
            return {**_external_result('pending',cursor,compensation=runtime['compensation']),'waitingPublication':True}
        state['publishedVersion']=int(file.versionNumber)
        state['source']=_external_pin(file,source_ctx.doc.creationId)
        # Independently saved versions must not share an editable producer
        # context when the consumer is cold-opened by references.refresh.
        close_effect=_external_close_owned_clean_doc(source_ctx,state['source'])
        state['restoring']=state['stage']=='restoreObserve';state['stage']='refreshPlan'
        runtime['compensation'].update(stage='restorePublished' if state['restoring'] else 'published',pending=False,
            publishedVersion=state['publishedVersion'])
        return _external_with_lifecycle(_external_result('pending',cursor+1,publishedSource=state['source'],
            compensation=runtime['compensation']),[close_effect])
    receipt=data['result']['byItem'][entry['spec']['itemId']]['phaseResults']['verify'][data['phase'].split(':')[1]].get('receipt') or {}
    if state['stage']=='refreshPlan':
        _cad_fields(probe['refresh'],('reportPath',),('nativeFallback','driverUiLeases','restoreUiLeases'))
        request=_external_probe_refresh_plan_request(data,probe,state,key)
        state['refreshRequest']=request;state['stage']='refreshApply'
        return _external_result('pending',cursor+1,refreshRequest=request,compensation=runtime['compensation'])
    if state['stage']=='refreshApply':
        plan=receipt.get('refreshReceipt')
        _external_require(plan and plan.get('planId') and plan.get('invocationStatus')=='complete',
                          'Missing successful immutable consumer refresh plan')
        _external_probe_validate_refresh_plan(state,plan)
        request=_external_probe_refresh_apply_request(data,probe,state,key,plan)
        state['stage']='verifyConsumer'
        return _external_result('pending',cursor+1,refreshRequest=request,compensation=runtime['compensation'])
    if state['stage']=='verifyConsumer':
        refreshed=receipt.get('refreshReceipt')
        _external_require(refreshed and refreshed.get('success') is True and refreshed.get('allIntendedReferencesCurrent') is True,
                          'Actual consumer refresh did not pass; do not publish compensation while unknown')
        rows=[r for r in refreshed['completed'] if r['fileId']==state['targetPin']['fileId']]
        _external_require(len(rows)==1 and rows[0]['coldVerified'],'Driver requires separate cold consumer proof')
        state['targetPin']['version']=rows[0]['resultingVersion']
        state['appliedVersions']={row['fileId']:row['resultingVersion'] for row in refreshed['completed']}
        for item in runtime['items'].values():
            if item.get('targetPin') and item['targetPin']['fileId'] in state['appliedVersions']:
                item['targetPin']['version']=state['appliedVersions'][item['targetPin']['fileId']]
        doc,target_effect=_external_document(adsk.core.Application.get(),state['targetPin'],allow_open=True,editable=True)
        _external_require(doc is not None,str(target_effect));target=_external_ctx(doc)
        activation_effects=_external_activate(target)
        checks=[_external_probe_measure_check(target,entry,c) for c in probe['checks']] if not state['restoring'] else []
        _external_require(all(c.get('passed') is True for c in checks),'Independent physical driver checks failed')
        if state['restoring']:
            runtime['target']=target if data['manifest']['mode']=='composeNew' else None
            if data['manifest']['mode']!='composeNew':runtime['source']=target
            for item in runtime['items'].values():
                item['staged']=[_external_occurrence(target,{'token':ref['token'],'kind':'occurrence'}) for ref in item.get('stagedRefs',[])]
                if data['manifest']['mode'] in ('copyAndReplace','replaceFromExisting'):
                    original_refs=next((g['members'] for g in data['manifest']['extractionGroups'] if g['id']==item['spec'].get('groupId')),None)
                    original_refs=original_refs or [row['source'] for row in item['instanceMap'] if row['source']]
                    item['originals']=[_external_occurrence(target,ref) for ref in original_refs]
                for occurrence in item['staged']:
                    for check in range(len(item['baseline']['bodies'])+1):_external_compare(item['baseline'],occurrence.component,check,runtime['tolerance'])
            runtime['sourceFingerprint']=_external_fingerprint(runtime['source'])
            state['restorationReserveMsUsed']=max(0,int((time.monotonic()-state['restorationStartedAt'])*1000)) if state.get('restorationStartedAt') is not None else 0
            completed.add(key);runtime['compensation']=None
            return _external_with_lifecycle(_external_result('pending',cursor+1,probePassed=True,restored=True,checks=checks,
                restorationReserveMsPlanned=state.get('restorationReserveMsPlanned',0),
                restorationReserveMsUsed=state['restorationReserveMsUsed']),
                [*target_effect.get('lifecycleEffects',[]),*activation_effects])
        _external_require(not doc.isModified,'Driver consumer must remain a clean exact refreshed document')
        state['consumerAppliedVersion']=state['publishedVersion']
        close_effect=[]
        if data['manifest']['mode'] in ('copyAndReplace','replaceFromExisting','replaceExternal','composeNew'):
            if data['manifest']['mode']=='composeNew':runtime['target']=target
            else:runtime['source']=target
            close_effect.append(_external_close_owned_clean_doc(target,state['targetPin']))
        close_effect.extend(_external_close_probe_children(runtime,data['manifest'],target.app))
        source,source_effect=_external_document(adsk.core.Application.get(),state['source'],allow_open=True,editable=True)
        _external_require(source is not None,str(source_effect));runtime['probeHandles'][key]=_external_ctx(source)
        state['stage']='restorePublish'
        return _external_with_lifecycle(_external_result('pending',cursor+1,driverChecks=checks,compensation=runtime['compensation']),
            [*target_effect.get('lifecycleEffects',[]),*source_effect.get('lifecycleEffects',[]),*activation_effects,*close_effect])
    raise ValueError('Unrecognized probe checkpoint; no replay')


CAD_HANDLERS['occurrence.insert_external'] = _external_insert
