// Plex Media Server API, scoped to the features this client uses.
import { request, withQuery, identity } from './client.js';

const SUPPORTED_HUB_TYPES = { movie: 1, show: 1, episode: 1, season: 1, mixed: 1, clip: 1 };

export class Server {
  constructor({ uri, token, name, id }) {
    this.uri = uri;
    this.token = token;
    this.name = name;
    this.id = id;
    this.cache = new Map();
  }

  async get(path, params, { maxAge = 0 } = {}) {
    const key = withQuery(path, params);
    if (maxAge) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.t < maxAge) return hit.data;
    }
    const json = await request(this.uri + path, { token: this.token, params });
    const data = json.MediaContainer || json;
    if (maxAge) this.cache.set(key, { t: Date.now(), data });
    return data;
  }

  invalidate() {
    this.cache.clear();
  }

  // Posters/backdrops resized (and optionally blurred) by the server, so the TV
  // only ever downloads and decodes pixels it actually shows.
  image(path, width, height, { blur = 0, quality = 85, format = 'jpeg' } = {}) {
    if (!path) return '';
    return withQuery(this.uri + '/photo/:/transcode', {
      width, height, minSize: 1, upscale: 1, blur: blur || undefined,
      quality, format, url: path, 'X-Plex-Token': this.token,
    });
  }

  url(path, params) {
    return withQuery(this.uri + path, Object.assign({ 'X-Plex-Token': this.token }, params));
  }

  async sections() {
    const mc = await this.get('/library/sections', null, { maxAge: 300000 });
    return (mc.Directory || []).filter(d => d.type === 'movie' || d.type === 'show');
  }

  async hubs() {
    const mc = await this.get('/hubs', { count: 24, includeExternalMedia: 0 });
    return (mc.Hub || []).filter(h => h.size > 0 && SUPPORTED_HUB_TYPES[h.type] && h.Metadata);
  }

  async sectionHubs(sectionId) {
    const mc = await this.get('/hubs/sections/' + sectionId, { count: 24 });
    return (mc.Hub || []).filter(h => h.size > 0 && SUPPORTED_HUB_TYPES[h.type] && h.Metadata);
  }

  async items(sectionId, start, size, { sort = 'titleSort', type, unwatched = false } = {}) {
    const mc = await this.get('/library/sections/' + sectionId + '/all', {
      sort, type, unwatched: unwatched ? 1 : undefined,
      'X-Plex-Container-Start': start,
      'X-Plex-Container-Size': size,
      excludeFields: 'summary,tagline',
    });
    return { total: mc.totalSize != null ? mc.totalSize : mc.size, items: mc.Metadata || [] };
  }

  async collections(sectionId, start, size) {
    return this.page('/library/sections/' + sectionId + '/collections', start, size);
  }

  // A collection's items in the collection's own order (the server ignores
  // sort and filters here, smart collections included).
  async collectionItems(ratingKey, start, size) {
    return this.page('/library/collections/' + ratingKey + '/children', start, size);
  }

  async page(path, start, size) {
    const mc = await this.get(path, {
      'X-Plex-Container-Start': start,
      'X-Plex-Container-Size': size,
      excludeFields: 'summary,tagline',
    });
    return { total: mc.totalSize != null ? mc.totalSize : mc.size, items: mc.Metadata || [] };
  }

  async metadata(ratingKey, { markers = false, extras = false } = {}) {
    const mc = await this.get('/library/metadata/' + ratingKey, {
      includeOnDeck: 1, includeExtras: extras ? 1 : 0, includeMarkers: markers ? 1 : undefined,
    });
    const item = (mc.Metadata || [])[0];
    if (item && mc.OnDeck && mc.OnDeck.Metadata) item.onDeck = mc.OnDeck.Metadata[0];
    return item;
  }

  async children(ratingKey) {
    const mc = await this.get('/library/metadata/' + ratingKey + '/children', { excludeAllLeaves: 1 });
    return mc.Metadata || [];
  }

  async search(q) {
    const mc = await this.get('/hubs/search', { query: q, limit: 30, includeCollections: 0 });
    return (mc.Hub || []).filter(h => h.size > 0 && SUPPORTED_HUB_TYPES[h.type] && h.Metadata);
  }

  // Subtitles the server can fetch from its providers (OpenSubtitles).
  async searchSubtitles(ratingKey, language) {
    const mc = await this.get('/library/metadata/' + ratingKey + '/subtitles', { language, hearingImpaired: 0, forced: 0 });
    return mc.Stream || [];
  }

  // Downloads a search result and attaches it to the item as an external stream.
  downloadSubtitle(ratingKey, stream) {
    return request(this.uri + '/library/metadata/' + ratingKey + '/subtitles', {
      method: 'PUT', token: this.token, timeout: 30000,
      params: {
        key: stream.key, codec: stream.codec, language: stream.languageCode,
        hearingImpaired: stream.hearingImpaired ? 1 : 0, forced: stream.forced ? 1 : 0,
        providerTitle: stream.providerTitle,
      },
    });
  }

  timeline(params) {
    return request(this.uri + '/:/timeline', { token: this.token, params, timeout: 8000 }).catch(() => {});
  }

  scrobble(ratingKey) {
    return request(this.uri + '/:/scrobble', {
      token: this.token, params: { identifier: 'com.plexapp.plugins.library', key: ratingKey },
    });
  }

  unscrobble(ratingKey) {
    return request(this.uri + '/:/unscrobble', {
      token: this.token, params: { identifier: 'com.plexapp.plugins.library', key: ratingKey },
    });
  }

  // HLS URL for content the TV can't direct play. Video is passed through when
  // possible; only the audio (e.g. DTS) or container gets converted.
  transcodeUrl(item, { session, offsetMs = 0, mediaIndex = 0, maxBitrate = 40000, resolution = '3840x2160', audioStreamID, subtitleStreamID } = {}) {
    const extra = [
      'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264,hevc&audioCodec=aac,ac3,eac3)',
      'add-direct-play-profile(type=videoProfile&container=mp4,mkv&videoCodec=h264,hevc&audioCodec=aac,ac3,eac3)',
    ].join('+');
    return withQuery(this.uri + '/video/:/transcode/universal/start.m3u8', Object.assign({}, identity(), {
      path: '/library/metadata/' + item.ratingKey,
      mediaIndex, partIndex: 0,
      protocol: 'hls', fastSeek: 1,
      directPlay: 0, directStream: 1, directStreamAudio: 1,
      offset: Math.floor(offsetMs / 1000),
      videoQuality: 100, videoResolution: resolution, maxVideoBitrate: maxBitrate,
      subtitles: subtitleStreamID ? 'burn' : 'none', subtitleSize: 100,
      audioBoost: 100, location: 'lan', copyts: 1,
      session, 'X-Plex-Session-Identifier': session,
      'X-Plex-Client-Profile-Extra': extra,
      'X-Plex-Token': this.token,
    }));
  }

  // Selected audio/subtitle streams are stored per part on the server.
  selectStreams(partId, { audioStreamID, subtitleStreamID }) {
    return request(this.uri + '/library/parts/' + partId, {
      method: 'PUT', token: this.token,
      params: { audioStreamID, subtitleStreamID, allParts: 1 },
    }).catch(() => {});
  }

  stopTranscode(session) {
    return request(this.uri + '/video/:/transcode/universal/stop', {
      token: this.token, params: { session }, timeout: 5000,
    }).catch(() => {});
  }
}
