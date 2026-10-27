// Detail page for a movie, show, season (opens its show) or episode.
import { h, setText, setTransform, toggleClass, fitText } from '../util/dom.js';
import { useAmbience, HeroArt } from '../ui/backdrop.js';
import { Row } from '../ui/row.js';
import { session } from '../session.js';
import { metaLine, clock, episodeLabel } from '../util/format.js';
import { clearLogo } from './home.js';
import { renderRatings } from '../ui/ratings.js';
import * as icons from '../ui/icons.js';
import * as router from '../router.js';
import { playItem, openPerson } from '../nav.js';
import { warm as warmDiscover } from '../plex/discover.js';
import { error } from '../util/log.js';

const SHIFT = 400; // how far the body slides up to reveal seasons/episodes

export function DetailScreen(initial, { autoplay = false } = {}) {
  const el = h('div', 'screen detail');
  const ambience = useAmbience(initial.UltraBlurColors);
  const art = new HeroArt(el, 'hero-art detail-art');
  const body = h('div', 'detail-body', el);
  const logo = h('img', 'detail-logo', body);
  const title = h('h1', 'detail-title', body);
  const sub = h('div', 'detail-sub', body);
  const metaRow = h('div', 'detail-meta', body);
  const meta = h('span', '', metaRow);
  const ratingsEl = h('span', 'ratings', metaRow);
  const tags = h('div', 'detail-tags', body);
  const summary = h('p', 'detail-summary', body);
  const buttonsEl = h('div', 'detail-buttons', body);
  const seasonsEl = h('div', 'detail-seasons', body);
  const episodesWrap = h('div', 'detail-episodes', body);
  const castWrap = h('div', 'detail-cast', body);
  // Full synopsis when the one on the page is clipped.
  const more = h('div', 'detail-more hidden', el);
  const moreBox = h('div', 'detail-more-box', more);
  const moreTitle = h('h2', 'detail-more-title', moreBox);
  const moreText = h('div', 'detail-more-text', moreBox);
  h('div', 'detail-more-hint', moreBox).textContent = '▲▼ Scroll · OK or Back to close';

  let item = initial;
  let buttons = [];
  let buttonIndex = 0;
  let seasons = [];
  let seasonIndex = 0;
  let episodes = null;
  let cast = null;
  let zone = 'buttons';
  let alive = true;
  let shown = false;

  const isShowLike = () => item.type === 'show';

  function renderHeader() {
    const server = session.server;
    const logoPath = clearLogo(item);
    const showTitle = item.type === 'episode' ? item.grandparentTitle : item.title;
    if (logoPath) {
      logo.src = server.image(logoPath, 720, 240, { format: 'png' });
      logo.style.display = '';
      title.style.display = 'none';
    } else {
      logo.style.display = 'none';
      title.style.display = '';
      setText(title, showTitle);
      fitText(title, 70, 42);
    }
    setText(sub, item.type === 'episode' ? episodeLabel(item) + '   ' + item.title : (item.tagline || ''));
    setText(meta, metaLine(item, { score: false }));
    renderRatings(ratingsEl, item);
    const genres = (item.Genre || []).slice(0, 3).map(g => g.tag);
    const people = (item.Director || []).slice(0, 1).map(d => 'Directed by ' + d.tag)
      .concat((item.Role || []).length ? ['Starring ' + item.Role.slice(0, 3).map(r => r.tag).join(', ')] : []);
    setText(tags, genres.concat(people).join('   ·   '));
    setText(summary, item.summary || '');
    ambience.set(item.UltraBlurColors);
    const artPath = item.type === 'episode' ? (item.grandparentArt || item.art) : item.art;
    art.set(server.image(artPath, 1920, 1080));
  }

  function target() {
    // What Play acts on: the item itself, or for a show the next episode.
    if (!isShowLike()) return item;
    if (item.onDeck) return item.onDeck;
    if (!episodes) return null;
    const eps = episodes.items;
    return eps.find(e => e.viewOffset) || eps.find(e => !e.viewCount) || eps[0] || null;
  }

  function renderButtons() {
    buttonsEl.innerHTML = '';
    buttons = [];
    const t = target();
    const add = (icon, label, run) => {
      const b = h('div', 'btn', buttonsEl);
      b.innerHTML = icon;
      h('span', '', b).textContent = label;
      buttons.push({ el: b, run });
    };
    if (t) {
      const prefix = isShowLike() ? episodeLabel(t) + '  ' : '';
      if (t.viewOffset) {
        add(icons.play, prefix + 'Resume ' + clock(t.viewOffset), () => playItem(t, { offset: t.viewOffset }));
        add(icons.restart, 'From the start', () => playItem(t, { offset: 0 }));
      } else {
        add(icons.play, isShowLike() ? 'Play ' + prefix : 'Play', () => playItem(t, { offset: 0 }));
      }
    }
    if (summary.scrollHeight > summary.clientHeight + 2) add(icons.info, 'More', openMore);
    const trailer = item.type === 'movie' && item.Extras && (item.Extras.Metadata || []).find(x => x.subtype === 'trailer');
    if (trailer) add(icons.film, 'Trailer', () => playItem(trailer, { offset: 0 }));
    const watched = isShowLike() ? item.viewedLeafCount >= item.leafCount : !!item.viewCount;
    add(watched ? icons.check : icons.uncheck, watched ? 'Watched' : 'Mark watched', toggleWatched);
    if (item.type === 'episode' && item.grandparentRatingKey) {
      add(icons.tv, 'Go to show', () => router.push(DetailScreen({ ratingKey: item.grandparentRatingKey, type: 'show', title: item.grandparentTitle })));
    }
    buttonIndex = Math.min(buttonIndex, buttons.length - 1);
    renderFocus();
  }

  function renderSeasons() {
    seasonsEl.innerHTML = '';
    seasons.forEach(s => { s.el = h('div', 'pill', seasonsEl); s.el.textContent = s.title; });
    renderFocus();
  }

  function renderFocus() {
    buttons.forEach((b, i) => toggleClass(b.el, 'focus', zone === 'buttons' && i === buttonIndex));
    seasons.forEach((s, i) => {
      toggleClass(s.el, 'focus', zone === 'seasons' && i === seasonIndex);
      toggleClass(s.el, 'current', i === seasonIndex);
    });
    if (episodes) episodes.row.setActive(zone === 'episodes');
    if (cast) cast.setActive(zone === 'cast');
    setTransform(body, 'translateY(' + (-shiftFor(zone)) + 'px)');
    toggleClass(el, 'shifted', zone !== 'buttons');
  }

  function openMore() {
    setText(moreTitle, item.type === 'episode' ? item.grandparentTitle + '  ·  ' + episodeLabel(item) + '  ' + item.title : item.title);
    setText(moreText, item.summary || '');
    moreText.scrollTop = 0;
    more.classList.remove('hidden');
  }

  // Seasons/episodes slide up by SHIFT; the cast row further, by however far
  // below the first of those it sits.
  function shiftFor(z) {
    if (z === 'buttons') return 0;
    if (z !== 'cast') return SHIFT;
    const first = [seasonsEl, episodesWrap, castWrap].find(e => e.offsetParent);
    return SHIFT + castWrap.offsetTop - first.offsetTop;
  }

  // Cast first, then directors and writers, like the official app.
  function renderCast() {
    const tag = (list, role) => (list || []).map(p => ({
      type: 'person', title: p.tag, sub: role || p.role || '', thumb: p.thumb, tagKey: p.tagKey,
      filter: p.filter, ratingKey: 'person:' + p.id + ':' + (role || 'actor'),
    }));
    const people = tag(item.Role).concat(tag(item.Director, 'Director'), tag(item.Writer, 'Writer'));
    if (!people.length) return;
    warmDiscover();
    if (!cast) {
      cast = new Row({ title: 'Cast & Crew', kind: 'person', caption: true, items: people, onSelect: openPerson });
      castWrap.appendChild(cast.el);
      castWrap.style.height = cast.height + 'px'; // rows are absolutely positioned
    } else {
      cast.setItems(people);
    }
  }

  async function loadEpisodes(season) {
    const kids = await session.server.children(season.ratingKey);
    if (!alive) return;
    if (!episodes) {
      const row = new Row({
        kind: 'episode', caption: true, items: kids,
        onSelect: ep => playItem(ep, { offset: ep.viewOffset || 0 }),
      });
      episodesWrap.appendChild(row.el);
      episodes = { row, items: kids };
    } else {
      episodes.items = kids;
      episodes.row.setItems(kids);
    }
    // Land on the first unwatched episode.
    const next = kids.findIndex(k => !k.viewCount || k.viewOffset);
    episodes.row.focusIndex(next >= 0 ? next : 0);
    renderFocus();
  }

  async function load() {
    try {
      let key = item.ratingKey;
      let preferSeason = null;
      if (item.type === 'season') { preferSeason = item.ratingKey; key = item.parentRatingKey; }
      const full = await session.server.metadata(key, { extras: true });
      if (!alive || !full) return;
      item = full;
      renderHeader();
      renderCast();
      if (isShowLike()) {
        seasons = (await session.server.children(item.ratingKey)).filter(s => s.type === 'season');
        if (!alive) return;
        const deckSeason = item.onDeck ? seasons.findIndex(s => s.ratingKey === item.onDeck.parentRatingKey) : -1;
        const pref = preferSeason ? seasons.findIndex(s => s.ratingKey === preferSeason) : -1;
        seasonIndex = pref >= 0 ? pref : (deckSeason >= 0 ? deckSeason : 0);
        renderSeasons();
        if (seasons[seasonIndex]) await loadEpisodes(seasons[seasonIndex]);
      }
      renderButtons();
      if (autoplay) {
        autoplay = false;
        const t = target();
        if (t) playItem(t, { offset: t.viewOffset || 0 });
      }
    } catch (e) {
      error('detail load failed', e);
      setText(summary, 'Couldn\'t load details.');
    }
  }

  async function toggleWatched() {
    const server = session.server;
    const watched = isShowLike() ? item.viewedLeafCount >= item.leafCount : !!item.viewCount;
    try {
      if (watched) await server.unscrobble(item.ratingKey);
      else await server.scrobble(item.ratingKey);
      server.invalidate();
      await load();
    } catch (e) {
      error('toggle watched failed', e);
    }
  }

  if (item.title) renderHeader();
  renderButtons();
  load();

  function moveZone(dir) {
    const order = ['buttons'];
    if (seasons.length > 1) order.push('seasons');
    if (episodes) order.push('episodes');
    if (cast) order.push('cast');
    const i = order.indexOf(zone) + dir;
    if (i < 0 || i >= order.length) return;
    zone = order[i];
    renderFocus();
  }

  return {
    el,
    name: 'detail',
    onShow() {
      ambience.restore();
      if (title.style.display !== 'none') fitText(title, 70, 42);
      // Back from the player: refresh resume points and watched state.
      if (shown) {
        session.server.invalidate();
        load();
      }
      shown = true;
    },
    onKey(action) {
      if (!more.classList.contains('hidden')) {
        if (action === 'up' || action === 'down') moreText.scrollTop += action === 'down' ? 156 : -156;
        if (action === 'back' || action === 'enter') more.classList.add('hidden');
        return true;
      }
      if (action === 'up') { moveZone(-1); return true; }
      if (action === 'down') { moveZone(1); return true; }
      if (action === 'play' || action === 'playpause') {
        const t = zone === 'episodes' ? episodes.row.current() : target();
        if (t) playItem(t, { offset: t.viewOffset || 0 });
        return true;
      }
      if (zone === 'buttons') {
        if (action === 'left') { buttonIndex = Math.max(0, buttonIndex - 1); renderFocus(); return true; }
        if (action === 'right') { buttonIndex = Math.min(buttons.length - 1, buttonIndex + 1); renderFocus(); return true; }
        if (action === 'enter' && buttons[buttonIndex]) { buttons[buttonIndex].run(); return true; }
      } else if (zone === 'seasons') {
        if (action === 'left' || action === 'right') {
          const next = seasonIndex + (action === 'right' ? 1 : -1);
          if (next >= 0 && next < seasons.length) {
            seasonIndex = next;
            renderFocus();
            loadEpisodes(seasons[seasonIndex]).catch(e => error('episodes failed', e));
          }
          return true;
        }
        if (action === 'enter') { moveZone(1); return true; }
      } else if (zone === 'episodes') {
        if (action === 'left') { episodes.row.move(-1); return true; }
        if (action === 'right') { episodes.row.move(1); return true; }
        if (action === 'enter') { episodes.row.select(); return true; }
        if (action === 'info') { router.push(DetailScreen(episodes.row.current())); return true; }
      } else if (zone === 'cast') {
        if (action === 'left') { cast.move(-1); return true; }
        if (action === 'right') { cast.move(1); return true; }
        if (action === 'enter') { cast.select(); return true; }
      }
      if (action === 'back' && zone !== 'buttons') { zone = 'buttons'; renderFocus(); return true; }
      return false;
    },
    destroy() { alive = false; },
  };
}
