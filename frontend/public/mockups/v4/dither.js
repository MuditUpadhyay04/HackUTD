// Bayer 4x4 ordered dither: SVG patterns, CSS data URIs, and the 4-step dither-dissolve.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Cells (x,y in 0..3) that are lit for a lit fraction 0..1. */
export function bayerCells(lit) {
  const n = Math.round(lit * 16), out = [];
  for (let i = 0; i < 16; i++) if (BAYER[i] < n) out.push([i % 4, (i / 4) | 0]);
  return out;
}
const rects = (lit, cell, color) =>
  bayerCells(lit).map(([x, y]) => `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${color}"/>`).join('');

/** CSS background-image value: dithered tile, `lit` fraction of cells painted. */
export function dataUri(color, lit, cell = 1) {
  const s = cell * 4;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" shape-rendering="crispEdges">${rects(lit, cell, color)}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
/** 45 degree hatch tile (inspect states). */
export function hatchUri(color, gap = 6, w = 1.3) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${gap}" height="${gap}"><path d="M-1 ${gap + 1}L${gap + 1} -1M-1 1L1 -1M${gap - 1} ${gap + 1}L${gap + 1} ${gap - 1}" stroke="${color}" stroke-width="${w}" fill="none"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
export function setCssVars() {
  const r = document.documentElement.style;
  for (const p of [25, 50, 75]) r.setProperty(`--dither-${p}`, dataUri('rgba(243,238,231,0.55)', p / 100, 1));
  r.setProperty('--dither-amber-50', dataUri('#FFB400', 0.5, 1));
  r.setProperty('--hatch-magenta', hatchUri('#FF2E88'));
}

const NS = 'http://www.w3.org/2000/svg';
/** Ensure an SVG <pattern> of `color` at lit fraction exists in defs; returns its id. */
export function ensurePattern(defs, color, lit, cell = 2) {
  const id = `dp${color.slice(1)}_${Math.round(lit * 100)}`;
  if (!defs.querySelector('#' + id)) {
    const p = document.createElementNS(NS, 'pattern');
    p.setAttribute('id', id); p.setAttribute('patternUnits', 'userSpaceOnUse');
    p.setAttribute('width', 4 * cell); p.setAttribute('height', 4 * cell);
    p.innerHTML = rects(lit, cell, color).replaceAll('<rect', '<rect shape-rendering="crispEdges"');
    defs.appendChild(p);
  }
  return id;
}
export function ensureHatch(defs, id, color, gap = 6) {
  if (defs.querySelector('#' + id)) return id;
  const p = document.createElementNS(NS, 'pattern');
  p.setAttribute('id', id); p.setAttribute('patternUnits', 'userSpaceOnUse');
  p.setAttribute('width', gap); p.setAttribute('height', gap); p.setAttribute('patternTransform', 'rotate(45)');
  p.innerHTML = `<rect width="1.6" height="${gap}" fill="${color}"/>`;
  defs.appendChild(p);
  return id;
}
/** Masks dm1..dm3 (25/50/75% lit) used by dissolve(). */
export function installMasks(defs) {
  const BIG = 40000;
  [0.25, 0.5, 0.75].forEach((lit, i) => {
    const pid = `dmp${i + 1}`;
    defs.insertAdjacentHTML('beforeend',
      `<pattern id="${pid}" patternUnits="userSpaceOnUse" width="8" height="8">${rects(lit, 2, '#fff')}</pattern>` +
      `<mask id="dm${i + 1}" maskUnits="userSpaceOnUse" x="${-BIG / 2}" y="${-BIG / 2}" width="${BIG}" height="${BIG}">` +
      `<rect x="${-BIG / 2}" y="${-BIG / 2}" width="${BIG}" height="${BIG}" fill="url(#${pid})"/></mask>`);
  });
}
/** Dither-dissolve an SVG element in: 4 steps over 280ms. Reduced motion: 150ms fade. Keyboard: instant. */
export function dissolve(el, instant) {
  clearTimeout(el._dt);
  el.removeAttribute('mask');
  if (instant) return;
  if (reduced()) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' }); return; }
  let i = 0;
  const go = () => {
    if (i < 3) { el.setAttribute('mask', `url(#dm${++i})`); el._dt = setTimeout(go, 70); } else el.removeAttribute('mask');
  };
  go();
}
