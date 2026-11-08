// Wires everything to ONE shared playhead (model.clock). Every module renders as a pure function of clock.t.
import { clock, subscribe, systems, allStatus, STEP } from './model.js';
import { setCssVars } from './dither.js';
import { initTicker } from './ticker.js';
import { initPipe } from './pipeview.js';
import { initArrangement } from './arrangement.js';
import { initRoads } from './trucks.js';
import { initTransport } from './transport.js';
import { tick, twoTone } from './audio.js';

// Keyboard-initiated changes never animate: html.inst turns transitions off for that frame.
subscribe((c) => document.documentElement.classList.toggle('inst', !!c.instant));

setCssVars();
initTicker();
const pipe = initPipe();
initArrangement();
initRoads();
initTransport();

// Rail: frame buttons drive the camera. Later views are placeholders (whiteboard LATER, no click-through yet).
const rail = document.getElementById('rail');
rail.innerHTML = `<div class="logo" aria-hidden="true">PV</div><small>FRAME</small>` +
  `<button type="button" data-f="0" title="Fit all (0)">ALL</button>` +
  systems.map((s, i) => `<button type="button" data-f="${i + 1}" title="Frame ${s.id} (${i + 1})">${s.id}</button>`).join('') +
  `<div class="sp"></div><small>LATER</small><button type="button" aria-disabled="true" title="Later">ALRT</button><button type="button" aria-disabled="true" title="Later">PLAN</button>`;
rail.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (b) pipe.frame(+b.dataset.f);
});

// Sound cues (muted by default): tick per replayed step, two-tone on pump failure or a countdown under 1h.
let prev = null, prevStep = Math.floor(clock.t / STEP);
subscribe((c) => {
  const sts = allStatus(c.t), stepNow = Math.floor(c.t / STEP);
  if (c.playing && stepNow !== prevStep) tick();
  if (prev && c.playing) {
    for (const s of sts) {
      const p = prev.get(s.fac.id);
      if (!p) continue;
      const failed = s.kind === 'down' && p.kind !== 'down' && p.kind !== 'shutin';
      const hour = s.countdownMin != null && s.countdownMin < 60 && !(p.countdownMin != null && p.countdownMin < 60);
      if (failed || hour) { twoTone(); break; }
    }
  }
  prevStep = stepNow;
  prev = new Map(sts.map((s) => [s.fac.id, { kind: s.kind, countdownMin: s.countdownMin }]));
});
