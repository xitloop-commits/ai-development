# T50 B.1 — Replay profiling report

- Profile target: `2026-05-22` / `nifty50`
- Event limit: 500,000 events
- Profile sandbox: `C:\Users\Admin\ai-development\ai-development\data\profile_run\features` (separate from production)
- Profiler: cProfile, single-process serial (`workers=1`)

## Top 30 by **cumulative** time (includes time spent in callees)

```
         279836085 function calls (279808565 primitive calls) in 201.508 seconds

   Ordered by: cumulative time
   List reduced from 2578 to 30 due to restriction <30>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
        1    0.004    0.004  201.886  201.886 replay_runner.py:754(replay)
        1    1.529    1.529  201.872  201.872 replay_runner.py:192(run_one_date)
   500000    0.661    0.000  116.161    0.000 replay_adapter.py:335(process_event)
     3306    0.113    0.000  106.728    0.032 replay_adapter.py:497(_handle_underlying)
     3306    0.591    0.000  106.299    0.032 replay_adapter.py:619(_compute_row)
     3306    0.216    0.000   76.536    0.023 feature_pipeline.py:290(compute_pipeline_features)
        1    0.071    0.071   59.947   59.947 replay_adapter.py:374(flush_all)
     3306   31.005    0.009   45.357    0.014 targets.py:143(compute_targets)
     3306   34.806    0.011   37.261    0.011 levels.py:143(compute_max_pain_features)
   500001    0.271    0.000   21.032    0.000 profile_replay_date.py:50(limited)
   500002    0.733    0.000   20.760    0.000 stream_merger.py:101(merge_streams)
500064/500061    0.263    0.000   19.693    0.000 {built-in method builtins.next}
   500008    1.878    0.000   19.428    0.000 stream_merger.py:66(_iter_gz)
     3306    4.168    0.001   19.173    0.006 dealer_hedging.py:129(compute_dealer_hedging_features)
     6554    9.957    0.002   16.279    0.002 active_features.py:112(compute_side_strengths)
     3306    2.698    0.001   14.431    0.004 trend_swing_targets.py:154(compute_targets)
   500009    0.643    0.000   14.349    0.000 __init__.py:304(loads)
   500009    1.116    0.000   13.473    0.000 decoder.py:340(decode)
  7876518    6.622    0.000   12.068    0.000 {built-in method builtins.max}
   500009   11.465    0.000   11.465    0.000 decoder.py:351(raw_decode)
  1795796    1.992    0.000   11.140    0.000 dealer_hedging.py:108(_per_strike_greeks)
 44388714    9.599    0.000    9.599    0.000 {method 'get' of 'dict' objects}
     3306    2.462    0.001    9.526    0.003 active_features.py:460(compute_strike_rotation_features)
 69682127    9.498    0.000    9.498    0.000 {built-in method math.isnan}
     3306    0.319    0.000    8.835    0.003 active_features.py:252(compute_active_features)
     3306    0.073    0.000    8.113    0.002 zone.py:33(compute_zone_features)
   491031    4.037    0.000    7.700    0.000 replay_adapter.py:438(_handle_option)
  1149871    3.103    0.000    7.548    0.000 greeks.py:71(bs_greeks)
   332708    3.989    0.000    6.362    0.000 {built-in method builtins.min}
     6195    3.789    0.001    5.712    0.001 active_features.py:419(_c7_center_of_mass)
```

## Top 30 by **total** time (excludes time spent in callees — pure work in this function)

```
         279836085 function calls (279808565 primitive calls) in 201.508 seconds

   Ordered by: internal time
   List reduced from 2578 to 30 due to restriction <30>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
     3306   34.806    0.011   37.261    0.011 levels.py:143(compute_max_pain_features)
     3306   31.005    0.009   45.357    0.014 targets.py:143(compute_targets)
   500009   11.465    0.000   11.465    0.000 decoder.py:351(raw_decode)
     6554    9.957    0.002   16.279    0.002 active_features.py:112(compute_side_strengths)
 44388714    9.599    0.000    9.599    0.000 {method 'get' of 'dict' objects}
 69682127    9.498    0.000    9.498    0.000 {built-in method math.isnan}
  7876518    6.622    0.000   12.068    0.000 {built-in method builtins.max}
     3306    4.168    0.001   19.173    0.006 dealer_hedging.py:129(compute_dealer_hedging_features)
   491031    4.037    0.000    7.700    0.000 replay_adapter.py:438(_handle_option)
   332708    3.989    0.000    6.362    0.000 {built-in method builtins.min}
     6195    3.789    0.001    5.712    0.001 active_features.py:419(_c7_center_of_mass)
 26125405    3.691    0.000    3.691    0.000 {built-in method math.isfinite}
  1149871    3.103    0.000    7.548    0.000 greeks.py:71(bs_greeks)
 18659020    2.743    0.000    2.743    0.000 trend_swing_targets.py:250(<genexpr>)
     3306    2.698    0.001   14.431    0.004 trend_swing_targets.py:154(compute_targets)
 13120391    2.628    0.000    2.628    0.000 {method 'append' of 'list' objects}
    10525    2.484    0.000    2.568    0.000 {built-in method builtins.sorted}
     3306    2.462    0.001    9.526    0.003 active_features.py:460(compute_strike_rotation_features)
     3306    2.452    0.001    3.816    0.001 chain.py:130(compute_oi_weighted_levels)
 18659020    2.373    0.000    2.373    0.000 trend_swing_targets.py:251(<genexpr>)
  1795796    1.992    0.000   11.140    0.000 dealer_hedging.py:108(_per_strike_greeks)
   500008    1.878    0.000   19.428    0.000 stream_merger.py:66(_iter_gz)
  2934600    1.863    0.000    2.982    0.000 greeks.py:58(_norm_cdf)
     3306    1.644    0.000    2.588    0.001 chain.py:242(compute_wall_strength)
  9327816    1.553    0.000    1.639    0.000 {built-in method builtins.isinstance}
  9978792    1.539    0.000    1.539    0.000 {built-in method builtins.abs}
        1    1.529    1.529  201.872  201.872 replay_runner.py:192(run_one_date)
    71590    1.353    0.000    1.353    0.000 {method 'decompress' of 'zlib._ZlibDecompressor' objects}
  3410946    1.145    0.000    1.585    0.000 targets.py:296(<genexpr>)
   500009    1.116    0.000   13.473    0.000 decoder.py:340(decode)
```

## Interpretation guide

- **cumulative** shows where time accrues including recursion / nested calls — useful for finding the headline hot orchestration paths.
- **tottime** isolates the actual per-function work — that's what columnar conversion replaces with vectorised Polars expressions.
- Compare the top-30 against the pre-B.1 conversion guess (`realized_vol`, `compression`, OI-weighted levels, `exhaustion`, `ofi`). Any tracker that ranks higher than these and isn't on the list is a candidate to swap in.
