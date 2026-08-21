# T50 B.1 — Replay profiling report

- Profile target: `2026-04-27` / `naturalgas`
- Event limit: 1,000,000 events
- Profile sandbox: `C:\Users\Admin\ai-development\ai-development\data\profile_run\features` (separate from production)
- Profiler: cProfile, single-process serial (`workers=1`)

## Top 30 by **cumulative** time (includes time spent in callees)

```
         445273750 function calls (445157698 primitive calls) in 530.512 seconds

   Ordered by: cumulative time
   List reduced from 3324 to 30 due to restriction <30>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
        2    0.070    0.035  531.614  265.807 threading.py:337(wait)
    13/12    3.097    0.238  500.552   41.713 {method 'acquire' of '_thread.lock' objects}
  1000000    1.806    0.000  335.055    0.000 replay_adapter.py:402(process_event)
    18532    0.940    0.000  229.461    0.012 replay_adapter.py:752(_handle_underlying)
    18532    6.950    0.000  226.511    0.012 replay_adapter.py:877(_compute_row)
       86    1.776    0.021  168.014    1.954 targets_cache.py:124(compute_pending_targets_batched)
    13486    0.051    0.000  146.234    0.011 deprecation.py:84(wrapper)
    13486    0.133    0.000  146.183    0.011 opt_flags.py:327(wrapper)
    13486    0.112    0.000  145.987    0.011 frame.py:2404(collect)
    13486  145.699    0.011  145.699    0.011 {method 'collect' of 'builtins.PyLazyFrame' objects}
    18532    1.032    0.000  116.396    0.006 feature_pipeline.py:290(compute_pipeline_features)
        1    0.203    0.203  115.431  115.431 replay_adapter.py:441(flush_all)
       86    7.027    0.082  105.167    1.223 targets_columnar.py:49(compute_targets_batch_per_strike)
   979606   13.419    0.000   96.400    0.000 replay_adapter.py:685(_handle_option)
5172/2586    0.030    0.000   67.554    0.026 deprecation.py:123(wrapper)
     2586    0.036    0.000   67.535    0.026 frame.py:8206(join)
  1000000    0.847    0.000   61.997    0.000 replay_adapter.py:1170(_flush_pending)
     1300    0.020    0.000   48.592    0.037 frame.py:5350(filter)
  1000001    0.634    0.000   42.292    0.000 profile_replay_date.py:50(limited)
  1000002    1.531    0.000   41.658    0.000 stream_merger.py:146(merge_streams)
1010523/1010522    0.604    0.000   39.492    0.000 {built-in method builtins.next}
  1000006    4.506    0.000   38.877    0.000 stream_merger.py:66(_iter_gz)
  1030737    1.450    0.000   37.436    0.000 __init__.py:304(loads)
    18532   18.771    0.001   35.733    0.002 dealer_hedging_columnar.py:94(compute_dealer_hedging_features_vec)
  1030737    2.421    0.000   35.487    0.000 decoder.py:340(decode)
  1030737   31.065    0.000   31.065    0.000 decoder.py:351(raw_decode)
       86    0.763    0.009   30.961    0.360 trend_swing_targets_columnar.py:50(compute_trend_swing_targets_batch)
    37052    0.449    0.000   26.065    0.001 time_to_move.py:77(compute)
    64344   25.641    0.000   25.974    0.000 {built-in method builtins.sorted}
110424697   25.053    0.000   25.053    0.000 {method 'get' of 'dict' objects}
```

## Top 30 by **total** time (excludes time spent in callees — pure work in this function)

```
         445273750 function calls (445157698 primitive calls) in 530.512 seconds

   Ordered by: internal time
   List reduced from 3324 to 30 due to restriction <30>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
    13486  145.699    0.011  145.699    0.011 {method 'collect' of 'builtins.PyLazyFrame' objects}
  1030737   31.065    0.000   31.065    0.000 decoder.py:351(raw_decode)
    64344   25.641    0.000   25.974    0.000 {built-in method builtins.sorted}
110424697   25.053    0.000   25.053    0.000 {method 'get' of 'dict' objects}
    18532   18.771    0.001   35.733    0.002 dealer_hedging_columnar.py:94(compute_dealer_hedging_features_vec)
   979606   13.419    0.000   96.400    0.000 replay_adapter.py:685(_handle_option)
   979606   11.954    0.000   15.737    0.000 option_buffer.py:58(depth_levels_to_kwargs)
    18532   11.132    0.001   22.894    0.001 chain.py:305(compute_oi_change_deltas)
 76983559   10.509    0.000   10.509    0.000 {built-in method math.isfinite}
    18520   10.133    0.001   16.661    0.001 active_features.py:112(compute_side_strengths)
 51204733    8.860    0.000    9.451    0.000 {built-in method builtins.isinstance}
 41960417    8.207    0.000    8.207    0.000 {method 'append' of 'list' objects}
    36145    8.051    0.000   12.554    0.000 active_features.py:419(_c7_center_of_mass)
    18532    8.004    0.000   16.403    0.001 chain.py:179(compute_pcr_slope)
       86    7.027    0.082  105.167    1.223 targets_columnar.py:49(compute_targets_batch_per_strike)
    18532    6.950    0.000  226.511    0.012 replay_adapter.py:877(_compute_row)
 14186502    5.903    0.000    7.697    0.000 chain.py:292(_safe_finite)
    18532    5.468    0.000   21.468    0.001 active_features.py:460(compute_strike_rotation_features)
    18532    5.184    0.000    8.809    0.000 emitter.py:784(assemble_flat_vector)
      135    5.040    0.037    5.040    0.037 {built-in method from_dicts}
    18532    5.039    0.000    7.897    0.000 max_pain_cache.py:158(cached)
   259448    4.826    0.000    7.454    0.000 multi_tf.py:59(_clean_closes)
  1000006    4.506    0.000   38.877    0.000 stream_merger.py:66(_iter_gz)
       22    4.456    0.203    6.376    0.290 emitter.py:1578(write_parquet)
23483271/23389257    3.902    0.000    3.983    0.000 {built-in method builtins.len}
  1012573    3.328    0.000    9.783    0.000 {built-in method builtins.sum}
       23    3.182    0.138    5.368    0.233 targets_cache.py:57(extract_strike_history_df)
    20486    3.133    0.000    4.860    0.000 max_pain_cache.py:66(_normalize_rows)
    13/12    3.097    0.238  500.552   41.713 {method 'acquire' of '_thread.lock' objects}
  9551191    2.889    0.000    5.139    0.000 {built-in method builtins.max}
```

## Interpretation guide

- **cumulative** shows where time accrues including recursion / nested calls — useful for finding the headline hot orchestration paths.
- **tottime** isolates the actual per-function work — that's what columnar conversion replaces with vectorised Polars expressions.
- Compare the top-30 against the pre-B.1 conversion guess (`realized_vol`, `compression`, OI-weighted levels, `exhaustion`, `ofi`). Any tracker that ranks higher than these and isn't on the list is a candidate to swap in.
