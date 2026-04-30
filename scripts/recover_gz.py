"""
recover_gz.py - Salvage partial NDJSON data from corrupted .ndjson.gz files.

Scans data/raw/<date>/*.ndjson.gz. For any file that fails `gzip -t`:
  1. Stream-reads decompressed bytes until zlib throws.
  2. Trims back to the last complete '\n' so we never emit a half-line.
  3. Re-gzips the recovered prefix as <stem>.recovered.ndjson.gz (separate file
     - originals are never modified).

Idempotent: skips files that already have an up-to-date .recovered sibling.

Usage:
  python scripts/recover_gz.py                       # scan all of data/raw
  python scripts/recover_gz.py --date 2026-04-20     # one date folder
  python scripts/recover_gz.py --root data/raw       # custom root
  python scripts/recover_gz.py --force               # rewrite even if up-to-date
"""

from __future__ import annotations

import argparse
import gzip
import sys
from pathlib import Path


def _integrity_ok(path: Path) -> bool:
    try:
        with gzip.open(path, "rb") as g:
            while g.read(4 * 1024 * 1024):
                pass
        return True
    except Exception:
        return False


def _stream_recover(path: Path) -> bytes:
    """Read as much decompressed data as possible, trimmed to last newline."""
    buf = bytearray()
    try:
        with gzip.open(path, "rb") as g:
            while True:
                chunk = g.read(4 * 1024 * 1024)
                if not chunk:
                    break
                buf.extend(chunk)
    except Exception:
        pass
    # Trim to last newline so we never emit a half-JSON line
    last_nl = buf.rfind(b"\n")
    if last_nl < 0:
        return b""
    return bytes(buf[: last_nl + 1])


def _count_lines_gz(path: Path) -> int | None:
    """Count newlines in a `.ndjson.gz` file, returning None if the gzip
    stream is unreadable. Used by the PY-128 'recovered ≥ existing'
    guard so we never overwrite a higher-water-mark recovered file with
    a smaller one (e.g. when source corruption worsens between runs)."""
    if not path.exists():
        return None
    try:
        n = 0
        with gzip.open(path, "rb") as g:
            while True:
                chunk = g.read(4 * 1024 * 1024)
                if not chunk:
                    break
                n += chunk.count(b"\n")
        return n
    except Exception:
        return None


def _recover_one(path: Path, force: bool) -> dict:
    out_path = path.with_name(path.stem.replace(".ndjson", "") + ".recovered.ndjson.gz")
    if out_path.exists() and not force:
        if out_path.stat().st_mtime >= path.stat().st_mtime:
            return {"path": path, "status": "skip_up_to_date", "out": out_path}

    data = _stream_recover(path)
    lines = data.count(b"\n")
    if not data:
        return {"path": path, "status": "empty", "lines": 0, "out": None}

    # PY-128: never overwrite an existing recovered file with one that
    # has fewer lines. If the prior recovery captured more data (because
    # the source was less corrupt at that time, or earlier recovery logic
    # was better), keeping it is strictly safer than the new attempt.
    if out_path.exists():
        existing_lines = _count_lines_gz(out_path)
        if existing_lines is not None and lines < existing_lines:
            print(
                f"  WARN  {path.name}: new recovery has {lines:,} lines, "
                f"existing has {existing_lines:,}; keeping existing.",
                file=sys.stderr,
            )
            return {
                "path": path,
                "status": "kept_existing",
                "lines": lines,
                "existing_lines": existing_lines,
                "out": out_path,
            }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(out_path, "wb") as g:
        g.write(data)

    return {
        "path": path,
        "status": "recovered",
        "lines": lines,
        "raw_bytes": len(data),
        "in_size": path.stat().st_size,
        "out": out_path,
        "out_size": out_path.stat().st_size,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="data/raw")
    ap.add_argument("--date", help="Single date folder (YYYY-MM-DD). Default: all.")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    root = Path(args.root)
    if not root.exists():
        print(f"ERROR: {root} does not exist", file=sys.stderr)
        return 1

    date_dirs = [root / args.date] if args.date else sorted(
        d for d in root.iterdir() if d.is_dir()
    )

    totals = {"ok": 0, "recovered": 0, "skipped": 0, "empty": 0,
              "kept_existing": 0, "files": 0}
    for d in date_dirs:
        if not d.exists():
            continue
        gz_files = sorted(
            p for p in d.glob("*.ndjson.gz") if ".recovered." not in p.name
        )
        if not gz_files:
            continue

        print(f"\n=== {d.name} ({len(gz_files)} files) ===")
        for p in gz_files:
            totals["files"] += 1
            if _integrity_ok(p):
                print(f"  OK    {p.name}")
                totals["ok"] += 1
                continue

            result = _recover_one(p, args.force)
            if result["status"] == "skip_up_to_date":
                print(f"  SKIP  {p.name}  (recovered file is up-to-date)")
                totals["skipped"] += 1
            elif result["status"] == "empty":
                print(f"  EMPTY {p.name}  (no recoverable lines)")
                totals["empty"] += 1
            elif result["status"] == "kept_existing":
                # Already printed a WARN to stderr inside _recover_one;
                # nothing extra here, just count it.
                totals["kept_existing"] += 1
            else:
                in_mb  = result["in_size"] / 1e6
                out_mb = result["out_size"] / 1e6
                print(
                    f"  REC   {p.name}"
                    f"  lines={result['lines']:,}"
                    f"  decomp={result['raw_bytes']/1e6:.1f}MB"
                    f"  {in_mb:.1f}MB -> {out_mb:.1f}MB"
                    f"  -> {result['out'].name}"
                )
                totals["recovered"] += 1

    print()
    print("-" * 60)
    print(
        f"files={totals['files']}  ok={totals['ok']}  "
        f"recovered={totals['recovered']}  skipped={totals['skipped']}  "
        f"kept_existing={totals['kept_existing']}  "
        f"empty={totals['empty']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
