"""Small generated-file allowlist. No recursive deletion or symlink traversal.

Producers inventory only their declared output names, before and after writing.
Deletion requires the same regular-file identity, size and modification time.
Callers must join producers and close streams before collecting consumed files.
"""
import os
import contextlib
from pathlib import Path
import stat


@contextlib.contextmanager
def parent_fd(path):
    """Pin every directory with O_NOFOLLOW; a rename cannot redirect deletion."""
    if os.name != 'posix' or not hasattr(os, 'O_NOFOLLOW'):
        raise OSError('Race-safe cleanup requires POSIX directory descriptors')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open('/', flags)
    try:
        for part in Path(path).absolute().parent.parts[1:]:
            child = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


def safe(path, root):
    path, root = Path(path).absolute(), Path(root).absolute()
    return ('..' not in path.parts and path.is_relative_to(root)
            and not any(p.is_symlink() for p in (path, *path.parents)))


def identity(path):
    info = Path(path).lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        return None
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]


def inventory(root, allowed):
    root = Path(root).absolute()
    result = {}
    if not safe(root, root) or not root.is_dir():
        return result
    for parent, directories, files in os.walk(root, followlinks=False):
        directories[:] = [name for name in directories if not (Path(parent) / name).is_symlink()]
        for name in files:
            path = Path(parent) / name
            if allowed(path.relative_to(root).as_posix()) and safe(path, root):
                value = identity(path)
                if value is not None:
                    result[str(path)] = value
    return result


def directories(root, allowed):
    root = Path(root).absolute()
    result = {}
    if not safe(root, root) or not root.is_dir():
        return result
    for parent, names, _ in os.walk(root, followlinks=False):
        names[:] = [name for name in names if not (Path(parent) / name).is_symlink()]
        for name in names:
            path = Path(parent) / name
            if allowed(path.relative_to(root).as_posix()) and safe(path, root):
                info = path.lstat()
                result[str(path)] = [info.st_dev, info.st_ino]
    return result


def collect_directories(owned, roots):
    remaining = dict(owned)
    for name in sorted(owned, key=lambda p: len(Path(p).parts), reverse=True):
        path = Path(name)
        if not any(safe(path, root) for root in roots):
            continue
        try:
            with parent_fd(path) as descriptor:
                info = os.stat(path.name, dir_fd=descriptor, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode) and [info.st_dev, info.st_ino] == owned[name]:
                    os.rmdir(path.name, dir_fd=descriptor)  # Empty owned dirs only.
                    del remaining[name]
        except FileNotFoundError:
            remaining.pop(name, None)
        except OSError:
            pass  # A user file or retained input keeps the directory alive.
    return remaining


def collect(owned, roots, keep=(), protected=(), debug=False):
    """Return (remaining allowlist, actual unlinked file bytes). Unknown files stay."""
    remaining, freed = dict(owned), 0
    if debug:
        return remaining, freed
    protected = {str(Path(p).absolute()) for p in (*keep, *protected) if p}
    for name, expected in owned.items():
        path = Path(name)
        if name in protected or not any(safe(path, root) for root in roots):
            continue
        try:
            with parent_fd(path) as descriptor:
                info = os.stat(path.name, dir_fd=descriptor, follow_symlinks=False)
                actual = [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or actual != expected:
                    continue
                os.unlink(path.name, dir_fd=descriptor)
                freed += actual[2]
                del remaining[name]
        except FileNotFoundError:
            remaining.pop(name, None)
        except OSError:
            pass  # Permissions, changed ancestors, unsupported platform: retain.
    return remaining, freed
