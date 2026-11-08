// One shared tooltip. 160ms ease-out from scale(.97); instant when a tooltip was just visible.
const root = document.getElementById('tip'), inner = root.firstElementChild;
let lastHide = 0, shown = false;
export function showTip(html, x, y) {
  inner.innerHTML = html;
  const w = inner.offsetWidth, h = inner.offsetHeight, vw = innerWidth, vh = innerHeight;
  const left = x + 14 + w > vw - 8, up = y + 18 + h > vh - 8;
  const px = left ? x - 14 - w : x + 14, py = up ? y - 14 - h : y + 18;
  root.style.transform = `translate(${Math.max(8, px)}px, ${Math.max(8, py)}px)`;
  inner.style.transformOrigin = `${left ? 'right' : 'left'} ${up ? 'bottom' : 'top'}`;
  if (!shown) {
    inner.classList.toggle('instant', performance.now() - lastHide < 350);
    inner.classList.add('on');
    shown = true;
  }
}
export function hideTip() {
  if (!shown) return;
  shown = false; lastHide = performance.now();
  inner.classList.remove('on');
}
