# UI v5 plan: classic base, Kumo components, the best of the lab

Status: **PLAN, not built** (2026-11-08). Owner of UI-only decisions: Gurneal (global_plan.md). `/` stays the classic
console until v5 is approved; v5 is built at **`/next`**; the v4 experiment stays at **`/lab`** as a reference.

## Why this direction
v4 (`/lab`) proved the ideas but landed too far toward technical mission control, even after softening. v3 (classic,
`/`) is calm and readable but static. v5 goes the opposite way from v4: **start from classic's information
architecture and calm language**, rebuild it on **Kumo** (Cloudflare's MIT component system on Base UI + Tailwind 4,
the same stack classic already uses), and bring in only the lab pieces that earned their place.

## Decisions (from Jason, 2026-11-08)
| Topic | Decision |
| --- | --- |
| Base | Classic layout and copy: sidebar, toolbar, one-sentence headline, four stats, pump cards, inspector/sensor lists, network, tanks |
| Components | **Adopt `@cloudflare/kumo`** (docs list v2.17.0) with `@phosphor-icons/react`; `echarts` for charts |
| Theme | **Light default + dark toggle** (Kumo `data-mode`) |
| Keep from lab | Metro map + flow, truck road, projected playback, rolling-digit stats, dither = uncertainty, transport + keyboard, auto-play |
| Timeline | Helpful but too intense: keep its value in a **lighter form** (below); the full multi-track view stays in `/lab` |

## Layout (1440x900)
```
Sidebar (Kumo Sidebar)  | Toolbar: dataset select | transport (play, scrub, 1x/4x/16x, Live) | theme | Cmd+K
  Overview              | "Avon water network"  + one plain sentence                    (classic)
  Replay week           | [Pumps down] [First shutdown] [Plan cost] [If nobody acts]     rolling digits
  Shift handoff         | Network map card (metro map, flow, states)        | Pumps down (cards, soonest first)
  Systems (status)      |   auto-plays; projection pill when past now       |   countdown + dither band
                        |                                                   |   plan in words, savings, Approve
                        |                                                   |   "Watch the plan": truck road
                        | Send an inspector (table) | Check sensors (table) | Detection note
                        | Tanks (Meter per facility, grouped by system)
```

## Kumo mapping
| Classic element | v5 (Kumo) |
| --- | --- |
| macOS window + sidebar | `Sidebar` with status dots + words per system |
| Now / Replay toggle | segmented `Tabs` inside the toolbar transport |
| Dataset / runtime pickers | `Select`; upload in a `Dialog` (three runtime files only) |
| Stat cards | `LayerCard` + NumberFlow rolling digits; "Unknown" never `$0` |
| Pump card | `LayerCard` + `Badge` ("Pump down") + countdown + p10-p90 **dither band** + `Button` Approve |
| Plan pop-up | `Dialog`/`Layer Dialog`: options table (cheapest first), level chart, Approve (acknowledge only) |
| Inspector / sensor rows | `Table` (Resource List pattern) with tinted `Badge`s |
| Tank cards | `Meter` per facility with a shutdown marker; missing level = dithered meter, "Level unknown" |
| Approve feedback | `Toast` ("Acknowledged, not dispatched") |
| Command palette | Kumo `Command Palette` (Cmd+K) |
| Tank level charts | `TimeseriesChart` with `thresholds` (shutdown %), `markers` (incident onsets), `incomplete` (projected part) |
| Empty states | `Empty` |

Visual language: Kumo semantic tokens only (`bg-kumo-canvas/base/elevated/recessed/tint`, status `-tint` badges,
`border-kumo-hairline` on flat cards). Brand stays blue (classic `#0A84FF`, close to Kumo brand). Status colors map to
Kumo info/success/warning/danger; inspect states keep a hatch so color is never alone. Classic's SF system font for UI;
tabular numerals for all numbers. Dark mode: Kumo dark tokens tinted toward the lab's warm charcoal, with amber kept
only for the playhead and projection. Glass blur is dropped in favor of Kumo's layered cards (borders over shadows).

## The lab pieces, adapted
1. **Network map card.** Reuse `lib/v4/pipeview-layout.ts`, `pipeview-model.ts`, `pipeview-labels.ts`, `derive.ts`
   (layout, states, label lanes, fit) with a new renderer themed by Kumo tokens (light and dark). Flow packets, red
   pump down with countdown pill, inspect hatch, dither for missing data, "Leak and wear checks unavailable" in the
   tooltip when no model is loaded. Fit to card; hover shows details; click a facility opens its pump/plan dialog.
2. **Transport + keyboard.** Lives in the toolbar. Space, arrows, J/K/L, Cmd+K. Replaces classic's separate Replay
   timeline. The facts (headline, stats, cards) follow the committed run (live or `?at=` replay); the visuals (map,
   charts, trucks) follow the local playhead, as in the lab.
3. **Auto-play.** Map flow and trucks loop the last 12 hours and the projection on load; any interaction hands
   control back; never under reduced motion.
4. **Projected playback + truck road.** Each pump card gets "Watch the plan": the truck road for that system and the
   level chart play forward into a labeled projection (do nothing until approved, the recommended plan after).
   "Projection, not recorded" and "Planned, not dispatched" everywhere they apply (hard rules 6 and 12).
5. **Rolling digits** on stats and countdowns.
6. **Dither = uncertainty**: missing/held readings, the p10-p90 band, the projected region of charts, unknown meters.
7. **Timeline, lighter.** Two pieces instead of the arrangement: (a) inside each pump's plan dialog, a
   `TimeseriesChart` of tank level for the last 48 h plus the projection, with the shutdown threshold and incident
   markers; (b) in Replay view, a "Week at a glance" strip: one thin row per system with incident clips only, click to
   seek. No automation lanes or take stacks on the main screen.

Carry-over fixes: headline counts "no recent readings" only for real data-quality problems (not `health: unknown`);
a detection note when no classifier model is loaded; Approve persists through `POST/GET /runs/:id/actions` (I-13);
`/classic` already fixed.

## Phases and workers (implementation by non-Fable workers; this session orchestrates and reviews)
| Phase | Work | Gate |
| --- | --- | --- |
| 0. Kumo spike | Install `@cloudflare/kumo`, `@phosphor-icons/react`, `echarts`; Tailwind 4 setup (`@source` + `@import "@cloudflare/kumo/styles/tailwind"` before `tailwindcss`); `isolation: isolate` root; `LinkProvider` with Next `Link`; `data-mode` toggle with a no-flash inline script; render Button, LayerCard, Table, Badge, Meter, Toast, Command Palette, TimeseriesChart on `/next`. Confirm `/` (classic) and `/lab` look unchanged (token/class collisions with shadcn and v4.css). | Screenshots of `/next` light+dark and unchanged `/`, `/lab`; peer-dep and bundle report (echarts loaded dynamically) |
| 1. Shell | `/next` layout: Sidebar, toolbar with transport + theme + Cmd+K, headline + stats (reuse `lib/v4/overview.ts`), data via `lib/v4/use-run.ts` + `store.tsx` | Browser check on mock dataset |
| 2. Parallel | A: pump cards + plan dialog + Approve + Toast + level chart. B: network map card (port renderer) + auto-play. C: inspector/sensor tables, detection note, tanks meters, handoff. D: truck road + projected playback + week-at-a-glance strip | Each: tsc, tests, eslint, browser screenshots light+dark |
| 3. Integrate | 1280x720, 1440x900, projector-ish contrast, reduced motion, keyboard-only pass, both themes; Gurneal review | Approval to swap `/` to v5 |

## Risks
- Kumo's Tailwind preset next to shadcn tokens in one `globals.css` may collide: Phase 0 must prove classic is pixel
  stable; fall back to Kumo's standalone CSS scoped to `/next` if needed.
- React 19 / Next 16 / `@base-ui/react` version compatibility is not documented by Kumo: check `peerDependencies`.
- ECharts size: dynamic import, client-only.
- Dark mode flash in the App Router: inline script setting `data-mode` before paint.

## Open questions (for Gurneal and Jason)
- Keep SF system font, or Martian Grotesk/Mono from the lab for numbers only?
- Should Approve stay "Approve" or read "Acknowledge plan" to avoid implying dispatch?
- When v5 is approved, retire `/lab` or keep it as a demo route?
