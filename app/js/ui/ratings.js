// Critic/audience scores with source icons (Rotten Tomatoes, IMDb, TMDB).
import { ratings } from '../util/format.js';
import * as icons from './icons.js';

// Official logos as images; TMDB and the plain star are inline SVG.
const LOGOS = { rtFresh: 1, rtRotten: 1, rtUpright: 1, rtSpilled: 1, imdb: 1 };

export function renderRatings(el, item) {
  const html = ratings(item).map(r =>
    '<span class="rating rating-' + r.icon + '">' +
    (LOGOS[r.icon] ? '<img src="img/ratings/' + r.icon + '.png" alt="">' : icons[r.icon]) +
    r.text + '</span>').join('');
  // Skip the write when nothing changed; hero/focus updates call this often.
  if (el._html !== html) {
    el._html = html;
    el.innerHTML = html;
  }
}
