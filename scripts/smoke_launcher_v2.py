import sys
sys.path.insert(0, "startup")

import launcher_v2 as L

print()
for inst in L._INSTRUMENTS:
    avail = L.scan_feature_days(inst)
    info = L.last_model_info(inst)
    trained = set(info.trained_dates)
    n_done = sum(1 for d in avail if d in trained)
    print(f"{inst:11s} parquets={len(avail):2d}  model={info.version or 'none':24s}  trained_in_model={n_done}/{len(avail)}")
print()
print("Walk-forward (D-1, D-2):", L.compute_walk_forward_dates())
print()
print("Running processes:")
for p in L.running_processes():
    print(f"  {p.kind:6s} {p.instrument:10s} pid={p.pid}  rss={p.rss_mb} MB")
