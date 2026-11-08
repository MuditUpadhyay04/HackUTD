# Weights v1 — training report

Four L2 logistic regressions on memory feature set v1 (31 integer features from `features_int.py`).
Validation: train on 4 systems, score the 5th, for each of S1–S5 (out-of-fold, **integer logits** after int16 export). Thresholds and K are chosen on those same out-of-fold scores, so the numbers below are **optimistic exploration on one practice week**, not a benchmark on the unseen network. Failure and shut-in are directly signalled by pump status 2 / all wells off.

Blob: 980 B, CRC32 0x8F5BFC5C, model hash 0x1D11C0C5, S_out 15, Fw 9, logits in 1/256 units.

## Regularization (pooled out-of-fold average precision by C)

- pipeline_leak: {'0.03': 0.9259, '0.1': 0.9395, '0.3': 0.9459, '1.0': 0.9527, '3.0': 0.9621} → **C = 3.0**
- pump_degradation: {'0.03': 0.6845, '0.1': 0.845, '0.3': 0.9001, '1.0': 0.9157, '3.0': 0.9239} → **C = 3.0**
- pump_failure: {'0.03': 1.0, '0.1': 1.0, '0.3': 1.0, '1.0': 1.0, '3.0': 1.0} → **C = 0.03**
- facility_shut_in: {'0.03': 1.0, '0.1': 1.0, '0.3': 1.0, '1.0': 1.0, '3.0': 1.0} → **C = 0.03**

## Wire v1 settings (single persist_K = 1)

| Head | logit_thr (1/256) | Precision / recall | False alerts per facility-day | Events | Delay median / max (min) |
| --- | --- | --- | --- | --- | --- |
| pipeline_leak | 64 (+0.25) | 0.94 / 0.99 | 0.038 | 5/5 | 5.0 / 60 |
| pump_degradation | 384 (+1.50) | 0.95 / 0.83 | 0.048 | 5/5 | 190.0 / 280 |
| pump_failure | 0 (+0.00) | 1.00 / 1.00 | 0.000 | 13/13 | 0.0 / 0 |
| facility_shut_in | 0 (+0.00) | 1.00 / 1.00 | 0.000 | — | — |

## Proposed per-class K (not in wire v1)

| Head | logit_thr | K | Precision / recall | False alerts per facility-day | Events | Delay median / max (min) |
| --- | --- | --- | --- | --- | --- | --- |
| pipeline_leak | 64 (+0.25) | 1 | 0.94 / 0.99 | 0.038 | 5/5 | 5.0 / 60 |
| pump_degradation | 128 (+0.50) | 4 | 0.95 / 0.84 | 0.029 | 5/5 | 240.0 / 365 |
| pump_failure | 0 (+0.00) | 1 | 1.00 / 1.00 | 0.000 | 13/13 | 0.0 / 0 |
| facility_shut_in | 0 (+0.00) | 1 | 1.00 / 1.00 | 0.000 | — | — |

## E-STOP rule (flow gap AND leak logit, K steps)

```
{
 "gap_thr": 504,
 "healthy_running_gap_p99_9": 402.9,
 "leak_events_with_estop": 5,
 "leak_events": 5,
 "estop_frames_outside_leaks": 0
}
```

## Ablation (frame precision / recall at logit 0, out-of-fold)

| Features | pipeline_leak | pump_degradation | pump_failure | facility_shut_in |
| --- | --- | --- | --- | --- |
| current_12 | 0.23 / 0.84 | 0.30 / 0.74 | 1.00 / 1.00 | 1.00 / 1.00 |
| memory_v1_31 | 0.94 / 0.99 | 0.83 / 0.90 | 1.00 / 1.00 | 1.00 / 1.00 |

## Integer export vs float (final model, in-sample)

```
{
 "decision_agreement": 1.0,
 "max_abs_logit_error_unsaturated": 0.006910567729434547
}
```

## Mock-test dry run (no labels; same week as training, so a sanity check only)

```
{
 "folder": "mock_test_2026-10-10T1530",
 "now_unix": 1791646200,
 "flagged_at_now": [
  {
   "facility": "S5_FACILITY_B",
   "model_above_threshold": [
    "pump_failure"
   ],
   "rules": [
    "pump_fault"
   ],
   "countdown_p50_min": 285
  },
  {
   "facility": "S5_FACILITY_C",
   "model_above_threshold": [
    "pump_failure"
   ],
   "rules": [
    "pump_fault"
   ],
   "countdown_p50_min": 123
  }
 ],
 "alerts": 131
}
```
