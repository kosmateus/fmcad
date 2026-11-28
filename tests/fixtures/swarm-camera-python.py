"""Run generated caller or swarm wrapper bytes against the local SDK double."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core_test import CoreTests

fixture = CoreTests()
fixture.setUp()
sdk = fixture.core.adsk
sdk.core.DataFile = type(fixture.doc.dataFile)
sdk.core.CameraTypes = SimpleNamespace(OrthographicCameraType=1)
point = SimpleNamespace(x=1.0, y=2.0, z=3.0)
camera = SimpleNamespace(cameraType=1, eye=point, target=point, upVector=point,
                         getExtents=lambda: (True, 20.0, 10.0))
fixture.app.activeViewport = SimpleNamespace(parentDocument=fixture.doc, camera=camera)
fixture.child.entityToken = 'fixture-component-token'
fixture.register(fixture.child)
fixture.root.attributes.add('fmcad.aliases', 'alias', json.dumps(fixture.ctx.ref(fixture.child)))
with patch.dict(sys.modules, {'adsk': sdk, 'adsk.core': sdk.core, 'adsk.fusion': sdk.fusion}):
    exec(compile(sys.stdin.read(), '<offline-swarm-camera>', 'exec'), {})
