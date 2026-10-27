// Where selecting things goes. Kept in one place so screens don't import each other.
import * as router from './router.js';
import { DetailScreen } from './screens/detail.js';
import { LibraryScreen } from './screens/library.js';
import { PlayerScreen } from './screens/player.js';
import { SearchScreen } from './screens/search.js';
import { SettingsScreen } from './screens/settings.js';
import { PersonScreen } from './screens/person.js';
import { session } from './session.js';
import { error } from './util/log.js';

const SHUFFLE_SIZE = 40;

export function openItem(item) {
  if (item.type === 'clip') { playItem(item); return; }
  if (item.type === 'collection') { openCollection(item); return; }
  router.push(DetailScreen(item));
}

export function playItem(item, opts) {
  if (item.type === 'show' || item.type === 'season') {
    // Play on a show means "the next episode"; the detail screen resolves it.
    router.push(DetailScreen(item, { autoplay: true }));
    return;
  }
  router.push(PlayerScreen(item, opts || {}));
}

export function openLibrary(section) {
  router.push(LibraryScreen(section));
}

export function openCollections(section) {
  router.push(LibraryScreen(section, { collections: true }));
}

export function openCollection(collection, section) {
  section = section || { key: collection.librarySectionID, type: collection.subtype === 'show' ? 'show' : 'movie', title: collection.librarySectionTitle };
  router.push(LibraryScreen(section, { collection }));
}

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// Play movies in random order, one after another (up-next between them).
// From whole libraries the server picks at random; a collection can't be
// sorted server side, so pick random positions in it instead.
export async function shuffle({ sections = [], collection = null, total = 0, unwatched = false }) {
  const server = session.server;
  let picks = [];
  try {
    if (collection) {
      const at = shuffled(Array.from({ length: total }, (_, i) => i)).slice(0, SHUFFLE_SIZE);
      const pages = await Promise.all(at.map(i => server.collectionItems(collection.ratingKey, i, 1)));
      picks = pages.map(p => p.items[0]).filter(Boolean);
    } else {
      const lists = await Promise.all(sections.map(s =>
        server.items(s.key, 0, SHUFFLE_SIZE, { sort: 'random', type: 1, unwatched })));
      picks = shuffled([].concat.apply([], lists.map(l => l.items))).slice(0, SHUFFLE_SIZE);
    }
  } catch (e) {
    error('shuffle failed', e);
    return;
  }
  picks = picks.filter(m => m.type === 'movie' && !(unwatched && m.viewCount));
  if (picks.length) playItem(picks[0], { queue: picks.slice(1) });
}

export function openPerson(person) {
  router.push(PersonScreen(person));
}

export function openSearch() {
  router.push(SearchScreen());
}

export function openSettings() {
  router.push(SettingsScreen());
}
