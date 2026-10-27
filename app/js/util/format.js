import * as store from './store.js';

export function duration(ms) {
  if (!ms) return '';
  const min = Math.round(ms / 60000);
  if (min < 60) return min + 'm';
  return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
}

// long: always h:mm:ss, so times in a video over an hour keep one width.
export function clock(ms, long) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = n => (n < 10 ? '0' : '') + n;
  return (hh || long ? hh + ':' + pad(mm) : mm) + ':' + pad(ss);
}

// Clock time, 24-hour unless the setting (default: by TV language) says 12.
export function use24h() {
  return store.get('clock24', !/^en-US/i.test(navigator.language || ''));
}

export function timeOfDay(date) {
  const mm = date.getMinutes();
  const pad = (mm < 10 ? ':0' : ':') + mm;
  if (use24h()) return (date.getHours() < 10 ? '0' : '') + date.getHours() + pad;
  const hh = date.getHours();
  return (hh % 12 || 12) + pad + (hh >= 12 ? ' PM' : ' AM');
}

export function episodeLabel(item) {
  if (item.type !== 'episode') return '';
  return 'S' + (item.parentIndex || 0) + ' · E' + (item.index || 0);
}

// The line under a title: "2019 · PG-13 · 2h 4m" style. Pass score: false
// where ratings() is drawn next to it.
export function metaLine(item, { score = true } = {}) {
  const parts = [];
  if (item.type === 'episode') {
    parts.push(episodeLabel(item));
    if (item.originallyAvailableAt) parts.push(item.originallyAvailableAt.slice(0, 4));
  } else if (item.year) {
    parts.push(item.year);
  }
  if (item.contentRating) parts.push(item.contentRating);
  if (item.type === 'show' && item.childCount) parts.push(item.childCount + (item.childCount === 1 ? ' season' : ' seasons'));
  else if (item.duration) parts.push(duration(item.duration));
  if (score && item.audienceRating) parts.push('★ ' + Number(item.audienceRating).toFixed(1));
  return parts.join('  ·  ');
}

const percent = v => Math.round(v * 10) + '%';
const RATING_KINDS = {
  'rottentomatoes://image.rating.ripe': { icon: 'rtFresh', text: percent },
  'rottentomatoes://image.rating.rotten': { icon: 'rtRotten', text: percent },
  'rottentomatoes://image.rating.upright': { icon: 'rtUpright', text: percent },
  'rottentomatoes://image.rating.spilled': { icon: 'rtSpilled', text: percent },
  'imdb://image.rating': { icon: 'imdb', text: v => v.toFixed(1) },
  'themoviedb://image.rating': { icon: 'tmdb', text: percent },
};

// Scores with their source: Rotten Tomatoes critic, Rotten Tomatoes audience,
// IMDb, TMDB. Full metadata has a Rating list; list responses only the flat
// rating/audienceRating fields.
export function ratings(item) {
  const list = (item.Rating || []).slice();
  if (!list.length) {
    if (item.rating && item.ratingImage) list.push({ image: item.ratingImage, value: item.rating, type: 'critic' });
    if (item.audienceRating && item.audienceRatingImage) list.push({ image: item.audienceRatingImage, value: item.audienceRating, type: 'audience' });
  }
  const out = [];
  for (const r of list) {
    const kind = RATING_KINDS[r.image];
    if (kind && r.value) out.push({ icon: kind.icon, text: kind.text(Number(r.value)), critic: r.type === 'critic' });
  }
  const rank = r => (r.critic ? 0 : r.icon === 'imdb' ? 2 : r.icon === 'tmdb' ? 3 : 1);
  out.sort((a, b) => rank(a) - rank(b));
  if (out.length) return out;
  return item.audienceRating ? [{ icon: 'star', text: Number(item.audienceRating).toFixed(1) }] : [];
}

export function progress(item) {
  if (!item.viewOffset || !item.duration) return 0;
  return Math.min(1, item.viewOffset / item.duration);
}

export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
