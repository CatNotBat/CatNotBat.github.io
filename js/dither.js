// Ordered-dither renderer. Paint intensity with ordinary 2D strokes into an
// offscreen buffer (red channel = trace, green channel = soul), then quantise
// to three levels through a 4x4 Bayer matrix. Cheap, crisp, no WebGL.

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const FAINT = [0x2c, 0x40, 0x44];
const TRACE = [0x58, 0xa8, 0x9f];
const SOUL = [0xe5, 0x32, 0x2d];

export class Dither {
  constructor(canvas, cell = 3) {
    this.canvas = canvas;
    this.cell = cell;
    this.ctx = canvas.getContext('2d');
    this.off = document.createElement('canvas');
    this.octx = this.off.getContext('2d', { willReadFrequently: true });
    this.w = 0;
    this.h = 0;
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width / this.cell));
    const h = Math.max(1, Math.round(r.height / this.cell));
    if (w === this.w && h === this.h) return false;
    this.w = this.canvas.width = this.off.width = w;
    this.h = this.canvas.height = this.off.height = h;
    this.out = this.ctx.createImageData(w, h);
    return true;
  }

  render(paint) {
    const { w, h, octx: o } = this;
    o.globalCompositeOperation = 'source-over';
    o.shadowBlur = 0;
    o.fillStyle = '#000';
    o.fillRect(0, 0, w, h);
    o.globalCompositeOperation = 'lighter';
    paint(o, w, h);
    const src = o.getImageData(0, 0, w, h).data;
    const dst = this.out.data;
    for (let y = 0; y < h; y++) {
      const row = (y & 3) << 2;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) << 2;
        const t = BAYER[row + (x & 3)];
        const soul = src[i + 1] / 255;
        let c = null;
        if (soul > t) c = SOUL;
        else {
          const v = (src[i] / 255) * 2;
          const base = v | 0;
          const level = Math.min(2, base + (v - base > t ? 1 : 0));
          if (level === 1) c = FAINT;
          else if (level === 2) c = TRACE;
        }
        if (c) {
          dst[i] = c[0]; dst[i + 1] = c[1]; dst[i + 2] = c[2]; dst[i + 3] = 255;
        } else {
          dst[i + 3] = 0;
        }
      }
    }
    this.ctx.putImageData(this.out, 0, 0);
  }
}

// Quadratic bezier helper in normalised space.
export function quad(p0, p1, p2, u) {
  const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
  return [a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]];
}
