"""
package_latest_models.py — bundle the LATEST trained model for every
instrument into a single zip for laptop transfer.

Output: `models_<YYYYMMDD_HHMMSS>.zip` in the repo root, containing
    models/<instrument>/LATEST
    models/<instrument>/<version>/...   (.lgbm files + manifest + metrics)
for each of the 4 instruments — only the version listed in that
instrument's `LATEST` pointer, nothing older.

Unpack on the other machine by running:
    python -c "import zipfile, sys; zipfile.ZipFile(sys.argv[1]).extractall()"  models_XYZ.zip
or just right-click → Extract All in Windows Explorer.
"""

from __future__ import annotations

import sys
import zipfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INSTRUMENTS = ("nifty50", "banknifty", "crudeoil", "naturalgas")


def main() -> int:
    bundles: list[tuple[str, Path, Path]] = []  # (instrument, latest_pointer_file, version_dir)
    missing: list[str] = []
    for inst in INSTRUMENTS:
        inst_dir = ROOT / "models" / inst
        latest_ptr = inst_dir / "LATEST"
        if not latest_ptr.exists():
            missing.append(inst)
            continue
        version = latest_ptr.read_text(encoding="utf-8").strip()
        version_dir = inst_dir / version
        if not version_dir.exists():
            missing.append(f"{inst} (LATEST points at non-existent {version})")
            continue
        bundles.append((inst, latest_ptr, version_dir))

    if missing:
        print("  WARNING — skipping instruments with missing models:")
        for m in missing:
            print(f"    - {m}")
        print()

    if not bundles:
        print("  ERROR: no instruments have a LATEST model. Nothing to package.")
        return 1

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = ROOT / f"models_{ts}.zip"
    print(f"  Packaging {len(bundles)} instrument(s) into {out_path.name}")
    print()

    total_files = 0
    total_bytes = 0
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for inst, latest_ptr, version_dir in bundles:
            # LATEST pointer
            arc_latest = f"models/{inst}/LATEST"
            zf.write(latest_ptr, arc_latest)
            total_files += 1
            total_bytes += latest_ptr.stat().st_size
            # Version directory contents
            version_count = 0
            version_bytes = 0
            for f in version_dir.rglob("*"):
                if not f.is_file():
                    continue
                arc = f"models/{inst}/{version_dir.name}/{f.relative_to(version_dir).as_posix()}"
                zf.write(f, arc)
                version_count += 1
                version_bytes += f.stat().st_size
                total_files += 1
                total_bytes += f.stat().st_size
            mb = version_bytes / (1024 * 1024)
            print(f"    {inst:11s} version {version_dir.name}  "
                  f"{version_count:>3d} files  {mb:>6.2f} MB")

    out_mb = out_path.stat().st_size / (1024 * 1024)
    print()
    print(f"  Done — {total_files} files, {total_bytes / (1024 * 1024):.2f} MB raw, "
          f"{out_mb:.2f} MB compressed")
    print(f"  Wrote: {out_path}")
    print()
    print(f"  To unpack on the other machine, copy the zip into the repo root and run:")
    print(f"    python -c \"import zipfile; zipfile.ZipFile('{out_path.name}').extractall()\"")
    return 0


if __name__ == "__main__":
    sys.exit(main())
