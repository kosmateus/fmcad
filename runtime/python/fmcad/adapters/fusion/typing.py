"""Fusion SDK protocols used only by static checkers."""
from typing import TYPE_CHECKING as _TYPE_CHECKING, Protocol as _FusionProtocol


if _TYPE_CHECKING:
    import adsk.core
    import adsk.fusion

    class _CadAttributes(_FusionProtocol):
        def itemByName(self, groupName: str, name: str, /) -> adsk.core.Attribute | None: ...

    class _DesignCaster(_FusionProtocol):
        @staticmethod
        def cast(arg: object) -> adsk.fusion.Design | None: ...
