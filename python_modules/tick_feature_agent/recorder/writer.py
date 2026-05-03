"""
recorder/writer.py - NdjsonGzWriter: thread- and process-safe gzip NDJSON writer.

Phase 13.1 (spec section 15.7).

One NdjsonGzWriter per stream (underlying_ticks, option_ticks, chain_snapshots).
All write operations are protected by a per-instance threading.Lock so the
asyncio WebSocket callback and the chain-poller timer thread can both write
without corruption.

Cross-process safety: each writer also acquires an exclusive advisory lock on
a sidecar ``<path>.lock`` file. If another process (e.g. a second start-tfa
instance launched by accident) is already writing to the same file, __init__
raises WriterLockError instead of silently interleaving gzip bytes - which is
what produced the "Error -3 invalid block type" corruption in raw data from
2026-04-14 onward.

On write failure: logs ERROR, skips the record, continues - does not halt TFA.
"""

from __future__ import annotations

import gzip
import json
import os
import sys
import threading
from pathlib import Path
from typing import Any

_WINDOWS = sys.platform == "win32"
if _WINDOWS:
    import msvcrt
else:
    import fcntl  # type: ignore


class WriterLockError(RuntimeError):
    """Raised when another process holds the writer lock on a given path."""


class _FileLock:
    """Cross-process advisory exclusive lock on a sidecar <target>.lock file."""

    def __init__(self, target: Path) -> None:
        self._lock_path = target.with_suffix(target.suffix + ".lock")
        self._fd: int | None = None

    def acquire(self) -> None:
        self._lock_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(self._lock_path), os.O_CREAT | os.O_RDWR, 0o644)
        try:
            if _WINDOWS:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(fd)
            raise WriterLockError(
                f"Another process is writing to {self._lock_path.with_suffix('')}. "
                f"Check for duplicate TFA processes for the same instrument."
            ) from exc
        self._fd = fd

    def release(self) -> None:
        if self._fd is None:
            return
        try:
            if _WINDOWS:
                try:
                    msvcrt.locking(self._fd, msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
            os.close(self._fd)
        finally:
            self._fd = None


class NdjsonGzWriter:
    """
    Thread-safe, process-safe writer for NDJSON.gz files.

    Usage:

        writer = NdjsonGzWriter(path="/data/raw/2026-04-14/nifty50_underlying_ticks.ndjson.gz")
        writer.write({"recv_ts": "...", "ltp": 23100.0, ...})
        writer.roll("/data/raw/2026-04-15/nifty50_underlying_ticks.ndjson.gz")
        writer.close()
    """

    _AUTO_FLUSH_EVERY = 50

    def __init__(self, path: str | Path, logger: Any = None) -> None:
        self._path = Path(path)
        self._lock = threading.Lock()
        self._logger = logger
        self._file_lock = _FileLock(self._path)
        self._file_lock.acquire()
        try:
            self._fh = self._open(self._path)
        except Exception:
            self._file_lock.release()
            raise
        self._write_count = 0

    def _open(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        return gzip.open(path, "at", encoding="utf-8")

    def write(self, record: dict[str, Any]) -> bool:
        with self._lock:
            if self._fh is None:
                return False
            try:
                line = json.dumps(record, default=str) + "\n"
                self._fh.write(line)
                self._write_count += 1
                if self._write_count % self._AUTO_FLUSH_EVERY == 0:
                    self._flush_locked()
                return True
            except Exception as exc:
                if self._logger:
                    self._logger.error(
                        "RECORDER_WRITE_FAILED",
                        msg=f"Failed to write record: {exc}",
                        path=str(self._path),
                    )
                return False

    def _raw_fileno(self) -> int | None:
        """Walk the TextIOWrapper -> GzipFile -> BufferedWriter -> raw FileIO chain."""
        fh = self._fh
        if fh is None:
            return None
        buf = getattr(fh, "buffer", None)  # GzipFile
        if buf is None:
            return None
        inner = getattr(buf, "fileobj", None)  # BufferedWriter (or similar)
        if inner is None:
            return None
        try:
            return inner.fileno()
        except (OSError, AttributeError):
            return None

    def _flush_locked(self) -> None:
        if self._fh is None:
            return
        try:
            self._fh.flush()  # TextIOWrapper -> GzipFile
            buf = getattr(self._fh, "buffer", None)  # GzipFile
            if buf is not None:
                buf.flush()  # Z_SYNC_FLUSH into BufferedWriter
                inner = getattr(buf, "fileobj", None)
                if inner is not None:
                    inner.flush()  # BufferedWriter -> OS
            fno = self._raw_fileno()
            if fno is not None:
                os.fsync(fno)
        except Exception:
            pass

    def flush(self) -> None:
        with self._lock:
            self._flush_locked()

    def roll(self, new_path: str | Path) -> None:
        new_path = Path(new_path)
        with self._lock:
            if self._fh is not None:
                try:
                    self._fh.close()
                except Exception:
                    pass
            self._file_lock.release()
            self._path = new_path
            self._file_lock = _FileLock(self._path)
            self._file_lock.acquire()
            try:
                self._fh = self._open(new_path)
            except Exception:
                self._file_lock.release()
                raise

    def close(self) -> None:
        with self._lock:
            if self._fh is not None:
                # Flush + fsync while the underlying fd is still open, then close.
                # close() writes the gzip trailer; on Windows the OS will flush
                # the final bytes when the handle is released, and on POSIX the
                # earlier fsync plus the final close suffices for durability.
                self._flush_locked()
                try:
                    self._fh.close()
                except Exception:
                    pass
                finally:
                    self._fh = None
            self._file_lock.release()

    @property
    def path(self) -> Path:
        return self._path

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
