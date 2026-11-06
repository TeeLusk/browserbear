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
      // Only op's own [ERROR] line, never its stdout, which can hold values.
      const said = (String(stderr || '').match(/\[ERROR\][^\n]*/) || [])[0]?.replace(/^\[ERROR\]\s*(\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\s*)?/, '').slice(0, 200) || 'it failed (no reason given)';
      reject(new Error(e.killed ? `1Password didn't answer within ${OP_WAIT_MS / 1000} s (the Touch ID prompt may have gone unanswered)` : `1Password said: ${said}`));
    });
  });
}

const urlOf = (href) => {
  try {
    return new URL(href);
  } catch {
    return null;
  }
};
const hostOf = (href) => urlOf(href)?.hostname.replace(/^www\./, '').toLowerCase() || '';

// Hosts where anyone can have a subdomain: a login saved for one of these
// only goes to that exact host, never to a sibling or child.
const SHARED_HOSTS = ['github.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com', 'firebaseapp.com', 'web.app', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'blogspot.com', 'glitch.me', 'onrender.com', 'fly.dev', 'ngrok-free.app', 'ngrok.io', 'convex.site', 'convex.cloud', 'repl.co', 'replit.app', 'surge.sh', 'wordpress.com', 'tumblr.com', 'myshopify.com'];
const shared = (host) => SHARED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

// The page's host is the login's, or a subdomain of it (accounts.google.com
// for a login saved for google.com), and never the other way: a login saved
// for login.example.com doesn't go to example.com. Not on shared hosting,
// where a subdomain is someone else's (Codex review, 6 Nov).
export function sameSite(pageHost, itemHost) {
  if (!pageHost || !itemHost) return false;
  if (pageHost === itemHost) return true;
  return !shared(itemHost) && pageHost.endsWith(`.${itemHost}`);
}

// Only over HTTPS (or this Mac), whatever the login was saved with.
const secure = (u) => u && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)));

// A port has to match too: example.com:8443 can be someone else's service.
const portOf = (u) => u?.port || '';

/** Whether this login may go to the page at href. */
export function loginMatches(login, href) {
  const page = urlOf(href);
  return Boolean(secure(page)) && login.sites.some((s) => sameSite(hostOf(href), s.host) && portOf(page) === s.port);
}

/** The same rule, as data for the check fill runs inside the page. */
export function allowedFor(login) {
  return login.sites.map((s) => ({ host: s.host, sub: !shared(s.host), port: s.port }));
}

// op's JSON can hold secrets, so a parse error mustn't quote it.
function parsed(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`1Password's answer for ${what} wasn't readable`);
  }
}

/** The logins saved for the page's site, as { id, title, vault, sites: [{ host, port }] }. */
export async function loginsFor(pageUrl) {
  if (!secure(urlOf(pageUrl))) throw new Error(`fill only signs in on https pages, not ${String(pageUrl).slice(0, 100)}`);
  const items = parsed(await op(['item', 'list', '--categories', 'Login', '--format', 'json']), 'the list of logins');
  return items
    .map((it) => ({
      id: it.id,
      title: it.title,
      vault: it.vault?.name || '',
      sites: (it.urls || []).map((u) => ({ host: hostOf(u.href), port: portOf(urlOf(u.href)) })).filter((x) => x.host),
    }))
    .filter((l) => loginMatches(l, pageUrl));
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
  const item = parsed(await op(['item', 'get', id, '--reveal', '--format', 'json']), 'that login');
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
