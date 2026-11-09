// Which sites agents may use: a list for every thread, plus one per thread,
// in allow.json. With no list for a thread at all, it may go anywhere (as
// before this existed). Otherwise open, goto and claim refuse other sites, and
// a tab an action took somewhere else is sent back.
//
// It's a guardrail against an agent wandering, not a sandbox: anything on this
// Mac that can reach BrowserBear's socket could change the file. Only the user
// changes it (the toolbar button in Chrome, or `browserbear allow` outside an
// agent's thread); agents can only read it.
//
// Patterns are hosts: `example.com` is that host only, `*.example.com` is its
// subdomains and itself, `localhost:5173` is one port. A bare host is any port.
import fs from 'node:fs';

const ALWAYS = new Set(['about:blank', 'about:srcdoc']);

export function hostOf(url) {
  try {
    const u = new URL(url);
    return u.hostname ? { host: u.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port: u.port, scheme: u.protocol } : null;
  } catch {
    return null;
  }
}

// What to put on the list for a URL's site.
export function siteOf(url) {
  const h = hostOf(url);
  return h && /^https?:$/.test(h.scheme) ? h.host : null;
}

export function normalise(pattern) {
  let p = String(pattern).trim().toLowerCase();
  if (!p) return null;
  // A pasted URL counts as its host (and port, if it had one).
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(p)) {
    try {
      const u = new URL(p);
      p = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    } catch {
      return null;
    }
  }
  p = p.replace(/\/.*$/, '').replace(/^\[|\](?=(:\d+)?$)/g, '');
  return /^(\*\.)?[a-z0-9.:_-]+$/.test(p) ? p : null;
}

export function matches(pattern, url) {
  if (ALWAYS.has(url)) return true;
  const h = hostOf(url);
  if (!h || !/^https?:$/.test(h.scheme)) return false;
  // ::1 has colons of its own, so only a pattern ending in :digits after a
  // host without colons has a port.
  const m = /^(.*[^:]):(\d+)$/.exec(pattern);
  const [host, port] = m && !m[1].includes(':') ? [m[1], m[2]] : [pattern, null];
  if (port && port !== (h.port || (h.scheme === 'https:' ? '443' : '80'))) return false;
  if (host.startsWith('*.')) {
    const base = host.slice(2);
    return h.host === base || h.host.endsWith(`.${base}`);
  }
  return h.host === host;
}

export function createAllow(file) {
  const load = () => {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { all: Array.isArray(d.all) ? d.all : [], threads: d.threads && typeof d.threads === 'object' ? d.threads : {} };
    } catch {
      return { all: [], threads: {} };
    }
  };
  const save = (d) => {
    // Threads with nothing left don't need a key.
    for (const [k, v] of Object.entries(d.threads)) if (!v.length) delete d.threads[k];
    fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n', { mode: 0o600 });
  };

  const listFor = (thread) => {
    const d = load();
    return [...new Set([...d.all, ...((thread && d.threads[thread]) || [])])];
  };

  return {
    listFor,
    // null when the URL may be used; otherwise the list it isn't on.
    check(url, thread) {
      const list = listFor(thread);
      if (!list.length || list.some((p) => matches(p, url))) return null;
      return list;
    },
    restricted: (thread) => listFor(thread).length > 0,
    add(patterns, thread) {
      const d = load();
      const bad = patterns.filter((p) => !normalise(p));
      if (bad.length) throw new Error(`not a site: ${bad.join(', ')} (give a host like example.com, *.example.com or localhost:5173)`);
      const target = thread ? (d.threads[thread] ||= []) : d.all;
      for (const p of patterns.map(normalise)) if (!target.includes(p)) target.push(p);
      save(d);
      return listFor(thread);
    },
    remove(patterns, thread) {
      const d = load();
      const drop = new Set(patterns.map(normalise));
      if (thread) d.threads[thread] = (d.threads[thread] || []).filter((p) => !drop.has(p));
      else d.all = d.all.filter((p) => !drop.has(p));
      save(d);
      return listFor(thread);
    },
    clear(thread) {
      const d = load();
      if (thread) delete d.threads[thread];
      else d.all = [];
      save(d);
    },
    raw: load,
  };
}
