# Beat the Shutdown: design rules (v3)

Approved 2026-11-07 by Gurneal: **Mockup A (macOS / visionOS)**, `public/mockups/a-macos.html`.
That file is the visual spec. The app matches it; changes to the look need his OK first.
Earlier rejected: v1 dark mission control ("looks AI"), v2 flat light ops console ("looks bad").

## Look
- A Mac window on a soft blue-grey backdrop: traffic lights, frosted sidebar, translucent toolbar.
- Glass cards: white at 62% with 30px blur, bright top edge, soft shadow, 18px radius.
- SF system font (`-apple-system`). Large titles bold with -0.022em tracking; big countdowns semibold, units small and grey.
- Apple system colors: blue #0A84FF for actions and water, red #FF3B30 for pump down and the 92% shutdown line,
  orange #FF9500 for leaks and worn pumps, green #248A3D for savings and approvals, NVIDIA green #76B900 only for Nemotron.

## Structure
- Sidebar: Overview, Replay week, Shift handoff, then Systems (status dot and facility count; click scrolls to that system).
- Toolbar: Now or Replay switch, dataset picker, "Agents run on NVIDIA Nemotron".
- Overview: title, one-line summary, four stat cards, pump cards (ring = tank fill toward 92%, countdown, recommended plan,
  cost and savings, action button), inspector rows (Create ticket), tank cards per system (vessel, red shutdown line).
- Pump card button opens the plan pop-up; "Approve plan" marks it approved on screen (no real dispatch yet).
- Plan steps read as clock times ("shut in well A2 at 13:51").

## Still true from before
- No middle dots or em dashes in UI text, no hype copy, color always paired with text.
- Respect reduced motion and reduced transparency.
