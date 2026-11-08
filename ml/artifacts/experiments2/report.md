# Architecture experiments

Train on 4 systems (clean + augmentations), quantize, choose threshold and K on clean out-of-fold scores, score the held-out system (clean and distorted). Cells: precision / recall, events caught, median / max delay in minutes, false alerts per facility-day (FA). Optimistic: thresholds are chosen on the same clean out-of-fold scores.

| Config | Leak (clean) | Degradation (clean) | FA leak / degr at pressure x0.7 | at x1.3 | with noise | 2 % missing (AP leak / degr) |
| --- | --- | --- | --- | --- | --- | --- |
| base31 | observable labels | 0.947/0.99, 5/5, 5.0/60 min, FA 0.01 | 0.949/0.833, 5/5, 170.0/275 min, FA 0.038 | 0.01 / 0.038 | 0.019 / 0.067 | 0.19 / 0.162 | 0.82 / 0.756 |
| base31 | observable + missing-data aug | 0.944/0.986, 5/5, 5.0/60 min, FA 0.048 | 0.954/0.833, 5/5, 200.0/275 min, FA 0.048 | 0.019 / 0.038 | 0.086 / 0.057 | 0.076 / 0.048 | 0.91 / 0.821 |
| base31 | observable + missing-data aug, C 0.3 | 0.943/0.986, 5/5, 5.0/60 min, FA 0.048 | 0.95/0.828, 5/5, 250.0/280 min, FA 0.038 | 0.029 / 0.048 | 0.095 / 0.057 | 0.105 / 0.067 | 0.908 / 0.82 |
| base31 | observable, C 3 | 0.946/0.99, 5/5, 5.0/60 min, FA 0.019 | 0.947/0.902, 5/5, 155.0/180 min, FA 0.038 | 0.01 / 0.038 | 0.048 / 0.105 | 0.133 / 0.086 | 0.795 / 0.706 |
