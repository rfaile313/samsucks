// Account, server and diagnostics.
import { DEV, VERSION } from '../config.js';
import { h, toggleClass } from '../util/dom.js';
import { session, signOut, useServer } from '../session.js';
import { getServers, connect } from '../plex/auth.js';
import { setHud, hudEnabled } from '../ui/hud.js';
import * as router from '../router.js';
import { ServerPicker } from './login.js';
import { error } from '../util/log.js';
import { use24h } from '../util/format.js';
import * as store from '../util/store.js';
import { accentName, nextAccent, accents, setAccent, accentIndex } from '../ui/theme.js';
import { useAmbience, setLegacyGradients, legacyGradients } from '../ui/backdrop.js';

export function SettingsScreen() {
  const el = h('div', 'screen settings');
  const ambience = useAmbience();
  h('h1', 'settings-title', el).textContent = 'Settings';
  const list = h('div', 'settings-list', el);
  const foot = h('div', 'settings-foot', el);
  foot.textContent = 'Plex Fast ' + VERSION + (DEV ? ' (dev)' : '') + ' · ' + (session.server ? session.server.uri.replace(/X-Plex-Token=.*/, '') : '');

  let index = 0;
  let items = [];

  function build() {
    list.innerHTML = '';
    items = [
      { label: 'Server', value: session.server ? session.server.name : '—', run: switchServer },
      { label: 'Signed in as', value: session.user ? session.user.title : '—', run: doSignOut, action: 'Sign out' },
      // ◀▶ picks a swatch (live preview), OK cycles.
      { label: 'Accent colour', value: accentName(), swatches: accents(), run: () => { nextAccent(); build(); },
        adjust: dir => { setAccent(accentIndex() + dir); build(); } },
      { label: 'Clock', value: use24h() ? '24-hour' : '12-hour', run: () => { store.set('clock24', !use24h()); build(); } },
    ];
    if (DEV) {
      items.push(
        { label: 'Performance overlay', value: hudEnabled() ? 'On' : 'Off', run: () => { setHud(!hudEnabled()); build(); } },
        // For before/after recordings: brings back the full-screen gradients that took ~2s per repaint.
        { label: 'Demo: original slow renderer', value: legacyGradients() ? 'On' : 'Off', run: () => { setLegacyGradients(!legacyGradients()); build(); } },
      );
    }
    items.forEach(it => {
      it.el = h('div', 'setting', list);
      h('span', 'setting-label', it.el).textContent = it.label;
      const value = h('span', 'setting-value', it.el);
      h('span', '', value).textContent = it.value + (it.action ? '  ·  ' + it.action : '');
      if (it.swatches) {
        const row = h('span', 'swatches', value);
        it.swatches.forEach(sw => {
          const dot = h('i', 'swatch' + (sw.on ? ' on' : ''), row);
          dot.style.background = sw.hex;
        });
      }
    });
    render();
  }

  function render() {
    items.forEach((it, i) => toggleClass(it.el, 'focus', i === index));
  }

  async function switchServer() {
    try {
      const servers = await getServers(session.token);
      if (servers.length === 1) {
        const uri = await connect(servers[0]);
        useServer(servers[0], uri);
        restart();
        return;
      }
      router.push(ServerPicker({ servers, onDone: restart }));
    } catch (e) {
      error('server list failed', e);
    }
  }

  function doSignOut() {
    signOut();
    restart();
  }

  function restart() {
    // Rebuild from scratch: app.js decides between login and home.
    window.dispatchEvent(new Event('samsucks:restart'));
  }

  build();

  return {
    el,
    name: 'settings',
    onShow() { ambience.restore(); },
    onKey(action) {
      if (action === 'up') { index = Math.max(0, index - 1); render(); return true; }
      if (action === 'down') { index = Math.min(items.length - 1, index + 1); render(); return true; }
      if (action === 'enter') { items[index].run(); return true; }
      if ((action === 'left' || action === 'right') && items[index].adjust) {
        items[index].adjust(action === 'left' ? -1 : 1);
        return true;
      }
      return false;
    },
  };
}
