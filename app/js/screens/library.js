// A whole library, one collection, or a library's collections as a virtualized
// poster grid, loaded page by page. ▲ from the top row reaches the toolbar
// (shuffle, unwatched filter, sort, collections); yellow cycles the sort;
// CH▲/CH▼ jump by letter (title sort) or by page.
import { h, setText, toggleClass, fitText } from '../util/dom.js';
import { Grid } from '../ui/grid.js';
import { useAmbience } from '../ui/backdrop.js';
import { session } from '../session.js';
import { prefetch } from '../ui/images.js';
import { isFast } from '../input.js';
import * as icons from '../ui/icons.js';
import { openItem, playItem, openCollection, openCollections, shuffle } from '../nav.js';
import { error } from '../util/log.js';
import { metaLine } from '../util/format.js';
import * as store from '../util/store.js';

const PAGE = 140;
const SORTS = [
  { id: 'titleSort', label: 'A–Z' },
  { id: 'addedAt:desc', label: 'Recently added' },
  { id: 'originallyAvailableAt:desc', label: 'Release date' },
  { id: 'audienceRating:desc', label: 'Rating' },
];

export function LibraryScreen(section, { collection = null, collections = false } = {}) {
  const el = h('div', 'screen library');
  const ambience = useAmbience();
  const head = h('header', 'lib-head', el);
  const titleEl = h('h1', 'lib-title', head);
  titleEl.textContent = collection ? collection.title
    : collections ? section.title + ' · Collections' : section.title;
  const count = h('div', 'lib-count', head);
  const toolsEl = h('div', 'lib-tools', head);
  const focusInfo = h('div', 'lib-focus', el);
  const hint = h('div', 'lib-hint', el);

  const whole = !collection && !collections;
  const movies = section.type !== 'show';
  const noun = collections ? 'collections' : movies ? 'movies' : 'shows';
  let sortIndex = 0;
  let unwatched = whole && !!store.get('unwatched:' + section.key, false);
  let pages = new Map();     // page -> 'loading' | true
  let items = [];
  let letters = [];          // [{ title: 'A', start: 0 }]
  let generation = 0;
  let zone = 'grid';
  let tools = [];
  let toolIndex = 0;

  const type = movies ? 1 : 2;

  hint.innerHTML = whole ? '<i class="key-yellow"></i> Sort &nbsp;&nbsp; CH ▲▼ Jump' : 'CH ▲▼ Jump';

  const grid = new Grid({
    top: 200, height: 880, total: 0,
    getItem: i => items[i],
    onFocus: (item, index) => {
      // Warm posters for the row just past the recycled pool.
      if (!isFast()) {
        const start = (Math.floor(index / grid.cols) + grid.poolRows - 1) * grid.cols;
        for (let i = start; i < start + grid.cols; i++) {
          if (items[i]) prefetch(session.server.image(items[i].thumb, 216, 324));
        }
      }
      if (!item) { setText(focusInfo, ''); return; }
      setText(focusInfo, item.title + '   ' + (item.type === 'collection' ? (item.childCount || 0) + ' ' + (item.subtype === 'show' ? 'shows' : 'movies') : metaLine(item)));
      ambience.set(item.UltraBlurColors);
    },
    onSelect: item => (item.type === 'collection' ? openCollection(item, section) : openItem(item)),
    onNeed: (start, end) => {
      for (let p = Math.floor(start / PAGE); p <= Math.floor(end / PAGE); p++) loadPage(p);
    },
  });
  el.appendChild(grid.el);

  function fetchPage(start, size) {
    const server = session.server;
    if (collection) return server.collectionItems(collection.ratingKey, start, size);
    if (collections) return server.collections(section.key, start, size);
    return server.items(section.key, start, size, { sort: SORTS[sortIndex].id, type, unwatched });
  }

  async function loadPage(p) {
    if (pages.has(p)) return;
    if (grid.total && p * PAGE >= grid.total) return;
    pages.set(p, 'loading');
    const gen = generation;
    try {
      const res = await fetchPage(p * PAGE, PAGE);
      if (gen !== generation) return;
      res.items.forEach((it, i) => { items[p * PAGE + i] = it; });
      pages.set(p, true);
      if (grid.total !== res.total) {
        grid.setTotal(res.total);
        setText(count, res.total + ' ' + (unwatched ? 'unwatched ' : '') + noun);
      } else {
        grid.refresh();
      }
      if (p === 0 && res.items[0]) grid.onFocus(grid.current());
      if (p === 0 && !res.total) setText(count, '0 ' + noun);
    } catch (e) {
      pages.delete(p);
      error('library page failed', section.title, p, e);
    }
  }

  async function loadLetters() {
    letters = [];
    if (!whole || SORTS[sortIndex].id !== 'titleSort') return;
    try {
      const mc = await session.server.get('/library/sections/' + section.key + '/firstCharacter', { type, unwatched: unwatched ? 1 : undefined });
      let start = 0;
      letters = (mc.Directory || []).map(d => {
        const l = { title: d.title, start };
        start += d.size;
        return l;
      });
    } catch (e) { /* letter jump just won't work */ }
  }

  function reload() {
    generation++;
    pages = new Map();
    items = [];
    grid.total = 0;
    grid.index = 0;
    grid.refresh();
    renderTools();
    loadPage(0);
    loadLetters();
  }

  // --- Toolbar ------------------------------------------------------------

  function renderTools() {
    toolsEl.innerHTML = '';
    tools = [];
    const add = (icon, label, run) => {
      const b = h('div', 'btn btn-sm', toolsEl);
      b.innerHTML = icon;
      h('span', '', b).textContent = label;
      tools.push({ el: b, run });
    };
    if (movies && !collections) add(icons.shuffle, 'Shuffle', doShuffle);
    if (whole) {
      add(unwatched ? icons.check : icons.uncheck, 'Unwatched', () => {
        unwatched = !unwatched;
        store.set('unwatched:' + section.key, unwatched);
        reload();
      });
      add(icons.sort, SORTS[sortIndex].label, cycleSort);
      add(icons.collection, 'Collections', () => openCollections(section));
    }
    toolIndex = Math.min(toolIndex, tools.length - 1);
    renderZone();
  }

  function renderZone() {
    toggleClass(el, 'in-tools', zone === 'tools');
    tools.forEach((t, i) => toggleClass(t.el, 'focus', zone === 'tools' && i === toolIndex));
  }

  function cycleSort() {
    sortIndex = (sortIndex + 1) % SORTS.length;
    reload();
  }

  function doShuffle() {
    if (collection) shuffle({ collection, total: grid.total });
    else shuffle({ sections: [section], unwatched });
  }

  reload();

  function jump(dir) {
    if (letters.length) {
      const i = grid.index;
      let li = letters.findIndex((l, k) => i >= l.start && (k === letters.length - 1 || i < letters[k + 1].start));
      li = Math.max(0, Math.min(letters.length - 1, li + dir));
      grid.focusIndex(letters[li].start);
      setText(focusInfo, letters[li].title);
    } else {
      grid.focusIndex(grid.index + dir * grid.cols * 3);
    }
  }

  return {
    el,
    name: 'library',
    onShow() { ambience.restore(); fitText(titleEl, 58, 36); },
    onKey(action) {
      if (zone === 'tools') {
        switch (action) {
          case 'left': toolIndex = Math.max(0, toolIndex - 1); renderZone(); return true;
          case 'right': toolIndex = Math.min(tools.length - 1, toolIndex + 1); renderZone(); return true;
          case 'down': case 'back': zone = 'grid'; renderZone(); return true;
          case 'enter': if (tools[toolIndex]) tools[toolIndex].run(); return true;
        }
        return true;
      }
      switch (action) {
        case 'left': grid.move(-1, 0); return true;
        case 'right': grid.move(1, 0); return true;
        case 'up':
          if (grid.index < grid.cols && tools.length) { zone = 'tools'; renderZone(); return true; }
          grid.move(0, -1); return true;
        case 'down': grid.move(0, 1); return true;
        case 'pageup': jump(-1); return true;
        case 'pagedown': jump(1); return true;
        case 'enter': grid.select(); return true;
        case 'play': case 'playpause': if (grid.current() && grid.current().type !== 'collection') playItem(grid.current()); return true;
        case 'yellow': if (whole) cycleSort(); return true;
        case 'back':
          if (grid.index > grid.cols * 2) { grid.focusIndex(0); return true; }
          return false;
      }
      return false;
    },
  };
}
