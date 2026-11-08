// Pipe View: metro map on a dot-grid canvas. Every visual state is a function of clock.t via model.statusAt.
import { systems, facilities, colorOf, allStatus, clock, snapshot, FULL, T0, STEP, NOW, fmtCountdown, fmtBpd, fmtTime, subscribe, LIMITS } from './model.js';
import { computeLayout, X } from './layout.js';
import { installMasks, ensurePattern, ensureHatch, dissolve, reduced } from './dither.js';
import { createCamera } from './pv-camera.js';
import { createPackets } from './pv-packets.js';
import { showTip, hideTip } from './tip.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};
const pts = (p) => p.map((a) => a.join(',')).join(' ');
const NE = { 'vector-effect': 'non-scaling-stroke', fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'butt' };

let svg, defs, world, cam, packets, layout, hud;
const lines = new Map();

function csGroup(parent, x, y, cls = '') {
  const o = el('g', { transform: `translate(${x} ${y})` }, parent);
  return el('g', { class: 'cs ' + cls }, o);
}
function text(parent, x, y, cls, anchor = 'start') {
  const t = el('text', { x, y, class: 'lbl ' + cls, 'text-anchor': anchor }, parent);
  return t;
}

function buildLine(cluster, f, cl) {
  const fid = f.fac.id, c = f.color;
  const g = el('g', { class: 'line', tabindex: 0, 'data-fid': fid, 'data-k': 'flow', 'data-q': 0, style: `--c:${c}` }, cluster);
  g.setAttribute('role', 'img'); g.setAttribute('aria-label', fid);
  const vis = el('g', { class: 'vis' }, g);
  for (const w of f.wells) {
    el('polyline', { ...NE, points: pts(w.pts), class: 'wb', stroke: c, 'stroke-width': 2 }, vis);
    el('polyline', { ...NE, points: pts(w.pts), class: 'wgrey', stroke: '#6F675E', 'stroke-width': 2, 'stroke-dasharray': '3 3' }, vis);
  }
  el('polyline', { ...NE, points: pts(f.up), class: 'up', stroke: c, 'stroke-width': 3 }, vis);
  el('polyline', { ...NE, points: pts(f.dn), class: 'dn', stroke: c, 'stroke-width': 5 }, vis);
  const full = f.up.concat(f.dn.slice(1));
  [0.25, 0.5, 0.75].forEach((sev, i) => el('polyline', { ...NE, points: pts(full), class: `dith d${i + 1}`, stroke: `url(#${ensurePattern(defs, c, 1 - sev, 2)})`, 'stroke-width': 5 }, vis));
  el('polyline', { ...NE, points: pts(f.dn), class: 'red', stroke: '#FF3B30', 'stroke-width': 5 }, vis);
  el('polyline', { ...NE, points: pts(f.pipe), class: 'hatch', stroke: 'url(#hatchMag)', 'stroke-width': 12 }, vis);
  const st = el('g', { class: 'stations' }, g);
  for (const w of f.wells) {
    const s = csGroup(st, w.x, w.y);
    el('circle', { r: 3.5, class: 'wt', stroke: c }, s);
  }
  const t = csGroup(st, f.tank.x, f.tank.y);
  el('circle', { r: 17, class: 'ring' }, t);
  el('rect', { x: -9, y: -11, width: 18, height: 22, class: 'tbody', stroke: c }, t);
  const gauge = el('rect', { x: -7, y: -9, width: 14, height: 18, class: 'tfill', fill: `url(#${ensurePattern(defs, c, 0.55, 1)})` }, t);
  el('rect', { x: -9, y: -11 + 22 * (1 - LIMITS.shutdownPct / 100) - 0.5, width: 18, height: 1.2, class: 'tlimit' }, t);
  const badge = el('rect', { x: 8, y: -17, width: 8, height: 8, class: 'badge' }, t);
  const p = csGroup(st, f.pumpAt.x, f.pumpAt.y);
  el('circle', { r: 13, class: 'pring', stroke: 'url(#hatchMag)' }, p);
  el('circle', { r: 8, class: 'pbody', stroke: c }, p);
  el('polygon', { points: '-3,-4.5 5,0 -3,4.5', class: 'pglyph', fill: c }, p);
  const L = { g, vis, gauge, badge, ring: t.querySelector('.ring'), k: null, q: null, alarm: null, st: null };
  const id = csGroup(st, f.xs + 4, f.rowY - 15);
  text(id, 0, 0, 'id').textContent = fid;
  const tt = csGroup(st, f.tank.x, f.tank.y + 25); L.tankTxt = text(tt, 0, 0, 'num', 'middle');
  const fl = csGroup(st, f.mid.x, f.mid.y - 9); L.flowTxt = text(fl, 0, 0, 'num', 'middle');
  const sx = csGroup(st, f.mid.x, f.mid.y + 17); L.stateTxt = text(sx, 0, 0, 'state', 'middle');
  const al = csGroup(st, f.tank.x, f.tank.y + 35); L.alarmTxt = text(al, 0, 0, 'alarm', 'middle');
  el('polyline', { ...NE, points: pts(f.up.concat(f.dn.slice(1))), class: 'hit', stroke: 'transparent', 'stroke-width': 18 }, g);
  g.addEventListener('pointerenter', () => highlight(fid, true));
  g.addEventListener('pointerleave', () => { highlight(fid, false); hideTip(); });
  g.addEventListener('focus', () => highlight(fid, true));
  g.addEventListener('blur', () => { highlight(fid, false); hideTip(); });
  g.addEventListener('pointermove', (e) => showTip(tipHtml(L), e.clientX, e.clientY));
  lines.set(fid, Object.assign(L, { f, cl }));
  packets.add(fid, { up: f.up, upCum: f.upCum, dn: f.dn, dnCum: f.dnCum, color: c, leakS: 80 });
  return g;
}
function highlight(fid, on) {
  svg.classList.toggle('hl', on);
  for (const [id, L] of lines) L.g.classList.toggle('on', on && id === fid);
}

function build() {
  svg.innerHTML = '';
  defs = el('defs', {}, svg);
  installMasks(defs);
  ensureHatch(defs, 'hatchMag', '#FF2E88', 6);
  const dots = el('pattern', { id: 'dots', width: 28, height: 28, patternUnits: 'userSpaceOnUse' }, defs);
  el('circle', { cx: 1, cy: 1, r: 0.9, fill: 'rgba(255,238,214,0.2)' }, dots);
  el('rect', { width: '100%', height: '100%', fill: 'url(#dots)' }, svg);
  world = el('g', { id: 'world' }, svg);
  cam = createCamera(svg, world, dots, () => packets.redraw());
  packets = createPackets(document.getElementById('pk'), cam.cam);
  layout = computeLayout(systems, colorOf);
  cam.setLayout(layout.bounds, layout.clusters);
  for (const cl of layout.clusters) {
    const cg = el('g', { class: 'cluster', 'data-sys': cl.sys.id }, world);
    const title = csGroup(cg, cl.ox, cl.oy - 22);
    text(title, 0, 0, 'sys').textContent = `${cl.sys.id} SYSTEM`;
    text(title, 0, 13, 'dim').textContent = `${cl.sys.facilities.length} FACILITIES, FLEET ${cl.sys.fleetSize}`;
    const { x, y, r } = cl.term, tg = el('g', { class: 'terminus' }, cg);
    el('circle', { cx: x, cy: y, r, class: 'tring', ...{ 'vector-effect': 'non-scaling-stroke' } }, tg);
    el('circle', { cx: x, cy: y, r: r - 6, class: 'tring', 'vector-effect': 'non-scaling-stroke' }, tg);
    const dl = csGroup(tg, x, y + r + 8);
    text(dl, 0, 8, 'dim', 'middle').textContent = `DISPOSAL ${cl.sys.disposal.id}`;
    text(dl, 0, 20, 'num', 'middle').textContent = `${cl.sys.disposal.pressurePsi} PSI`;
    for (const f of cl.facs) buildLine(cg, f, cl);
  }
  buildHud();
}

function buildHud() {
  hud = document.getElementById('pv-hud');
  const key = (cls, label, pat = '') => `<span class="lg"><i class="sw ${cls}"></i>${label}</span>`;
  hud.innerHTML = `<div class="legend" aria-label="State encoding">${key('s-flow', 'FLOWING')}${key('s-idle', 'IDLE')}${key('s-red', 'PUMP DOWN')}${key('s-hatch', 'INSPECT')}${key('s-dith', 'NO DATA')}</div>
  <div class="zoomctl"><button type="button" data-z="out" aria-label="Zoom out">-</button><button type="button" data-z="fit" aria-label="Fit all">FIT</button><button type="button" data-z="in" aria-label="Zoom in">+</button></div>
  <div class="hint">DRAG PAN, CTRL SCROLL ZOOM, 0 FIT, 1-9 FRAME SYSTEM</div>`;
  hud.querySelector('.zoomctl').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const [W, H] = cam.size();
    if (b.dataset.z === 'fit') cam.frame(0); else cam.zoomAt(b.dataset.z === 'in' ? 1.25 : 0.8, W / 2, H / 2);
  });
}

// ---- per frame update from the playhead -----------------------------------------------------
function heldMin(fac, t) {
  const Q = FULL[fac.id].Q; let i = Math.max(0, Math.min(Q.length - 1, Math.round((Math.min(t, NOW) - T0) / STEP))), n = 0;
  const q = Q[i]; while (i >= 0 && Q[i] === q) { n++; i--; }
  return n * 5;
}
function stateText(st) {
  const inc = st.inc;
  if (st.q === 3) return 'NO DATA';
  if (st.kind === 'down') return st.countdownMin != null ? `SHUTDOWN ${fmtCountdown(st.countdownMin)}` : 'PLAN HOLDS';
  if (st.kind === 'shutin') return 'SHUT IN';
  if (st.kind === 'leak') return `INSPECT ${inc.estLeakBblPerDay} BBL/D EST`;
  if (st.kind === 'worn') return `INSPECT ${inc.capacityLossPct}% CAP LOSS`;
  if (st.q === 1) return `HELD ${heldMin(st.fac, clock.t)} MIN`;
  if (st.q === 2) return 'INVALID';
  return st.kind === 'idle' ? 'IDLE' : '';
}
function tipHtml(L) {
  const st = L.st, f = st.fac, rows = [];
  const r = (k, v) => rows.push(`<div class="tr"><span>${k}</span><b>${v}</b></div>`);
  r('STATE', stateText(st) || 'FLOWING');
  r('TANK', st.level == null ? 'UNKNOWN' : st.level.toFixed(1) + '%');
  r('PUMP FLOW', fmtBpd(st.pf) + (st.pf == null ? '' : ' BPD'));
  r('RECEIVE', fmtBpd(st.rf) + (st.rf == null ? '' : ' BPD'));
  r('WELLS', String(f.wells.length));
  if (st.q) r('QUALITY', ['VALID', 'HELD', 'INVALID', 'DROPPED'][st.q]);
  let band = '';
  if (st.countdownMin != null) {
    r('SHUTDOWN P10', fmtCountdown(st.p10)); r('SHUTDOWN P90', fmtCountdown(st.p90));
    band = '<div class="band" aria-hidden="true"></div><div class="tn">ESTIMATE, P10 TO P90</div>';
  }
  if (st.alarm) r('BOARD', (st.alarm === 'e_stop' ? 'E-STOP' : 'NIGHT SHIFT') + ' (DISPLAY ONLY)');
  return `<div class="th" style="--c:${colorOf(f)}">${f.id}</div>${rows.join('')}${band}`;
}

export function update(clk) {
  const inst = clk.instant, sts = allStatus(clk.t);
  svg.classList.toggle('inst', inst);
  for (const st of sts) {
    const L = lines.get(st.fac.id);
    if (L.k !== st.kind || L.q !== st.q) {
      const first = L.k == null, wasDown = L.k === 'down' || L.k === 'shutin';
      L.g.dataset.k = st.kind; L.g.dataset.q = st.q;
      if (!first) {
        dissolve(L.vis, inst);
        if (!inst && !wasDown && (st.kind === 'down') && !reduced()) L.ring.animate([{ transform: 'scale(0.6)', opacity: 0.9 }, { transform: 'scale(1.5)', opacity: 0 }], { duration: 700, iterations: 3, easing: 'cubic-bezier(0.23,1,0.32,1)' });
      }
      L.k = st.kind; L.q = st.q;
    }
    L.st = st;
    L.gauge.style.transform = `scaleY(${st.level == null ? 0 : Math.max(0, Math.min(1, st.level / 100))})`;
    L.g.dataset.gauge = st.level == null ? 'none' : 'ok';
    L.tankTxt.textContent = st.level == null ? 'UNKNOWN' : `${Math.round(st.level)}%`;
    L.flowTxt.textContent = st.q === 3 ? '' : st.kind === 'down' || st.kind === 'shutin' ? '0 BPD' : st.kind === 'idle' ? '' : `${fmtBpd(st.pf)} BPD`;
    L.stateTxt.textContent = stateText(st);
    L.alarmTxt.textContent = st.alarm ? (st.alarm === 'e_stop' ? 'E-STOP' : 'NIGHT SHIFT') + ' (BOARD, DISPLAY ONLY)' : '';
    if (st.alarm !== L.alarm) {
      L.badge.style.opacity = st.alarm ? 1 : 0;
      if (st.alarm && !inst && !reduced()) L.badge.animate([{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }, { opacity: 1 }], { duration: 700, easing: 'steps(1)' });
      L.alarm = st.alarm;
    }
    packets.set(st.fac.id, { kind: st.kind, flow: st.flow, inflow: st.inflow || 0, maxFlow: st.fac.pump.maxFlowBpd });
  }
  if (reduced()) packets.redraw();
}

/** Once per session: lines draw in from wells to disposal, then stations fade in, then packets start. */
function intro() {
  let seen = false;
  try { seen = sessionStorage.getItem('pv4-intro') === '1'; sessionStorage.setItem('pv4-intro', '1'); } catch (e) {}
  if (seen || reduced()) { packets.start(); return; }
  let i = 0, end = 0;
  svg.classList.add('intro');
  const ease = 'cubic-bezier(0.77,0,0.175,1)';
  for (const L of lines.values()) {
    const delay = i++ * 40;
    const draw = (sel, d0, dur) => L.g.querySelectorAll(sel).forEach((p) => {
      const len = p.getTotalLength() + 2;
      p.style.strokeDasharray = len;
      p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: dur, delay: delay + d0, easing: ease, fill: 'backwards' }).onfinish = () => { p.style.strokeDasharray = ''; };
    });
    draw('.wb', 0, 260); draw('.up', 120, 280); draw('.dn', 380, 320);
    end = Math.max(end, delay + 700);
    const st = L.g.querySelector('.stations');
    st.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: end - 200 + 100, easing: 'cubic-bezier(0.23,1,0.32,1)', fill: 'backwards' });
  }
  setTimeout(() => { svg.classList.remove('intro'); packets.start(); }, end + 340); // packets begin after the draw-in
}

export function initPipe() {
  svg = document.getElementById('pv');
  build();
  requestAnimationFrame(() => { cam.frame(0); intro(); update(clock); });
  subscribe(update);
  return { frame: (i) => cam.frame(i), zoom: (f) => { const [W, H] = cam.size(); cam.zoomAt(f, W / 2, H / 2); }, layout };
}
