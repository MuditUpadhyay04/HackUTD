# UI v4 softening pass (meter.com direction)

Feedback (Jason, 2026-11-08): "feels a little too technical; soften it and make it feel more meter.com inspired."
Too technical = **hard edges**, **ALL-CAPS mono text**, **too much at once**. Keep: warm near-black + amber, neon
lines, the dot grid, dither as the uncertainty language, the metro map, the Arrangement/takes, trucks, transport,
every hard rule (missing data never healthy, projection labeled, approve is not dispatch). This pass changes the
*feel*, not the information model.

meter.com feel: calm, polished, friendly and still dense. Soft rounded surfaces, low-contrast borders, sentence case
in a clean sans, mono only for numbers, tinted pill badges, generous but efficient spacing, quiet chrome, details on
hover, gentle micro-motion.

## 1. Tokens (owner: worker S adds these to `src/app/v4.css` under `.v4`; others reference them with fallbacks,
e.g. `var(--r-md, 10px)`)

```css
--r-xs: 4px; --r-sm: 6px; --r-md: 10px; --r-lg: 14px; --r-pill: 999px;
--bg:        #0E0C0A;
--panel:     #151210;   /* region cards */
--panel-2:   #1B1814;   /* hover / raised rows */
--panel-3:   #221E19;   /* inputs, pressed */
--line:      rgba(255, 238, 214, 0.06);
--line-2:    rgba(255, 238, 214, 0.11);
--hi:        inset 0 1px 0 rgba(255, 240, 220, 0.035);   /* soft top highlight on cards */
--text:      #EEE8E0;  --muted: #A0968A;  --faint: #6B635A;
--tint-amber:   rgba(255, 180, 0, 0.12);
--tint-red:     rgba(255, 59, 48, 0.14);
--tint-magenta: rgba(255, 46, 136, 0.13);
--tint-neutral: rgba(255, 238, 214, 0.06);
--gap: 8px;            /* gutter between region cards */
--font-ui: "Martian Grotesk", ui-sans-serif, system-ui, sans-serif;
--font-num: "Martian Mono", ui-monospace, monospace;
```
Dither ink and dot-grid dots get ~30% lower contrast (softer grain, same meaning).

### 1b. Softer, Ableton-like palette (Jason: "the Ableton palette is softer than this")
Ableton's dark theme sits on **mid-dark greys, not near-black**, and its clip colors are **lighter, slightly
desaturated tints**, not full neon. Override the tokens above with these (keep the same names):

```css
--bg:      #1A1816;   /* warm charcoal, Ableton-like, not near-black */
--panel:   #23201D;
--panel-2: #2B2824;
--panel-3: #33302B;
--line:    rgba(255, 240, 225, 0.07);
--line-2:  rgba(255, 240, 225, 0.12);
--text:    #E6E0D8;  --muted: #A39A8F;  --faint: #6F675F;

/* line identities: soft Ableton clip tints (replace --n1..--n8). Never red, amber or magenta. */
--n1: #7FD3E6;  /* soft cyan   */   --n2: #B5DC72;  /* soft lime  */
--n3: #A79DEE;  /* soft violet */   --n4: #82A8F2;  /* periwinkle */
--n5: #72D9B3;  /* mint        */   --n6: #9FD0C8;  /* seafoam    */
--n7: #C9A3E2;  /* lilac       */   --n8: #D9D38A;  /* sand       */

/* status, softened but still unmistakable (always paired with text/pattern) */
--red:     #F0625A;   --tint-red: rgba(240, 98, 90, 0.16);
--magenta: #E56A9E;   --tint-magenta: rgba(229, 106, 158, 0.15);
--amber:   #FFB400;   /* brand stays, but used sparingly: playhead, focus, recommended, projection */
```
- Lines at 85-90% opacity with no glow; packets are small soft dots (line color lightened ~15%), not bright streaks.
- Idle lines ~35% of their tint; dimmed-on-hover lines ~30%.
- Clip bodies in the Arrangement use the line tint at ~70% with darker text on top (Ableton clip style), red/magenta
  clips use the softened status colors.
- Lane curves 1.5px in the facility tint; the shutdown limit line is a soft red dashed line.

## 2. Shape and surfaces (no hard edges)
- The shell becomes **inset region cards** on `--bg` with `--gap` gutters and `--r-lg` corners (ticker, Pipe View,
  Arrangement, truck road, transport), `1px solid var(--line)` + `box-shadow: var(--hi)`. No butted 1px dividers
  between regions. The rail becomes a slim card too.
- Buttons, selects, chips: `--r-sm` to `--r-md`; segmented controls (speed 1x/4x/16x) are a pill track with a sliding
  thumb (transform, 180ms ease-out). Popovers/palette: `--r-lg`, `--panel-2`, soft shadow
  `0 12px 32px -12px rgba(0,0,0,.6)`.
- Status = **pill badges**: tinted background + small dot/shape + sentence-case text (e.g. red tint "Pump down",
  magenta tint "Inspect", amber tint "Recommended", neutral "Idle", dither-backed "No data"). Color still never alone.
- Pipe View geometry: rounded line caps and joins, 45° bends become smooth arcs (radius 14-18 in map units),
  station glyphs are rounded (circles / rounded squares), tank gauges are rounded capsules. Clips in the Arrangement
  get `--r-xs` corners; lanes get rounded clip bodies.

## 3. Type (no ALL-CAPS mono)
- Remove `text-transform: uppercase` and wide letter-spacing everywhere in v4. **Sentence case**, Martian Grotesk
  (`--font-ui`), 13px base, 12px secondary in `--muted`, weight 500 for headings/values, 600 for the one hero number
  per card.
- Martian Mono (`--font-num`) **only** for numbers, times and money (tabular). IDs read in the UI font.
- Copy examples: "Pumps down", "First shutdown", "Plan cost", "If nobody acts", "Trucks free", "Board unavailable",
  "Projection, not recorded", "Following the approved plan", "Planned, not dispatched", "Acknowledged",
  "Last reading", "Replay". Keep the no-middle-dot / no-em-dash rule.

## 4. Less at once (progressive disclosure)
- **Ticker**: 5 primary cells (Now, Pumps down, First shutdown, Plan cost, Trucks free) as soft stat chips; the rest
  behind a "More" chip that opens a small popover. Unknown stays visibly "Unknown" (dithered chip).
- **Pipe View**: at fit zoom show system name, the lines, and status pills only for facilities with a problem. Flow
  numbers, well labels and tank % appear on hover of a line or at near zoom. The legend collapses to a small
  "Legend" pill. The projection overlay becomes one soft amber pill "Projection, not recorded. Following the
  approved plan" (top-left inside the card).
- **Arrangement**: systems without problems start collapsed; only failing facilities start expanded; lanes default to
  Tank only with "Inflow, pump, receive" behind a small toggle; plan takes show the recommended take and "Do
  nothing", with "Show N more options". Nemotron notes render as soft rounded note chips.
- **Transport**: primary row = play/pause, step, time, scrubber, speed, Live. Secondary (runtime, dataset, upload,
  sound, command palette) move into a dataset pill + a "..." menu on the right.
- **Truck road**: one calm header line ("S5 trucks, 0 of 2 free" + pills); sprites unchanged.

## 5. Motion (Emil rules still binding)
- Hover: background tint to `--panel-2`, 150ms ease, gated behind `(hover: hover) and (pointer: fine)`.
- Popovers/menus: 180ms `--ease-out` from `scale(.98)` + opacity, origin-aware; instant when keyboard-opened.
- Disclosure (expand lanes, show more takes): 200ms ease-out opacity + clip-path; keyboard toggles instant.
- Segmented thumb slide 180ms ease-out. Nothing else new.

## Ownership for this pass
| Worker | Files |
| --- | --- |
| S (shell) | `src/app/v4.css`, `components/v4/{shell,rail,app,loading}.tsx`, `components/v4/ticker/**`, `components/v4/transport/**`, `components/v4/trucks/**`, `lib/v4/format.ts`, ticker labels in `lib/v4/derive.ts` (`tickerAt` labels only) |
| P (pipe view) | `components/v4/pipeview/**`, `lib/v4/pipeview-*.ts` |
| A (arrangement) | `components/v4/arrangement/**`, `lib/v4/arrangement-*.ts` |
