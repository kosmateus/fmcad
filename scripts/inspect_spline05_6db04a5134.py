import adsk.core
import adsk.fusion
import collections
import json


def run(context):
    app = adsk.core.Application.get()
    doc = app.activeDocument
    expected = 'Spline_05-20260909T141434-6db04a5134'
    if not doc or not doc.name.startswith(expected):
        raise RuntimeError('Unexpected active document: ' + (doc.name if doc else 'none'))
    design = adsk.fusion.Design.cast(app.activeProduct)
    sketches, bodies, health = [], [], []
    for comp in design.allComponents:
        for sketch in comp.sketches:
            counts = collections.Counter(c.objectType for c in sketch.sketchCurves)
            sketches.append(dict(component=comp.name, name=sketch.name, curves=sketch.sketchCurves.count,
                                 types=dict(counts), profiles=sketch.profiles.count))
        for body in comp.bRepBodies:
            box = body.boundingBox
            bodies.append(dict(component=comp.name, name=body.name, solid=body.isSolid,
                               volumeMm3=body.volume * 1000,
                               minMm=[box.minPoint.x*10, box.minPoint.y*10, box.minPoint.z*10],
                               maxMm=[box.maxPoint.x*10, box.maxPoint.y*10, box.maxPoint.z*10]))
    for i in range(design.timeline.count):
        obj = design.timeline.item(i).entity
        if obj and hasattr(obj, 'healthState') and int(obj.healthState) != 0:
            health.append(dict(index=i, name=obj.name, state=int(obj.healthState), message=obj.errorOrWarningMessage))
    data = doc.dataFile
    result = dict(document=doc.name, modified=doc.isModified, fileId=data.id, complete=data.isComplete,
                  sketches=sketches, curveCount=sum(s['curves'] for s in sketches), bodies=bodies,
                  timelineCount=design.timeline.count, unhealthy=health)
    folder = 'C:/Users/kamil/OneDrive/Dokumenty/CadProjects/Brelok/Breloki do testowania/Spline_05-6db04a5134/'
    result['viewportSaved'] = app.activeViewport.saveAsImageFile(folder + 'native-viewport.png', 1600, 1000)
    with open(folder + 'native-inspection.json', 'x', encoding='utf-8') as stream:
        json.dump(result, stream, indent=2)
    print(json.dumps(result))
