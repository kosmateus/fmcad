"""Document interfaces from the pinned Autodesk API; behavior from owned-document tests."""
from __future__ import annotations

from collections.abc import Iterator
import math
from typing import ClassVar, Generic, TypeVar
from uuid import uuid4

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
    pass


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

    def _snapshot(self, file: DataFile) -> None:
        from .fusion import Design
        product = self.products.product
        assert isinstance(product, Design)
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


class Application(Base):
    _instance: ClassVar[Application | None] = None

    def __init__(self) -> None:
        self.version: str = "fmcad-simulator-v5-not-Fusion"
        self.activeDocument: Document | None = None
        self.documents: Documents = Documents(self)
        self.userInterface: UserInterface = UserInterface()
        self.data: Data = Data(self)

    @property
    def activeProduct(self) -> Product | None:
        return self.activeDocument.products.product if self.activeDocument is not None else None

    @staticmethod
    def get() -> Application:
        if Application._instance is None:
            Application._instance = Application()
        return Application._instance
