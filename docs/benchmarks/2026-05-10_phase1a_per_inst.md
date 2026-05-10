# Phase 1A signal-persistence benchmark

Generated: 2026-05-10T23:22:27.928543+05:30

## Configuration
- Days: 2026-04-22, 2026-04-29
- Instruments: nifty50, banknifty, crudeoil, naturalgas
- Modes: current → multi_horizon → multi_horizon_sustained (additive)
- 900s prob threshold: 0.7
- Sustained-N: 10

## 2026-04-22

### nifty50

| Metric | current | multi_horizon | multi_horizon_sustained | wave1_deterministic |
|---|---:|---:|---:|---:|
| count | 274 | 91 | 5 | 5 |
| long_ce_count | 49 | 14 | 0 | 0 |
| long_pe_count | 225 | 77 | 5 | 5 |
| lifetime_p50_sec | 210.5 | 1549.5 | 11035.3 | 8351.8 |
| lifetime_p90_sec | 1654.9 | 3678.0 | 12210.6 | 12210.6 |
| direction_holds_60s_pct | 63.5 | 67.0 | 60.0 | 60.0 |
| direction_holds_300s_pct | 57.7 | 86.8 | 100.0 | 80.0 |
| avg_return_at_60s_pct | 0.95 | 1.14 | 0.28 | 0.37 |
| avg_return_at_300s_pct | 2.75 | 4.41 | 5.01 | 3.13 |
| neither_rate_900s_pct | 25.9 | 14.3 | 20.0 | 40.0 |

### banknifty

| Metric | current | multi_horizon | multi_horizon_sustained | wave1_deterministic |
|---|---:|---:|---:|---:|
| count | 420 | 0 | 0 | 16 |
| long_ce_count | 165 | — | — | 3 |
| long_pe_count | 255 | — | — | 13 |
| lifetime_p50_sec | 36.9 | — | — | 2258.0 |
| lifetime_p90_sec | 237.7 | — | — | 5910.0 |
| direction_holds_60s_pct | 65.5 | — | — | 68.8 |
| direction_holds_300s_pct | 59.8 | — | — | 62.5 |
| avg_return_at_60s_pct | 1.56 | — | — | 0.74 |
| avg_return_at_300s_pct | 3.21 | — | — | 2.37 |
| neither_rate_900s_pct | 5.5 | — | — | 12.5 |

### crudeoil

| Metric | current | multi_horizon | multi_horizon_sustained | wave1_deterministic |
|---|---:|---:|---:|---:|
| count | 273 | 0 | 0 | 51 |
| long_ce_count | 3 | — | — | 0 |
| long_pe_count | 270 | — | — | 51 |
| lifetime_p50_sec | 27735.1 | — | — | 37726.5 |
| lifetime_p90_sec | 38841.5 | — | — | 48205.7 |
| direction_holds_60s_pct | 58.6 | — | — | 56.9 |
| direction_holds_300s_pct | 59.7 | — | — | 66.7 |
| avg_return_at_60s_pct | 0.92 | — | — | 0.56 |
| avg_return_at_300s_pct | 1.76 | — | — | 1.34 |
| neither_rate_900s_pct | 47.6 | — | — | 45.1 |

### naturalgas

| Metric | current | multi_horizon | multi_horizon_sustained | wave1_deterministic |
|---|---:|---:|---:|---:|
| count | 553 | 0 | 0 | 38 |
| long_ce_count | 4 | — | — | 0 |
| long_pe_count | 549 | — | — | 38 |
| lifetime_p50_sec | 28849.7 | — | — | 33607.3 |
| lifetime_p90_sec | 42915.8 | — | — | 50535.4 |
| direction_holds_60s_pct | 67.8 | — | — | 55.3 |
| direction_holds_300s_pct | 62.6 | — | — | 57.9 |
| avg_return_at_60s_pct | 2.9 | — | — | 2.92 |
| avg_return_at_300s_pct | 6.98 | — | — | 5.93 |
| neither_rate_900s_pct | 33.1 | — | — | 18.4 |

## 2026-04-29

### nifty50

| Metric | current | multi_horizon | multi_horizon_sustained | wave1_deterministic |
|---|---:|---:|---:|---:|
| count | 283 | 98 | 1 | 1 |
| long_ce_count | 46 | 0 | 0 | 0 |
| long_pe_count | 237 | 98 | 1 | 1 |
| lifetime_p50_sec | 217.1 | 3693.0 | 2122.1 | 2122.1 |
| lifetime_p90_sec | 1052.2 | 19050.3 | 2122.1 | 2122.1 |
| direction_holds_60s_pct | 65.0 | 52.0 | 0.0 | 0.0 |
| direction_holds_300s_pct | 58.7 | 54.1 | 0.0 | 0.0 |
| avg_return_at_60s_pct | 1.38 | 0.75 | 0.37 | 0.37 |
| avg_return_at_300s_pct | 3.19 | 2.36 | 0.37 | 0.37 |
| neither_rate_900s_pct | 50.5 | 61.2 | 0.0 | 0.0 |

### banknifty

| Metric | current | multi_horizon | multi_horizon_sustained | wave1_deterministic |
|---|---:|---:|---:|---:|
| count | 510 | 0 | 0 | 21 |
| long_ce_count | 234 | — | — | 7 |
| long_pe_count | 276 | — | — | 14 |
| lifetime_p50_sec | 21.6 | — | — | 1396.5 |
| lifetime_p90_sec | 163.9 | — | — | 3586.7 |
| direction_holds_60s_pct | 63.7 | — | — | 66.7 |
| direction_holds_300s_pct | 61.2 | — | — | 76.2 |
| avg_return_at_60s_pct | 1.18 | — | — | 0.8 |
| avg_return_at_300s_pct | 2.33 | — | — | 1.8 |
| neither_rate_900s_pct | 11.2 | — | — | 0.0 |

### crudeoil

| Metric | current | multi_horizon | multi_horizon_sustained | wave1_deterministic |
|---|---:|---:|---:|---:|
| count | 618 | 0 | 0 | 62 |
| long_ce_count | 0 | — | — | 0 |
| long_pe_count | 618 | — | — | 62 |
| lifetime_p50_sec | 26966.7 | — | — | 28851.7 |
| lifetime_p90_sec | 40836.9 | — | — | 40409.3 |
| direction_holds_60s_pct | 47.9 | — | — | 40.3 |
| direction_holds_300s_pct | 42.2 | — | — | 45.2 |
| avg_return_at_60s_pct | 0.62 | — | — | 0.58 |
| avg_return_at_300s_pct | 1.24 | — | — | 0.97 |
| neither_rate_900s_pct | 51.3 | — | — | 54.8 |

### naturalgas

| Metric | current | multi_horizon | multi_horizon_sustained | wave1_deterministic |
|---|---:|---:|---:|---:|
| count | 1021 | 0 | 0 | 78 |
| long_ce_count | 14 | — | — | 0 |
| long_pe_count | 1007 | — | — | 78 |
| lifetime_p50_sec | 3793.6 | — | — | 15945.0 |
| lifetime_p90_sec | 21851.0 | — | — | 35821.3 |
| direction_holds_60s_pct | 70.7 | — | — | 73.1 |
| direction_holds_300s_pct | 60.5 | — | — | 64.1 |
| avg_return_at_60s_pct | 0.7 | — | — | 0.84 |
| avg_return_at_300s_pct | 1.5 | — | — | 1.63 |
| neither_rate_900s_pct | 59.6 | — | — | 46.2 |

## Aggregate (all days × instruments)

| Metric | current | multi_horizon | multi_horizon_sustained | wave1_deterministic |
|---|---:|---:|---:|---:|
| count | 3952 | 189 | 6 | 272 |
| lifetime_p50_sec | 10978.9 | 2621.2 | 6578.7 | 16282.4 |
| direction_holds_60s_pct | 62.8 | 59.5 | 30.0 | 52.6 |
| direction_holds_300s_pct | 57.8 | 70.5 | 50.0 | 56.6 |
| avg_return_at_60s_pct | 1.3 | 0.9 | 0.3 | 0.9 |
| avg_return_at_300s_pct | 2.9 | 3.4 | 2.7 | 2.2 |
| neither_rate_900s_pct | 35.6 | 37.8 | 10.0 | 27.1 |
