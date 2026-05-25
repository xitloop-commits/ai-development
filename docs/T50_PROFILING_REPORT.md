# T50 B.1 — Replay profiling report

- Profile target: `2026-04-28` / `nifty50`
- Event limit: 500,000 events
- Profile sandbox: `C:\Users\Admin\ai-development\ai-development\data\profile_run\features` (separate from production)
- Profiler: cProfile, single-process serial (`workers=1`)

## Top 30 by **cumulative** time (includes time spent in callees)

```
         250081384 function calls (250055981 primitive calls) in 182.220 seconds

   Ordered by: cumulative time
   List reduced from 2577 to 30 due to restriction <30>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
        1    0.006    0.006  182.697  182.697 replay_runner.py:754(replay)
        1    1.564    1.564  182.689  182.689 replay_runner.py:192(run_one_date)
   500000    0.649    0.000  106.711    0.000 replay_adapter.py:335(process_event)
     2881    0.105    0.000   94.850    0.033 replay_adapter.py:497(_handle_underlying)
     2881    0.511    0.000   94.464    0.033 replay_adapter.py:619(_compute_row)
     2881    0.186    0.000   68.555    0.024 feature_pipeline.py:290(compute_pipeline_features)
        1    0.059    0.059   49.785   49.785 replay_adapter.py:374(flush_all)
     2881   26.239    0.009   38.591    0.013 targets.py:143(compute_targets)
     2881   32.742    0.011   34.954    0.012 levels.py:143(compute_max_pain_features)
   500001    0.277    0.000   21.653    0.000 profile_replay_date.py:50(limited)
   500002    0.741    0.000   21.376    0.000 stream_merger.py:101(merge_streams)
500063/500060    0.265    0.000   20.336    0.000 {built-in method builtins.next}
   500006    1.928    0.000   20.070    0.000 stream_merger.py:66(_iter_gz)
   500008    0.639    0.000   14.792    0.000 __init__.py:304(loads)
     5746    8.962    0.002   14.650    0.003 active_features.py:112(compute_side_strengths)
     2881    3.537    0.001   14.154    0.005 dealer_hedging.py:129(compute_dealer_hedging_features)
   500008    1.112    0.000   13.924    0.000 decoder.py:340(decode)
   500008   11.925    0.000   11.925    0.000 decoder.py:351(raw_decode)
     2881    1.990    0.001   11.067    0.004 trend_swing_targets.py:154(compute_targets)
  7239183    5.518    0.000    9.940    0.000 {built-in method builtins.max}
 43248609    9.177    0.000    9.177    0.000 {method 'get' of 'dict' objects}
     2881    2.276    0.001    8.724    0.003 active_features.py:460(compute_strike_rotation_features)
 60488976    8.141    0.000    8.141    0.000 {built-in method math.isnan}
     2881    0.323    0.000    8.074    0.003 active_features.py:252(compute_active_features)
   496596    4.066    0.000    7.741    0.000 replay_adapter.py:438(_handle_option)
  1626118    1.431    0.000    7.376    0.000 dealer_hedging.py:108(_per_strike_greeks)
     2881    0.064    0.000    7.296    0.003 zone.py:33(compute_zone_features)
     5385    3.402    0.001    5.134    0.001 active_features.py:419(_c7_center_of_mass)
   297287    3.182    0.000    5.041    0.000 {built-in method builtins.min}
   706718    1.887    0.000    4.659    0.000 greeks.py:71(bs_greeks)
```

## Top 30 by **total** time (excludes time spent in callees — pure work in this function)

```
         250081384 function calls (250055981 primitive calls) in 182.220 seconds

   Ordered by: internal time
   List reduced from 2577 to 30 due to restriction <30>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
     2881   32.742    0.011   34.954    0.012 levels.py:143(compute_max_pain_features)
     2881   26.239    0.009   38.591    0.013 targets.py:143(compute_targets)
   500008   11.925    0.000   11.925    0.000 decoder.py:351(raw_decode)
 43248609    9.177    0.000    9.177    0.000 {method 'get' of 'dict' objects}
     5746    8.962    0.002   14.650    0.003 active_features.py:112(compute_side_strengths)
 60488976    8.141    0.000    8.141    0.000 {built-in method math.isnan}
  7239183    5.518    0.000    9.940    0.000 {built-in method builtins.max}
   496596    4.066    0.000    7.741    0.000 replay_adapter.py:438(_handle_option)
     2881    3.537    0.001   14.154    0.005 dealer_hedging.py:129(compute_dealer_hedging_features)
     5385    3.402    0.001    5.134    0.001 active_features.py:419(_c7_center_of_mass)
 23334991    3.267    0.000    3.267    0.000 {built-in method math.isfinite}
   297287    3.182    0.000    5.041    0.000 {built-in method builtins.min}
 12801791    2.481    0.000    2.481    0.000 {method 'append' of 'list' objects}
     2881    2.276    0.001    8.724    0.003 active_features.py:460(compute_strike_rotation_features)
     2881    2.207    0.001    3.436    0.001 chain.py:130(compute_oi_weighted_levels)
 14708800    2.054    0.000    2.054    0.000 trend_swing_targets.py:250(<genexpr>)
     2881    1.990    0.001   11.067    0.004 trend_swing_targets.py:154(compute_targets)
   500006    1.928    0.000   20.070    0.000 stream_merger.py:66(_iter_gz)
   706718    1.887    0.000    4.659    0.000 greeks.py:71(bs_greeks)
 14708800    1.859    0.000    1.859    0.000 trend_swing_targets.py:251(<genexpr>)
    10364    1.667    0.000    1.928    0.000 {built-in method builtins.sorted}
  9477041    1.569    0.000    1.644    0.000 {built-in method builtins.isinstance}
        1    1.564    1.564  182.689  182.689 replay_runner.py:192(run_one_date)
     2881    1.490    0.001    2.346    0.001 chain.py:242(compute_wall_strength)
  1626118    1.431    0.000    7.376    0.000 dealer_hedging.py:108(_per_strike_greeks)
  9176968    1.407    0.000    1.407    0.000 {built-in method builtins.abs}
    76066    1.395    0.000    1.395    0.000 {method 'decompress' of 'zlib._ZlibDecompressor' objects}
  1789566    1.150    0.000    1.847    0.000 greeks.py:58(_norm_cdf)
   500008    1.112    0.000   13.924    0.000 decoder.py:340(decode)
     2881    0.999    0.000    2.070    0.001 chain.py:305(compute_oi_change_deltas)
```

## Interpretation guide

- **cumulative** shows where time accrues including recursion / nested calls — useful for finding the headline hot orchestration paths.
- **tottime** isolates the actual per-function work — that's what columnar conversion replaces with vectorised Polars expressions.
- Compare the top-30 against the pre-B.1 conversion guess (`realized_vol`, `compression`, OI-weighted levels, `exhaustion`, `ofi`). Any tracker that ranks higher than these and isn't on the list is a candidate to swap in.
