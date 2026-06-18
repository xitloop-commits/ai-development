# T50 B.1 — Replay profiling report

- Profile target: `2026-04-22` / `crudeoil`
- Event limit: 500,000 events
- Profile sandbox: `C:\Users\Admin\ai-development\ai-development\data\profile_run\features` (separate from production)
- Profiler: cProfile, single-process serial (`workers=1`)

## Top 30 by **cumulative** time (includes time spent in callees)

```
         183045667 function calls (182999655 primitive calls) in 195.013 seconds

   Ordered by: cumulative time
   List reduced from 3297 to 30 due to restriction <30>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
        1    0.001    0.001  195.405  195.405 threading.py:337(wait)
     10/9    1.523    0.152  152.595   16.955 {method 'acquire' of '_thread.lock' objects}
   500000    0.884    0.000   96.202    0.000 replay_adapter.py:377(process_event)
     4980    0.251    0.000   74.920    0.015 replay_adapter.py:712(_handle_underlying)
     4980    1.034    0.000   74.113    0.015 replay_adapter.py:834(_compute_row)
     4980    0.357    0.000   42.988    0.009 feature_pipeline.py:290(compute_pipeline_features)
        1    0.052    0.052   32.428   32.428 replay_adapter.py:416(flush_all)
       10    0.505    0.051   31.018    3.102 targets_cache.py:124(compute_pending_targets_batched)
     1580    0.007    0.000   28.270    0.018 deprecation.py:84(wrapper)
     1580    0.018    0.000   28.263    0.018 opt_flags.py:327(wrapper)
     1580    0.015    0.000   28.236    0.018 frame.py:2404(collect)
     1580   28.198    0.018   28.198    0.018 {method 'collect' of 'builtins.PyLazyFrame' objects}
   517546    0.702    0.000   27.555    0.000 __init__.py:304(loads)
   517546    1.214    0.000   26.601    0.000 decoder.py:340(decode)
   517546   24.360    0.000   24.360    0.000 decoder.py:351(raw_decode)
       10    1.366    0.137   23.216    2.322 targets_columnar.py:49(compute_targets_batch_per_strike)
     4980   11.059    0.002   22.252    0.004 dealer_hedging_columnar.py:94(compute_dealer_hedging_features_vec)
   500001    0.315    0.000   19.538    0.000 profile_replay_date.py:50(limited)
   494874    7.005    0.000   19.432    0.000 replay_adapter.py:645(_handle_option)
        1    0.004    0.004   19.259   19.259 max_pain_cache.py:539(install_side_strengths)
        1    2.193    2.193   19.255   19.255 max_pain_cache.py:473(_build_side_strengths_cache)
   500002    0.784    0.000   19.223    0.000 stream_merger.py:101(merge_streams)
   506004    0.293    0.000   18.108    0.000 {built-in method builtins.next}
   500006    2.015    0.000   17.807    0.000 stream_merger.py:66(_iter_gz)
 64587675   14.052    0.000   14.052    0.000 {method 'get' of 'dict' objects}
        1    4.015    4.015   13.571   13.571 max_pain_cache.py:420(_load_chain_snapshots_with_volumes)
        1    0.107    0.107   11.687   11.687 max_pain_cache.py:219(install)
        1    0.659    0.659   11.580   11.580 max_pain_cache.py:85(build_cache)
     4980    3.144    0.001   11.157    0.002 active_features.py:460(compute_strike_rotation_features)
        1    0.002    0.002   11.095   11.095 max_pain_cache.py:372(install_chain_features)
```

## Top 30 by **total** time (excludes time spent in callees — pure work in this function)

```
         183045667 function calls (182999655 primitive calls) in 195.013 seconds

   Ordered by: internal time
   List reduced from 3297 to 30 due to restriction <30>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
     1580   28.198    0.018   28.198    0.018 {method 'collect' of 'builtins.PyLazyFrame' objects}
   517546   24.360    0.000   24.360    0.000 decoder.py:351(raw_decode)
 64587675   14.052    0.000   14.052    0.000 {method 'get' of 'dict' objects}
     4980   11.059    0.002   22.252    0.004 dealer_hedging_columnar.py:94(compute_dealer_hedging_features_vec)
   494874    7.005    0.000   19.432    0.000 replay_adapter.py:645(_handle_option)
   494874    6.232    0.000    8.213    0.000 option_buffer.py:58(depth_levels_to_kwargs)
     4961    6.214    0.001   10.178    0.002 active_features.py:112(compute_side_strengths)
    11692    4.311    0.000    6.643    0.001 max_pain_cache.py:66(_normalize_rows)
     7857    4.060    0.001    6.168    0.001 active_features.py:419(_c7_center_of_mass)
        1    4.015    4.015   13.571   13.571 max_pain_cache.py:420(_load_chain_snapshots_with_volumes)
       15    3.887    0.259    3.887    0.259 {built-in method from_dicts}
 26495180    3.814    0.000    3.814    0.000 {built-in method math.isfinite}
 20958498    3.673    0.000    3.829    0.000 {built-in method builtins.isinstance}
 15980221    3.213    0.000    3.213    0.000 {method 'append' of 'list' objects}
     4980    3.144    0.001   11.157    0.002 active_features.py:460(compute_strike_rotation_features)
     4980    3.130    0.001    4.966    0.001 max_pain_cache.py:158(cached)
       80    3.018    0.038    3.018    0.038 {built-in method _imp.create_dynamic}
   181322    2.657    0.000    2.657    0.000 {method 'decompress' of 'zlib._ZlibDecompressor' objects}
        1    2.193    2.193   19.255   19.255 max_pain_cache.py:473(_build_side_strengths_cache)
    15482    2.084    0.000    2.137    0.000 {built-in method builtins.sorted}
   500006    2.015    0.000   17.807    0.000 stream_merger.py:66(_iter_gz)
  1297816    1.575    0.000    2.239    0.000 frame.py:12009(iter_rows)
     10/9    1.523    0.152  152.595   16.955 {method 'acquire' of '_thread.lock' objects}
  4780695    1.499    0.000    2.868    0.000 {built-in method builtins.max}
     4980    1.411    0.000    2.401    0.000 emitter.py:751(assemble_flat_vector)
       10    1.366    0.137   23.216    2.322 targets_columnar.py:49(compute_targets_batch_per_strike)
     4980    1.342    0.000    2.703    0.001 regime.py:277(update)
   517546    1.214    0.000   26.601    0.000 decoder.py:340(decode)
  2153074    1.175    0.000    1.484    0.000 dealer_hedging_columnar.py:46(_safe_oi)
  2153074    1.172    0.000    1.476    0.000 dealer_hedging_columnar.py:58(_safe_iv_pct)
```

## Interpretation guide

- **cumulative** shows where time accrues including recursion / nested calls — useful for finding the headline hot orchestration paths.
- **tottime** isolates the actual per-function work — that's what columnar conversion replaces with vectorised Polars expressions.
- Compare the top-30 against the pre-B.1 conversion guess (`realized_vol`, `compression`, OI-weighted levels, `exhaustion`, `ofi`). Any tracker that ranks higher than these and isn't on the list is a candidate to swap in.
