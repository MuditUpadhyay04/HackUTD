// Arrangement: expanded automation lanes (tank, inflow, pump, receive) and plan takes. SVG viewBox is 1000 wide, time on x.
import { FULL, T0, NOW, END, STEP, LIMITS, colorOf, facById, flowAt, levelAt, plan, optionOf, select, approve, fmtUsd, fmtCountdown, fmtBpd } from './model.js';

const SPAN = END - T0, NS = 'http://www.w3.org/2000/svg';
const X = (t) => (((t - T0) / SPAN) * 1000).toFixed(1);
const LANES = [['TANK', 'L', 100, '%'], ['INFLOW', 'IN', 1.25, ' BPD'], ['PUMP', 'PF', 1, ' BPD'], ['RECEIVE', 'RF', 1, ' BPD']];

function seriesPath(arr, max) {
  let d = '', pen = false;
  for (let i = 0; i < arr.length; i += 3) {
    const v = arr[i];
    if (Number.isNaN(v)) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${X(T0 + i * STEP)} ${(100 - Math.min(100, (v / max) * 100)).toFixed(1)}`; pen = true;
  }
  return d;
}
const curvePath = (curve) => curve.map((p, i) => `${i ? 'L' : 'M'}${X(NOW + p.min * 60)} ${(100 - p.pct).toFixed(1)}`).join('');
const svgWrap = (inner) => `<svg class="ln" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">${inner}</svg>`;
const limitLine = `<line class="shut" x1="0" x2="1000" y1="${100 - LIMITS.shutdownPct}" y2="${100 - LIMITS.shutdownPct}"/>`;

export function lanesEl(fac, failing) {
  const S = FULL[fac.id], c = colorOf(fac), box = document.createElement('div');
  box.className = 'lanes'; box.dataset.fid = fac.id;
  LANES.forEach(([name, key, mulMax], i) => {
    const max = key === 'L' ? 100 : (key === 'IN' ? S.base : S.pmax) * (key === 'IN' ? mulMax : 1);
    let inner = (i === 0 ? limitLine : '') + `<path class="data" d="${seriesPath(S[key], max)}" style="stroke:${c};opacity:${i === 0 ? 1 : 0.6}" />`;
    if (i === 0 && failing) {
      const dn = failing.options.find((o) => o.kind === 'do_nothing');
      inner += `<path class="proj dim" d="${curvePath(dn.levelCurve)}" style="stroke:${c}"/><path class="proj eff" data-eff d="${curvePath(plan.approved[failing.systemId] ? optionOf(failing).levelCurve : dn.levelCurve)}" style="stroke:${c}"/>`;
    }
    const r = document.createElement('div');
    r.className = 'row lane-row'; r.dataset.key = key;
    r.innerHTML = `<div class="hdr sub" style="--c:${c}"><span>${name}</span><b data-v></b></div><div class="lane">${svgWrap(inner)}</div>`;
    box.appendChild(r);
  });
  return box;
}

export function takesEl(inc) {
  const f = facById[inc.facilityId], c = colorOf(f), box = document.createElement('div');
  box.className = 'takes'; box.dataset.inc = inc.id;
  const head = document.createElement('div');
  head.className = 'row take-head';
  head.innerHTML = `<div class="hdr sub"><span>PLAN TAKES</span><button type="button" class="btn approve" data-approve="${inc.systemId}"></button></div><div class="lane"><span class="note">ACKNOWLEDGES THE PLAN, NO DISPATCH. CHEAPEST FIRST.</span></div>`;
  box.appendChild(head);
  inc.options.forEach((o, i) => {
    const r = document.createElement('div');
    r.className = 'row take'; r.dataset.kind = o.kind; r.tabIndex = 0;
    r.setAttribute('role', 'button');
    const trip = o.tripAtMin == null ? 'HOLDS' : `SHUTDOWN ${fmtCountdown(o.tripAtMin)}`;
    const ticks = o.truckArrivalsMin.filter((m) => m <= 1200).map((m) => `<line class="arr-tick" x1="${X(NOW + m * 60)}" x2="${X(NOW + m * 60)}" y1="82" y2="100"/>`).join('');
    const tripMark = o.tripAtMin != null && o.tripAtMin <= 1200 ? `<line class="trip" x1="${X(NOW + o.tripAtMin * 60)}" x2="${X(NOW + o.tripAtMin * 60)}" y1="0" y2="100"/>` : '';
    r.innerHTML = `<div class="hdr sub take-h"><span>${o.label}</span><b>${fmtUsd(o.cost)}</b><em>${trip}${i === 0 ? ', RECOMMENDED' : ''}</em></div>
      <div class="lane">${svgWrap(limitLine + tripMark + ticks + `<path class="proj eff" d="${curvePath(o.levelCurve)}" style="stroke:${c}"/>`)}</div>`;
    if (i === 0) r.classList.add('rec');
    r.addEventListener('click', () => select(inc.id, o.kind));
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); select(inc.id, o.kind); } });
    box.appendChild(r);
  });
  head.querySelector('.approve').addEventListener('click', () => approve(inc.systemId));
  return box;
}

/** Cheap per-notify refresh: readouts at the playhead, selected/approved take state, effective curve. */
export function refreshExpanded(root, t) {
  root.querySelectorAll('.lanes').forEach((box) => {
    const fac = facById[box.dataset.fid];
    box.querySelectorAll('.lane-row').forEach((r) => {
      const k = r.dataset.key, v = k === 'L' ? levelAt(fac, t) : flowAt(fac, k, t);
      r.querySelector('[data-v]').textContent = v == null ? 'UNKNOWN' : k === 'L' ? `${v.toFixed(0)}%` : fmtBpd(v);
    });
    const eff = box.querySelector('[data-eff]'), inc = [...root.querySelectorAll('.takes')].map((x) => x.dataset.inc).find((id) => id.includes(`_${fac.letter}@`));
    if (eff && inc) {
      const i = optionsOf(inc);
      eff.setAttribute('d', curvePath((plan.approved[i.systemId] ? optionOf(i) : i.options.find((o) => o.kind === 'do_nothing')).levelCurve));
    }
  });
  root.querySelectorAll('.takes').forEach((box) => {
    const inc = optionsOf(box.dataset.inc), sel = optionOf(inc).kind, ok = !!plan.approved[inc.systemId];
    box.querySelectorAll('.take').forEach((r) => { r.classList.toggle('sel', r.dataset.kind === sel); r.setAttribute('aria-pressed', String(r.dataset.kind === sel)); });
    const b = box.querySelector('.approve');
    b.textContent = ok ? 'APPROVED' : 'APPROVE'; b.classList.toggle('done', ok); b.disabled = ok;
  });
}
import { failures } from './model.js';
const optionsOf = (id) => failures.find((i) => i.id === id);
