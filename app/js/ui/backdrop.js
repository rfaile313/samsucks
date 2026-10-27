// Full-screen ambience from Plex's UltraBlur corner colors, plus a hero image.
//
// Painting a full-screen CSS gradient takes ~2s on a 2022 TV CPU, and even a
// software canvas stretched to full screen costs ~100ms per change. Instead the
// ambience is a 2x2-pixel WebGL canvas (one pixel per corner color): WebGL
// output always lives on the GPU, so the compositor just stretches a 2x2
// texture over the screen and bilinear filtering produces the smooth blend.
// One shared instance sits behind every screen; two layers cross-fade.
import { h } from '../util/dom.js';

const FALLBACK = { topLeft: '1b1f2b', topRight: '0f1118', bottomLeft: '2a2112', bottomRight: '0b0d12' };
const DIM = 0.78; // keep text readable on bright posters

function rgb(hex) {
  const n = parseInt(hex || '0b0d12', 16);
  return [(n >> 16 & 255) * DIM, (n >> 8 & 255) * DIM, (n & 255) * DIM];
}

function createLayer(parent, className) {
  const canvas = h('canvas', className, parent);
  canvas.width = 2;
  canvas.height = 2;
  const opts = { preserveDrawingBuffer: true, antialias: false, alpha: false, depth: false, stencil: false };
  canvas._gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
  if (!canvas._gl) canvas._ctx = canvas.getContext('2d');
  return canvas;
}

function paint(canvas, colors) {
  const c = colors || FALLBACK;
  const px = [c.topLeft, c.topRight, c.bottomLeft, c.bottomRight].map(rgb);
  const gl = canvas._gl;
  if (gl) {
    gl.enable(gl.SCISSOR_TEST);
    px.forEach(([r, g, b], i) => {
      // GL's origin is bottom-left.
      gl.scissor(i % 2, i < 2 ? 1 : 0, 1, 1);
      gl.clearColor(r / 255, g / 255, b / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    });
    return;
  }
  const img = canvas._ctx.createImageData(2, 2);
  px.forEach(([r, g, b], i) => { img.data.set([r, g, b, 255], i * 4); });
  canvas._ctx.putImageData(img, 0, 0);
}

// The renderer this replaced, kept as a Settings demo for before/after videos:
// four full-screen CSS radial gradients, repainted on every focus change.
let legacy = false;

function legacyGradient(colors) {
  const c = colors || FALLBACK;
  return ['topLeft 0% 0%', 'topRight 100% 0%', 'bottomLeft 0% 100%', 'bottomRight 100% 100%']
    .map(s => { const [k, x, y] = s.split(' '); return 'radial-gradient(ellipse at ' + x + ' ' + y + ', #' + c[k] + ' 0%, transparent 70%)'; })
    .join(',') + ',#0B0D12';
}

class Ambience {
  constructor(parent) {
    this.el = h('div', 'ambience', parent);
    this.layers = [createLayer(this.el, 'amb-layer on'), createLayer(this.el, 'amb-layer')];
    paint(this.layers[0], null);
    this.front = 0;
    this.key = '';
  }

  set(colors) {
    const key = colors ? colors.topLeft + colors.topRight + colors.bottomLeft + colors.bottomRight : '';
    if (key === this.key) return;
    this.key = key;
    this.colors = colors;
    if (legacy) {
      this.el.style.background = legacyGradient(colors);
      return;
    }
    const back = 1 - this.front;
    paint(this.layers[back], colors);
    this.layers[back].classList.add('on');
    this.layers[this.front].classList.remove('on');
    this.front = back;
  }
}

let shared = null;

export function setLegacyGradients(on) {
  legacy = on;
  if (!shared) return;
  shared.el.classList.toggle('legacy', on);
  shared.el.style.background = on ? legacyGradient(shared.colors) : '';
  if (!on) { const c = shared.colors; shared.key = null; shared.set(c); }
}

export function legacyGradients() {
  return legacy;
}

// Per-screen handle on the shared ambience: remembers the screen's colors so
// they can be restored when the screen comes back to the top.
export function useAmbience(initial) {
  if (!shared) shared = new Ambience(document.body.insertBefore(document.createElement('div'), document.body.firstChild));
  let colors = initial || null;
  return {
    set(c) { colors = c || null; shared.set(colors); },
    restore() { shared.set(colors); },
  };
}

export class HeroArt {
  constructor(parent, className) {
    this.el = h('div', className || 'hero-art', parent);
    this.imgs = [h('img', 'hero-img', this.el), h('img', 'hero-img', this.el)];
    this.front = 0;
    this.url = '';
    this.token = 0;
    h('div', 'hero-fade', this.el);
  }

  set(url) {
    if (url === this.url) return;
    this.url = url;
    const token = ++this.token;
    if (!url) {
      this.imgs.forEach(i => i.classList.remove('on'));
      return;
    }
    const back = this.imgs[1 - this.front];
    const loader = new Image();
    loader.src = url;
    const swap = () => {
      if (token !== this.token) return;
      back.src = url;
      back.classList.add('on');
      this.imgs[this.front].classList.remove('on');
      this.front = 1 - this.front;
    };
    if (loader.decode) loader.decode().then(swap, () => {});
    else loader.onload = swap;
  }
}
