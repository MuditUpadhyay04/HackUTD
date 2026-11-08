# Architecture experiments

Train on 4 systems (clean + augmentations), quantize, choose threshold and K on clean out-of-fold scores, score the held-out system (clean and distorted). Cells: precision / recall, events caught, median / max delay in minutes, false alerts per facility-day (FA). Optimistic: thresholds are chosen on the same clean out-of-fold scores.

| Config | Leak (clean) | Degradation (clean) | FA leak / degr at pressure x0.7 | at x1.3 | with noise | 2 % missing (AP leak / degr) |
| --- | --- | --- | --- | --- | --- | --- |
| v3 recipe (observable, C 3) under hold C | 0.946/0.99, 5/5, 5.0/60 min, FA 0.019 | 0.947/0.902, 5/5, 155.0/180 min, FA 0.038 | 0.01 / 0.038 | 0.048 / 0.105 | 0.133 / 0.086 | 0.932 / 0.768 |
| v3 recipe + missing-data aug under hold C | 0.921/0.986, 5/5, 10.0/65 min, FA 0.038 | 0.962/0.877, 5/5, 165.0/180 min, FA 0.038 | 0.019 / 0.038 | 0.057 / 0.076 | 0.057 / 0.067 | 0.978 / 0.888 |
