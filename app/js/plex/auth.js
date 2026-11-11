// plex.tv sign-in (PIN / plex.tv/link) and server discovery.
import { request, clientId, query } from './client.js';
import { log, warn } from '../util/log.js';

const TV = 'https://plex.tv/api/v2';

export async function createPin() {
  // Non-strong PINs are the 4-character codes plex.tv/link accepts.
  return request(TV + '/pins', { method: 'POST', params: { strong: 'false' } });
}

export async function checkPin(id) {
  const pin = await request(TV + '/pins/' + id);
  return pin.authToken || null;
}

// Link that signs this device in from a phone, encoded in the login QR code.
// No context[device][product]: app.plex.tv sends it as X-Plex-Product on PUT /pins/link,
// and plex.tv answers 403 ("We were unable to complete this request") for anything but Plex Web.
export function authAppUrl(code) {
  return 'https://app.plex.tv/auth#?' + query({
    clientID: clientId,
    code,
  });
}

export async function getUser(token) {
  return request(TV + '/user', { token });
}

export async function getServers(token) {
  const resources = await request(TV + '/resources', {
    token, params: { includeHttps: 1, includeRelay: 1, includeIPv6: 0 },
  });
  return resources.filter(r => (r.provides || '').indexOf('server') !== -1);
}

function probe(uri, token, timeout) {
  const started = Date.now();
  return request(uri + '/identity', { token, timeout }).then(() => ({ uri, ms: Date.now() - started }));
}

// Plain HTTP on the LAN is the fastest path on a TV CPU (no TLS), so try that
// first, then the plex.direct HTTPS URLs, then remote, then relay.
export function candidateUris(resource) {
  const conns = resource.connections || [];
  const local = conns.filter(c => c.local && !c.relay);
  const remote = conns.filter(c => !c.local && !c.relay);
  const relay = conns.filter(c => c.relay);
  const tiers = [];
  if (resource.httpsRequired !== true) {
    tiers.push(local.map(c => 'http://' + c.address + ':' + c.port));
  }
  tiers.push(local.map(c => c.uri));
  tiers.push(remote.map(c => c.uri));
  tiers.push(relay.map(c => c.uri));
  return tiers.filter(t => t.length);
}

function firstSuccess(promises) {
  return new Promise((resolve, reject) => {
    let pending = promises.length;
    if (!pending) reject(new Error('no candidates'));
    promises.forEach(p => p.then(resolve, () => { if (--pending === 0) reject(new Error('all failed')); }));
  });
}

export async function connect(resource) {
  const token = resource.accessToken;
  for (const tier of candidateUris(resource)) {
    try {
      const hit = await firstSuccess(tier.map(uri => probe(uri, token, 4000)));
      log('connected to', resource.name, 'via', hit.uri, hit.ms + 'ms');
      return hit.uri;
    } catch (e) {
      warn('connection tier failed', tier.join(', '));
    }
  }
  throw new Error('Could not reach ' + resource.name);
}
