import json

with open("data/features/nifty50_live.ndjson") as f:
    lines = f.readlines()

def populated(chunk):
    return sum(1 for ln in chunk if json.loads(ln).get("upside_percentile_60s") is not None)

print(f"total: {len(lines)}")
for label, sl in [
    ("first 100", lines[:100]),
    ("mid 500 (10000-10500)", lines[10000:10500]),
    ("rows 24000-24500", lines[24000:24500]),
    ("last 500", lines[-500:]),
    ("last 50", lines[-50:]),
]:
    print(f"  {label}: {populated(sl)}/{len(sl)} populated")

# Time-of-day of last 5 rows
print()
for ln in lines[-5:]:
    row = json.loads(ln)
    print(f"  ts={row.get('timestamp_ist')} pct60={row.get('upside_percentile_60s')} dir60_in_row={('direction_60s' in row)}")
