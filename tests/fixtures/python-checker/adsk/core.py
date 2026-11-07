from __future__ import annotations

class Point3D:
    @staticmethod
    def create(x: float = 0.0, y: float = 0.0, z: float = 0.0) -> Point3D | None:
        ...
    @property
    def x(self) -> float:
        ...

class UserInterface:
    def messageBox(self, text: str) -> int:
        ...

class Application:
    @staticmethod
    def get() -> Application:
        ...
    @property
    def userInterface(self) -> UserInterface:
        ...
