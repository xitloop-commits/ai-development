# T50 B.1 — Replay profiling report

- Profile target: `2026-04-27` / `naturalgas`
- Event limit: 1,500,000 events
- Profile sandbox: `C:\Users\Admin\ai-development\ai-development\data\profile_run\features` (separate from production)
- Profiler: cProfile, single-process serial (`workers=1`)

## Top 30 by **cumulative** time (includes time spent in callees)

```
         1062937873 function calls (1062720563 primitive calls) in 1564.249 seconds

   Ordered by: cumulative time
   List reduced from 3332 to 30 due to restriction <30>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
        1    0.000    0.000 1565.850 1565.850 threading.py:337(wait)
     10/9    4.683    0.468 1534.950  170.550 {method 'acquire' of '_thread.lock' objects}
  1500000    2.710    0.000 1344.087    0.001 replay_adapter.py:389(process_event)
     2245   16.576    0.007  958.504    0.427 targets_cache.py:124(compute_pending_targets_batched)
  1500000    0.985    0.000  926.158    0.001 replay_adapter.py:1157(_flush_pending)
  1471427   20.201    0.000  709.589    0.000 replay_adapter.py:672(_handle_option)
    25830    1.383    0.000  543.216    0.021 replay_adapter.py:739(_handle_underlying)
     2187  270.093    0.123  457.578    0.209 targets_cache.py:57(extract_strike_history_df)
   350290    1.106    0.000  372.199    0.001 deprecation.py:84(wrapper)
   350290    2.870    0.000  371.092    0.001 opt_flags.py:327(wrapper)
   350290    2.412    0.000  366.771    0.001 frame.py:2404(collect)
   350290  360.640    0.001  360.640    0.001 {method 'collect' of 'builtins.PyLazyFrame' objects}
    25830   12.536    0.000  347.857    0.013 replay_adapter.py:864(_compute_row)
     2245   11.973    0.005  262.602    0.117 targets_columnar.py:49(compute_targets_batch_per_strike)
    25830    1.480    0.000  172.573    0.007 feature_pipeline.py:290(compute_pipeline_features)
     6622    0.036    0.000  161.292    0.024 frame.py:378(__init__)
     6622    0.037    0.000  161.247    0.024 dataframe.py:443(sequence_to_pydf)
     6622    0.055    0.000  161.126    0.024 functools.py:978(wrapper)
     6622    0.042    0.000  161.025    0.024 dataframe.py:692(_sequence_of_dict_to_pydf)
     6622  160.937    0.024  160.937    0.024 {built-in method from_dicts}
     4435    0.033    0.000  152.505    0.034 general.py:119(from_dicts)
134712/67356    0.656    0.000  138.522    0.002 deprecation.py:123(wrapper)
    67356    0.797    0.000  138.110    0.002 frame.py:8206(join)
        1    0.254    0.254  113.927  113.927 replay_adapter.py:428(flush_all)
     2245    2.614    0.001  103.976    0.046 trend_swing_targets_columnar.py:50(compute_trend_swing_targets_batch)
     2743    0.072    0.000   87.844    0.032 replay_adapter.py:635(_handle_chain)
     2245    2.552    0.001   84.328    0.038 targets_columnar.py:253(compute_targets_batch_spot)
    33685    0.370    0.000   70.676    0.002 frame.py:5350(filter)
  1500001    0.955    0.000   63.417    0.000 profile_replay_date.py:50(limited)
    33679    0.610    0.000   62.557    0.002 frame.py:6034(sort)
```

## Top 30 by **total** time (excludes time spent in callees — pure work in this function)

```
         1062937873 function calls (1062720563 primitive calls) in 1564.249 seconds

   Ordered by: internal time
   List reduced from 3332 to 30 due to restriction <30>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
   350290  360.640    0.001  360.640    0.001 {method 'collect' of 'builtins.PyLazyFrame' objects}
     2187  270.093    0.123  457.578    0.209 targets_cache.py:57(extract_strike_history_df)
     6622  160.937    0.024  160.937    0.024 {built-in method from_dicts}
    90205   49.948    0.001   50.436    0.001 {built-in method builtins.sorted}
254088718   44.607    0.000   44.607    0.000 {method 'append' of 'list' objects}
  1530737   42.016    0.000   42.016    0.000 decoder.py:351(raw_decode)
153677465   35.711    0.000   35.711    0.000 {method 'get' of 'dict' objects}
     1328   30.948    0.023   41.999    0.032 targets.py:143(compute_targets)
    25830   26.109    0.001   49.711    0.002 dealer_hedging_columnar.py:94(compute_dealer_hedging_features_vec)
  1471427   20.201    0.000  709.589    0.000 replay_adapter.py:672(_handle_option)
     2187   18.751    0.009   27.571    0.013 targets_cache.py:84(extract_spot_history_df)
  1471427   18.231    0.000   23.998    0.000 option_buffer.py:58(depth_levels_to_kwargs)
 89012539   17.287    0.000   19.669    0.000 {built-in method builtins.isinstance}
    25830   16.875    0.001   34.832    0.001 chain.py:305(compute_oi_change_deltas)
     2245   16.576    0.007  958.504    0.427 targets_cache.py:124(compute_pending_targets_batched)
115461504   16.015    0.000   16.015    0.000 {built-in method math.isfinite}
    25818   14.261    0.001   23.447    0.001 active_features.py:112(compute_side_strengths)
    25830   12.536    0.000  347.857    0.013 replay_adapter.py:864(_compute_row)
     2245   11.973    0.005  262.602    0.117 targets_columnar.py:49(compute_targets_batch_per_strike)
    25830   11.888    0.000   24.165    0.001 chain.py:179(compute_pcr_slope)
    50741   11.428    0.000   17.920    0.000 active_features.py:419(_c7_center_of_mass)
 14426433   11.156    0.000   22.403    0.000 {built-in method builtins.max}
 21131842    9.077    0.000   11.797    0.000 chain.py:292(_safe_finite)
   361620    8.535    0.000   13.108    0.000 multi_tf.py:59(_clean_closes)
 56889305    8.077    0.000    8.077    0.000 {built-in method math.isnan}
    25830    7.647    0.000   30.515    0.001 active_features.py:460(compute_strike_rotation_features)
    25830    7.214    0.000   12.331    0.000 emitter.py:784(assemble_flat_vector)
    25830    7.115    0.000   11.167    0.000 max_pain_cache.py:158(cached)
 32979686    6.913    0.000    6.913    0.000 trend_swing_targets.py:265(<genexpr>)
       25    6.743    0.270    9.215    0.369 emitter.py:1578(write_parquet)
```

## Interpretation guide

- **cumulative** shows where time accrues including recursion / nested calls — useful for finding the headline hot orchestration paths.
- **tottime** isolates the actual per-function work — that's what columnar conversion replaces with vectorised Polars expressions.
- Compare the top-30 against the pre-B.1 conversion guess (`realized_vol`, `compression`, OI-weighted levels, `exhaustion`, `ofi`). Any tracker that ranks higher than these and isn't on the list is a candidate to swap in.
