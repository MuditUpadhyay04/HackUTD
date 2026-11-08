# Architecture experiments

Train on 4 systems (clean + augmentations), quantize, choose threshold and K on clean out-of-fold scores, score the held-out system (clean and distorted). Cells: precision / recall, events caught, median / max delay in minutes, false alerts per facility-day (FA). Optimistic: thresholds are chosen on the same clean out-of-fold scores.

| Config | Leak (clean) | Degradation (clean) | FA leak / degr at pressure x0.7 | at x1.3 | with noise | 2 % missing (AP leak / degr) |
| --- | --- | --- | --- | --- | --- | --- |
| base31 | current recipe | 0.944/0.989, 5/5, 5.0/60 min, FA 0.048 | 0.949/0.845, 5/5, 170.0/275 min, FA 0.048 | 0.038 / 0.029 | 0.076 / 0.267 | 0.19 / 0.171 | 0.833 / 0.731 |
| drop_redundant26 | current recipe | 0.943/0.989, 5/5, 5.0/60 min, FA 0.048 | 0.948/0.828, 5/5, 190.0/285 min, FA 0.038 | 0.048 / 0.048 | 0.095 / 0.229 | 0.21 / 0.076 | 0.83 / 0.724 |
| relu3 | current recipe | 0.945/0.986, 5/5, 10.0/60 min, FA 0.038 | 0.942/0.876, 5/5, 190.0/270 min, FA 0.048 | 0.01 / 0.029 | 0.086 / 0.143 | 0.124 / 0.114 | 0.802 / 0.727 |
| vslow3 | current recipe | 0.944/0.989, 5/5, 5.0/60 min, FA 0.048 | 0.954/0.806, 5/5, 230.0/400 min, FA 0.038 | 0.0 / 0.067 | 0.162 / 0.2 | 0.162 / 0.095 | 0.74 / 0.718 |
| relu_vslow3 | current recipe | 0.945/0.985, 5/5, 15.0/65 min, FA 0.01 | 0.946/0.859, 5/5, 260.0/340 min, FA 0.038 | 0.0 / 0.038 | 0.048 / 0.095 | 0.038 / 0.086 | 0.703 / 0.707 |
| base31 | observable labels | 0.947/0.99, 5/5, 5.0/60 min, FA 0.01 | 0.949/0.833, 5/5, 170.0/275 min, FA 0.038 | 0.01 / 0.038 | 0.019 / 0.067 | 0.19 / 0.162 | 0.82 / 0.756 |
| base31 | + missing-data aug | 0.942/0.97, 5/5, 20.0/65 min, FA 0.048 | 0.955/0.865, 5/5, 200.0/275 min, FA 0.048 | 0.019 / 0.048 | 0.086 / 0.143 | 0.048 / 0.105 | 0.905 / 0.815 |
