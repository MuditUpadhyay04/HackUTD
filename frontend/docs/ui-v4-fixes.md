# UI v4 integration fixes (found in browser on mock_test_2026-10-10T1530, 1440x900)

1. **Approve returns 409 PLAN_MISMATCH.** `approvePlan` in `src/lib/v4/store.tsx` sends `plan.id`; the API contract
   (`packages/contracts`, `apps/api/src/application.ts` operatorAction) expects `planId = incident.plan.systemPlanId`
   and `revision = snapshot.revision`. A system plan is shared by every failing incident in that system: on success,
   mark the systemPlanId AND every incident whose `plan.systemPlanId` matches as approved, so all of that system's
   trucks turn solid and every recommended take reads ACKNOWLEDGED. On 409 STALE_PLAN show "PLAN CHANGED, REFRESHING"
   and let the snapshot resync. Also: on load, GET `/runs/:id/actions` and pre-mark already-acknowledged plans
   (persistence, global_plan I-13). Type these via `@hackutd/contracts` instead of casts.
2. **Server-side dataset fetch 503.** The Eden base on the server was `http://localhost/api/backend` (no port, hits
   port 80). The console at `/` loads datasets in the client `Workspace`.
3. **Ticker shows "BOARD BOARD UNAVAILABLE".** The label is repeated in the value. Value should be `UNAVAILABLE`
   (or `FPGA v4` / `SOFTWARE, NOT BIT-EXACT`).
4. **Truck road header text overlaps** (`SYSTEM S5 TRUCKS FREE 0/3` runs into the next element; the
   `PLANNED, NOT DISPATCHED` / `RECOMMENDED, NOT APPROVED` tags stack awkwardly). Lay the header out as one row:
   system, trucks free, then the two tags, with ellipsis rather than overlap.
5. **Space at the end of data does nothing.** When `t` is at the end of the loaded window and the dataset has no later
   data, Play should seek to the start of the loaded window and play (DAW behavior), not sit still.
6. **Plan take label** shows API text "1 truck(s), 1 trip(s)"; fine to keep, but make sure the two-line header never
   truncates the cost line.
7. **Wire Pipe View camera to the rail and palette.** Pipe View listens for
   `window.dispatchEvent(new CustomEvent("v4:pipeview", {detail: {action: "fit"|"frame"|"zoom-in"|"zoom-out", index?}}))`.
   Rail system buttons should dispatch `frame` with that system's index (and set store focus `{kind:"system"}`);
   the command palette gets "Fit network" and "Frame system N" commands. Keyboard-initiated: no animation.
8. **Pass the real pane aspect to Pipe View fit.** Add an optional `targetAspect` (measured with ResizeObserver on the
   pane) so the system grid wraps to fill the actual pane instead of an assumed 2.6:1.
