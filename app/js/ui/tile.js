// Poster / landscape tiles. A tile node is created once and re-filled as it is
// recycled; fill() only touches the DOM for fields that changed.
import { h, setText, show, setTransform, toggleClass } from '../util/dom.js';
import { load } from './images.js';
import { session } from '../session.js';
import { progress, episodeLabel } from '../util/format.js';

export const KINDS = {
  poster: { w: 220, h: 330 },
  wide: { w: 400, h: 225 },
  grid: { w: 216, h: 324 },
  episode: { w: 384, h: 216 },
  person: { w: 180, h: 180 },
};

export function createTile(kind, { caption = false } = {}) {
  const size = KINDS[kind];
  const el = h('div', 'tile tile-' + kind);
  const frame = h('div', 'tile-frame', el);
  frame.style.width = size.w + 'px';
  frame.style.height = size.h + 'px';
  const img = h('img', 'tile-img', frame);
  const ph = h('div', 'tile-ph', frame);
  img.alt = '';
  const badge = h('div', 'tile-badge', frame);
  const bar = h('div', 'tile-bar', frame);
  const fill = h('i', '', bar);
  let cap = null;
  let sub = null;
  if (caption) {
    cap = h('div', 'tile-cap', el);
    cap.style.width = size.w + 'px';
    sub = h('div', 'tile-sub', el);
    sub.style.width = size.w + 'px';
  }
  return { el, img, ph, badge, bar, fill, cap, sub, kind, size, item: null };
}

function artFor(item, kind) {
  if (kind === 'wide' || kind === 'episode') {
    if (item.type === 'episode') return item.thumb || item.art;
    return item.art || item.thumb;
  }
  if (item.type === 'episode') return item.grandparentThumb || item.parentThumb || item.thumb;
  if (item.type === 'season') return item.thumb || item.parentThumb;
  return item.thumb;
}

function titleFor(item, kind) {
  if (item.type === 'episode' && kind !== 'episode') return item.grandparentTitle || item.title;
  return item.title;
}

function subFor(item, kind) {
  if (item.sub != null) return item.sub; // e.g. a person's role, a credit's "role · year"
  if (item.type === 'episode') {
    return kind === 'episode' ? episodeLabel(item).replace(' · ', '') + '  ' + item.title
      : episodeLabel(item) + '  ' + item.title;
  }
  if (item.type === 'season') return item.leafCount ? item.leafCount + ' episodes' : '';
  return item.year || '';
}

export function fillTile(tile, item) {
  if (tile.item === item) return;
  tile.item = item;
  if (!item) {
    load(tile.img, '');
    setText(tile.ph, '');
    show(tile.bar, false);
    show(tile.badge, false);
    if (tile.cap) { setText(tile.cap, ''); setText(tile.sub, ''); }
    return;
  }
  const kind = tile.kind;
  const server = session.server;
  const path = artFor(item, kind);
  // The web layer is 1920x1080, so tile size is exactly the pixels we need.
  load(tile.img, server ? server.image(path, tile.size.w, tile.size.h) : '');
  setText(tile.ph, titleFor(item, kind));

  const p = progress(item);
  show(tile.bar, p > 0.01);
  if (p > 0.01) setTransform(tile.fill, 'scaleX(' + p.toFixed(3) + ')');

  // Unwatched episode count on shows/seasons, check on watched items.
  let badge = '';
  if ((item.type === 'show' || item.type === 'season') && item.leafCount) {
    const left = item.leafCount - (item.viewedLeafCount || 0);
    badge = left > 0 ? String(left) : '✓';
  } else if (item.viewCount && !item.viewOffset && item.type !== 'show') {
    badge = '✓';
  }
  show(tile.badge, !!badge);
  setText(tile.badge, badge);
  toggleClass(tile.badge, 'done', badge === '✓');

  if (tile.cap) {
    setText(tile.cap, kind === 'episode' ? item.title : titleFor(item, kind));
    setText(tile.sub, kind === 'episode' ? episodeLabel(item) + (item.duration ? '  ·  ' + Math.round(item.duration / 60000) + 'm' : '') : subFor(item, kind));
  }
}
