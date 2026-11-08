// Transport: play/pause, step 5 min, speed, time, LIVE, scrubber, sound toggle, and the keyboard map.
import { clock, setTime, subscribe, notify, T0, END, NOW, STEP, fmtTime, fmtHM } from './model.js';
import { isMuted, setMuted } from './audio.js';

const SPEEDS = [1, 4, 16]; // x5 min per second
const I = {
  play: '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M3 1.5v9l7-4.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.5 1.5h2.6v9H2.5zM6.9 1.5h2.6v9H6.9z" fill="currentColor"/></svg>',
  back: '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M2 1.5h1.6v9H2zM10 1.5v9L4.6 6z" fill="currentColor"/></svg>',
  fwd: '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M8.4 1.5H10v9H8.4zM2 1.5v9L7.4 6z" fill="currentColor"/></svg>',
};
let ui = {};

function setPlaying(p) { clock.playing = p; notify(); }
function step(dir, instant) { clock.playing = false; setTime(clock.t + dir * STEP, instant); }
function cycleSpeed() { clock.speed = SPEEDS[(SPEEDS.indexOf(clock.speed) + 1) % SPEEDS.length]; notify(); }
function scrubKey(dir) {
  if (clock.playing && clock.dir === dir) clock.speed = SPEEDS[(SPEEDS.indexOf(clock.speed) + 1) % SPEEDS.length];
  else { clock.dir = dir; clock.playing = true; clock.speed = 1; }
  notify(true);
}
function toggleSound() { setMuted(!isMuted()); render(); }

function render() {
  const sound = ui.sound; if (!sound) return;
  sound.setAttribute('aria-pressed', String(!isMuted()));
  sound.querySelector('span').textContent = isMuted() ? 'SOUND OFF' : 'SOUND ON';
}

export function initTransport() {
  const root = document.getElementById('transport');
  root.innerHTML = `
    <button type="button" class="tb" data-a="back" aria-label="Step back 5 minutes" title="Step back (Left)">${I.back}</button>
    <button type="button" class="tb play" data-a="play" aria-label="Play" title="Play or pause (Space)">${I.play}</button>
    <button type="button" class="tb" data-a="fwd" aria-label="Step forward 5 minutes" title="Step forward (Right)">${I.fwd}</button>
    <button type="button" class="tb txt" data-a="speed" aria-label="Playback speed" title="Speed">1X</button>
    <div class="tm" aria-live="off"><b data-r="time"></b><span data-r="sub"></span></div>
    <button type="button" class="tb txt live" data-a="live" aria-label="Jump to now" title="Jump to now (the last reading)">LIVE</button>
    <div class="scrub" style="--now:${((NOW - T0) / (END - T0)) * 100}%"><input type="range" min="${T0}" max="${END}" step="1" aria-label="Playhead time"><i class="nowmark"></i></div>
    <div class="keys" aria-hidden="true">SPACE PLAY, J K L SCRUB, M SOUND</div>
    <button type="button" class="tb txt snd" data-a="sound" aria-pressed="false" title="Toggle sound (M)"><span>SOUND OFF</span></button>`;
  ui = { play: root.querySelector('[data-a=play]'), speed: root.querySelector('[data-a=speed]'), time: root.querySelector('[data-r=time]'),
    sub: root.querySelector('[data-r=sub]'), range: root.querySelector('input'), sound: root.querySelector('[data-a=sound]'), live: root.querySelector('.live') };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'play') setPlaying(!clock.playing);
    else if (a === 'back') step(-1); else if (a === 'fwd') step(1);
    else if (a === 'speed') cycleSpeed();
    else if (a === 'live') { clock.playing = false; clock.dir = 1; setTime(NOW); }
    else if (a === 'sound') toggleSound();
  });
  ui.range.addEventListener('input', () => { clock.playing = false; setTime(+ui.range.value, true); });

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches?.('input[type=text],textarea,select')) return;
    const onRange = e.target === ui.range;
    switch (e.key) {
      case ' ': e.preventDefault(); setPlaying(!clock.playing); break;
      case 'ArrowLeft': if (onRange) return; e.preventDefault(); step(-1, true); break;
      case 'ArrowRight': if (onRange) return; e.preventDefault(); step(1, true); break;
      case 'j': case 'J': scrubKey(-1); break;
      case 'k': case 'K': clock.playing = false; notify(true); break;
      case 'l': case 'L': scrubKey(1); break;
      case 'm': case 'M': toggleSound(); break;
      default: return;
    }
  });
  document.addEventListener('keyup', (e) => { if (e.key === ' ' && e.target.tagName === 'BUTTON') e.preventDefault(); });

  subscribe(sync);
  let last = performance.now();
  (function loop(now) {
    const dt = Math.min(0.25, (now - last) / 1000); last = now;
    if (clock.playing && !document.hidden) {
      const t = clock.t + clock.dir * clock.speed * STEP * dt;
      if (t >= END || t <= T0) clock.playing = false;
      setTime(t);
    }
    requestAnimationFrame(loop);
  })(last);
  sync(clock); render();
}

function sync(c) {
  ui.time.textContent = fmtTime(c.t);
  ui.sub.textContent = c.t > NOW ? `PROJECTED +${fmtHM(c.t - NOW)}` : c.t === NOW ? 'LAST READING' : '';
  ui.play.innerHTML = c.playing ? I.pause : I.play;
  ui.play.setAttribute('aria-label', c.playing ? 'Pause' : 'Play');
  ui.speed.textContent = `${c.dir < 0 && c.playing ? '-' : ''}${c.speed}X`;
  if (document.activeElement !== ui.range || !c.instant) ui.range.value = Math.round(c.t);
  ui.live.classList.toggle('on', c.t === NOW);
}
