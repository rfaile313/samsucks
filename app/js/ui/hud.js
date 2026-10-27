// Perf overlay: fps, worst frame and key-to-frame latency. On in dev builds
// (and reported to the devserver), toggleable from Settings in release builds.
import { DEV } from '../config.js';
import { h, setText } from '../util/dom.js';
import { stats } from '../input.js';
import { perf } from '../util/log.js';
import * as store from '../util/store.js';

let el = null;
let running = false;
let frames = 0;
let worst = 0;
let last = 0;
let windowStart = 0;
let maxLatency = 0;
let longFrames = 0;
let screenName = () => '';

function tick(now) {
  if (!running) return;
  const dt = now - last;
  last = now;
  frames++;
  if (dt > worst) worst = dt;
  if (dt > 50) longFrames++;
  if (stats.keyAt) {
    stats.latency = now - stats.keyAt;
    if (stats.latency > maxLatency) maxLatency = stats.latency;
    stats.keyAt = 0;
  }
  if (now - windowStart >= 1000) {
    const fps = Math.round(frames * 1000 / (now - windowStart));
    setText(el, fps + ' fps · worst ' + worst.toFixed(0) + 'ms · key ' + stats.latency.toFixed(0) + 'ms');
    // Only report windows where something happened, so idle doesn't drown the log.
    if (maxLatency || fps < 55) {
      perf('screen=' + screenName() + ' fps=' + fps + ' worst=' + worst.toFixed(0) + ' long=' + longFrames + ' keyMax=' + maxLatency.toFixed(0));
    }
    frames = 0; worst = 0; longFrames = 0; maxLatency = 0; windowStart = now;
  }
  requestAnimationFrame(tick);
}

// Only an explicit choice in Settings is remembered; dev builds default to on.
export function setHud(on, remember = true) {
  if (remember) store.set('hud', on);
  if (on === running) return;
  running = on;
  if (!el) el = h('div', 'hud', document.body);
  el.style.display = on ? '' : 'none';
  if (on) {
    last = windowStart = performance.now();
    requestAnimationFrame(tick);
  }
}

export function hudEnabled() {
  return running;
}

export function initHud(getScreenName) {
  screenName = getScreenName;
  // Release builds have no toggle for it, so never show it there.
  setHud(DEV && store.get('hud', true), false);
}
