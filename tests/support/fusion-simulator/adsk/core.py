"""Document interfaces from the pinned Autodesk API; behavior from owned-document tests."""
from __future__ import annotations

from collections.abc import Iterator
import math
from copy import deepcopy
from typing import TYPE_CHECKING, ClassVar, Generic, TypeVar
from uuid import uuid4
from ._expressions import Quantity, evaluate

if TYPE_CHECKING:
    from .fusion import Design

T = TypeVar("T")


class Collection(Generic[T]):
    def __init__(self, values: list[T] | None = None) -> None:
        self.values: list[T] = values if values is not None else []

    @property
    def count(self) -> int:
        return len(self.values)

    def item(self, index: int) -> T:
        return self.values[index]

    def asArray(self) -> list[T]:
        return list(self.values)

    def __iter__(self) -> Iterator[T]:
        return iter(self.values)


class Base:
    pass


class Property(Base):
    """No physical/visual property values are modeled by the metadata fixture."""


class Properties(Collection[Property]):
    def itemById(self, id: str) -> Property | None:
        return None

    def itemByName(self, name: str) -> Property | None:
        return None


class Material(Base):
    def __init__(self, owner: Materials, name: str, description: str = "") -> None:
        self.model_owner: Materials = owner
        self.model_id: str = "model-material:" + str(uuid4())
        self.model_name: str = name
        self.model_description: str = description
        self.model_properties: Properties = Properties()

    def model_valid(self) -> None:
        doc = self.model_owner.model_document
        if doc is not None and not doc.isValid:
            raise ValueError("Material belongs to a closed document")

    def model_write(self) -> None:
        self.model_valid()
        doc = self.model_owner.model_document
        if doc is None:
            raise ValueError("Modeled library materials are read-only")
        doc.isModified = True

    @property
    def id(self) -> str:
        self.model_valid()
        return self.model_id

    @property
    def name(self) -> str:
        self.model_valid()
        return self.model_name

    @name.setter
    def name(self, value: str) -> None:
        if not value.strip():
            raise ValueError("Material name must be nonempty")
        if any(item is not self and item.name == value for item in self.model_owner):
            raise ValueError("Material name already exists")
        self.model_write()
        self.model_name = value

    @property
    def description(self) -> str:
        self.model_valid()
        return self.model_description

    @description.setter
    def description(self, value: str) -> None:
        self.model_write()
        self.model_description = value

    @property
    def materialProperties(self) -> Properties:
        self.model_valid()
        return self.model_properties

    @property
    def parent(self) -> Base:
        return self.model_owner.model_parent


class Materials(Collection[Material]):
    def __init__(self, parent: Base, document: Document | None) -> None:
        super().__init__()
        self.model_parent: Base = parent
        self.model_document: Document | None = document

    def itemById(self, id: str) -> Material | None:
        return next((item for item in self.values if item.id == id), None)

    def itemByName(self, name: str) -> Material | None:
        return next((item for item in self.values if item.name == name), None)

    def addByCopy(self, materialToCopy: Material, name: str) -> Material:
        if self.model_document is None or not self.model_document.isValid:
            raise ValueError("Material copies require an open target document")
        if not name.strip() or self.itemByName(name) is not None:
            raise ValueError("Material copy name is empty or already exists")
        materialToCopy.model_valid()
        material = Material(self, name, materialToCopy.description)
        material.model_properties = deepcopy(materialToCopy.materialProperties)
        self.values.append(material)
        self.model_document.isModified = True
        return material


class MaterialLibrary(Base):
    def __init__(self) -> None:
        self.model_materials: Materials = Materials(self, None)
        self.model_materials.values.append(Material(self.model_materials, "Model metadata material", "No physical properties or native library identity implied"))

    @property
    def id(self) -> str:
        return "model-library:metadata"

    @property
    def name(self) -> str:
        return "Model metadata library"

    @property
    def materials(self) -> Materials:
        return self.model_materials


class MaterialLibraries(Collection[MaterialLibrary]):
    def __init__(self) -> None:
        super().__init__([MaterialLibrary()])

    def itemById(self, id: str) -> MaterialLibrary | None:
        return next((item for item in self.values if item.id == id), None)

    def itemByName(self, name: str) -> MaterialLibrary | None:
        return next((item for item in self.values if item.name == name), None)


class Attribute(Base):
    def __init__(self, collection: Attributes, group: str, name: str, value: str) -> None:
        self.model_collection: Attributes = collection
        self.groupName: str = group
        self.name: str = name
        self.model_value: str = value

    @property
    def value(self) -> str:
        return self.model_value

    @value.setter
    def value(self, value: str) -> None:
        self.model_collection.model_validate_value(value)
        self.model_value = value
        self.model_collection.model_document.isModified = True


class Attributes(Collection[Attribute]):
    def __init__(self, document: Document) -> None:
        super().__init__()
        self.model_document: Document = document

    @staticmethod
    def model_validate_value(value: str) -> None:
        if len(value.encode("utf-8")) > 2097152:
            raise ValueError("Attribute exceeds the modeled UTF-8 byte limit")

    def itemByName(self, groupName: str, name: str) -> Attribute | None:
        return next((a for a in self.values if (a.groupName, a.name) == (groupName, name)), None)

    def add(self, groupName: str, name: str, value: str) -> Attribute:
        if not groupName.strip() or not name.strip():
            raise ValueError("An attribute needs a nonempty group and name")
        self.model_validate_value(value)
        previous = self.itemByName(groupName, name)
        if previous is not None:
            previous.value = value
            return previous
        attribute = Attribute(self, groupName, name, value)
        self.values.append(attribute)
        self.model_document.isModified = True
        return attribute

    def itemsByGroup(self, groupName: str) -> list[Attribute]:
        if not groupName.strip():
            raise ValueError("Empty attribute group")
        return [a for a in self.values if a.groupName == groupName]


class Point3D(Base):
    def __init__(self, x: float, y: float, z: float) -> None:
        if not all(math.isfinite(v) for v in (x, y, z)):
            raise ValueError("Non-finite point")
        self.x: float = x
        self.y: float = y
        self.z: float = z

    @staticmethod
    def create(x: float = 0.0, y: float = 0.0, z: float = 0.0) -> Point3D:
        return Point3D(x, y, z)

    def asArray(self) -> list[float]:
        return [self.x, self.y, self.z]

    def copy(self) -> Point3D:
        return Point3D(self.x, self.y, self.z)


class BoundingBox3D(Base):
    def __init__(self, minPoint: Point3D, maxPoint: Point3D) -> None:
        if any(a > b for a, b in zip(minPoint.asArray(), maxPoint.asArray())):
            raise ValueError("Inverted bounding box")
        self.minPoint: Point3D = minPoint
        self.maxPoint: Point3D = maxPoint

    @staticmethod
    def create(minPoint: Point3D, maxPoint: Point3D) -> BoundingBox3D:
        return BoundingBox3D(minPoint, maxPoint)


class Vector3D(Base):
    def __init__(self, x: float, y: float, z: float) -> None:
        if not all(math.isfinite(v) for v in (x, y, z)):
            raise ValueError("Non-finite vector")
        self.x: float = x
        self.y: float = y
        self.z: float = z

    @staticmethod
    def create(x: float = 0.0, y: float = 0.0, z: float = 0.0) -> Vector3D:
        return Vector3D(x, y, z)

    def asArray(self) -> list[float]:
        return [self.x, self.y, self.z]


class Plane(Base):
    def __init__(self, origin: Point3D, normal: Vector3D) -> None:
        magnitude = math.sqrt(sum(v * v for v in normal.asArray()))
        if magnitude == 0:
            raise ValueError("Zero plane normal")
        self.origin: Point3D = Point3D(origin.x, origin.y, origin.z)
        self.normal: Vector3D = Vector3D(normal.x / magnitude, normal.y / magnitude, normal.z / magnitude)

    @staticmethod
    def create(origin: Point3D, normal: Vector3D) -> Plane:
        return Plane(origin, normal)


class Matrix3D(Base):
    @staticmethod
    def create() -> Matrix3D:
        return Matrix3D()

    def asArray(self) -> list[float]:
        # Only the identity placement used by comp_add is implemented.
        return [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]


class UnitsManager(Base):
    def model_resolve(self, name: str) -> Quantity:
        raise ValueError("Unknown parameter: " + name)

    def evaluateExpression(self, expression: str, units: str = 'DefaultDistance') -> float:
        return evaluate(expression, "" if units == "cm/cm" else units, self.model_resolve).value

    def isValidExpression(self, expression: str, units: str) -> bool:
        try:
            _ = self.evaluateExpression(expression, units)
            return True
        except (ValueError, SyntaxError, ZeroDivisionError, NotImplementedError):
            return False


class NamedValues(Base):
    pass


class DocumentTypes:
    FusionDesignDocumentType: ClassVar[int] = 0


class Product(Base):
    pass


class ValueInput(Base):
    def __init__(self, value: str | float) -> None:
        self.value: str | float = value

    @staticmethod
    def createByString(stringValue: str) -> ValueInput:
        if not stringValue.strip():
            raise ValueError("Empty expression")
        return ValueInput(stringValue)

    @staticmethod
    def createByReal(realValue: float) -> ValueInput:
        return ValueInput(realValue)


class UserInterface:
    activeCommand: str = "SelectCommand"


class Products:
    def __init__(self, product: Product) -> None:
        self.product: Product = product

    def itemByProductType(self, productType: str) -> Product:
        if productType != "DesignProductType":
            raise NotImplementedError("Only DesignProductType is modeled")
        return self.product


class DataFile(Base):
    """A versioned test state. Cloud progress advances between SDK requests."""
    def __init__(self, folder: DataFolder, name: str, id: str | None = None, version: int = 1) -> None:
        self.parentFolder: DataFolder = folder
        self.parentProject: DataProject = folder.parentProject
        self.id: str = id or "sim-file:" + str(uuid4())
        self.name: str = name
        self.versionNumber: int = version
        self.fileExtension: str = "f3d"
        self.isReadOnly: bool = False
        self.isComplete: bool = False
        self.model_pending: int = folder.parentProject.data.save_delay_steps
        self.model_delete_remaining: int | None = None
        self.model_parameters: list[tuple[str, str, float, str, str]] = []
        self.model_design: Design | None = None

    @property
    def latestVersion(self) -> DataFile:
        file = self.parentFolder.dataFiles.itemById(self.id)
        if file is None:
            raise RuntimeError("File is deleted")
        return file

    @property
    def latestVersionNumber(self) -> int:
        return self.latestVersion.versionNumber

    def deleteMe(self) -> bool:
        data = self.parentProject.data
        if self.isReadOnly or not self.isComplete:
            return False
        if any(d.dataFile is not None and d.dataFile.id == self.id for d in data.app.documents):
            return False
        if self.model_delete_remaining is not None:
            raise RuntimeError("Deletion already accepted; observe the original operation")
        if self not in self.parentFolder.dataFiles.values:
            return False
        self.model_delete_remaining = data.delete_delay_steps
        data.delete_calls += 1
        return True


class DataFiles(Collection[DataFile]):
    def itemById(self, id: str) -> DataFile | None:
        return next((file for file in self if file.id == id), None)


class DataFolder(Base):
    def __init__(self, project: DataProject, name: str, id: str | None = None, parent: DataFolder | None = None) -> None:
        self.id: str = id or "sim-folder:" + str(uuid4())
        self.name: str = name
        self.parentProject: DataProject = project
        self.dataFiles: DataFiles = DataFiles()
        self.parentFolder: DataFolder | None = parent
        self.dataFolders: DataFolders = DataFolders(project, self)


class DataFolders(Collection[DataFolder]):
    def __init__(self, project: DataProject, parent: DataFolder | None = None) -> None:
        super().__init__()
        self.parent: DataFolder | None = parent
        self.project: DataProject = project

    def itemById(self, id: str) -> DataFolder | None:
        return next((folder for folder in self if folder.id == id), None)

    def itemByName(self, name: str) -> DataFolder | None:
        return next((folder for folder in self if folder.name == name), None)

    def add(self, name: str) -> DataFolder:
        if not name or any(folder.name == name for folder in self):
            raise ValueError("Invalid or duplicate folder name")
        folder = DataFolder(self.project, name, parent=self.parent)
        self.values.append(folder)
        return folder


class DataProject(Base):
    def __init__(self, data: Data) -> None:
        self.data: Data = data
        self.id: str = "sim-project:fixtures"
        self.name: str = "Scenario fixtures"
        self.rootFolder: DataFolder = DataFolder(self, "Scenario fixtures", "sim-folder:fixtures")


class DataProjects(Collection[DataProject]):
    def itemById(self, id: str) -> DataProject | None:
        return next((project for project in self if project.id == id), None)


class Data(Base):
    def __init__(self, app: Application) -> None:
        self.app: Application = app
        self.save_delay_steps: int = 2
        self.delete_delay_steps: int = 2
        self.save_calls: int = 0
        self.delete_calls: int = 0
        self.dataProjects: DataProjects = DataProjects([DataProject(self)])

    def _folders(self) -> Iterator[DataFolder]:
        pending = [project.rootFolder for project in self.dataProjects]
        while pending:
            folder = pending.pop()
            yield folder
            pending.extend(folder.dataFolders)

    def findFileById(self, id: str) -> DataFile | None:
        return next((file for folder in self._folders() for file in folder.dataFiles if file.id == id), None)

    def advance_model(self) -> None:
        for folder in self._folders():
            for file in list(folder.dataFiles):
                if file.model_pending > 0:
                    file.model_pending -= 1
                file.isComplete = file.model_pending == 0
                if file.model_delete_remaining is not None:
                    file.model_delete_remaining -= 1
                    if file.model_delete_remaining <= 0:
                        folder.dataFiles.values.remove(file)


class Document(Base):
    def __init__(self, app: Application) -> None:
        from .fusion import Design
        self.app: Application = app
        self.creationId: str = str(uuid4())
        self.name: str = "Untitled"
        self.isSaved: bool = False
        self.isModified: bool = False
        self.isValid: bool = True
        self.dataFile: DataFile | None = None
        self.allDocumentReferences: Collection[object] = Collection()
        self.documentReferences: Collection[object] = Collection()
        self.products: Products = Products(Design(self))
        self.model_viewport: Viewport = Viewport(self)

    def _snapshot(self, file: DataFile) -> None:
        from .fusion import Design
        product = self.products.product
        assert isinstance(product, Design)
        # Copy the bounded model graph, but never the live application/documents.
        # The document reference is rebound when opening the immutable snapshot.
        file.model_design = deepcopy(product, {id(self): self})
        file.model_parameters = [(p.name, p.expression, p.value, p.unit, p.comment) for p in product.userParameters]
        self.dataFile = file
        self.isSaved = True
        self.isModified = False
        self.app.data.save_calls += 1

    def saveAs(self, name: str, dataFolder: DataFolder, description: str, tag: str) -> bool:
        if not self.isValid or dataFolder.parentProject.data is not self.app.data:
            raise RuntimeError("Unavailable document or foreign data folder")
        if self.isSaved:
            raise NotImplementedError("SaveAs of an existing file is outside the fixture model")
        self.name = name or self.name
        file = DataFile(dataFolder, self.name)
        dataFolder.dataFiles.values.append(file)
        self._snapshot(file)
        return True

    def save(self, description: str) -> bool:
        if not self.isValid or self.dataFile is None:
            raise RuntimeError("SaveAs is required before save")
        if self.dataFile.isReadOnly or not self.dataFile.isComplete:
            return False
        if not self.isModified:
            return True
        old = self.dataFile
        file = DataFile(old.parentFolder, self.name, old.id, old.versionNumber + 1)
        old.parentFolder.dataFiles.values.remove(old)
        old.parentFolder.dataFiles.values.append(file)
        self._snapshot(file)
        return True

    def activate(self) -> bool:
        if not self.isValid:
            raise RuntimeError("Document is closed")
        self.app.activeDocument = self
        return True

    def close(self, saveChanges: bool) -> bool:
        if saveChanges and self.isModified:
            raise NotImplementedError("Interactive save prompts are not modeled")
        if not self.isValid:
            raise RuntimeError("Document is already closed")
        self.app.documents.values.remove(self)
        self.isValid = False
        if self.app.activeDocument is self:
            self.app.activeDocument = next(iter(self.app.documents), None)
        return True


class Documents(Collection[Document]):
    def __init__(self, app: Application) -> None:
        super().__init__()
        self.app: Application = app

    def add(self, documentType: DocumentTypes | int, visible: bool = True,
            options: NamedValues | None = None) -> Document:
        if documentType != DocumentTypes.FusionDesignDocumentType or options is not None:
            raise NotImplementedError("Only a new default design is modeled")
        doc = Document(self.app)
        self.values.append(doc)
        if visible:
            self.app.activeDocument = doc
        return doc


    def open(self, dataFile: DataFile, visible: bool = True) -> Document:
        if dataFile.parentProject.data is not self.app.data:
            raise ValueError("Foreign data file")
        if dataFile.parentFolder.dataFiles.itemById(dataFile.id) is not dataFile:
            raise ValueError("Deleted or superseded file version")
        if not dataFile.isComplete or dataFile.model_delete_remaining is not None:
            raise ValueError("File is incomplete or being deleted")
        existing = next((doc for doc in self if doc.dataFile is dataFile), None)
        if existing is not None:
            if visible:
                existing.activate()
            return existing
        snapshot = dataFile.model_design
        if snapshot is None:
            raise NotImplementedError("File has no modeled design snapshot")
        doc = Document(self.app)
        doc.products = Products(deepcopy(snapshot, {id(snapshot.model_doc): doc}))
        doc.name = dataFile.name
        doc.dataFile = dataFile
        doc.isSaved = True
        self.values.append(doc)
        if visible:
            self.app.activeDocument = doc
        return doc


class CameraTypes:
    OrthographicCameraType = 0
    PerspectiveCameraType = 1
    PerspectiveWithOrthoFacesCameraType = 2


class Camera(Base):
    """Detached camera state only; no renderer, fitting or ViewCube solver."""
    def __init__(self) -> None:
        self.model_eye = Point3D(10., 10., 10.)
        self.model_target = Point3D(0., 0., 0.)
        self.model_upVector = Vector3D(0., 0., 1.)
        self.model_cameraType: int = CameraTypes.OrthographicCameraType
        self.model_perspectiveAngle: float = math.pi / 4
        self.model_extents: tuple[float, float] = (10., 10.)
        self.model_isFitView: bool = False
        self.model_isSmoothTransition: bool = False

    @staticmethod
    def create() -> Camera:
        return Camera()

    def getExtents(self) -> tuple[bool, float, float]:
        if self.cameraType != CameraTypes.OrthographicCameraType:
            return (False, 0., 0.)
        return (True, *self.model_extents)

    def setExtents(self, width: float, height: float) -> bool:
        if self.cameraType != CameraTypes.OrthographicCameraType:
            return False
        if not all(math.isfinite(v) and v > 0 for v in (width, height)):
            return False
        self.model_extents = (width, height)
        return True

    @property
    def eye(self) -> Point3D:
        return deepcopy(self.model_eye)

    @eye.setter
    def eye(self, value: Point3D) -> None:
        self.model_eye = deepcopy(value)

    @property
    def target(self) -> Point3D:
        return deepcopy(self.model_target)

    @target.setter
    def target(self, value: Point3D) -> None:
        self.model_target = deepcopy(value)

    @property
    def upVector(self) -> Vector3D:
        return deepcopy(self.model_upVector)

    @upVector.setter
    def upVector(self, value: Vector3D) -> None:
        self.model_upVector = deepcopy(value)

    @property
    def cameraType(self) -> int:
        return self.model_cameraType

    @cameraType.setter
    def cameraType(self, value: int) -> None:
        if value not in (0, 1, 2):
            raise ValueError("Unknown camera projection")
        self.model_cameraType = value

    @property
    def perspectiveAngle(self) -> float:
        if self.cameraType == CameraTypes.OrthographicCameraType:
            raise ValueError("Perspective angle requires perspective projection")
        return self.model_perspectiveAngle

    @perspectiveAngle.setter
    def perspectiveAngle(self, value: float) -> None:
        if self.cameraType == CameraTypes.OrthographicCameraType or not 0 < value < math.pi:
            raise ValueError("Invalid perspective angle or projection")
        self.model_perspectiveAngle = value

    @property
    def isFitView(self) -> bool:
        return self.model_isFitView

    @isFitView.setter
    def isFitView(self, value: bool) -> None:
        self.model_isFitView = value

    @property
    def isSmoothTransition(self) -> bool:
        return self.model_isSmoothTransition

    @isSmoothTransition.setter
    def isSmoothTransition(self, value: bool) -> None:
        self.model_isSmoothTransition = value

    @property
    def viewOrientation(self) -> int:
        raise NotImplementedError("ViewCube orientation is not modeled")

    @viewOrientation.setter
    def viewOrientation(self, value: int) -> None:
        raise NotImplementedError("ViewCube orientation is not modeled")


class Viewport(Base):
    def __init__(self, document: Document) -> None:
        self.model_document: Document = document
        self.model_camera: Camera = Camera.create()

    @property
    def parentDocument(self) -> Document:
        return self.model_document

    @property
    def camera(self) -> Camera:
        self.model_validate()
        return deepcopy(self.model_camera)

    @camera.setter
    def camera(self, value: Camera) -> None:
        self.model_validate()
        if value.isFitView or value.isSmoothTransition:
            raise NotImplementedError("Fit and animated camera transitions require native Fusion")
        if value.cameraType == CameraTypes.OrthographicCameraType:
            _, width, height = value.getExtents()
            if width != height:
                raise NotImplementedError("Only square viewport extents are modeled")
        self.model_camera = deepcopy(value)

    def model_validate(self) -> None:
        if not self.model_document.isValid:
            raise ValueError("Viewport document is closed")


class Application(Base):
    _instance: ClassVar[Application | None] = None

    def __init__(self) -> None:
        self.version: str = "fmcad-simulator-v15-not-Fusion"
        self.activeDocument: Document | None = None
        self.documents: Documents = Documents(self)
        self.userInterface: UserInterface = UserInterface()
        self.data: Data = Data(self)
        self.model_material_libraries: MaterialLibraries = MaterialLibraries()

    @property
    def materialLibraries(self) -> MaterialLibraries:
        return self.model_material_libraries

    @property
    def activeViewport(self) -> Viewport:
        if self.activeDocument is None:
            raise ValueError("No active viewport")
        return self.activeDocument.model_viewport

    @property
    def activeProduct(self) -> Product | None:
        return self.activeDocument.products.product if self.activeDocument is not None else None

    @staticmethod
    def get() -> Application:
        if Application._instance is None:
            Application._instance = Application()
        return Application._instance
