// Plex's Discover service (plex.tv account token): people's bios and credits
// beyond what's in the library.
import { request } from './client.js';
import { session } from '../session.js';

const DISCOVER = 'https://discover.provider.plex.tv';
let warmed = false;

// The TV takes seconds to open its first TLS connection; open it while the
// user is still looking at the cast row, not after they pick someone.
export function warm() {
  if (warmed) return;
  warmed = true;
  fetch(DISCOVER + '/identity').catch(() => {});
}

export async function person(id) {
  const json = await request(DISCOVER + '/library/people/' + id, { token: session.token });
  return ((json.MediaContainer || {}).Metadata || [])[0] || null;
}

// [{ type: 'actor' | 'director' | 'appeared' | ..., title, Credit: [{ role, Metadata }] }]
export async function credits(id) {
  const json = await request(DISCOVER + '/library/people/' + id + '/credits', { token: session.token });
  return (json.MediaContainer || {}).CreditGroup || [];
}
