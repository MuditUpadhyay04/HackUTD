# Dataset findings and four-output FPGA CNN handoff

Date: 2026-11-07. Status: **proposed interface, backed by a completed data audit; no CNN has been trained or synthesized here.**

> **Superseded in part (Sat Nov 7, 21:10 CST).** The FPGA plan ([`docs/plan/lucas/fpga_hardware_plan.md`](../plan/lucas/fpga_hardware_plan.md))
> dropped the CNN for four logistic regressions on causal memory features, computed on the FPGA from raw
> streamed records. **Superseded here:** the CNN architecture, the `[1, 12, 96]` window and its warm-up, host-side
> windowing, and the 2,304 B full-window transport. **Still valid:** the 12 channel formulas (section 4), the output
> order, the int16 scale 1/16384, server-side sigmoid/events/planning, and the training and validation rules
> (section 7). See [`global_plan.md`](../../global_plan.md) §6.

Reference repository: https://github.com/nihaal419/HackUTD-ZeroDay

Audited commit: `135ba4c8348357457420a1111df80ec1906bcbdb`.

Integration owners from project context: **Lucas (Eclypse Z7 FPGA) and Mudit (model training)**. Neither their core configuration nor an existing model/export was available in this checkout. They must agree tensor, operator, precision, and weight formats together. With the hackathon ending November 8, keep a working normal + three-fault model if it already exists; add the observed shut-in state as a host rule rather than destabilize the end-to-end demo just to add a learned output.

## 1. Decision in one paragraph

Use a **temporal, per-facility CNN with four independent binary outputs**: pipeline leak, pump degradation, pump failure, and observed facility shut-in. The fourth is a real operational state in the telemetry, **not a fourth independent equipment fault**. A shut-in caused by pump failure must produce both outputs simultaneously. Healthy operation is all four targets zero, not a fifth sigmoid output. If hardware already implements a four-class softmax, its four mutually exclusive classes should instead be normal + the three official faults; calculate shut-in separately. Do not put the three faults plus shut-in into one four-way softmax.

For a useful operator demo, add physically calculated leak-volume estimates, capacity-loss estimates, shutdown countdowns, and a separate response planner. A CNN diagnosis is not a truck-dispatch decision.

## 2. What was actually investigated

Read every row of `history/full_week/telemetry.csv`, every event in its answer key, all topology and operations metadata, and compared every snapshot/mock telemetry file byte-for-byte against the full week. Reshaped all readings into facility/timestamp frames, examined event boundaries, normal/off/running regimes, pressure and flow distributions, well shutdowns, and missing/duplicate data. Ran simple physical diagnostics and two grouped-validation decision-tree probes to test the importance of temporal memory.

### Inventory and integrity

- 393,120 CSV rows, 2,016 timestamps, exactly 300 seconds apart.
- Range: 2026-10-05 00:00 through 2026-10-11 23:55 UTC.
- 5 systems, 15 facilities, 45 wells; 105 reporting assets and 195 asset/metric series.
- Each facility contributes 13 raw readings per interval: 6 well readings, facility inflow, tank level, 3 pump readings, and 2 pipeline readings.
- 30,240 facility/timestamp frames. These are not 30,240 independent incidents.
- No missing values, missing grid cells, duplicate keys, timestamp-string mismatches, unexpected series, or missing expected series.
- Each of the three snapshots and the mock test is an **exact byte prefix** of the full-week CSV. Their network and ops files are identical. They are not independent test sets.
- This audited commit has no judging `test/` dataset. Generalization to that network has not been measured.

### Available supervision

| Target | Independent labelled events / derived episodes | Positive facility frames | Share of all frames |
|---|---:|---:|---:|
| Pipeline leak | 5 labelled events | 1,452 | 4.80% |
| Pump degradation | 5 labelled events | 1,924 | 6.36% |
| Pump failure | 13 labelled events | 936 | 3.10% |
| Facility shut-in | 12 derived episodes | 199 | 0.66% |
| None of these labels | — | 25,928 | 85.74% |

Every failure lasts 72 readings, or six hours. Every shut-in frame also has a failure label: 737 failure frames are before shut-in and 199 are during shut-in. The three root-cause labels never overlap within a facility in this week; multiple facilities do fail concurrently. Three degradation episodes transition directly to failure; two recover without a failure. This is insufficient evidence for a reliable learned time-to-pump-failure predictor.

### Dataset simplifications that can make a model look better than it is

- Every facility has exactly three wells and healthy pump capacity is exactly **1.5 × baseline facility water inflow**.
- All pumps use 70%/30% start/stop setpoints; warning/shutdown limits are 85%/92%.
- Tank capacities range from 600 to 1,200 bbl; rated pump flows from 1,950 to 3,600 bpd; disposal pressures from 950 to 1,100 psi.
- Facility inflow equals the sum of well-water readings to rounding error: absolute discrepancy never exceeds approximately 0.1 bpd. These are not independent measurements in practice data.
- Pump fault status, zero flows, and well statuses are unusually clean. Pressures follow simplified formulas, not a validated hydraulic simulator.

Read metadata in each incoming network; do not hardcode these shared practice-data properties.

## 3. The four binary classifiers

Output order is fixed:

```text
[pipeline_leak, pump_degradation, pump_failure, facility_shut_in]
```

Each logit is independently trained with binary cross-entropy. Sigmoid probabilities do not sum to one. The targets below describe **the newest timestamp**, not whether an event happened anywhere in the input window.

### Output 0: pipeline_leak

**Meaning:** an active leak in this facility's pipeline, based on current/recent sensor evidence.

**Offline label:** 1 when `onset_unix <= t < end_unix` for that facility's `pipeline_leak` answer-key event; otherwise 0.

**Observed signatures while running:**

- Pump flow remains near rated capacity; received pipeline flow is smaller.
- Healthy running flow mismatch `(Qpump - Qreceive) / Qmax` has 1st/99th percentiles of approximately -1.88%/+1.84%.
- Leak running mismatch has a median of 6.34%, with an observed range of 0.17% to 12.71%. Early small leaks overlap healthy flow noise.
- Healthy running pipeline pressure offset `(Pline - Pdisposal) / 50` is typically about 1. Leak running values range from -1.208 to 0.830, with a median of -0.195. Pump discharge pressure stays near its healthy running offset.
- These pressure changes are a particularly strong signal in this synthetic dataset; do not generalize their exact magnitude to physical equipment.

**Critical limitation:** 420 of 1,452 leak-labelled frames have the pump off. Both measured flows are zero and pressures return to the normal off regime. The leak is not freshly observable there. Carry a prior diagnosis as unconfirmed; absence of off-state evidence is not proof of resolution. EVENT_1 starts while off and has no running observation until 60 minutes after labelled onset. No causal model can guarantee detecting its labelled onset from an absent hydraulic signature.

**Operator response:** inspect pipeline; report estimated lost flow/volume with uncertainty, not a trucking requirement.

### Output 1: pump_degradation

**Meaning:** the pump is losing running hydraulic capacity; not electrical efficiency and not a guaranteed future failure.

**Offline label:** the same half-open interval rule for `pump_degradation` events. A directly following failure ends the degradation target and starts the failure target.

**Observed signatures while running:**

- Pump and received flow decrease together, without a sustained pipeline flow imbalance.
- Healthy running `Qpump / Qmax` spans 0.9752–1.0224; degradation running values span 0.8514–1.0072, with a median of 0.9307. Early degradation overlaps healthy readings.
- Pump discharge offset `(Pdischarge - Pdisposal) / 150` decreases: degradation median 0.82 versus healthy median 1.00. Pipeline downstream pressure generally remains in its healthy running regime.
- Reduced capacity changes the tank drawdown/duty cycle. Tank slope is supporting evidence, not a mandatory trigger.

**Critical limitation:** 495 of 1,924 degradation-labelled frames have the pump off, with no direct capacity measurement. Four degradation events start while off; first running observations arrive 20, 105, 130, and 145 minutes after onset. Even a running observation at onset can look healthy. A model must be allowed detection delay and cannot recover exact early onset reliably.

**Operator response:** inspect pump; report hydraulic capacity loss. Do not claim cavitation, bearing damage, power efficiency, or a reliable failure date.

### Output 2: pump_failure

**Meaning:** pump currently faulted/unavailable, whether the tank is still filling or already shut in.

**Offline label:** half-open interval rule for `pump_failure` events.

**Observed signatures:** all 936 failure frames have pump `status = 2`, zero pump flow, and zero received flow. No non-failure frame has status 2. Pressure returns to the off regime.

**Important honesty point:** this target is already explicitly signalled by a sensor enum in this dataset. Perfect recognition with this input is fault-status recognition, not proof the CNN discovered an incipient failure. A separate ablation omitting the fault bit would be needed to support a sensor-based inference claim.

**Do not confuse it with normal off:** 8,244 healthy-labelled frames have `status = 0` and zero flow. Healthy off periods reach 70 consecutive readings, approximately 5 h 50 min. Zero flow alone is not failure.

**Boundary gotcha:** at all 13 failure-onset readings the measured tank is still lower than at the preceding timestamp, despite status already changing to 2. Rising level becomes apparent afterward. Requiring positive tank slope to recognize the first fault frame would delay every failure. Conversely, repaired pumps can run with high tank levels; 219 no-active-label frames have tank level at least 85%.

**Operator response:** calculate shutdown deadline and remaining repair horizon; invoke a system-wide truck/well-shut-in cost planner. An already shut-in facility must retain this failure diagnosis until the failure ends.

### Output 3: facility_shut_in

**Meaning:** production from all wells at this facility has stopped. In this recording it is automatic shutdown caused by tank capacity, not a separate equipment fault.

**Offline derived label:** all this facility's well statuses are 0 and all their water rates are 0. Use these observations, not future `trips_at` timestamps, to derive the label. All 199 such frames also have tank level exactly 92% and pump status 2 in the audited data. There are no partial well-shut-in examples.

**Evidence:** 12 separate episodes, all inside the 13 failure events; EVENT_6 never trips. For EVENT_9, the answer key gives a continuous-time trip at 04:49, but the first measured shut-in is 04:50. Five-minute telemetry cannot identify an exact intervening minute.

**Critical limitations:**

- This is current-state recognition, not advance prediction of a shutdown.
- All observed shutdowns coincide with failure, so the learned head could simply use failure plus high level. Test explicit reliance on well status and water rate; do not claim independent generalization.
- In real operations the same well readings could result from an intentional operator shutdown. Without command logs, the model cannot establish automatic versus manual causality.
- Inference may use a small validated water-rate tolerance for noisy real sensors; the practice labels use exact observed zeros.

**Operator response:** show active production loss, retain the root-cause alert, and replan. Do not open a second independent equipment-failure incident or allocate trucks twice.

### Examples of target vectors

```text
Normal running or normal pump-off: [0, 0, 0, 0]
Pipeline leaking:                  [1, 0, 0, 0]
Pump degrading:                    [0, 1, 0, 0]
Pump failed, wells still active:   [0, 0, 1, 0]
Pump failed, all wells shut in:    [0, 0, 1, 1]
```

No active prediction is not proof of health: it may be an early, weak, or unobservable fault. Invalid/missing telemetry is a separate host-side status, never silently a normal prediction. Unseen combinations must not be called validated merely because a sigmoid model can emit them.

## 4. Exact input interface for the FPGA teammate

### Ownership boundary

**Host/software:** parse CSV and JSON, map assets using topology, align timestamped readings, aggregate variable well counts, normalize, build history buffers, perform quality checks, and pack tensors. Keep raw unrounded readings for physics calculations and safety checks.

**FPGA:** run the frozen temporal CNN on numeric tensors and return four ordered logits. It does not parse JSON, receive asset-name strings, train online, or infer a truck plan.

**Host after inference:** sigmoid/calibration, thresholding, diagnosis persistence, safety overrides, event IDs, explanations, cost optimization, and dashboard updates. Transport facility/timestamp IDs outside the learned tensor.

### Unit of inference and time order

- One sample = one facility's current and previous 95 readings.
- Sample interval = 300 seconds, stride = one interval.
- Tensor shape in the training/reference implementation: **`[N, 12, 96]`**, N usually 1 at device invocation.
- Channels first; inside each channel, time is **oldest to newest**. Index `[..., 95]` is the timestamp being classified.
- 96 readings span 475 minutes (7 h 55 min). This exceeds the longest observed off stretch; it is a practical starting point, not a proof that all future off stretches fit.
- Keep separate buffers for every facility; never concatenate different facilities in time or pad by borrowing another facility's rows.
- Require 96 complete contiguous readings for a valid full-window CNN result. During cold start, host rules for failure/shut-in and an explicitly marked provisional running-state diagnostic remain available. Waiting for a valid CNN window must not delay these direct alarms.
- Do not hide cold-start misses in evaluation. The first leak starts at 06:00, before an initially empty buffer becomes full at 07:55.
- Missing/duplicate/unmatched/nonfinite values: flag invalid input. Do not backfill from future data or interpret zero-filled missing sensors as real zero flow. A gap resets the valid full-window buffer for this v1 contract.

### Constants loaded from network metadata

```text
B = sum(well.baseline_water_bpd for this facility's wells)  # bbl/day
Q = facility.pump.max_flow_bpd                            # bbl/day
C = facility.tank.capacity_bbl                            # bbl
P0 = system.disposal_site.pressure_psi                     # psi
W = number of wells at this facility
```

All must exist, be finite, and have valid positive B/Q/C/W. P0 is topology metadata, not a disposal-site sensor. Enumerated statuses must be validated before encoding.

### Frozen channel order and formulas, interface v1

| Index | Name | Exact formula at timestamp t |
|---:|---|---|
| 0 | `inflow_norm` | facility `inflow_bpd / B` |
| 1 | `pump_flow_norm` | pump `flow_bpd / Q` |
| 2 | `receive_flow_norm` | pipeline `receive_flow_bpd / Q` |
| 3 | `flow_gap_norm` | `(pump.flow_bpd - pipeline.receive_flow_bpd) / Q` |
| 4 | `tank_fraction` | tank `level_pct / 100` |
| 5 | `discharge_offset_norm` | `(pump.discharge_psi - P0) / 150` |
| 6 | `pipeline_offset_norm` | `(pipeline.pressure_psi - P0) / 50` |
| 7 | `pump_running` | 1 if pump status == 1, else 0 |
| 8 | `pump_fault` | 1 if pump status == 2, else 0 |
| 9 | `wells_active_fraction` | `sum(well.status) / W` |
| 10 | `well_water_norm` | `sum(well.water_bpd) / B` |
| 11 | `tank_net_flow_norm` | `(level_pct[t] - level_pct[t-1]) * C * 288 / (100 * B)` |

For channel 11 only, set the first record of a new contiguous facility history to zero because no prior sample exists. Subsequently use the actual preceding reading, including the reading immediately before the oldest row of a sliding window. The factor 288 converts a five-minute volume change to bbl/day. This derivative is noisy and can lag state changes; do not treat balance residuals as a fourth fault. Channel 10 is intentionally nearly redundant in practice data; it permits checking inflow consistency but does not add independent fault information.

Do not clamp a negative flow mismatch to zero in preprocessing: negative noise is part of normal behavior. Do not normalize each window by its own mean/max: that can erase degradation and leak magnitude. Metadata scaling is shared by training and inference and adapts to new equipment sizes without fitting on future telemetry.

### Numerical transport proposal

The logical feature values above are the reference. Proposed host-to-FPGA encoding:

```text
q[c,t] = saturate_int16(round_ties_to_even(x[c,t] * 16384))
x_reconstructed = q / 16384
dtype = signed int16, little endian
payload = C-order bytes of q[12,96]  # channel-major, not time-interleaved
payload size = 12 * 96 * 2 = 2304 bytes per facility window
```

This explicitly defined scale covers [-2, 1.99993896484375]; all observed features fit (overall extremes about -1.208 to +1.6272). It preserves weak flow changes better than a naive shared-scale int8 cast. Out-of-range features must set an input-saturation/quality flag, even if saturated bytes are sent. Do not label saturated/out-of-distribution inputs healthy by default.

**This is not a claim that the teammate's core supports int16.** Agree this transport format before wiring. If the existing core requires int8, produce a versioned alternative using representative calibration or quantization-aware training, exact feature/activation/weight scales and zero points, and new golden vectors. Do not simply cast these int16 bytes to int8 or silently change the scale. Distinguish input transport precision from internal weight/activation precision.

Output transport cannot be frozen before a model is exported. The training export must specify the four logits' dtype, order, scales, zero points, overflow behavior, and model/version/hash; raw accumulator integers are not probabilities. Sigmoid may run on the host. Use per-head thresholds selected on validation data; 0.5 is only a provisional software default. A sigmoid value is not calibrated confidence without measurement.

Generated `fixtures/golden_vectors.json` and five `.i16le.bin` files provide exact input examples, hashes, labels, and latest-frame encodings. They are preprocessing/packing fixtures, **not expected predictions of an already trained model**.

## 5. Temporal model and hardware limits

- Use a 1D temporal CNN, not an image CNN over arbitrary reshaped CSV rows. Input is 12 sensor-derived channels over time.
- A 96-reading buffer is insufficient if the CNN's actual receptive field covers only a few readings. Ensure the newest output can access the oldest input.
- One candidate: six causal Conv1d layers, 16 channels each, kernel 3, dilations 1/2/4/8/16/32, ReLU, then a linear four-logit head on the final timestep. Its theoretical receptive field is 127, covering all 96 real inputs with causal left padding; approximately 4,580 parameters and 424,000 dense MACs per window. This is an architecture suggestion, not an exported or benchmarked implementation. Check dilation support and buffer costs on the actual core.
- Do not globally average the window and assume abrupt failure/recovery timing is preserved. The newest state must remain accessible. A direct newest-frame feature path is an alternative if supported.
- Train four independent binary heads or a shared encoder with four sigmoid outputs. Do not use categorical cross-entropy or argmax for the proposed multi-label contract.
- Tiny failure/shut-in rule comparators are sufficient for those clean dataset states. Retain them as explicit host/device safety checks; separately report CNN-only accuracy and rule-assisted accuracy.
- Never turn off wells or dispatch trucks directly from unvalidated CNN scores. This project is a decision-support replay, not validated industrial safety control.
- 15 practice facilities produce only 15 new frames every five minutes. Full-window int16 traffic is 34,560 bytes per interval before framing; FPGA compute speed is not the main detection bottleneck. The five-minute sampling cadence and hours of pump-off time dominate observability.
- Board resource use, clock rate, synthesis success, power, numerical accuracy, and latency remain unmeasured. Do not promise them from parameter counts.

## 6. What the diagnostic experiments actually show

Two **decision-tree probes, not CNN results** were evaluated by holding out one entire system at a time, training on the other four, then pooling predictions. Both use depth 4 and minimum leaf size 5, with the same four targets. The temporal probe adds last-running values and running-only means bounded to the current/past 96 readings. No future samples, answer-key fields, asset IDs, or absolute times are features. Temporal means use partial histories at cold start, unlike the proposed full-window CNN validity rule.

| Target | Current-frame precision / recall | Causal-memory precision / recall |
|---|---|---|
| Leak | 100.0% / 64.8% | 95.5% / 98.7% |
| Degradation | 80.2% / 68.4% | 95.8% / 86.3% |
| Failure | 100.0% / 100.0% | 100.0% / 92.3% |
| Shut-in | 100.0% / 100.0% | 100.0% / 94.5% |

Interpretation: causal memory materially helps leaks/degradation during off periods. It does not prove this CNN will achieve those metrics. A depth-limited shared tree can actually degrade the easy failure/shut-in outputs when extra features compete; this reinforces the need for direct status checks and separate per-head evaluation. Thresholds, model depth and the memory choice were inspected against this one week; these are exploratory diagnostics, not an untouched final benchmark.

Perfect shut-in recognition by its defining well-zero rule is tautological label agreement, not evidence of predictive ability. Likewise, explicit fault status explains perfect failure recognition.

## 7. Training and validation requirements

1. Use answer keys only in an offline labelling/evaluation process. Runtime loads only topology, ops, and telemetry. Do not embed event schedules, `trips_at`, reference actions, or future repair endings in features.
2. Split by whole systems/facilities/events before constructing windows. Never randomly split neighbouring rows/windows. Snapshots and mock test must not be treated as independent held-out data.
3. For any chronological split within a facility, prevent raw input windows crossing the train/validation boundary; a 95-reading embargo is the minimum for this window. Keep a complete event in one partition where feasible. Report limitations if the resulting split lacks positive examples.
4. Use class-weighted binary loss or carefully balanced event sampling. Do not report overall accuracy alone: predicting no active issue everywhere already matches 85.74% of frames exactly.
5. Report per-head precision/recall/F1, incident detection rate, time-to-first-alert, false alerts per facility-day, and recovery/clearance lag. Separately report running/off periods, early-onset ambiguity, and cold-start frames.
6. Evaluate the float reference, quantized software model, FPGA bit-accurate simulation, and real device on identical held-out tensors. Compare logits, threshold decisions, saturations, and regressions around weak faults and event boundaries.
7. Include normal off cycles, recovery at high tank level, failure-onset negative tank slope, and `[0,0,1,1]` labels in regression tests. Ablate pump fault/well status inputs before claiming inference beyond explicitly encoded states.
8. Treat physical inconsistency or unseen combinations as unsupported/needs review, not automatically a new diagnosed failure type. No OOD detector has been validated here.

The official answer-key labels include hydraulically unobservable off frames and weak early frames. Keep those true labels; do not relabel them normal to improve a score. Optionally attach an observability mask for analysis, but report full-interval performance as well.

## 8. Extra impact estimates and what must stay outside the classifier

### Leak severity

```text
signed_loss_rate_bpd = pump.flow_bpd - pipeline.receive_flow_bpd
estimated_loss_bbl += signed_loss_rate_bpd * 300 / 86400
```

Smooth/aggregate noise and apply incident gating. Do not clip every noisy negative observation before summing: that biases normal loss upward. Over the labelled leak intervals, signed observed differences integrate to approximately 114.7, 145.7, 98.8, 117.7, and 89.6 bbl for EVENT_1/4/10/16/17 respectively. These are sensor-derived estimates, not independent ground-truth leak volumes. Real pipelines may require transit-delay/line-storage correction, neither validated nor characterized here.

### Hydraulic capacity loss

While the pump is running, aggregate `1 - pump.flow_bpd / Q`. Mask off/fault frames; zero flow during a normal stop is not 100% degradation. Call this capacity loss, not energy efficiency: the dataset has no motor power, current, RPM, vibration, or temperature.

### Countdown

```text
remaining_bbl = C * max(shutdown_pct - level_pct, 0) / 100
net_inflow_bpd = estimated_inflow_bpd - estimated_pump_outflow_bpd
hours_to_shutdown = 24 * remaining_bbl / net_inflow_bpd  # if net inflow > 0
```

Use a robust inflow estimate and explicit assumptions. An already tripped tank has countdown 0; do not divide by the zero inflow after its wells stop. A post-repair high tank is not an active failure. For ordinary pump cycling, constant net-flow extrapolation is not a valid general forecast. Leaks/degradation retain null official countdowns under the challenge rules.

### Actions

Truck plans depend on shared fleet size, response/cycle time, trip timing, repair time remaining, and well economics in `ops.json`/`network.json`. These are system-wide constrained optimization inputs, absent from the per-facility CNN. Do not train action labels by copying each event's reference action: the same fault at a different time or with a busy fleet may need a different response. Observed telemetry contains no operator interventions, so proposed plans must run in a separate what-if simulation, not rewrite the recording.

## 9. What we cannot honestly claim

- No labelled fourth independent root-cause fault was found or established. This audit cannot prove the absence of every possible unlabelled anomaly.
- Blockage, cavitation, sensor failure, electrical failure cause, disposal outage, and overflow cannot be validated as learned classes from this week. The reference specifically excludes disposal-site failures and recorded overflow.
- Unknown/anomaly is not a supervised fourth class: there are no validated unknown-fault examples. Synthetic corruption could test input validation but is not real fault evidence.
- No reliable exact-onset detection while signals are absent, sub-five-minute event timing, learned time-to-failure guarantee, or calibrated uncertainty has been demonstrated.
- No new-network, real-field, trained-CNN, quantized-CNN, or synthesized-FPGA performance has been demonstrated here.

## 10. Reproduction and deliverables

Install `numpy`, `pandas`, and optionally `scikit-learn` in a development environment. Run:

```sh
git clone https://github.com/nihaal419/HackUTD-ZeroDay.git /path/to/reference
git -C /path/to/reference switch --detach 135ba4c8348357457420a1111df80ec1906bcbdb
python3 docs/research/audit_dataset.py /path/to/reference /path/to/audit-output
python3 docs/research/verify_handoff.py /path/to/reference
```

Outputs: full `audit.json`, derived `facility_frames.csv` (offline only), and five binary input fixtures with `golden_vectors.json`. The repository retains the audit summary and small fixtures, not another copy of the raw dataset. See `audit-summary.json`, `model-input-v1.json`, and `fixtures/` beside this document.

The verification script independently reconstructs all 1,152 features in each saved tensor directly from raw readings and checks ordering, bytes, hashes, latest-frame values, and labels. All five fixtures passed against the audited commit.

### Paste this instruction into the FPGA teammate's Claude

> Read `docs/research/FPGA_CLASSIFIER_HANDOFF.md` and `model-input-v1.json` before implementing. This is per-facility temporal multi-label classification, not direct action selection. Proposed input is `[1,12,96]`, channel-first, five-minute intervals, oldest-to-newest; proposed transport is signed int16 LE with scale 1/16384, zero point 0. Confirm compatibility with our core; do not silently substitute int8. Return four independent ordered logits: leak, degradation, failure, observed facility shut-in. Failure and shut-in can both be true; normal is all-zero targets. CSV/JSON parsing, metadata normalization, windowing, quality checks and action optimization stay on the host. Use the supplied binary fixtures to verify packing before training/export integration. CNN weights/output quantization are not supplied and must be produced and versioned by training. No accuracy, latency, power or resource claim has been established for the CNN/FPGA yet.
