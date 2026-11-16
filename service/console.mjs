// Console capture for `browserbear console`: a tab's console messages, uncaught
// errors and Chrome's own log for it (a failed load, a blocked request), as the
// extension (or the agents' browser's host) forwards them while capturing.
// After opencode Browse's console tool.
//
// Kept to the last MAX entries, each line clipped, so a chatty page can't fill
// the service or an agent's context.

export const CONSOLE_EVENTS = new Set(['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded']);

const MAX = 500;
const CLIP = 500;

const clip = (s) => (s.length > CLIP ? `${s.slice(0, CLIP)}…` : s);

const where = (url, line) => {
  if (!url) return '';
  let name = url;
  try {
    const u = new URL(url);
    name = u.pathname.split('/').filter(Boolean).pop() || u.host;
  } catch {}
  return line != null ? ` (${name}:${line + 1})` : ` (${name})`;
};

// One of a console call's arguments, as DevTools would show it in a line.
function show(arg) {
  if (!arg) return '';
  if (arg.type === 'string') return arg.value;
  if ('unserializableValue' in arg) return arg.unserializableValue;
  if (arg.type === 'undefined') return 'undefined';
  if (arg.subtype === 'null') return 'null';
  if ('value' in arg && typeof arg.value !== 'object') return String(arg.value);
  const p = arg.preview;
  if (p?.properties && arg.subtype !== 'error') {
    const props = p.properties.map((x) => (p.subtype === 'array' ? x.value : `${x.name}: ${x.type === 'string' ? JSON.stringify(x.value) : x.value}`));
    const body = props.join(', ') + (p.overflow ? ', …' : '');
    return p.subtype === 'array' ? `[${body}]` : `{${body}}`;
  }
  return arg.description || arg.className || arg.type;
}

// An object Chrome sent without a preview (as it does for messages logged before
// capturing started) is only "Object" until the service asks the page for it.
const unseen = (arg) => arg?.objectId && !arg.preview && arg.type === 'object' && !['node', 'error', 'null', 'regexp', 'date', 'promise', 'proxy'].includes(arg.subtype);

// Run on the object itself; a string, or nothing to leave it as it was.
export const SHOW_OBJECT = `function () {
  try {
    const s = JSON.stringify(this, (k, v) => (typeof v === 'bigint' ? String(v) : v));
    return typeof s === 'string' ? s.slice(0, ${CLIP}) : undefined;
  } catch {
    return undefined;
  }
}`;

export function formatConsole(method, params) {
  if (method === 'Runtime.consoleAPICalled') {
    const level = { warning: 'warn', assert: 'error', trace: 'log', dir: 'log', table: 'log' }[params.type] || params.type;
    const top = params.stackTrace?.callFrames?.[0];
    const args = params.args || [];
    const parts = args.map(show);
    const objects = args.flatMap((a, i) => (unseen(a) ? [{ i, objectId: a.objectId }] : []));
    return { level, parts, objects, at: where(top?.url, top?.lineNumber) };
  }
  if (method === 'Runtime.exceptionThrown') {
    const d = params.exceptionDetails || {};
    const text = d.exception?.description?.split('\n')[0] || d.text || 'uncaught error';
    return { level: 'exception', parts: [text], at: where(d.url, d.lineNumber) };
  }
  if (method === 'Log.entryAdded') {
    const e = params.entry || {};
    const level = e.level === 'warning' ? 'warn' : e.level === 'verbose' ? 'debug' : e.level;
    return { level, parts: [e.text || ''], at: e.url ? ` (${e.url})` : '' };
  }
  return null;
}

export function createConsole({ tabId }) {
  const entries = [];
  let dropped = 0;
  let shown = 0; // how many of everything ever captured have been printed
  let total = 0;
  return {
    started: Date.now(),
    get count() {
      return total;
    },
    // The entry, whose parts the caller may fill in (SHOW_OBJECT).
    on(method, params) {
      const e = formatConsole(method, params);
      if (!e) return null;
      entries.push(e);
      total++;
      if (entries.length > MAX) {
        entries.shift();
        dropped++;
      }
      return e;
    },
    // What's come in since the last look (or everything still kept, with all).
    take({ all = false, errors = false } = {}) {
      const from = all ? 0 : Math.max(0, shown - dropped);
      const missed = all ? dropped : Math.max(0, dropped - shown);
      let list = entries.slice(from);
      shown = total;
      if (errors) list = list.filter((e) => /^(error|exception|warn)$/.test(e.level));
      const lines = list.map((e) => clip(`[${e.level}] ${e.parts.join(' ')}`) + e.at);
      if (missed) lines.unshift(`(${missed} older messages weren't kept)`);
      return lines.length ? lines.join('\n') : `(nothing new in tab ${tabId}'s console)`;
    },
  };
}
