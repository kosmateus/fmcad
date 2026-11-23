/**
 * Runtime implementation subset of the approved v2 primitive semantics.
 * Approval still comes from the source-effects API, never this name inventory.
 */
export const isolatedStdoutPrimitives: Readonly<
  Record<string, "function" | "type">
> = Object.freeze({
  print: "function",
  len: "function",
  sorted: "function",
  abs: "function",
  min: "function",
  max: "function",
  str: "type",
  int: "type",
  float: "type",
  bool: "type",
  object: "type",
  list: "type",
  tuple: "type",
  range: "type",
  type: "type",
  enumerate: "type",
  ValueError: "type",
  RuntimeError: "type",
  AssertionError: "type",
  Exception: "type",
});

/**
 * Trusted host entry is required: this cannot validate earlier host compile,
 * redirection, audit/tracing callbacks or native-process integrity.
 * Not a general Python sandbox. The exact source must also pass approved v2.
 */
export function emitIsolatedStdoutKernel(
  source: string,
  names: readonly string[],
): string {
  const bindings = names.map((name) => [name, isolatedStdoutPrimitives[name]]);
  return String.raw`
from typing import TYPE_CHECKING, cast
if TYPE_CHECKING:
    from types import CodeType, FunctionType, ModuleType
    from typing import Callable, NoReturn, Protocol, TypeGuard

    class _StdoutBuffer(Protocol):
        def write(self, text: str, /) -> int: ...
        def flush(self) -> None: ...

    class _NativePrint(Protocol):
        def __call__(self, *args: object, sep: str | None = " ",
                     end: str | None = "\n", file: _StdoutBuffer | None = None,
                     flush: bool = False) -> None: ...

    class _NativeCompile(Protocol):
        def __call__(self, source: str, filename: str, mode: str, flags: int,
                     dont_inherit: bool, /) -> CodeType: ...

    class _NativeExec(Protocol):
        def __call__(self, code: CodeType, namespace: dict[str, object],
                     local: dict[str, object], /) -> None: ...

    class _FunctionFactory(Protocol):
        def __call__(self, code: CodeType, namespace: dict[str, object], /) -> FunctionType: ...

# Checker declarations, not assignments or evidence of the host bindings.
io: "ModuleType"
inspect: "ModuleType"
__builtins__: "object"
_fmcad_stdout_c_print: "_NativePrint"
_fmcad_stdout_buffer: "_StdoutBuffer"
_fmcad_stdout_type_error: "type[TypeError]"

def _fmcad_isolated_stdout_main() -> None:
    def _deny() -> "NoReturn":
        # The first iteration unconditionally raises an interpreter-created
        # exception. No exception symbol/callback/assertion is resolved.
        while True:
            _refusal = 1 // 0

    # These casts describe fixed CPython intrinsic descriptors, not caller data.
    _type = cast("Callable[[object], type[object]]", ().__class__.__class__)
    _object = cast("type[object]", ().__class__.__base__)
    _type_get = cast("Callable[[object, str], object]", ().__class__.__class__.__getattribute__)
    _object_get = cast("Callable[[object, str], object]", _object.__getattribute__)
    _dict_type = {"": 0}.__class__
    _str_type = "".__class__
    _int_type = (0).__class__
    _function_type = [0].append.__class__
    _method_descriptor_type = [0].__class__.append.__class__
    _function_factory = cast("_FunctionFactory", (lambda: None).__class__)

    def _is_str(value: "object") -> "TypeGuard[str]":
        return _type(value) is _str_type

    def _native_type(value: "object", module: "str", name: "str") -> "TypeGuard[type[object]]":
        if _type(value) is not _type:
            return False
        flags = _type_get(value, "__flags__")
        if _type(flags) is not _int_type:
            return False
        if not (cast("int", flags) & 256):
            return False
        actual_module = _type_get(value, "__module__")
        actual_name = _type_get(value, "__name__")
        return (_is_str(actual_module) and actual_module == module
                and _is_str(actual_name) and actual_name == name)

    def _string_dict(value: "object") -> "dict[str, object]":
        if _type(value) is not _dict_type:
            _deny()
        data = cast("dict[object, object]", value)
        for key in data:
            if not _is_str(key):
                _deny()
        return cast("dict[str, object]", data)

    def _module_dict(value: "object", name: "str") -> "dict[str, object]":
        if not _native_type(_type(value), "builtins", "module"):
            _deny()
        data = _string_dict(_object_get(value, "__dict__"))
        actual_name = data["__name__"]
        if not _is_str(actual_name) or actual_name != name:
            _deny()
        return data

    try:
        _host_builtins = __builtins__
        _host_io = io
        _host_inspect = inspect
        if _type(_host_builtins) is _dict_type:
            _builtins_dict = _string_dict(_host_builtins)
        else:
            _builtins_dict = _module_dict(_host_builtins, "builtins")
        _owner: object = None
        _verified: dict[str, object] = {}
        _requested: list[list[str]] = ${JSON.stringify(bindings)}
        # These three C functions anchor a common genuine builtins module even
        # when the input itself needs no user-visible primitive.
        for name in ("compile", "exec", "print"):
            value = _builtins_dict[name]
            if _type(value) is not _function_type:
                _deny()
            actual_name = _object_get(value, "__name__")
            actual_module = _object_get(value, "__module__")
            owner = _object_get(value, "__self__")
            if (not _is_str(actual_name) or actual_name != name
                    or not _is_str(actual_module) or actual_module != "builtins"
                    or _module_dict(owner, "builtins") is not _builtins_dict):
                _deny()
            if _owner is None:
                _owner = owner
            elif owner is not _owner:
                _deny()
            _verified[name] = value
        for name, kind in _requested + [["TypeError", "type"]]:
            value = _builtins_dict[name]
            if kind == "function":
                if _type(value) is not _function_type:
                    _deny()
                actual_name = _object_get(value, "__name__")
                actual_module = _object_get(value, "__module__")
                if (not _is_str(actual_name) or actual_name != name
                        or not _is_str(actual_module) or actual_module != "builtins"
                        or _object_get(value, "__self__") is not _owner):
                    _deny()
            elif not _native_type(value, "builtins", name):
                _deny()
            _verified[name] = value

        _io_dict = _module_dict(_host_io, "io")
        _inspect_dict = _module_dict(_host_inspect, "inspect")
        _sys_dict = _module_dict(_inspect_dict["sys"], "sys")
        _stringio = _io_dict["StringIO"]
        if not _native_type(_stringio, "_io", "StringIO"):
            _deny()
        _sink = _sys_dict["stdout"]
        if _type(_sink) is not _stringio:
            _deny()
        _descriptors: dict[str, object] = {}
        for name in ("write", "getvalue", "tell"):
            descriptor = _type_get(_stringio, name)
            if (_type(descriptor) is not _method_descriptor_type
                    or _object_get(descriptor, "__objclass__") is not _stringio):
                _deny()
            descriptor_name = _object_get(descriptor, "__name__")
            if not _is_str(descriptor_name) or descriptor_name != name:
                _deny()
            _descriptors[name] = descriptor
        _write = cast("Callable[[object, str], int]", _descriptors["write"])
        _getvalue = cast("Callable[[object], str]", _descriptors["getvalue"])
        _tell = cast("Callable[[object], int]", _descriptors["tell"])
        if _getvalue(_sink) != "" or _tell(_sink) != 0:
            _deny()
        _buffer = _stringio()
        if _type(_buffer) is not _stringio:
            _deny()
    except:
        _deny()

    compile = cast("_NativeCompile", _verified["compile"])
    exec = cast("_NativeExec", _verified["exec"])
    _type_error = cast("type[TypeError]", _verified["TypeError"])

    # These names are globals only in the cloned adapter's private dictionary,
    # never the kernel/host globals. Its entire body is checked in this unit.
    def _print_definition(*args: "object", sep: "str | None" = " ",
                          end: "str | None" = "\n", file: "object" = None,
                          flush: "bool" = False) -> None:
        if file is not None:
            raise _fmcad_stdout_type_error("isolated-stdout-v1 permits only private stdout")
        _fmcad_stdout_c_print(*args, sep=sep, end=end,
                             file=_fmcad_stdout_buffer, flush=flush)

    _printer_globals: dict[str, object] = {
        "__builtins__": {}, "_fmcad_stdout_c_print": _verified["print"],
        "_fmcad_stdout_buffer": _buffer, "_fmcad_stdout_type_error": _type_error,
    }
    _printer_code = cast("CodeType", _object_get(_print_definition, "__code__"))
    _printer = _function_factory(_printer_code, _printer_globals)
    _printer.__kwdefaults__ = {"sep": " ", "end": "\n", "file": None, "flush": False}
    _user_builtins: dict[str, object] = {}
    for name, kind in _requested:
        _user_builtins[name] = _verified[name]
    if "print" in _user_builtins:
        _user_builtins["print"] = _printer
    _user_globals: dict[str, object] = {"__builtins__": _user_builtins}
    try:
        exec(compile(${JSON.stringify(source)}, "<isolated-stdout-source>", "exec", 0, True),
              _user_globals, _user_globals)
    finally:
        # No instance.write lookup: a poisoned sink callback cannot run.
        _write(_sink, _getvalue(_buffer))

_fmcad_isolated_stdout_main()
`;
}
