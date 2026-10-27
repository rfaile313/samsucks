// An actor's (or director's) page: photo, bio, what of theirs is in the
// library, and their full filmography from Plex's Discover service.
import { h, setText, setTransform, toggleClass, fitText } from '../util/dom.js';
import * as icons from '../ui/icons.js';
import { useAmbience } from '../ui/backdrop.js';
import { Row } from '../ui/row.js';
import { session } from '../session.js';
import { person as fetchPerson, credits as fetchCredits } from '../plex/discover.js';
import { openItem } from '../nav.js';
import { error } from '../util/log.js';

const ROWS_TOP = 560;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return d + ' ' + MONTHS[m - 1] + ' ' + y;
}

function age(from, to) {
  const a = new Date(from.slice(0, 10));
  const b = to ? new Date(to.slice(0, 10)) : new Date();
  let years = b.getFullYear() - a.getFullYear();
  if (b.getMonth() < a.getMonth() || (b.getMonth() === a.getMonth() && b.getDate() < a.getDate())) years--;
  return years;
}

// person: { title, thumb, tagKey, filter ('actor=123'), sub (role) }
export function PersonScreen(person) {
  const el = h('div', 'screen person');
  const ambience = useAmbience();
  const body = h('div', 'person-body', el);
  const photoWrap = h('div', 'person-photo', body);
  const photo = h('img', '', photoWrap);
  photo.alt = '';
  const text = h('div', 'person-text', body);
  const nameEl = h('h1', 'person-name', text);
  nameEl.textContent = person.title;
  const meta = h('div', 'person-meta', text);
  const summary = h('p', 'person-summary', text);
  const moreBtn = h('div', 'btn btn-sm person-more hidden', text);
  moreBtn.innerHTML = icons.info;
  h('span', '', moreBtn).textContent = 'More';
  // Full bio when the one on the page is clipped (same overlay as detail pages).
  const more = h('div', 'detail-more hidden', el);
  const moreBox = h('div', 'detail-more-box', more);
  h('h2', 'detail-more-title', moreBox).textContent = person.title;
  const moreText = h('div', 'detail-more-text', moreBox);
  h('div', 'detail-more-hint', moreBox).textContent = '▲▼ Scroll · OK or Back to close';
  const rowsEl = h('div', 'person-rows', body);
  rowsEl.style.top = ROWS_TOP + 'px';

  let rows = [];
  let rowIndex = 0;
  let onMore = false;
  let alive = true;

  function setPhoto(url) {
    if (!url) return;
    photo.src = session.server.image(url, 300, 300);
  }
  setPhoto(person.thumb);

  // What's in the library comes from this server's own tag filter (actor=,
  // director=, writer=), across every movie and show library.
  async function libraryItems() {
    if (!person.filter) return [];
    const [key, value] = person.filter.split('=');
    const server = session.server;
    const sections = await server.sections();
    const lists = await Promise.all(sections.map(s =>
      server.get('/library/sections/' + s.key + '/all', { [key]: value }).then(mc => mc.Metadata || []).catch(() => [])));
    return [].concat.apply([], lists).sort((a, b) => (b.year || 0) - (a.year || 0));
  }

  // Discover credits as tiles. Ones we have locally become the library item
  // itself, so they open and play like anywhere else.
  function filmography(groups, local) {
    const byGuid = {};
    local.forEach(it => { if (it.guid) byGuid[it.guid.split('/').pop()] = it; });
    const seen = {};
    const out = [];
    groups.filter(g => g.type !== 'appeared').forEach(g => (g.Credit || []).forEach(c => {
      const m = c.Metadata;
      if (!m || seen[m.ratingKey] || (m.type !== 'movie' && m.type !== 'show')) return;
      seen[m.ratingKey] = true;
      const role = g.type === 'actor' ? c.role : g.title;
      const sub = [role, m.year].filter(Boolean).join(' · ');
      const mine = byGuid[m.ratingKey];
      out.push(mine ? Object.assign({}, mine, { sub, mine: true })
        : { type: m.type, title: m.title, year: m.year, thumb: m.thumb, ratingKey: 'discover:' + m.ratingKey, sub, remote: true });
    }));
    return out.sort((a, b) => (b.year || 0) - (a.year || 0));
  }

  function addRow(title, items) {
    if (!items.length) return;
    const row = new Row({
      title, kind: 'poster', caption: true, items,
      onSelect: it => { if (!it.remote) openItem(it); },
    });
    // Rows are absolutely positioned: stack them by hand.
    row.top = rows.reduce((y, r) => y + r.height + 20, 0);
    row.el.style.top = row.top + 'px';
    rowsEl.appendChild(row.el);
    rows.push(row);
    render();
  }

  function render() {
    toggleClass(moreBtn, 'focus', onMore);
    rows.forEach((r, i) => r.setActive(!onMore && i === rowIndex));
    const row = rows[rowIndex];
    // Slide so the focused row sits where the first one starts.
    setTransform(body, 'translateY(' + (row ? -row.top : 0) + 'px)');
  }

  async function load() {
    try {
      const [info, groups, local] = await Promise.all([
        person.tagKey ? fetchPerson(person.tagKey).catch(e => { error('person info failed', e); return null; }) : null,
        person.tagKey ? fetchCredits(person.tagKey).catch(e => { error('person credits failed', e); return []; }) : [],
        libraryItems(),
      ]);
      if (!alive) return;
      if (info) {
        if (info.thumb && info.thumb !== person.thumb) setPhoto(info.thumb);
        const bits = [];
        if (info.bornAt) bits.push('Born ' + longDate(info.bornAt) + (info.diedAt ? '' : ' (age ' + age(info.bornAt) + ')'));
        if (info.diedAt) bits.push('Died ' + longDate(info.diedAt) + ' (age ' + age(info.bornAt || info.diedAt, info.diedAt) + ')');
        if (info.birthPlace) bits.push(info.birthPlace);
        setText(meta, bits.join('  ·  '));
        setText(summary, info.summary || '');
        setText(moreText, info.summary || '');
        toggleClass(moreBtn, 'hidden', summary.scrollHeight <= summary.clientHeight + 2);
      }
      addRow('In your library', local);
      addRow('Filmography', filmography(groups, local));
      if (!rows.length) setText(summary, summary.textContent || 'Nothing found for ' + person.title + '.');
    } catch (e) {
      error('person load failed', e);
      setText(summary, 'Couldn\'t load ' + person.title + '.');
    }
  }
  load();

  return {
    el,
    name: 'person',
    onShow() { ambience.restore(); fitText(nameEl, 64, 40); },
    onKey(action) {
      if (!more.classList.contains('hidden')) {
        if (action === 'up' || action === 'down') moreText.scrollTop += action === 'down' ? 156 : -156;
        if (action === 'back' || action === 'enter') more.classList.add('hidden');
        return true;
      }
      const hasMore = !moreBtn.classList.contains('hidden');
      if (onMore) {
        if (action === 'enter') { moreText.scrollTop = 0; more.classList.remove('hidden'); return true; }
        if ((action === 'down' || action === 'back') && rows.length) { onMore = false; render(); return true; }
        return action !== 'back';
      }
      const row = rows[rowIndex];
      switch (action) {
        case 'up':
          if (rowIndex > 0) { rowIndex--; render(); } else if (hasMore) { onMore = true; render(); }
          return true;
        case 'down': if (rowIndex < rows.length - 1) { rowIndex++; render(); } return true;
        case 'left': if (row) row.move(-1); return true;
        case 'right': if (row) row.move(1); return true;
        case 'enter': if (row) row.select(); return true;
        case 'back':
          if (row && (rowIndex > 0 || row.index > 0)) { rowIndex = 0; rows.forEach(r => r.focusIndex(0)); render(); return true; }
          return false;
      }
      return false;
    },
    destroy() { alive = false; },
  };
}
