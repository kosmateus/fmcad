import adsk.core

p = adsk.core.Point3D.create("bad", 0, 0)
print(p.x)
if p is not None:
    p.nonexistent()
