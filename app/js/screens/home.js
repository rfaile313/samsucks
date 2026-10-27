// Home: hero for the focused item, nav bar, and Plex's home hubs as rows.
// The last hub payload is cached so a cold start paints instantly.
import { h, setText, setTransform, toggleClass, fitText } from '../util/dom.js';
import { Row } from '../ui/row.js';
import { useAmbience, HeroArt } from '../ui/backdrop.js';
import { session } from '../session.js';
import { metaLine, timeOfDay } from '../util/format.js';
import { renderRatings } from '../ui/ratings.js';
import { isFast } from '../input.js';
import * as store from '../util/store.js';
import * as icons from '../ui/icons.js';
import { openItem, playItem, openLibrary, openSearch, openSettings, shuffle } from '../nav.js';
import { error, log } from '../util/log.js';

const ROWS_TOP = 600;
const NAV_PAD = 80; // wider than the 64px edge fade in app.css

function slimHub(hub) {
  // Keep the cache small: only fields the home screen renders.
  const keep = ['ratingKey', 'key', 'type', 'title', 'grandparentTitle', 'parentTitle', 'year', 'thumb', 'art',
    'grandparentThumb', 'grandparentArt', 'parentThumb', 'index', 'parentIndex', 'duration', 'viewOffset',
    'viewCount', 'leafCount', 'viewedLeafCount', 'childCount', 'contentRating', 'audienceRating', 'summary',
    'rating', 'ratingImage', 'audienceRatingImage',
    'originallyAvailableAt', 'UltraBlurColors', 'grandparentRatingKey', 'parentRatingKey', 'Image'];
  return {
    hubIdentifier: hub.hubIdentifier, title: hub.title, type: hub.type,
    Metadata: hub.Metadata.map(m => {
      const o = {};
      for (const k of keep) if (m[k] !== undefined) o[k] = m[k];
      return o;
    }),
  };
}

export function heroArtPath(item) {
  if (item.type === 'episode' || item.type === 'season') return item.grandparentArt || item.art;
  return item.art;
}

export function clearLogo(item) {
  const img = (item.Image || []).find(i => i.type === 'clearLogo');
  return img ? img.url : '';
}

export function HomeScreen() {
  const el = h('div', 'screen home');
  const ambience = useAmbience();
  const hero = new HeroArt(el, 'hero-art home-art');

  const top = h('header', 'topbar', el);
  const brand = h('div', 'brand', top);
  const brandText = h('div', 'brand-text', brand);
  h('img', 'brand-wordmark', brandText).src = 'img/plex-logo.png';
  // The nav is a clip with a sliding track, so any number of libraries fits.
  const navEl = h('nav', 'nav', top);
  const navTrack = h('div', 'nav-track', navEl);
  const clockEl = h('div', 'topbar-clock', top);
  const tick = () => setText(clockEl, timeOfDay(new Date()));
  tick();
  const clockTimer = setInterval(tick, 5000);

  const info = h('div', 'hero-info', el);
  const heroLogo = h('img', 'hero-logo', info);
  const heroTitle = h('h1', 'hero-title', info);
  const heroMetaRow = h('div', 'hero-meta', info);
  const heroMeta = h('span', '', heroMetaRow);
  const heroRatings = h('span', 'ratings', heroMetaRow);
  const heroSummary = h('p', 'hero-summary', info);

  const rowsClip = h('div', 'home-rows', el);
  rowsClip.style.top = ROWS_TOP + 'px';
  const track = h('div', 'rows-track', rowsClip);
  const empty = h('div', 'home-empty', el);

  let rows = [];
  let offsets = [];
  let rowIndex = 0;
  let zone = 'rows';
  let navItems = [];
  let navIndex = 0;
  let navScroll = 0;
  let loadedAt = 0;
  let heroTimer = 0;
  let artTimer = 0;
  let reportedPaint = false;

  function buildNav(sections) {
    navTrack.innerHTML = '';
    navItems = [{ label: 'Home', id: 'home' }]
      .concat(sections.map(s => ({ label: s.title, id: 'section', section: s })))
      .concat(sections.some(s => s.type === 'movie') ? [{ label: 'Shuffle', id: 'shuffle', icon: icons.shuffle }] : [])
      .concat([{ label: 'Search', id: 'search', icon: icons.search }, { label: 'Settings', id: 'settings', icon: icons.gear }]);
    navIndex = Math.min(navIndex, navItems.length - 1);
    navItems.forEach((n, i) => {
      if (n.icon && !navItems[i - 1].icon) h('i', 'nav-sep', navTrack);
      n.el = h('div', 'nav-item' + (n.icon ? ' nav-icon' : ''), navTrack);
      if (n.icon) n.el.innerHTML = n.icon;
      else h('span', '', n.el).textContent = n.label;
    });
    renderNav();
  }

  // Slide the track just enough to keep the focused item clear of the edge fades.
  function scrollNav() {
    const room = navEl.clientWidth;
    if (!room) return; // hidden screen: nothing to measure
    const max = Math.max(0, navTrack.offsetWidth - room);
    const n = navItems[navIndex];
    if (zone === 'nav' && n) {
      const left = n.el.offsetLeft;
      const right = left + n.el.offsetWidth;
      if (left - NAV_PAD < navScroll) navScroll = left - NAV_PAD;
      else if (right + NAV_PAD > navScroll + room) navScroll = right + NAV_PAD - room;
    }
    navScroll = Math.round(Math.max(0, Math.min(max, navScroll)));
    setTransform(navTrack, 'translateX(' + (-navScroll) + 'px)');
    toggleClass(navEl, 'more-left', navScroll > 0);
    toggleClass(navEl, 'more-right', navScroll < max - 1);
  }

  function renderNav() {
    scrollNav(); // measure before the class writes below dirty the style
    navItems.forEach((n, i) => {
      toggleClass(n.el, 'focus', zone === 'nav' && i === navIndex);
      toggleClass(n.el, 'current', n.id === 'home');
    });
    toggleClass(el, 'in-nav', zone === 'nav');
  }

  function showHero(item) {
    if (!item) return;
    const logoPath = clearLogo(item);
    const server = session.server;
    if (logoPath && item.type !== 'episode') {
      heroLogo.src = server.image(logoPath, 640, 200, { format: 'png' });
      heroLogo.style.display = '';
      heroTitle.style.display = 'none';
    } else {
      heroLogo.style.display = 'none';
      heroTitle.style.display = '';
      setText(heroTitle, item.type === 'episode' ? item.grandparentTitle : item.title);
      fitText(heroTitle, 64, 40);
    }
    setText(heroMeta, (item.type === 'episode' ? item.title + '  ·  ' : '') + metaLine(item, { score: false }));
    renderRatings(heroRatings, item);
    setText(heroSummary, item.summary || '');
    ambience.set(item.UltraBlurColors);
    clearTimeout(artTimer);
    artTimer = setTimeout(() => hero.set(server.image(heroArtPath(item), 1344, 756)), isFast() ? 350 : 120);
  }

  function onFocusItem(item) {
    clearTimeout(heroTimer);
    // While a key is held, skip the text repaint until the user settles.
    if (isFast()) heroTimer = setTimeout(() => showHero(item), 160);
    else showHero(item);
  }

  function layoutRows() {
    offsets = [];
    let y = 0;
    rows.forEach(r => {
      offsets.push(y);
      setTransform(r.el, 'translateY(' + y + 'px)');
      y += r.height;
    });
  }

  function renderRows() {
    rows.forEach((r, i) => {
      r.setActive(zone === 'rows' && i === rowIndex);
      toggleClass(r.el, 'above', i < rowIndex);
    });
    setTransform(track, 'translateY(' + (-(offsets[rowIndex] || 0)) + 'px)');
  }

  function setHubs(hubs) {
    const sameShape = hubs.length === rows.length && hubs.every((hb, i) => rows[i].hubId === hb.hubIdentifier);
    const focusedKey = rows[rowIndex] && rows[rowIndex].current() && rows[rowIndex].current().ratingKey;
    if (sameShape) {
      hubs.forEach((hb, i) => rows[i].setItems(hb.Metadata, i === rowIndex ? focusedKey : null));
    } else {
      track.innerHTML = '';
      rows = hubs.map(hb => {
        const wide = /continue|ondeck/i.test(hb.hubIdentifier);
        const row = new Row({
          title: hb.title, kind: wide ? 'wide' : 'poster', items: hb.Metadata,
          onFocus: onFocusItem, onSelect: item => openItem(item),
        });
        row.hubId = hb.hubIdentifier;
        track.appendChild(row.el);
        return row;
      });
      rowIndex = Math.min(rowIndex, Math.max(0, rows.length - 1));
      layoutRows();
    }
    renderRows();
    setText(empty, rows.length ? '' : 'Nothing here yet. Add some media to your Plex server.');
    const cur = rows[rowIndex] && rows[rowIndex].current();
    if (cur) showHero(cur);
    if (!reportedPaint && rows.length) {
      reportedPaint = true;
      log('home rows ready at ' + Math.round(performance.now()) + 'ms after page start');
    }
  }

  async function load() {
    const server = session.server;
    loadedAt = Date.now();
    try {
      const [sections, hubs] = await Promise.all([server.sections(), server.hubs()]);
      buildNav(sections);
      setHubs(hubs);
      store.set('homeCache', { server: server.id, sections, hubs: hubs.map(slimHub) });
    } catch (e) {
      error('home load failed', e);
      if (!rows.length) setText(empty, 'Couldn\'t load from ' + server.name + '. Press OK to retry.');
    }
  }

  const cached = store.get('homeCache');
  if (cached && session.server && cached.server === session.server.id) {
    buildNav(cached.sections || []);
    setHubs(cached.hubs || []);
  } else {
    buildNav([]);
  }
  // Inter swaps in after first paint and changes the label widths.
  if (document.fonts) document.fonts.ready.then(renderNav);
  load();

  function activateNav(n) {
    if (n.id === 'section') openLibrary(n.section);
    else if (n.id === 'shuffle') shuffle({ sections: navItems.filter(x => x.section && x.section.type === 'movie').map(x => x.section), unwatched: true });
    else if (n.id === 'search') openSearch();
    else if (n.id === 'settings') openSettings();
  }

  return {
    el,
    name: 'home',
    destroy() { clearInterval(clockTimer); },
    onShow() {
      ambience.restore();
      renderNav(); // widths can't be measured while the screen was hidden
      // Coming back from playback: progress and Continue Watching changed.
      if (Date.now() - loadedAt > 5000) load();
    },
    onKey(action) {
      if (zone === 'nav') {
        if (action === 'left') { navIndex = Math.max(0, navIndex - 1); renderNav(); return true; }
        if (action === 'right') { navIndex = Math.min(navItems.length - 1, navIndex + 1); renderNav(); return true; }
        if (action === 'down' && rows.length) { zone = 'rows'; renderNav(); renderRows(); return true; }
        if (action === 'enter') { activateNav(navItems[navIndex]); return true; }
        if (action === 'back') return false;
        return true;
      }
      const row = rows[rowIndex];
      if (!row) {
        if (action === 'up') { zone = 'nav'; renderNav(); return true; }
        if (action === 'enter') { load(); return true; }
        return false;
      }
      switch (action) {
        case 'left': row.move(-1); return true;
        case 'right': row.move(1); return true;
        case 'up':
          if (rowIndex === 0) { zone = 'nav'; renderNav(); renderRows(); return true; }
          rowIndex--; renderRows(); onFocusItem(rows[rowIndex].current()); return true;
        case 'down':
          if (rowIndex < rows.length - 1) { rowIndex++; renderRows(); onFocusItem(rows[rowIndex].current()); }
          return true;
        case 'enter': row.select(); return true;
        case 'play': case 'playpause': if (row.current()) playItem(row.current()); return true;
        case 'back':
          // Back from deep in the rows returns to the top first.
          if (rowIndex > 0 || row.index > 0) {
            rowIndex = 0; rows.forEach(r => r.focusIndex(0)); renderRows(); onFocusItem(rows[0].current());
            return true;
          }
          return false;
      }
      return false;
    },
  };
}
