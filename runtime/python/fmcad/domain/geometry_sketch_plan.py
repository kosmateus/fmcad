"""Geometry sketch_plan: domain; retained cad-v1 shared namespace."""


_SKETCH_RECOGNITION = {
    'SketchRadialDimension': ('radius', ('entity',)),
    'SketchDiameterDimension': ('radius', ('entity',)),
    'SketchEllipseMajorRadiusDimension': ('majorRadius', ('ellipse',)),
    'SketchEllipseMinorRadiusDimension': ('minorRadius', ('ellipse',)),
    'SketchLinearDimension': ('distance', ('entityOne', 'entityTwo')),
    'SketchAngularDimension': ('angle', ('lineOne', 'lineTwo')),
    'HorizontalConstraint': ('horizontal', ('line',)),
    'VerticalConstraint': ('vertical', ('line',)),
    'HorizontalPointsConstraint': ('horizontalPoints', ('pointOne', 'pointTwo')),
    'VerticalPointsConstraint': ('verticalPoints', ('pointOne', 'pointTwo')),
    'CoincidentConstraint': ('coincident', ('point', 'entity')),
    'ParallelConstraint': ('parallel', ('lineOne', 'lineTwo')),
    'PerpendicularConstraint': ('perpendicular', ('line', 'curve')),
    'ConcentricConstraint': ('concentric', ('entityOne', 'entityTwo')),
    'EqualConstraint': ('equal', ('curveOne', 'curveTwo')),
}
