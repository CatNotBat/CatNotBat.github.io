// A DNS resolver for the browser, in the spirit of the C one: build the query
// byte by byte, parse the answer by hand (RFC 1035, name compression and all).
// Browsers can't send raw UDP, so the same bytes ride over HTTPS (RFC 8484).

export const TYPES = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28 };
const TNAME = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));
export const RCODE = ['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED'];
const LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/i;

export function encodeName(name) {
  const clean = name.trim().replace(/\.$/, '').toLowerCase();
  if (!clean || clean.length > 253) throw new Error('that is not a domain');
  const out = [];
  for (const label of clean.split('.')) {
    if (!LABEL.test(label)) throw new Error(`"${label}" is not a valid label`);
    out.push(label.length, ...[...label].map((c) => c.charCodeAt(0)));
  }
  out.push(0);
  return { bytes: out, name: clean };
}

export function buildQuery(name, type) {
  const q = encodeName(name);
  const id = (Math.random() * 0x10000) | 0;
  const bytes = [id >> 8, id & 255, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, ...q.bytes, 0, TYPES[type], 0, 1];
  return { bytes: Uint8Array.from(bytes), qnameEnd: 12 + q.bytes.length, name: q.name };
}

function readName(buf, start) {
  const labels = [];
  let pos = start, next = null, hops = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('name runs off the end');
    const len = buf[pos];
    if (len === 0) { pos++; break; }
    if ((len & 0xc0) === 0xc0) {
      if (++hops > 32) throw new Error('compression loop');
      if (next === null) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    labels.push(String.fromCharCode(...buf.subarray(pos + 1, pos + 1 + len)));
    pos += 1 + len;
  }
  return { name: labels.length ? `${labels.join('.')}.` : '.', next: next ?? pos };
}

function rdata(buf, type, off, len) {
  const b = buf.subarray(off, off + len);
  switch (type) {
    case 1: return [...b].join('.');
    case 28: {
      const g = [];
      for (let i = 0; i < 16; i += 2) g.push(((b[i] << 8) | b[i + 1]).toString(16));
      return g.join(':').replace(/(^|:)0(:0)+(:|$)/, '::').replace(/:{3,}/, '::');
    }
    case 2: case 5: case 12: return readName(buf, off).name;
    case 15: return `${(b[0] << 8) | b[1]} ${readName(buf, off + 2).name}`;
    case 16: {
      const parts = [];
      for (let i = 0; i < b.length;) { const l = b[i]; parts.push(`"${String.fromCharCode(...b.subarray(i + 1, i + 1 + l))}"`); i += 1 + l; }
      return parts.join(' ');
    }
    case 6: {
      const m = readName(buf, off);
      const r = readName(buf, m.next);
      const serial = new DataView(buf.buffer, buf.byteOffset + r.next, 4).getUint32(0);
      return `${m.name} ${r.name} ${serial}`;
    }
    default: return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
}

export function parse(buf) {
  if (buf.length < 12) throw new Error('answer is shorter than a header');
  const u16 = (o) => (buf[o] << 8) | buf[o + 1];
  const flags = u16(2);
  const counts = [u16(4), u16(6), u16(8), u16(10)];
  let off = 12;
  for (let i = 0; i < counts[0]; i++) off = readName(buf, off).next + 4;
  const sections = [[], [], []];
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < counts[s + 1]; i++) {
      const n = readName(buf, off);
      off = n.next;
      const type = u16(off), ttl = new DataView(buf.buffer, buf.byteOffset + off + 4, 4).getUint32(0), len = u16(off + 8);
      off += 10;
      if (off + len > buf.length) throw new Error('record runs off the end');
      sections[s].push({ name: n.name, type: TNAME[type] ?? `TYPE${type}`, ttl, data: rdata(buf, type, off, len) });
      off += len;
    }
  }
  return { rcode: flags & 15, flags, answers: sections[0], authority: sections[1] };
}

export async function resolve(name, type) {
  const q = buildQuery(name, type);
  const b64 = btoa(String.fromCharCode(...q.bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const t0 = performance.now();
  const res = await fetch(`https://cloudflare-dns.com/dns-query?dns=${b64}`, { headers: { accept: 'application/dns-message' }, cache: 'no-store', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const answer = new Uint8Array(await res.arrayBuffer());
  return { query: q, answer, ms: Math.round(performance.now() - t0), parsed: parse(answer) };
}
