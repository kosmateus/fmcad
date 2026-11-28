"""Metadata-only discovery; no preview objects are instantiated or invoked.

Reviewed installed September 2026 SDK sim.py: Simulations, SimulationModel,
SimulationModels, Studies and Study are preview, not for distributed programs.
"""
import importlib


def _simulation_capabilities(ctx, data):
    _cad_fields(data)
    module, error = None, None
    try:
        module = importlib.import_module('adsk.sim')
    except Exception as exc:
        error = type(exc).__name__ + ': ' + str(exc)
    classes = []
    for name in ('Simulations', 'SimulationModel', 'SimulationModels', 'Studies', 'Study'):
        cls = getattr(module, name, None) if module is not None else None
        doc = getattr(cls, '__doc__', '') or ''
        runtime_preview = 'preview' in doc.lower()
        classes.append({'name': name, 'available': cls is not None, 'preview': True,
                        'runtimeDocMarksPreview': runtime_preview,
                        'statusSource': 'runtime documentation' if runtime_preview else 'known SDK specification (September 2026)',
                        'supported': False})
    return {'profile': 'stable-distributed', 'module': 'adsk.sim',
            'moduleAvailable': module is not None, 'importError': error, 'classes': classes,
            'stableFEASolve': {'available': False, 'status': 'unavailable in supported profile'},
            'entitlement': 'notChecked', 'productAccessed': False,
            'limitations': ['Module presence is not solve support or entitlement evidence.',
                            'All known Simulation/Study APIs are preview and not for distributed programs.',
                            'No study creation, editing, meshing, solving, results access or workspace activation.',
                            'Simulations.get is deliberately not called: it can create a product.',
                            'Joint sampling is kinematic evidence, not FEA or dynamics.'],
            'nativeExamples': [{'operation': 'simulation.capabilities', 'data': {}},
                               {'operation': 'motion.sample', 'data': {'confirm': True, 'frameCount': 3,
                                'tracks': [{'joint': {'token': 'joint-token'},
                                            'rotation': {'from': '0 deg', 'to': '90 deg'}}]}}]}


CAD_HANDLERS['simulation.capabilities'] = _simulation_capabilities
