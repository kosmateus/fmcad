"""Offline SDK doubles and safety contracts; not Fusion kernel qualification."""
import ast
import json
import types
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


class ExternalizationNativeTests(unittest.TestCase):
    def setUp(self):
        self.ns={'CAD_HANDLERS':{},'TYPE_CHECKING':False,
                 '_references_items':lambda x:list(x),'_cad_items':lambda x:list(x)}
        for relative in ('runtime/python/fmcad/domain/values.py',
                         'runtime/python/fmcad/domain/externalization.py',
                         'runtime/python/fmcad/adapters/fusion/externalization.py'):
            exec(compile((ROOT/relative).read_text(),relative,'exec'),self.ns)
        self.project=types.SimpleNamespace(id='project')
        self.file=types.SimpleNamespace(id='file',parentProject=self.project,versionNumber=2,isComplete=True,
            isReadOnly=False,name='Part',parentFolder=types.SimpleNamespace(id='folder'))
        self.effects=[]
        self.app=types.SimpleNamespace(documents=[],documentsOpen=0)
        self.ns['_references_document_identity']=lambda d: {'fileId':d.dataFile.id,'projectId':d.dataFile.parentProject.id,
            'version':d.dataFile.versionNumber,'creationId':d.creationId}
        self.ns['_cad_unique']=lambda rows,label: rows[0] if len(rows)==1 else self.reject(label)
        self.ns['_cad_require_result']=lambda value,label: value if value else self.reject(label)
        self.ns['_cad_fields']=self.fields
        self.ns['_cad_type']=lambda obj: obj.kind
        self.ns['adsk']=types.SimpleNamespace(core=types.SimpleNamespace(
            FutureStates=types.SimpleNamespace(ProcessingFutureState=10,FinishedFutureState=11,FailedFutureState=12),
            UploadStates=types.SimpleNamespace(UploadProcessing=0,UploadFinished=1,UploadFailed=2),
            Application=types.SimpleNamespace(get=lambda:self.app)),fusion=types.SimpleNamespace(
            FeatureHealthStates=types.SimpleNamespace(HealthyFeatureHealthState=0)))

    def reject(self,label):raise ValueError(label)

    def fields(self,data,required=(),optional=()):
        if not isinstance(data,dict) or set(data)-set(required)-set(optional) or set(required)-set(data):
            raise ValueError('fields')

    def doc(self,top=True,creation='creation'):
        file=self.file
        class Doc:
            dataFile=file
            creationId=creation
            isModified=False
            isValid=True
            @property
            def allDocumentReferences(self):
                if not top:raise RuntimeError('3 : Cannot get allDocumentReferences of a non-top-level document.')
                return types.SimpleNamespace(count=0)
            def activate(inner):self.effects.append('activate');return True
        return Doc()

    def test_initial_not_started_block_can_reenter_preflight_but_unknown_cannot(self):
        self.ns['_external_registry']=lambda create:{}
        expected={'status':'blocked','receipt':{'cursor':0,'notStarted':True,'reason':'stillBlocked'}}
        calls=[]
        def initial(data):calls.append('preflight');return {'_externalPending':expected}
        self.ns['_external_initial']=initial
        copy={'status':'blocked','receipt':{'cursor':0,'notStarted':True}}
        data={'operationId':'initial','result':{'byItem':{'part':{'phaseResults':
            {'copy':copy,'stage':{'status':'notStarted'}}}}}}
        self.assertEqual(self.ns['_external_refresh_internal']('step',data),expected)
        copy['status']='unknown';copy['receipt']={'cursor':0,'reason':'unknownExecution'}
        self.assertEqual(self.ns['_external_refresh_internal']('step',data)['status'],'unknown')
        self.assertEqual(calls,['preflight'])

    def test_inspect_style_resolution_reports_cached_ambiguity_without_open_or_activation(self):
        self.app.documents=[self.doc(),self.doc(False)]
        pin={'projectId':'project','fileId':'file','version':2,'creationId':'creation'}
        doc,result=self.ns['_external_document'](self.app,pin,allow_open=False,editable=False)
        self.assertIsNone(doc);self.assertEqual(result['status'],'ambiguous');self.assertEqual(len(result['candidates']),2)
        self.assertEqual(self.effects,[])

    def test_explicit_top_level_context_selects_proven_owner_without_guessing_from_caption(self):
        top,buffer=self.doc(),self.doc(False)
        self.app.documents=[buffer,top]
        doc,result=self.ns['_external_document'](self.app,{'projectId':'project','fileId':'file','version':2,'context':'topLevel'},editable=True)
        self.assertIs(doc,top);self.assertEqual(result['status'],'resolved');self.assertEqual(self.effects,[])

    def test_mutating_ambiguous_cached_context_without_explicit_context_pin_never_opens(self):
        self.app.documents=[self.doc(False),self.doc()]
        doc,result=self.ns['_external_document'](self.app,{'projectId':'project','fileId':'file','version':2},allow_open=True,editable=True)
        self.assertIsNone(doc);self.assertEqual(result['status'],'ambiguous');self.assertEqual(self.effects,[])

    def test_exact_creation_pin_disambiguates_before_any_activation(self):
        a,b=self.doc(creation='a'),self.doc(creation='b');self.app.documents=[a,b]
        doc,result=self.ns['_external_document'](self.app,{'projectId':'project','fileId':'file','version':2,'creationId':'b'})
        self.assertIs(doc,b);self.assertEqual(self.effects,[])

    def test_fresh_occurrence_and_joint_tokens_reconcile_in_exact_native_scope(self):
        component=types.SimpleNamespace(entityToken='component-token',occurrences=[],allOccurrences=[],joints=[],asBuiltJoints=[])
        occurrence=types.SimpleNamespace(entityToken='occurrence-token',fullPathName='module_A:1',
            component=component,nativeObject=None)
        component.occurrences=[occurrence]
        component.allOccurrences=[occurrence]
        joint=types.SimpleNamespace(entityToken='joint-token')
        component.joints=[joint]
        self.ns['_references_own_components']=lambda root:[root]
        ctx=types.SimpleNamespace(root=component,resolve=lambda *_:self.reject('findEntityByToken unavailable'))
        selected=self.ns['_external_occurrence'](ctx,{'token':'expired-occurrence-token','kind':'occurrence','path':'module_A:1',
            'component':{'token':'component-token'}})
        self.assertIs(selected,occurrence)
        self.assertIs(self.ns['_external_joint'](ctx,{'token':'joint-token','kind':'Joint'}),joint)
        with self.assertRaisesRegex(ValueError,'Exact native boundary-joint token'):
            self.ns['_external_joint'](ctx,{'token':'missing-joint','kind':'Joint'})

    def test_composed_transform_is_converted_to_native_matrix_before_external_insert(self):
        values=[1.0,0,0,2.0,0,1.0,0,3.0,0,0,1.0,4.0,0,0,0,1.0]
        class Matrix:
            def setWithArray(self,array):self.values=list(array);return True
            def asArray(self):return self.values
        matrix_rows=[]
        class MatrixFactory:
            @staticmethod
            def create():
                row=Matrix();matrix_rows.append(row);return row
        class ParentOccurrences:
            def addByInsert(inner,file,matrix,flatten):
                self.assertIs(matrix,matrix_rows[0]);self.assertEqual(matrix.values,values);self.assertTrue(flatten)
                root.allOccurrences.append(occurrence)
                return occurrence
        target_file=types.SimpleNamespace(id='target',parentProject=self.project)
        source_file=types.SimpleNamespace(id='source',parentProject=self.project,versionNumber=2,
            isComplete=True,parentFolder=types.SimpleNamespace(id='folder'))
        reference=types.SimpleNamespace(dataFile=source_file,version=2)
        occurrence=types.SimpleNamespace(entityToken='new',nativeObject=None,assemblyContext=None,
            fullPathName='Inserted:1',isReferencedComponent=True,documentReference=reference,
            component=types.SimpleNamespace(entityToken='definition'))
        root=types.SimpleNamespace(allOccurrences=[],occurrences=[],joints=[],asBuiltJoints=[])
        parent=types.SimpleNamespace(occurrences=ParentOccurrences())
        doc=types.SimpleNamespace(dataFile=target_file)
        ctx=types.SimpleNamespace(doc=doc,root=root,app=types.SimpleNamespace(),
            require_confirm=lambda *_:None,ref=lambda entity:{'kind':'occurrence','path':entity.fullPathName})
        self.ns['adsk'].core.Matrix3D=MatrixFactory
        self.ns['_references_project_file']=lambda *_:source_file
        self.ns['_external_destination']=lambda *_:(parent,None,None,[''])
        self.ns['_assembly_capture_ready']=lambda *_:None
        self.ns['_references_collect_graph']=lambda *_:{'graphComplete':True,'edges':[],'documents':[],'lifecycleEffects':[]}
        self.ns['_external_activate']=lambda *_:[]
        self.ns['_entity_occurrence_matrix']=lambda *_:values
        result=self.ns['_external_insert'](ctx,{'source':{'dataFileId':'source','version':2},'confirm':True},
                                            project_id='project',native_matrix=values)
        self.assertEqual(result['status'],'complete');self.assertEqual(result['worldPoses'],[values])

    def test_compose_save_unknown_reconciles_only_exact_complete_saved_target(self):
        target_file=types.SimpleNamespace(id='target-file',parentProject=self.project,
            parentFolder=types.SimpleNamespace(id='folder'),name='Assembly',versionNumber=1,isComplete=True)
        source_file=types.SimpleNamespace(id='file',parentProject=self.project,versionNumber=2)
        child_file=types.SimpleNamespace(id='child',parentProject=self.project,versionNumber=1)
        occurrence=types.SimpleNamespace(isReferencedComponent=True,
            documentReference=types.SimpleNamespace(dataFile=child_file,version=1),
            component=types.SimpleNamespace(name='Child'))
        root=types.SimpleNamespace(allOccurrences=[occurrence])
        target_doc=types.SimpleNamespace(dataFile=target_file,isModified=False,isSaved=True,creationId='saved-target')
        source_doc=types.SimpleNamespace(dataFile=source_file,isModified=False)
        app=types.SimpleNamespace(documents=[target_doc])
        target_ctx=types.SimpleNamespace(doc=target_doc,root=root,design=types.SimpleNamespace(
            timeline=types.SimpleNamespace(count=7)))
        source_ctx=types.SimpleNamespace(doc=source_doc,app=app)
        baseline={'bodies':[object()],'inventory':{'history':2}}
        entry={'baseline':baseline,'staged':[occurrence],'targetPin':{'fileId':'child','version':1},'spec':{}}
        runtime={'source':source_ctx,'target':target_ctx,'sourceFingerprint':'source-fingerprint','targetCreationId':'unsaved-target',
            'items':{'moduleC':entry},'tolerance':{'linear':1e-4,'angular':1e-4},'processId':42,'compensation':None,'effects':{}}
        manifest={'mode':'composeNew','items':[{'itemId':'moduleC'}],
            'source':{'fileId':'file','version':2},
            'destinationDocument':{'projectId':'project','folderId':'folder','name':'Assembly'}}
        checks=[{'checkId':'final:0:body:0','passed':True},
            {'checkId':'final:1:history:poses:attributes','passed':True}]
        phase={'status':'pending','receipt':{'cursor':3,'checks':checks}}
        result={'byItem':{'moduleC':{'phaseResults':{'finalize':phase}}}}
        pending={'stepId':'finalize:moduleC:3:9','phase':'finalize','itemId':'moduleC'}
        self.ns['_external_folder']=lambda _app,_dest:types.SimpleNamespace(dataFiles=[target_file])
        self.ns['_references_document_identity']=lambda doc:{'fileId':doc.dataFile.id,'projectId':'project',
            'version':doc.dataFile.versionNumber,'creationId':doc.creationId}
        self.ns['_external_ctx']=lambda _doc:target_ctx
        self.ns['_external_health']=lambda *_:None
        self.ns['_external_fingerprint']=lambda _ctx:'source-fingerprint'
        self.ns['_external_compare']=lambda *_:{'passed':True,'checkId':'verified'}
        self.ns['_external_stage_insert_plan']=lambda *args:{'expectedWorld':{'':[0]*16}}
        self.ns['_entity_occurrence_matrix']=lambda *args:[0]*16
        self.ns['_measure_pose_delta']=lambda *args:(0,0)
        data={'manifest':manifest,'result':result}
        receipt=self.ns['_external_inspect_finalize_save'](runtime,data,pending)
        self.assertTrue(receipt['terminal']);self.assertEqual(receipt['stepId'],pending['stepId'])
        self.assertEqual(receipt['result']['status'],'complete')
        self.assertTrue(receipt['result']['receipt']['cloudComplete'])
        self.assertTrue(receipt['result']['receipt']['reconciledAfterException'])
        repeated=types.SimpleNamespace(isReferencedComponent=True,documentReference=occurrence.documentReference,
            component=types.SimpleNamespace(name='Child'),role='second')
        root.allOccurrences.append(repeated);entry['staged'].append(repeated)
        phase['receipt']={'cursor':5,'checks':checks+[
            {'checkId':'final:2:body:0','passed':True},{'checkId':'final:3:history:poses:attributes','passed':True}]}
        repeated_receipt=self.ns['_external_inspect_finalize_save'](runtime,data,pending)
        self.assertTrue(repeated_receipt['terminal'])
        self.assertEqual(repeated_receipt['result']['receipt']['cursor'],6)
        self.ns['_measure_pose_delta']=lambda *args:(1,0)
        self.assertEqual(self.ns['_external_inspect_finalize_save'](runtime,data,pending)['diagnostic'],'savedTargetWorldPoseChanged')
        self.ns['_measure_pose_delta']=lambda *args:(0,0)
        target_file.versionNumber=2
        self.assertEqual(self.ns['_external_inspect_finalize_save'](runtime,data,pending)['diagnostic'],'savedTargetUnexpectedVersion')
        target_file.versionNumber=1
        entry['staged']=[occurrence,occurrence]
        self.assertEqual(self.ns['_external_inspect_finalize_save'](runtime,data,pending)['diagnostic'],'savedTargetLinkCoverageMismatch')
        entry['staged']=[occurrence,repeated]
        # Other items must retain their own unfinished finalize checkpoints;
        # reconciling this save never claims their metadata/checks completed.
        manifest['items'].append({'itemId':'other'})
        other_occurrence=types.SimpleNamespace(isValid=True,isReferencedComponent=True,component=object(),
            documentReference=types.SimpleNamespace(dataFile=types.SimpleNamespace(id='other-child'),version=1))
        runtime['items']['other']={'baseline':baseline,'staged':[other_occurrence],
            'targetPin':{'fileId':'other-child','version':1},'spec':{}}
        other={'status':'notStarted','receipt':None}
        result['byItem']['other']={'phaseResults':{'finalize':other}}
        receipt=self.ns['_external_inspect_finalize_save'](runtime,data,pending)
        self.assertTrue(receipt['terminal']);self.assertEqual(other,{'status':'notStarted','receipt':None})
        self.assertEqual(receipt['result']['receipt']['savedTargetFingerprint'],'source-fingerprint')
        other_occurrence.documentReference.version=2
        self.assertEqual(self.ns['_external_inspect_finalize_save'](runtime,data,pending)['diagnostic'],'savedTargetOtherItemIdentityChanged')
        other_occurrence.documentReference.version=1
        target_doc.isModified=True
        unverified=self.ns['_external_inspect_finalize_save'](runtime,data,pending)
        self.assertEqual(unverified['diagnostic'],'savedTargetDocumentUnavailableOrAmbiguous')

    def test_inplace_save_settlement_accepts_only_same_owned_content_at_new_complete_version(self):
        file=types.SimpleNamespace(id='file',parentProject=self.project,versionNumber=2,isComplete=True)
        doc=types.SimpleNamespace(dataFile=file,creationId='creation',isModified=False)
        ctx=types.SimpleNamespace(doc=doc)
        runtime={'source':ctx,'saveAttempted':True,'saveFileId':'file','saveProjectId':'project',
            'saveCreationId':'creation','saveBaseline':1,'saveContentFingerprint':'known-content'}
        self.ns['_external_content_fingerprint']=lambda _ctx:'known-content'
        self.assertTrue(self.ns['_external_inplace_save_is_settled'](runtime))
        # composeNew's save owner is the created target, not its preserved source.
        preserved=types.SimpleNamespace(doc=types.SimpleNamespace(dataFile=types.SimpleNamespace(id='preserved-source')))
        composed={**runtime,'source':preserved,'target':ctx}
        self.assertFalse(self.ns['_external_inplace_save_is_settled'](composed))
        self.assertTrue(self.ns['_external_inplace_save_is_settled']({**composed,'source':composed['target']}))
        self.ns['_external_content_fingerprint']=lambda _ctx:'drifted-content'
        self.assertFalse(self.ns['_external_inplace_save_is_settled'](runtime))
        self.ns['_external_content_fingerprint']=lambda _ctx:'known-content'
        file.isComplete=False
        self.assertFalse(self.ns['_external_inplace_save_is_settled'](runtime))

    def test_accepted_save_as_receipt_survives_post_step_fingerprint_getter_error(self):
        source=object();target=object();saved=[]
        runtime={'requestHash':'h','sessionNonce':'n','source':source,'target':target,
            'sourceFingerprint':'s','targetFingerprint':'t','items':{'a':{'spec':{'itemId':'a'}}},'effects':{},'saveBaseline':0}
        self.ns['_external_registry']=lambda create:{'op':runtime}
        def fingerprint(ctx):
            if ctx is source:return 's'
            if saved:raise RuntimeError('2 : InternalValidationError : res')
            return 't'
        def finalize(*args):
            saved.append('one SaveAs')
            return {'status':'pending','receipt':{'cursor':6,'saveAccepted':True,'creationId':'saved-target'}}
        self.ns['_external_fingerprint']=fingerprint;self.ns['_external_finalize']=finalize
        data={'operationId':'op','requestHash':'h','sessionNonce':'n','stepId':'save','itemId':'a','phase':'finalize',
            'manifest':{'mode':'composeNew'},'result':{'byItem':{'a':{'phaseResults':{'finalize':{'status':'pending','receipt':{'cursor':5}}}}}}}
        result=self.ns['_external_refresh_internal']('perform',data)
        self.assertEqual(result['status'],'pending');self.assertTrue(result['receipt']['saveAccepted'])
        self.assertEqual(result['receipt']['cursor'],6);self.assertTrue(result['waitingPublication'])
        self.assertTrue(runtime['effects']['save']['terminal']);self.assertEqual(saved,['one SaveAs'])
        self.assertEqual(runtime['acceptedSaveAsObservation'],{'itemId':'a','cursor':6,'creationId':'saved-target'})
        runtime.pop('acceptedSaveAsObservation');runtime['effects']={};saved.clear()
        self.ns['_external_fingerprint']=lambda ctx:'s' if ctx is source else 't'
        result=self.ns['_external_refresh_internal']('perform',{**data,'stepId':'readable-save'})
        self.assertTrue(result['waitingPublication']);self.assertNotIn('observationError',result['receipt'])
        self.assertEqual(runtime['acceptedSaveAsObservation']['cursor'],6)

    def test_accepted_save_as_observation_waits_without_resubmission_and_rejects_drift(self):
        file=types.SimpleNamespace(isComplete=False,parentProject=types.SimpleNamespace(id='p'),
            parentFolder=types.SimpleNamespace(id='f'),name='Assembly',versionNumber=1)
        doc=types.SimpleNamespace(isValid=True,creationId='saved-target',dataFile=file,isModified=False)
        target=types.SimpleNamespace(doc=doc);source=object()
        runtime={'source':source,'target':target,'sourceFingerprint':'source','targetFingerprint':'before',
            'saveContentFingerprint':'content','saveBaseline':0,
            'acceptedSaveAsObservation':{'itemId':'a','cursor':6,'creationId':'saved-target'}}
        self.ns['_external_fingerprint']=lambda ctx:'source' if ctx is source else 'after'
        self.ns['_external_content_fingerprint']=lambda ctx:'content'
        data={'phase':'finalize','itemId':'a','manifest':{'destinationDocument':{'projectId':'p','folderId':'f','name':'Assembly'}}}
        result=self.ns['_external_observe_accepted_save_as'](runtime,data)
        self.assertTrue(result['waitingPublication']);self.assertEqual(result['receipt']['cursor'],6)
        file.isComplete=True;file.parentFolder.id='wrong'
        self.assertEqual(self.ns['_external_observe_accepted_save_as'](runtime,data)['status'],'blocked')
        self.assertEqual(runtime['targetFingerprint'],'before')
        file.parentFolder.id='f'
        self.assertIsNone(self.ns['_external_observe_accepted_save_as'](runtime,data))
        self.assertEqual(runtime['targetFingerprint'],'after');self.assertNotIn('acceptedSaveAsObservation',runtime)

    def test_own_pending_final_save_can_only_observe_exact_next_revision_and_unchanged_content(self):
        file=types.SimpleNamespace(id='file',parentProject=self.project,versionNumber=2,isComplete=False)
        doc=types.SimpleNamespace(dataFile=file,creationId='creation',isModified=False)
        runtime={'source':types.SimpleNamespace(doc=doc),'saveAttempted':True,'saveFileId':'file','saveProjectId':'project',
            'saveCreationId':'creation','saveBaseline':1,'saveContentFingerprint':'same',
            'items':{'part':{'baseline':{'bodies':[object()]},'staged':[object()]}}}
        state={'receipt':{'cursor':4,'saveAccepted':True}}
        data={'phase':'finalize','itemId':'part','result':{'byItem':{'part':{'phaseResults':{'finalize':state}}}}}
        self.ns['_external_content_fingerprint']=lambda ctx:'same'
        self.assertTrue(self.ns['_external_inplace_save_is_pending'](runtime,data))
        state['receipt']['cursor']=3
        self.assertFalse(self.ns['_external_inplace_save_is_pending'](runtime,data))
        state['receipt']['cursor']=4;file.versionNumber=3
        self.assertFalse(self.ns['_external_inplace_save_is_pending'](runtime,data))
        file.versionNumber=2;self.ns['_external_content_fingerprint']=lambda ctx:'different'
        self.assertFalse(self.ns['_external_inplace_save_is_pending'](runtime,data))

    def test_driver_probe_allows_only_its_published_source_stale_edge_before_refresh_plan(self):
        project=types.SimpleNamespace(id='project')
        target_file=types.SimpleNamespace(id='consumer',parentProject=project,versionNumber=3,isComplete=True)
        target_doc=types.SimpleNamespace(dataFile=target_file,isModified=False)
        target_ctx=types.SimpleNamespace(doc=target_doc)
        original=types.SimpleNamespace(component=types.SimpleNamespace(name='Part'))
        entry={'originals':[original],'baseline':{'bodies':[object()]},'spec':{}}
        baseline_edge={'edgeId':'driver-edge','sourceFileId':'driver','kind':'derive',
            'baselineVersion':2,'latestVersion':2}
        state={'stage':'refreshPlan','source':{'fileId':'driver','version':3},'publishedVersion':3,
            'targetPin':{'fileId':'consumer','version':3},'baselineEdges':[baseline_edge]}
        runtime={'target':None,'source':target_ctx,'items':{'module':entry},
            'probes':{'probe':state},'tolerance':{}}
        data={'phase':'verify:assembly','itemId':'module',
            'manifest':{'probes':[{'probeId':'probe','itemId':'module','scope':'assembly'}]}}
        current=[{**baseline_edge,'latestVersion':3}]
        self.ns['_references_current_edges']=lambda _ctx:current
        self.ns['_external_compare']=lambda *_:{'passed':True}
        self.assertTrue(self.ns['_external_probe_refresh_checkpoint'](runtime,data))
        current[:]=[{**baseline_edge,'latestVersion':4}]
        self.assertFalse(self.ns['_external_probe_refresh_checkpoint'](runtime,data))

    def test_driver_measurement_rebinds_only_expired_token_to_unique_exact_selected_body(self):
        body=types.SimpleNamespace(entityToken='current-body-token')
        component=types.SimpleNamespace(entityToken='selected-component-token',bRepBodies=[body])
        root=types.SimpleNamespace()
        ctx=types.SimpleNamespace(root=root,ref=lambda entity:{'token':entity.entityToken,'kind':'body'})
        self.ns['_references_own_components']=lambda _root:[component]
        def measure(_ctx,data):
            ref=data['measurement']['data']['ref']
            if ref.get('token')!='current-body-token':raise ValueError('Entity token: expected one match, found 0')
            return {'passed':True,'checkId':data['id']}
        self.ns['_measure_check']=measure
        entry={'component':component,'instanceMap':[{'definition':'selected-component-token'}],
            'baseline':{'inventory':{'bodies':1}},'spec':{'itemId':'moduleC'}}
        check={'id':'volume','measurement':{'operation':'measure.volume','data':{
            'ref':{'token':'expired-token','kind':'body','component':{'token':'selected-component-token'}}}},
            'expected':'1 cm^3','tolerance':'0.01 cm^3'}
        result=self.ns['_external_probe_measure_check'](ctx,entry,check)
        self.assertTrue(result['passed'])
        self.assertEqual(result['entityResolution']['method'],'selectedDefinitionUniqueBody')
        self.assertEqual(result['entityResolution']['bodyToken'],'current-body-token')

    def test_readonly_pinned_source_is_usable_for_verify_but_not_an_edit_owner(self):
        doc=self.doc();doc.dataFile.isReadOnly=True;self.app.documents=[doc]
        pin={'projectId':'project','fileId':'file','version':2,'creationId':'creation'}
        observed,result=self.ns['_external_document'](self.app,pin,editable=False)
        self.assertIs(observed,doc);self.assertEqual(result['status'],'resolved')
        edit_owner,result=self.ns['_external_document'](self.app,pin,editable=True)
        self.assertIsNone(edit_owner);self.assertEqual(result['reason'],'editableOwnerUnavailable')

    def test_activation_is_a_phase_effect_and_is_not_reported_when_already_active(self):
        target=types.SimpleNamespace(name='Fixture',creationId='creation',dataFile=self.file,isModified=False)
        app=types.SimpleNamespace(userInterface=types.SimpleNamespace(activeCommand='SelectCommand'),activeDocument=None)
        target.activate=lambda:(setattr(app,'activeDocument',target) or True)
        ctx=types.SimpleNamespace(app=app,doc=target)
        effect=self.ns['_external_activate'](ctx)
        self.assertEqual(effect[0]['action'],'activated');self.assertEqual(effect[0]['docid'],'creation')
        self.assertFalse(effect[0]['openedByOperation']);self.assertEqual(effect[0]['identity']['fileId'],'file')
        self.assertEqual(self.ns['_external_activate'](ctx),[])

    def test_clean_incomplete_sameversion_source_refreshes_metadata_without_save(self):
        doc=self.doc();doc.dataFile.isComplete=False;doc.dataFile.refresh=lambda _:self.effects.append('refresh')
        doc.dataFile.save=lambda *args:self.effects.append('save')
        app=types.SimpleNamespace()
        self.ns['adsk'].core.Application.get=lambda:app
        self.ns['_external_document']=lambda *args,**kwargs:(doc,{'status':'resolved','identity':{'version':2}})
        manifest={'mode':'copyAndReplace','source':{'projectId':'project','fileId':'file','creationId':'creation','version':2},
            'items':[],'probes':[]}
        result=self.ns['_external_initial']({'manifest':manifest})
        self.assertEqual(result['_externalPending']['status'],'pending')
        self.assertTrue(result['_externalPending']['waitingPublication'])
        self.assertEqual(self.effects,['refresh'])
        self.assertEqual(doc.dataFile.versionNumber,2)

    def test_initial_block_preserves_owned_open_receipt_if_later_preflight_rejects(self):
        doc=self.doc();app=types.SimpleNamespace()
        self.ns['adsk'].core.Application.get=lambda:app
        lifecycle=[{'action':'opened','docid':'creation','openedByOperation':True,
            'identity':{'projectId':'project','fileId':'file','version':2,'creationId':'creation'}}]
        self.ns['_external_document']=lambda *args,**kwargs:(doc,{'status':'resolved','lifecycleEffects':lifecycle})
        self.ns['_assembly_capture_ready']=lambda ctx:self.reject('source history preflight failed')
        manifest={'mode':'copyAndReplace','source':{'projectId':'project','fileId':'file','creationId':'creation','version':2},
            'items':[],'probes':[]}
        result=self.ns['_external_initial']({'manifest':manifest})
        self.assertEqual(result['_externalPending']['status'],'blocked')
        self.assertEqual(result['_externalPending']['lifecycleEffects'],lifecycle)

    def test_incomplete_source_preflight_can_poll_same_metadata_refresh_without_replay(self):
        operations={};calls=[]
        self.ns['_external_registry']=lambda create:operations
        self.ns['_external_initial']=lambda data:(calls.append('preflight'),
            {'_externalPending':{'status':'pending','waitingPublication':True,
                'receipt':{'cursor':0,'preflightPending':True,'reason':'sourcePublicationPending'}}})[1]
        data={'operationId':'op','requestHash':'hash','sessionNonce':'nonce','manifest':{},
            'result':{'byItem':{'unit':{'phaseResults':{
                'copy':{'status':'notStarted','receipt':None},'stage':{'status':'notStarted','receipt':None}}}}}}
        first=self.ns['_external_refresh_internal']('perform',data)
        self.assertEqual(first['status'],'pending');self.assertTrue(first['waitingPublication'])
        self.assertTrue(operations['op']['preflightPending'])
        data['result']['byItem']['unit']['phaseResults']['copy']=(
            {'status':'pending','receipt':first['receipt']})
        second=self.ns['_external_refresh_internal']('perform',data)
        self.assertEqual(second['status'],'pending');self.assertEqual(calls,['preflight','preflight'])
        operations.clear()  # simulate loss of only the read-only preflight runtime
        third=self.ns['_external_refresh_internal']('perform',data)
        self.assertEqual(third['status'],'pending');self.assertEqual(calls,['preflight','preflight','preflight'])
        self.assertTrue(operations['op']['preflightPending'])

    def test_readonly_outer_context_blocks_required_open_before_effect(self):
        self.ns['_references_project_file']=lambda *args:self.reject('must not query/open')
        doc,result=self.ns['_external_document'](self.app,{'projectId':'project','fileId':'file','version':2},allow_open=True,readonly=True)
        self.assertIsNone(doc);self.assertEqual(result['status'],'unavailable');self.assertEqual(result['lifecycleEffects'],[])

    def test_geometry_verify_can_open_exact_owned_pin_and_records_actual_creation(self):
        doc=self.doc()
        self.app.documents=types.SimpleNamespace(__iter__=lambda:iter([]),open=lambda f,visible:(self.effects.append(('open',f.id,f.versionNumber)),doc)[1])
        items=lambda coll:[] if coll is self.app.documents else list(coll)
        self.ns['_references_items']=items;self.ns['_cad_items']=items
        self.ns['_references_project_file']=lambda app,p,f,v:self.file
        actual,result=self.ns['_external_document'](self.app,{'projectId':'project','fileId':'file','version':2},allow_open=True,editable=True)
        self.assertIs(actual,doc);self.assertEqual(self.effects,[('open','file',2)])
        self.assertEqual(result['lifecycleEffects'][0]['identity']['creationId'],'creation')

    def test_pending_future_never_means_verified_or_migrated(self):
        entry={'future':types.SimpleNamespace(uploadState=0)}
        result=self.ns['_external_future'](entry,1,{'projectId':'project','folderId':'folder','fileName':'Part'})
        self.assertEqual(result['status'],'pending');self.assertEqual(result['uploadStatus'],'pending')
        self.assertTrue(result['waitingPublication']);self.assertNotIn('migrationComplete',result)

    def test_completed_future_requires_exact_identity_and_complete_cloud(self):
        entry={'future':types.SimpleNamespace(uploadState=1,dataFile=self.file)}
        dest={'projectId':'project','folderId':'folder','fileName':'Part'}
        result=self.ns['_external_future'](entry,1,dest)
        self.assertEqual(result['status'],'complete');self.assertEqual(result['receipt']['target']['version'],2)
        self.file.parentFolder.id='foreign'
        with self.assertRaisesRegex(ValueError,'identity'):self.ns['_external_future'](entry,1,dest)

    def test_incomplete_cloud_refreshes_metadata_without_new_save_or_submission(self):
        self.file.isComplete=False;self.file.refresh=lambda _:self.effects.append('refresh')
        result=self.ns['_external_future']({'future':types.SimpleNamespace(uploadState=1,dataFile=self.file)},1,
            {'projectId':'project','folderId':'folder','fileName':'Part'})
        self.assertEqual(result['status'],'pending');self.assertEqual(self.effects,['refresh'])

    def test_lost_future_stays_unknown_and_never_recreates_by_filename(self):
        result=self.ns['_external_future']({},1,{'projectId':'project','folderId':'folder','fileName':'Part'})
        self.assertEqual(result['status'],'unknown');self.assertEqual(result['uploadStatus'],'unknown');self.assertEqual(self.effects,[])

    def test_native_failure_is_separate_from_raw_sdk_state(self):
        result=self.ns['_external_future']({'future':types.SimpleNamespace(uploadState=2)},1,{})
        self.assertEqual(result['status'],'failed');self.assertEqual(result['rawUploadState']['value'],2)

    def test_future_state_uses_declared_upload_enum_not_generic_future_enum(self):
        for raw in (10,11,12,99):
            result=self.ns['_external_future']({'future':types.SimpleNamespace(uploadState=raw)},1,{})
            self.assertEqual(result['status'],'unknown');self.assertEqual(result['uploadStatus'],'unknown')
            self.assertEqual(result['rawUploadState']['value'],raw)
            self.assertEqual(result['receipt']['reason'],'unrecognizedNativeUploadState')

    def test_filename_collision_is_not_permission_to_reuse(self):
        with self.assertRaisesRegex(ValueError,'collision|exists'):
            self.ns['_external_collision'](types.SimpleNamespace(dataFiles=[self.file]),'Part')

    def test_metadata_restore_is_idempotent_and_rejects_conflicting_existing_value(self):
        values={};adds=[]
        class Attributes:
            def itemByName(inner,group,name):return values.get((group,name))
            def add(inner,group,name,value):
                adds.append((group,name,value));values[(group,name)]=types.SimpleNamespace(value=value)
        entity=types.SimpleNamespace(attributes=Attributes())
        desired=[('role','instance','left')]
        self.ns['_external_ensure_attributes'](entity,desired)
        self.ns['_external_ensure_attributes'](entity,desired)
        self.assertEqual(adds,desired)
        with self.assertRaisesRegex(ValueError,'differs'):
            self.ns['_external_ensure_attributes'](entity,[('role','instance','right')])

    def test_insert_exception_readback_requires_one_exact_new_file_per_parent_context(self):
        data_file=types.SimpleNamespace(id='target',versionNumber=4)
        def occurrence(token,path,file=data_file,referenced=True):
            return types.SimpleNamespace(entityToken=token,fullPathName=path,isReferencedComponent=referenced,
                documentReference=types.SimpleNamespace(dataFile=file))
        a=occurrence('a','Parent:1+Module:1');b=occurrence('b','Parent:2+Module:1')
        ctx=types.SimpleNamespace(root=types.SimpleNamespace(allOccurrences=[a,b]))
        result=self.ns['_external_insert_reconcile'](ctx,data_file,['Parent:1','Parent:2'],{'old-a','old-b'})
        self.assertEqual(result['status'],'matched');self.assertEqual(result['occurrences'],[a,b])
        duplicate=occurrence('duplicate','Parent:1+Other:1')
        ctx.root.allOccurrences.append(duplicate)
        result=self.ns['_external_insert_reconcile'](ctx,data_file,['Parent:1','Parent:2'],{'old-a','old-b'})
        self.assertEqual(result['status'],'unresolved');self.assertEqual(result['occurrences'],[a,duplicate])

    def test_delete_checkpoint_reconciles_exception_after_joint_and_occurrence_removal(self):
        joint=types.SimpleNamespace(entityToken='joint')
        joints=[joint]
        component=types.SimpleNamespace(joints=joints,asBuiltJoints=[])
        ctx=types.SimpleNamespace(root=types.SimpleNamespace())
        self.ns['_references_own_components']=lambda root:[component]
        joint.deleteMe=lambda:(joints.remove(joint),(_ for _ in ()).throw(RuntimeError('after joint delete')))[1]
        result=self.ns['_external_delete_joint_checkpoint'](ctx,joint,'joint')
        self.assertEqual(result['status'],'removed');self.assertTrue(result['reconciledAfterException'])
        self.assertEqual(joints,[])

        occurrence=types.SimpleNamespace(entityToken='occ',fullPathName='Module:1',component=types.SimpleNamespace(entityToken='def'))
        occurrences=[occurrence];ctx.root.allOccurrences=occurrences
        occurrence.deleteMe=lambda:(occurrences.remove(occurrence),(_ for _ in ()).throw(RuntimeError('after occurrence delete')))[1]
        captured={'token':'occ','path':'Module:1','definition':'def'}
        result=self.ns['_external_delete_occurrence_checkpoint'](ctx,occurrence,captured)
        self.assertEqual(result['status'],'removed');self.assertTrue(result['reconciledAfterException'])
        self.assertEqual(occurrences,[])

    def test_replace_external_exception_after_native_effect_uses_exact_readback_without_replay(self):
        source_file=types.SimpleNamespace(id='source',versionNumber=2)
        target_file=types.SimpleNamespace(id='target',versionNumber=4)
        class Occurrence:
            def __init__(self,token,file):
                self.entityToken=token;self.fullPathName='Module:1';self.isReferencedComponent=True
                self.isValid=True;self.documentReference=types.SimpleNamespace(dataFile=file,version= file.versionNumber)
                self.assemblyContext=None;self.worldPose=list(range(16))
                self.attributes=types.SimpleNamespace(itemByName=lambda group,name:None,add=lambda *args:None)
            def replace(inner,file,replaceAll):
                self.assertFalse(replaceAll);self.assertEqual(file.id,'target');self.assertTrue(inner.isValid)
                inner.isValid=False;root.allOccurrences.remove(inner);root.allOccurrences.append(new)
                raise RuntimeError('transport raised after native replacement')
        old=Occurrence('old',source_file);new=Occurrence('new',target_file)
        root=types.SimpleNamespace(allOccurrences=[old])
        ctx=types.SimpleNamespace(root=root,app=types.SimpleNamespace(),ref=lambda occurrence:{'token':occurrence.entityToken,'path':occurrence.fullPathName})
        self.ns['_external_activate']=lambda _:None
        self.ns['_references_project_file']=lambda *args:target_file
        self.ns['_entity_occurrence_matrix']=lambda context,occurrence:occurrence.worldPose
        self.ns['_measure_pose_delta']=lambda left,right:(0.0,0.0)
        captured={'path':'Module:1','parentToken':None,'fileId':'source','version':2,'worldPose':list(range(16)),
            'attributes':[]}
        entry={'spec':{'itemId':'unit'},'originals':[old],'instanceMap':[captured],
            'targetPin':{'projectId':'project','fileId':'target','version':4},'staged':[]}
        runtime={'source':ctx,'boundaries':[],'tolerance':{'linear':0.01,'angular':0.01}}
        result=self.ns['_external_replace_stage'](runtime,{},entry,0)
        self.assertEqual(result['status'],'pending');self.assertTrue(result['receipt']['reconciledAfterException'])
        self.assertEqual(result['receipt']['replaced']['token'],'new')
        self.assertEqual(entry['staged'],[new]);self.assertFalse(old.isValid)

    def test_health_blocks_equal_cached_geometry_with_broken_native_history(self):
        component=types.SimpleNamespace(allOccurrences=[],features=[types.SimpleNamespace(isSuppressed=False,healthState=1)])
        with self.assertRaisesRegex(ValueError,'Unhealthy'):self.ns['_external_health'](component)

    def test_shared_native_replace_accounts_for_all_authorized_contexts_once(self):
        calls=[];native=object();source=types.SimpleNamespace(id='source',versionNumber=1)
        target=types.SimpleNamespace(id='target',versionNumber=1)
        def occurrence(token,parent,file):
            return types.SimpleNamespace(entityToken=token,fullPathName=parent+'+Leaf:1',nativeObject=native,
                assemblyContext=types.SimpleNamespace(entityToken=parent),isValid=True,isReferencedComponent=True,
                documentReference=types.SimpleNamespace(dataFile=file,version=1),worldPose=[0]*16)
        old=[occurrence('old1','p1',source),occurrence('old2','p2',source)]
        new=[occurrence('new1','p1',target),occurrence('new2','p2',target)]
        protected=types.SimpleNamespace(entityToken='outside',fullPathName='Outside:1',worldPose=[0]*16,isReferencedComponent=False)
        class Root:
            reads=0
            @property
            def allOccurrences(inner):inner.reads+=1;return inner.items
            @allOccurrences.setter
            def allOccurrences(inner,value):inner.items=value
        root=Root();root.allOccurrences=[*old,protected]
        def replace(file,all_instances):
            calls.append((file.id,all_instances));root.allOccurrences=[*new,protected]
            for item in old:item.isValid=False
            return True
        for item in old:item.replace=replace
        ctx=types.SimpleNamespace(root=root,app=object(),ref=lambda o:{'token':o.entityToken},
            design=types.SimpleNamespace(computeAll=lambda:True))
        self.ns['_references_project_file']=lambda *args:target
        self.ns['_entity_occurrence_matrix']=lambda ctx,o:o.worldPose
        self.ns['_measure_pose_delta']=lambda *args:(0,0)
        self.ns['_external_ensure_attributes']=lambda *args:None
        entry={'spec':{'itemId':'part'},'originals':old,'staged':[],'targetPin':{'fileId':'target','projectId':'project','version':1},
            'instanceMap':[{'path':o.fullPathName,'parentToken':o.assemblyContext.entityToken,'fileId':'source','version':1,
                'worldPose':o.worldPose,'attributes':[]} for o in old]}
        runtime={'source':ctx,'boundaries':[],'tolerance':{'linear':1e-4,'angular':1e-4}}
        self.assertEqual(self.ns['_external_replace_stage'](runtime,{},entry,0)['status'],'pending')
        self.assertEqual(entry['staged'],new)
        self.assertEqual(self.ns['_external_replace_stage'](runtime,{},entry,1)['status'],'complete')
        self.assertEqual(calls,[('target',False)])
        self.assertEqual(root.reads,2)  # pre-submit fence plus one post-mutation index

    def test_history_signature_includes_feature_parameters_and_sketch_constraint_inventory(self):
        parameter=types.SimpleNamespace(name='Width',expression='10 mm',unit='mm')
        feature=types.SimpleNamespace(kind='ExtrudeFeature',name='Extrude',isSuppressed=False,healthState=0,parameters=[parameter])
        sketch=types.SimpleNamespace(name='Profile',isFullyConstrained=True,sketchCurves=types.SimpleNamespace(count=4),
            geometricConstraints=types.SimpleNamespace(count=4),sketchDimensions=types.SimpleNamespace(count=2))
        component=types.SimpleNamespace(features=[feature],sketches=[sketch],allOccurrences=[])
        signature=self.ns['_external_history_signature'](component)
        self.assertEqual(signature[0]['features'][0]['parameters'],[('Width','10 mm','mm')])
        self.assertEqual(signature[0]['sketches'][0],{'name':'Profile','isFullyConstrained':True,
            'curves':4,'constraints':4,'dimensions':2})
        parameter.expression='12 mm'
        self.assertNotEqual(signature,self.ns['_external_history_signature'](component))

    def test_explicit_group_covers_combine_cross_inputs_but_separate_copy_is_blocked(self):
        left=types.SimpleNamespace(allOccurrences=[],features=[]);right=types.SimpleNamespace(allOccurrences=[],features=[])
        left.features=[types.SimpleNamespace(kind='CombineFeature',targetBody=types.SimpleNamespace(parentComponent=left),
            toolBodies=[types.SimpleNamespace(parentComponent=right)])]
        with self.assertRaisesRegex(ValueError,'extraction group'):self.ns['_external_dependency_coverage'](left,[left])
        self.ns['_external_dependency_coverage'](left,[left,right])

    def test_combine_input_owners_are_captured_before_feature_and_marker_restored(self):
        timeline=types.SimpleNamespace(markerPosition=8)
        owner=types.SimpleNamespace(parentDesign=types.SimpleNamespace(timeline=timeline))
        def roll(before):self.assertTrue(before);timeline.markerPosition=3;return True
        class Combine:
            kind='CombineFeature';parentComponent=owner
            timelineObject=types.SimpleNamespace(rollTo=roll)
            @property
            def targetBody(inner):
                if timeline.markerPosition!=3:raise RuntimeError("3 : Didn't roll editing feature back.")
                return types.SimpleNamespace(parentComponent=owner)
            toolBodies=[]
        with self.assertRaisesRegex(RuntimeError,"Didn't roll"):
            self.ns['_external_feature_input_owners'](Combine())
        self.assertEqual(timeline.markerPosition,8)
        self.assertEqual(self.ns['_external_feature_input_owners'](Combine(),True),[owner])
        self.assertEqual(timeline.markerPosition,8)
        self.ns['_external_input_owner']=lambda _:self.reject('read failure')
        with self.assertRaisesRegex(ValueError,'read failure'):
            self.ns['_external_feature_input_owners'](Combine(),True)
        self.assertEqual(timeline.markerPosition,8)

    def test_unknown_dependency_coverage_is_explicitly_blocked_not_healthy_geometry_pass(self):
        component=types.SimpleNamespace(allOccurrences=[],features=[types.SimpleNamespace(kind='UnknownCopiedFeature')])
        with self.assertRaisesRegex(ValueError,'Unsupported'):self.ns['_external_dependency_coverage'](component,[component])

    def test_expanded_all_instances_scope_rejects_overlap_with_nested_selected_item(self):
        parent=types.SimpleNamespace(fullPathName='Carrier:1')
        child=types.SimpleNamespace(fullPathName='Carrier:1+Wing:1')
        sibling=types.SimpleNamespace(fullPathName='Carrier:2')
        authorized=[]
        self.assertEqual(self.ns['_external_disjoint_instances']([parent,parent],authorized),[parent])
        with self.assertRaisesRegex(ValueError,'overlaps'):
            self.ns['_external_disjoint_instances']([child],authorized)
        self.assertEqual(self.ns['_external_disjoint_instances']([sibling],authorized),[sibling])

    def test_caller_parent_namespace_matches_repeated_context_without_pose_or_name_guess(self):
        def owner(role):
            class Attributes(list):
                def itemByName(inner,group,name):
                    return next((a for a in inner if a.groupName==group and a.name==name),None)
            attrs=Attributes([types.SimpleNamespace(groupName='ROLE',name='site',value=role)])
            return types.SimpleNamespace(attributes=attrs,entityToken='target-parent')
        source_ctx=types.SimpleNamespace(doc=types.SimpleNamespace(creationId='source',dataFile=types.SimpleNamespace(id='s')),
            root=types.SimpleNamespace(attributes=types.SimpleNamespace(itemByName=lambda *_:None)))
        target_ctx=types.SimpleNamespace(doc=types.SimpleNamespace(creationId='target',dataFile=types.SimpleNamespace(id='t')),
            root=types.SimpleNamespace(attributes=types.SimpleNamespace(itemByName=lambda *_:None)))
        declaration=[{'itemId':'unit','scope':'parent','group':'ROLE','keys':['site']}]
        source_instance={'parentToken':'source-parent','callerNamespaceSpecs':declaration,
            'callerNamespaces':[{'group':'ROLE','values':[('site','north')]}]}
        self.assertTrue(self.ns['_external_parent_context_match'](source_ctx,target_ctx,owner('north'),source_instance))
        self.assertFalse(self.ns['_external_parent_context_match'](source_ctx,target_ctx,owner('south'),source_instance))

    def test_repeated_destination_stage_maps_by_caller_identity_before_native_insert(self):
        identity=list(types.SimpleNamespace(asArray=lambda:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]).asArray())
        parents={'P1':types.SimpleNamespace(entityToken='target-1',role='north'),
                 'P2':types.SimpleNamespace(entityToken='target-2',role='south')}
        self.ns['_external_destination']=lambda ctx,data:(None,None,types.SimpleNamespace(asArray=lambda:identity),['P1','P2'])
        self.ns['_external_destination_parent']=lambda ctx,path:parents[path]
        self.ns['_entity_occurrence_matrix']=lambda ctx,occ:identity
        self.ns['_entity_inverse']=lambda matrix:matrix
        self.ns['_entity_multiply']=lambda left,right:identity
        self.ns['_entity_matrix']=lambda matrix:types.SimpleNamespace(asArray=lambda:matrix)
        self.ns['_measure_pose_delta']=lambda left,right:(0.0,0.0)
        self.ns['_external_parent_context_match']=lambda source,target,parent,row:parent.role==row['role']
        source_ctx=types.SimpleNamespace(doc=types.SimpleNamespace(creationId='s',dataFile=types.SimpleNamespace(id='source')))
        target_ctx=types.SimpleNamespace(doc=types.SimpleNamespace(creationId='t',dataFile=types.SimpleNamespace(id='target')))
        mapping=[{'role':'north','worldPose':identity},{'role':'south','worldPose':identity}]
        plan=self.ns['_external_stage_insert_plan'](target_ctx,source_ctx,
            {'destinationOccurrence':'Parent','sharedParentPolicy':'allInstances'},mapping,0,
            {'linear':0.01,'angular':0.01})
        self.assertEqual(plan['sourceByParent'],{'P1':0,'P2':1})
        self.assertEqual(set(plan['expectedWorld']),{'P1','P2'})
        self.ns['_external_parent_context_match']=lambda *args:False
        with self.assertRaisesRegex(ValueError,'callerNamespaces'):
            self.ns['_external_stage_insert_plan'](target_ctx,source_ctx,
                {'destinationOccurrence':'Parent','sharedParentPolicy':'allInstances'},mapping,0,
                {'linear':0.01,'angular':0.01})

    def test_nested_insert_uses_inverse_rotated_parent_times_source_world_pose(self):
        identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
        parent_world=[0,-1,0,10,1,0,0,0,0,0,1,0,0,0,0,1]
        source_world=[0,-1,0,8,1,0,0,1,0,0,1,0,0,0,0,1]
        def multiply(a,b):return [sum(a[4*r+k]*b[4*k+c] for k in range(4)) for r in range(4) for c in range(4)]
        def inverse(matrix):
            out=list(identity)
            for r in range(3):
                for c in range(3):out[4*r+c]=matrix[4*c+r]
                out[4*r+3]=-sum(matrix[4*c+r]*matrix[4*c+3] for c in range(3))
            return out
        parent=types.SimpleNamespace(fullPathName='Parent:1',entityToken='parent')
        target=types.SimpleNamespace(root=types.SimpleNamespace(allOccurrences=[parent]),
            doc=types.SimpleNamespace(creationId='target',dataFile=types.SimpleNamespace(id='target')))
        source=types.SimpleNamespace(doc=types.SimpleNamespace(creationId='source',dataFile=types.SimpleNamespace(id='source')))
        self.ns['_external_destination']=lambda *args:(None,None,types.SimpleNamespace(asArray=lambda:identity),['Parent:1'])
        self.ns['_external_destination_parent']=lambda ctx,path:parent
        self.ns['_external_parent_context_match']=lambda *args:True
        self.ns['_entity_occurrence_matrix']=lambda ctx,occ:parent_world if occ is parent else identity
        self.ns['_entity_inverse']=inverse;self.ns['_entity_multiply']=multiply
        self.ns['_entity_matrix']=lambda value:types.SimpleNamespace(asArray=lambda:value)
        self.ns['_measure_pose_delta']=lambda left,right:(max(abs(a-b) for a,b in zip(left,right)),0.0)
        row={'worldPose':source_world,'parentToken':'old-parent'}
        plan=self.ns['_external_stage_insert_plan'](target,source,
            {'destinationOccurrence':'Parent:1','sharedParentPolicy':'reject'},[row],0,{'linear':1e-9,'angular':1e-9})
        self.assertEqual(plan['matrix'].asArray(),[1,0,0,1,0,1,0,2,0,0,1,0,0,0,0,1])
        self.assertEqual(plan['expectedWorld']['Parent:1'],source_world)

    def test_boundary_endpoints_require_one_explicit_context_and_declared_root_datum(self):
        self.ns['_external_boundary_endpoint_preflight']({'itemId':'unit','instanceIndex':0}, {'unit'}, set(), {'Datum'})
        self.ns['_external_boundary_endpoint_preflight']({'rootDatum':'Datum'}, {'unit'}, set(), {'Datum'})
        self.ns['_external_boundary_endpoint_preflight']({'occurrence':{'token':'t','kind':'occurrence','path':'A:1'}}, {'unit'}, set(), {'Datum'})
        with self.assertRaisesRegex(ValueError,'exactly one'):
            self.ns['_external_boundary_endpoint_preflight']({'itemId':'unit','rootDatum':'Datum'}, {'unit'}, set(), {'Datum'})
        with self.assertRaisesRegex(ValueError,'declared root datum'):
            self.ns['_external_boundary_endpoint_preflight']({'rootDatum':'Typo'}, {'unit'}, set(), {'Datum'})
        with self.assertRaisesRegex(ValueError,'memberIndex'):
            self.ns['_external_boundary_endpoint_preflight']({'itemId':'unit','memberIndex':0}, {'unit'}, set(), {'Datum'})
        with self.assertRaisesRegex(ValueError,'exact token'):
            self.ns['_external_boundary_endpoint_preflight']({'occurrence':'A:1'}, {'unit'}, set(), {'Datum'})

    def test_asbuilt_boundary_endpoint_maps_occurrence_without_requiring_joint_origin(self):
        component=types.SimpleNamespace(name='Module',attributes=[])
        first=types.SimpleNamespace(component=component,fullPathName='Module:1')
        second=types.SimpleNamespace(component=component,fullPathName='Module:2')
        runtime={'items':{'module':{'staged':[first,second]}}}
        ctx=types.SimpleNamespace(root=types.SimpleNamespace(allOccurrences=[first,second]))
        geometry,occurrence=self.ns['_external_endpoint'](runtime,ctx,{'itemId':'module','instanceIndex':1},
            {'componentAttributes':[]},require_geometry=False)
        self.assertIsNone(geometry);self.assertIs(occurrence,second)

    def test_initial_derive_creation_does_not_reselect_an_existing_stale_source_version(self):
        exact=types.SimpleNamespace(isSuppressed=False,documentReference=types.SimpleNamespace(
            dataFile=types.SimpleNamespace(id='source'),version=3))
        ctx=types.SimpleNamespace(root=types.SimpleNamespace(features=types.SimpleNamespace(deriveFeatures=[exact])))
        self.assertIs(self.ns['_external_existing_derive'](ctx,{'fileId':'source','version':3}),exact)
        with self.assertRaisesRegex(ValueError,'routine refresh belongs'):
            self.ns['_external_existing_derive'](ctx,{'fileId':'source','version':4})
        ambiguous=types.SimpleNamespace(isSuppressed=False,documentReference=exact.documentReference)
        ctx.root.features.deriveFeatures=[exact,ambiguous]
        with self.assertRaisesRegex(ValueError,'Ambiguous existing'):
            self.ns['_external_existing_derive'](ctx,{'fileId':'source','version':3})

    def test_cold_derive_getter_uses_unique_saved_forward_version_not_latest(self):
        reference_ns={'_cad_items':lambda value:list(value)}
        exec(compile((ROOT/'assets/cad/references.py').read_text(),'references.py','exec'),reference_ns)
        self.ns['_references_edge_version']=reference_ns['_references_edge_version']
        file=types.SimpleNamespace(id='source',versionNumber=3,latestVersionNumber=4,parentProject=self.project)
        class Ref:
            dataFile=file
            @property
            def version(self):raise RuntimeError('2 : InternalValidationError : doc')
        ref=Ref();feature=types.SimpleNamespace(isSuppressed=False,documentReference=ref)
        root=types.SimpleNamespace(features=types.SimpleNamespace(deriveFeatures=[feature]))
        ctx=types.SimpleNamespace(root=root,doc=types.SimpleNamespace(documentReferences=[ref],
            dataFile=types.SimpleNamespace(parentProject=self.project,childReferences=[types.SimpleNamespace(id='source',versionNumber=3)])))
        self.ns['_references_own_components']=lambda _: [root]
        self.assertIs(self.ns['_external_existing_derive'](ctx,{'fileId':'source','version':3}),feature)
        with self.assertRaisesRegex(ValueError,'another source version'):
            self.ns['_external_existing_derive'](ctx,{'fileId':'source','version':4})
        ctx.doc.dataFile.childReferences.append(types.SimpleNamespace(id='source',versionNumber=4))
        with self.assertRaisesRegex(ValueError,'unresolved'):
            self.ns['_external_existing_derive'](ctx,{'fileId':'source','version':3})

    def test_staged_probe_uses_body_and_occurrence_tokens_without_linked_root_token(self):
        body=types.SimpleNamespace(entityToken='assembly-body')
        native=types.SimpleNamespace(createForAssemblyContext=lambda occurrence:body)
        occurrence=types.SimpleNamespace(entityToken='installed-occurrence',isReferencedComponent=True,
            documentReference=types.SimpleNamespace(dataFile=types.SimpleNamespace(id='child',versionNumber=2)),
            component=types.SimpleNamespace(bRepBodies=types.SimpleNamespace(count=1,item=lambda i:native)))
        self.ns['_external_occurrence']=lambda ctx,ref:occurrence
        ctx=types.SimpleNamespace(ref=lambda obj:self.reject('must not serialize linked component token'))
        entry={'spec':{'itemId':'module'},'stagedRefs':[{'token':'installed-occurrence'}],
            'targetPin':{'fileId':'child','version':2}}
        check={'measurement':{'operation':'measure.volume','data':{'ref':{'itemId':'module','bodyIndex':0}}}}
        actual=self.ns['_external_staged_probe_check'](ctx,entry,check)
        self.assertEqual(actual['measurement']['data']['ref'],{'token':'assembly-body','kind':'body',
            'occurrence':{'token':'installed-occurrence','kind':'occurrence'}})
        entry['targetPin']['version']=3
        with self.assertRaisesRegex(ValueError,'confirmed receipt'):
            self.ns['_external_staged_probe_check'](ctx,entry,check)

    def test_item_and_parent_binding_names_are_scoped_by_owner_not_suffix(self):
        bindings=[dict(ownerFileId=owner,sourceFileId='producer',sourceParameter='driver',
            nativeDerivedParameter='driver_Ref',consumerAlias='alias') for owner in ('parent','child')]
        edges=[dict(ownerFileId=owner,edgeId=owner+'-derive',kind='derive',edgeIdentityUnique=True,
            sourceFileId='producer',sourceParameters=[{'name':'driver'}],derivedParameters=[{'name':'driver_Ref'}])
            for owner in ('parent','child')]
        result=self.ns['_external_probe_refresh_bindings'](bindings,edges)
        self.assertEqual([r['edgeId'] for r in result],['parent-derive','child-derive'])

    def test_declared_parameter_reference_helpers_are_not_physical_extraction_units(self):
        flag=types.SimpleNamespace(groupName='fmcad.externalization',name='role',value='declaredParameterReference')
        rows=[types.SimpleNamespace(fullPathName='Physical:1',attributes=[]),
              types.SimpleNamespace(fullPathName='Master:1',attributes=[flag]),
              types.SimpleNamespace(fullPathName='Master:1+Nested:1',attributes=[])]
        root=types.SimpleNamespace(allOccurrences=rows)
        self.assertEqual(self.ns['_external_physical_occurrences'](root),rows[:1])

    def test_root_datum_preflight_checks_unique_names_units_and_topological_dependencies(self):
        ctx=types.SimpleNamespace(design=types.SimpleNamespace(allParameters=[]),root=types.SimpleNamespace(jointOrigins=types.SimpleNamespace(itemByName=lambda _:None)))
        datum={'name':'Origin','offsetX':'0 mm','offsetY':'0 mm','offsetZ':'Height','angle':'Phase',
            'isFlipped':False,'xAxis':'x','zAxis':'z','parameters':[
                {'name':'Height','expression':'10 mm','unit':'mm','dependsOn':[]},
                {'name':'Phase','expression':'0 deg','unit':'deg','dependsOn':[]}]}
        self.ns['_external_validate_root_datums'](ctx,{'mode':'composeNew','rootDatums':[datum],'parameterBindings':[]})
        bad={**datum,'parameters':[{'name':'Height','expression':'10 mm','unit':'mm','dependsOn':['Phase']},datum['parameters'][1]]}
        with self.assertRaisesRegex(ValueError,'topologically ordered'):
            self.ns['_external_validate_root_datums'](ctx,{'mode':'composeNew','rootDatums':[bad],'parameterBindings':[]})
        duplicate=[datum,{**datum,'parameters':[]}]
        with self.assertRaisesRegex(ValueError,'unique'):
            self.ns['_external_validate_root_datums'](ctx,{'mode':'composeNew','rootDatums':duplicate,'parameterBindings':[]})

    def test_every_local_restore_setter_recompute_and_readback_is_attempted(self):
        class Parameter:
            def __init__(inner,name):inner.name=name;inner._expression='changed'
            @property
            def expression(inner):return inner._expression
            @expression.setter
            def expression(inner,value):
                self.effects.append(inner.name)
                if inner.name=='first':raise RuntimeError('setter failed')
                inner._expression=value
        parameters={name:Parameter(name) for name in ('first','second')}
        ctx=types.SimpleNamespace(design=types.SimpleNamespace(userParameters=types.SimpleNamespace(itemByName=parameters.get),
            computeAll=lambda:(self.effects.append('compute'),False)[1]))
        result=self.ns['_external_restore_local'](ctx,{'first':'1 mm','second':'2 mm'})
        self.assertEqual(self.effects,['first','second','compute']);self.assertEqual(len(result),3)
        self.assertEqual(parameters['second'].expression,'2 mm')

    def test_static_native_routes_use_real_sdk_methods_and_no_product_or_repair_replay(self):
        source=(ROOT/'runtime/python/fmcad/adapters/fusion/externalization.py').read_text();tree=ast.parse(source)
        calls={n.func.attr for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute)}
        self.assertTrue({'saveCopyAs','addByInsert','replace','moveToComponent','save','saveAs'}<=calls)
        self.assertFalse({'setSourceEntities','promote','breakLink','uploadFile','executeTextCommand','terminateActiveCommand'}&calls)
        self.assertIn('inp.sourceEntities=[inp.sourceDesign.rootComponent]',source)
        self.assertIn('adsk.fusion.DesignTypes.ParametricDesignType',source)
        self.assertIn('old.replace(file,False)',source)
        self.assertNotIn('Cat Water Gun',source)
        self.assertNotIn('urn:adsk.',source)

    def test_owned_native_fixture_scripts_are_generic_and_do_not_save_or_cleanup_resources(self):
        fixture_dir=ROOT/'tests'/'fixtures'/'externalization'
        for name in ('build_case.py','insert_external.py','inspect_case.py'):
            source=(fixture_dir/name).read_text()
            ast.parse(source,filename=name)
            self.assertNotIn('Cat Water Gun',source)
            self.assertNotIn('urn:adsk.',source)
            self.assertNotIn('.close(',source)
            self.assertNotIn('.deleteMe(',source)
            self.assertNotIn('.save(',source)

    def test_unknown_cross_file_publication_never_runs_restore_save_from_finally(self):
        parameter=types.SimpleNamespace(expression='baseline')
        def save(_):self.effects.append('save');raise RuntimeError('publication outcome unknown')
        source=types.SimpleNamespace(doc=types.SimpleNamespace(dataFile=types.SimpleNamespace(versionNumber=2),save=save),
            design=types.SimpleNamespace(userParameters=types.SimpleNamespace(itemByName=lambda _:parameter),computeAll=lambda:True))
        runtime={'source':source,'target':None,'items':{},'probes':{'probe':{'stage':'publish','source':{'fileId':'producer'},
            'originalExpressions':{'driver':'baseline'}}},'probeHandles':{'probe':source},'compensation':None}
        data={'remainingMs':10000,'phase':'verify:assembly','manifest':{'probes':[{'probeId':'probe','itemId':'unit','parameter':'driver','expression':'changed'}]}}
        self.ns['_external_activate']=lambda _:None
        self.ns['_external_restore_local']=lambda *args:self.reject('must not restore after unknown publication')
        with self.assertRaisesRegex(RuntimeError,'publication outcome unknown'):
            self.ns['_external_probe_step'](runtime,data,{'spec':{'itemId':'unit'}},0)
        self.assertEqual(self.effects,['save']);self.assertEqual(parameter.expression,'changed')
        self.assertTrue(runtime['compensation']['pending']);self.assertEqual(runtime['compensation']['originalExpressions'],{'driver':'baseline'})

    def test_assembly_probe_checks_preflight_before_producer_lookup_or_local_assignment(self):
        events=[]
        self.ns['_measure_validate_parameter_check']=lambda ctx,check:events.append(('check',check))
        self.ns['_external_source_pin']=lambda *args:(events.append(('source',None)),self.reject('stop after preflight'))[1]
        self.ns['_measure_parameter_test']=lambda *args:(events.append(('setter',None)),self.reject('probe setter must not run'))[1]
        probe={'probeId':'probe','itemId':'unit','scope':'assembly','source':{'fileId':'producer'},
            'parameter':'Drive','expression':'12 mm','minimum':'8 mm','maximum':'16 mm','checks':[{'expected':'2 mm'}]}
        runtime={'target':object(),'source':object(),'items':{},'probes':{}}
        data={'phase':'verify:assembly','remainingMs':100000,'manifest':{'probes':[probe]}}
        with self.assertRaisesRegex(ValueError,'stop after preflight'):
            self.ns['_external_probe_step'](runtime,data,{'spec':{'itemId':'unit'}},0)
        self.assertEqual([event[0] for event in events],['check','source'])

    def test_assembly_probe_budget_keeps_declared_restore_reserve_and_stops_before_source_lookup(self):
        budget=self.ns['_external_probe_local_budget']
        self.assertEqual(budget(100000,60000),40000)
        self.assertIsNone(budget(60000,60000))
        self.assertEqual(budget(1000,0),1000)
        events=[]
        self.ns['_external_source_pin']=lambda *args:(events.append('source'),self.reject('source lookup must not run'))[1]
        probe={'probeId':'probe','itemId':'unit','scope':'assembly'}
        runtime={'target':object(),'source':object(),'items':{},'probes':{}}
        data={'phase':'verify:assembly','remainingMs':60000,'manifest':{'probes':[probe]}}
        result=self.ns['_external_probe_step'](runtime,data,{'spec':{'itemId':'unit'}},0)
        self.assertEqual(result['status'],'pending')
        self.assertEqual(result['receipt']['stopReason'],'budgetExhausted')
        self.assertEqual(result['receipt']['restorationReserveMsPlanned'],60000)
        self.assertEqual(result['receipt']['restorationReserveMsUsed'],0)
        self.assertEqual(events,[])

    def test_assembly_probe_subtracts_restore_reserve_from_local_parameter_test_budget(self):
        events=[]
        parameter=types.SimpleNamespace(name='Drive',unit='mm',expression='10 mm')
        producer_file=types.SimpleNamespace(id='producer',parentProject=self.project,versionNumber=2,isComplete=True,
            isReadOnly=False,parentFolder=types.SimpleNamespace(id='folder'))
        producer=self.doc();producer.dataFile=producer_file
        producer_design=types.SimpleNamespace(userParameters=types.SimpleNamespace(itemByName=lambda name:parameter),
            unitsManager=types.SimpleNamespace(evaluateExpression=lambda expression,unit:float(expression.split()[0])))
        producer_ctx=types.SimpleNamespace(doc=producer,design=producer_design,root=types.SimpleNamespace(bRepBodies=[]))
        consumer_file=types.SimpleNamespace(id='consumer')
        target=types.SimpleNamespace(app=types.SimpleNamespace(),doc=types.SimpleNamespace(dataFile=consumer_file))
        self.ns['_external_source_pin']=lambda *args:{'projectId':'project','fileId':'producer','version':2}
        self.ns['_references_project_file']=lambda *args:producer_file
        self.ns['_external_owned_document']=lambda *args:(producer,{'lifecycleEffects':[]})
        self.ns['_external_ctx']=lambda doc:producer_ctx
        self.ns['_external_activate']=lambda ctx:[]
        self.ns['_external_snapshot']=lambda root:{'bodies':[]}
        self.ns['_external_bodies']=lambda root:[]
        self.ns['_measure_validate_parameter_check']=lambda *args:None
        def parameter_test(ctx,payload,*callbacks):
            events.append(payload['timeBudgetMs'])
            return {'passed':True,'restored':True,'cases':[],'restorationReserveMsUsed':5}
        self.ns['_measure_parameter_test']=parameter_test
        probe={'probeId':'probe','itemId':'unit','scope':'assembly','source':{'fileId':'producer'},
            'parameter':'Drive','expression':'12 mm','minimum':'8 mm','maximum':'16 mm','checks':[{'expected':'2 mm'}]}
        runtime={'target':target,'source':target,'items':{'unit':{}},'probes':{},'completedProbes':set(),
            'sourceFingerprint':'fingerprint'}
        data={'phase':'verify:assembly','remainingMs':100000,'operationId':'op','manifest':{'probes':[probe]}}
        result=self.ns['_external_probe_step'](runtime,data,{'spec':{'itemId':'unit'}},0)
        self.assertEqual(events,[], 'No producer setter while the consumer baseline is still live')
        self.assertTrue(result['receipt']['localProbeDeferred'])
        self.assertEqual(runtime['probes']['probe']['stage'],'baselineSave')
        runtime['probes']['probe']['stage']='localProbe'
        target.doc.isValid=True
        with self.assertRaisesRegex(ValueError,'Consumer must be closed'):
            self.ns['_external_probe_step'](runtime,data,{'spec':{'itemId':'unit'}},1)
        self.assertEqual(events,[])
        target.doc.isValid=False
        result=self.ns['_external_probe_step'](runtime,data,{'spec':{'itemId':'unit'}},1)
        self.assertEqual(events,[40000])
        self.assertEqual(runtime['probes']['probe']['restorationReserveMsPlanned'],60000)
        self.assertEqual(result['status'],'pending')

    def test_nested_refresh_uses_saved_consumer_pin_published_driver_receipt_and_separate_ui_leases(self):
        driver_lease={'token':'forward'};restore_lease={'token':'restore'}
        probe={'probeId':'width-driver','refresh':{'reportPath':'/owned/refresh','nativeFallback':'qualifiedOnce',
            'driverUiLeases':{'consumer':driver_lease},'restoreUiLeases':{'consumer':restore_lease}}}
        stage_binding={'sourceFileId':'driver','sourceParameter':'IW79_Driver',
            'nativeDerivedParameter':'IW79_Driver_Ref','consumerAlias':'IW79_Alias','featureToken':'stale-stage-token'}
        current_edge={'edgeId':'derive-edge','edgeIdentityUnique':True,'kind':'derive','sourceFileId':'driver',
            'sourceParameters':[{'name':'IW79_Driver'}],'derivedParameters':[{'name':'IW79_Driver_Ref'}],
            'featureToken':'saved-consumer-token'}
        refresh_bindings=self.ns['_external_probe_refresh_bindings']([stage_binding],
            [current_edge,{'edgeId':'linked-edge','edgeIdentityUnique':True,'kind':'linked','sourceFileId':'child'}])
        self.assertEqual(refresh_bindings[0]['edgeId'],'derive-edge',
            'the immutable .10 edge identity comes from the saved consumer, not a pre-save feature token')
        state={'targetPin':{'projectId':'project','fileId':'consumer','version':3,'creationId':'consumer-creation'},
            'source':{'projectId':'project','fileId':'driver','version':5},'publishedVersion':5,
            'refreshBindings':refresh_bindings,
            'baselineEdges':[{'edgeId':'derive-edge','sourceFileId':'driver','baselineVersion':4},
                {'edgeId':'linked-edge','sourceFileId':'child','baselineVersion':1}]}
        data={'operationId':'op'}

        forward=self.ns['_external_probe_refresh_plan_request'](data,probe,state,'width-driver')
        state['refreshRequest']=forward
        self.assertEqual(forward['root'],{'projectId':'project','fileId':'consumer','version':3})
        self.assertEqual(forward['nativeFallback'],'qualifiedOnce')
        self.assertEqual(forward['requestId'],'op_width-driver_driver_plan')
        self.assertEqual(forward['parameterBindings'],[{'edgeId':'derive-edge','sourceParameter':'IW79_Driver',
            'nativeDerivedParameter':'IW79_Driver_Ref','consumerAlias':'IW79_Alias'}])
        self.assertNotIn('sourceFileId',forward['parameterBindings'][0],
            'private receipt scope is not part of the .10 public parameterBindings contract')
        self.assertNotIn('uiLeases',forward)
        default=self.ns['_external_probe_refresh_plan_request'](data,
            {'refresh':{'reportPath':'/owned/default-refresh'}},state,'width-driver')
        self.assertEqual(default['nativeFallback'],'never','native UI routing is never inferred from a mixed plan')

        plan={'planId':'plan-id','invocationStatus':'complete','root':forward['root'],
            'edges':[{'edgeId':'derive-edge','kind':'derive','sourceFileId':'driver','targetVersion':5},
                     {'edgeId':'linked-edge','kind':'linked','sourceFileId':'child','targetVersion':1}]}
        self.ns['_external_probe_validate_refresh_plan'](state,plan)
        apply=self.ns['_external_probe_refresh_apply_request'](data,probe,state,'width-driver',plan)
        self.assertEqual(apply['root'],forward['root'])
        self.assertEqual(apply['planId'],'plan-id')
        self.assertEqual(apply['requestId'],'op_width-driver_driver_apply')
        self.assertIs(apply['uiLeases'],probe['refresh']['driverUiLeases'])
        self.assertEqual(apply['nativeFallback'],'qualifiedOnce')

        restoring=dict(state,restoring=True,
            targetPin={**state['targetPin'],'version':4},
            source={'projectId':'project','fileId':'driver','version':6},publishedVersion=6)
        restore_plan=self.ns['_external_probe_refresh_plan_request'](data,probe,restoring,'width-driver')
        restoring['refreshRequest']=restore_plan
        restore_plan_receipt={'planId':'restore-plan','invocationStatus':'complete','root':restore_plan['root'],
            'edges':[dict(plan['edges'][0],targetVersion=6),plan['edges'][1]]}
        self.ns['_external_probe_validate_refresh_plan'](restoring,restore_plan_receipt)
        restore_apply=self.ns['_external_probe_refresh_apply_request'](
            data,probe,restoring,'width-driver',restore_plan_receipt)
        self.assertEqual(restore_plan['requestId'],'op_width-driver_restore_plan')
        self.assertEqual(restore_plan['root']['version'],4,'restore plan uses the saved forward consumer result version')
        self.assertEqual(restore_apply['requestId'],'op_width-driver_restore_apply')
        self.assertIs(restore_apply['uiLeases'],probe['refresh']['restoreUiLeases'])

        with self.assertRaisesRegex(ValueError,'exact settled producer publication receipt'):
            self.ns['_external_probe_refresh_plan_request'](data,probe,
                dict(state,source={'projectId':'project','fileId':'driver','version':4}),'width-driver')
        with self.assertRaisesRegex(ValueError,'exact producer publication'):
            self.ns['_external_probe_validate_refresh_plan'](state,
                dict(plan,edges=[dict(plan['edges'][0],targetVersion=6),plan['edges'][1]]))
        with self.assertRaisesRegex(ValueError,'omitted or changed the declared published driver binding edge'):
            self.ns['_external_probe_validate_refresh_plan'](state,
                dict(plan,edges=[plan['edges'][1]]))

    def test_baseline_observation_repins_the_authorized_save_result_not_the_stale_open_version(self):
        project=types.SimpleNamespace(id='project')
        folder=types.SimpleNamespace(id='folder')
        old_file=types.SimpleNamespace(id='consumer',parentProject=project,parentFolder=folder,
            versionNumber=2,latestVersionNumber=3,isComplete=True,isReadOnly=False)
        new_file=types.SimpleNamespace(id='consumer',parentProject=project,parentFolder=folder,
            versionNumber=3,latestVersionNumber=3,isComplete=True,isReadOnly=False)
        current_file=[old_file]
        class SavedDocument:
            creationId='consumer-editor-v2'
            isModified=False
            @property
            def dataFile(self):return current_file[0]
        old_doc=SavedDocument()
        new_doc=types.SimpleNamespace(dataFile=new_file,creationId='consumer-editor-v3',isModified=False)
        old_ctx=types.SimpleNamespace(doc=old_doc,app=types.SimpleNamespace(),root=object())
        new_ctx=types.SimpleNamespace(doc=new_doc,app=old_ctx.app,root=object(),ref=lambda value:value)
        self.ns['_external_fingerprint']=lambda _: 'unchanged'
        def current_project_file(*args):
            current_file[0]=new_file
            return new_file
        self.ns['_references_project_file']=current_project_file
        self.ns['_external_close_owned_clean_doc']=lambda ctx,pin:{'action':'closed','docid':ctx.doc.creationId,
            'owned':True,'identity':{'fileId':'consumer','version':pin['version']}}
        self.ns['_external_document']=lambda app,pin,allow_open,editable:(new_doc,{'status':'resolved',
            'lifecycleEffects':[{'action':'opened','docid':new_doc.creationId,'owned':True}]})
        self.ns['_external_ctx']=lambda doc:new_ctx
        self.ns['_references_current_edges']=lambda ctx:[]
        self.ns['_references_collect_graph']=lambda data:{'graphComplete':True,'edges':[],'lifecycleEffects':[]}
        probe={'probeId':'driver','itemId':'module','source':{'fileId':'producer'},
            'parameter':'IW79_Driver','expression':'15 mm','minimum':'8 mm','maximum':'16 mm',
            'checks':[{'expected':'1.5 cm^3'}],'refresh':{'reportPath':'/owned/refresh'}}
        state={'stage':'baselineObserve','targetBaseline':2,'baselineSaveSubmitted':True,
            'source':{'fileId':'producer'},'publishedVersion':None,'targetPin':None,'refreshBindings':[]}
        runtime={'source':old_ctx,'target':None,'items':{'module':{'originals':[],'staged':[],'instanceMap':[],
            'retireMap':[]}},'boundaries':[],'referenceHelpers':[],'sourceFingerprint':'unchanged',
            'probeHandles':{'driver':object()},
            'probes':{'driver':state},'completedProbes':set(),'compensation':None}
        data={'phase':'verify:assembly','remainingMs':100000,'operationId':'saved-root',
            'manifest':{'probes':[probe],'mode':'copyAndReplace'},
            'result':{'byItem':{'module':{'phaseResults':{'verify':{'assembly':{'receipt':{}}}}}}}}
        result=self.ns['_external_probe_step'](runtime,data,{'spec':{'itemId':'module'}},8)
        self.assertEqual(result['receipt']['consumerBaseline']['version'],3)
        self.assertEqual(result['receipt']['consumerBaseline']['creationId'],'consumer-editor-v2')
        self.assertIs(runtime['source'],old_ctx)
        self.assertEqual([row['action'] for row in result['lifecycleEffects']],['closed'])

    def test_probe_child_cleanup_closes_only_explicit_bound_item_editors_without_open(self):
        runtime={'items':{'bound':{'targetPin':{'fileId':'own-child','version':3}},
            'other':{'targetPin':{'fileId':'other','version':1}}}}
        manifest={'parameterBindings':[{'targetItemId':'bound'},{'consumerAlias':'rootAlias'}]}
        owned=object();calls=[]
        def resolve(app,pin,allow_open,editable):
            calls.append(pin);self.assertFalse(allow_open);self.assertTrue(editable)
            return owned,{'status':'resolved'}
        self.ns['_external_document']=resolve;self.ns['_external_ctx']=lambda doc:doc
        self.ns['_external_close_owned_clean_doc']=lambda ctx,pin:{'closed':pin['fileId']}
        result=self.ns['_external_close_probe_children'](runtime,manifest,self.app)
        self.assertEqual(result,[{'closed':'own-child'}]);self.assertEqual(len(calls),1)
        self.assertEqual(calls[0]['context'],'topLevel')

    def test_reconciled_producer_close_advances_without_repeating_close_or_save(self):
        pin={'fileId':'producer','version':2}
        state={'stage':'publishObserve','source':pin,'publishedVersion':2}
        runtime={'source':object(),'target':None,'probes':{'driver':state},
            'probeHandles':{'driver':types.SimpleNamespace(app=types.SimpleNamespace(documents=[]))},'compensation':{}}
        data={'phase':'verify:assembly','manifest':{'probes':[{'probeId':'driver','itemId':'module'}]},
            'result':{'byItem':{'module':{'phaseResults':{'verify':{'assembly':{'receipt':
                {'producerCloseObserved':True,'publishedSource':pin}}}}}}}}
        result=self.ns['_external_probe_step'](runtime,data,{'spec':{'itemId':'module'}},7)
        self.assertEqual(result['status'],'pending');self.assertEqual(result['receipt']['cursor'],8)
        self.assertEqual(state['stage'],'refreshPlan');self.assertFalse(runtime['compensation']['pending'])

    def test_baseline_publication_waits_for_editor_version_without_close_or_second_save(self):
        file=types.SimpleNamespace(versionNumber=2,isComplete=True,parentProject=types.SimpleNamespace(id='project'),id='consumer')
        ctx=types.SimpleNamespace(doc=types.SimpleNamespace(dataFile=file,isModified=False),app=self.app)
        self.ns['_references_project_file']=lambda *args:types.SimpleNamespace(versionNumber=3)
        self.ns['_external_close_owned_clean_doc']=lambda *args:self.reject('must not close transient old version')
        probe={'probeId':'driver','itemId':'module'}
        state={'stage':'baselineObserve','targetBaseline':2,'baselineSaveSubmitted':True}
        runtime={'source':ctx,'target':None,'probes':{'driver':state},'probeHandles':{'driver':object()}}
        data={'phase':'verify:assembly','manifest':{'probes':[probe]}}
        result=self.ns['_external_probe_step'](runtime,data,{'spec':{'itemId':'module'}},4)
        self.assertEqual(result['status'],'pending');self.assertTrue(result['waitingPublication'])
        self.assertEqual(result['receipt']['cursor'],4);self.assertEqual(state['stage'],'baselineObserve')

    def test_logical_deadline_after_local_compute_restores_without_starting_publication(self):
        parameter=types.SimpleNamespace(expression='baseline');clock=[0]
        def compute():self.effects.append('compute');clock[0]+=2;return True
        source=types.SimpleNamespace(doc=types.SimpleNamespace(dataFile=types.SimpleNamespace(versionNumber=2),
            save=lambda _:self.reject('must not publish after forward deadline')),
            design=types.SimpleNamespace(userParameters=types.SimpleNamespace(itemByName=lambda _:parameter),computeAll=compute))
        runtime={'source':source,'target':None,'items':{},'probes':{'probe':{'stage':'publish','source':{'fileId':'producer'},
            'originalExpressions':{'driver':'baseline'}}},'probeHandles':{'probe':source},'compensation':None}
        data={'remainingMs':1000,'phase':'verify:assembly','manifest':{'probes':[{'probeId':'probe','itemId':'unit','parameter':'driver','expression':'changed'}]}}
        self.ns['_external_activate']=lambda _:None;self.ns['_external_time']=types.SimpleNamespace(monotonic=lambda:clock[0])
        result=self.ns['_external_probe_step'](runtime,data,{'spec':{'itemId':'unit'}},0)
        self.assertEqual(result['status'],'pending');self.assertTrue(result['receipt']['restored'])
        self.assertTrue(result['receipt']['budgetExceeded']);self.assertEqual(parameter.expression,'baseline')
        self.assertEqual(self.effects,['compute','compute'])


    def test_group_parent_poll_uses_only_original_future_and_never_name_candidate(self):
        ctx=types.SimpleNamespace(root=object())
        originals={name:types.SimpleNamespace(fullPathName=name) for name in ('A:1','B:1')}
        self.ns['_external_occurrence']=lambda ctx,ref:originals[ref]
        self.ns['_external_folder']=lambda *args:self.reject('must not discover/promote a name candidate')
        file=types.SimpleNamespace(id='original-receipt-file',parentProject=self.project,
            parentFolder=types.SimpleNamespace(id='folder'),name='pair__op__staging',versionNumber=1,isComplete=True)
        class Future:
            uploadState=0
            @property
            def dataFile(inner):
                if inner.uploadState==0:self.reject('Processing cannot provide completion evidence')
                return file
        future=Future()
        entry={'spec':{'groupId':'pair','destination':{'fileName':'pair','projectId':'project','folderId':'folder'}},
            'groupParentFuture':future,'future':None}
        data={'operationId':'op','manifest':{'extractionGroups':[{'id':'pair','members':['A:1','B:1']}]}}
        for _ in range(3):
            result=self.ns['_external_group_copy']({'source':ctx},data,entry,1)
            self.assertEqual(result['status'],'pending');self.assertEqual(result['receipt']['cursor'],1)
            self.assertIs(entry['groupParentFuture'],future);self.assertNotIn('groupParentPin',entry)
        future.uploadState=1
        result=self.ns['_external_group_copy']({'source':ctx},data,entry,1)
        self.assertEqual(result['receipt']['cursor'],2)
        self.assertEqual(entry['groupParentPin']['fileId'],'original-receipt-file')
        self.assertIsNone(entry['future'])

    def test_group_combine_deferral_never_rolls_or_reads_saved_source_inputs(self):
        class Combine:
            kind='CombineFeature'
            @property
            def targetBody(inner):self.reject('source input getter must not run')
        owner=types.SimpleNamespace(features=[Combine()],allOccurrences=[])
        self.ns['_external_dependency_coverage'](owner,[owner],defer_combine=True)
        owner.features.append(types.SimpleNamespace(kind='UnsupportedFeature'))
        with self.assertRaisesRegex(ValueError,'Unsupported'):
            self.ns['_external_dependency_coverage'](owner,[owner],defer_combine=True)

    def test_combine_marker_restore_failure_is_unknown_not_initial_not_started(self):
        class Timeline:
            current=8
            @property
            def markerPosition(inner):return inner.current
            @markerPosition.setter
            def markerPosition(inner,value):
                if value==8:raise RuntimeError('restore rejected')
                inner.current=value
        timeline=Timeline();owner=types.SimpleNamespace(parentDesign=types.SimpleNamespace(timeline=timeline))
        def roll(before):timeline.markerPosition=3;return True
        class Combine:
            kind='CombineFeature';parentComponent=owner
            timelineObject=types.SimpleNamespace(rollTo=roll);toolBodies=[]
            @property
            def targetBody(inner):
                if timeline.markerPosition!=3:raise RuntimeError("Didn't roll editing feature back")
                return types.SimpleNamespace(parentComponent=owner)
        with self.assertRaises(self.ns['_ExternalTimelineRestoreError']):
            self.ns['_external_feature_input_owners'](Combine(),True)
        self.ns['_external_registry']=lambda create:{}
        def initial(data):raise self.ns['_ExternalTimelineRestoreError']('restore rejected')
        self.ns['_external_initial']=initial
        result=self.ns['_external_refresh_internal']('perform',{'operationId':'op','result':{'byItem':{}}})
        self.assertEqual(result['status'],'unknown');self.assertNotIn('notStarted',result['receipt'])

    def test_coincident_repeated_parents_with_duplicate_roles_block_before_insert(self):
        identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
        parents={path:types.SimpleNamespace(entityToken=path) for path in ('Parent:1','Parent:2')}
        self.ns['_external_destination']=lambda *args:(None,None,types.SimpleNamespace(asArray=lambda:identity),list(parents))
        self.ns['_external_destination_parent']=lambda ctx,path:parents[path]
        self.ns['_entity_occurrence_matrix']=lambda *args:identity
        self.ns['_entity_inverse']=lambda matrix:matrix
        self.ns['_entity_multiply']=lambda *args:identity
        self.ns['_external_parent_context_match']=lambda *args:True
        self.ns['_measure_pose_delta']=lambda *args:(0,0)
        ctx=types.SimpleNamespace(doc=types.SimpleNamespace(creationId='target',dataFile=types.SimpleNamespace(id='target')))
        source=types.SimpleNamespace(doc=types.SimpleNamespace(creationId='source',dataFile=types.SimpleNamespace(id='source')))
        with self.assertRaisesRegex(ValueError,'callerNamespaces'):
            self.ns['_external_stage_insert_plan'](ctx,source,
                {'destinationOccurrence':'Parent','sharedParentPolicy':'allInstances'},
                [{'worldPose':identity},{'worldPose':identity}],0,{'linear':1e-9,'angular':1e-9})

    def test_regular_boundary_preserves_typed_motion_expressions_frames_and_nonzero_limits(self):
        for kind in (0,1):
            with self.subTest(kind=kind):
                actions=[];ends=[(object(),object()),(object(),object())]
                limits=types.SimpleNamespace();motion=types.SimpleNamespace(rotationAxis=0,rotationValue=0.0,rotationLimits=limits)
                joint=types.SimpleNamespace(healthState=0,jointMotion=motion,occurrenceOne=ends[0][1],occurrenceTwo=ends[1][1],
                    isFlipped=True,offset=types.SimpleNamespace(expression='mountOffset + 2 mm'),
                    angle=types.SimpleNamespace(expression='mountAngle - 3 deg'))
                inp=types.SimpleNamespace(setAsRigidJointMotion=lambda:actions.append('rigid'),
                    setAsRevoluteJointMotion=lambda axis:actions.append(('revolute',axis)))
                def create(a,b):
                    self.assertIs(a,ends[0][0]);self.assertIs(b,ends[1][0]);return inp
                def add(value):self.assertIs(value,inp);actions.append('add');return joint
                ctx=types.SimpleNamespace(root=types.SimpleNamespace(joints=types.SimpleNamespace(createInput=create,add=add)),
                    ref=lambda obj:{'joint':'new'},design=types.SimpleNamespace(snapshots=types.SimpleNamespace(hasPendingSnapshot=False)))
                self.ns['adsk'].core.ValueInput=types.SimpleNamespace(createByString=lambda value:value)
                self.ns['_external_endpoint']=lambda runtime,ctx,s,c,require_geometry:ends[s['index']]
                self.ns['_external_ensure_attributes']=lambda entity,attrs:actions.append(('attrs',attrs))
                row={'form':'Joint','kind':kind,'rotationAxis':0,'rotationValue':.35,'name':'TypedBoundary',
                    'offset':'mountOffset + 2 mm','angle':'mountAngle - 3 deg','flipped':True,'attrs':[('fixture','role','boundary')],
                    'spec':{'endpoints':[{'index':0},{'index':1}]},'endpoints':[{},{}],
                    'limits':{'minimumValue':.2,'maximumValue':1.2,'restValue':.35,
                        'isMinimumValueEnabled':True,'isMaximumValueEnabled':False,'isRestValueEnabled':True},'new':None}
                result=self.ns['_external_rebuild_joint']({'tolerance':{'angular':1e-9}},ctx,row)
                self.assertEqual(result,{'joint':'new'});self.assertIs(row['new'],joint)
                self.assertEqual(actions.count('add'),1)
                self.assertEqual(actions[0],'rigid' if kind==0 else ('revolute',0))
                self.assertEqual(inp.offset,row['offset']);self.assertEqual(inp.angle,row['angle']);self.assertTrue(inp.isFlipped)
                if kind==1:
                    self.assertEqual(motion.rotationValue,.35)
                    self.assertEqual(vars(limits),row['limits'])
                    class ClampedMotion:
                        rotationAxis=0
                        rotationLimits=types.SimpleNamespace()
                        attempted=None
                        @property
                        def rotationValue(inner):return 0.0
                        @rotationValue.setter
                        def rotationValue(inner,value):inner.attempted=value
                    joint.jointMotion=ClampedMotion();row['new']=None;actions.clear()
                    with self.assertRaisesRegex(ValueError,'after assignment'):
                        self.ns['_external_rebuild_joint']({'tolerance':{'angular':1e-9}},ctx,row)
                    self.assertEqual(joint.jointMotion.attempted,.35)
                    self.assertIsNone(row['new']);self.assertEqual(actions.count('add'),1)

    def test_unsupported_boundary_dof_rejects_before_any_detach(self):
        occurrence=types.SimpleNamespace(fullPathName='Module:1')
        joint=types.SimpleNamespace(kind='Joint',jointMotion=types.SimpleNamespace(jointType=2))
        self.ns['_external_joint']=lambda *args:joint
        self.ns['_external_validate_root_datums']=lambda *args:None
        runtime={'source':object(),'items':{'module':{'originals':[occurrence]}}}
        manifest={'items':[{'itemId':'module'}],'boundaries':[{'id':'unsupported','joint':{'token':'joint'},
            'endpoints':[{'itemId':'module','componentOrigin':True},{'itemId':'module','componentOrigin':True}]}]}
        with self.assertRaisesRegex(ValueError,'Only native rigid and revolute'):
            self.ns['_external_preflight_boundaries'](runtime,manifest)
        self.assertEqual(runtime['boundaries'],[])

    def test_group_member_boundary_selects_member_inside_one_staged_group_not_second_group(self):
        component=types.SimpleNamespace(name='Tool',attributes=[])
        enclosing=types.SimpleNamespace(fullPathName='Group:1')
        member=types.SimpleNamespace(fullPathName='Group:1+Tool:1',component=component)
        runtime={'items':{'pair':{'spec':{'groupId':'pair'},'staged':[enclosing]}}}
        ctx=types.SimpleNamespace(root=types.SimpleNamespace(allOccurrences=[enclosing,member]))
        geometry,selected=self.ns['_external_endpoint'](runtime,ctx,
            {'itemId':'pair','memberIndex':1,'relativePath':'Tool:1'},
            {'componentName':'Tool','componentAttributes':[]},require_geometry=False)
        self.assertIsNone(geometry);self.assertIs(selected,member)

    def test_group_boundary_preflight_requires_explicit_member_path_not_instance_index(self):
        check=self.ns['_external_boundary_endpoint_preflight']
        check({'itemId':'pair','memberIndex':1,'relativePath':'Tool:1'}, {'pair'}, {'pair'},set())
        for endpoint in ({'itemId':'pair','memberIndex':1},
                         {'itemId':'pair','instanceIndex':0,'relativePath':'Tool:1'}):
            with self.assertRaisesRegex(ValueError,'exact member relativePath'):
                check(endpoint,{'pair'},{'pair'},set())

    def test_boundary_origin_preserves_arbitrary_local_frame_and_rejects_drift_before_proxy(self):
        frame=[0,0,1,2,0,1,0,3,-1,0,0,4,0,0,0,1]
        proxy=object();calls=[]
        origin=types.SimpleNamespace(transform=types.SimpleNamespace(asArray=lambda:frame),
            createForAssemblyContext=lambda occurrence:(calls.append(occurrence) or proxy))
        component=types.SimpleNamespace(name='Module',attributes=[],
            jointOrigins=types.SimpleNamespace(itemByName=lambda name:origin if name=='NonZFrame' else None))
        occurrence=types.SimpleNamespace(component=component)
        runtime={'items':{'module':{'spec':{},'staged':[occurrence]}},'tolerance':{'linear':1e-9,'angular':1e-9}}
        self.ns['_measure_pose_delta']=lambda a,b:(0,0) if a==b else (0,1)
        endpoint={'itemId':'module','originName':'NonZFrame'}
        captured={'transform':list(frame),'componentAttributes':[]}
        geometry,actual=self.ns['_external_endpoint'](runtime,object(),endpoint,captured)
        self.assertIs(geometry,proxy);self.assertIs(actual,occurrence);self.assertEqual(calls,[occurrence])
        captured['transform'][0]=1
        with self.assertRaisesRegex(ValueError,'origin frame differs'):
            self.ns['_external_endpoint'](runtime,object(),endpoint,captured)
        self.assertEqual(calls,[occurrence])

    def test_future_getter_failure_retains_original_holder_without_fabricated_terminal_state(self):
        class Future:
            @property
            def uploadState(inner):raise RuntimeError('SDK getter unavailable')
        future=Future();entry={'future':future}
        with self.assertRaisesRegex(RuntimeError,'SDK getter unavailable'):
            self.ns['_external_future'](entry,1,{})
        self.assertIs(entry['future'],future);self.assertNotIn('targetPin',entry)

    def test_repeated_native_definition_submits_once_and_other_instance_waits_for_exact_owner_receipt(self):
        copies=[]
        future=types.SimpleNamespace(uploadState=1,dataFile=self.file)
        component=types.SimpleNamespace(saveCopyAs=lambda *args:(copies.append(args) or future))
        destination={'projectId':'project','folderId':'folder','fileName':'Part'}
        owner={'spec':{'itemId':'owner','destination':destination},'definitionOwner':'owner',
            'component':component,'future':None,'targetPin':None}
        peer={'spec':{'itemId':'peer','destination':destination},'definitionOwner':'owner',
            'component':component,'targetPin':None}
        runtime={'source':types.SimpleNamespace(app=self.app),'items':{'owner':owner,'peer':peer}}
        self.ns['_external_activate']=lambda ctx:[]
        self.ns['_external_folder']=lambda *args:object()
        self.ns['_external_collision']=lambda *args:None
        def begin(runtime,data,entry,ctx,component,dest,folder,purpose,slot,cursor):
            entry[slot]=component.saveCopyAs(dest['fileName'],folder,'test','')
            return self.ns['_external_result']('pending',cursor+1)
        self.ns['_external_begin_copy']=begin
        blocked=self.ns['_external_copy'](runtime,{'operationId':'one-copy'},peer,0)
        self.assertEqual(blocked['status'],'blocked');self.assertEqual(copies,[])
        accepted=self.ns['_external_copy'](runtime,{'operationId':'one-copy'},owner,0)
        self.assertEqual(accepted['status'],'pending');self.assertEqual(len(copies),1)
        complete=self.ns['_external_copy'](runtime,{'operationId':'one-copy'},owner,1)
        self.assertEqual(complete['status'],'complete')
        reused=self.ns['_external_copy'](runtime,{'operationId':'one-copy'},peer,0)
        self.assertEqual(reused['status'],'complete');self.assertEqual(reused['receipt']['sharedDefinitionOwner'],'owner')
        self.assertEqual(peer['targetPin'],owner['targetPin']);self.assertEqual(len(copies),1)

    def test_native_fixture_assertions_cover_three_rigid_variants_and_non_z_revolute(self):
        import copy
        fixture={}
        exec(compile((ROOT/'tests/fixtures/externalization/inspect_case.py').read_text(),'inspect_case.py','exec'),fixture)
        identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
        non_z=[0,0,1,2,0,1,0,3,-1,0,0,4,0,0,0,1]
        expected=[]
        for i in range(3):
            expected.append({'name':'Rigid'+str(i),'collection':'joints','motionType':0,'healthState':0,
                'endpoints':['A'+str(i)+':1','B'+str(i)+':1'],'attributes':[('fixture','role','rigid'+str(i))],
                'angle':['0 deg','mountAngle + 3 deg','25 deg'][i],
                'offset':['0 mm','mountOffset + 2 mm','3 mm'][i],'isFlipped':i==2,
                'originTypes':['adsk::fusion::JointOrigin']*2,'originFrames':[list(non_z),list(identity)]})
        revolute=copy.deepcopy(expected[0]);revolute.update(name='NonZRevolute',motionType=1,rotationAxis=0,rotationValue=.35,
            rotationLimits={'minimumValue':.2,'maximumValue':1.2,'restValue':.35,
                'isMinimumValueEnabled':True,'isMaximumValueEnabled':False,'isRestValueEnabled':True})
        expected.append(revolute)
        verify=fixture['assert_boundary_snapshot']
        verify(copy.deepcopy(expected),expected,1e-6,1e-6)
        verify(copy.deepcopy(expected),json.loads(json.dumps(expected)),1e-6,1e-6)
        changes=[lambda rows:rows[2].update(isFlipped=False),lambda rows:rows[1].update(offset='12 mm'),
            lambda rows:rows[3].update(rotationAxis=2),lambda rows:rows[3].update(rotationValue=0),
            lambda rows:rows[3]['rotationLimits'].update(maximumValue=0),
            lambda rows:rows[3]['rotationLimits'].update(isMaximumValueEnabled=True),
            lambda rows:rows[0]['originFrames'][0].__setitem__(3,2.1),
            lambda rows:rows[0]['originFrames'].__setitem__(0,[1,0,0,2,0,1,0,3,0,0,1,4,0,0,0,1]),
            lambda rows:rows[0].update(healthState=1),lambda rows:rows.pop(),
            lambda rows:rows[0]['originFrames'].__setitem__(0,None)]
        for change in changes:
            observed=copy.deepcopy(expected);change(observed)
            with self.assertRaises(AssertionError):verify(observed,expected,1e-6,1e-6)
        unsupported=copy.deepcopy(expected);unsupported[0]['motionType']=2
        with self.assertRaisesRegex(AssertionError,'Unsupported'):
            verify(copy.deepcopy(unsupported),unsupported,1e-6,1e-6)

    def test_native_group_fixture_requires_preserved_helper_feature_not_just_equal_body_cache(self):
        import copy
        fixture={}
        exec(compile((ROOT/'tests/fixtures/externalization/inspect_case.py').read_text(),'inspect_case.py','exec'),fixture)
        expected=[{'component':'Target','name':'DrivenExtrude','type':'adsk::fusion::ExtrudeFeature',
            'parameters':[{'name':'distance','expression':'groupDriver','unit':'mm'}],
            'healthState':0,'isSuppressed':False},
            {'component':'Target','name':'SiblingToolCut','type':'adsk::fusion::CombineFeature',
             'parameters':None,'healthState':0,'isSuppressed':False},
            {'component':'Tool','name':'HistoryHelper','type':'adsk::fusion::ExtrudeFeature',
             'parameters':[],'healthState':0,'isSuppressed':False}]
        verify=fixture['assert_group_feature_snapshot']
        verify(copy.deepcopy(expected),expected)
        for alter in (lambda rows:rows.pop(),lambda rows:rows[1].update(healthState=1),
                      lambda rows:rows[1].update(isSuppressed=True),
                      lambda rows:rows[1].update(type='adsk::fusion::BaseFeature'),
                      lambda rows:rows[0]['parameters'][0].update(expression='10 mm')):
            actual=copy.deepcopy(expected);alter(actual)
            with self.assertRaises(AssertionError):verify(actual,expected)

    def copy_event_job(self):
        self.app.data=types.SimpleNamespace(findFileById=lambda file_id:self.file if file_id=='file' else None)
        intent={'nonce':'a'*64,'description':'Native copy [fmcad-copy:'+'a'*64+']','finalDescription':'Native copy',
            'destination':{'projectId':'project','folderId':'folder','fileName':'Part'}}
        self.file.description=intent['description']
        event={'event':'dataFileComplete','fileId':'file','version':2,'projectId':'project','folderId':'folder',
            'description':intent['description'],'name':'Part','isComplete':True,
            'status':{'isOK':True,'isError':False,'isWarning':False}}
        return {'intent':intent,'events':[event],'files':{'file':self.file},'handlers':[],
            'diagnostics':[],'disarmed':False,'submitted':True}

    def test_group_source_verify_defers_rolled_getter_only_with_owned_staging_coverage(self):
        calls=[];component=object();doc=object()
        self.ns['_references_project_file']=lambda *args:self.file
        self.ns['_external_refresh_complete']=lambda file:True
        self.ns['_external_document']=lambda *args,**kwargs:(doc,{'lifecycleEffects':[]})
        self.ns['_external_ctx']=lambda doc:types.SimpleNamespace(root=component)
        self.ns['_external_health']=lambda component:calls.append('health')
        self.ns['_external_dependency_coverage']=lambda component,owners,**kwargs:calls.append(kwargs['defer_combine'])
        self.ns['_external_compare']=lambda *args:{'passed':True}
        runtime={'source':types.SimpleNamespace(app=self.app),'sourceFingerprint':'same','tolerance':{}}
        entry={'spec':{'groupId':'group','itemId':'pair'},'baseline':{'bodies':[object()]},
            'targetPin':{'fileId':'file','projectId':'project','version':2}}
        self.ns['_external_verify'](runtime,{'phase':'verify:sources','manifest':{}},entry,0)
        self.assertEqual(calls,['health',False])
        calls.clear();entry['groupDependencyCoverage']={'parentCopy':{'fileId':'staging','version':1}}
        self.ns['_external_verify'](runtime,{'phase':'verify:sources','manifest':{}},entry,0)
        self.assertEqual(calls,['health',True])

    def test_group_move_restores_native_and_context_attributes_dropped_by_sdk(self):
        component=types.SimpleNamespace(name='Member')
        native=types.SimpleNamespace(attrs=[('fixture','native','n')])
        old=types.SimpleNamespace(component=component,attrs=[('fixture','context','c')],fullPathName='Member:1')
        fresh_native=types.SimpleNamespace(attrs=[])
        fresh=types.SimpleNamespace(component=component,attrs=[],nativeObject=fresh_native)
        copied=types.SimpleNamespace(component=component,attrs=list(old.attrs),nativeObject=native,
            moveToComponent=lambda enclosing:fresh)
        gd=types.SimpleNamespace(root=types.SimpleNamespace(occurrences=[copied]),ref=lambda o:{'name':'Member:1'})
        self.ns['_external_occurrence']=lambda *args:old
        self.ns['_external_ctx']=lambda doc:gd
        self.ns['_external_activate']=lambda ctx:[]
        self.ns['_external_attributes']=lambda obj:list(obj.attrs)
        self.ns['_external_ensure_attributes']=lambda obj,attrs:setattr(obj,'attrs',list(attrs))
        self.ns['_external_inventory']=lambda component:{}
        entry={'spec':{'groupId':'g','destination':{'fileName':'copy'}},'groupDoc':object(),
            'groupOccurrence':object(),'groupMoved':[]}
        result=self.ns['_external_group_copy']({'source':types.SimpleNamespace(root=object())},
            {'operationId':'op','manifest':{'extractionGroups':[{'id':'g','members':[{}]}]}},entry,3)
        self.assertEqual(result['status'],'pending')
        self.assertEqual(fresh.attrs,old.attrs);self.assertEqual(fresh_native.attrs,native.attrs)
        self.assertEqual(entry['groupMoved'],[fresh])

    def test_group_typed_rebind_requires_exact_body_provenance_and_restores_marker(self):
        timeline=types.SimpleNamespace(markerPosition=5);calls=[]
        class Collection(list):
            def add(self,item):self.append(item);return True
        self.ns['adsk'].core.ObjectCollection=types.SimpleNamespace(create=Collection)
        feature=types.SimpleNamespace(kind='CombineFeature',name='Cut',operation=1,isKeepToolBodies=True,healthState=1)
        def roll(before):timeline.markerPosition=2;return True
        feature.timelineObject=types.SimpleNamespace(rollTo=roll)
        material=types.SimpleNamespace(id='material')
        a=types.SimpleNamespace(attrs=[('role','body','a')],material=material)
        b=types.SimpleNamespace(attrs=[('role','body','b')],material=material)
        ca=types.SimpleNamespace(attrs=[('role','component','a')],bRepBodies=[a],features=types.SimpleNamespace(item=lambda i:feature))
        cb=types.SimpleNamespace(attrs=[('role','component','b')],bRepBodies=[b])
        members=[types.SimpleNamespace(attrs=[('role','occurrence','a')],component=ca),
                 types.SimpleNamespace(attrs=[('role','occurrence','b')],component=cb)]
        self.ns['_external_physical_occurrences']=lambda root:members
        self.ns['_external_attributes']=lambda obj:list(obj.attrs)
        self.ns['_external_ensure_attributes']=lambda obj,attrs:setattr(obj,'attrs',list(attrs))
        self.ns['_external_health']=lambda root:self.assertEqual(feature.healthState,0)
        def compute():calls.append('compute');feature.healthState=0;return True
        ctx=types.SimpleNamespace(root=object(),design=types.SimpleNamespace(timeline=timeline,computeAll=compute))
        entry={'baseline':{'occurrences':[{'attrs':list(o.attrs),'nativeAttrs':list(o.attrs),'componentAttrs':o.component.attrs} for o in members]},
            'groupCombineInputs':[{'memberIndex':0,'featureIndex':0,'name':'Cut','operation':1,'keepTools':True,
            'inputs':[{'memberIndex':0,'bodyAttrs':a.attrs,'material':'material'},
                      {'memberIndex':1,'bodyAttrs':b.attrs,'material':'material'}]}]}
        members[0].attrs=[];members[1].attrs=[]
        result=self.ns['_external_group_rebind_combines'](ctx,entry)
        self.assertEqual(members[0].attrs,entry['baseline']['occurrences'][0]['attrs'])
        self.assertEqual(result,[{'feature':'Cut','originalTypedInputsRebound':True}])
        self.assertIs(feature.targetBody,a);self.assertEqual(feature.toolBodies,[b]);self.assertEqual(timeline.markerPosition,5)
        feature.healthState=1;cb.bRepBodies.append(object())
        with self.assertRaisesRegex(ValueError,'ambiguous'):self.ns['_external_group_rebind_combines'](ctx,entry)
        self.assertEqual(timeline.markerPosition,5);self.assertEqual(calls,['compute'])

    def test_group_context_attributes_are_restored_on_root_proxy_not_linked_native(self):
        native=types.SimpleNamespace(attrs=[('role','native','a')])
        proxy=types.SimpleNamespace(fullPathName='Group:1+Member:1',nativeObject=native,attrs=[],
            component=types.SimpleNamespace(attrs=[('role','definition','a')]))
        ctx=types.SimpleNamespace(root=types.SimpleNamespace(allOccurrences=[proxy]))
        entry={'staged':[types.SimpleNamespace(fullPathName='Group:1')],
            'baseline':{'occurrences':[{'nativeAttrs':list(native.attrs),'attrs':[('role','context','a')],
                'componentAttrs':proxy.component.attrs}]}}
        self.ns['_external_attributes']=lambda o:list(o.attrs)
        self.ns['_external_ensure_attributes']=lambda o,attrs:setattr(o,'attrs',list(attrs))
        with self.assertRaisesRegex(ValueError,'root-context occurrence attributes differ'):
            self.ns['_external_group_context_attributes'](ctx,entry)
        self.ns['_external_group_context_attributes'](ctx,entry,apply=True)
        self.ns['_external_group_context_attributes'](ctx,entry)
        self.assertEqual(native.attrs,[('role','native','a')]);self.assertEqual(proxy.attrs,[('role','context','a')])

    def test_copy_status_snapshots_primitives_during_callback_not_transient_wrappers(self):
        status=types.SimpleNamespace(isOK=True,isError=False,isWarning=False)
        class Args:
            alive=True
            @property
            def isValid(self):return self.alive
            @property
            def status(self):
                if not self.alive:raise RuntimeError('expired event args')
                return status
        args=Args();row=self.ns['_external_capture_copy_status'](args)
        args.alive=False;status.isOK=False
        self.assertEqual(row,{'status':{'isError':False,'isWarning':False,'isOK':True},'statusReadContext':'notify'})

    def test_copy_status_capture_identifies_exact_throw_without_inventing_status(self):
        class Args:
            isValid=True
            @property
            def status(self):raise RuntimeError('2 : InternalValidationError : res')
        row=self.ns['_external_capture_copy_status'](Args())
        self.assertEqual(row['status'],{})
        self.assertEqual(row['statusReadErrorAt'],'args.status')
        self.assertEqual(row['statusReadContext'],'notify')
        self.assertEqual(row['statusReadError'],'RuntimeError: 2 : InternalValidationError : res')

    def test_copy_events_require_exact_nonce_project_folder_not_filename(self):
        for field,value in (('description','same name but no nonce'),('projectId','foreign'),('folderId','foreign')):
            job=self.copy_event_job();job['events'][0][field]=value
            result=self.ns['_external_future']({'future':types.SimpleNamespace(uploadState=0),'futureObserver':job},1,
                job['intent']['destination'])
            self.assertEqual(result['status'],'pending');self.assertFalse(job['disarmed'])

    def test_correlated_copy_event_can_complete_stale_future_with_exact_cloud_readback(self):
        job=self.copy_event_job();job['events'].append({**job['events'][0],'event':'dataFileCopyComplete'})
        future=types.SimpleNamespace(uploadState=0,dataFile=None);entry={'future':future,'futureObserver':job}
        result=self.ns['_external_future'](entry,1,job['intent']['destination'])
        self.assertEqual(result['status'],'complete');self.assertEqual(result['rawUploadState']['value'],0)
        self.assertEqual(result['receipt']['copyCompletion']['method'],'correlatedEvent')
        self.assertEqual(result['receipt']['copyCompletion']['rawUploadState']['value'],0)
        self.assertEqual(len(result['receipt']['copyCompletion']['events']),2)
        self.assertTrue(job['disarmed']);self.assertIs(entry['future'],future);self.assertIsNone(future.dataFile)

    def test_copy_event_duplicate_file_ids_failed_status_and_incomplete_cloud_never_promote(self):
        job=self.copy_event_job();job['events'].append({**job['events'][0],'fileId':'different-file'})
        self.assertEqual(self.ns['_external_copy_events'](job)['reason'],'copyNonceMatchedMultipleFiles')
        for status,wanted in (({'isOK':False,'isError':True,'isWarning':False},'failed'),
                              ({'isOK':False,'isError':False,'isWarning':True},'correlated'),({},'correlated')):
            job=self.copy_event_job();job['events'][0]['status']=status
            self.assertEqual(self.ns['_external_copy_events'](job)['status'],wanted)
        job=self.copy_event_job();self.file.isComplete=False;self.file.refresh=lambda _:self.effects.append('metadataRefresh')
        result=self.ns['_external_future']({'future':types.SimpleNamespace(uploadState=0),'futureObserver':job},1,
            job['intent']['destination'])
        self.assertEqual(result['status'],'pending');self.assertFalse(job['disarmed'])
        self.assertEqual(self.effects,['metadataRefresh'])

    def test_optional_event_read_failure_never_masks_explicit_failure_or_ambiguity(self):
        job=self.copy_event_job();job['observationFailed']=True
        job['events'][0]['status']={'isError':True}
        result=self.ns['_external_future']({'future':types.SimpleNamespace(uploadState=1,dataFile=self.file),
            'futureObserver':job},1,job['intent']['destination'])
        self.assertEqual(result['status'],'unknown')
        self.assertEqual(result['receipt']['reason'],'Contradictory native copy receipts')
        job=self.copy_event_job();job['observationFailed']=True
        job['events'].append({**job['events'][0],'fileId':'other'})
        self.assertEqual(self.ns['_external_copy_events'](job)['reason'],'copyNonceMatchedMultipleFiles')

    def test_copy_event_status_getter_error_is_separate_from_exact_identity_cloud_proof(self):
        job=self.copy_event_job();job['events'][0]['status']={};job['events'][0]['statusReadError']='SDK getter unavailable'
        pending={'future':types.SimpleNamespace(uploadState=0,dataFile=None),'futureObserver':job}
        result=self.ns['_external_future'](pending,1,job['intent']['destination'])
        self.assertEqual(result['status'],'complete');self.assertTrue(job['disarmed'])
        self.assertEqual(result['receipt']['copyCompletion']['method'],'correlatedEvent')
        self.assertEqual(result['rawUploadState']['value'],0)
        pending['future']=types.SimpleNamespace(uploadState=1,dataFile=self.file)
        result=self.ns['_external_future'](pending,1,job['intent']['destination'])
        self.assertEqual(result['status'],'complete')
        self.assertEqual(result['receipt']['copyCompletion']['method'],'future')
        self.assertEqual(result['receipt']['copyCompletion']['eventQualification'],'correlated')
        self.assertEqual(result['receipt']['copyCompletion']['events'][0]['status'],{})

    def test_correlated_event_reresolves_exact_id_not_retained_datafile_wrapper(self):
        job=self.copy_event_job();job['files']={'file':object()}
        looked_up=[]
        self.app.data.findFileById=lambda file_id:(looked_up.append(file_id) or self.file)
        result=self.ns['_external_future']({'future':types.SimpleNamespace(uploadState=0),'futureObserver':job},1,job['intent']['destination'])
        self.assertEqual(result['status'],'complete');self.assertEqual(looked_up,['file'])
        self.file.versionNumber=3
        with self.assertRaisesRegex(ValueError,'identity/version changed'):
            self.ns['_external_future']({'future':types.SimpleNamespace(uploadState=0),'futureObserver':job},1,job['intent']['destination'])

    def test_final_boundary_readback_rejects_nominal_limits_and_expression_drift(self):
        limits={'minimumValue':-.2,'maximumValue':1.2,'restValue':.35,
            'isMinimumValueEnabled':True,'isMaximumValueEnabled':True,'isRestValueEnabled':False}
        motion=types.SimpleNamespace(jointType=1,rotationAxis=0,rotationValue=.35,rotationLimits=types.SimpleNamespace(**limits))
        ends=[object(),object()]
        joint=types.SimpleNamespace(healthState=0,jointMotion=motion,occurrenceOne=ends[0],occurrenceTwo=ends[1],
            attributes=[],isFlipped=True,angle=types.SimpleNamespace(expression='angleParam'),offset=types.SimpleNamespace(expression='offsetParam'))
        row={'new':joint,'kind':1,'form':'Joint','attrs':[],'flipped':True,'angle':'angleParam','offset':'offsetParam',
            'rotationAxis':0,'rotationValue':.35,'limits':limits,'spec':{'endpoints':[{'index':0},{'index':1}]},'endpoints':[{},{}]}
        self.ns['_external_endpoint']=lambda runtime,ctx,s,c,require_geometry:(None,ends[s['index']])
        runtime={'tolerance':{'angular':1e-9}}
        self.ns['_external_boundary_readback'](runtime,object(),row)
        motion.rotationLimits.restValue=0
        with self.assertRaisesRegex(ValueError,'stored limits'):self.ns['_external_boundary_readback'](runtime,object(),row)
        motion.rotationLimits.restValue=.35;motion.rotationValue=0
        with self.assertRaisesRegex(ValueError,'nominal'):self.ns['_external_boundary_readback'](runtime,object(),row)
        motion.rotationValue=.35;joint.angle.expression='20 deg'
        with self.assertRaisesRegex(ValueError,'expression'):self.ns['_external_boundary_readback'](runtime,object(),row)

    def test_shared_parent_retirement_deletes_native_once_and_accounts_for_both_contexts(self):
        alive=[True];calls=[]
        class Native:
            def deleteMe(inner):calls.append('delete');alive[0]=False;return True
        native=Native()
        class Proxy:
            nativeObject=native;isReferencedComponent=False
            @property
            def isValid(inner):return alive[0]
        entry={'spec':{'itemId':'leaf'},'originals':[Proxy(),Proxy()],
            'instanceMap':[{'token':'one','path':'P1+Leaf:1','definition':'leaf'},
                           {'token':'two','path':'P2+Leaf:1','definition':'leaf'}]}
        runtime={'source':object(),'boundaries':[]};data={'manifest':{'mode':'copyAndReplace'}}
        self.ns['_external_activate']=lambda ctx:[]
        self.ns['_external_occurrence_present']=lambda ctx,row:alive[0]
        first=self.ns['_external_retire'](runtime,data,entry,0)
        self.assertEqual(first['receipt']['removedTokens'],['one','two']);self.assertEqual(entry['retiredCount'],2)
        second=self.ns['_external_retire'](runtime,data,entry,1)
        self.assertEqual(second['status'],'complete');self.assertEqual(calls,['delete'])

    def test_nested_native_insert_delta_preserves_the_declared_parent_space_plan(self):
        parent=[0,-1,0,3,1,0,0,0,0,0,1,0,0,0,0,1]
        local=[1,0,0,1,0,1,0,2,0,0,1,0,0,0,0,1]
        multiply=lambda a,b:[sum(a[4*r+k]*b[4*k+c] for k in range(4)) for r in range(4) for c in range(4)]
        inverse=[0,1,0,0,-1,0,0,3,0,0,1,0,0,0,0,1]
        self.ns['_external_destination_parent']=lambda *args:object()
        self.ns['_entity_occurrence_matrix']=lambda *args:parent
        self.ns['_entity_inverse']=lambda m:inverse
        self.ns['_entity_multiply']=multiply
        class Matrix:
            def setWithArray(self,values):self.values=values;return True
            def asArray(self):return self.values
        self.ns['adsk'].core.Matrix3D=types.SimpleNamespace(create=Matrix)
        source=types.SimpleNamespace(asArray=lambda:local)
        result=self.ns['_external_insert_delta'](object(),['Parent:1'],source)
        self.assertEqual(result.asArray(),[1,0,0,-2,0,1,0,1,0,0,1,0,0,0,0,1])
        self.assertEqual(multiply(result.asArray(),parent),multiply(parent,local))
        self.assertIs(self.ns['_external_insert_delta'](object(),[''],source),source)

    def test_copy_final_description_retains_marker_with_read_only_sdk_property(self):
        job=self.copy_event_job();pin={'projectId':'project','fileId':'file','version':2};job['filePin']=pin
        file=self.file
        class ReadOnlyDescription:
            @property
            def description(self):return file.description
            def __getattr__(self,name):return getattr(file,name)
        self.ns['_references_project_file']=lambda *args:ReadOnlyDescription()
        ctx=types.SimpleNamespace(app=self.app);entry={'futureObserver':job,'targetPin':pin}
        effects=self.ns['_external_verify_copy_descriptions'](ctx,entry)
        self.assertEqual(self.file.description,job['intent']['description'])
        self.assertTrue(effects[0]['markerRetained'])
        self.assertEqual(self.ns['_external_verify_copy_descriptions'](ctx,entry),effects)
        requested=[]
        self.ns['_references_project_file']=lambda app,project,file_id,version:(requested.append(version) or ReadOnlyDescription())
        entry['targetPin']={**pin,'version':3}
        self.ns['_external_verify_copy_descriptions'](ctx,entry)
        self.assertEqual(requested,[2])
        job=self.copy_event_job();job['filePin']=pin;self.file.description='unrelated caller edit'
        with self.assertRaisesRegex(ValueError,'outside this operation'):
            self.ns['_external_verify_copy_descriptions'](ctx,{'futureObserver':job,'targetPin':pin})
        self.assertEqual(self.file.description,'unrelated caller edit')

    def test_copy_version_metadata_preflight_error_reconciles_without_replaying_finalize(self):
        ctx=types.SimpleNamespace(doc=self.doc(),app=self.app);calls=[]
        runtime={'requestHash':'h','sessionNonce':'n','source':ctx,'target':None,'sourceFingerprint':'same',
            'items':{'part':{}},'effects':{'step':{'terminal':False,'error':'ValueError: Copy description changed outside this operation'}},
            'processId':42,'compensation':None}
        self.ns['_external_registry']=lambda create:{'op':runtime}
        self.ns['_external_fingerprint']=lambda ctx:'same'
        self.ns['_external_verify_copy_descriptions']=lambda ctx,entry:(calls.append('readCopyVersion') or [])
        data={'operationId':'op','requestHash':'h','sessionNonce':'n','manifest':{'mode':'copyAndReplace'},
            'result':{'pending':{'stepId':'step','phase':'finalize','itemId':'part'},
                'byItem':{'part':{'phaseResults':{'finalize':{'status':'unknown','receipt':{'cursor':0}}}}}}}
        result=self.ns['_external_refresh_internal']('inspect',data)
        self.assertTrue(result['terminal']);self.assertTrue(result['result']['notStarted'])
        self.assertFalse(result['modelMutationSubmitted']);self.assertEqual(calls,['readCopyVersion'])
        runtime['saveAttempted']=True
        self.assertFalse(self.ns['_external_refresh_internal']('inspect',data)['terminal'])
        self.assertEqual(calls,['readCopyVersion'])


if __name__=='__main__':unittest.main()
