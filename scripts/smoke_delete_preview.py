"""Smoke-test the Delete preview helpers — no destructive ops."""
import sys
sys.path.insert(0, "startup")

import launcher_v2 as L
from pathlib import Path

print()
print("=== Raw days available per instrument ===")
for inst in L._INSTRUMENTS:
    raw = L.scan_raw_days(inst)
    print(f"  {inst:11s} {len(raw):2d} days: {raw[:5]}{'...' if len(raw) > 5 else ''}")

print()
print("=== Parquet days available per instrument ===")
for inst in L._INSTRUMENTS:
    parquet = L.scan_feature_days(inst)
    print(f"  {inst:11s} {len(parquet):2d} days: {parquet}")

print()
print("=== Live feature stream sizes ===")
for inst in L._INSTRUMENTS:
    p = L.ROOT / "data" / "features" / f"{inst}_live.ndjson"
    sz = L._path_size(p)
    print(f"  {inst:11s} {L._human_bytes(sz):>12s}  {p}")

print()
print("=== Model versions per instrument ===")
for inst in L._INSTRUMENTS:
    inst_dir = L.ROOT / "models" / inst
    if not inst_dir.exists():
        print(f"  {inst}: no models dir")
        continue
    latest_ptr = inst_dir / "LATEST"
    latest = latest_ptr.read_text(encoding="utf-8").strip() if latest_ptr.exists() else ""
    print(f"  {inst}  (LATEST = {latest})")
    versions = sorted([v for v in inst_dir.iterdir() if v.is_dir()], reverse=True)
    for v in versions[:5]:
        sz = L._path_size(v)
        marker = " (LATEST)" if v.name == latest else ""
        print(f"    {v.name:30s} {L._human_bytes(sz):>10s}{marker}")
    if len(versions) > 5:
        print(f"    ... +{len(versions) - 5} more")
