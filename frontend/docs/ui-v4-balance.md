# UI v4.1 "balance" pass

Feedback (Jason, 2026-11-08): still too far toward technical mission control. Find the balance between the classic
v3 console (`/classic`) and v4. Add a side panel with a simpler overview, auto-play the animations, and keep
pushing toward a simpler, cleaner, still fairly info-dense solution.

## What each side does well
- **Classic**: one plain-English sentence that says what's wrong ("Two pumps in System 5 are down and share two
  trucks."), four big friendly numbers, pump cards with a huge countdown ("2h 03m until the tank reaches shutdown at
  17:33"), the recommended plan in words with its cost and savings, short lists ("Send an inspector",
  "Check sensors"). Nothing to decode.
- **v4**: the metro map shows the whole network and flow at a glance; the timeline shows history; the projection
  makes plans tangible (trucks driving, tanks filling); density and polish.

## Direction
**Left = the story in motion (map + compact timeline). Right = the facts in plain English (overview panel).**
The overview is pinned to the latest reading and never churns; the map/timeline animate by themselves.

### Layout (1440x900 first)
```
rail 60 | MAIN (flex)                                  | OVERVIEW PANEL 380px
        | Pipe View (hero, ~62% height)                | header: network name + plain sentence
        |                                              | 4 big stats
        | Timeline (compact, ~38%)                     | Pumps down cards (big countdown, plan, Approve)
        | Truck road (only when trucks planned)        | Send an inspector / Check sensors lists
        | transport (48)                               | Detection note, systems health, Nemotron handoff
```
- **Remove the top ticker strip.** Its numbers move into the overview's stat row (digits still roll on change).
  Fewer bands of chrome; the "now" time lives in the transport.
- Overview panel is collapsible (chevron; remembered per viewer in localStorage with try/catch). Below 1280px wide
  it becomes an overlay sheet from the right.

### Overview panel content (port classic's logic, v4's look)
1. Title "Water network" (or dataset label) + date/time of the latest reading + **one plain sentence** built like
   classic's headline (`components/console/console.tsx` headline logic: counts as words, shared trucks, inspections),
   **but fixed**: "no recent readings" only when key readings are actually missing/HELD/INVALID/DROPPED
   (`dataQuality.quality !== "VALID"`), never because `health === "unknown"`.
2. Stat row: Pumps down, First shutdown, Plan cost, If nobody acts. Big numbers (Martian Grotesk 26-28px, medium),
   small labels. Unknown stays "Unknown".
3. **Pumps down** cards, soonest shutdown first (hard rule 7): facility name, "Pump down since 14:00", big countdown
   "2h 03m" + "until the tank reaches shutdown at 17:33" (p10 to p90 as a soft dithered band under it), recommended
   plan in words with clock times, cost and "saves $4,734 vs doing nothing", Approve (same `approvePlan`; reads
   "Acknowledged, not dispatched" after). Hover a card = focus that facility on the map.
4. **Send an inspector** rows (leak / worn pump) and **Check sensors** rows (real data-quality problems only).
5. **Detection note** when classifier output is unavailable (facilities with `health === "unknown"` and no model
   scores / board unavailable): one calm line, e.g. "Leak and wear checks are off: no model is loaded. Pump failures
   are still detected from the readings." Never imply "no leaks" (hard rule 9). Inspect counts read "Unavailable"
   in that case, not 0.
6. **Systems**: compact list, one row per system: status dot+word, facilities, trucks free.
7. **Shift handoff** (Nemotron): the latest handoff text, labeled model-written or deterministic draft, collapsed to
   3 lines with "Read more".

### Auto-play (the animations run by themselves)
- After the first-load draw-in, auto-play a **showcase loop**: from `now - 12h` (or window start) through the
  projection end (or `now` when there is no failure), sized to ~25 s per loop, looping. Map packets, tank gauges,
  timeline playhead and trucks all move. The overview stays pinned to the latest reading.
- A small pill in the transport: "Auto-playing the last 12 hours and the projection" + Stop. Any user interaction
  with the transport, keyboard shortcuts, the timeline ruler or the map camera stops auto-play and hands control to
  the user; it does not restart on its own in this session.
- `prefers-reduced-motion`: no auto-play (static at the latest reading).
- Pause while the tab is hidden (already true for the rAF loop).

### Calmer visuals (closer to classic warmth, still dark)
- Base text 14px; overview uses generous line-height and fewer borders (sections separated by spacing and one soft
  hairline, not boxes inside boxes).
- Pipe View: lines 20% thinner, grid dots fainter, station glyphs smaller; facility names readable at fit zoom when
  space allows; problem pills stay.
- Timeline compact by default: only tracks with incidents in the loaded window plus failing facilities' tank lane;
  everything else under "N more facilities". Nemotron notes move to the overview (timeline keeps a small marker).

## Ownership for this pass
| Worker | Files |
| --- | --- |
| O (overview) | new `components/v4/overview/**`, new `lib/v4/overview*.ts` (+ tests). Export `OverviewPanel({ snapshot }: { snapshot: Snapshot })` from `components/v4/overview/overview-panel.tsx` (create this file first, compiling). |
| L (layout, autoplay, timeline) | `components/v4/{shell,rail,app}.tsx`, `src/app/v4.css`, `lib/v4/store.tsx` (autoplay), `components/v4/transport/**`, `components/v4/arrangement/**`, `lib/v4/arrangement-*.ts`, `components/v4/trucks/**`. Mounts `OverviewPanel` and stops mounting `Ticker`. |
| P (pipe view) | `components/v4/pipeview/**`, `lib/v4/pipeview-*.ts` |
Shared rules unchanged: brief hard rules, Emil motion rules, sentence case, no middle dots or em dashes.
