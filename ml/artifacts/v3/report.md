# Weights v3 — training report

Four L2 logistic regressions on memory feature set v1 (31 integer features from `features_int.py`).
Validation: train on 4 systems, score the 5th, for each of S1–S5 (out-of-fold, **integer logits** after int16 export). Thresholds and K are chosen on those same out-of-fold scores, so the numbers below are **optimistic exploration on one practice week**, not a benchmark on the unseen network. Failure and shut-in are directly signalled by pump status 2 / all wells off.

Training data: the clean practice week **plus augmented copies** (healthy pressure offsets x0.8 / x1.2, sizes x0.7 / x1.5, extra sensor noise; see `augment.TRAIN`). Validation scores are always on the clean held-out system.

Observable labels: leak / degradation positives before the pump first runs inside their event get training weight 0 (nothing can show the problem yet); evaluation uses the full labels.

Blob: 980 B, CRC32 0xA8E1639F, model hash 0xF0D8A2D2, S_out 14, Fw 8, logits in 1/256 units.

## Regularization (pooled out-of-fold average precision by C)

- pipeline_leak: {'fixed': 3.0} → **C = 3.0**
- pump_degradation: {'fixed': 3.0} → **C = 3.0**
- pump_failure: {'fixed': 0.03} → **C = 0.03**
- facility_shut_in: {'fixed': 0.03} → **C = 0.03**

## Shipped settings: per-class K (GLOBAL bytes 20-23, FPGA D10)

| Head | logit_thr | K | Precision / recall | False alerts per facility-day | Events | Delay median / max (min) |
| --- | --- | --- | --- | --- | --- | --- |
| pipeline_leak | -64 (-0.25) | 1 | 0.95 / 0.99 | 0.019 | 5/5 | 5.0 / 60 |
| pump_degradation | 0 (+0.00) | 3 | 0.95 / 0.90 | 0.038 | 5/5 | 155.0 / 180 |
| pump_failure | 0 (+0.00) | 1 | 1.00 / 1.00 | 0.000 | 13/13 | 0.0 / 0 |
| facility_shut_in | 0 (+0.00) | 1 | 1.00 / 1.00 | 0.000 | — | — |

## Alternative: one K for all classes (persist_K = 1)

| Head | logit_thr (1/256) | Precision / recall | False alerts per facility-day | Events | Delay median / max (min) |
| --- | --- | --- | --- | --- | --- |
| pipeline_leak | -64 (-0.25) | 0.95 / 0.99 | 0.019 | 5/5 | 5.0 / 60 |
| pump_degradation | 448 (+1.75) | 0.95 / 0.85 | 0.048 | 5/5 | 170.0 / 260 |
| pump_failure | 0 (+0.00) | 1.00 / 1.00 | 0.000 | 13/13 | 0.0 / 0 |
| facility_shut_in | 0 (+0.00) | 1.00 / 1.00 | 0.000 | — | — |

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
| current_12 | 0.23 / 0.83 | 0.45 / 0.73 | 1.00 / 1.00 | 1.00 / 1.00 |
| memory_v1_31 | 0.95 / 0.99 | 0.89 / 0.92 | 1.00 / 1.00 | 1.00 / 1.00 |

## Integer export vs float (final model, in-sample)

```
{
 "decision_agreement": 0.9999751984126984,
 "max_abs_logit_error_unsaturated": 0.01352695666186321
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
   "countdown_p50_min": 205
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
 "alerts": 98
}
```
