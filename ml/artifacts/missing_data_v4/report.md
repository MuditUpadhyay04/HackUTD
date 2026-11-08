# R7: hold policy C vs A6 under missing readings (v4 settings, missing-data augmentation)

Same rows deleted under both policies (seed 2). Each system is scored by a model trained without it, using v4's shipped thresholds and per-class K. FA = false alerts per facility-day; AP = average precision (VALID/HELD records). Resets exclude each facility's first record.

| Case | Policy | Leak FA | Degr FA | Leak AP | Degr AP | Leak / degr events | Resets per facility-day | Memory < 64 steps | INVALID | HELD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| clean | C | 0.038 | 0.029 | 0.979 | 0.925 | 5/5 / 5/5 | 0.0 | 3.2 % | 0.00 % | 0.0 % |
| 1% missing | A6 | 0.029 | 0.114 | 0.969 | 0.902 | 5/5 / 5/5 | 0.39 | 11.6 % | 0.15 % | 11.9 % |
| 1% missing | C | 0.029 | 0.086 | 0.98 | 0.908 | 5/5 / 5/5 | 0.0 | 3.2 % | 0.17 % | 11.8 % |
| 2% missing | A6 | 0.133 | 0.229 | 0.787 | 0.725 | 5/5 / 5/5 | 2.7 | 47.3 % | 0.98 % | 21.8 % |
| 2% missing | C | 0.029 | 0.171 | 0.978 | 0.888 | 5/5 / 5/5 | 0.0 | 3.2 % | 1.20 % | 21.6 % |
| 5% missing | A6 | 0.048 | 0.038 | 0.523 | 0.51 | 5/5 / 5/5 | 19.7 | 99.4 % | 7.34 % | 41.4 % |
| 5% missing | C | 0.181 | 0.41 | 0.958 | 0.815 | 5/5 / 5/5 | 0.0 | 3.6 % | 11.92 % | 36.9 % |
