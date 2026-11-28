const declarations = (
  windowsOnly: boolean,
) => `import os as _qi_os, ${windowsOnly ? "" : "sys as _qi_sys, "}adsk.core as _qi_core
from typing import Protocol as _qi_Protocol, cast as _qi_cast, Sequence as _qi_Sequence
class _qi_ProcessHandle(_qi_Protocol):
    restype: object
    def __call__(self) -> object: ...
class _qi_ProcessTimes(_qi_Protocol):
    argtypes: _qi_Sequence[object]
    def __call__(self, handle: object, creation: object, exit: object, kernel: object, user: object) -> int: ...
class _qi_Kernel(_qi_Protocol):
    GetCurrentProcess: _qi_ProcessHandle
    GetProcessTimes: _qi_ProcessTimes
`;

const windowsBirth = `        import ctypes as _ct
        from ctypes import wintypes as _wt
        # Audited Win32 ABI: GetProcessTimes(HANDLE, FILETIME*, FILETIME*, FILETIME*, FILETIME*).
        _kernel = _qi_cast(_qi_Kernel, _ct.WinDLL('kernel32', use_last_error=True))
        _kernel.GetCurrentProcess.restype = _wt.HANDLE
        _kernel.GetProcessTimes.argtypes = [_wt.HANDLE] + [_ct.POINTER(_wt.FILETIME)] * 4
        _times = [_wt.FILETIME() for _ in range(4)]
        if not _kernel.GetProcessTimes(_kernel.GetCurrentProcess(), _ct.byref(_times[0]), _ct.byref(_times[1]), _ct.byref(_times[2]), _ct.byref(_times[3])):
            raise OSError(_ct.get_last_error(), 'GetProcessTimes')
        _birth = str((_times[0].dwHighDateTime << 32) | _times[0].dwLowDateTime)
`;

/** Canonical ABI implementation, shared by generic and qualified Windows receipts. */
export function receiptIdentitySource(host?: "windows"): string {
  const windowsOnly = host === "windows";
  return (
    declarations(windowsOnly) +
    (windowsOnly
      ? "if _qi_os.name != 'nt':\n    raise RuntimeError('Camera receipt requires the qualified Windows Fusion host')\n"
      : "") +
    `def _qi_identity() -> dict[str, object]:
    _app = _qi_core.Application.get()
` +
    (windowsOnly
      ? windowsBirth
          .split("\n")
          .map((line) => line.slice(4))
          .join("\n")
      : `    if _qi_os.name == 'nt':
${windowsBirth}    elif _qi_sys.platform.startswith('linux'):
        with open('/proc/self/stat') as _f: _stat = _f.read()
        with open('/proc/sys/kernel/random/boot_id') as _f: _boot = _f.read().strip()
        _birth = _boot + ':' + _stat[_stat.rfind(')') + 2:].split()[19]
    else:
        raise RuntimeError('Actual process birth identity unavailable on this Fusion host')
`) +
    `    return {'pid':_qi_os.getpid(), 'birth':_birth, 'version':_app.version,
            'activeCommand':_app.userInterface.activeCommand}
`
  );
}
