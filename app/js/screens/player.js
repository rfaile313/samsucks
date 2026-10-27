// Playback. Direct play whenever the TV can decode the file (hardware, zero
// server load); otherwise ask Plex for HLS with the video passed through and
// only the audio/container converted. Seeking previews locally and only
// commits once the user stops pressing, because AVPlay seeks are slow.
import { DEV } from '../config.js';
import { h, setText, setTransform, toggleClass, fitText } from '../util/dom.js';
import { createPlayer } from '../platform/player.js';
import { setScreenSaver, supports4K } from '../platform/tizen.js';
import { session } from '../session.js';
import { clock, episodeLabel, timeOfDay, uuid } from '../util/format.js';
import * as icons from '../ui/icons.js';
import * as router from '../router.js';
import { log, warn, error } from '../util/log.js';
import { request } from '../plex/client.js';
import { parseSubtitles, CueTrack } from '../player/subtitles.js';
import * as store from '../util/store.js';

// What a 2022 Samsung (Tizen 6.5) decodes natively. No DTS on 2018+ models.
const DIRECT = {
  container: { mp4: 1, m4v: 1, mov: 1, mkv: 1, webm: 1, ts: 1, mpegts: 1, avi: 1 },
  video: { h264: 1, hevc: 1, vp9: 1, av1: 1, mpeg4: 1, mpeg2video: 1, vc1: 1 },
  audio: { aac: 1, ac3: 1, eac3: 1, mp3: 1, mp2: 1, flac: 1, opus: 1, vorbis: 1, pcm: 1 },
};
const TEXT_SUBS = { srt: 1, subrip: 1, ass: 1, ssa: 1, mov_text: 1, vtt: 1, webvtt: 1, smi: 1 };

// Names for subtitle search languages that may not appear among the file's own streams.
const LANGUAGES = {
  en: 'English', sv: 'Swedish', no: 'Norwegian', nb: 'Norwegian', da: 'Danish', fi: 'Finnish',
  de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', nl: 'Dutch', pt: 'Portuguese', pl: 'Polish',
};
const PANEL_ROWS = 11;

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SUB_SIZES = [['Small', 36], ['Medium', 46], ['Large', 58], ['Huge', 72]];
const SUB_COLOURS = [['White', '#FFFFFF'], ['Yellow', '#FFE14D'], ['Cyan', '#7FE7FF'], ['Green', '#8CFF8C']];
const SUB_POSITIONS = [['Bottom', 90], ['Raised', 220], ['Top', 0]];
const SUB_BACKS = ['Outline', 'Box'];
const SYNC_STEP = 250;
const SPEED_APPLY_MS = 700;
const JUMPS = [-30000, -15000, 0, 15000, 30000]; // 0 is play/pause

const OSD_HIDE_MS = 4000;
const SEEK_COMMIT_MS = 900;
const TIMELINE_MS = 10000;

function streamsOf(part, type) {
  return (part && part.Stream || []).filter(s => s.streamType === type);
}

function isEmbeddedText(sub) {
  return !!sub && sub.index != null && !sub.key && !!TEXT_SUBS[sub.codec];
}

// External .srt/.ass/.vtt files: we fetch and draw these ourselves.
function isSidecarText(sub) {
  return !!sub && !!sub.key && !!TEXT_SUBS[sub.codec];
}

function subtitleLabel(s) {
  const title = s.displayTitle && s.displayTitle !== 'Unknown' ? s.displayTitle : (s.language || '');
  const kind = (s.codec || '').toUpperCase() + (s.key ? ' · external' : '');
  return title ? title + (s.key ? ' · external' : '') : kind || 'Subtitle';
}

function cleanSubtitle(text) {
  return String(text || '')
    .replace(/\{\\[^}]*\}/g, '')        // ASS override tags
    .replace(/<[^>]+>/g, '')            // <i>, <font> ...
    .replace(/\\N/g, '\n');
}

// queue: what plays after this (shuffle), instead of the next episode.
export function PlayerScreen(initial, { offset = null, queue = [] } = {}) {
  const el = h('div', 'screen player');
  const stage = h('div', 'player-stage', el);
  const subs = h('div', 'subs', el);
  const subsText = h('span', 'subs-text', subs);
  const spinner = h('div', 'spinner', el);
  const pauseBig = h('div', 'pause-big', el);
  pauseBig.innerHTML = icons.pause;

  const osd = h('div', 'osd', el);
  const osdTop = h('div', 'osd-top', osd);
  const osdTitle = h('div', 'osd-title', osdTop);
  const osdSub = h('div', 'osd-sub', osdTop);
  const osdBottom = h('div', 'osd-bottom', osd);
  const bar = h('div', 'osd-bar', osdBottom);
  const barFill = h('div', 'osd-fill', bar);
  const knob = h('div', 'osd-knob', bar);
  const seekLabel = h('div', 'osd-seek', knob);
  const times = h('div', 'osd-times', osdBottom);
  const tNow = h('span', 'osd-now', times);
  const tInfo = h('span', 'osd-info', times);
  const tLeft = h('span', 'osd-left', times);
  const controls = h('div', 'osd-controls', osdBottom);
  const ctlEls = JUMPS.map(ms => {
    const c = h('div', 'osd-ctl', controls);
    if (ms) c.textContent = (ms < 0 ? '−' : '+') + Math.abs(ms / 1000);
    return c;
  });
  const hintEl = h('div', 'osd-hint', osdBottom);
  hintEl.innerHTML = '▲ Controls &nbsp;&nbsp; ▼ Audio, subtitles &amp; speed';

  const panel = h('div', 'tracks hidden', el);
  const upnext = h('div', 'upnext hidden', el);
  const skipBtn = h('div', 'skip hidden', el);
  const errorEl = h('div', 'player-error hidden', el);

  let item = initial;
  let media = null;
  let part = null;
  let mode = 'direct';
  let triedFallback = false;
  let base = 0;             // HLS restarts at an offset; AVPlay time is relative to it
  let position = offset || 0;
  let duration = initial.duration || 0;
  let paused = false;
  let started = false;
  let alive = true;
  let audioStream = null;
  let subStream = null;
  let seekTarget = null;
  let seekCount = 0;
  let lastSeekAt = 0;
  let seekTimer = 0;
  let osdTimer = 0;
  let timelineTimer = 0;
  let subTimer = 0;
  let lastText = 0;
  let upnextTimer = 0;
  let nextItem = null;
  let cueTrack = null;
  let cueTimer = 0;
  let cueFor = null;
  let markers = [];
  let skipFor = null;
  let ctlIndex = -1;        // focused OSD control, -1 = the seek bar
  let speed = 1;
  let web = false;          // playing through <video> (for speed) instead of AVPlay
  let speedTimer = 0;
  let subDelay = 0;         // ms, positive = subtitles later
  const subStyle = Object.assign({ size: 1, colour: 0, position: 0, back: 0 }, store.get('subStyle', {}));
  const playSession = uuid();

  const listener = {
    onTime(ms) {
      if (!started) return;
      position = base + ms;
      if (seekTarget == null) {
        renderProgress(position);
        updateSkip(position);
      }
    },
    onBuffering(on) { toggleClass(spinner, 'on', on); },
    onEnd() { finished(); },
    onError(msg) { failed(msg); },
    onSubtitle(text, ms) {
      clearTimeout(subTimer);
      setText(subsText, cleanSubtitle(text));
      if (ms > 0) subTimer = setTimeout(() => setText(subsText, ''), ms);
    },
  };
  let player = createPlayer(stage, listener);

  // --- OSD --------------------------------------------------------------

  const long = () => duration >= 3600000;

  function renderProgress(ms) {
    const p = duration ? Math.max(0, Math.min(1, ms / duration)) : 0;
    setTransform(barFill, 'scaleX(' + p.toFixed(4) + ')');
    setTransform(knob, 'translateX(' + Math.round(p * 1728) + 'px)');
    const now = Date.now();
    if (now - lastText > 900 || seekTarget != null) {
      lastText = now;
      setText(tNow, clock(ms, long()));
      setText(tLeft, '−' + clock(duration - ms, long()));
      setText(tInfo, 'Ends at ' + timeOfDay(new Date(now + (duration - ms))));
    }
  }

  function showOsd(sticky) {
    toggleClass(el, 'osd-on', true);
    renderControls();
    clearTimeout(osdTimer);
    if (!sticky && !paused) osdTimer = setTimeout(hideOsd, OSD_HIDE_MS);
  }

  function hideOsd() {
    clearTimeout(osdTimer);
    toggleClass(el, 'osd-on', false);
    ctlIndex = -1;
    renderControls();
  }

  function renderControls() {
    ctlEls.forEach((c, i) => toggleClass(c, 'focus', i === ctlIndex));
    const icon = paused ? icons.play : icons.pause;
    if (ctlEls[2]._icon !== icon) { ctlEls[2]._icon = icon; ctlEls[2].innerHTML = icon; }
  }

  // --- Subtitle look and sync --------------------------------------------

  function applySubStyle() {
    subs.style.fontSize = SUB_SIZES[subStyle.size][1] + 'px';
    subs.style.color = SUB_COLOURS[subStyle.colour][1];
    const pos = SUB_POSITIONS[subStyle.position][1];
    toggleClass(subs, 'subs-top', !pos);
    subs.style.setProperty('--sub-bottom', (pos || 90) + 'px');
    toggleClass(subs, 'subs-box', SUB_BACKS[subStyle.back] === 'Box');
  }
  applySubStyle();

  function applySync() {
    player.setSubtitleDelay(subDelay);
  }

  function syncLabel() {
    return (subDelay > 0 ? '+' : subDelay < 0 ? '−' : '') + (Math.abs(subDelay) / 1000).toFixed(2) + ' s';
  }

  function setDelay(ms) {
    subDelay = ms;
    if (part) store.set('subDelay:' + part.id, subDelay || undefined);
    applySync();
  }

  // --- Speed ---------------------------------------------------------------
  // AVPlay only does whole-number (trick-play) speeds, so anything but 1×
  // plays Plex's HLS through <video>, whose playbackRate is exact.

  function setSpeed(next) {
    speed = next;
    clearTimeout(speedTimer);
    speedTimer = setTimeout(() => {
      const wantWeb = speed !== 1;
      if (wantWeb === web) { if (web) player.setRate(speed); return; }
      player.destroy();
      if (mode === 'hls') session.server.stopTranscode(playSession);
      web = wantWeb;
      player = createPlayer(stage, listener, { web });
      mode = decideMode();
      triedFallback = false;
      log('speed', speed + 'x', web ? 'via <video>' : 'via AVPlay');
      open(position).catch(e => failed(e.message));
    }, SPEED_APPLY_MS);
  }

  function renderTitles() {
    if (item.type === 'episode') {
      setText(osdTitle, item.grandparentTitle);
      setText(osdSub, episodeLabel(item) + '   ' + item.title);
    } else {
      setText(osdTitle, item.title);
      setText(osdSub, item.year || '');
    }
    fitText(osdTitle, 50, 32);
  }

  // --- Timeline ---------------------------------------------------------

  function report(state) {
    if (!item.ratingKey) return;
    if (DEV && window.__ss && window.__ss.muteTimeline) return;
    session.server.timeline({
      ratingKey: item.ratingKey,
      key: '/library/metadata/' + item.ratingKey,
      state,
      time: Math.floor(position),
      duration: Math.floor(duration),
      'X-Plex-Session-Identifier': playSession,
    });
  }

  function startTimeline() {
    clearInterval(timelineTimer);
    timelineTimer = setInterval(() => report(paused ? 'paused' : 'playing'), TIMELINE_MS);
  }

  // --- Opening ----------------------------------------------------------

  function decideMode() {
    if (web) return 'hls';
    // Trailers and other extras live on Plex's CDN behind a redirect AVPlay
    // can't play; let the server stream them.
    if (part.key.indexOf('/services/') === 0) return 'hls';
    const directOk = DIRECT.container[media.container] && DIRECT.video[media.videoCodec] &&
      (!audioStream || DIRECT.audio[audioStream.codec]);
    const subsOk = !subStream || isEmbeddedText(subStream) || isSidecarText(subStream);
    return directOk && subsOk ? 'direct' : 'hls';
  }

  async function open(atMs) {
    const server = session.server;
    const t0 = Date.now();
    started = false;
    toggleClass(spinner, 'on', true);
    let url;
    if (mode === 'direct') {
      base = 0;
      url = server.url(part.key);
    } else {
      base = atMs;
      // Burn in only what we can't draw ourselves (image subs, embedded text).
      const burn = subStream && !isSidecarText(subStream);
      url = server.transcodeUrl(item, {
        session: playSession, offsetMs: atMs,
        audioStreamID: audioStream && audioStream.id,
        subtitleStreamID: burn ? subStream.id : undefined,
      });
      // PMS 1.42+ rejects start.m3u8 unless a decision was made for the session first.
      const decision = await request(url.replace('/start.m3u8', '/decision'));
      const mc = decision.MediaContainer || {};
      if (mc.generalDecisionCode && mc.generalDecisionCode >= 2000) throw new Error(mc.generalDecisionText || 'Server refused to convert this file');
    }
    log('play', mode, item.title, media.container + '/' + media.videoCodec + '/' + (audioStream && audioStream.codec), 'at', clock(atMs));
    player.open(url, { uhd: media.videoResolution === '4k' && supports4K(), aspect: mode === 'direct' ? displayAspect() : 0 });
    await player.prepare();
    if (!alive) return;
    if (mode === 'direct') {
      applyTracks();
      if (atMs > 0) await player.seek(atMs);
    }
    if (web) player.setRate(speed);
    applySync();
    syncSidecar();
    player.play();
    paused = false;
    started = true;
    position = atMs;
    toggleClass(el, 'paused', false);
    toggleClass(spinner, 'on', false);
    log('playing after ' + (Date.now() - t0) + 'ms (' + mode + ')');
    report('playing');
    startTimeline();
  }

  // Anamorphic video (non-square pixels, e.g. 1280x720 at 9:8) shown at its
  // real shape. Plex's HLS output already has square pixels.
  function displayAspect() {
    const v = streamsOf(part, 1)[0];
    const par = v && v.pixelAspectRatio && String(v.pixelAspectRatio).split(':').map(Number);
    if (!v || !v.width || !v.height || !par || !par[0] || !par[1] || par[0] === par[1]) return 0;
    return v.width * par[0] / par[1] / v.height;
  }

  // Map Plex's chosen streams onto AVPlay's track list (same file order).
  function applyTracks() {
    const t = player.tracks();
    if (audioStream && t.audio.length > 1) {
      const pos = streamsOf(part, 2).indexOf(audioStream);
      if (pos >= 0 && t.audio[pos] != null) player.selectAudio(t.audio[pos]);
    }
    if (isEmbeddedText(subStream)) {
      const pos = streamsOf(part, 3).filter(isEmbeddedText).indexOf(subStream);
      if (pos >= 0 && t.text[pos] != null) player.selectText(t.text[pos]);
    } else {
      player.selectText(null);
      setText(subsText, '');
    }
  }

  // Start/stop drawing an external subtitle file for the current selection.
  function syncSidecar() {
    if (!isSidecarText(subStream)) {
      cueTrack = null;
      cueFor = null;
      clearInterval(cueTimer);
      if (!isEmbeddedText(subStream)) setText(subsText, '');
      return;
    }
    if (cueFor === subStream) return;
    cueFor = subStream;
    const stream = subStream;
    cueTrack = null;
    fetch(session.server.url(stream.key, { encoding: 'utf-8' }))
      .then(r => r.text())
      .then(text => {
        if (cueFor !== stream || !alive) return;
        cueTrack = new CueTrack(parseSubtitles(text, stream.codec));
        log('subtitles loaded', stream.displayTitle, cueTrack.cues.length + ' cues');
      })
      .catch(e => warn('subtitle fetch failed', e.message));
    clearInterval(cueTimer);
    cueTimer = setInterval(() => {
      if (cueTrack && started) setText(subsText, cueTrack.at(base + player.time() - subDelay));
    }, 120);
  }

  async function start() {
    try {
      const full = await session.server.metadata(item.ratingKey, { markers: true });
      if (!alive) return;
      item = full;
      markers = (item.Marker || []).filter(m => m.type === 'intro' || m.type === 'credits');
      duration = item.duration || duration;
      media = (item.Media || [])[0];
      part = media && media.Part && media.Part[0];
      if (!part) throw new Error('No playable media');
      const audios = streamsOf(part, 2);
      audioStream = audios.find(s => s.selected) || audios[0] || null;
      subStream = streamsOf(part, 3).find(s => s.selected) || null;
      subDelay = store.get('subDelay:' + part.id, 0);
      renderTitles();
      mode = decideMode();
      if (offset == null) offset = item.viewOffset || 0;
      position = offset;
      renderProgress(position);
      showOsd();
      await open(offset);
    } catch (e) {
      failed(e.message || String(e));
    }
  }

  function failed(msg) {
    if (!alive) return;
    if (mode === 'direct' && !triedFallback && media) {
      // The file looked direct-playable but the TV choked: let Plex convert it.
      warn('direct play failed (' + msg + '), falling back to HLS');
      triedFallback = true;
      mode = 'hls';
      open(position).catch(e => failed(e.message));
      return;
    }
    error('playback failed', msg);
    toggleClass(spinner, 'on', false);
    errorEl.classList.remove('hidden');
    setText(errorEl, 'Playback failed: ' + msg);
  }

  // --- Controls ---------------------------------------------------------

  function togglePause() {
    if (!started) return;
    if (paused) {
      player.play();
      paused = false;
      showOsd();
    } else {
      player.pause();
      paused = true;
      showOsd(true);
    }
    toggleClass(el, 'paused', paused);
    report(paused ? 'paused' : 'playing');
  }

  function seekBy(dir) {
    if (!started) return;
    const now = Date.now();
    seekCount = now - lastSeekAt < 700 ? seekCount + 1 : 0;
    lastSeekAt = now;
    const step = seekCount < 3 ? 10000 : seekCount < 8 ? 30000 : seekCount < 16 ? 60000 : 180000;
    const from = seekTarget == null ? position : seekTarget;
    seekTarget = Math.max(0, Math.min(duration - 3000, from + dir * step));
    toggleClass(el, 'seeking', true);
    setText(seekLabel, clock(seekTarget, long()));
    renderProgress(seekTarget);
    showOsd(true);
    clearTimeout(seekTimer);
    seekTimer = setTimeout(commitSeek, SEEK_COMMIT_MS);
  }

  // The −30/−15/+15/+30 controls: same deferred commit as arrow seeking, so
  // repeated presses add up before the (slow) seek happens.
  function jumpBy(ms) {
    if (!started) return;
    const from = seekTarget == null ? position : seekTarget;
    seekTarget = Math.max(0, Math.min(duration - 3000, from + ms));
    toggleClass(el, 'seeking', true);
    setText(seekLabel, clock(seekTarget, long()));
    renderProgress(seekTarget);
    showOsd(true);
    clearTimeout(seekTimer);
    seekTimer = setTimeout(commitSeek, SEEK_COMMIT_MS);
  }

  async function commitSeek() {
    clearTimeout(seekTimer);
    if (seekTarget == null) return;
    const target = seekTarget;
    seekTarget = null;
    toggleClass(el, 'seeking', false);
    showOsd();
    position = target;
    try {
      if (mode === 'direct') {
        toggleClass(spinner, 'on', true);
        await player.seek(target);
        toggleClass(spinner, 'on', false);
        if (paused) togglePause();
      } else {
        await open(target);
      }
    } catch (e) {
      warn('seek failed, reopening', e.message);
      open(target).catch(err => failed(err.message));
    }
  }

  // --- Skip intro / credits ---------------------------------------------

  function updateSkip(ms) {
    const m = markers.find(x => !x.dismissed && ms >= x.startTimeOffset && ms < x.endTimeOffset - 1000) || null;
    if (m === skipFor) return;
    skipFor = m;
    toggleClass(skipBtn, 'hidden', !m);
    if (m) setText(skipBtn, m.type === 'credits' ? 'Skip Credits' : 'Skip Intro');
  }

  function skip() {
    const m = skipFor;
    m.dismissed = true;
    updateSkip(position);
    // Credits that run to the end: go straight to up-next.
    if (m.type === 'credits' && (item.type === 'episode' || queue.length) && m.endTimeOffset >= duration - 5000) {
      finished();
      return;
    }
    seekTarget = Math.min(m.endTimeOffset, duration - 3000);
    commitSeek();
  }

  // --- Audio / subtitle picker ------------------------------------------
  // Two columns: audio and subtitles, or in search mode language and results.

  let panelMode = 'tracks';
  let panelCol = 0;
  let panelIndex = [0, 0];
  let panelLists = [[], []];
  let panelHeads = [];
  let searchToken = 0;

  function openPanel() {
    const audios = streamsOf(part, 2);
    const texts = streamsOf(part, 3);
    panelMode = 'tracks';
    searchToken++;
    panelHeads = [{ name: 'Audio', icon: icons.audio }, { name: 'Subtitles', icon: icons.subtitles }, { name: 'Options', icon: icons.gear }];
    panelLists = [
      audios.map(s => ({ label: s.displayTitle || s.language || 'Track', stream: s, on: s === audioStream })),
      [{ label: 'Off', stream: null, on: !subStream }]
        .concat(texts.map(s => ({ label: subtitleLabel(s), stream: s, on: s === subStream })))
        .concat([{ label: 'Search subtitles…', search: true }]),
      optionRows(),
    ];
    panelIndex = panelLists.map(l => Math.max(0, l.findIndex(x => x.on)));
    panelCol = 0;
    renderPanel();
    panel.classList.remove('hidden');
    hideOsd();
  }

  // Third column: speed, subtitle look and sync. OK changes the value in place
  // (the panel stays open so the effect is visible).
  function optionRows() {
    const cycle = (key, list) => () => {
      subStyle[key] = (subStyle[key] + 1) % list.length;
      store.set('subStyle', subStyle);
      applySubStyle();
    };
    return [
      { label: 'Speed   ' + speed + '×', act: () => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]) },
      { label: 'Size   ' + SUB_SIZES[subStyle.size][0], act: cycle('size', SUB_SIZES) },
      { label: 'Colour   ' + SUB_COLOURS[subStyle.colour][0], act: cycle('colour', SUB_COLOURS) },
      { label: 'Position   ' + SUB_POSITIONS[subStyle.position][0], act: cycle('position', SUB_POSITIONS) },
      { label: 'Style   ' + SUB_BACKS[subStyle.back], act: cycle('back', SUB_BACKS) },
      { label: 'Sync   ' + syncLabel() + (subDelay ? '  (OK resets)' : ''), act: () => setDelay(0) },
      { label: 'Subtitles earlier', act: () => setDelay(subDelay - SYNC_STEP) },
      { label: 'Subtitles later', act: () => setDelay(subDelay + SYNC_STEP) },
    ];
  }

  function closePanel() {
    searchToken++;
    panel.classList.add('hidden');
  }

  // The TV's language and English first, then the file's languages, then the rest.
  function searchLanguages() {
    const names = Object.assign({}, LANGUAGES);
    const codes = [(navigator.language || '').slice(0, 2), 'en'];
    streamsOf(part, 2).concat(streamsOf(part, 3)).forEach(s => {
      const c = (s.languageTag || '').slice(0, 2);
      if (!c) return;
      codes.push(c);
      if (!names[c] && s.language) names[c] = s.language;
    });
    codes.push.apply(codes, Object.keys(LANGUAGES));
    return codes.filter((c, i) => c && names[c] && codes.indexOf(c) === i).map(c => ({ code: c, name: names[c] }));
  }

  function openSearch() {
    panelMode = 'search';
    panelHeads = [{ name: 'Language', icon: icons.subtitles }, { name: 'Download', icon: icons.search }];
    panelLists = [searchLanguages().map(l => ({ label: l.name, lang: l.code })), [{ label: 'Choose a language', status: true }]];
    panelIndex = [0, 0];
    panelCol = 0;
    renderPanel();
  }

  async function runSearch(opt) {
    const token = ++searchToken;
    panelLists[0].forEach(o => { o.on = o === opt; });
    panelLists[1] = [{ label: 'Searching…', status: true }];
    panelIndex[1] = 0;
    renderPanel();
    let results = null;
    try {
      results = await session.server.searchSubtitles(item.ratingKey, opt.lang);
    } catch (e) {
      warn('subtitle search failed', e.message);
    }
    if (token !== searchToken) return;
    panelLists[1] = !results ? [{ label: 'Search failed', status: true }]
      : !results.length ? [{ label: 'Nothing found', status: true }]
      : results.map(r => ({ label: (r.hearingImpaired ? '[SDH]  ' : '') + (r.title || r.displayTitle), result: r }));
    if (results && results.length) panelCol = 1;
    renderPanel();
  }

  // The server downloads the file and adds it to the part as an external
  // stream; reload the metadata until it shows up, then select it.
  async function download(opt) {
    const token = ++searchToken;
    const server = session.server;
    const before = streamsOf(part, 3).map(s => s.id);
    setText(panel.querySelector('.tracks-opt.focus'), 'Downloading…');
    try {
      await server.downloadSubtitle(item.ratingKey, opt.result);
      let added = null;
      for (let i = 0; i < 6 && !added; i++) {
        if (i) await new Promise(r => setTimeout(r, 1000));
        const full = await server.metadata(item.ratingKey, { markers: true });
        const fresh = [].concat.apply([], (full.Media || []).map(m => m.Part || [])).find(p => p.id === part.id);
        added = fresh && streamsOf(fresh, 3).find(s => before.indexOf(s.id) === -1);
        if (added) adoptPart(full, fresh);
      }
      if (token !== searchToken || !alive) return;
      if (!added) throw new Error('the new subtitle never appeared');
      log('subtitle downloaded', added.displayTitle, added.title || '');
      choose(1, { stream: added });
    } catch (e) {
      warn('subtitle download failed', e.message);
      if (token !== searchToken) return;
      panelLists[1] = [{ label: 'Download failed', status: true }];
      panelIndex[1] = 0;
      renderPanel();
    }
  }

  // Swap in reloaded metadata, keeping the current stream choices.
  function adoptPart(full, fresh) {
    const same = (list, s) => (s && list.find(x => x.id === s.id)) || s;
    item = full;
    media = (full.Media || []).find(m => (m.Part || []).indexOf(fresh) !== -1) || media;
    part = fresh;
    audioStream = same(streamsOf(part, 2), audioStream);
    subStream = same(streamsOf(part, 3), subStream);
  }

  function renderPanel() {
    panel.innerHTML = '';
    toggleClass(panel, 'searching', panelMode === 'search');
    toggleClass(panel, 'three', panelLists.length === 3);
    panelHeads.forEach((head, c) => {
      const col = h('div', 'tracks-col', panel);
      const headEl = h('div', 'tracks-head', col);
      headEl.innerHTML = head.icon;
      h('span', '', headEl).textContent = head.name;
      // Long lists scroll: show a window of rows around the focused one.
      const list = panelLists[c];
      const first = Math.max(0, Math.min(panelIndex[c] - (PANEL_ROWS >> 1), list.length - PANEL_ROWS));
      list.slice(first, first + PANEL_ROWS).forEach((opt, j) => {
        const i = first + j;
        const row = h('div', 'tracks-opt', col);
        row.textContent = opt.label;
        toggleClass(row, 'on', !!opt.on);
        toggleClass(row, 'status', !!opt.status);
        toggleClass(row, 'focus', c === panelCol && i === panelIndex[c]);
      });
    });
  }

  async function choose(col, opt) {
    const server = session.server;
    if (col === 0) audioStream = opt.stream;
    else subStream = opt.stream;
    server.selectStreams(part.id, {
      audioStreamID: audioStream ? audioStream.id : undefined,
      subtitleStreamID: subStream ? subStream.id : 0,
    });
    closePanel();
    const wanted = decideMode();
    if (wanted === 'direct' && mode === 'direct') {
      applyTracks();
      syncSidecar();
    } else if (mode === 'hls' && wanted === 'hls' && col === 1 && isSidecarText(subStream)) {
      syncSidecar();
    } else {
      mode = wanted;
      triedFallback = false;
      await open(position).catch(e => failed(e.message));
    }
  }

  function panelKey(action) {
    if (action === 'back') {
      if (panelMode === 'search') openPanel();
      else closePanel();
      return true;
    }
    if (action === 'up' && panelIndex[panelCol] === 0) {
      if (panelMode === 'tracks') closePanel();
      return true;
    }
    if (action === 'left' || action === 'right') {
      panelCol = Math.max(0, Math.min(panelLists.length - 1, panelCol + (action === 'left' ? -1 : 1)));
    }
    if (action === 'up') panelIndex[panelCol]--;
    if (action === 'down') panelIndex[panelCol] = Math.min(panelLists[panelCol].length - 1, panelIndex[panelCol] + 1);
    if (action === 'enter') {
      const opt = panelLists[panelCol][panelIndex[panelCol]];
      if (!opt || opt.status) return true;
      if (opt.act) {
        opt.act();
        panelLists[2] = optionRows();
        renderPanel();
        return true;
      }
      if (opt.search) openSearch();
      else if (opt.lang) runSearch(opt);
      else if (opt.result) download(opt);
      else choose(panelCol, opt);
      return true;
    }
    renderPanel();
    return true;
  }

  // --- Ending -----------------------------------------------------------

  async function nextEpisode() {
    const server = session.server;
    const eps = await server.children(item.parentRatingKey);
    const i = eps.findIndex(e => e.ratingKey === item.ratingKey);
    if (i >= 0 && i < eps.length - 1) return eps[i + 1];
    const seasons = (await server.children(item.grandparentRatingKey)).filter(s => s.type === 'season');
    const si = seasons.findIndex(s => s.ratingKey === item.parentRatingKey);
    if (si >= 0 && si < seasons.length - 1) return (await server.children(seasons[si + 1].ratingKey))[0] || null;
    return null;
  }

  async function finished() {
    position = duration;
    report('stopped');
    clearInterval(timelineTimer);
    player.close();
    if (queue.length) nextItem = queue[0];
    else if (item.type !== 'episode') { exit(); return; }
    else try { nextItem = await nextEpisode(); } catch (e) { nextItem = null; }
    if (!alive) return;
    if (!nextItem) { exit(); return; }
    let left = 10;
    upnext.classList.remove('hidden');
    const render = () => {
      upnext.innerHTML = '';
      h('div', 'upnext-label', upnext).textContent = 'Up next in ' + left;
      h('div', 'upnext-title', upnext).textContent = [episodeLabel(nextItem), nextItem.title].filter(Boolean).join('   ');
      h('div', 'upnext-hint', upnext).textContent = 'OK to play now · Back to stop';
    };
    render();
    upnextTimer = setInterval(() => {
      left--;
      if (left <= 0) playNext();
      else render();
    }, 1000);
  }

  function playNext() {
    clearInterval(upnextTimer);
    router.replace(PlayerScreen(nextItem, { offset: queue.length ? null : 0, queue: queue.slice(1) }));
  }

  function exit() {
    router.back();
  }

  function teardown() {
    if (!alive) return;
    alive = false;
    if (started && position < duration) report('stopped');
    [seekTimer, osdTimer, subTimer, speedTimer].forEach(clearTimeout);
    clearInterval(timelineTimer);
    clearInterval(upnextTimer);
    clearInterval(cueTimer);
    player.destroy();
    if (mode === 'hls') session.server.stopTranscode(playSession);
    document.documentElement.classList.remove('playing');
    setScreenSaver(true);
    document.removeEventListener('visibilitychange', onVisibility);
  }

  function onVisibility() {
    if (document.hidden) {
      if (started && !paused) togglePause();
      player.suspend();
    } else {
      player.restore();
    }
  }

  return {
    el,
    name: 'player',
    onShow() {
      document.documentElement.classList.add('playing');
      setScreenSaver(false);
      document.addEventListener('visibilitychange', onVisibility);
      renderTitles();
      if (!started) start();
    },
    onKey(action) {
      if (!upnext.classList.contains('hidden')) {
        if (action === 'enter') { playNext(); return true; }
        if (action === 'back' || action === 'stop') { exit(); return true; }
        return true;
      }
      if (!panel.classList.contains('hidden')) return panelKey(action);
      if (ctlIndex >= 0 && el.classList.contains('osd-on')) {
        if (action === 'left' || action === 'right') {
          ctlIndex = Math.max(0, Math.min(JUMPS.length - 1, ctlIndex + (action === 'left' ? -1 : 1)));
          showOsd(paused);
          return true;
        }
        if (action === 'enter') {
          if (JUMPS[ctlIndex]) jumpBy(JUMPS[ctlIndex]);
          else togglePause();
          return true;
        }
        if (action === 'down' || action === 'back' || action === 'up') {
          ctlIndex = -1;
          showOsd(paused);
          return true;
        }
      }
      if (skipFor && seekTarget == null) {
        if (action === 'enter') { skip(); return true; }
        if (action === 'back' && !el.classList.contains('osd-on')) {
          skipFor.dismissed = true;
          updateSkip(position);
          return true;
        }
      }
      switch (action) {
        case 'enter':
          if (seekTarget != null) commitSeek();
          else if (el.classList.contains('osd-on') || paused) togglePause();
          else showOsd();
          return true;
        case 'playpause': if (seekTarget != null) commitSeek(); else togglePause(); return true;
        case 'play': if (paused) togglePause(); return true;
        case 'pause': if (!paused) togglePause(); return true;
        case 'left': case 'rw': seekBy(-1); return true;
        case 'right': case 'ff': seekBy(1); return true;
        case 'up':
          // First press shows the OSD, a second moves focus to the controls.
          if (el.classList.contains('osd-on') && seekTarget == null) ctlIndex = 2;
          showOsd(paused);
          return true;
        case 'info': showOsd(); return true;
        case 'down': if (part) openPanel(); return true;
        case 'stop': exit(); return true;
        case 'back':
          if (seekTarget != null) { seekTarget = null; toggleClass(el, 'seeking', false); renderProgress(position); showOsd(); return true; }
          if (el.classList.contains('osd-on') && !paused) { hideOsd(); return true; }
          exit();
          return true;
      }
      return true;
    },
    onHide() {},
    destroy: teardown,
  };
}
