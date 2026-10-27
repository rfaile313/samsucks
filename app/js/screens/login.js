// Sign in with a plex.tv/link code (or by scanning the QR code with a phone),
// then pick a server.
import qrcode from '../vendor/qrcode.js';
import { h, setText } from '../util/dom.js';
import { createPin, checkPin, authAppUrl, getUser, getServers, connect } from '../plex/auth.js';
import { signIn, useServer, session } from '../session.js';
import * as router from '../router.js';
import { error, log } from '../util/log.js';
import { useAmbience } from '../ui/backdrop.js';

export function LoginScreen({ onDone }) {
  const el = h('div', 'screen login');
  const ambience = useAmbience({ topLeft: '3a2c10', topRight: '161922', bottomLeft: '1b1f2b', bottomRight: '2a1f0c' });
  const left = h('div', 'login-art', el);
  const art = h('img', '', left);
  art.src = 'img/plex-mark.png';
  const panel = h('div', 'login-panel', el);
  h('h1', 'login-title', panel).textContent = 'Sign in to Plex';
  const steps = h('ol', 'login-steps', panel);
  h('li', '', steps).innerHTML = 'On your phone or computer, go to <b>plex.tv/link</b>';
  h('li', '', steps).textContent = 'Enter this code:';
  const code = h('div', 'login-code', panel);
  const qrWrap = h('div', 'login-qr', panel);
  const qrBox = h('div', 'login-qr-box', qrWrap);
  h('div', 'login-qr-label', qrWrap).textContent = 'or scan to sign in';
  const status = h('div', 'login-status', panel);

  let timer = 0;
  let alive = true;
  let signedToken = null; // set once the PIN is claimed; OK then retries connecting

  async function start() {
    clearTimeout(timer);
    try {
      setText(status, '');
      const pin = await createPin();
      if (!alive) return;
      setText(code, pin.code);
      const qr = qrcode(0, 'M');
      qr.addData(authAppUrl(pin.code));
      qr.make();
      qrBox.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
      const expires = Date.now() + (pin.expiresIn || 900) * 1000 - 5000;
      const poll = async () => {
        if (!alive) return;
        if (Date.now() > expires) { start(); return; }
        let token = null;
        try {
          token = await checkPin(pin.id);
        } catch (e) {
          error('pin poll failed', e);
        }
        if (token) {
          // The PIN is used up now: stop polling, and on failure say why.
          signedToken = token;
          finish(token).catch(failed);
          return;
        }
        timer = setTimeout(poll, 2000);
      };
      timer = setTimeout(poll, 2000);
    } catch (e) {
      error('createPin failed', e);
      setText(status, 'Can\'t reach plex.tv. Retrying…');
      timer = setTimeout(start, 4000);
    }
  }

  function failed(e) {
    error('sign-in failed', e);
    setText(status, (e && e.message || 'Sign-in failed') + '. Press OK to try again.');
  }

  async function finish(token) {
    setText(status, 'Signed in. Finding your servers…');
    const user = await getUser(token);
    signIn(token, user);
    log('signed in as', session.user.title);
    const servers = await getServers(token);
    if (!servers.length) {
      setText(status, 'No Plex Media Servers on this account.');
      return;
    }
    if (servers.length === 1) {
      setText(status, 'Connecting to ' + servers[0].name + '…');
      const uri = await connect(servers[0]);
      useServer(servers[0], uri);
      onDone();
      return;
    }
    router.replace(ServerPicker({ servers, onDone }));
  }

  start();

  return {
    el,
    name: 'login',
    onShow() { ambience.restore(); },
    onKey(action) {
      if (action === 'enter') {
        if (signedToken) finish(signedToken).catch(failed);
        else start();
        return true;
      }
      return false;
    },
    destroy() {
      alive = false;
      clearTimeout(timer);
    },
  };
}

export function ServerPicker({ servers, onDone }) {
  const el = h('div', 'screen picker');
  const ambience = useAmbience();
  h('h1', 'picker-title', el).textContent = 'Choose a server';
  const list = h('div', 'picker-list', el);
  const status = h('div', 'login-status', el);
  const buttons = servers.map(s => {
    const b = h('div', 'btn btn-wide', list);
    h('span', '', b).textContent = s.name;
    h('small', '', b).textContent = s.owned ? 'Your server' : 'Shared by ' + (s.sourceTitle || 'a friend');
    return b;
  });
  let index = 0;
  const render = () => buttons.forEach((b, i) => b.classList.toggle('focus', i === index));
  render();

  return {
    el,
    name: 'picker',
    onShow() { ambience.restore(); },
    onKey(action) {
      if (action === 'up' || action === 'down') {
        index = Math.max(0, Math.min(servers.length - 1, index + (action === 'down' ? 1 : -1)));
        render();
        return true;
      }
      if (action === 'enter') {
        const s = servers[index];
        setText(status, 'Connecting to ' + s.name + '…');
        connect(s).then(uri => { useServer(s, uri); onDone(); }, e => setText(status, e.message));
        return true;
      }
      return false;
    },
  };
}
