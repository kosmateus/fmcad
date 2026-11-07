"""Geometry feature: domain; retained cad-v1 shared namespace."""


_FEATURE_EDITABLE_NATIVE = {
    'ExtrudeFeature': ['profile', 'startExtent', 'extentOne', 'extentTwo', 'operation', 'participantBodies'],
    'RevolveFeature': ['profile', 'axis', 'signed/partial/full angle extent', 'two-side angle extent', 'one-side to-entity extent', 'operation', 'participantBodies'],
    'FilletFeature': ['edge-set edges/continuity/weight', 'constant/chord/variable/asymmetric parameters', 'variable mid-radius points', 'full-round face sets', 'rolling-ball corner'],
    'ChamferFeature': ['edge-set edges', 'edge-set tangent chain', 'edge-set variant parameters', 'cornerType'],
    'HoleFeature': ['diameter/depth model parameters', 'distance/through-all/to-entity extent', 'simple/counterbore/countersink type', 'position references', 'participantBodies'],
    'CircularPatternFeature': ['inputEntities', 'axis', 'isSymmetric', 'suppressedElementsIds'],
    'RectangularPatternFeature': ['inputEntities', 'directionOneEntity', 'directionTwoEntity', 'symmetric directions', 'patternDistanceType', 'suppressedElementsIds'],
    'PathPatternFeature': ['inputEntities', 'path', 'startPoint', 'isFlipDirection', 'patternDistanceType', 'isSymmetric', 'suppressedElementsIds'],
    'MirrorFeature': ['inputEntities', 'mirrorPlane', 'patternComputeOption'],
    'ShellFeature': ['inputEntities', 'inside/outside thickness', 'tangent-chain selection', 'shellType'],
    'SweepFeature': ['profile', 'path', 'orientation', 'guideRail', 'guide surfaces', 'direction flip', 'operation', 'participantBodies'],
    'LoftFeature': ['loft section entities/order', 'rail/centerline entities', 'section end conditions', 'closed/tangent merge', 'start/end edge alignment', 'operation', 'participantBodies'],
    'ThickenFeature': ['inputFaces', 'thickness model parameter (signed expression controls direction)', 'isSymmetric', 'operation', 'thickenType', 'tangent-chain selection'],
}


_FEATURE_UNSUPPORTED_NATIVE = {
    'ExtrudeFeature': ['thin-extrude conversion and unsupported feature-type conversion are refused'],
    'RevolveFeature': ['direction is controlled by signed angle; a separate direction property is unsupported', 'two-side to-entity extent is not offered because the installed SDK definitions expose no stable extent readback type'],
    'FilletFeature': ['feature operation change and convert-to/from-fillet-variant are unsupported; full-round face sets can only be edited on an existing full-round feature'],
    'ChamferFeature': ['feature operation/type conversion is unsupported; edit only the existing edge-set variants'],
    'HoleFeature': ['feature operation change, clearance/tapped-hole variants and transient Point3D positions are unsupported; use native sketch/edge references'],
    'CircularPatternFeature': ['FeatureOperations conversion is not exposed; pattern feature-type conversion is unsupported'],
    'RectangularPatternFeature': ['FeatureOperations conversion is not exposed; pattern feature-type conversion is unsupported'],
    'PathPatternFeature': ['FeatureOperations conversion is not exposed; pattern feature-type conversion is unsupported'],
    'MirrorFeature': ['FeatureOperations conversion is not exposed; mirror feature-type conversion is unsupported'],
    'ShellFeature': ['FeatureOperations conversion is not exposed; shell feature-type conversion is unsupported'],
    'SweepFeature': ['profileScaling and solidBody/solid-axis conversion are unsupported; setting solidBody clears existing profile/path references'],
    'LoftFeature': ['changing section or rail count is refused; same-count edits preserve feature lineage'],
    'ThickenFeature': ['the installed in-place API exposes no separate direction setter; one-sided direction follows selected face normals'],
}


_FEATURE_OPERATION_CHANGE_TYPES = ('ExtrudeFeature', 'RevolveFeature', 'SweepFeature', 'LoftFeature', 'ThickenFeature')


def _feature_edit_capabilities(kind: str, parameters: list[dict[str, str]]) -> "JsonObject":
    supported = list(_FEATURE_EDITABLE_NATIVE.get(kind, []))
    if parameters:
        supported.append('entries: exact owned ModelParameter expressions (listed in parameters)')
    unsupported = list(_FEATURE_UNSUPPORTED_NATIVE.get(kind, []))
    if kind not in _FEATURE_NATIVE_FIELDS:
        unsupported.append('type-specific nativeEdits are unsupported for ' + kind)
    return {'supported': supported,
            'modelParameters': [{'name': row['name'], 'role': row['role'], 'unit': row['unit']} for row in parameters],
            'unsupported': unsupported}


_FEATURE_NATIVE_FIELDS = {
    'ExtrudeFeature': ('profile',),
    'RevolveFeature': ('profile', 'axis'),
    'FilletFeature': ('edgeSets', 'fullRoundFaceSets', 'isRollingBallCorner'),
    'ChamferFeature': ('edgeSets', 'cornerType'),
    'HoleFeature': ('holeType', 'position', 'participants'),
    'CircularPatternFeature': ('entities', 'axis', 'isSymmetric', 'suppressedElementsIds', 'patternComputeOption'),
    'RectangularPatternFeature': ('entities', 'directionOneEntity', 'directionTwoEntity', 'isSymmetricInDirectionOne', 'isSymmetricInDirectionTwo', 'patternDistanceType', 'suppressedElementsIds'),
    'PathPatternFeature': ('entities', 'path', 'startPoint', 'isFlipDirection', 'patternDistanceType', 'isSymmetric', 'suppressedElementsIds'),
    'MirrorFeature': ('entities', 'mirrorPlane', 'patternComputeOption'),
    'ShellFeature': ('entities', 'insideThickness', 'outsideThickness', 'isTangentChain', 'shellType'),
    'SweepFeature': ('profile', 'path', 'orientation', 'guideRail', 'isDirectionFlipped', 'guideSurfaces', 'isChainSelection', 'participants'),
    'LoftFeature': ('sections', 'rails', 'centerLine', 'sectionConditions', 'isClosed', 'isTangentEdgesMerged', 'startLoftEdgeAlignment', 'endLoftEdgeAlignment', 'participants'),
    'ThickenFeature': ('entities', 'isSymmetric', 'thickenType', 'isChainSelection'),
}
