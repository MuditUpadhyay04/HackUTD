// Truck road: one strip per system with an active pump failure. Positions are a pure function of clock.t and the plan schedule.
// Ghost (dashed) until the system's plan is approved, then solid. Always labeled PLANNED, NOT DISPATCHED.
import { systems, failures, facById, colorOf, clock, plan, trucksOf, truckState, trucksBusy, subscribe, STEP, NEON } from './model.js';
import { dissolve, reduced } from './dither.js';

const NS = 'http://www.w3.org/2000/svg';
const SPR = ['.########.......', '.########..####.', '.########.######', '.##############.', '.##############.', '..##..##...##...'];
const PX = 2, SW = 16 * PX, SH = SPR.length * PX, YARD_X = 74, ROAD_Y = 40, H = 54;
const roads = [];

function sprite() {
  const g = document.createElementNS(NS, 'g');
  let h = '';
  SPR.forEach((row, y) => [...row].forEach((c, x) => {
    if (c !== '#') return;
    const dith = x < 9 && y > 0 && y < 5 && (x + y) % 2 === 1; // tank body is dithered, cab and wheels solid
    h += `<rect x="${x * PX}" y="${y * PX}" width="${PX}" height="${PX}" fill="currentColor" ${dith ? 'opacity="0.35"' : ''}/>`;
  }));
  g.innerHTML = `<rect class="outline" x="-3" y="-3" width="${SW + 6}" height="${SH + 6}" rx="1"/>${h}`;
  return g;
}

export function initRoads() {
  const host = document.getElementById('road');
  const sysList = [...new Set(failures.map((i) => i.systemId))].map((id) => systems.find((s) => s.id === id));
  host.innerHTML = '';
  for (const sys of sysList) {
    const d = document.createElement('div');
    d.className = 'rd';
    d.innerHTML = `<div class="rh"><b>TRUCK ROAD ${sys.id}</b><span class="tag warn">PLANNED, NOT DISPATCHED</span><span class="tag appr" data-r="appr"></span><span class="free" data-r="free"></span></div>
      <svg class="rsvg" height="${H}" role="img" aria-label="Truck road for ${sys.id}"></svg>`;
    host.appendChild(d);
    const svg = d.querySelector('svg');
    const fcs = sys.facilities, trucks = Array.from({ length: sys.fleetSize }, (_, i) => ({ truck: i + 1 }));
    const R = { sys, svg, appr: d.querySelector('[data-r=appr]'), free: d.querySelector('[data-r=free]'), stops: {}, trucks: [], approved: null, W: 0 };
    svg.innerHTML = `<line class="road" x1="8" y1="${ROAD_Y + SH + 2}" x2="100%" y2="${ROAD_Y + SH + 2}"/><g class="yard"><rect x="8" y="${ROAD_Y - 14}" width="58" height="${SH + 18}"/><text x="14" y="${ROAD_Y - 3}">YARD</text></g><g class="stops"></g><g class="fleet"></g>`;
    const stopsG = svg.querySelector('.stops'), fleetG = svg.querySelector('.fleet');
    fcs.forEach((f) => {
      const down = failures.some((i) => i.facilityId === f.id), g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'stop' + (down ? ' down' : ''));
      g.innerHTML = `<title>${f.id}</title><line y1="${ROAD_Y - 6}" y2="${ROAD_Y + SH + 8}"/><text y="${ROAD_Y - 10}" text-anchor="middle" style="fill:${down ? 'var(--red)' : 'var(--muted)'}">${f.id.replace(/^S\d_FACILITY_/, '')}</text>`;
      stopsG.appendChild(g); R.stops[f.id] = g;
    });
    for (const tr of trucks) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'truck');
      const s = sprite();
      const lab = document.createElementNS(NS, 'text');
      lab.setAttribute('y', -6); lab.setAttribute('x', 0); lab.textContent = `T${tr.truck}`;
      g.append(s, lab); g.dataset.truck = tr.truck;
      fleetG.appendChild(g); R.trucks.push({ tr, g });
    }
    roads.push(R);
    new ResizeObserver(() => layout(R)).observe(svg);
  }
  subscribe(update);
  roads.forEach(layout); update(clock);
}

function layout(R) {
  R.W = R.svg.getBoundingClientRect().width;
  const fcs = R.sys.facilities, x0 = 130, x1 = Math.max(x0 + 100, R.W - 40);
  fcs.forEach((f, i) => {
    const x = x0 + (fcs.length === 1 ? 0 : (i * (x1 - x0)) / (fcs.length - 1));
    R.stops[f.id].dataset.x = x; R.stops[f.id].setAttribute('transform', `translate(${x} 0)`);
  });
  position(R);
}
function position(R) {
  const t = reduced() ? Math.floor(clock.t / STEP) * STEP : clock.t, truckSet = trucksOf(R.sys);
  R.trucks.forEach((o, i) => {
    const tr = truckSet[i];
    if (!tr) { o.g.style.display = 'none'; return; }
    o.g.style.color = colorOf(facById[tr.facilityId]);
    o.g.querySelector('text').textContent = `T${tr.truck}`;
    const sx = +R.stops[tr.facilityId].dataset.x, st = truckState(tr, t);
    const x = YARD_X + st.p * (sx - SW / 2 - YARD_X), lane = (i % 2) * 0;
    const flip = st.mode === 'back';
    o.g.style.display = '';
    o.g.setAttribute('transform', flip ? `translate(${x + SW} ${ROAD_Y + lane}) scale(-1 1)` : `translate(${x} ${ROAD_Y + lane})`);
    o.g.dataset.mode = st.mode;
    const lab = o.g.querySelector('text');
    lab.setAttribute('transform', flip ? `translate(${SW} 0) scale(-1 1)` : '');
  });
}
function update(clk) {
  for (const R of roads) {
    const ok = !!plan.approved[R.sys.id];
    if (R.approved !== ok) {
      const first = R.approved === null;
      R.approved = ok;
      R.svg.classList.toggle('approved', ok);
      R.appr.textContent = ok ? 'APPROVED, ACKNOWLEDGED' : 'RECOMMENDED, NOT APPROVED';
      R.appr.classList.toggle('ok', ok);
      if (!first) R.trucks.forEach((o) => dissolve(o.g, clk.instant));
    }
    position(R);
    const size = R.sys.fleetSize;
    R.free.textContent = `TRUCKS FREE ${size - trucksBusy(R.sys, clk.t)}/${size}`;
  }
}
