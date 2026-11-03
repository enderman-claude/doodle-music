// Doodle Music
// x = time within the loop, y = pitch, color = instrument (waveform).

const canvas = document.getElementById('board');
const ctx2d = canvas.getContext('2d');
const playBtn = document.getElementById('playBtn');
const undoBtn = document.getElementById('undoBtn');
const clearBtn = document.getElementById('clearBtn');
const randomBtn = document.getElementById('randomBtn');
const loopInput = document.getElementById('loopLen');
const loopLabel = document.getElementById('loopLabel');
const statusEl = document.getElementById('status');
const swatches = [...document.querySelectorAll('.swatch')];

// The shared button style would otherwise paint every swatch the same dark color.
swatches.forEach(b => {
  b.style.background = b.dataset.color;
});

// Pentatonic scale over two octaves, starting at middle C.
const PENTA = [0, 2, 4, 7, 9];
const BASE_HZ = 261.63;
const STEPS = 10;
const LOOKAHEAD = 0.12;   // seconds of audio scheduled ahead
const TICK_MS = 25;       // how often the scheduler runs
const MIN_X_GAP = 0.03;   // minimum horizontal distance between notes in one stroke
const WAVE_GAIN = { sine: 0.25, triangle: 0.25, square: 0.12, sawtooth: 0.1 };

let strokes = [];         // { color, wave, points: [{x, y}] } with coordinates in 0..1
let currentStroke = null;
let events = [];          // { t, hz, wave } with t in seconds from the loop start

let activeColor = swatches[0].dataset.color;
let activeWave = swatches[0].dataset.wave;

let audio = null;
let playing = false;
let playStart = 0;        // audio time when the first loop started
let scheduledUpTo = 0;    // audio time up to which notes are already scheduled
let loopIndex = 0;
let eventIndex = 0;
let timer = null;
let liveNodes = [];

// ---------- helpers ----------

function loopLength() {
  return Number(loopInput.value);
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function stepToHz(step) {
  const octave = Math.floor(step / 5);
  const degree = step % 5;
  return BASE_HZ * Math.pow(2, (octave * 12 + PENTA[degree]) / 12);
}

function yToStep(y) {
  // Top of the canvas is the highest note.
  return Math.round((1 - y) * (STEPS - 1));
}

function setStatus(text) {
  statusEl.textContent = text;
}

// ---------- drawing ----------

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: clamp01((e.clientX - r.left) / r.width),
    y: clamp01((e.clientY - r.top) / r.height)
  };
}

function drawBoard() {
  const W = canvas.width;
  const H = canvas.height;
  ctx2d.clearRect(0, 0, W, H);

  // Faint pitch guide lines.
  ctx2d.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx2d.lineWidth = 1;
  for (let s = 0; s < STEPS; s++) {
    const y = (1 - s / (STEPS - 1)) * H;
    ctx2d.beginPath();
    ctx2d.moveTo(0, y);
    ctx2d.lineTo(W, y);
    ctx2d.stroke();
  }

  // Strokes.
  for (const stroke of strokes) {
    ctx2d.strokeStyle = stroke.color;
    ctx2d.fillStyle = stroke.color;
    ctx2d.lineWidth = 6;
    ctx2d.lineCap = 'round';
    ctx2d.lineJoin = 'round';

    if (stroke.points.length === 1) {
      const p = stroke.points[0];
      ctx2d.beginPath();
      ctx2d.arc(p.x * W, p.y * H, 6, 0, Math.PI * 2);
      ctx2d.fill();
      continue;
    }

    ctx2d.beginPath();
    stroke.points.forEach((p, i) => {
      const px = p.x * W;
      const py = p.y * H;
      if (i === 0) ctx2d.moveTo(px, py);
      else ctx2d.lineTo(px, py);
    });
    ctx2d.stroke();
  }

  // Playhead.
  if (playing && audio) {
    const elapsed = Math.max(0, audio.currentTime - playStart);
    const frac = (elapsed % loopLength()) / loopLength();
    ctx2d.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.moveTo(frac * W, 0);
    ctx2d.lineTo(frac * W, H);
    ctx2d.stroke();
  }
}

function animate() {
  drawBoard();
  requestAnimationFrame(animate);
}

// ---------- events from drawing ----------

function rebuildEvents() {
  const len = loopLength();
  events = [];

  for (const stroke of strokes) {
    let lastX = null;
    for (const p of stroke.points) {
      if (lastX === null || Math.abs(p.x - lastX) >= MIN_X_GAP) {
        events.push({
          t: p.x * len,
          hz: stepToHz(yToStep(p.y)),
          wave: stroke.wave
        });
        lastX = p.x;
      }
    }
  }

  events.sort((a, b) => a.t - b.t);
}

// After the drawing changes during playback, continue from the point already scheduled.
function resyncPosition() {
  const len = loopLength();
  const k = Math.floor((scheduledUpTo - playStart) / len);
  const rel = scheduledUpTo - (playStart + k * len);
  const next = events.findIndex(e => e.t > rel);

  if (next === -1) {
    loopIndex = k + 1;
    eventIndex = 0;
  } else {
    loopIndex = k;
    eventIndex = next;
  }
}

function changed() {
  rebuildEvents();
  if (playing) resyncPosition();
  if (!playing) {
    setStatus(strokes.length ? '' : 'Draw something, then press Start.');
  }
}

// ---------- sound ----------

function playNote(ev, when) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  const peak = WAVE_GAIN[ev.wave] || 0.2;

  osc.type = ev.wave;
  osc.frequency.value = ev.hz;

  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(peak, when + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.35);

  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start(when);
  osc.stop(when + 0.4);

  liveNodes.push(osc);
  osc.onended = () => {
    liveNodes = liveNodes.filter(n => n !== osc);
  };
}

function schedule() {
  const horizon = audio.currentTime + LOOKAHEAD;
  const len = loopLength();

  if (events.length === 0) {
    scheduledUpTo = horizon;
    return;
  }

  while (true) {
    if (eventIndex >= events.length) {
      loopIndex++;
      eventIndex = 0;
    }
    const ev = events[eventIndex];
    const when = playStart + loopIndex * len + ev.t;
    if (when > horizon) break;
    playNote(ev, when);
    eventIndex++;
  }

  scheduledUpTo = horizon;
}

// ---------- transport ----------

function startPlayback() {
  if (!audio) {
    audio = new (window.AudioContext || window.webkitAudioContext)();
  }
  audio.resume();

  if (strokes.length === 0) {
    setStatus('Draw something first.');
    return;
  }

  rebuildEvents();
  playing = true;
  playStart = audio.currentTime + 0.1;
  scheduledUpTo = playStart;
  loopIndex = 0;
  eventIndex = 0;
  playBtn.textContent = 'Stop';
  setStatus('Playing');

  schedule();
  timer = setInterval(schedule, TICK_MS);
}

function stopPlayback() {
  playing = false;
  clearInterval(timer);
  timer = null;

  for (const node of liveNodes) {
    try {
      node.stop();
    } catch (err) {
      // Already stopped; nothing to do.
    }
  }
  liveNodes = [];

  playBtn.textContent = 'Start';
  changed();
}

playBtn.addEventListener('click', () => {
  if (playing) stopPlayback();
  else startPlayback();
});

// ---------- instrument and controls ----------

swatches.forEach(btn => {
  btn.addEventListener('click', () => {
    swatches.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeColor = btn.dataset.color;
    activeWave = btn.dataset.wave;
  });
});

loopInput.addEventListener('input', () => {
  loopLabel.textContent = `${loopLength()} s`;
  if (playing) {
    stopPlayback();
    startPlayback();
  } else {
    changed();
  }
});

undoBtn.addEventListener('click', () => {
  strokes.pop();
  changed();
});

clearBtn.addEventListener('click', () => {
  strokes = [];
  changed();
});

randomBtn.addEventListener('click', () => {
  const palette = swatches.map(b => ({ color: b.dataset.color, wave: b.dataset.wave }));
  const count = 12;
  for (let i = 0; i < count; i++) {
    const pick = palette[Math.floor(Math.random() * palette.length)];
    strokes.push({
      color: pick.color,
      wave: pick.wave,
      points: [{
        x: (i + 0.5 + (Math.random() - 0.5) * 0.4) / count,
        y: 0.15 + Math.random() * 0.7
      }]
    });
  }
  changed();
});

// ---------- drawing input ----------

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  currentStroke = { color: activeColor, wave: activeWave, points: [canvasPoint(e)] };
  strokes.push(currentStroke);
  changed();
});

canvas.addEventListener('pointermove', e => {
  if (!currentStroke) return;
  currentStroke.points.push(canvasPoint(e));
  changed();
});

function endStroke() {
  currentStroke = null;
  changed();
}

canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

// ---------- start ----------

setStatus('Draw something, then press Start.');
animate();
