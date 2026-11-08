# UI v4 "Pipe View": design brief

Status: **DRAFT for Jason's review** (2026-11-08). Replaces `frontend/DESIGN.md` (v3, macOS glass) once approved;
Gurneal owns UI-only matters (`global_plan.md`), so he signs off before this merges to `main`.
Branch: `feature/ui-v4-pipeview`. The v3 console stays at **`/`**. Pipe View is at **`/lab`**.

Every implementation worker reads this whole file first, plus `global_plan.md` §2 (hard rules).

---

## 1. The idea in one paragraph

An expert-operator instrument, not a dashboard. Dense, dark and warm like Ableton's Arrangement view: the
produced-water network is drawn as a **metro map** in which each facility's flow path is a neon line. A **transport**
(playhead, play, step) drives the whole screen through the recorded week, so scrubbing time moves the water, the tank
levels, the countdowns and the planned trucks together. Motion only ever means *something is flowing or something
changed*. Grain (ordered dither) only ever means *we are not sure*.

North star when references conflict: **Ableton** (density, dark, neon, everything visible at once, minimal chrome).
Supporting refs: meter.com (dense tables, topology viz, purposeful micro-motion, their system/workflow diagrams),
Cloudflare Kumo (consistent component system, borders over shadows), PlanetScale diagrams (packets on lines, crisp mono
labels, explains itself on first load, blueprint grid), Egg Inc (trucks driving along the bottom).

## 2. Screen anatomy (hero screen, 1440x900 first; must survive 1280x720 and a projector)

```
┌ TICKER ───────────────────────────────────────────────────────────────────────────────────┐ 32px static KV strip
├ RAIL ┬ PIPE VIEW (pan/zoom dot-grid canvas, metro lines per flow path) ───────────────────┤ ~45% height
│ 56px │                                                                                     │
│      ├ ARRANGEMENT (Ableton tracks: Nemotron track, one track per facility, plan takes) ───┤ ~40% height
│      │                                                     ▲ amber playhead                │
│      ├ TRUCK ROAD (per system with an active failure: yard → stops, ghost/solid trucks) ───┤ ~64px per system
└──────┴ TRANSPORT (play, step, time, speed, sound toggle) ─────────────────────────────────┘ 36px
```

### 2.1 Ticker (top)
Static strip, never scrolls. Monospace KV pairs separated by thin rules:
`NOW OCT 08 12:00` · `PUMPS DOWN 2` · `FIRST SHUTDOWN 13:51` · `PLAN $41,200` · `IF NOBODY ACTS $188,900` ·
`TRUCKS FREE 1/3` · `INSPECT 2` · `NO DATA 1` · `BOARD FPGA v4` (or `SOFTWARE, NOT BIT-EXACT`, or `BOARD UNAVAILABLE`) ·
`ALARMS LATCHED 0` (display only).
(Those separators are for this doc; in UI use thin vertical rules, never middle dots.)
Digits **roll** (odometer, `@number-flow/react` is already a dependency) when a value changes, and the changed cell
gets a brief amber underline that fades (600ms). That is the only motion in the ticker.
Unknown values read `UNKNOWN` in a dithered cell, never `0` or `$0` (hard rule 9).

### 2.2 Pipe View (metro map)
- **One neon line per facility flow path**: wells (small tick stations) → tank (station with a level gauge) → pump
  (station glyph) → pipeline (thick line) → merges into the system trunk → **disposal terminus** (double ring).
- Every system is drawn as its own map cluster on one **infinite dot-grid canvas** (graph paper, blueprint feel).
  Pan (drag, trackpad), zoom (pinch, ctrl+wheel, `+`/`-`), `0` fits all, `1`-`9` frames a system. Layout is computed
  from `network.json` order (hard rule 2: nothing hardcoded; any count up to 32 facilities / 8 wells). Lines use
  0/45/90 degree segments only, like a transit map.
- Mono labels on the diagram: asset IDs, flow in bpd, tank %. Labels counter-scale so they stay readable at any zoom.
- **First load explains itself (PlanetScale)**: lines draw in from wells to disposal with a 40ms stagger per line
  (`stroke-dashoffset`, 700ms, ease-in-out), then station glyphs fade in, then packets start. Once per session only.
- Hover = highlight that line (others dim to 35%) plus a small tooltip card. **No click-through routes yet**
  (whiteboard: "all things will eventually be clickable ... don't build this yet"), but every hit target already
  has hover/focus states and a cursor so wiring later is trivial.

#### State encoding: color + pattern + motion (never color alone)
| State | Line / station | Motion | Text |
| --- | --- | --- | --- |
| Flowing | line's own neon, solid | packets travel toward disposal; **speed and density ∝ pump flow bpd** | flow bpd |
| Idle (pump off, normal cycling) | neon at 40% | none | `IDLE` |
| Pump down (`pump_failure`) | segment after the pump turns **red #FF3B30**; tank station gets a red ring | packets stop; tank gauge rises with the playhead; ring pulses 3x on onset, then steady | countdown `SHUTDOWN 13:51` (p50) |
| Leak (`pipeline_leak`) | **magenta #FF2E88 45° hatch** over the pipeline segment | a few packets drift off the line at the leak point | `INSPECT` + est bbl/d |
| Worn pump (`pump_degradation`) | magenta hatch ring on the pump station | packets slow and stutter slightly | `INSPECT` + capacity loss % |
| Shut in | wells grey, dashed | none | `SHUT IN` |
| No data / HELD / INVALID / DROPPED | line rendered as **ordered dither** (grain), density by severity (HELD 25%, INVALID 50%, DROPPED/no data 75%) | none | `NO DATA` / `HELD 10 MIN` + reason |
| Board alarm latched (E-STOP / Night Shift) | small square amber badge on the station | blinks twice on raise, then steady | `E-STOP (BOARD, DISPLAY ONLY)` |

### 2.3 Arrangement (Ableton tracks)
- Time runs left to right across the dataset (start → "now" = last `ts_unix`, hard rule 3). Amber playhead.
- **Track 0: Nemotron annotation track.** Agent notes pinned to the time they refer to, NVIDIA green #76B900 marker
  only here. Each note says whether it is model-written or a deterministic draft (hard rules 12, 13).
- **One track per facility**, header colored with that facility's line neon, grouped by system (Ableton group tracks,
  collapsible). Clip bodies = incident spans (red pump down, magenta hatched inspect, dithered no-data spans).
  Expanding a track reveals automation lanes: tank level (with red shutdown line at `limits.shutdownPct`), inflow,
  pump flow, receive flow.
- **Plan takes**: under an active pump failure, its plan options (`do_nothing`, `trucks`, `shut_in`, `mixed`) stack
  like comp takes, each with its projected `levelCurve`, cost and trip time. Cheapest first (it is the recommended
  take, amber outline). `Approve` acknowledges the plan revision (no dispatch, hard rule 12) and turns that system's
  ghost trucks solid. Alerts order everywhere follows hard rule 7.
- Data density: 22px track height collapsed, mono 11px labels, 1px grid lines every hour, stronger every 6h.

### 2.4 Truck road (Egg Inc)
- A strip per system that has an active failure: `YARD` depot at left, facility stops along the road.
- Trucks are small **dithered pixel-art** sprites. Positions are a pure function of playhead time and the plan
  schedule (first arrival `response_min` after the call, then every `cycle_min`; unload; return). Never random.
- **Recommended, not approved** = dashed outline ghost trucks. **Approved** = solid. Always labeled
  `PLANNED, NOT DISPATCHED` (hard rule 12). Idle trucks park at the yard.
- Truck count per system = `emergency_fleet_size`; concurrent failures share it (hard rule 5).

### 2.5 Transport (bottom bar) and keyboard
- Play/pause, step back/forward 5 min, speed (1x = 5 min/s, 4x, 16x), current time, `LIVE` jump to "now".
- Keyboard: `Space` play/pause, `←`/`→` step 5 min, `J`/`K`/`L` scrub back/stop/forward, `⌘K` command palette,
  `0`-`9` canvas framing, `M` toggles sound. **Keyboard-initiated actions never animate** (Emil rule): the playhead
  jumps, panels appear instantly.
- **Sound cues**, muted by default (toggle in the transport): soft tick per replayed step while playing; a distinct
  two-tone when a pump fails or a countdown drops below 1h. WebAudio, generated, no files.

## 3. Visual tokens

```css
--bg:        #0D0B09;   /* near-black, warm */
--surface:   #15120F;
--raised:    #1D1915;
--line:      rgba(255, 238, 214, 0.08);
--line-2:    rgba(255, 238, 214, 0.16);
--text:      #F3EEE7;
--muted:     #A69C90;
--faint:     #6F675E;

--amber:     #FFB400;   /* brand, focus, selection, playhead, recommended */
--red:       #FF3B30;   /* pump down and the shutdown line ONLY */
--magenta:   #FF2E88;   /* inspect: leak, worn pump; always with a 45° hatch */
--nv:        #76B900;   /* Nemotron only */

/* neon line identities (per facility within a system, by network.json order). Never red, amber or magenta. */
--n1: #2CE5FF;  --n2: #B4FF39;  --n3: #A880FF;  --n4: #4D8DFF;
--n5: #3CFFB4;  --n6: #7AF0FF;  --n7: #C6A8FF;  --n8: #E4FF6B;
```
- **Type**: Martian Grotesk for UI text and headings (use its narrow widths for dense labels), Martian Mono for every
  number, ID, timestamp and the ticker. Sizes 11 / 12 / 13 / 15 / 20 / 28. Mono labels uppercase, +0.04em tracking.
  Tabular numerals everywhere. Martian Mono: `@fontsource-variable/martian-mono`. Martian Grotesk: vendor the woff2
  from the official `evilmartians/grotesk` GitHub repo (OFL) into `frontend/public/fonts/`; if that fails, fall back
  to Martian Mono and say so.
- **Surfaces (Kumo)**: borders over shadows. 1px `--line` borders, radius 3-6px, no glass, no blur, no gradients
  except dither.
- **Dither**: 4x4 Bayer ordered-dither patterns as SVG `<pattern>`s (and a CSS `background-image` equivalent) at
  25/50/75%. Used for: uncertainty (no-data, HELD, the p10-p90 band around a countdown), tank/gauge fills, pixel-art
  trucks and empty states, and **dither-dissolve** transitions (see §4).
- Copy rules kept from v3: no middle dots or em dashes in UI text, no hype copy, color always paired with text or
  pattern, missing data never reads as healthy.

## 4. Motion spec (Emil Kowalski rules, non-negotiable)

```css
--ease-out:    cubic-bezier(0.23, 1, 0.32, 1);   /* entering, UI response */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);  /* on-screen movement, line draw-in */
```
| What | Duration / easing | Notes |
| --- | --- | --- |
| Button / pressable `:active` | 120ms ease-out, `scale(0.97)` | every pressable |
| Hover color/opacity | 150ms ease | gate behind `@media (hover: hover) and (pointer: fine)` |
| Tooltip / popover | 160ms ease-out from `scale(0.97)` + opacity, origin-aware | instant (0ms) for subsequent tooltips |
| State change on a station/segment | 240ms ease-out | color + pattern swap via **dither-dissolve**: 4-step `steps(4)` mask, 280ms |
| Onset pulse (pump down, alarm) | 3 pulses then steady | never infinite |
| Packets, trucks driving | linear, continuous | the only infinite motion; encodes flow and schedule |
| First-load draw-in | 700ms ease-in-out, 40ms stagger | once per session |
| Ticker digit roll | NumberFlow defaults, then amber underline fade 600ms | |
| Keyboard actions | **no animation** | |

- Animate only `transform`, `opacity`, `clip-path`, `stroke-dashoffset`. Never width/height/top/left.
- Transitions, not keyframes, for anything retriggerable. CSS/WAAPI over JS rAF where possible; packets use SVG
  `offset-path`/`animateMotion` or a single canvas layer if count > ~300.
- `prefers-reduced-motion`: no packets (static arrowheads at density ∝ flow), no draw-in, dissolves become 150ms
  opacity fades, trucks jump between positions per step. Pulses become a static ring.
- Pause all infinite motion when the tab is hidden.

## 5. Routes and data

- `/` is the classic console. `/lab` is Pipe View. `/how-it-works` stays.
- Presentation only (global_plan §3): consume the existing `Snapshot` (`frontend/src/lib/engine/types.ts`) from the
  existing loaders/API proxy. No detector, planner or cost logic in the UI. Trucks, countdowns and costs come from
  `Incident.plan/options`, `FleetState`, `hoursToLimit`.
- Board provenance labels per hard rule 11. E-STOP / Night Shift display-only (hard rule 8).

## 6. Deferred (whiteboard "LATER")
Click-through sub-routes / modals / inspector panels; data-ingest launcher; plans and alerts management screens.
Design every hit target so these slot in later.
