// A small RV32IM assembler and CPU, written for one station on this page.
// No library. Enough of the ISA to run real firmware, not enough to be clever.

const ABI = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
  'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];
const REG = new Map(ABI.map((n, i) => [n, i]));
for (let i = 0; i < 32; i++) REG.set(`x${i}`, i);
REG.set('fp', 8);
export { ABI };

export const MMIO = 0x60000000;

const OPR = { add: [0, 0], sub: [0x20, 0], sll: [0, 1], slt: [0, 2], sltu: [0, 3], xor: [0, 4], srl: [0, 5], sra: [0x20, 5],
  or: [0, 6], and: [0, 7], mul: [1, 0], div: [1, 4], divu: [1, 5], rem: [1, 6], remu: [1, 7] };
const OPI = { addi: 0, slti: 2, sltiu: 3, xori: 4, ori: 6, andi: 7 };
const SHI = { slli: [0, 1], srli: [0, 5], srai: [0x20, 5] };
const LD = { lb: 0, lh: 1, lw: 2, lbu: 4, lhu: 5 };
const ST = { sb: 0, sh: 1, sw: 2 };
const BR = { beq: 0, bne: 1, blt: 4, bge: 5, bltu: 6, bgeu: 7 };

const encR = (f7, rs2, rs1, f3, rd, op) => ((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op) >>> 0;
const encI = (im, rs1, f3, rd, op) => (((im & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op) >>> 0;
const encS = (im, rs2, rs1, f3) => ((((im >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((im & 0x1f) << 7) | 0x23) >>> 0;
const encB = (im, rs2, rs1, f3) => ((((im >> 12) & 1) << 31) | (((im >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12)
  | (((im >> 1) & 0xf) << 8) | (((im >> 11) & 1) << 7) | 0x63) >>> 0;
const encU = (im, rd, op) => ((im & 0xfffff000) | (rd << 7) | op) >>> 0;
const encJ = (im, rd) => ((((im >> 20) & 1) << 31) | (((im >> 1) & 0x3ff) << 21) | (((im >> 11) & 1) << 20) | (((im >> 12) & 0xff) << 12)
  | (rd << 7) | 0x6f) >>> 0;

class AsmError extends Error {}
const fail = (m) => { throw new AsmError(m); };

function num(t) {
  const m = /^(-?)(0x[0-9a-f]+|0b[01]+|\d+)$/i.exec(t);
  if (!m) return null;
  const v = Number(m[2]);
  return (m[1] ? -v : v) | 0;
}
function reg(t) {
  const r = REG.get(t);
  if (r === undefined) fail(`"${t}" is not a register`);
  return r;
}
function stripComment(line) {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"' && line[i - 1] !== '\\') q = !q;
    if (!q && line[i] === '#') return line.slice(0, i);
  }
  return line;
}
function str(t) {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(t);
  if (!m) fail('expected a "string"');
  const out = [];
  for (let i = 0; i < m[1].length; i++) {
    let c = m[1][i];
    if (c === '\\') { c = m[1][++i]; c = { n: '\n', t: '\t', 0: '\0', '\\': '\\', '"': '"' }[c] ?? c; }
    out.push(c.charCodeAt(0) & 0xff);
  }
  return out;
}

export function assemble(src) {
  const lines = src.split('\n');
  const items = [];
  const labels = new Map();
  let pc = 0;
  // pass 1: sizes and labels
  lines.forEach((raw, ln) => {
    try {
      let line = stripComment(raw).trim();
      for (let m; (m = /^([A-Za-z_.][\w.]*):\s*/.exec(line));) {
        if (labels.has(m[1])) fail(`label "${m[1]}" twice`);
        labels.set(m[1], pc); line = line.slice(m[0].length);
      }
      if (!line) return;
      const sp = line.search(/\s/);
      const op = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
      const rest = sp < 0 ? '' : line.slice(sp).trim();
      if (op === '.asciz' || op === '.string') { const b = [...str(rest), 0]; items.push({ ln, pc, data: b }); pc += b.length; return; }
      if (op === '.byte') { const b = rest.split(',').map((t) => (num(t.trim()) ?? fail('bad byte')) & 0xff); items.push({ ln, pc, data: b }); pc += b.length; return; }
      if (op === '.word') {
        pc = (pc + 3) & ~3;
        const ws = rest.split(',').map((t) => t.trim());
        items.push({ ln, pc, words: ws }); pc += 4 * ws.length; return;
      }
      if (op.startsWith('.')) fail(`unknown directive ${op}`);
      pc = (pc + 3) & ~3;
      const args = rest ? rest.split(',').map((t) => t.trim()) : [];
      let size = 4;
      if (op === 'la') size = 8;
      if (op === 'li') { const v = num(args[1] ?? ''); if (v === null) fail('li wants a number'); size = v >= -2048 && v < 2048 ? 4 : 8; }
      items.push({ ln, pc, op, args });
      pc += size;
    } catch (e) {
      if (e instanceof AsmError) throw new AsmError(`line ${ln + 1}: ${e.message}`);
      throw e;
    }
  });
  if (pc > 0x8000) throw new AsmError('program does not fit in 32 KB');

  const image = new Uint8Array(pc + 4);
  const dv = new DataView(image.buffer);
  const lineAt = new Map();
  const target = (t) => (labels.has(t) ? labels.get(t) : num(t) ?? fail(`no label "${t}"`));
  const imm12 = (v) => { if (v < -2048 || v > 2047) fail(`${v} does not fit in 12 bits`); return v; };
  const mem = (t) => { const m = /^(-?\w*)\((\w+)\)$/.exec(t); if (!m) fail(`expected offset(reg), got "${t}"`); return [imm12(m[1] ? target(m[1]) : 0), reg(m[2])]; };

  for (const it of items) {
    try {
      if (it.data) { image.set(it.data, it.pc); continue; }
      if (it.words) { it.words.forEach((w, k) => dv.setUint32(it.pc + 4 * k, target(w) >>> 0, true)); continue; }
      const { op, args: a } = it;
      let p = it.pc;
      const emit = (w) => { dv.setUint32(p, w, true); lineAt.set(p, it.ln); p += 4; };
      const want = (n) => { if (a.length !== n) fail(`${op} takes ${n} operand${n === 1 ? '' : 's'}`); };
      const big = (rd, v) => {
        const hi = (v + 0x800) & 0xfffff000;
        emit(encU(hi, rd, 0x37));
        emit(encI((v - hi) | 0, rd, 0, rd, 0x13));
      };
      const branch = (f3, rs1, rs2, t) => { const off = target(t) - p; if (off < -4096 || off > 4094) fail('branch too far'); emit(encB(off, rs2, rs1, f3)); };
      const jal = (rd, t) => { const off = target(t) - p; if (off < -(1 << 20) || off >= (1 << 20)) fail('jump too far'); emit(encJ(off, rd)); };

      if (op in OPR) { want(3); const [f7, f3] = OPR[op]; emit(encR(f7, reg(a[2]), reg(a[1]), f3, reg(a[0]), 0x33)); }
      else if (op in OPI) { want(3); emit(encI(imm12(target(a[2])), reg(a[1]), OPI[op], reg(a[0]), 0x13)); }
      else if (op in SHI) { want(3); const [f7, f3] = SHI[op]; emit(encI(((f7 << 5) | (target(a[2]) & 31)), reg(a[1]), f3, reg(a[0]), 0x13)); }
      else if (op in LD) { want(2); const [o, r] = mem(a[1]); emit(encI(o, r, LD[op], reg(a[0]), 0x03)); }
      else if (op in ST) { want(2); const [o, r] = mem(a[1]); emit(encS(o, reg(a[0]), r, ST[op])); }
      else if (op in BR) { want(3); branch(BR[op], reg(a[0]), reg(a[1]), a[2]); }
      else if (op === 'beqz' || op === 'bnez') { want(2); branch(op === 'beqz' ? 0 : 1, reg(a[0]), 0, a[1]); }
      else if (op === 'bgt' || op === 'ble') { want(3); branch(op === 'bgt' ? 4 : 5, reg(a[1]), reg(a[0]), a[2]); }
      else if (op === 'lui' || op === 'auipc') { want(2); emit(encU(target(a[1]) << 12, reg(a[0]), op === 'lui' ? 0x37 : 0x17)); }
      else if (op === 'jal') { if (a.length === 1) jal(1, a[0]); else { want(2); jal(reg(a[0]), a[1]); } }
      else if (op === 'jalr') { if (a.length === 1) emit(encI(0, reg(a[0]), 0, 1, 0x67)); else { want(3); emit(encI(imm12(target(a[2])), reg(a[1]), 0, reg(a[0]), 0x67)); } }
      else if (op === 'j') { want(1); jal(0, a[0]); }
      else if (op === 'call') { want(1); jal(1, a[0]); }
      else if (op === 'ret') { want(0); emit(encI(0, 1, 0, 0, 0x67)); }
      else if (op === 'nop') { want(0); emit(encI(0, 0, 0, 0, 0x13)); }
      else if (op === 'mv') { want(2); emit(encI(0, reg(a[1]), 0, reg(a[0]), 0x13)); }
      else if (op === 'not') { want(2); emit(encI(-1, reg(a[1]), 4, reg(a[0]), 0x13)); }
      else if (op === 'neg') { want(2); emit(encR(0x20, reg(a[1]), 0, 0, reg(a[0]), 0x33)); }
      else if (op === 'li') { want(2); const v = num(a[1]); if (v >= -2048 && v < 2048) emit(encI(v, 0, 0, reg(a[0]), 0x13)); else big(reg(a[0]), v); }
      else if (op === 'la') { want(2); big(reg(a[0]), target(a[1])); }
      else if (op === 'ecall') emit(0x00000073);
      else if (op === 'ebreak') emit(0x00100073);
      else fail(`unknown instruction "${op}"`);
    } catch (e) {
      if (e instanceof AsmError) throw new AsmError(`line ${it.ln + 1}: ${e.message}`);
      throw e;
    }
  }
  return { image, lineAt, labels, size: pc };
}

export class CPU {
  constructor(image, io) {
    this.mem = new Uint8Array(0x10000);
    this.mem.set(image);
    this.dv = new DataView(this.mem.buffer);
    this.x = new Int32Array(32);
    this.x[2] = 0x10000 - 16;
    this.pc = 0;
    this.io = io;
    this.halted = null;
    this.cycles = 0;
    this.touched = new Set();
  }

  load(addr, size, signed) {
    addr >>>= 0;
    if (addr >= MMIO) return this.io.read(addr - MMIO) | 0;
    if (addr + size > this.mem.length) throw new Error(`load fault at 0x${addr.toString(16)}`);
    if (size === 4) return this.dv.getInt32(addr, true);
    if (size === 2) return signed ? this.dv.getInt16(addr, true) : this.dv.getUint16(addr, true);
    return signed ? this.dv.getInt8(addr) : this.dv.getUint8(addr);
  }

  store(addr, size, v) {
    addr >>>= 0;
    if (addr >= MMIO) { this.io.write(addr - MMIO, v, size); return; }
    if (addr + size > this.mem.length) throw new Error(`store fault at 0x${addr.toString(16)}`);
    if (size === 4) this.dv.setInt32(addr, v, true);
    else if (size === 2) this.dv.setInt16(addr, v, true);
    else this.dv.setInt8(addr, v);
  }

  set(rd, v) { if (rd) { this.x[rd] = v; this.touched.add(rd); } }

  step() {
    if (this.halted) return false;
    const pc = this.pc;
    try {
      if (pc & 3 || pc + 4 > this.mem.length) throw new Error(`fetch fault at 0x${(pc >>> 0).toString(16)}`);
      const ins = this.dv.getUint32(pc, true);
      const s = ins | 0;
      const op = ins & 0x7f;
      const rd = (ins >>> 7) & 31;
      const f3 = (ins >>> 12) & 7;
      const rs1 = (ins >>> 15) & 31;
      const rs2 = (ins >>> 20) & 31;
      const f7 = ins >>> 25;
      const a = this.x[rs1];
      const b = this.x[rs2];
      const iImm = s >> 20;
      let next = pc + 4;
      switch (op) {
        case 0x37: this.set(rd, s & 0xfffff000); break;
        case 0x17: this.set(rd, (pc + (s & 0xfffff000)) | 0); break;
        case 0x6f: {
          const off = ((s >> 31) << 20) | (((ins >>> 12) & 0xff) << 12) | (((ins >>> 20) & 1) << 11) | (((ins >>> 21) & 0x3ff) << 1);
          this.set(rd, next); next = (pc + off) | 0; break;
        }
        case 0x67: { const t = (a + iImm) & ~1; this.set(rd, next); next = t; break; }
        case 0x63: {
          const off = ((s >> 31) << 12) | (((ins >>> 7) & 1) << 11) | (((ins >>> 25) & 0x3f) << 5) | (((ins >>> 8) & 0xf) << 1);
          const ua = a >>> 0, ub = b >>> 0;
          const take = [a === b, a !== b, null, null, a < b, a >= b, ua < ub, ua >= ub][f3];
          if (take === null) throw new Error('illegal branch');
          if (take) next = (pc + off) | 0;
          break;
        }
        case 0x03: {
          const addr = (a + iImm) | 0;
          const v = { 0: () => this.load(addr, 1, true), 1: () => this.load(addr, 2, true), 2: () => this.load(addr, 4, true),
            4: () => this.load(addr, 1, false), 5: () => this.load(addr, 2, false) }[f3];
          if (!v) throw new Error('illegal load');
          this.set(rd, v()); break;
        }
        case 0x23: {
          const off = ((s >> 25) << 5) | ((ins >>> 7) & 0x1f);
          const size = [1, 2, 4][f3];
          if (!size) throw new Error('illegal store');
          this.store((a + off) | 0, size, b); break;
        }
        case 0x13: {
          const sh = iImm & 31;
          const r = [() => a + iImm, () => a << sh, () => (a < iImm ? 1 : 0), () => ((a >>> 0) < (iImm >>> 0) ? 1 : 0),
            () => a ^ iImm, () => (f7 & 0x20 ? a >> sh : a >>> sh), () => a | iImm, () => a & iImm][f3]();
          this.set(rd, r | 0); break;
        }
        case 0x33: {
          let r;
          if (f7 === 1) {
            const ua = a >>> 0, ub = b >>> 0;
            r = [() => Math.imul(a, b), null, null, null,
              () => (b === 0 ? -1 : a === -0x80000000 && b === -1 ? a : Math.trunc(a / b)),
              () => (ub === 0 ? -1 : Math.trunc(ua / ub)),
              () => (b === 0 ? a : a === -0x80000000 && b === -1 ? 0 : a % b),
              () => (ub === 0 ? a : ua % ub)][f3];
            if (!r) throw new Error('unsupported M instruction');
            r = r();
          } else {
            const sh = b & 31;
            r = [() => (f7 & 0x20 ? a - b : a + b), () => a << sh, () => (a < b ? 1 : 0), () => ((a >>> 0) < (b >>> 0) ? 1 : 0),
              () => a ^ b, () => (f7 & 0x20 ? a >> sh : a >>> sh), () => a | b, () => a & b][f3]();
          }
          this.set(rd, r | 0); break;
        }
        case 0x73: this.halted = ins === 0x00100073 ? 'ebreak' : 'ecall'; this.pc = next; return false;
        default: throw new Error(`illegal instruction 0x${ins.toString(16).padStart(8, '0')}`);
      }
      this.pc = next;
      this.cycles++;
      return true;
    } catch (e) {
      this.halted = e.message;
      return false;
    }
  }
}
