// Pan / zoom for the dot-grid canvas. Camera is a shared mutable {x,y,z} (world to screen).
// Drag or trackpad scroll pans, ctrl+wheel and pinch zoom, +/- zoom, 0 fits all, 1-9 frame a system.
export function createCamera(svg, world, dots, onChange) {
  const cam = { x: 0, y: 0, z: 1 }, MIN = 0.2, MAX = 4;
  let bounds = null, clusters = [];
  const size = () => { const r = svg.getBoundingClientRect(); return [r.width, r.height]; };
  function apply() {
    world.setAttribute('transform', `translate(${cam.x} ${cam.y}) scale(${cam.z})`);
    dots.setAttribute('patternTransform', `translate(${cam.x} ${cam.y}) scale(${cam.z})`);
    svg.style.setProperty('--iz', String(1 / cam.z));
    onChange(cam);
  }
  function zoomAt(f, cx, cy) {
    const z = Math.max(MIN, Math.min(MAX, cam.z * f)), k = z / cam.z;
    cam.x = cx - (cx - cam.x) * k; cam.y = cy - (cy - cam.y) * k; cam.z = z; apply();
  }
  function fit(b, pad = 40) {
    const [W, H] = size();
    const z = Math.max(MIN, Math.min(MAX, Math.min((W - pad * 2) / (b.x1 - b.x0), (H - pad * 2 - 20) / (b.y1 - b.y0))));
    cam.z = z; cam.x = (W - (b.x1 - b.x0) * z) / 2 - b.x0 * z; cam.y = (H - (b.y1 - b.y0) * z) / 2 - b.y0 * z + 8; apply();
  }
  const frame = (i) => {
    if (i === 0 || !clusters[i - 1]) return fit(bounds);
    const c = clusters[i - 1];
    fit({ x0: c.ox - 20, y0: c.oy - 50, x1: c.ox + c.w, y1: c.oy + c.h + 30 });
  };
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.012), e.clientX - r.left, e.clientY - r.top);
    else { cam.x -= e.deltaX; cam.y -= e.deltaY; apply(); }
  }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
    svg.setPointerCapture(e.pointerId); svg.classList.add('grab');
  });
  svg.addEventListener('pointermove', (e) => { if (drag) { cam.x = drag.cx + e.clientX - drag.x; cam.y = drag.cy + e.clientY - drag.y; apply(); } });
  const end = () => { drag = null; svg.classList.remove('grab'); };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || /input|textarea|select/i.test(e.target.tagName)) return;
    const [W, H] = size();
    if (e.key === '+' || e.key === '=') zoomAt(1.25, W / 2, H / 2);
    else if (e.key === '-' || e.key === '_') zoomAt(0.8, W / 2, H / 2);
    else if (/^[0-9]$/.test(e.key)) frame(+e.key);
    else return;
  });
  new ResizeObserver(() => { if (bounds) onChange(cam); }).observe(svg);
  return { cam, apply, zoomAt, fit, frame, size,
    setLayout(b, cl) { bounds = b; clusters = cl; } };
}
