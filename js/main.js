import { Dither, quad } from './dither.js';

const root = document.documentElement;
root.classList.add('js');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

console.log('%cyou opened the console. hi.\nthere are more stations than the list admits.', 'color:#58a89f;font-family:monospace');

/* ================================================================== *
 * 440. A tiny pattern language, borrowed in spirit from TidalCycles /
 * Strudel mini-notation and written from scratch: no library, no eval.
 *   a b c   one cycle split in three      [a b]  squeeze into one slot
 *   <a b>   one per cycle, in turn         a*4    repeat inside the slot
 *   a, b    at the same time               ~      silence
 * Atoms: a frequency in Hz, a note (a4, c#5, bb3), or click chirp blip hum.
 * Every line is its own layer.
 * ================================================================== */
const NOTE = { c: -9, d: -7, e: -5, f: -4, g: -2, a: 0, b: 2 };
const WORDS = new Set(['click', 'chirp', 'blip', 'hum']);
function atom(tok) {
  if (tok === '~' || tok === '-') return { t: 'rest' };
  if (/^\d+(\.\d+)?$/.test(tok)) return { t: 'hz', v: clamp(Number(tok), 20, 8000) };
  const m = /^([a-g])([#b]?)(\d)$/.exec(tok);
  if (m) return { t: 'hz', v: 440 * 2 ** ((NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) - 4) * 12) / 12) };
  if (WORDS.has(tok)) return { t: 'sym', v: tok };
  throw new Error(`no such thing as "${tok}"`);
}
function parseLine(src) {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  function group(end) {
    const layers = [[]];
    for (;;) {
      ws();
      if (i >= src.length) { if (end) throw new Error(`missing ${end}`); break; }
      const c = src[i];
      if (c === end) { i++; break; }
      if (c === ']' || c === '>') throw new Error(`stray ${c}`);
      if (c === ',') { i++; layers.push([]); continue; }
      layers[layers.length - 1].push(term());
    }
    const seqs = layers.map((ch) => ({ t: 'seq', ch }));
    return seqs.length === 1 ? seqs[0] : { t: 'stack', ch: seqs };
  }
  function term() {
    let node;
    if (src[i] === '[') { i++; node = group(']'); }
    else if (src[i] === '<') { i++; const g = group('>'); node = { t: 'alt', ch: g.t === 'seq' ? g.ch : [g] }; }
    else {
      const m = /^[A-Za-z0-9.~#_-]+/.exec(src.slice(i));
      if (!m) throw new Error(`stray ${src[i]}`);
      i += m[0].length;
      node = atom(m[0]);
    }
    while (src[i] === '*') {
      i++;
      const m = /^\d+/.exec(src.slice(i));
      if (!m) throw new Error('a number goes after *');
      i += m[0].length;
      node = { t: 'fast', n: clamp(Number(m[0]), 1, 32), ch: [node] };
    }
    return node;
  }
  return group(null);
}
function query(node, cycle, b, d, out) {
  switch (node.t) {
    case 'hz': case 'sym': out.push({ b, d, v: node }); break;
    case 'seq': node.ch.forEach((c, k) => query(c, cycle, b + (k * d) / node.ch.length, d / node.ch.length, out)); break;
    case 'stack': node.ch.forEach((c) => query(c, cycle, b, d, out)); break;
    case 'alt': if (node.ch.length) query(node.ch[((cycle % node.ch.length) + node.ch.length) % node.ch.length], Math.floor(cycle / node.ch.length), b, d, out); break;
    case 'fast': for (let k = 0; k < node.n; k++) query(node.ch[0], cycle * node.n + k, b + (k * d) / node.n, d / node.n, out); break;
    default: break;
  }
  return out;
}
const music = (() => {
  const ta = $('#code');
  const err = $('#code-err');
  let layers = [];
  function compile() {
    const next = [];
    const lines = ta.value.split('\n');
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n].replace(/\/\/.*$/, '').trim();
      if (!line) continue;
      try { next.push(parseLine(line)); }
      catch (e) { err.textContent = `line ${n + 1}: ${e.message}`; return; }
    }
    err.textContent = '';
    layers = next;
  }
  let t = 0;
  ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(compile, 180); });
  ta.addEventListener('keydown', (e) => e.stopPropagation());
  compile();
  return { events(cycle) { const out = []; layers.forEach((l) => query(l, cycle, 0, 1, out)); return out; } };
})();

/* ================================================================== *
 * Sound. Off until asked. Everything is synthesised, nothing is fetched.
 * ================================================================== */
const sound = (() => {
  const btn = $('#sound');
  let ctx = null, master, noiseG, voiceG, noiseBuf;
  let on = false, cur = null, pending = 'home', timers = [], oscs = [];
  const geiger = { alive: false, rate: 3 };

  function init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.5;
    noiseG = ctx.createGain(); noiseG.gain.value = 0;
    src.connect(bp); bp.connect(noiseG); noiseG.connect(master); src.start();
    voiceG = ctx.createGain(); voiceG.gain.value = 0; voiceG.connect(master);
    return true;
  }
  function osc(type, f, g) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
    const gn = ctx.createGain(); gn.gain.value = g;
    o.connect(gn); gn.connect(voiceG); o.start(); oscs.push(o); return o;
  }
  function blip(f, dur, g = 0.12, type = 'square') {
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0, t); gn.gain.linearRampToValueAtTime(g, t + 0.005); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(gn); gn.connect(voiceG); o.start(t); o.stop(t + dur + 0.02);
  }
  function play(v, at, dur) {
    if (v.t === 'sym') {
      if (v.v === 'click') { const s = ctx.createBufferSource(); s.buffer = noiseBuf; const g = ctx.createGain(); g.gain.setValueAtTime(0.6, at); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.012); s.connect(g); g.connect(voiceG); s.start(at, Math.random()); s.stop(at + 0.03); return; }
      const f0 = { chirp: 400, blip: 2402, hum: 50 }[v.v];
      const o = ctx.createOscillator(); o.type = v.v === 'hum' ? 'sawtooth' : 'sine';
      o.frequency.setValueAtTime(f0, at);
      if (v.v === 'chirp') o.frequency.linearRampToValueAtTime(1600, at + dur);
      const g = ctx.createGain(); const peak = v.v === 'blip' ? 0.05 : 0.07; const len = v.v === 'blip' ? 0.03 : dur;
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(peak, at + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      o.connect(g); g.connect(voiceG); o.start(at); o.stop(at + len + 0.05);
      return;
    }
    const o = ctx.createOscillator(); o.type = v.v < 120 ? 'sawtooth' : 'triangle'; o.frequency.value = v.v;
    const g = ctx.createGain(); const peak = 0.09 * Math.min(1, 500 / v.v) + 0.02;
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(peak, at + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, at + Math.max(0.08, dur * 0.95));
    o.connect(g); g.connect(voiceG); o.start(at); o.stop(at + dur + 0.05);
  }
  function click() {
    const t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const gn = ctx.createGain(); gn.gain.setValueAtTime(0.6, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.01);
    s.connect(gn); gn.connect(voiceG); s.start(t, Math.random()); s.stop(t + 0.02);
  }
  const voices = {
    hum() { osc('sawtooth', 50, 0.05); osc('sine', 100, 0.07); osc('sine', 150, 0.03); },
    dns() { timers.push(setInterval(() => { blip(1200, 0.05); setTimeout(() => blip(1800, 0.08, 0.1), 170); }, 1600)); },
    harmonium() {
      const a = Array.from({ length: 10 }, (_, i) => osc('sine', 700 + i * 160, 0.012));
      timers.push(setInterval(() => a.forEach((o, i) => o.frequency.setTargetAtTime(700 + i * 160 + (Math.random() - 0.5) * 50, ctx.currentTime, 0.02)), 90));
    },
    hydrogen() { osc('sine', 1420.405, 0.035); },
    home() { timers.push(setInterval(() => blip(2402, 0.025, 0.05, 'sine'), 2100)); },
    roomsense() {
      const o = osc('sine', 400, 0.045);
      const sweep = () => { const t = ctx.currentTime; o.frequency.setValueAtTime(400, t); o.frequency.linearRampToValueAtTime(1600, t + 1.2); };
      sweep(); timers.push(setInterval(sweep, 1500));
    },
    a440() {
      const CYCLE = 2.4;
      const t0 = ctx.currentTime + 0.08;
      let next = 0;
      const sched = () => {
        while (t0 + next * CYCLE < ctx.currentTime + 0.3) {
          for (const e of music.events(next)) {
            const at = t0 + (next + e.b) * CYCLE;
            const dur = Math.min(e.d * CYCLE, 1.6);
            play(e.v, at, dur);
            setTimeout(() => wire.packet(), Math.max(0, (at - ctx.currentTime) * 1000));
          }
          next++;
        }
      };
      sched();
      timers.push(setInterval(sched, 60));
    },
    gamma() {
      geiger.alive = true;
      const tick = () => { if (!geiger.alive) return; click(); setTimeout(tick, -Math.log(1 - Math.random()) * (1000 / geiger.rate)); };
      tick();
    },
  };
  function stopVoice() {
    timers.forEach(clearInterval); timers = [];
    oscs.forEach((o) => { try { o.stop(); } catch { /* already stopped */ } }); oscs = [];
    geiger.alive = false;
  }
  function station(id) {
    pending = id;
    if (!on || id === cur) return;
    stopVoice(); cur = id; voices[id]?.();
  }
  function levels(staticLevel, signal) {
    if (!on) return;
    const t = ctx.currentTime;
    noiseG.gain.setTargetAtTime(0.015 + 0.16 * staticLevel, t, 0.04);
    voiceG.gain.setTargetAtTime(signal * signal, t, 0.06);
  }
  btn.addEventListener('click', () => {
    if (!ctx && !init()) { btn.textContent = 'no audio here'; return; }
    on = !on;
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? 'sound on' : 'sound off';
    const pb = $('#play'); pb.setAttribute('aria-pressed', String(on)); pb.textContent = on ? 'stop' : 'play';
    if (on) { ctx.resume(); master.gain.setTargetAtTime(0.5, ctx.currentTime, 0.1); cur = null; tuner.refresh(); }
    else { master.gain.setTargetAtTime(0, ctx.currentTime, 0.05); stopVoice(); cur = null; }
  });
  return {
    station, levels, geiger, toggle: () => btn.click(),
    get on() { return on; },
    twang() { if (on) blip(90 + Math.random() * 90, 0.7, 0.14, 'triangle'); },
  };
})();

/* ================================================================== *
 * Hydrogen reserve. Presence is the radiation; it leaks away slowly.
 * ================================================================== */
const reserveEl = $('#reserve');
const signalBtn = $('#signal');
const signalState = $('#signal-state');
let reserve = 0;
let charged = false;
let lastPointer = null;

function jolt() {
  if (reduceMotion.matches) return;
  document.body.classList.remove('jolt'); void document.body.offsetWidth; document.body.classList.add('jolt');
}
function feed(amount) {
  if (charged || dialog.open) return;
  reserve = Math.min(100, reserve + amount);
  if (reserve >= 100) {
    charged = true;
    signalBtn.dataset.charged = '';
    signalState.textContent = 'sufficient';
    wire.beat();
    jolt();
    // enough has gathered: up at gamma, or while dormant, the heart restarts on its own
    if (state === 'dormant' || tuner.lockedId() === 'gamma') setTimeout(() => openReveal(null), 600);
  }
}
addEventListener('pointermove', (e) => {
  if (lastPointer) feed(Math.min(1.2, Math.hypot(e.clientX - lastPointer[0], e.clientY - lastPointer[1]) * (state === 'dormant' ? 0.012 : 0.004)));
  lastPointer = [e.clientX, e.clientY];
}, { passive: true });
addEventListener('pointerdown', () => feed(2), { passive: true });
let lastScroll = scrollY;
addEventListener('scroll', () => { feed(Math.min(2, Math.abs(scrollY - lastScroll) * 0.01)); lastScroll = scrollY; }, { passive: true });

setInterval(() => {
  if (!charged) {
    if (tuner.lockedId() === 'gamma' && state === 'listening' && !dialog.open) {
      feed(3.2); // radiation
      sound.geiger.rate = 3 + reserve * 0.6;
      dwell.textContent = `${Math.round(40 + reserve * 9.6)} counts per minute`;
    } else reserve = Math.max(0, reserve - 0.3);
  }
  reserveEl.textContent = String(Math.round(reserve));
}, 250);

/* ================================================================== *
 * The wires. They hum at 50 Hz (slowed down), carry packets, fill with
 * static between stations, and you can pluck them.
 * ================================================================== */
const WIRES = [
  { a: [-0.01, 34 / 240], c: [0.5, 140 / 240], b: [1.01, 22 / 240], k: 0.55, glow: 3, n: 3 },
  { a: [-0.01, 70 / 240], c: [0.48, 196 / 240], b: [1.01, 58 / 240], k: 1, glow: 9, n: 2 },
  { a: [-0.01, 104 / 240], c: [0.34, 172 / 240], b: [0.62, 126 / 240], k: 0.5, glow: 3, n: 1, cut: true },
];

const wire = (() => {
  const host = $('.wires');
  const canvas = $('#wire');
  const noop = { beat() {}, packet() {}, set staticLevel(v) {} };
  if (!canvas?.getContext) return noop;
  const d = new Dither(canvas, 3);
  let packets = [];
  let plucks = [];
  let beatAt = -1;
  let visible = true;
  let raf = 0;
  let last = 0;
  let nextPacket = 0;
  let staticLevel = 0;
  const side = WIRES.map(() => 0);

  function disp(wi, u, t) {
    let y = 0;
    for (const p of plucks) {
      if (p.wi !== wi) continue;
      const age = t - p.t0;
      y += p.amp * Math.exp(-age / 700) * Math.sin(age * 0.045) * Math.exp(-((u - p.u) ** 2) / 0.006);
    }
    return y;
  }
  function point(wi, u, t, w, h, amp) {
    const wd = WIRES[wi];
    const [x, y] = quad(wd.a, wd.c, wd.b, u);
    const hum = amp * Math.sin(Math.PI * u * wd.n * 2) * Math.sin(t * 0.0021 + wd.n);
    const jitter = staticLevel ? (Math.random() - 0.5) * staticLevel * 2.4 : 0;
    return [x * w, y * h + hum + jitter + disp(wi, u, t)];
  }

  function paint(t) {
    const amp = 0.35 + (reserve / 100) * 1.6;
    d.render((o, w, h) => {
      o.lineCap = 'round';
      WIRES.forEach((wd, wi) => {
        o.strokeStyle = `rgba(255,0,0,${wd.k})`;
        o.shadowColor = 'rgba(255,0,0,.9)';
        o.shadowBlur = wd.glow;
        o.lineWidth = 1;
        o.beginPath();
        for (let i = 0; i <= 90; i++) {
          const [x, y] = point(wi, i / 90, t, w, h, amp);
          i ? o.lineTo(x, y) : o.moveTo(x, y);
        }
        if (wd.cut) {
          const [ex, ey] = point(wi, 1, t, w, h, amp);
          const sway = Math.sin(t * 0.0007) * 0.006 * w + disp(wi, 1, t) * 0.6;
          o.quadraticCurveTo(ex + 0.018 * w, ey + 0.08 * h, ex + 0.012 * w + sway, 0.99 * h);
        }
        o.stroke();
      });
      o.shadowBlur = 4;
      o.fillStyle = 'rgba(255,0,0,1)';
      for (const p of packets) {
        const [x, y] = point(1, p.u, t, w, h, amp);
        o.beginPath(); o.arc(x, y, 1.4, 0, Math.PI * 2); o.fill();
      }
      if (staticLevel > 0.02) {
        o.shadowBlur = 0;
        const n = staticLevel * w * h * 0.012;
        for (let i = 0; i < n; i++) {
          o.fillStyle = `rgba(255,0,0,${0.25 + Math.random() * 0.5})`;
          o.fillRect((Math.random() * w) | 0, (Math.random() * h) | 0, 1, 1);
        }
      }
      if (beatAt >= 0) {
        const age = (t - beatAt) / 1400;
        if (age < 1) {
          const [x, y] = point(1, 0.72, t, w, h, amp);
          const k = Math.sin(Math.PI * Math.min(1, age * 1.6));
          o.shadowBlur = 0;
          o.strokeStyle = `rgba(0,255,0,${0.95 * k})`;
          o.beginPath();
          [[-9, 0], [-4, 0], [-2, 3], [0, -16], [2, 5], [4, 0], [9, 0]].forEach(([dx, dy], i) => (i ? o.lineTo(x + dx, y + dy) : o.moveTo(x + dx, y + dy)));
          o.stroke();
        } else beatAt = -1;
      }
    });
  }

  function step(t) {
    raf = 0;
    if (!visible || document.hidden) return;
    if (t - last >= 33) {
      const dt = Math.min(100, t - last);
      last = t;
      if (t > nextPacket) {
        packets.push({ u: 0, v: 0.00005 + Math.random() * 0.00004 });
        nextPacket = t + (9000 - reserve * 70) * (0.5 + Math.random());
      }
      packets = packets.filter((p) => (p.u += p.v * dt) < 1);
      plucks = plucks.filter((p) => t - p.t0 < 3500);
      paint(t);
    }
    raf = requestAnimationFrame(step);
  }
  function start() {
    if (reduceMotion.matches) { paint(0); return; }
    if (!raf) raf = requestAnimationFrame(step);
  }

  // plucking: cross a wire with the pointer, or press on one
  function wireY(wi, px, w, h) {
    const wd = WIRES[wi];
    const u = (px / w - wd.a[0]) / (wd.b[0] - wd.a[0]);
    if (u < 0 || u > 1) return null;
    return { u, y: quad(wd.a, wd.c, wd.b, u)[1] * h };
  }
  function pluck(wi, u, amp) {
    plucks.push({ wi, u, amp: clamp(amp, -9, 9), t0: performance.now() });
    if (wi === 1) packets.push({ u, v: 0.00012 });
    sound.twang();
    feed(4);
  }
  function probe(e, press) {
    const r = canvas.getBoundingClientRect();
    if (e.clientY < r.top - 20 || e.clientY > r.bottom + 20) { side.fill(0); return; }
    const px = ((e.clientX - r.left) / r.width) * d.w;
    const py = ((e.clientY - r.top) / r.height) * d.h;
    WIRES.forEach((_, wi) => {
      const hit = wireY(wi, px, d.w, d.h);
      if (!hit) return;
      const s = Math.sign(py - hit.y);
      if (press && Math.abs(py - hit.y) < 6) pluck(wi, hit.u, 6 * (s || 1));
      else if (side[wi] && s && s !== side[wi]) pluck(wi, hit.u, 7 * s);
      side[wi] = s;
    });
    start();
  }
  addEventListener('pointermove', (e) => probe(e, false), { passive: true });
  canvas.addEventListener('pointerdown', (e) => probe(e, true));

  new ResizeObserver(() => { if (d.resize() || reduceMotion.matches) paint(performance.now()); }).observe(canvas);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) start(); }).observe(host);
  document.addEventListener('visibilitychange', start);
  reduceMotion.addEventListener('change', start);
  paint(0);
  host.classList.add('live');
  start();

  return {
    packet() { if (packets.length < 40) packets.push({ u: 0, v: 0.00034 }); start(); },
    beat() { if (!reduceMotion.matches) beatAt = performance.now(); },
    set staticLevel(v) { staticLevel = v; if (reduceMotion.matches) paint(0); },
  };
})();

/* ================================================================== *
 * The tuner. Stations sit evenly along the dial, in order of frequency.
 * Between them: static. Near one, its text climbs out of the noise.
 * ================================================================== */
const dwell = $('#dwell');
const display = $('#display');
const announce = $('#announce');
const tuneK = $('#tune-k');
const tuneV = $('#tune-v');
const bars = $$('#bars i');
const dial = $('#dial');
const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const NOISE = 'abcdefghijklmnopqrstuvwxyz0123456789';

function fmtHz(f) {
  if (f >= 1e16) {
    const e = Math.floor(Math.log10(f));
    return `${(f / 10 ** e).toFixed(1)}×10${[...String(e)].map((c) => SUP[c]).join('')} Hz`;
  }
  for (const [div, unit] of [[1e12, 'THz'], [1e9, 'GHz'], [1e6, 'MHz'], [1e3, 'kHz'], [1, 'Hz']]) {
    if (f >= div) {
      const v = f / div;
      return `${v < 10 ? v.toFixed(3) : v < 100 ? v.toFixed(2) : v.toFixed(1)} ${unit}`;
    }
  }
  return `${f.toFixed(2)} Hz`;
}

const tuner = (() => {
  const stations = $$('.station[data-f]').map((el) => ({
    el, id: el.id, f: Number(el.dataset.f), k: el.dataset.k, v: el.dataset.v, name: el.dataset.name, secret: 'secret' in el.dataset,
  })).sort((a, b) => a.f - b.f);
  const N = stations.length;
  stations.forEach((s, i) => { s.pos = Math.round(60 + (i * 880) / (N - 1)); });
  const byId = new Map(stations.map((s) => [s.id, s]));
  const transmit = $('#transmit');
  const CAPTURE = 60;
  const LOCK = 6;

  const scale = $('#scale');
  for (const s of stations) {
    const b = document.createElement('b');
    b.style.left = `${s.pos / 10}%`;
    if (s.secret) b.className = 'secret';
    else { const sp = document.createElement('span'); sp.textContent = s.v.split(', ').pop(); b.append(sp); }
    scale.append(b);
  }

  // remember the original text of every node that can drown in static
  for (const s of stations) {
    const walker = document.createTreeWalker(s.el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest('pre, svg, button, .dwell, textarea, .code') || !n.data.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    s.nodes = [];
    while (walker.nextNode()) s.nodes.push({ n: walker.currentNode, t: walker.currentNode.data });
  }
  function scramble(s, level) {
    for (const { n, t } of s.nodes) {
      if (level <= 0) { if (n.data !== t) n.data = t; continue; }
      let out = '';
      for (let i = 0; i < t.length; i++) {
        const c = t[i];
        out += c === ' ' || c === '\n' || Math.random() > level ? c : NOISE[(Math.random() * NOISE.length) | 0];
      }
      n.data = out;
    }
  }

  const found = new Set((() => { try { return JSON.parse(store.get('lk.found') || '[]'); } catch { return []; } })().filter((id) => byId.has(id)));
  const logEl = $('#logbook');
  const presets = $$('[data-preset]');
  function renderLog() {
    logEl.textContent = `${found.size}/${N}`;
    presets.forEach((a) => { if (found.has(a.dataset.preset)) a.dataset.found = ''; });
  }
  renderLog();

  let shown = byId.get('home');
  let locked = null;
  let lastAnnounced = null;
  stations.forEach((s) => { s.el.hidden = s !== shown; });
  transmit.hidden = true;

  function nearest(p) {
    let best = stations[0];
    for (const s of stations) if (Math.abs(s.pos - p) < Math.abs(best.pos - p)) best = s;
    return best;
  }
  function freqAt(p) {
    if (p <= stations[0].pos) return stations[0].f * 10 ** ((p - stations[0].pos) / 60);
    if (p >= stations[N - 1].pos) return stations[N - 1].f * 10 ** ((p - stations[N - 1].pos) / 60);
    for (let i = 0; i < N - 1; i++) {
      const a = stations[i], b = stations[i + 1];
      if (p >= a.pos && p <= b.pos) {
        const t = (p - a.pos) / (b.pos - a.pos);
        return 10 ** (Math.log10(a.f) + t * (Math.log10(b.f) - Math.log10(a.f)));
      }
    }
    return 1;
  }

  function update() {
    const p = Number(dial.value);
    const s = nearest(p);
    const dist = Math.abs(s.pos - p);
    const sig = clamp(1 - dist / CAPTURE, 0, 1);
    const isLocked = dist <= LOCK;

    if (state !== 'transmitting') {
      if (sig > 0 && s !== shown) {
        scramble(shown, 0);
        shown.el.hidden = true;
        shown = s;
        shown.el.hidden = false;
      }
      display.classList.toggle('static', sig === 0);
      scramble(shown, sig === 0 ? 0 : isLocked ? 0 : clamp((1 - sig) * 1.15, 0, 0.95));
      shown.el.setAttribute('aria-hidden', String(!isLocked));
    }

    locked = isLocked ? s : null;
    tuneK.textContent = locked ? locked.k : 'freq';
    tuneV.textContent = locked ? locked.v : fmtHz(freqAt(p));
    const n = Math.round(sig * 5);
    bars.forEach((b, i) => b.classList.toggle('on', i < n));
    dial.setAttribute('aria-valuetext', locked ? `${locked.v}, ${locked.name}` : `${fmtHz(freqAt(p))}, no station`);
    presets.forEach((a) => a.setAttribute('aria-current', String(locked?.id === a.dataset.preset)));

    wire.staticLevel = isLocked ? 0 : 1 - sig;
    sound.levels(isLocked ? 0.1 : 1 - sig * 0.8, sig);
    if (sig > 0) sound.station(s.id);
    if (locked?.id !== 'gamma') dwell.textContent = '';

    if (gliding) return;
    if (locked && locked !== lastAnnounced) {
      lastAnnounced = locked;
      announce.textContent = `Tuned to ${locked.name}.`;
      if (!found.has(locked.id)) {
        found.add(locked.id);
        store.set('lk.found', JSON.stringify([...found]));
        renderLog();
        if (locked.secret) { jolt(); wire.beat(); announce.textContent = `Found a hidden station: ${locked.name}.`; }
      }
      if (location.hash !== `#${locked.id}`) history.replaceState(null, '', `#${locked.id}`);
    } else if (!locked) lastAnnounced = null;
  }

  let anim = 0;
  let gliding = false;
  function glideTo(target, ms = 520) {
    cancelAnimationFrame(anim);
    gliding = false;
    if (state !== 'listening') setState('listening');
    if (reduceMotion.matches || ms === 0) { dial.value = String(target); update(); return; }
    const from = Number(dial.value);
    const t0 = performance.now();
    const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
    const stepFn = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      dial.value = String(Math.round(from + (target - from) * ease(k)));
      gliding = k < 1;
      update();
      if (k < 1) anim = requestAnimationFrame(stepFn);
    };
    anim = requestAnimationFrame(stepFn);
  }
  function tuneTo(id, ms) { const s = byId.get(id); if (s) glideTo(s.pos, ms); }
  function stepStation(dir) {
    const p = Number(dial.value);
    const list = dir > 0 ? stations.filter((s) => s.pos > p + LOCK) : stations.filter((s) => s.pos < p - LOCK).reverse();
    if (list[0]) glideTo(list[0].pos);
  }

  dial.addEventListener('input', () => { cancelAnimationFrame(anim); gliding = false; if (state !== 'listening') setState('listening'); update(); });
  dial.addEventListener('change', () => {
    const p = Number(dial.value);
    const s = nearest(p);
    if (Math.abs(s.pos - p) <= CAPTURE * 0.6) glideTo(s.pos, 220);
  });
  dial.addEventListener('keydown', (e) => {
    const map = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
    if (e.key in map) { e.preventDefault(); stepStation(map[e.key]); }
    else if (e.key === 'Home') { e.preventDefault(); glideTo(stations[0].pos, 900); }
    else if (e.key === 'End') { e.preventDefault(); glideTo(stations[N - 1].pos, 900); }
  });
  presets.forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    tuneTo(a.dataset.preset);
    if (display.getBoundingClientRect().top > innerHeight * 0.8) display.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
  }));
  // arrow keys anywhere on the page tune too
  addEventListener('keydown', (e) => {
    if (dialog.open || e.target !== document.body || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); stepStation(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepStation(-1); }
  });

  function showTransmit(on) {
    if (on) {
      scramble(shown, 0);
      shown.el.hidden = true;
      display.classList.remove('static');
      transmit.hidden = false;
    } else {
      transmit.hidden = true;
      shown.el.hidden = false;
      update();
    }
  }

  return {
    update, tuneTo, glideTo, showTransmit, byId,
    lockedId: () => locked?.id ?? null,
    refresh() { sound.station(nearest(Number(dial.value)).id); update(); },
    homePos: () => byId.get('home').pos,
  };
})();

/* ================================================================== *
 * State: listening, transmitting, dormant.
 * ================================================================== */
let state = 'listening';
const stateBtns = $$('[data-state]');
function setState(s) {
  if (s === state) return;
  const prev = state;
  state = s;
  document.body.dataset.state = s;
  stateBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.state === s)));
  if (s === 'transmitting') tuner.showTransmit(true);
  if (prev === 'transmitting') tuner.showTransmit(false);
  if (s === 'dormant') { announce.textContent = 'Dormant. Move around to gather signal. Escape wakes it early.'; sound.levels(0.05, 0); }
  if (prev === 'dormant') tuner.update();
}
stateBtns.forEach((b) => b.addEventListener('click', () => {
  setState(b.dataset.state);
  if (b.dataset.state === 'transmitting') display.focus({ preventScroll: false });
}));
$$('[data-transmit]').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  setState('transmitting');
  display.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
  display.focus({ preventScroll: true });
}));
addEventListener('keydown', (e) => { if (e.key === 'Escape' && state === 'dormant' && !dialog.open) setState('listening'); });

/* ================================================================== *
 * Small things
 * ================================================================== */
$('[data-carrier-toggle]')?.addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const fig = btn.closest('.sig-carrier');
  const on = fig.dataset.view !== 'comb';
  fig.dataset.view = on ? 'comb' : 'noise';
  btn.setAttribute('aria-pressed', String(on));
});

(() => {
  const el = $('#addr');
  const rev = (s) => [...s].reverse().join('');
  const addr = `${rev(el.dataset.u)}@${rev(el.dataset.d)}`;
  const a = document.createElement('a');
  a.href = `mailto:${addr}`;
  a.textContent = addr;
  el.replaceChildren(a);
  const copy = $('#copy');
  const out = $('#copied');
  if (!navigator.clipboard) return;
  copy.hidden = false;
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(addr); out.textContent = 'copied to clipboard'; }
    catch { out.textContent = 'could not copy, select it by hand'; }
    setTimeout(() => { out.textContent = ''; }, 3200);
  });
})();

const lastBeatEl = $('#last-beat');
function renderLastBeat() {
  const t = Number(store.get('lk.lastBeat'));
  if (!t) return;
  const s = (Date.now() - t) / 1000;
  lastBeatEl.textContent = s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}
renderLastBeat();
setInterval(renderLastBeat, 30000);

/* ================================================================== *
 * Better days
 * ================================================================== */
const dialog = $('#better-days');
const bdState = $('#bd-state');
const story = dialog.querySelector('.story');
story.tabIndex = -1;
[...story.children].forEach((el, i) => el.style.setProperty('--i', String(Math.min(i, 3))));

let timers = [];
let ecgRaf = 0;
let opener = null;
const ecg = new Dither($('#ecg'), 4);

function drawEcg(mode, t, sweep = 1) {
  ecg.render((o, w, h) => {
    const mid = h / 2;
    o.lineWidth = 1;
    o.strokeStyle = 'rgba(255,0,0,1)';
    o.shadowColor = 'rgba(255,0,0,1)';
    o.shadowBlur = mode === 'flat' ? 0 : 3;
    o.beginPath();
    const end = Math.round(w * sweep);
    for (let x = 0; x <= end; x++) {
      let y = mid;
      if (mode === 'hum') y += Math.sin(x * 0.21 + t * 0.012) * 2.2 + Math.sin(x * 0.047 - t * 0.004) * 3;
      x ? o.lineTo(x, y) : o.moveTo(x, y);
    }
    o.stroke();
    if (mode === 'beat') {
      const cx = Math.round(w * 0.5);
      if (end >= cx - 12) {
        o.shadowBlur = 0;
        o.strokeStyle = 'rgba(0,255,0,1)';
        o.lineWidth = 1.5;
        o.beginPath();
        [[-12, 0], [-6, 0], [-4, 4], [-1, -h * 0.4], [2, h * 0.16], [5, 0], [12, 0]].forEach(([dx, dy], i) => {
          const x = cx + dx;
          if (x > end) return;
          i ? o.lineTo(x, mid + dy) : o.moveTo(x, mid + dy);
        });
        o.stroke();
      }
      o.fillStyle = 'rgba(255,0,0,1)';
      o.shadowBlur = 6;
      o.fillRect(end - 1, mid - 1, 2, 2);
    }
  });
}
const at = (ms, fn) => { timers.push(setTimeout(fn, ms)); };
function stage(name, label) { dialog.classList.add(name); if (label) bdState.textContent = label; }

function openReveal(trigger) {
  if (dialog.open) return;
  const active = document.activeElement;
  opener = trigger instanceof HTMLElement ? trigger : (active instanceof HTMLElement && active !== document.body ? active : signalBtn);
  dialog.className = '';
  bdState.textContent = 'reactivating';
  sound.levels(0, 0);
  dialog.showModal();
  ecg.resize();
  story.scrollTop = 0;
  store.set('lk.lastBeat', String(Date.now()));

  if (reduceMotion.matches) { stage('s-dawn', 'flying'); stage('s-story'); story.focus({ preventScroll: true }); return; }

  const t0 = performance.now();
  const hum = (t) => { drawEcg('hum', t - t0); ecgRaf = requestAnimationFrame(hum); };
  ecgRaf = requestAnimationFrame(hum);
  at(700, () => { cancelAnimationFrame(ecgRaf); drawEcg('flat', 0); bdState.textContent = 'flatline'; });
  at(1800, () => {
    bdState.textContent = 'one beat';
    const s0 = performance.now();
    const sweep = (t) => {
      const k = Math.min(1, (t - s0) / 1100);
      drawEcg('beat', t, k);
      if (k < 1) ecgRaf = requestAnimationFrame(sweep);
    };
    ecgRaf = requestAnimationFrame(sweep);
  });
  at(3500, () => stage('s-dawn', 'flying'));
  at(5200, () => {
    stage('s-story');
    if (document.activeElement === dialog || document.activeElement?.id === 'bd-close') story.focus({ preventScroll: true });
  });
}

dialog.addEventListener('close', () => {
  timers.forEach(clearTimeout);
  timers = [];
  cancelAnimationFrame(ecgRaf);
  dialog.className = '';
  reserve = 0; // the heart used what it gathered
  charged = false;
  delete signalBtn.dataset.charged;
  signalState.textContent = 'dormant';
  renderLastBeat();
  setState('listening');
  tuner.glideTo(tuner.homePos(), 0);
  if (opener && document.contains(opener)) opener.focus();
  opener = null;
});
$('#bd-close').addEventListener('click', () => dialog.close());
$$('[data-reveal]').forEach((b) => b.addEventListener('click', () => openReveal(b)));

let typed = '';
addEventListener('keydown', (e) => {
  if (dialog.open || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' && e.target.type !== 'range') return;
  if (tag === 'TEXTAREA' || e.target?.isContentEditable) return;
  typed = (typed + e.key.toLowerCase()).slice(-3);
  if (typed === 'fly') { typed = ''; openReveal(null); }
});

/* ================================================================== *
 * Boot. The only external input is the hash, checked against a fixed set.
 * ================================================================== */
const hash = location.hash.slice(1);
if (hash === 'better-days') {
  tuner.glideTo(tuner.homePos(), 0);
  setTimeout(() => openReveal(signalBtn), 400);
} else if (hash === 'transmit') {
  tuner.glideTo(tuner.homePos(), 0);
  setState('transmitting');
} else if (tuner.byId.has(hash) && hash !== 'gamma') {
  tuner.tuneTo(hash, 0);
} else {
  // tune in from the static, so the first thing you see is how this works
  dial.value = String(tuner.homePos() - 70);
  tuner.update();
  tuner.glideTo(tuner.homePos(), 1100);
}

addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (h === 'better-days') openReveal(signalBtn);
  else if (h === 'transmit') setState('transmitting');
  else if (tuner.byId.has(h) && h !== tuner.lockedId()) tuner.tuneTo(h);
});

$('#play').addEventListener('click', () => sound.toggle());
