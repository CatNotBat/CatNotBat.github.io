import { Dither, quad } from './dither.js';
import { assemble, CPU, ABI } from './rv32.js';
import { resolve as dnsResolve, RCODE } from './dns.js';

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

let deepDormant = false; // one unannounced day a year
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
function parseLine(src, lineNo = 0) {
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
      const at = i;
      i += m[0].length;
      node = atom(m[0]);
      node.pos = `${lineNo}:${at}`;
      node.end = i;
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
  const hl = $('#code-hl');
  const err = $('#code-err');
  let layers = [];
  const spans = new Map();
  const timers = new Map();

  // a transparent copy of the text sits under the textarea; its spans light up as they play
  function mirror(tokens) {
    spans.clear();
    const frag = document.createDocumentFragment();
    ta.value.split('\n').forEach((line, n) => {
      let at = 0;
      for (const t of (tokens.get(n) ?? []).sort((x, y) => x.s - y.s)) {
        if (t.s > at) frag.append(line.slice(at, t.s));
        const sp = document.createElement('span');
        sp.textContent = line.slice(t.s, t.e);
        spans.set(`${n}:${t.s}`, sp);
        frag.append(sp);
        at = t.e;
      }
      frag.append(`${line.slice(at)}\n`);
    });
    hl.replaceChildren(frag);
  }
  function collect(node, out) {
    if (node.pos) out.push({ s: Number(node.pos.split(':')[1]), e: node.end });
    node.ch?.forEach((c) => collect(c, out));
    return out;
  }
  function compile() {
    const next = [];
    const tokens = new Map();
    const lines = ta.value.split('\n');
    let bad = '';
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n].replace(/\/\/.*$/, '');
      if (!line.trim()) continue;
      try {
        const tree = parseLine(line, n);
        next.push(tree);
        tokens.set(n, collect(tree, []));
      } catch (e) { bad ||= `line ${n + 1}: ${e.message}`; }
    }
    err.textContent = bad;
    if (!bad) layers = next;
    mirror(tokens);
  }
  const sync = () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; };
  ta.addEventListener('scroll', sync);
  // writing music is asking to hear it
  ta.addEventListener('input', () => { compile(); sync(); if (!sound.on) sound.toggle(); });
  ta.addEventListener('keydown', (e) => e.stopPropagation());
  compile();
  return {
    events(cycle) { const out = []; layers.forEach((l) => query(l, cycle, 0, 1, out)); return out; },
    mark(pos, dur) {
      const sp = spans.get(pos);
      if (!sp) return;
      sp.classList.add('on');
      clearTimeout(timers.get(sp));
      timers.set(sp, setTimeout(() => sp.classList.remove('on'), clamp(dur * 900, 70, 600)));
    },
  };
})();

/* ================================================================== *
 * Sound. Off until asked. Everything is synthesised, nothing is fetched.
 * ================================================================== */
const sound = (() => {
  const btn = $('#sound');
  let ctx = null, master, noiseG, voiceG, noiseBuf;
  let on = false, cur = null, pending = 'home', timers = [], oscs = [];
  const geiger = { alive: false, rate: 3 };
  let flatOsc = null, flatG = null, dawnNodes = null, hushed = false, hetO = null, hetG = null;
  let analyser = null, harmRaw = null, harmBufs = null, harmGains = null, harmKey = 0;

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
    hetO = ctx.createOscillator(); hetO.type = 'sine'; hetO.frequency.value = 400;
    hetG = ctx.createGain(); hetG.gain.value = 0; hetO.connect(hetG); hetG.connect(master); hetO.start();
    analyser = ctx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.6; analyser.connect(voiceG);
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
      // the real take, when there is one: what Discord carried and what came out, looped together
      if (harmBufs) {
        const at = ctx.currentTime + 0.05;
        harmGains = harmBufs.map((b, i) => {
          const g = ctx.createGain(); g.gain.value = keyGain(i);
          const src = ctx.createBufferSource(); src.buffer = b; src.loop = true;
          if (i === 0) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.5; src.connect(lp); lp.connect(g); }
          else src.connect(g);
          g.connect(analyser); src.start(at); oscs.push(src);
          return g;
        });
        return;
      }
      const a = Array.from({ length: 10 }, (_, i) => osc('sine', 700 + i * 160, 0.005));
      timers.push(setInterval(() => a.forEach((o, i) => o.frequency.setTargetAtTime(700 + i * 160 + (Math.random() - 0.5) * 20, ctx.currentTime, 0.15)), 320));
    },
    hydrogen() { osc('sine', 1420.405, 0.035); },
    home() { timers.push(setInterval(() => blip(2402, 0.025, 0.05, 'sine'), 2100)); },
    // cp 1919: one click per measured period (1.3373 s)
    lgm1() { timers.push(setInterval(() => blip(1400, 0.012, 0.22, 'square'), 1337.3)); },
    roomsense() {
      // room tone: barely there, the sound of a quiet room with radios in its corners
      const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
      const g = ctx.createGain(); g.gain.value = 0.05;
      s.connect(lp); lp.connect(g); g.connect(voiceG); s.start(); oscs.push(s);
    },
    a440() {
      // look only 150 ms ahead, so an edit is heard almost as soon as it is typed
      const CYCLE = 2.4;
      const t0 = ctx.currentTime + 0.06;
      let until = 0;
      const sched = () => {
        const end = (ctx.currentTime + 0.15 - t0) / CYCLE;
        if (end <= until) return;
        for (let c = Math.floor(until); c < Math.ceil(end); c++) {
          for (const e of music.events(c)) {
            const b = c + e.b;
            if (b < until || b >= end) continue;
            const at = t0 + b * CYCLE;
            const dur = Math.min(e.d * CYCLE, 1.6);
            play(e.v, at, dur);
            setTimeout(() => { wire.packet(); music.mark(e.v.pos, dur); }, Math.max(0, (at - ctx.currentTime) * 1000));
          }
        }
        until = end;
      };
      sched();
      timers.push(setInterval(sched, 40));
    },
    gamma() {
      geiger.alive = true;
      const tick = () => { if (!geiger.alive) return; click(); setTimeout(tick, -Math.log(1 - Math.random()) * (1000 / geiger.rate)); };
      tick();
    },
  };
  // equal-power crossfade: the key turns the wire into the voice
  // the raw modem is harsh, so it sits low; the voice comes up clear
  const keyGain = (i) => (i ? 0.95 * Math.sin((harmKey * Math.PI) / 2) : 0.28 * Math.cos((harmKey * Math.PI) / 2));
  async function decodeHarm() {
    if (harmBufs || !harmRaw || !ctx) return;
    try { harmBufs = await Promise.all(harmRaw.map((b) => ctx.decodeAudioData(b.slice(0)))); } catch { harmBufs = null; }
  }
  function stopVoice() {
    timers.forEach(clearInterval); timers = [];
    oscs.forEach((o) => { try { o.stop(); } catch { /* already stopped */ } }); oscs = [];
    geiger.alive = false;
  }
  function station(id) {
    pending = id;
    if (!on || id === cur) return;
    stopVoice(); harmGains = null; cur = id; voices[id]?.();
  }
  function levels(staticLevel, signal) {
    if (!on || hushed) return;
    const t = ctx.currentTime;
    noiseG.gain.setTargetAtTime(0.015 + 0.16 * staticLevel, t, 0.04);
    voiceG.gain.setTargetAtTime(signal * signal, t, 0.06);
  }
  btn.addEventListener('click', () => {
    if (!ctx && !init()) { btn.textContent = 'no audio here'; return; }
    on = !on;
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? 'sound on' : 'sound off';
    if (on) {
      ctx.resume(); master.gain.setTargetAtTime(0.5, ctx.currentTime, 0.1); cur = null; tuner.refresh();
      decodeHarm().then(() => { if (cur === 'harmonium') { stopVoice(); cur = null; tuner.refresh(); } });
    }
    else { master.gain.setTargetAtTime(0, ctx.currentTime, 0.05); stopVoice(); cur = null; }
  });
  return {
    station, levels, geiger, toggle: () => btn.click(),
    // the heterodyne: near a station you hear the beat between you and it, falling to nothing as you lock on
    het(dist, capture, lock) {
      if (!on || !hetG) return;
      const t = ctx.currentTime;
      if (hushed || dist <= lock || dist >= capture) { hetG.gain.setTargetAtTime(0, t, 0.04); return; }
      const x = (dist - lock) / (capture - lock);
      hetO.frequency.setTargetAtTime(25 + x * x * 2200, t, 0.02);
      hetG.gain.setTargetAtTime(0.026 * Math.sin(Math.PI * Math.min(1, x * 1.1)) ** 0.7, t, 0.03);
    },
    loadHarmonium(raw) { harmRaw = raw; if (on) decodeHarm().then(() => { if (cur === 'harmonium') { stopVoice(); cur = null; tuner.refresh(); } }); },
    key(k) {
      harmKey = clamp(k, 0, 1);
      if (harmGains && ctx) harmGains.forEach((g, i) => g.gain.setTargetAtTime(keyGain(i), ctx.currentTime, 0.03));
    },
    spectrum(out) {
      if (!on || cur !== 'harmonium' || !analyser) return 0;
      analyser.getByteFrequencyData(out);
      return ctx.sampleRate;
    },
    get on() { return on; },
    twang() { if (on) blip(90 + Math.random() * 90, 0.7, 0.14, 'triangle'); },
    // one BLE advertisement, heard by each node from where it sits: panned, and as loud as it heard it
    adv(heard) {
      if (!on || cur !== 'roomsense') return;
      const t = ctx.currentTime;
      const f = [2402, 2426, 2480][(Math.random() * 3) | 0] / 1.2; // ch 37/38/39, as a soft filtered tick
      for (const { pan, db } of heard) {
        const g = clamp(10 ** ((db + 40) / 20), 0, 1) * 0.22;
        if (g < 0.003) continue;
        const o = ctx.createBufferSource(); o.buffer = noiseBuf;
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 9;
        const gn = ctx.createGain();
        gn.gain.setValueAtTime(0, t); gn.gain.linearRampToValueAtTime(g, t + 0.002); gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.022);
        o.connect(bp); bp.connect(gn);
        if (ctx.createStereoPanner) { const pn = ctx.createStereoPanner(); pn.pan.value = clamp(pan, -1, 1); gn.connect(pn); pn.connect(voiceG); }
        else gn.connect(voiceG);
        o.start(t, Math.random()); o.stop(t + 0.04);
      }
    },
    // Better days: the monitor
    flat(onOff) {
      if (!on) return;
      if (onOff && !flatOsc) {
        flatOsc = ctx.createOscillator(); flatOsc.frequency.value = 880;
        flatG = ctx.createGain(); flatG.gain.setValueAtTime(0, ctx.currentTime); flatG.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 0.02);
        flatOsc.connect(flatG); flatG.connect(master); flatOsc.start();
      } else if (!onOff && flatOsc) {
        const o = flatOsc; flatG.gain.setValueAtTime(flatG.gain.value, ctx.currentTime); flatG.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.01);
        setTimeout(() => o.stop(), 40); flatOsc = null;
      }
    },
    beep() {
      if (!on) return;
      const t = ctx.currentTime;
      const o = ctx.createOscillator(); o.frequency.value = 880;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09, t + 0.005); g.gain.setValueAtTime(0.09, t + 0.13); g.gain.linearRampToValueAtTime(0, t + 0.15);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.2);
    },
    dawn(onOff) {
      if (!on) return;
      const t = ctx.currentTime;
      if (onOff && !dawnNodes) {
        dawnNodes = [110, 164.81, 220, 329.63].map((f, i) => {
          const o = ctx.createOscillator(); o.type = i ? 'sine' : 'triangle'; o.frequency.value = f; o.detune.value = (Math.random() - 0.5) * 6;
          const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(i ? 0.018 : 0.03, t + 4);
          o.connect(g); g.connect(master); o.start(t);
          return { o, g };
        });
      } else if (!onOff && dawnNodes) {
        dawnNodes.forEach(({ o, g }) => { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + 2.5); o.stop(t + 2.6); });
        dawnNodes = null;
      }
    },
    // the story is the one silent place: no static, no station
    hush(onOff) {
      if (!ctx) return;
      const t = ctx.currentTime;
      if (onOff && hetG) hetG.gain.setTargetAtTime(0, t, 0.03);
      if (onOff) { noiseG.gain.cancelScheduledValues(t); noiseG.gain.setTargetAtTime(0, t, 0.05); voiceG.gain.cancelScheduledValues(t); voiceG.gain.setTargetAtTime(0, t, 0.05); }
      hushed = onOff;
    },
    chime(up) {
      if (!on || cur !== 'roomsense') return;
      blip(up ? 329.63 : 493.88, 0.9, 0.025, 'sine');
      setTimeout(() => blip(up ? 493.88 : 329.63, 1.2, 0.022, 'sine'), 220);
    },
    thump() { if (on) { blip(62, 0.28, 0.5, 'sine'); setTimeout(() => blip(55, 0.22, 0.35, 'sine'), 190); } },
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
    // the story stays an easter egg: only gamma, the signal button or typing 'fly' opens it
    if (tuner.lockedId() === 'gamma') setTimeout(() => openReveal(null), 600);
  }
}
addEventListener('pointermove', (e) => {
  if (lastPointer) feed(Math.min(1.2, Math.hypot(e.clientX - lastPointer[0], e.clientY - lastPointer[1]) * (state === 'dormant' ? 0.012 : tuner.lockedId() === 'rv32' ? 0.02 : 0.004)));
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
  if (reserveEl) reserveEl.textContent = String(Math.round(reserve));
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

/* ---- volume 3, T4: particle life in the static, between stations ---- */
const life = (() => {
  const K = 3, N = 380, RMIN = 0.3, RMAX = 0.13, FRIC = 0.12; // tuned offline: clusters form in ~2.5 s, drift ~2 px a frame
  // the rules change once a day, so the creatures are different tomorrow
  let seed = Math.floor(Date.now() / 864e5) * 2654435761 >>> 0;
  const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 4294967296);
  const M = Array.from({ length: K }, () => Array.from({ length: K }, () => rnd() * 2 - 1));
  const P = Array.from({ length: N }, () => ({ x: rnd(), y: rnd(), vx: 0, vy: 0, k: (rnd() * K) | 0 }));
  let prev = 0;
  function force(r, a) { return r < RMIN ? r / RMIN - 1 : r < 1 ? a * (1 - Math.abs(2 * r - 1 - RMIN) / (1 - RMIN)) : 0; }
  function frame(o, w, h, t, level) {
    const dt = Math.min(0.05, prev ? (t - prev) / 1000 : 0.016); prev = t;
    const ar = h / w;
    for (const p of P) {
      let fx = 0, fy = 0;
      for (const q of P) {
        if (p === q) continue;
        let dx = q.x - p.x, dy = (q.y - p.y) * ar;
        dx -= Math.round(dx); dy -= Math.round(dy / ar) * ar;
        const r = Math.hypot(dx, dy);
        if (r > 0 && r < RMAX) { const f = force(r / RMAX, M[p.k][q.k]) / r; fx += dx * f; fy += dy * f; }
      }
      p.vx = p.vx * (1 - FRIC) + fx * RMAX * 6 * dt; p.vy = p.vy * (1 - FRIC) + (fy / ar) * RMAX * 6 * dt;
    }
    for (const p of P) {
      p.x = (p.x + p.vx * dt * 2 + 1) % 1; p.y = (p.y + p.vy * dt * 2 + 1) % 1;
      o.fillStyle = `rgba(255,0,0,${Math.min(1, 0.5 + 0.8 * level) * (p.k === 0 ? 1 : 0.75)})`;
      o.fillRect((p.x * w) | 0, (p.y * h) | 0, p.k === 0 ? 2 : 1, 1);
    }
  }
  return { frame };
})();

const wire = (() => {
  const host = $('.wires');
  const canvas = $('#wire');
  const noop = { beat() {}, packet() {}, useStatic() {}, set staticLevel(v) {} };
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
  let real = null;
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
        if (real) {
          // a recorded sweep, one row at a time: the loud columns are real carriers
          const row = real.rows[((t / 90) | 0) % real.rows.length];
          const n = staticLevel * w * h * 0.03;
          for (let i = 0; i < n; i++) {
            const x = (Math.random() * w) | 0;
            const v = row[((x * real.width) / w) | 0] / 255;
            if (Math.random() > v * v * 1.6) continue;
            o.fillStyle = `rgba(255,0,0,${0.3 + v * 0.7})`;
            o.fillRect(x, (Math.random() * h) | 0, 1, 1);
          }
        } else {
          const n = staticLevel * w * h * 0.012;
          for (let i = 0; i < n; i++) {
            o.fillStyle = `rgba(255,0,0,${0.25 + Math.random() * 0.5})`;
            o.fillRect((Math.random() * w) | 0, (Math.random() * h) | 0, 1, 1);
          }
        }
      }
      // something lives in the static: a few hundred particles with rules about each other
      if (staticLevel > 0.02 && !reduceMotion.matches) life.frame(o, w, h, t, staticLevel);
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
    useStatic(d) { real = d; },
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

// some stations only exist on radios that can receive them
const unreachable = [];
document.querySelectorAll('.station[data-needs]').forEach((el) => {
  const need = el.dataset.needs;
  const ok = need === 'reduce' ? matchMedia('(prefers-reduced-motion: reduce)').matches
    : need === 'webgpu' ? 'gpu' in navigator
    : need === 'pip' ? 'documentPictureInPicture' in window : true;
  if (!ok) { unreachable.push(el.dataset.name); el.remove(); }
});

const tuner = (() => {
  const stations = $$('.station[data-f]').map((el) => ({
    el, id: el.id, f: Number(el.dataset.f), k: el.dataset.k, v: el.dataset.v, name: el.dataset.name, secret: 'secret' in el.dataset,
  })).sort((a, b) => a.f - b.f);
  const N = stations.length;
  // the listed stations keep an even dial; hidden ones sit in the static between them,
  // placed by frequency but never too close to a neighbour, with a narrower capture
  const pub = stations.filter((s) => !s.secret);
  pub.forEach((s, i) => { s.pos = Math.round(60 + (i * 880) / (pub.length - 1)); s.cap = 60; });
  for (const s of stations.filter((x) => x.secret)) {
    s.cap = 22;
    const lo = [...pub].reverse().find((x) => x.f < s.f), hi = pub.find((x) => x.f > s.f);
    if (!lo) { s.pos = Math.max(12, hi.pos - 42); continue; }
    if (!hi) { s.pos = Math.min(988, lo.pos + 42); continue; }
    const t = (Math.log10(s.f) - Math.log10(lo.f)) / (Math.log10(hi.f) - Math.log10(lo.f));
    s.pos = Math.round(lo.pos + (hi.pos - lo.pos) * Math.min(0.68, Math.max(0.32, t)));
  }
  // two hidden stations in one gap: push them apart
  const sec = stations.filter((x) => x.secret).sort((a, b) => a.pos - b.pos);
  for (let i = 1; i < sec.length; i++) if (sec[i].pos - sec[i - 1].pos < 30) sec[i].pos = sec[i - 1].pos + 30;
  stations.sort((a, b) => a.pos - b.pos);
  const byId = new Map(stations.map((s) => [s.id, s]));
  const CAPTURE = 60; // listed stations; hidden ones use s.cap
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
      acceptNode: (n) => (n.parentElement.closest('pre, svg, button, .dwell, textarea, .code, .mcu, .prov, .resolve') || !n.data.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
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

  // presets sit under their own ticks (CSS positions them only on wide screens)
  $$('[data-preset]').forEach((a) => { const st = byId.get(a.dataset.preset); if (st) a.style.left = `${st.pos / 10}%`; });

  const found = new Set((() => { try { return JSON.parse(store.get('lk.found') || '[]'); } catch { return []; } })().filter((id) => byId.has(id)));
  const logEl = $('#logbook');
  const presets = $$('[data-preset]');
  function renderLog() {
    if (logEl) logEl.textContent = `${found.size}/${N}`;
    presets.forEach((a) => { if (found.has(a.dataset.preset)) a.dataset.found = ''; });
  }
  renderLog();

  let shown = byId.get('home');
  let locked = null;
  let lastAnnounced = null;
  stations.forEach((s) => { s.el.hidden = s !== shown; });

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
    const sig = clamp(1 - dist / s.cap, 0, 1);
    const isLocked = dist <= LOCK;

    {
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
    sound.het(dist, s.cap, LOCK);
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
    if (Math.abs(s.pos - p) <= s.cap * 0.6) glideTo(s.pos, 220);
  });
  dial.addEventListener('keydown', (e) => {
    const map = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
    if (e.key in map) { e.preventDefault(); stepStation(map[e.key]); }
    else if (e.key === 'Home') { e.preventDefault(); glideTo(pub[0].pos, 900); }
    else if (e.key === 'End') { e.preventDefault(); glideTo(pub[pub.length - 1].pos, 900); }
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

  return {
    update, tuneTo, glideTo, byId,
    lockedId: () => locked?.id ?? null,
    refresh() { sound.station(nearest(Number(dial.value)).id); update(); },
    homePos: () => byId.get('home').pos,
  };
})();

/* ================================================================== *
 * State: listening or dormant.
 * ================================================================== */
let state = 'listening';
const stateBtns = $$('.r-state [data-state]');
function setState(s) {
  if (s === state) return;
  const prev = state;
  state = s;
  document.body.dataset.state = s;
  stateBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.state === s)));
  if (s === 'dormant') { announce.textContent = 'Dormant. Tap or press Escape to wake it.'; sound.levels(0.05, 0); dormantSince = performance.now(); }
  if (prev === 'dormant') tuner.update();
}
stateBtns.forEach((b) => b.addEventListener('click', () => { if (!deepDormant) setState(b.dataset.state); }));
// a tap anywhere wakes it (moving around only gathers); a short grace so the click that put it to sleep doesn't wake it
let dormantSince = 0;
addEventListener('pointerdown', (e) => {
  if (state !== 'dormant' || deepDormant || performance.now() - dormantSince < 400 || e.target.closest('.r-state')) return;
  cpr.tap();
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && state === 'dormant' && !dialog.open && !deepDormant) setState('listening'); });
addEventListener('keydown', (e) => { if (e.key === ' ' && state === 'dormant' && !dialog.open && !e.repeat && !deepDormant) { e.preventDefault(); if (performance.now() - dormantSince > 400) cpr.tap(); } });
// leave it alone for a while and it does what it does most of its life: it dies, and waits
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = performance.now(); return; }
  if (hiddenAt && performance.now() - hiddenAt > 45000 && state === 'listening' && !dialog.open) setState('dormant');
});

/* ================================================================== *
 * Small things
 * ================================================================== */
// harmonium: one key, from what Discord carries to what the other end hears, and a live look at it
(() => {
  const fig = $('.sig-carrier');
  if (!fig) return;
  const key = $('#harm-key');
  const noise = fig.querySelector('.noise');
  const comb = fig.querySelector('.comb');
  const canvas = fig.querySelector('.live');
  const d = new Dither(canvas, 2);
  const bins = new Uint8Array(1024);
  let raf = 0;
  function apply() {
    const k = Number(key.value) / 100;
    sound.key(k);
    noise.style.opacity = String(1 - 0.85 * k);
    comb.style.opacity = String(k);
    fig.dataset.view = k > 0.5 ? 'comb' : 'noise';
  }
  function draw() {
    raf = requestAnimationFrame(draw);
    const rate = tuner.lockedId() === 'harmonium' ? sound.spectrum(bins) : 0;
    fig.classList.toggle('playing', !!rate);
    if (!rate) return;
    d.resize();
    const hz = rate / 2048;
    d.render((o, w, h) => {
      o.fillStyle = 'rgba(255,0,0,1)';
      for (let x = 0; x < w; x++) {
        const v = bins[Math.min(1023, Math.floor(((x / w) * 4000) / hz))] / 255;
        const bh = Math.round(v * v * h * 1.1);
        o.globalAlpha = 0.35 + 0.65 * v;
        o.fillRect(x, h - bh, 1, bh);
      }
      o.globalAlpha = 1;
    });
  }
  key.addEventListener('input', apply);
  key.addEventListener('keydown', (e) => e.stopPropagation());
  // touching the key is asking to hear it
  key.addEventListener('pointerdown', () => { if (!sound.on) sound.toggle(); });
  key.addEventListener('keydown', () => { if (!sound.on) sound.toggle(); }, { once: true });
  apply();
  raf = requestAnimationFrame(draw);
})();

// dns: ask the wire anything, and see the bytes both ways
(() => {
  const form = $('#resolve');
  if (!form) return;
  const qname = $('#qname');
  const qtype = $('#qtype');
  const pre = $('#hexdump');
  const cap = $('#dns-cap');
  const verdict = $('#dns-verdict');
  form.hidden = false;
  const hx = (b) => b.toString(16).padStart(2, '0');
  const line = (frag, ...parts) => { parts.forEach((p) => frag.append(p)); frag.append('\n'); };
  const span = (cls, text) => { const e = document.createElement(cls === 'b' || cls === 'em' ? cls : 'span'); if (cls !== 'b' && cls !== 'em') e.className = cls; e.textContent = text; return e; };

  function dump(frag, bytes, other, qEnd, maxRows = 20) {
    const rows = Math.ceil(bytes.length / 16);
    for (let r = 0; r < Math.min(rows, maxRows); r++) {
      frag.append(span('off', (r * 16).toString(16).padStart(4, '0')), ' ');
      for (let i = r * 16; i < Math.min(bytes.length, r * 16 + 16); i++) {
        const t = hx(bytes[i]);
        frag.append(' ');
        if (i < 12 && other && other[i] !== bytes[i]) frag.append(span('em', t));
        else if (i >= 12 && i < qEnd) frag.append(span('b', t));
        else frag.append(t);
      }
      frag.append('\n');
    }
    if (rows > maxRows) line(frag, span('off', `  +${bytes.length - maxRows * 16}`), '  more bytes');
  }

  async function run() {
    const name = qname.value;
    form.setAttribute('aria-busy', 'true');
    cap.textContent = 'asking 1.1.1.1...';
    try {
      const r = await dnsResolve(name, qtype.value);
      const frag = document.createDocumentFragment();
      line(frag, span('dir', 'asked'));
      dump(frag, r.query.bytes, r.answer, r.query.qnameEnd);
      line(frag);
      line(frag, span('dir', 'answer'));
      dump(frag, r.answer, r.query.bytes, r.query.qnameEnd);
      line(frag);
      line(frag, span('dir', 'qname'), '   ', span('b', r.query.name));
      line(frag, span('dir', 'rcode'), '   ', span('em', String(r.parsed.rcode)), `  ${RCODE[r.parsed.rcode] ?? '?'}`);
      for (const a of r.parsed.answers.slice(0, 8)) line(frag, span('dir', a.type.padEnd(5)), '   ', a.data, span('off', `  ttl ${a.ttl}`));
      if (!r.parsed.answers.length) for (const a of r.parsed.authority.slice(0, 2)) line(frag, span('dir', 'auth'), '    ', `${a.type} ${a.data}`);
      pre.replaceChildren(frag);
      cap.textContent = `Just now, to 1.1.1.1 over HTTPS, ${r.ms} ms.`;
      verdict.textContent = r.parsed.rcode === 3 ? 'disagree' : 'agree';
    } catch (e) {
      cap.textContent = e instanceof TypeError ? 'Could not reach 1.1.1.1.' : e.message;
    } finally {
      form.removeAttribute('aria-busy');
    }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  qtype.addEventListener('change', run);
  [qname, qtype].forEach((el) => el.addEventListener('keydown', (e) => e.stopPropagation()));
})();

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

// roomsense, as it actually works: four corner nodes, each a BLE ear and an LD2450 radar.
// The radars only see inside the room; the ears hear your phone through the wall too.
// Presence is a probability that builds and decays (5 s in, 25 s out in the real thing,
// quicker here), and the answer is a census by device type, never an identity.
(() => {
  const fig = $('.sig-room');
  if (!fig) return;
  const svg = fig.querySelector('svg');
  const NODES = [[24, 18], [176, 18], [24, 142], [176, 142]];
  const ROOM = { x0: 20, y0: 14, x1: 180, y1: 146 };
  const PX_PER_M = 40;
  const fov = [...fig.querySelectorAll('.fov path')];
  const lines = [...fig.querySelectorAll('.radar line')];
  const blips = [...fig.querySelectorAll('.radar rect')];
  const est = fig.querySelector('.est');
  const mac = fig.querySelector('.mac');
  const dbm = [...fig.querySelectorAll('.dbm text')];
  const c1 = fig.querySelector('.c1');
  const c2 = fig.querySelector('.c2');
  const CARRY = [['phone'], ['phone', 'earbuds'], ['phone', 'earbuds', 'watch'], ['laptop']];
  let carry = 0;
  let you = null;        // where the pointer is, in room units, or null when gone
  let p = 0.02;          // presence probability
  let occupied = false;
  let raf = 0, last = 0, nextAdv = 0, nextRot = 0, nextRadar = 0, nextTrack = 0;
  let fused = null, shown = null, seen = false;
  const track = [];
  const NS = 'http://www.w3.org/2000/svg';
  const radarG = fig.querySelector('.radar');
  const trackEl = document.createElementNS(NS, 'polyline');
  trackEl.setAttribute('class', 'track');
  radarG.prepend(trackEl);
  // phosphor: each radar return leaves a dot that fades, like an old scope
  const dots = Array.from({ length: 48 }, () => {
    const el = document.createElementNS(NS, 'circle');
    el.setAttribute('r', '0.9'); el.setAttribute('class', 'ph'); el.setAttribute('opacity', '0');
    radarG.prepend(el);
    return { el, t0: -1e9, a: 0 };
  });
  let dotI = 0;
  const glow = (x, y, t) => {
    const g = dots[dotI++ % dots.length];
    g.t0 = t; g.el.setAttribute('cx', x.toFixed(1)); g.el.setAttribute('cy', y.toFixed(1));
  };
  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
  const inside = (x, y) => x > ROOM.x0 && x < ROOM.x1 && y > ROOM.y0 && y < ROOM.y1;
  const sees = (i, x, y) => {
    const [nx, ny] = NODES[i];
    const face = Math.atan2(80 - ny, 100 - nx);
    let d = Math.atan2(y - ny, x - nx) - face;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return inside(x, y) && Math.abs(d) < Math.PI / 3 && Math.hypot(x - nx, y - ny) < 240;
  };
  const rssiAt = (i, x, y) => {
    const m = Math.max(0.3, Math.hypot(x - NODES[i][0], y - NODES[i][1]) / PX_PER_M);
    return -47 - 22 * Math.log10(m) - (inside(x, y) ? 0 : 7) + gauss() * 2;
  };
  const rotate = () => { mac.textContent = Array.from({ length: 3 }, () => ((Math.random() * 256) | 0).toString(16).padStart(2, '0')).join(':') + ':..'; };

  function frame(t) {
    raf = 0;
    const dt = Math.min(0.1, (t - (last || t)) / 1000);
    last = t;
    const here = you && inside(you[0], you[1]);

    // radar: each node that can see you reports its own slightly wrong position (~16 Hz)
    if (t > nextRadar) {
      nextRadar = t + 60;
      let fx = 0, fy = 0, n = 0;
      NODES.forEach(([nx, ny], i) => {
        const on = !!you && sees(i, you[0], you[1]);
        fov[i].classList.toggle('sees', on);
        lines[i].classList.toggle('on', on);
        blips[i].classList.toggle('on', on);
        if (!on) return;
        const bx = you[0] + gauss() * 1.4, by = you[1] + gauss() * 1.4;
        lines[i].setAttribute('x2', bx.toFixed(1)); lines[i].setAttribute('y2', by.toFixed(1));
        blips[i].setAttribute('transform', `translate(${bx.toFixed(1)} ${by.toFixed(1)})`);
        glow(bx, by, t);
        fx += bx; fy += by; n++;
      });
      seen = n > 0;
      if (n) { fused = [fx / n, fy / n]; if (!shown) shown = fused.slice(); }
      else shown = null;
      est.classList.toggle('on', seen);
      // the ears: everyone hears the phone, louder when close, quieter through the wall
      dbm.forEach((el, i) => {
        if (!you) { el.textContent = ''; return; }
        const r = rssiAt(i, you[0], you[1]);
        el.textContent = `${Math.round(r)} dBm`;
        el.classList.toggle('loud', r > -62);
      });
    }

    // between reports the estimate glides; a faint track remembers where you've been
    if (seen && shown) {
      const k = reduceMotion.matches ? 1 : 1 - Math.exp(-dt / 0.05);
      shown = [shown[0] + (fused[0] - shown[0]) * k, shown[1] + (fused[1] - shown[1]) * k];
      est.setAttribute('transform', `translate(${shown[0].toFixed(1)} ${shown[1].toFixed(1)})`);
      if (t > nextTrack) {
        nextTrack = t + 70;
        track.push(shown.slice());
        if (track.length > 28) track.shift();
      }
    } else if (track.length && t > nextTrack) { nextTrack = t + 70; track.shift(); }
    trackEl.setAttribute('points', track.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
    for (const g of dots) {
      const a = Math.max(0, 1 - (t - g.t0) / 900);
      if (g.a !== a) { g.a = a; g.el.setAttribute('opacity', (a * 0.6).toFixed(2)); }
    }

    // the fused classifier: certain inside, unsure near a wall from outside, sure of nothing far away
    const nearWall = you && !here && dbm.some((el) => Number.parseInt(el.textContent, 10) > -62);
    const goal = here ? 0.96 : nearWall ? 0.14 : 0.02;
    const tau = goal > p ? 1.2 : 4;
    p += (goal - p) * (1 - Math.exp(-dt / tau));
    const nowOcc = p >= 0.5;
    if (nowOcc !== occupied) {
      occupied = nowOcc;
      sound.chime(occupied);
      announce.textContent = occupied ? `roomsense: occupied, ${CARRY[carry].join(', ')}.` : 'roomsense: empty.';
    }
    c1.textContent = `${occupied ? 'occupied' : 'empty'} ${p.toFixed(2)}`;
    c1.classList.toggle('occupied', occupied);
    c2.textContent = occupied ? CARRY[carry].join('  ') : '';

    // the phone advertises; it changes its address every so often and the census doesn't care
    if (you && t > nextRot) { rotate(); nextRot = t + 6000 + Math.random() * 3000; }
    if (you && t > nextAdv) {
      nextAdv = t + 320 + Math.random() * 380;
      sound.adv(NODES.map(([nx], i) => ({ pan: (nx - 100) / 90, db: rssiAt(i, you[0], you[1]) })));
    }

    fig.classList.toggle('sensing', !!you);
    if (you || p > 0.025 || track.length) raf = requestAnimationFrame(frame);
    else last = 0;
  }
  const wake = () => { if (!raf) raf = requestAnimationFrame(frame); };
  function at(ev) {
    const m = svg.getScreenCTM();
    if (!m) return null;
    const q = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    return [q.x, q.y];
  }
  svg.addEventListener('pointermove', (ev) => { you = at(ev); wake(); });
  // a tap inside the room (once you're already in it) changes what you're carrying
  svg.addEventListener('pointerdown', (ev) => {
    const q = at(ev);
    if (q && you && inside(you[0], you[1]) && inside(q[0], q[1])) carry = (carry + 1) % CARRY.length;
    you = q; wake();
  });
  svg.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') you = null; });
  svg.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[e.key];
    if (step) {
      e.preventDefault(); e.stopPropagation();
      you = you ?? [100, 170];
      you = [clamp(you[0] + step[0], -20, 220), clamp(you[1] + step[1], -20, 180)];
      wake();
    } else if (e.key === 'Enter') { carry = (carry + 1) % CARRY.length; wake(); }
    else if (e.key === 'Escape') { you = null; wake(); }
  });
  rotate();
})();

const lastBeatEl = $('#last-beat');
function renderLastBeat() {
  const t = Number(store.get('lk.lastBeat'));
  if (!t || !lastBeatEl) return;
  const s = (Date.now() - t) / 1000;
  lastBeatEl.textContent = s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}
renderLastBeat();
setInterval(renderLastBeat, 30000);

/* ================================================================== *
 * 160 MHz. An emulated RV32IM chip running the beakless's firmware.
 *   0x60000000 uart   0x60000004 heart   0x60000008 h2   0x6000000c sleep
 * ================================================================== */
const mcu = (() => {
  const fw = $('#fw');
  if (!fw) return null;
  const ed = $('#fw-edit');
  const err = $('#fw-err');
  const led = $('#led');
  const stEl = $('#mcu-state');
  const uart = $('#uart');
  const editB = $('#mcu-edit');
  const stepB = $('#mcu-step');
  const contB = $('#mcu-cont');
  const SPEED = 10; // instructions per second: slow enough to read along
  const REGRX = new RegExp(`\\b(${ABI.join('|')}|x\\d{1,2})\\b`, 'g');
  let source = fw.textContent;
  let prog = null, cpu = null, lines = [], curLine = -1;
  let out = '', gpio = 0, sleepUntil = 0, acc = 0, last = 0;
  let paused = false, skipLine = -1;
  const bps = new Set();
  const hex = (v) => (v >>> 0).toString(16).padStart(8, '0');
  const fmt = (v) => (Math.abs(v) < 100000 ? String(v) : `0x${hex(v)}`);

  const io = {
    read(off) { return off === 8 ? Math.round(reserve) : off === 4 ? gpio : 0; },
    write(off, v) {
      if (off === 0) { out = (out + String.fromCharCode(v & 0xff)).slice(-800); }
      else if (off === 4) {
        const on = v & 1;
        if (on && !gpio) { wire.beat(); sound.thump(); jolt(); }
        gpio = on;
      } else if (off === 8) {
        reserve = clamp(v | 0, 0, 100);
        if (reserve < 100 && charged) { charged = false; delete signalBtn.dataset.charged; signalState.textContent = 'dormant'; }
      } else if (off === 12) sleepUntil = performance.now() + clamp(v | 0, 0, 60000);
    },
  };

  function build() {
    const code = new Set(prog.lineAt.values());
    for (const n of [...bps]) if (!code.has(n)) bps.delete(n);
    fw.replaceChildren(...source.split('\n').map((t, n) => {
      const ln = document.createElement('span'); ln.className = 'ln';
      let g;
      if (code.has(n)) {
        g = document.createElement('button');
        g.type = 'button';
        g.setAttribute('aria-label', `breakpoint on line ${n + 1}`);
        g.setAttribute('aria-pressed', String(bps.has(n)));
        g.addEventListener('click', () => {
          if (bps.has(n)) bps.delete(n); else bps.add(n);
          g.setAttribute('aria-pressed', String(bps.has(n)));
        });
      } else g = document.createElement('span');
      g.className = 'bp';
      const tx = document.createElement('span'); tx.textContent = t;
      const ann = document.createElement('span'); ann.className = 'ann';
      ln.append(g, tx, ann, '\n');
      return ln;
    }));
    lines = [...fw.children];
  }

  function flash() {
    try { prog = assemble(source); } catch (e) { err.textContent = e.message; return false; }
    err.textContent = `${prog.size} bytes`;
    cpu = new CPU(prog.image, io);
    out = ''; gpio = 0; sleepUntil = 0; acc = 0; curLine = -1;
    build();
    resume(false);
    render();
    return true;
  }

  // while paused, the registers on the current line show their values; tap one to change it
  function clearAnn() { fw.querySelectorAll('.ann').forEach((a) => a.replaceChildren()); }
  function annotate() {
    clearAnn();
    const ln = prog.lineAt.get(cpu.pc);
    const ann = lines[ln]?.querySelector('.ann');
    if (!ann) return;
    const names = [...new Set(source.split('\n')[ln].replace(/#.*/, '').match(REGRX) ?? [])].filter((r) => r !== 'zero');
    for (const r of names) {
      const i = ABI.includes(r) ? ABI.indexOf(r) : Number(r.slice(1));
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'val';
      b.textContent = `${r}=${fmt(cpu.x[i])}`;
      b.setAttribute('aria-label', `${r} is ${cpu.x[i]}. Change it`);
      b.addEventListener('click', () => poke(b, r, i));
      ann.append(b);
    }
  }
  function poke(b, r, i) {
    const inp = document.createElement('input');
    inp.className = 'val-in';
    inp.value = String(cpu.x[i]);
    inp.setAttribute('aria-label', `new value for ${r}`);
    inp.inputMode = 'numeric';
    const done = (save) => {
      if (save) {
        const v = /^-?0x[0-9a-f]+$/i.test(inp.value.trim()) ? Number.parseInt(inp.value, 16) : Number(inp.value);
        if (Number.isFinite(v) && i !== 0) cpu.x[i] = v | 0;
      }
      annotate();
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    inp.addEventListener('blur', () => done(true), { once: true });
    b.replaceWith(inp);
    inp.focus(); inp.select();
  }

  function pause() { paused = true; stepB.hidden = false; contB.hidden = false; annotate(); render(); }
  function resume(skip = true) {
    paused = false; stepB.hidden = true; contB.hidden = true; clearAnn();
    skipLine = skip ? prog.lineAt.get(cpu.pc) ?? -1 : -1;
  }

  function render() {
    const ln = prog.lineAt.get(cpu.pc);
    if (ln !== curLine) {
      lines[curLine]?.classList.remove('pc');
      const el = lines[ln];
      if (el) {
        el.classList.add('pc');
        const top = el.offsetTop - fw.offsetTop;
        if (top < fw.scrollTop || top > fw.scrollTop + fw.clientHeight - 24) fw.scrollTop = top - fw.clientHeight / 3;
      }
      curLine = ln;
    }
    cpu.touched.clear();
    const u = out.split('\n').slice(-9).join('\n');
    if (uart.textContent !== u) uart.textContent = u;
    led.toggleAttribute('data-on', !!gpio);
    const sleeping = performance.now() < sleepUntil;
    stEl.textContent = cpu.halted ?? (paused ? `paused, line ${ln + 1}` : sleeping ? 'asleep' : 'awake');
  }

  const active = () => tuner.lockedId() === 'rv32' && state === 'listening' && !dialog.open && !document.hidden && ed.hidden;
  function loop(t) {
    requestAnimationFrame(loop);
    const dt = Math.min(100, t - last);
    last = t;
    if (!cpu || !active()) return;
    if (!cpu.halted && !paused && t >= sleepUntil) {
      acc += (dt / 1000) * SPEED;
      let n = Math.floor(acc);
      acc -= n;
      while (n-- > 0 && !cpu.halted && !paused && performance.now() >= sleepUntil) {
        const ln = prog.lineAt.get(cpu.pc);
        if (skipLine !== -1 && ln !== skipLine) skipLine = -1;
        if (bps.has(ln) && ln !== skipLine) { pause(); break; }
        cpu.step();
      }
    }
    render();
  }
  requestAnimationFrame(loop);

  stepB.addEventListener('click', () => { cpu.step(); annotate(); render(); });
  contB.addEventListener('click', () => { resume(); render(); });

  editB.addEventListener('click', () => {
    if (ed.hidden) {
      ed.value = source;
      ed.hidden = false; fw.hidden = true;
      editB.textContent = 'flash'; editB.setAttribute('aria-pressed', 'true');
      ed.focus();
    } else {
      source = ed.value;
      if (flash()) {
        ed.hidden = true; fw.hidden = false;
        editB.textContent = 'edit'; editB.setAttribute('aria-pressed', 'false');
      }
    }
  });
  ed.addEventListener('keydown', (e) => e.stopPropagation());
  flash();
  return { flash };
})();

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
  sound.hush(true);
  dialog.showModal();
  ecg.resize();
  story.scrollTop = 0;
  store.set('lk.lastBeat', String(Date.now()));

  if (reduceMotion.matches) { stage('s-dawn', 'flying'); stage('s-story'); story.focus({ preventScroll: true }); return; }

  const t0 = performance.now();
  const hum = (t) => { drawEcg('hum', t - t0); ecgRaf = requestAnimationFrame(hum); };
  ecgRaf = requestAnimationFrame(hum);
  at(700, () => { cancelAnimationFrame(ecgRaf); drawEcg('flat', 0); bdState.textContent = 'flatline'; sound.flat(true); });
  at(1800, () => {
    bdState.textContent = 'one beat';
    sound.flat(false);
    at(550, () => sound.beep());
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
  sound.flat(false);
  sound.hush(false);
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
  $('#tx').scrollIntoView();
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
  else if (h === 'transmit') $('#tx').scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  else if (tuner.byId.has(h) && h !== tuner.lockedId()) tuner.tuneTo(h);
});


/* ================================================================== *
 * Real recordings, when there are any. data/manifest.json says which
 * exist, so nothing is fetched (or faked) when they don't.
 * ================================================================== */
(async () => {
  let m;
  try { m = await (await fetch('data/manifest.json')).json(); } catch { return; }
  if (m.static) {
    try {
      const d = await (await fetch(`data/${m.static}`)).json();
      const rows = d.rows.map((r) => Uint8Array.from(atob(r), (c) => c.charCodeAt(0)));
      if (rows.length && d.width > 0) wire.useStatic({ width: d.width, rows });
    } catch { /* keep the synthetic static */ }
  }
  if (m.harmonium) {
    try {
      const d = await (await fetch(`data/${m.harmonium}`)).json();
      const n = d.level.length;
      const pts = d.level.map((v, i) => `${((i * 240) / (n - 1)).toFixed(1)},${(54 - v * 44).toFixed(1)}`).join(' ');
      document.querySelector('.sig-carrier .noise')?.setAttribute('points', pts);
      const prov = document.querySelector('.sig-carrier .prov');
      if (prov) prov.textContent = d.note || `Recorded, ${d.seconds} s.`;
    } catch { /* keep the illustration */ }
  }
  if (m.harmonium_audio?.wire && m.harmonium_audio?.voice) {
    try {
      const raw = await Promise.all([m.harmonium_audio.wire, m.harmonium_audio.voice].map(async (f) => (await fetch(`data/${f}`)).arrayBuffer()));
      sound.loadHarmonium(raw);
    } catch { /* keep the synthetic carrier */ }
  }
})();


/* ================================================================== *
 * v4 additions (phase 1–2 + selected lab items)
 * ================================================================== */
const forget = (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } };
const TZ = 'Asia/Jerusalem';
const hhmm = (d, tz) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...(tz ? { timeZone: tz } : {}) }).format(d);

/* ---- lgm-1: a chart recorder, one pulse per 1.3373 s ---- */
(() => {
  const P = 1337.3;
  const dot = $('#pulsar-dot');
  const cv = $('#pulsar-trace');
  if (!cv) return;
  const g = cv.getContext('2d');
  const t0 = performance.now();
  let raf = 0;
  function draw(now) {
    raf = requestAnimationFrame(draw);
    if (tuner.lockedId() !== 'lgm1' || state !== 'listening') return;
    const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(2, devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#58a89f'; g.lineWidth = 1; g.beginPath();
    const speed = 0.06; // px per ms, like paper moving under the pen
    const tNow = reduceMotion.matches ? t0 : now;
    for (let x = 0; x <= w; x++) {
      const t = tNow - (w - x) / speed;
      const ph = (((t - t0) % P) + P) % P;
      const pulse = Math.exp(-((ph - 40) ** 2) / 300);
      const n = Math.sin(t * 0.37) * 0.6 + Math.sin(t * 0.113) * 0.8;
      const y = h - 6 - n - pulse * (h - 16);
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    const ph = (((now - t0) % P) + P) % P;
    dot.classList.toggle('on', ph < 140);
  }
  raf = requestAnimationFrame(draw);
})();

/* ---- voyager 1: one light-day, crossed 18 Nov 2026 10:16:07 UTC ---- */
(() => {
  const CROSS = Date.UTC(2026, 10, 18, 10, 16, 7);
  const ago = $('#vgr-ago'), at2 = $('#vgr-at');
  function tick() {
    const now = Date.now();
    const d = now - CROSS;
    if (d > 0) {
      const h = Math.floor(d / 3.6e6), m = Math.floor((d % 3.6e6) / 6e4);
      ago.textContent = `That was ${h > 47 ? `${Math.floor(h / 24)} days` : h >= 1 ? `${h} hours` : `${m} minutes`} ago.`;
    }
    // it recedes about 17 km/s, roughly 4.9 light-seconds a day
    const lt = 86400 + 4.9 * Math.max(0, d / 864e5);
    const arrive = new Date(now + lt * 1000);
    at2.textContent = `around ${hhmm(arrive)} tomorrow, your time`;
  }
  tick(); setInterval(tick, 20000);
})();

/* ---- last beat (v4 1.4) ---- */
function renderLastBeat2() {
  const el = $('#last-beat');
  const t = Number(store.get('lk.lastBeat'));
  if (!t) { el.textContent = 'not yet'; return; }
  const s = (Date.now() - t) / 1000;
  el.textContent = s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}
renderLastBeat2(); setInterval(renderLastBeat2, 15000);

/* ---- what this page remembers ---- */
const memory = (() => {
  const list = $('#mem-list');
  function render() {
    let found = [];
    try { found = JSON.parse(store.get('lk.found') || '[]'); } catch { /* none */ }
    const names = found.map((id) => tuner.byId.get(id)?.name).filter(Boolean);
    const lb = Number(store.get('lk.lastBeat'));
    const rows = [
      ['stations found', names.length ? names.join(', ') : 'none yet'],
      ['last beat', lb ? new Date(lb).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'never'],
      ['stored where', 'this browser only, in two localStorage keys. nothing leaves.'],
      ['requests', 'google fonts for the type. cloudflare-dns.com, only when you press resolve on the dns station. nothing else.'],
      ['cookies', 'none'],
    ];
    list.replaceChildren(...rows.map(([k, v]) => { const li = document.createElement('li'); const b = document.createElement('b'); b.textContent = k; li.append(b, v); return li; }));
  }
  $('#memory').addEventListener('toggle', render);
  $('#forget').addEventListener('click', () => {
    forget('lk.found'); forget('lk.lastBeat');
    $$('[data-preset]').forEach((a) => delete a.dataset.found);
    render(); renderLastBeat2();
    $('#forgot').textContent = 'forgotten.';
    setTimeout(() => { $('#forgot').textContent = ''; }, 2400);
  });
  return { render };
})();

/* ---- four-minute heart (lab): four minutes of company fills the reserve ---- */
const presence = (() => {
  let ms = 0, last = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (!document.hidden && !dialog.open && state === 'listening') ms += now - last;
    last = now;
    if (ms >= 240000 && !charged && !dialog.open) { ms = 0; feed(100); }
  }, 1000);
  return { skip() { ms = 239000; } };
})();

/* ---- green horizon (lab L2): sunset in tel aviv, NOAA-style, -0.833° ---- */
const horizon = (() => {
  const LAT = 32.08, LON = 34.78, R = Math.PI / 180;
  function sunsetOn(day) { // day: Date at local noon-ish; returns Date of sunset
    const J = day.getTime() / 864e5 + 2440587.5;
    const n = Math.ceil(J - 2451545.0 + 0.0008 - 0.5);
    const Js = n - LON / 360;
    const M = (357.5291 + 0.98560028 * Js) % 360;
    const C = 1.9148 * Math.sin(M * R) + 0.02 * Math.sin(2 * M * R) + 0.0003 * Math.sin(3 * M * R);
    const L = (M + C + 180 + 102.9372) % 360;
    const Jt = 2451545.0 + Js + 0.0053 * Math.sin(M * R) - 0.0069 * Math.sin(2 * L * R);
    const sd = Math.sin(L * R) * Math.sin(23.4397 * R);
    const cd = Math.cos(Math.asin(sd));
    const w0 = Math.acos((Math.sin(-0.833 * R) - Math.sin(LAT * R) * sd) / (Math.cos(LAT * R) * cd)) / R;
    return new Date((Jt + w0 / 360 - 2440587.5) * 864e5);
  }
  function next(now = new Date()) {
    let s = sunsetOn(now);
    if (s < now) s = sunsetOn(new Date(now.getTime() + 864e5));
    return s;
  }
  const line = $('#horizon-line');
  const label = $('#sunset-at');
  function flash() { line.classList.remove('on'); void line.offsetWidth; line.classList.add('on'); }
  let target = next();
  function tick() {
    const now = new Date();
    if (now >= target) { if (now - target < 120000 && !document.hidden) flash(); target = next(new Date(now.getTime() + 60000)); }
    label.textContent = `${hhmm(target, TZ)}, israel time`;
  }
  tick(); setInterval(tick, 5000);
  return { flash, next, sunsetOn };
})();

/* ---- cpr restart (lab O3): in dormant, rhythm restarts the heart ---- */
const cpr = (() => {
  const out = $('#cpr-count');
  let taps = [], wakeT = 0, lastRate = 0;
  function reset() { taps = []; out.textContent = ''; }
  function tap() {
    const t = performance.now();
    clearTimeout(wakeT);
    const prev = taps[taps.length - 1];
    if (prev && (t - prev < 380 || t - prev > 900)) taps = [];
    taps.push(t);
    if (taps.length >= 3) {
      const k = Math.min(10, taps.length);
      const span = (taps[taps.length - 1] - taps[taps.length - k]) / (k - 1);
      lastRate = Math.round(60000 / span);
      out.textContent = `${taps.length} compressions, ${lastRate} a minute${lastRate < 100 ? ', faster' : lastRate > 120 ? ', slower' : ''}`;
      if (taps.length >= 10 && lastRate >= 100 && lastRate <= 120) {
        reset();
        sound.thump(); wire.beat(); jolt();
        setTimeout(() => { setState('listening'); $('#cpr-rate').textContent = String(lastRate); $('#cpr-card').hidden = false; }, 400);
        return;
      }
    }
    // a single tap still just wakes it, after a breath
    wakeT = setTimeout(() => { if (state === 'dormant' && !dialog.open) { setState('listening'); reset(); } }, 950);
  }
  let restarted = 0;
  return { tap, reset, takeRestart() { const r = restarted; restarted = 0; return r; } };
})();
$('#cpr-ok').addEventListener('click', () => { $('#cpr-card').hidden = true; });

/* ---- the ending (v4 2.1–2.3 + lab L1): everything falls for 1.5 s, the line rises, then dormant ---- */
const ending = (() => {
  const last = story.querySelector('p.last');
  const fly = story.querySelector('.fly');
  let armed = false, ended = false, io = null, holdT = 0, cutT = [];
  function arm() {
    if (armed) return; armed = true;
    io = new IntersectionObserver(([e]) => {
      clearTimeout(holdT);
      if (e.intersectionRatio >= 0.99 && !ended) holdT = setTimeout(go, 2200);
    }, { root: story, threshold: [0, 0.99] });
    io.observe(fly);
  }
  function fallKeys(dist, rot) {
    const k = [];
    for (let i = 0; i <= 15; i++) { const u = i / 15; k.push({ transform: `translateY(${(dist * u * u).toFixed(1)}px) rotate(${(rot * u * u).toFixed(2)}deg)`, opacity: u > 0.85 ? (1 - u) / 0.15 : 1 }); }
    return k;
  }
  function go() {
    if (ended || !dialog.open) return;
    ended = true; io?.disconnect();
    dialog.classList.add('s-fall');
    const H = innerHeight;
    const others = [...story.children].filter((el) => el !== last);
    others.push(last.querySelector('.pre'), $('#bd-state').parentElement);
    const pre = last.querySelector('.pre');
    const rm = reduceMotion.matches;
    for (const el of others) {
      if (rm) { el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' }); continue; }
      if (el === pre) { el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, easing: 'ease-in', fill: 'forwards' }); continue; }
      const r = el.getBoundingClientRect();
      // off screen already: just gone. on screen: one gravity for everything, so nothing slides through anything else
      if (r.bottom < 0 || r.top > H) { el.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 10, fill: 'forwards' }); continue; }
      el.animate(fallKeys(H + 60, (Math.random() - 0.5) * 3), { duration: 1500, easing: 'linear', fill: 'forwards' });
    }
    if (!rm) fly.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${-Math.round(H * 0.18)}px)` }], { duration: 1500, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
    // a second and a half, then nothing
    cutT.push(setTimeout(() => {
      dialog.classList.add('s-cut');
      $('#bd-state').parentElement.getAnimations().forEach((a) => a.cancel());
      bdState.textContent = '';
      cutT.push(setTimeout(() => { bdState.textContent = 'dormant'; $('#bd-live').textContent = 'It fell. Dormant.'; $('#bd-close').focus({ preventScroll: true }); }, 800));
    }, 1500));
  }
  function reset() {
    clearTimeout(holdT); cutT.forEach(clearTimeout); cutT = [];
    io?.disconnect(); io = null; armed = false;
    story.querySelectorAll('*').forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
    $('#bd-state').parentElement.getAnimations().forEach((a) => a.cancel());
    $('#bd-live').textContent = '';
    const was = ended; ended = false;
    return was;
  }
  new MutationObserver(() => { if (dialog.classList.contains('s-story')) arm(); }).observe(dialog, { attributes: true, attributeFilter: ['class'] });
  return { reset, go, get ended() { return ended; } };
})();

dialog.addEventListener('close', () => {
  const wasEnded = ending.reset();
  renderLastBeat2();
  // it ended by falling: the page goes dormant, as the story did
  if (wasEnded) setTimeout(() => setState('dormant'), 30);

});

/* ================================================================== *
 * VOLUME 3 EXPERIMENTS
 * ================================================================== */
// a beakless bird: body, open wings, a stub of a tail, a round head with nothing on it
const BIRD = 'M150 120 C132 118 110 100 64 58 C96 68 122 86 140 101 C143 95 157 95 160 101 C178 86 204 68 236 58 C190 100 168 118 150 120 Z M145 118 L137 146 L150 136 L163 146 L155 118 Z M142 95 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0 Z';

/* ---- W1: a bird that exists only in coherent motion ---- */
const rdk = (() => {
  const cv = $('#rdk');
  if (!cv) return null;
  const W = 150, H = 100, S = 2; // 2 css px per cell
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const m = document.createElement('canvas'); m.width = W; m.height = H;
  const mg = m.getContext('2d');
  mg.scale(W / 300, H / 200); mg.fill(new Path2D(BIRD));
  const md = mg.getImageData(0, 0, W, H).data;
  const inside = (x, y) => md[(((y | 0) * W + (x | 0)) << 2) + 3] > 127;
  const N = Math.round(W * H * 0.16);
  const dots = Array.from({ length: N }, () => ({ x: Math.random() * W, y: Math.random() * H, life: (Math.random() * 12) | 0 }));
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  let last = 0;
  function still() {
    g.fillStyle = '#070b0f'; g.fillRect(0, 0, W, H);
    g.save(); g.scale(W / 300, H / 200); g.strokeStyle = 'rgba(88,168,159,.45)'; g.lineWidth = 2; g.stroke(new Path2D(BIRD)); g.restore();
  }
  function frame(t) {
    requestAnimationFrame(frame);
    if (tuner.lockedId() !== 'motion' || state !== 'listening') return;
    if (reduceMotion.matches) { if (!cv.dataset.still) { cv.dataset.still = '1'; still(); } return; }
    delete cv.dataset.still;
    if (t - last < 33) return; // ~30 fps: each dot steps once per frame, no flashing area
    last = t;
    g.fillStyle = '#070b0f'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#3f6f69';
    for (const d of dots) {
      if (--d.life < 0) { d.x = Math.random() * W; d.y = Math.random() * H; d.life = 6 + ((Math.random() * 10) | 0); }
      else if (inside(d.x, d.y)) { d.x += 1; }                       // the bird drifts right, together
      else { const [dx, dy] = DIRS[(Math.random() * 8) | 0]; d.x = (d.x + dx + W) % W; d.y = (d.y + dy + H) % H; } // everything else wanders
      g.fillRect(d.x | 0, d.y | 0, 1, 1);
    }
  }
  requestAnimationFrame(frame);
  return { inside, W, H };
})();
document.documentElement.classList.toggle('rm', reduceMotion.matches);

/* ---- W2: an afterimage, the only copy is in your eye ---- */
(() => {
  const bird = $('#ai-bird');
  if (!bird) return;
  bird.setAttribute('d', BIRD);
  const go = $('#ai-go'), bar = $('#ai-bar'), msg = $('#ai-msg');
  let t0 = 0, iv = 0;
  function reset() { clearInterval(iv); bird.style.opacity = '1'; bar.style.width = '0'; }
  go.addEventListener('click', () => {
    reset(); t0 = Date.now(); msg.textContent = 'look at the dot.'; go.textContent = 'again';
    iv = setInterval(() => {
      const s = (Date.now() - t0) / 1000;
      bar.style.width = `${Math.min(100, s * 5)}%`;
      if (s >= 20) {
        clearInterval(iv); bird.style.opacity = '0'; msg.textContent = 'keep looking at the paper.';
        setTimeout(() => { if (bird.style.opacity === '0') msg.textContent = 'that was the only copy.'; }, 7000);
      }
    }, 250);
  });
})();

/* ---- Y2: the anniversary of the chart (28 November, Israel time) ---- */
const anniversary = (() => {
  const el = $('#lgm-anniv');
  function check(force) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    const on = force || (p.month === '11' && p.day === '28');
    if (!el) return;
    el.hidden = !on;
    el.textContent = on ? `${Number(p.year) - 1967} years ago today.` : '';
    document.body.classList.toggle('anniv-on', on);
  }
  check(); setInterval(check, 60000);
  return { force: () => check(true) };
})();

/* ---- Z2: one unannounced dormant day a year ---- */
const dormantDay = (() => {
  function dayFor(year) { let h = 2166136261; for (const c of `beakless-${year}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 365) + 1; }
  function today() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    const doy = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day) - Date.UTC(+p.year, 0, 0)) / 864e5);
    return { year: +p.year, doy };
  }
  const span = document.querySelector('.dormant-msg > span');
  const wake = span?.textContent;
  function enter() { deepDormant = true; document.body.classList.add('deep'); setState('dormant'); if (span) span.textContent = 'not today.'; announce.textContent = 'Dormant for today. The contact details are still in the footer.'; }
  function leave() { deepDormant = false; document.body.classList.remove('deep'); if (span) span.textContent = wake; setState('listening'); }
  const { year, doy } = today();
  if (doy === dayFor(year)) enter();
  return { enter, leave, dayFor };
})();

/* ---- X1: what this radio can't receive ---- */
(() => {
  const el = $('#reach');
  if (!el) return;
  const n = unreachable.length;
  el.textContent = n ? `${n} station${n > 1 ? 's aren’t' : ' isn’t'} reachable on this radio. other radios can.` : 'this radio can reach every station.';
})();
