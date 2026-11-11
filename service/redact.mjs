// Blanks secrets in a HAR before it's written (har.mjs), unless `--raw`.
// Borrowed from opencode Browse's network capture (anomalyco/browse,
// cli/src/network-capture), 11 Nov: a header list alone left access tokens in
// query strings, OAuth callbacks' fragments, JSON responses and posted
// passwords.
//
//   - Auth and cookie headers, and any header named like a secret
//     ("x-goog-api-key"), but not CORS ones ("access-control-allow-credentials").
//   - URL query and fragment parameters named like secrets, plus ?key= and ?code=,
//     in the URL, queryString, Referer, Location and :path.
//   - URL path segments that look like tokens (a JWT, long hex, long mixed base64).
//   - String values of JSON and form fields named like secrets, in request and
//     response bodies.
//   - Then every value blanked above that's long enough to be a credential
//     (16+ characters), wherever else it turns up (a "next" link, an echoed
//     token), and whatever was typed into a password or one-time-code field
//     while recording (`type`, `fill`), whatever its length.

export const REDACTED = 'REDACTED';
const KNOWN_MIN = 16; // shorter found values would hit ordinary text
const TYPED_MIN = 4;

const SECRET_WORDS = new Set([
  'password', 'passwd', 'pwd', 'passcode', 'passphrase', 'secret', 'token', 'jwt', 'otp', 'totp',
  'cookie', 'csrf', 'xsrf', 'credential', 'credentials', 'signature', 'auth', 'authorization',
  'bearer', 'sid', 'sessionid', 'session', 'apikey', 'cvv', 'cvc', 'ssn',
]);
// "token_type": "Bearer" and "expires_at" describe a secret; they aren't one.
const ABOUT = new Set(['type', 'url', 'uri', 'endpoint', 'expires', 'expiry', 'expiration', 'at', 'in', 'length', 'count', 'used', 'limit', 'hint', 'policy', 'name', 'label', 'required', 'enabled', 'method', 'field']);
const KEYISH = /(api|access|private|secret|signing|client|session|master|encryption|license)key/;
// Query parameters too short or plain to name a secret anywhere else.
const QUERY_SECRETS = new Set(['key', 'code', 'sig', 'ticket', 'nonce']);
const SECRET_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;

const words = (name) =>
  String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

export function secretName(name) {
  const w = words(name);
  if (!w.length || ABOUT.has(w[w.length - 1])) return false;
  return w.some((x) => SECRET_WORDS.has(x)) || KEYISH.test(w.join(''));
}

const secretHeader = (name) => !/^access-control-/i.test(name) && (SECRET_HEADERS.test(name) || secretName(name.replace(/^:/, '')));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function tokenLike(segment) {
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {}
  if (s.length < 24 || UUID.test(s) || /^\d+$/.test(s)) return false;
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(s)) return true;
  if (/^[0-9a-f]{32,}$/i.test(s)) return true;
  if (!/^[A-Za-z0-9_~+/=-]+$/.test(s)) return false;
  // Slugs ("how-to-install-the-extension", "Getting-Started-2024") are words,
  // not tokens: a token mixes digits and both cases without separators.
  if (/[-_]/.test(s) && s.split(/[-_]/).every((w) => w.length < 12)) return false;
  return /\d/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);
}

export function createRedactor({ typed = [] } = {}) {
  const found = new Set();
  const keep = (v) => {
    if (typeof v === 'string' && v.length >= KNOWN_MIN && v !== REDACTED) found.add(v);
  };

  function params(text, isQuery) {
    const p = new URLSearchParams(text);
    let changed = false;
    for (const [name, value] of [...p]) {
      if (value && value !== REDACTED && (secretName(name) || (isQuery && QUERY_SECRETS.has(name.toLowerCase())))) {
        keep(value);
        p.set(name, REDACTED);
        changed = true;
      }
    }
    return changed ? p.toString() : null;
  }

  function url(raw) {
    if (typeof raw !== 'string' || !raw) return raw;
    let u;
    try {
      u = new URL(raw);
    } catch {
      return raw;
    }
    if (!/^(https?|wss?):$/.test(u.protocol)) return raw;
    const segs = u.pathname.split('/');
    const path = segs.map((s) => (tokenLike(s) ? (keep(decodeURIComponent(s)), REDACTED) : s)).join('/');
    if (path !== u.pathname) u.pathname = path;
    if (u.search) {
      const q = params(u.search.slice(1), true);
      if (q != null) u.search = q;
    }
    if (u.hash.includes('=')) {
      const h = params(u.hash.slice(1), true);
      if (h != null) u.hash = h;
    }
    return u.toString();
  }

  function headers(list) {
    return list.map((h) => {
      if (h.name === ':path') return { ...h, value: url(`https://x${h.value}`).slice('https://x'.length) };
      if (/^(referer|location|content-location)$/i.test(h.name)) return { ...h, value: url(h.value) };
      if (!secretHeader(h.name)) return h;
      const v = String(h.value);
      if (/^(set-)?cookie$/i.test(h.name)) {
        const pairs = /^set-/i.test(h.name) ? [v.split(';')[0]] : v.split(';');
        for (const pair of pairs) keep(pair.slice(pair.indexOf('=') + 1).trim());
      } else {
        keep(v);
        keep(v.split(/\s+/).pop()); // "Bearer xyz"
      }
      return { ...h, value: '(removed)' };
    });
  }

  function walk(value, secret) {
    if (typeof value === 'string') {
      if (!secret || !value) return value;
      keep(value);
      return REDACTED;
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, secret));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, secret || secretName(k))]));
    }
    return value;
  }

  // A body's text, by its type: JSON and forms have their secret fields
  // blanked; anything else only gets the known values (at the end).
  function body(text, mimeType = '') {
    if (typeof text !== 'string' || !text) return text;
    const t = text.trim();
    if (/json/i.test(mimeType) || /^[[{]/.test(t)) {
      try {
        const before = JSON.parse(t);
        const after = walk(before, false);
        return JSON.stringify(after) === JSON.stringify(before) ? text : JSON.stringify(after);
      } catch {}
    }
    if (/x-www-form-urlencoded/i.test(mimeType)) return params(text, false) ?? text;
    return text;
  }

  // Last, over the whole file: what was blanked once is blanked everywhere.
  function known(har) {
    const values = new Set();
    for (const v of typed) if (typeof v === 'string' && v.length >= TYPED_MIN) values.add(v);
    for (const v of found) values.add(v);
    const all = [];
    for (const v of values) {
      all.push(v);
      const enc = encodeURIComponent(v);
      if (enc !== v) all.push(enc);
      const json = JSON.stringify(v).slice(1, -1);
      if (json !== v) all.push(json);
    }
    all.sort((a, b) => b.length - a.length);
    if (!all.length) return har;
    const swap = (s) => {
      for (const v of all) if (s.includes(v)) s = s.split(v).join(REDACTED);
      return s;
    };
    const go = (x) => {
      if (typeof x === 'string') return swap(x);
      if (Array.isArray(x)) return x.map(go);
      if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, go(v)]));
      return x;
    };
    return go(har);
  }

  return { url, headers, body, known };
}
