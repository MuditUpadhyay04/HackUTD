// Arrangement: Ableton style tracks. Time runs left to right across the week plus the projected zone. Amber playhead.
import { systems, facilities, facById, colorOf, allIncidents, failures, clock, snapshot, FULL, T0, NOW, END, N, STEP, setTime, subscribe, allStatus, fmtDay, fmtTime, fmtUsd } from './model.js';
import { NOTES } from './data.js';
import { lanesEl, takesEl, refreshExpanded } from './arr-lanes.js';
import { showTip, hideTip } from './tip.js';

const SPAN = END - T0, pct = (t) => ((t - T0) / SPAN) * 100;
const open = Object.fromEntries(systems.map((s) => [s.id, s.facilities.some((f) => failures.some((i) => i.facilityId === f.id))]));
const expanded = Object.fromEntries(facilities.map((f) => [f.id, failures.some((i) => i.facilityId === f.id)]));
let root, body, ph, phWrap, readouts = [];

const CAT = { pump_failure: ['fail', 'PUMP DOWN'], pipeline_leak: ['insp', 'INSPECT LEAK'], pump_degradation: ['insp', 'INSPECT WORN PUMP'] };
const clipHtml = (cls, a, b, label, extra = '') => {
  const l = Math.max(0, pct(a)), r = Math.min(100, pct(b));
  return `<div class="clip ${cls}" style="left:${l}%;width:max(4px,${r - l}%)" ${extra}><span>${label}</span></div>`;
};
function qRuns(fid) {
  const Q = FULL[fid].Q, out = [];
  for (let i = 0; i < N; i++) if (Q[i]) { let j = i; while (j + 1 < N && Q[j + 1] === Q[i]) j++; out.push([i, j, Q[i]]); i = j; }
  return out;
}
function clipsFor(fid) {
  let h = '';
  for (const i of allIncidents.filter((x) => x.facilityId === fid)) {
    const [cls, label] = CAT[i.category];
    h += clipHtml(cls, i.onsetUnix, i.endUnix ?? END, label, `data-inc="${i.id}"`);
  }
  for (const [a, b, q] of qRuns(fid)) h += clipHtml(`nodata q${q}`, T0 + a * STEP, T0 + (b + 1) * STEP, q === 3 ? 'NO DATA' : q === 2 ? 'INVALID' : 'HELD');
  return h;
}

function ruler() {
  let h = '';
  for (let t = Math.ceil(T0 / 21600) * 21600; t <= END; t += 21600) {
    const hr = new Date(t * 1000).getUTCHours(), day = hr === 0;
    h += `<span class="tk${day ? ' day' : ''}" style="left:${pct(t)}%">${day ? fmtDay(t) : String(hr).padStart(2, '0')}</span>`;
  }
  return `${h}<span class="tk nowtk" style="left:${pct(NOW)}%">NOW</span>`;
}
function gridSvg() {
  let h = '';
  const total = Math.round(SPAN / 3600);
  for (let i = 0; i <= total; i++) {
    const t = Math.ceil(T0 / 3600) * 3600 + i * 3600, six = (new Date(t * 1000).getUTCHours() % 6) === 0;
    h += `<line class="${six ? 'g6' : 'g1'}" x1="${((t - T0) / SPAN) * 1000}" x2="${((t - T0) / SPAN) * 1000}" y1="0" y2="1"/>`;
  }
  return `<svg class="grid" viewBox="0 0 1000 1" preserveAspectRatio="none" aria-hidden="true">${h}</svg>`;
}

function rowHtml(cls, hdr, lane, attrs = '') { return `<div class="row ${cls}" ${attrs}><div class="hdr">${hdr}</div><div class="lane">${lane}</div></div>`; }

function renderBody() {
  const scroll = body.scrollTop;
  readouts = [];
  let h = '<div class="inner">' + gridSvg() + `<div class="projband" style="--f:${pct(NOW) / 100}"></div>`;
  h += rowHtml('nem', '<span class="nvtag">NEMOTRON</span><em>NOTES</em>', NOTES.map((n) => {
    const right = pct(n.t) > 62;
    return `<button type="button" class="clip note ${n.source}" style="${right ? `right:${100 - pct(n.t)}%` : `left:${pct(n.t)}%`}" data-note="${n.id}"><i class="nvdot"></i><b>${n.source === 'model' ? 'MODEL' : 'DRAFT'}</b><span>${n.text}</span></button>`;
  }).join(''));
  h += '</div>';
  body.innerHTML = h;
  const inner = body.firstChild;
  for (const sys of systems) {
    const g = document.createElement('div');
    g.innerHTML = rowHtml('group', `<button type="button" class="chev" data-g="${sys.id}" aria-expanded="${open[sys.id]}" aria-label="Toggle ${sys.id}"></button><b>${sys.id}</b><em>${sys.facilities.length} FACILITIES</em>`,
      open[sys.id] ? '' : sys.facilities.map((f) => clipsFor(f.id)).join(''));
    inner.appendChild(g.firstChild);
    if (!open[sys.id]) continue;
    for (const f of sys.facilities) {
      const c = colorOf(f), fail = failures.find((i) => i.facilityId === f.id);
      const row = document.createElement('div');
      row.innerHTML = rowHtml('track', `<button type="button" class="chev" data-f="${f.id}" aria-expanded="${expanded[f.id]}" aria-label="Toggle ${f.id} lanes"></button><i class="chip" style="background:${c}"></i><span class="nm">${f.id.replace(/^S\d_FACILITY_/, 'FAC ')}</span><b data-ro="${f.id}"></b>`, clipsFor(f.id), `style="--c:${c}" data-fid="${f.id}"`);
      inner.appendChild(row.firstChild);
      if (expanded[f.id]) {
        inner.appendChild(lanesEl(f, fail));
        if (fail) inner.appendChild(takesEl(fail));
      }
    }
  }
  readouts = [...body.querySelectorAll('[data-ro]')];
  body.scrollTop = scroll;
  bind(inner);
}

function bind(inner) {
  inner.addEventListener('click', (e) => {
    const g = e.target.closest('[data-g]'), f = e.target.closest('[data-f]');
    if (g) { open[g.dataset.g] = !open[g.dataset.g]; renderBody(); sync(clock); g.focus?.(); }
    else if (f) { expanded[f.dataset.f] = !expanded[f.dataset.f]; renderBody(); sync(clock); }
  });
  inner.querySelectorAll('.clip[data-inc]').forEach((c) => {
    c.addEventListener('pointermove', (e) => {
      const i = allIncidents.find((x) => x.id === c.dataset.inc);
      showTip(`<div class="th">${i.facilityId}</div><div class="tr"><span>INCIDENT</span><b>${CAT[i.category][1]}</b></div><div class="tr"><span>FROM</span><b>${fmtTime(i.onsetUnix)}</b></div><div class="tr"><span>TO</span><b>${i.endUnix ? fmtTime(i.endUnix) : 'ONGOING'}</b></div>` +
        (i.evidence.map((x) => `<div class="tn">${x}</div>`).join('')), e.clientX, e.clientY);
    });
    c.addEventListener('pointerleave', hideTip);
  });
  inner.querySelectorAll('.clip.note').forEach((c) => {
    const n = NOTES.find((x) => x.id === c.dataset.note);
    const show = (x, y) => showTip(`<div class="th nv">${n.source === 'model' ? 'NEMOTRON, MODEL WRITTEN' : 'DETERMINISTIC DRAFT, NOT MODEL WRITTEN'}</div><div class="tr"><span>ABOUT</span><b>${n.facilityId}</b></div><div class="tr"><span>AT</span><b>${fmtTime(n.t)}</b></div><div class="tn full">${n.text}</div><div class="tn">ADVISES ONLY, NEVER DISPATCHES</div>`, x, y);
    c.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
    c.addEventListener('focus', () => { const r = c.getBoundingClientRect(); show(r.left, r.bottom); });
    c.addEventListener('blur', hideTip); c.addEventListener('pointerleave', hideTip);
  });
}

function sync(clk) {
  const w = phWrap.clientWidth, x = ((clk.t - T0) / SPAN) * w;
  ph.style.transform = `translateX(${x}px)`;
  const st = allStatus(clk.t);
  for (const r of readouts) {
    const s = st.find((q) => q.fac.id === r.dataset.ro);
    r.textContent = s.level == null ? 'UNKNOWN' : `${Math.round(s.level)}%`;
    r.className = s.kind === 'down' || s.kind === 'shutin' ? 'red' : s.kind === 'nodata' ? 'unk' : '';
  }
  refreshExpanded(body, clk.t);
  root.querySelector('.rtime').textContent = fmtTime(clk.t);
}

export function initArrangement() {
  root = document.getElementById('arr');
  root.innerHTML = `<div class="ruler"><div class="hdr"><b>ARRANGEMENT</b><em class="rtime"></em></div><div class="lane">${ruler()}<div class="phtri"></div></div></div>
    <div class="body" tabindex="0" aria-label="Tracks"></div><div class="phwrap"><div class="ph"></div></div>`;
  body = root.querySelector('.body'); ph = root.querySelector('.ph'); phWrap = root.querySelector('.phwrap');
  renderBody();
  // scrub: drag on the ruler or any lane
  let down = false;
  const seek = (e) => {
    const r = phWrap.getBoundingClientRect();
    setTime(T0 + Math.round((((e.clientX - r.left) / r.width) * SPAN) / STEP) * STEP);
  };
  const onDown = (e) => {
    if (e.button !== 0 || !e.target.closest('.lane, .ruler .lane') || e.target.closest('.clip.note, .take, button')) return;
    down = true; clock.playing = false; root.setPointerCapture(e.pointerId); seek(e);
  };
  root.addEventListener('pointerdown', onDown);
  root.addEventListener('pointermove', (e) => { if (down) seek(e); });
  root.addEventListener('pointerup', () => { down = false; });
  new ResizeObserver(() => sync(clock)).observe(phWrap);
  subscribe(sync);
  sync(clock);
  // start scrolled to the first open system with a failure
  const t = body.querySelector('.track'); if (t) body.scrollTop = Math.max(0, t.offsetTop - 70);
}
