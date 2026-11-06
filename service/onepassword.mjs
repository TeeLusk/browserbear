// Sign-ins from 1Password, for `browserbear fill`. The service asks the
// 1Password CLI (`op`, with the 1Password app's CLI integration, so Mike
// approves with Touch ID) for a login and types it into the agent's page
// itself. The values never go back to the agent: only which login was used
// and which fields were filled. Mike's agent-only trial, 6 Nov 2026.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Chrome starts the service without the user's PATH.
export function opPath() {
  const candidates = [process.env.BROWSERBEAR_OP, path.join(os.homedir(), '.local', 'bin', 'op'), '/usr/local/bin/op', '/opt/homebrew/bin/op'];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

// Long enough for Mike to see the Touch ID prompt and answer it.
const OP_WAIT_MS = Number(process.env.BROWSERBEAR_OP_WAIT_MS) || 120_000;

function op(args) {
  const bin = opPath();
  if (!bin) return Promise.reject(new Error("the 1Password CLI isn't installed (op in ~/.local/bin or /usr/local/bin), so fill can't sign in. Hand the page to the user instead: browserbear handoff <tab> --wait"));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: OP_WAIT_MS, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (!e) return resolve(stdout);
      // op's own message says what went wrong (locked, dismissed, no item);
      // it never holds a secret.
      const said = String(stderr || '').trim().split('\n').pop() || e.message;
      reject(new Error(e.killed ? `1Password didn't answer within ${OP_WAIT_MS / 1000} s (the Touch ID prompt may have gone unanswered)` : `1Password said: ${said}`));
    });
  });
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
};

// accounts.google.com matches a login saved for google.com, and the other way.
export function sameSite(pageHost, itemHost) {
  if (!pageHost || !itemHost) return false;
  return pageHost === itemHost || pageHost.endsWith(`.${itemHost}`) || itemHost.endsWith(`.${pageHost}`);
}

/** The logins saved for the page's site, as { id, title, vault }. */
export async function loginsFor(pageUrl) {
  const page = hostOf(pageUrl);
  const items = JSON.parse(await op(['item', 'list', '--categories', 'Login', '--format', 'json']));
  return items
    .filter((it) => (it.urls || []).some((u) => sameSite(page, hostOf(u.href))))
    .map((it) => ({ id: it.id, title: it.title, vault: it.vault?.name || '' }));
}

/** Pick one login: by title or id when given, else the only one. */
export function pickLogin(logins, want, pageUrl) {
  const site = hostOf(pageUrl) || pageUrl;
  if (want) {
    const w = want.toLowerCase();
    const hits = logins.filter((l) => l.id === want || l.title.toLowerCase() === w);
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new Error(`no 1Password login for ${site} is called "${want}"; there's ${listed(logins)}`);
    throw new Error(`several 1Password logins for ${site} are called "${want}"; use the id: ${listed(hits)}`);
  }
  if (logins.length === 1) return logins[0];
  if (!logins.length) throw new Error(`1Password has no login saved for ${site}. Hand the page to the user instead: browserbear handoff <tab> --wait`);
  throw new Error(`1Password has ${logins.length} logins for ${site}; say which with --item "<title or id>": ${listed(logins)}`);
}

const listed = (logins) => logins.map((l) => `"${l.title}" (${l.id}${l.vault ? `, ${l.vault}` : ''})`).join(', ') || 'none';

/** The login's username and password, and its one-time code when asked and it has one. */
export async function secretsFor(id, { otp = false } = {}) {
  const item = JSON.parse(await op(['item', 'get', id, '--reveal', '--format', 'json']));
  const fields = item.fields || [];
  const by = (purpose) => fields.find((f) => f.purpose === purpose)?.value || '';
  const hasOtp = fields.some((f) => f.type === 'OTP');
  return {
    username: by('USERNAME'),
    password: by('PASSWORD'),
    hasOtp,
    otp: otp && hasOtp ? (await op(['item', 'get', id, '--otp'])).trim() : '',
  };
}
