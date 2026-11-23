"""``fcntl.flock`` for Linux and Windows (Kortes Desktop runs the backend natively).

Callers use it like fcntl: ``file_lock.flock(handle, file_lock.LOCK_EX | file_lock.LOCK_NB)``
raises ``BlockingIOError`` when the lock is taken. Locks belong to the open file
(two opens of the same lock file conflict, even in one process) and go away
when it is closed.

On Windows this is ``LockFileEx`` on one byte far past the end of the file, so
the lock never blocks reading or writing the file's contents. Unlike flock it
does not turn a shared lock into an exclusive one on the same open file: lock
files here are always opened once per lock, which this relies on.
"""

from __future__ import annotations

import os

if os.name != "nt":
    from fcntl import LOCK_EX, LOCK_NB, LOCK_SH, LOCK_UN, flock  # noqa: F401
else:
    import ctypes
    import msvcrt
    from ctypes import wintypes

    LOCK_SH, LOCK_EX, LOCK_NB, LOCK_UN = 1, 2, 4, 8

    _LOCKFILE_FAIL_IMMEDIATELY = 0x1
    _LOCKFILE_EXCLUSIVE_LOCK = 0x2
    _ERROR_LOCK_VIOLATION = 33
    _ERROR_IO_PENDING = 997
    _ERROR_NOT_LOCKED = 158
    # One byte near the top of the 64-bit range: never part of a real file.
    _OFFSET_LOW, _OFFSET_HIGH = 0xFFFFFFFE, 0x7FFFFFFF

    class _Overlapped(ctypes.Structure):
        _fields_ = [
            ("Internal", ctypes.c_void_p),
            ("InternalHigh", ctypes.c_void_p),
            ("Offset", wintypes.DWORD),
            ("OffsetHigh", wintypes.DWORD),
            ("hEvent", wintypes.HANDLE),
        ]

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _LockFileEx = _kernel32.LockFileEx
    _LockFileEx.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
        ctypes.POINTER(_Overlapped),
    ]
    _LockFileEx.restype = wintypes.BOOL
    _UnlockFileEx = _kernel32.UnlockFileEx
    _UnlockFileEx.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(_Overlapped),
    ]
    _UnlockFileEx.restype = wintypes.BOOL

    def _overlapped() -> _Overlapped:
        overlapped = _Overlapped()
        overlapped.Offset = _OFFSET_LOW
        overlapped.OffsetHigh = _OFFSET_HIGH
        return overlapped

    def flock(handle, operation: int) -> None:
        os_handle = msvcrt.get_osfhandle(handle.fileno() if hasattr(handle, "fileno") else handle)
        if operation & LOCK_UN:
            if not _UnlockFileEx(os_handle, 0, 1, 0, ctypes.byref(_overlapped())):
                error = ctypes.get_last_error()
                if error != _ERROR_NOT_LOCKED:
                    raise ctypes.WinError(error)
            return
        flags = 0
        if operation & LOCK_EX:
            flags |= _LOCKFILE_EXCLUSIVE_LOCK
        if operation & LOCK_NB:
            flags |= _LOCKFILE_FAIL_IMMEDIATELY
        if not _LockFileEx(os_handle, flags, 0, 1, 0, ctypes.byref(_overlapped())):
            error = ctypes.get_last_error()
            if error in (_ERROR_LOCK_VIOLATION, _ERROR_IO_PENDING):
                raise BlockingIOError(error, "The file is locked")
            raise ctypes.WinError(error)
