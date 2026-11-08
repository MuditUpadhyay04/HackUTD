# R7: hold policy C vs A6 under missing readings (weights v3 recipe)

Same rows deleted under both policies (seed 2). Each system is scored by a model trained without it, using v3's shipped thresholds and per-class K. FA = false alerts per facility-day; AP = average precision (VALID/HELD records). Resets exclude each facility's first record.

| Case | Policy | Leak FA | Degr FA | Leak AP | Degr AP | Leak / degr events | Resets per facility-day | Memory < 64 steps | INVALID | HELD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| clean | C | 0.019 | 0.038 | 0.977 | 0.935 | 5/5 / 5/5 | 0.0 | 3.2 % | 0.00 % | 0.0 % |
| 1% missing | A6 | 0.086 | 0.152 | 0.947 | 0.826 | 5/5 / 5/5 | 0.39 | 11.6 % | 0.15 % | 11.9 % |
| 1% missing | C | 0.124 | 0.086 | 0.936 | 0.774 | 5/5 / 5/5 | 0.0 | 3.2 % | 0.17 % | 11.8 % |
| 2% missing | A6 | 0.152 | 0.2 | 0.795 | 0.706 | 5/5 / 5/5 | 2.7 | 47.3 % | 0.98 % | 21.8 % |
| 2% missing | C | 0.21 | 0.105 | 0.932 | 0.768 | 5/5 / 5/5 | 0.0 | 3.2 % | 1.20 % | 21.6 % |
| 5% missing | A6 | 0.219 | 0.105 | 0.48 | 0.397 | 5/5 / 5/5 | 19.7 | 99.4 % | 7.34 % | 41.4 % |
| 5% missing | C | 0.543 | 0.486 | 0.831 | 0.545 | 5/5 / 5/5 | 0.0 | 3.6 % | 11.92 % | 36.9 % |
