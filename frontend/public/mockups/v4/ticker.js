// Ticker: static KV strip. Digits roll like an odometer on change, the changed cell gets an amber underline that fades (600ms).
import { snapshot, failures, systems, allStatus, optionOf, trucksBusy, subscribe, fmtTime, fmtCountdown, fmtUsd } from './model.js';

const CELLS = [
  ['now', 'NOW'], ['down', 'PUMPS DOWN'], ['first', 'FIRST SHUTDOWN'], ['plan', 'PLAN'], ['nobody', 'IF NOBODY ACTS'],
  ['trucks', 'TRUCKS FREE'], ['inspect', 'INSPECT'], ['nodata', 'NO DATA'], ['board', 'BOARD'], ['alarms', 'ALARMS LATCHED'],
];
const cells = {};

function setOdometer(cell, text, animate) {
  const prev = cell.text;
  if (prev === text) return;
  cell.text = text;
  const shape = (s) => [...s].map((c) => (/\d/.test(c) ? 'd' : c)).join('');
  if (shape(prev ?? '') !== shape(text)) {
    cell.val.innerHTML = [...text].map((c) => /\d/.test(c)
      ? `<span class="dg" data-d="${c}"><span class="strip" style="transform:translateY(${-c * 1.25}em)">${'0123456789'.replace(/./g, '<i>$&</i>')}</span></span>`
      : `<span class="ch">${c === ' ' ? '&nbsp;' : c}</span>`).join('');
    cell.val.setAttribute('aria-label', text);
  } else {
    [...text].forEach((c, i) => {
      if (!/\d/.test(c)) return;
      const dg = cell.val.children[i];
      if (dg.dataset.d !== c) { dg.dataset.d = c; dg.firstChild.style.transform = `translateY(${-c * 1.25}em)`; }
    });
    cell.val.setAttribute('aria-label', text);
  }
  if (prev != null && animate) cell.ul.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 600, easing: 'ease-out' });
}

export function initTicker() {
  const root = document.getElementById('ticker');
  root.innerHTML = CELLS.map(([k, label]) => `<div class="kv" data-k="${k}"><span class="k">${label}</span><span class="v"></span><i class="ul"></i></div>`).join('');
  for (const [k] of CELLS) {
    const e = root.querySelector(`[data-k="${k}"]`);
    cells[k] = { e, val: e.querySelector('.v'), ul: e.querySelector('.ul'), text: null };
  }
  subscribe(update);
  update({ t: snapshot.nowUnix, instant: true });
}

function update(clk) {
  const t = clk.t, sts = allStatus(t), anim = !clk.instant;
  const down = sts.filter((s) => s.kind === 'down' || s.kind === 'shutin');
  const act = failures.filter((i) => down.some((s) => s.fac.id === i.facilityId));
  const rem = down.filter((s) => s.countdownMin != null).map((s) => s.countdownMin);
  const sys = act.length ? systems.filter((s) => act.some((i) => i.systemId === s.id)) : systems;
  const size = sys.reduce((a, s) => a + s.fleetSize, 0), busy = sys.reduce((a, s) => a + trucksBusy(s, t), 0);
  const b = snapshot.board, unknown = (k, on) => cells[k].e.classList.toggle('unknown', on);
  const val = {
    now: fmtTime(t), down: String(down.length),
    first: rem.length ? fmtCountdown(Math.min(...rem)) : 'NONE',
    plan: act.length ? fmtUsd(act.reduce((a, i) => a + optionOf(i).cost, 0)) : 'NONE',
    nobody: act.length ? fmtUsd(act.reduce((a, i) => a + i.options.find((o) => o.kind === 'do_nothing').cost, 0)) : 'NONE',
    trucks: `${size - busy}/${size}`,
    inspect: String(sts.filter((s) => s.kind === 'leak' || s.kind === 'worn').length),
    nodata: String(sts.filter((s) => s.q === 3).length),
    board: !b || b.provenance === 'unavailable' ? 'BOARD UNAVAILABLE' : b.provenance === 'software' ? 'SOFTWARE, NOT BIT-EXACT' : `FPGA v${b.weightsVersion}`,
    alarms: String(sts.filter((s) => s.alarm).length),
  };
  for (const k in val) setOdometer(cells[k], val[k], anim);
  unknown('board', !b || b.provenance === 'unavailable');
  cells.down.e.classList.toggle('hot', down.length > 0);
  cells.nodata.e.classList.toggle('dim', false);
}
