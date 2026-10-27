// Accent colour (focus ring, progress bars, highlights), chosen in Settings.
import * as store from '../util/store.js';

const ACCENTS = [
  ['Plex orange', '#E5A00D'],
  ['Coral', '#FF4C42'],
  ['Blue', '#3D8BFD'],
  ['Green', '#2FBF71'],
  ['Purple', '#9B6BFF'],
  ['Pink', '#FF5FA2'],
  ['White', '#F2F2F2'],
];

function current() {
  const i = store.get('accent', 0);
  return ACCENTS[i] ? i : 0;
}

export function applyAccent() {
  const hex = ACCENTS[current()][1];
  const n = parseInt(hex.slice(1), 16);
  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  root.setProperty('--accent-glow', 'rgba(' + (n >> 16) + ', ' + (n >> 8 & 255) + ', ' + (n & 255) + ', 0.45)');
}

export function accentName() {
  return ACCENTS[current()][0];
}

export function nextAccent() {
  setAccent(current() + 1);
}

// For the swatches in Settings: [{ name, hex, on }].
export function accents() {
  const cur = current();
  return ACCENTS.map(([name, hex], i) => ({ name, hex, on: i === cur }));
}

export function setAccent(i) {
  store.set('accent', (i + ACCENTS.length) % ACCENTS.length);
  applyAccent();
}

export function accentIndex() {
  return current();
}
