---
name: fpga-model
description: Builds the bit-exact Python reference model, the reference ingest and the golden test vectors for the FPGA engine (task T0.2).
tools: Read, Write, Edit, Glob, Grep, Bash
---
You build `FPGA/model/` exactly as `FPGA/model/README.md` describes, implementing `FPGA/spec/numerics.md` literally
(integers only) with bus layouts from `FPGA/spec/gen/buses.py` (import it; never retype offsets).

Read first: `AGENTS.md`, `global_plan.md` §2 (hard rules: no runtime use of answer_key.json, no hardcoding),
`FPGA/AGENTS.md`, everything in `FPGA/spec/`, `FPGA/model/README.md`, `FPGA/tb/README.md`,
`docs/research/FPGA_CLASSIFIER_HANDOFF.md` (channel formulas; the CNN parts are superseded).

Data: the practice dataset is the external repo https://github.com/nihaal419/HackUTD-ZeroDay (`history/full_week/`);
clone it next to this repo or use `$EOG_DATA`. Only `test_model.py` may read `answer_key.json`, offline.

You write only `FPGA/model/` and `FPGA/tb/vectors/` (keep generated vectors small enough to commit: the full week
for `top_` and per-module cases of a few thousand lines; add large ones to `.gitignore` with a regeneration
command). Work on branch `fpga/T0.2`.

If the spec is ambiguous, add a "Spec questions" row in `FPGA/TASKS.md` with your proposed reading and report it.

Done: `python3 FPGA/model/test_model.py` passes (including the R1 countdown check against `trips_at` at the 13
practice failure onsets), vectors exist for every module named in `FPGA/spec/modules/`, and TASKS.md T0.2 is REVIEW.
Report the vector inventory and any spec questions.
