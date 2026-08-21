# T50 B.1 — Replay profiling report

- Profile target: `2026-04-27` / `naturalgas`
- Event limit: 200,000 events
- Profile sandbox: `C:\Users\Admin\ai-development\ai-development\data\profile_run\features` (separate from production)
- Profiler: cProfile, single-process serial (`workers=1`)

## Top 30 by **cumulative** time (includes time spent in callees)

```
         95347266 function calls (95305872 primitive calls) in 104.126 seconds

   Ordered by: cumulative time
   List reduced from 3314 to 30 due to restriction <30>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
        1    0.000    0.000  104.310  104.310 threading.py:337(wait)
     10/9    0.594    0.059   73.783    8.198 {method 'acquire' of '_thread.lock' objects}
   200000    0.351    0.000   45.399    0.000 replay_adapter.py:389(process_event)
     3997    0.185    0.000   36.864    0.009 replay_adapter.py:739(_handle_underlying)
     3997    0.597    0.000   36.279    0.009 replay_adapter.py:864(_compute_row)
     3997    0.201    0.000   19.174    0.005 feature_pipeline.py:290(compute_pipeline_features)
        1    0.062    0.062   17.964   17.964 replay_adapter.py:428(flush_all)
       20    0.341    0.017   16.056    0.803 targets_cache.py:124(compute_pending_targets_batched)
        1    0.000    0.000   14.838   14.838 max_pain_cache.py:539(install_side_strengths)
        1    1.694    1.694   14.838   14.838 max_pain_cache.py:473(_build_side_strengths_cache)
   230737    0.323    0.000   14.801    0.000 __init__.py:304(loads)
   230737    0.543    0.000   14.364    0.000 decoder.py:340(decode)
     3190    0.012    0.000   14.100    0.004 deprecation.py:84(wrapper)
     3190    0.032    0.000   14.089    0.004 opt_flags.py:327(wrapper)
     3190    0.026    0.000   14.042    0.004 frame.py:2404(collect)
     3190   13.974    0.004   13.974    0.004 {method 'collect' of 'builtins.PyLazyFrame' objects}
   230737   13.369    0.000   13.369    0.000 decoder.py:351(raw_decode)
       20    0.520    0.026   10.128    0.506 targets_columnar.py:49(compute_targets_batch_per_strike)
        1    2.873    2.873    9.244    9.244 max_pain_cache.py:420(_load_chain_snapshots_with_volumes)
   200001    0.123    0.000    8.319    0.000 profile_replay_date.py:50(limited)
     3997    4.232    0.001    8.288    0.002 dealer_hedging_columnar.py:94(compute_dealer_hedging_features_vec)
   200002    0.303    0.000    8.195    0.000 stream_merger.py:146(merge_streams)
        1    0.073    0.073    7.916    7.916 max_pain_cache.py:219(install)
        1    0.448    0.448    7.844    7.844 max_pain_cache.py:85(build_cache)
   210412    0.125    0.000    7.781    0.000 {built-in method builtins.next}
   200006    0.892    0.000    7.645    0.000 stream_merger.py:66(_iter_gz)
        1    0.002    0.002    7.572    7.572 max_pain_cache.py:372(install_chain_features)
        1    0.094    0.094    7.570    7.570 max_pain_cache.py:308(_build_chain_feature_caches)
   195714    2.666    0.000    7.442    0.000 replay_adapter.py:672(_handle_option)
        1    0.427    0.427    7.399    7.399 max_pain_cache.py:271(_load_chain_snapshots)
```

## Top 30 by **total** time (excludes time spent in callees — pure work in this function)

```
         95347266 function calls (95305872 primitive calls) in 104.126 seconds

   Ordered by: internal time
   List reduced from 3314 to 30 due to restriction <30>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
     3190   13.974    0.004   13.974    0.004 {method 'collect' of 'builtins.PyLazyFrame' objects}
   230737   13.369    0.000   13.369    0.000 decoder.py:351(raw_decode)
 31377990    6.580    0.000    6.580    0.000 {method 'get' of 'dict' objects}
     3997    4.232    0.001    8.288    0.002 dealer_hedging_columnar.py:94(compute_dealer_hedging_features_vec)
    20486    3.185    0.000    4.912    0.000 max_pain_cache.py:66(_normalize_rows)
       25    2.960    0.118    2.960    0.118 {built-in method from_dicts}
        1    2.873    2.873    9.244    9.244 max_pain_cache.py:420(_load_chain_snapshots_with_volumes)
   195714    2.666    0.000    7.442    0.000 replay_adapter.py:672(_handle_option)
   195714    2.401    0.000    3.158    0.000 option_buffer.py:58(depth_levels_to_kwargs)
     3985    2.135    0.001    3.503    0.001 active_features.py:112(compute_side_strengths)
 11110635    1.952    0.000    2.091    0.000 {built-in method builtins.isinstance}
        1    1.694    1.694   14.838   14.838 max_pain_cache.py:473(_build_side_strengths_cache)
  8456360    1.674    0.000    1.674    0.000 {method 'append' of 'list' objects}
 12064267    1.665    0.000    1.665    0.000 {built-in method math.isfinite}
     7075    1.554    0.000    2.381    0.000 active_features.py:419(_c7_center_of_mass)
    10243    1.315    0.000    1.315    0.000 {method 'gather_with_series' of 'builtins.PyDataFrame' objects}
  1003818    1.287    0.000    1.989    0.000 frame.py:12009(iter_rows)
     3997    1.146    0.000    4.226    0.001 active_features.py:460(compute_strike_rotation_features)
     3997    1.116    0.000    1.869    0.000 emitter.py:784(assemble_flat_vector)
     3997    1.079    0.000    1.688    0.000 max_pain_cache.py:158(cached)
        6    1.052    0.175    1.998    0.333 emitter.py:1578(write_parquet)
    13446    1.006    0.000    1.061    0.000 {built-in method builtins.sorted}
     3997    1.000    0.000    2.059    0.001 chain.py:305(compute_oi_change_deltas)
   200006    0.892    0.000    7.645    0.000 stream_merger.py:66(_iter_gz)
   111467    0.773    0.000    2.173    0.000 _streams.py:66(readinto)
     3997    0.729    0.000    1.565    0.000 chain.py:179(compute_pcr_slope)
   111464    0.665    0.000    0.665    0.000 {method 'decompress' of 'zlib._ZlibDecompressor' objects}
3636113/3614774    0.653    0.000    0.688    0.000 {built-in method builtins.len}
     3997    0.597    0.000   36.279    0.009 replay_adapter.py:864(_compute_row)
     10/9    0.594    0.059   73.783    8.198 {method 'acquire' of '_thread.lock' objects}
```

## Interpretation guide

- **cumulative** shows where time accrues including recursion / nested calls — useful for finding the headline hot orchestration paths.
- **tottime** isolates the actual per-function work — that's what columnar conversion replaces with vectorised Polars expressions.
- Compare the top-30 against the pre-B.1 conversion guess (`realized_vol`, `compression`, OI-weighted levels, `exhaustion`, `ofi`). Any tracker that ranks higher than these and isn't on the list is a candidate to swap in.
