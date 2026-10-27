// Horizontal, virtualized row. Focus is anchored at the left edge: the track
// slides under a stationary focus ring, so every move is one compositor-only
// transform and the ring never repaints.
import { h, setText, setTransform, toggleClass } from '../util/dom.js';
import { createTile, fillTile, KINDS } from './tile.js';

const GAP = 28;
const LEFT = 96;
const BEHIND = 2;   // tiles kept to the left of focus (one is peeking on screen)

export class Row {
  constructor({ title, kind = 'poster', items = [], caption = false, onFocus, onSelect }) {
    this.kind = kind;
    this.size = KINDS[kind];
    this.step = this.size.w + GAP;
    this.items = items;
    this.index = 0;
    this.active = false;
    this.onFocus = onFocus;
    this.onSelect = onSelect;

    this.el = h('section', 'row row-' + kind);
    this.titleEl = h('h2', 'row-title', this.el);
    setText(this.titleEl, title || '');
    const clip = h('div', 'row-clip', this.el);
    this.track = h('div', 'row-track', clip);
    this.track.style.left = LEFT + 'px';
    this.ring = h('div', 'ring', clip);
    this.ring.style.left = (LEFT - 8) + 'px';
    this.ring.style.width = (this.size.w + 16) + 'px';
    this.ring.style.height = (this.size.h + 16) + 'px';

    this.captionH = caption ? 70 : 0;
    clip.style.height = (this.size.h + this.captionH + 24) + 'px';
    this.height = (title ? 64 : 0) + this.size.h + this.captionH + 24;

    const visible = Math.ceil((1920 - LEFT) / this.step);
    this.poolSize = visible + BEHIND + 2;
    this.pool = [];
    for (let i = 0; i < this.poolSize; i++) {
      const tile = createTile(kind, { caption });
      tile.index = -1;
      this.track.appendChild(tile.el);
      this.pool.push(tile);
    }
    this.render();
  }

  setItems(items, keepKey) {
    this.items = items;
    if (keepKey) {
      const i = items.findIndex(it => it.ratingKey === keepKey);
      this.index = i >= 0 ? i : Math.min(this.index, items.length - 1);
    } else {
      this.index = Math.min(this.index, Math.max(0, items.length - 1));
    }
    for (const t of this.pool) { t.index = -1; t.item = undefined; }
    this.render();
  }

  setTitle(title) {
    setText(this.titleEl, title);
  }

  current() {
    return this.items[this.index];
  }

  setActive(on) {
    this.active = on;
    toggleClass(this.el, 'active', on);
  }

  focusIndex(i) {
    if (!this.items.length) return;
    this.index = Math.max(0, Math.min(this.items.length - 1, i));
    this.render();
    if (this.onFocus) this.onFocus(this.current(), this);
  }

  // Returns false at the edges so the parent can decide what to do.
  move(dx) {
    const next = this.index + dx;
    if (next < 0 || next >= this.items.length) return false;
    this.index = next;
    this.render();
    if (this.onFocus) this.onFocus(this.current(), this);
    return true;
  }

  select() {
    if (this.onSelect && this.current()) this.onSelect(this.current(), this);
  }

  render() {
    const first = Math.max(0, this.index - BEHIND);
    const last = Math.min(this.items.length, first + this.poolSize);
    for (let i = first; i < last; i++) {
      const tile = this.pool[i % this.poolSize];
      if (tile.index !== i) {
        tile.index = i;
        setTransform(tile.el, 'translateX(' + i * this.step + 'px)');
        tile.el.style.visibility = '';
      }
      fillTile(tile, this.items[i]);
    }
    // Slots not covering any item this frame.
    for (const tile of this.pool) {
      if (tile.index < first || tile.index >= last) {
        tile.index = -1;
        tile.el.style.visibility = 'hidden';
      }
    }
    setTransform(this.track, 'translateX(' + (-this.index * this.step) + 'px)');
  }
}
