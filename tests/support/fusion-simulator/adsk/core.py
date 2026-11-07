"""Document interfaces from the pinned Autodesk API; behavior from owned-document tests."""
from __future__ import annotations

from collections.abc import Iterator
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

    def __iter__(self) -> Iterator[T]:
        return iter(self.values)


class Base:
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


class Document(Base):
    def __init__(self, app: Application) -> None:
        from .fusion import Design
        self.app: Application = app
        self.creationId: str = str(uuid4())
        self.name: str = "Untitled"
        self.isSaved: bool = False
        self.isModified: bool = False
        self.isValid: bool = True
        self.dataFile: None = None
        self.allDocumentReferences: Collection[object] = Collection()
        self.documentReferences: Collection[object] = Collection()
        self.products: Products = Products(Design(self))

    def activate(self) -> bool:
        if not self.isValid:
            raise RuntimeError("Document is closed")
        self.app.activeDocument = self
        return True

    def close(self, saveChanges: bool) -> bool:
        if saveChanges:
            raise NotImplementedError("Cloud save is not modeled")
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
        self.version: str = "fmcad-simulator-v1-not-Fusion"
        self.activeDocument: Document | None = None
        self.documents: Documents = Documents(self)
        self.userInterface: UserInterface = UserInterface()

    @staticmethod
    def get() -> Application:
        if Application._instance is None:
            Application._instance = Application()
        return Application._instance
