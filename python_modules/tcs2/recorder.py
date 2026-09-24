"""TCS2 - the tick recorder: sealed chunks, and a reader that survives damage.

Spec: docs/systems/14_tcs2.md  (D8, D20, D43, D44)

A gzip file is a run of independent members laid end to end. Left alone, a writer
keeps one member open all day - and a crash turns that member into garbage that
sits **in front of everything behind it**, so a standard reader stops there. That
is exactly what happened on 2026-09-18: 16 of 326 recordings damaged, some losing
99.9% of a day, and ticks cannot be re-obtained.

D44: **seal a member every 10 seconds.** Sealed members are readable forever, so
a crash costs ten seconds rather than a day. Compression restarts with each
member, which costs about 10% more disk - measured against ~1 GB/day, accepted.

Two halves, both belonging to TCS2 rather than borrowed (D43):

  * `TickRecorder` - the writer. Sealing prevents the damage.
  * `read_lines` / `iter_members` - the reader. It rescues whatever still slips
    through, because prevention is never total.

The reader recovers in two stages when it meets a damaged member: it keeps
whatever decompressed before the fault, then scans forward for the next member's
magic bytes and resumes. A standard reader returns nothing past the fault.
"""
from __future__ import annotations

import gzip
import json
import os
import queue
import threading
import time
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

# D44. Long enough that the ~10% size penalty stays modest, short enough that
# losing one member is not worth caring about.
SEAL_EVERY_SEC = 10.0

# gzip member header: magic 0x1f 0x8b, then compression method 8 (deflate).
GZIP_MAGIC = b"\x1f\x8b\x08"

# zlib window size that produces a gzip wrapper rather than a bare deflate stream.
_GZIP_WBITS = zlib.MAX_WBITS | 16


@dataclass
class RecorderStats:
    lines: int = 0
    bytes_written: int = 0
    members_sealed: int = 0
    queue_high_water: int = 0
    dropped: int = 0
    last_write_at: float = 0.0
    errors: list[str] = field(default_factory=list)


class TickRecorder:
    """Append JSON lines to a gzip file, sealing a member every few seconds.

    Runs on its own thread (D16), fed through a queue so the feed thread never
    waits on the disk. **The queue is unbounded on purpose**: dropping a tick to
    protect the GUI is allowed, dropping one to protect the recorder is not -
    ticks cannot be re-obtained. If the disk cannot keep up, memory grows and
    `queue_high_water` says so, which is a visible failure rather than a silent
    one.
    """

    def __init__(self, path: Path, seal_every_sec: float = SEAL_EVERY_SEC) -> None:
        self.path = Path(path)
        self.seal_every_sec = seal_every_sec
        self.stats = RecorderStats()
        self._q: queue.Queue[Any] = queue.Queue()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._fh = None
        self._comp: zlib._Compress | None = None
        self._member_opened_at = 0.0

    # -- writing ---------------------------------------------------------

    def _open(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(self.path, "ab")
        self._new_member()

    def _new_member(self) -> None:
        self._comp = zlib.compressobj(6, zlib.DEFLATED, _GZIP_WBITS)
        self._member_opened_at = time.time()

    def _seal(self) -> None:
        """Finish the current member and flush it to the operating system.

        After this returns, everything written so far is readable by any gzip
        reader, even if the process dies in the next instruction.
        """
        if self._comp is None or self._fh is None:
            return
        tail = self._comp.flush(zlib.Z_FINISH)
        if tail:
            self._fh.write(tail)
            self.stats.bytes_written += len(tail)
        self._fh.flush()
        os.fsync(self._fh.fileno())
        self.stats.members_sealed += 1
        self._comp = None

    def _write(self, line: bytes) -> None:
        if self._comp is None:
            self._new_member()
        chunk = self._comp.compress(line)
        if chunk:
            self._fh.write(chunk)
            self.stats.bytes_written += len(chunk)
        self.stats.lines += 1
        self.stats.last_write_at = time.time()

    def _run(self) -> None:
        self._open()
        try:
            while True:
                # Wait no longer than the time left until the next seal is due.
                # Blocking on the queue for a fixed period would starve the seal
                # check during a quiet market, making the guarantee "10 seconds,
                # plus however long nothing arrived" - which is not the
                # guarantee D44 makes.
                now = time.time()
                if self._comp is None:
                    wait = 0.5
                else:
                    due = self._member_opened_at + self.seal_every_sec
                    wait = min(0.5, max(0.005, due - now))
                try:
                    item = self._q.get(timeout=wait)
                except queue.Empty:
                    item = None
                if item is not None:
                    self._write(item)
                    self._q.task_done()
                now = time.time()
                if self._comp is not None and \
                        now - self._member_opened_at >= self.seal_every_sec:
                    self._seal()
                if self._stop.is_set() and self._q.empty():
                    break
        except Exception as exc:                      # noqa: BLE001
            self.stats.errors.append(f"{type(exc).__name__}: {exc}"[:200])
        finally:
            # Drain whatever is still queued, then seal. A graceful stop must
            # not be the thing that loses the last ten seconds.
            try:
                while True:
                    self._write(self._q.get_nowait())
                    self._q.task_done()
            except queue.Empty:
                pass
            except Exception:                         # noqa: BLE001
                pass
            self._seal()
            if self._fh is not None:
                self._fh.close()
                self._fh = None

    # -- public ----------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("already started")
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="tcs2-recorder",
                                        daemon=True)
        self._thread.start()

    def write(self, obj: Any) -> None:
        """Queue one record. Called from the feed thread; never blocks on disk."""
        line = (obj if isinstance(obj, (bytes, bytearray))
                else json.dumps(obj, separators=(",", ":")).encode("utf-8"))
        if not line.endswith(b"\n"):
            line = line + b"\n"
        self._q.put(line)
        n = self._q.qsize()
        if n > self.stats.queue_high_water:
            self.stats.queue_high_water = n

    def stop(self, timeout: float = 30.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def pending(self) -> int:
        return self._q.qsize()


# -- reading -------------------------------------------------------------

@dataclass
class ReadReport:
    members: int = 0
    damaged_members: int = 0
    lines: int = 0
    bytes_recovered: int = 0
    bytes_skipped: int = 0

    @property
    def clean(self) -> bool:
        return self.damaged_members == 0


def _find_next_member(raw: bytes, start: int) -> int:
    """Byte offset of the next gzip member header at or after `start`, else -1."""
    return raw.find(GZIP_MAGIC, start)


def iter_members(raw: bytes, report: ReadReport | None = None
                 ) -> Iterator[bytes]:
    """Yield the decompressed bytes of every member, stepping over damage.

    A standard reader stops at the first damaged member and everything behind it
    is lost. This one does two things instead:

      1. keeps whatever decompressed **before** the fault, rather than discarding
         the member wholesale
      2. scans forward for the next member's magic bytes and carries on

    That is the difference between losing ten seconds and losing a day.
    """
    rep = report if report is not None else ReadReport()
    pos = 0
    n = len(raw)
    while pos < n:
        start = _find_next_member(raw, pos)
        if start < 0:
            rep.bytes_skipped += n - pos
            return
        if start > pos:
            rep.bytes_skipped += start - pos
        d = zlib.decompressobj(_GZIP_WBITS)
        out = bytearray()
        try:
            out += d.decompress(raw[start:])
            consumed = n - start - len(d.unused_data)
            rep.members += 1
            rep.bytes_recovered += len(out)
            yield bytes(out)
            pos = start + max(consumed, 1)
        except zlib.error:
            # Damaged. Keep whatever came out before the fault, then look for the
            # next member. zlib discards the failing chunk's partial output, so
            # decompress byte-wise to salvage the leading good portion.
            rep.damaged_members += 1
            salvage = bytearray()
            d2 = zlib.decompressobj(_GZIP_WBITS)
            i = start
            while i < n:
                try:
                    salvage += d2.decompress(raw[i:i + 1])
                except zlib.error:
                    break
                i += 1
                if d2.eof:
                    break
            if salvage:
                rep.bytes_recovered += len(salvage)
                yield bytes(salvage)
            nxt = _find_next_member(raw, start + 3)
            if nxt < 0:
                rep.bytes_skipped += n - start
                return
            pos = nxt


def read_lines(path: Path | str, report: ReadReport | None = None
               ) -> Iterator[bytes]:
    """Every complete line in the file, skipping past damage.

    A line straddling a member boundary is stitched back together, and a trailing
    partial line - the signature of a crash mid-write - is discarded rather than
    handed on as a truncated record.
    """
    rep = report if report is not None else ReadReport()
    raw = Path(path).read_bytes()
    carry = b""
    for block in iter_members(raw, rep):
        buf = carry + block
        *lines, carry = buf.split(b"\n")
        for ln in lines:
            if ln:
                rep.lines += 1
                yield ln
    if carry.endswith(b"}"):          # a complete record with no newline
        rep.lines += 1
        yield carry


def read_json(path: Path | str, report: ReadReport | None = None
              ) -> Iterator[dict]:
    """Decoded records, skipping any line damage left a line unparseable."""
    for ln in read_lines(path, report):
        try:
            yield json.loads(ln)
        except (ValueError, UnicodeDecodeError):
            continue


def is_readable_by_standard_gzip(path: Path | str) -> bool:
    """Would an ordinary gzip reader get through the whole file?

    Used by tests to demonstrate the difference, and useful in a health check:
    a file that stops answering yes has been damaged since it was written.
    """
    try:
        with gzip.open(path, "rb") as f:
            while f.read(1 << 20):
                pass
        return True
    except (OSError, EOFError, zlib.error):
        return False
