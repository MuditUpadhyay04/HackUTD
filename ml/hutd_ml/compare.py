"""Compare RESULT records from the RTL testbench or the board with a golden set.

    python -m hutd_ml.compare <expected_results.bin> <actual_results.bin> [--stages expected_stages.csv]
                              [--ignore result_no,...]

Both files are packed 32 B RESULT records in the same order. Prints the first mismatch (record, field, expected,
actual, and the expected per-stage values for that record if --stages is given) and mismatch counts per field.
Exit code 0 = identical on every compared field.
"""
import argparse
import csv
import sys

import numpy as np

from . import wire

FIELDS = ["fac_id", "status", "since_reset", "ts_unix", "reason", "logits", "rules", "weights_ver", "countdown",
          "result_no"]


def compare(expected, actual, ignore=()):
    n = min(len(expected), len(actual))
    counts, first = {}, None
    for f in FIELDS:
        if f in ignore:
            continue
        e, a = expected[f][:n], actual[f][:n]
        bad = np.any(e != a, axis=tuple(range(1, e.ndim))) if e.ndim > 1 else e != a
        counts[f] = int(bad.sum())
        if bad.any():
            i = int(np.argmax(bad))
            if first is None or i < first[0]:
                first = (i, f, e[i].tolist(), a[i].tolist())
    return n, counts, first


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("expected")
    ap.add_argument("actual")
    ap.add_argument("--stages", default=None)
    ap.add_argument("--ignore", default="")
    a = ap.parse_args(argv)
    exp = np.fromfile(a.expected, dtype=wire.RESULT_DTYPE)
    act = np.fromfile(a.actual, dtype=wire.RESULT_DTYPE)
    n, counts, first = compare(exp, act, [x for x in a.ignore.split(",") if x])
    print(f"compared {n} records (expected {len(exp)}, actual {len(act)})")
    print("mismatches per field:", counts)
    if first:
        i, f, e, v = first
        print(f"FIRST MISMATCH record {i}: field {f}: expected {e}, actual {v}")
        if a.stages:
            with open(a.stages) as fh:
                for row in csv.DictReader(fh):
                    if int(row["i"]) == i:
                        print("expected stages for that record:", row)
                        break
    ok = first is None and len(exp) == len(act)
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
