"""Read NDJSON.gz recordings that may contain a CORRUPT gzip member.

WHY THIS EXISTS
---------------
TFA's recorder appends to `data/raw/<date>/*.ndjson.gz` in gzip append mode,
which writes independent gzip members one after another. When a recorder process
stops badly, the member it was writing can be left corrupt — and Python's
`gzip.open` stops reading at the first corrupt member. Everything written after
it, including by a fresh process that resumed recording, becomes invisible.

Found 2026-09-18. The nifty50 underlying file held two members:

    member 1  written 09:15 -> 10:00 by the original TFA, left corrupt
    member 2  written 12:37 onward by the restarted TFA

`gzip.open` read 3,246 ticks, raised "Error -3 while decompressing data: invalid
block type" at the end of member 1, and never reached member 2. The Market
Status Screen therefore froze at 10:00 even though fresh ticks were on disk —
and so would every other reader using `gzip.open`.

This reader decompresses member by member. When a member is corrupt it keeps
whatever decoded cleanly, then scans forward for the next gzip header and
resumes. Lines that do not parse are dropped by the caller.

KNOWN READERS STILL USING PLAIN gzip.open (not changed here; see T185):
claude_cohort/backtest.py via book.py and flow.py, claude_cohort/study.py,
and TFA's own replay / end-of-day feature build.
"""
from __future__ import annotations

import zlib
from typing import Iterator

GZIP_MAGIC = b"\x1f\x8b\x08"
_CHUNK = 1 << 16


def _decompress_member(raw: bytes, start: int) -> tuple[bytes, int, bool]:
    """Decode one gzip member starting at `start`.

    Returns (decoded_bytes, next_offset, clean). `clean` is False when the member
    was corrupt or truncated; decoded_bytes still holds everything that decoded
    before the problem, so a long member with a damaged tail loses only its tail.
    """
    d = zlib.decompressobj(zlib.MAX_WBITS | 16)   # 16 = expect a gzip wrapper
    out = []
    i = start
    while i < len(raw):
        chunk = raw[i:i + _CHUNK]
        snap = d.copy()
        try:
            out.append(d.decompress(chunk))
        except zlib.error:
            # zlib raises on the damaged block and DISCARDS everything it had
            # decoded from this chunk up to that point. A first version lost a
            # whole 64 KB chunk of good data this way - about 1,000 nifty ticks
            # on 2026-09-18. Rewind and feed the chunk in halving slices to
            # recover every byte that decodes before the fault.
            d = snap
            j, end = i, i + len(chunk)
            step = max(1, len(chunk) // 2)
            while j < end and step >= 1:
                probe = d.copy()
                try:
                    out.append(d.decompress(raw[j:min(j + step, end)]))
                    j += step
                    if d.eof:
                        break
                except zlib.error:
                    d = probe
                    step //= 2
            return b"".join(out), -1, False
        i += len(chunk)
        if d.eof:
            # Rewind to exactly where this member ended.
            i -= len(d.unused_data)
            return b"".join(out), i, True
    # Ran out of bytes before the member's end — the one being written now.
    return b"".join(out), len(raw), False


def iter_lines(path: str) -> Iterator[str]:
    """Every complete text line in the file, across all readable members."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return

    pos = raw.find(GZIP_MAGIC)
    carry = b""
    while pos != -1 and pos < len(raw):
        data, nxt, clean = _decompress_member(raw, pos)
        if data:
            buf = carry + data
            lines = buf.split(b"\n")
            # A damaged or still-growing member usually ends mid-line; hold the
            # fragment back rather than emit half a record.
            carry = lines.pop() if not buf.endswith(b"\n") else b""
            for ln in lines:
                if ln:
                    try:
                        yield ln.decode("utf-8")
                    except UnicodeDecodeError:
                        continue
        if clean and nxt > pos:
            pos = raw.find(GZIP_MAGIC, nxt)
        else:
            # Corrupt: skip past this header and look for the next member. A
            # fragment carried out of a corrupt member is not trusted.
            carry = b""
            pos = raw.find(GZIP_MAGIC, pos + len(GZIP_MAGIC))


def count_members(path: str) -> int:
    """How many gzip members the file appears to contain. Diagnostic only."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return 0
    n, pos = 0, raw.find(GZIP_MAGIC)
    while pos != -1:
        _, nxt, clean = _decompress_member(raw, pos)
        n += 1
        pos = raw.find(GZIP_MAGIC, nxt if clean and nxt > pos else pos + len(GZIP_MAGIC))
    return n


class GzTail:
    """Incrementally follow a growing NDJSON.gz file, surviving corrupt members.

    `iter_lines` re-decodes the whole file, which is fine once but too slow to
    repeat every second: crude oil's underlying file took 1.27 s by early
    afternoon and grows until 23:30. This keeps the decompressor alive between
    calls and feeds it only the bytes appended since last time, so each poll
    costs proportional to what is new, not to the size of the day.

    A recorder writes one long gzip member for the whole session; a restart
    starts a new member. When the member being followed turns out to be corrupt,
    everything that decodes before the fault is kept and following resumes at
    the next gzip header - the same recovery as `iter_lines`.
    """

    def __init__(self, path: str):
        self.path = path
        self._pos = 0            # file bytes already consumed
        self._d = None           # live decompressor for the current member
        self._pending = b""      # raw bytes held back (e.g. a split gzip header)
        self._carry = b""        # partial line awaiting its newline

    def _emit(self, data: bytes, out: list) -> None:
        if not data:
            return
        buf = self._carry + data
        parts = buf.split(b"\n")
        self._carry = parts.pop()
        for ln in parts:
            if ln:
                try:
                    out.append(ln.decode("utf-8"))
                except UnicodeDecodeError:
                    continue

    def _recover(self, snap, buf: bytes, out: list) -> None:
        """Salvage every byte that decodes before a fault (see _decompress_member)."""
        d = snap
        j, step = 0, max(1, len(buf) // 2)
        while j < len(buf) and step >= 1:
            probe = d.copy()
            try:
                self._emit(d.decompress(buf[j:j + step]), out)
                j += step
                if d.eof:
                    break
            except zlib.error:
                d = probe
                step //= 2

    def read_new(self) -> list:
        """Complete lines appended since the previous call."""
        try:
            with open(self.path, "rb") as fh:
                fh.seek(self._pos)
                new = fh.read()
        except OSError:
            return []
        if not new:
            return []
        self._pos += len(new)
        buf = self._pending + new
        self._pending = b""
        out: list = []

        while buf:
            if self._d is None:
                h = buf.find(GZIP_MAGIC)
                if h == -1:
                    # The magic can straddle two reads; keep its possible start.
                    self._pending = buf[-(len(GZIP_MAGIC) - 1):]
                    break
                buf = buf[h:]
                self._d = zlib.decompressobj(zlib.MAX_WBITS | 16)
                self._carry = b""

            snap = self._d.copy()
            try:
                data = self._d.decompress(buf)
            except zlib.error:
                # Corrupt member: keep what decodes, drop the damaged tail, and
                # resume at the next header. A fragment out of a corrupt member
                # is not trusted.
                self._recover(snap, buf, out)
                self._d = None
                self._carry = b""
                nxt = buf.find(GZIP_MAGIC, len(GZIP_MAGIC))
                if nxt == -1:
                    self._pending = buf[-(len(GZIP_MAGIC) - 1):]
                    break
                buf = buf[nxt:]
                continue

            self._emit(data, out)
            if self._d.eof:
                # Member closed cleanly; anything after it is the next member.
                buf = self._d.unused_data
                self._d = None
                self._carry = b""
                continue
            buf = b""   # all consumed; the member is still being written

        return out
