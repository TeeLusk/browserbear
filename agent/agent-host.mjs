#!/usr/bin/env node
// The agent's own Chrome, in place of the extension in Mike's profiles.
//
// It's real Google Chrome with a profile folder of its own, so it never touches
// the Chrome he's using, and it speaks the extension's side of the service's
// protocol (tabs, open, navigate, cdp and so on), so every page smart in
// service.mjs still works. Three things found by trying them (5 Nov 2026):
//  - Headless Chrome is rejected by Google's sign-in and CEF is too, with
//    "This browser or app may not be secure". Real windowed Chrome isn't, even
//    with the debugging port open and scripted input, so it has to be this.
//  - Chrome stops drawing a window that's minimised, an app that's hidden and
//    a tab that's in the background (0 frames a second, and 5 s for a mouse
//    event). A window that's merely off to the side keeps 60 frames a second, so
//    each tab gets a window of its own, parked in a corner of the screen, and
//    the flags below stop Chrome pausing windows that are covered.
//  - A fixed debugging port doesn't set navigator.webdriver; a pipe would.
//
// Threadbear's Browser panel reads tabs.json to learn which tabs a thread has,
// and connects to the same port for the picture and for Mike's mouse and keys.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME, SOCKET, line, lineReader } from '../service/wire.mjs';

export const DIR = path.join(HOME, 'agent');
const PROFILE = path.join(DIR, 'chrome-profile');
const STATE = path.join(DIR, 'tabs.json');
const IDS = path.join(DIR, 'tab-ids.json');
const PORT = Number(process.env.BROWSERBEAR_AGENT_PORT) || 9339;
const WIDTH = 1280;
const HEIGHT = 900;
// Far past any screen: Chrome keeps about 40 points of the window on a display.
// The window's top right corner is what shows at the bottom left, which is the
// part with nothing in it to click by accident (top left is the close button).
const PARK = { left: -100000, top: 100000 };

const CHROME_FLAGS = [
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  `--window-size=${WIDTH},${HEIGHT}`,
  `--window-position=${PARK.left},${PARK.top}`,
];

fs.mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
const logFile = fs.createWriteStream(path.join(DIR, 'host.log'), { flags: 'a' });
const log = (...a) => logFile.write(`${new Date().toISOString()} ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Chrome ----

async function browserWsUrl() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/version`).catch(() => null);
  return r?.ok ? (await r.json()).webSocketDebuggerUrl : null;
}

async function ensureChrome() {
  let url = await browserWsUrl();
  if (url) return url;
  log('starting Chrome');
  // -g: don't bring it to the front. -n: a second copy beside Mike's.
  spawn('open', ['-g', '-n', '-a', 'Google Chrome', '--args', ...CHROME_FLAGS, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !url; i++) {
    await sleep(200);
    url = await browserWsUrl();
  }
  if (!url) throw new Error("the agent's Chrome didn't start");
  return url;
}

let ws;
let nextCdp = 1;
const cdpWaiting = new Map();
const sessions = new Map(); // targetId -> sessionId
const sessionTarget = new Map(); // sessionId -> targetId

function browserCall(method, params = {}, sessionId, timeoutMs = 30_000) {
  const id = nextCdp++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cdpWaiting.delete(id);
      reject(new Error(`cdp timed out after ${timeoutMs / 1000}s: ${method}`));
    }, timeoutMs);
    cdpWaiting.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function connectChrome() {
  const url = await ensureChrome();
  ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("couldn't connect to the agent's Chrome"));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && cdpWaiting.has(m.id)) {
      const w = cdpWaiting.get(m.id);
      cdpWaiting.delete(m.id);
      clearTimeout(w.timer);
      if (m.error) w.reject(new Error(m.error.message));
      else w.resolve(m.result);
      return;
    }
    if (m.method) onEvent(m);
  };
  // Chrome was quit (by Mike, or crashed): the service sees us go, and the
  // next `--profile agent` starts us again.
  ws.onclose = () => {
    log('Chrome went away');
    process.exit(0);
  };
  await browserCall('Target.setDiscoverTargets', { discover: true });
}

// ---- Tabs ----

const known = new Map(); // tabId -> { targetId, url, title, thread, mark, status, loadError, handoffs, openedAt }
const byTarget = new Map(); // targetId -> tabId
let ids = {};
try {
  ids = JSON.parse(fs.readFileSync(IDS, 'utf8'));
} catch {}
let nextTab = Math.max(1000, ...Object.values(ids)) + 1;
// Which thread has which page, kept so a restart of this host doesn't orphan them.
const OWNERS = path.join(DIR, 'tab-threads.json');
let owners = {};
try {
  owners = JSON.parse(fs.readFileSync(OWNERS, 'utf8'));
} catch {}
function own(tab, thread) {
  tab.thread = thread;
  if (thread) owners[tab.targetId] = thread;
  else delete owners[tab.targetId];
  fs.writeFileSync(OWNERS, JSON.stringify(owners));
}

function tabIdFor(targetId) {
  if (!ids[targetId]) {
    ids[targetId] = nextTab++;
    fs.writeFileSync(IDS, JSON.stringify(ids));
  }
  return ids[targetId];
}

const isTab = (t) => t.type === 'page' && !t.url.startsWith('devtools://');

function track(info) {
  if (!isTab(info)) return null;
  const tabId = tabIdFor(info.targetId);
  let tab = known.get(tabId);
  if (!tab) {
    tab = { tabId, targetId: info.targetId, status: 'complete', handoffs: 0, openedAt: Date.now(), thread: owners[info.targetId] };
    known.set(tabId, tab);
    byTarget.set(info.targetId, tabId);
    // A popup (a Google sign-in, say) belongs to the thread that opened it,
    // and has to be parked like any other window or it lands on Mike's screen.
    if (info.openerId) {
      own(tab, known.get(byTarget.get(info.openerId))?.thread);
      tab.popup = true;
    }
  }
  tab.url = info.url;
  tab.title = info.title;
  return tab;
}

const tabInfo = (t) => ({
  tabId: t.tabId,
  windowId: t.tabId,
  url: t.url || '',
  title: t.title || '',
  active: true,
  groupId: -1,
  status: t.status,
  loadError: t.loadError,
  agent: true,
  bear: true,
});

let chromePid = null;
let writing = null;
function writeState() {
  writing ||= setTimeout(() => {
    writing = null;
    const tabs = [...known.values()].map(({ tabId, targetId, url, title, thread, mark, status, handoffs, openedAt, popup }) => ({
      tabId,
      targetId,
      url,
      title,
      thread: thread ?? null,
      state: mark?.state ?? null,
      action: mark?.action ?? null,
      finish: mark?.finish ?? false,
      status,
      handoffs,
      openedAt,
      popup: !!popup,
    }));
    const tmp = `${STATE}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ port: PORT, socket: SOCKET, pid: process.pid, chromePid, tabs }));
    fs.renameSync(tmp, STATE);
  }, 50);
}

async function park(targetId) {
  const { windowId } = await browserCall('Browser.getWindowForTarget', { targetId });
  await browserCall('Browser.setWindowBounds', { windowId, bounds: PARK });
}

async function sessionFor(tab) {
  const have = sessions.get(tab.targetId);
  if (have) return have;
  const { sessionId } = await browserCall('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
  sessions.set(tab.targetId, sessionId);
  sessionTarget.set(sessionId, tab.targetId);
  await browserCall('Page.enable', {}, sessionId);
  // So the page behaves as if it's in front, though Chrome's window never is.
  await browserCall('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
  const tree = await browserCall('Page.getFrameTree', {}, sessionId).catch(() => null);
  tab.mainFrame = tree?.frameTree?.frame?.id;
  return sessionId;
}

const tabOf = (tabId) => {
  const tab = known.get(tabId);
  if (!tab) throw new Error(`No tab with id: ${tabId}`);
  return tab;
};

function loaded(tab, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const look = () => {
      if (tab.status === 'complete' || Date.now() - start > timeoutMs) return resolve(tab);
      setTimeout(look, 50);
    };
    look();
  });
}

async function goTo(tab, url) {
  const session = await sessionFor(tab);
  tab.status = 'loading';
  tab.loadError = undefined;
  const r = await browserCall('Page.navigate', { url }, session, 40_000);
  if (r.errorText) {
    tab.status = 'complete';
    if (r.errorText !== 'net::ERR_ABORTED') tab.loadError = r.errorText;
    return tab;
  }
  // A URL that only downloads never finishes loading a page.
  if (!r.loaderId) tab.status = 'complete';
  return loaded(tab);
}

function onEvent(m) {
  const { method, params, sessionId } = m;
  if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
    const tab = track(params.targetInfo);
    if (tab && method === 'Target.targetCreated' && tab.popup) {
      park(tab.targetId).catch((e) => log('park failed', e.message));
    }
    writeState();
    return;
  }
  if (method === 'Target.targetDestroyed') {
    const tabId = byTarget.get(params.targetId);
    if (tabId) {
      known.delete(tabId);
      byTarget.delete(params.targetId);
      sessions.delete(params.targetId);
      if (owners[params.targetId]) {
        delete owners[params.targetId];
        fs.writeFileSync(OWNERS, JSON.stringify(owners));
      }
      writeState();
    }
    return;
  }
  if (method === 'Target.detachedFromTarget') {
    const targetId = sessionTarget.get(params.sessionId);
    sessionTarget.delete(params.sessionId);
    if (targetId) sessions.delete(targetId);
    return;
  }
  const targetId = sessionId && sessionTarget.get(sessionId);
  const tab = targetId && known.get(byTarget.get(targetId));
  if (!tab) return;
  if (method === 'Page.frameStartedLoading' && params.frameId === tab.mainFrame) {
    tab.status = 'loading';
    writeState();
  }
  if (method === 'Page.frameStoppedLoading' && params.frameId === tab.mainFrame) {
    tab.status = 'complete';
    writeState();
  }
  if (method === 'Page.javascriptDialogOpening') post({ type: 'event', event: 'dialog', tabId: tab.tabId, params });
  if (method === 'Page.javascriptDialogClosed') post({ type: 'event', event: 'dialogClosed', tabId: tab.tabId });
}

// What `handoff --wait` asks: is there still a sign-in form, and is this text
// here? Yes or no only, as with the extension. Main frame only, for now.
const PROBE = (text) => `(() => {
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const signInForm = [...document.querySelectorAll('input[type=password]')].some(seen);
  const want = ${JSON.stringify(text ?? null)};
  return { signInForm, text: want ? (document.body?.innerText || '').includes(want) : false };
})()`;

const ops = {
  async tabs() {
    const { targetInfos } = await browserCall('Target.getTargets');
    targetInfos.forEach(track);
    writeState();
    return [...known.values()].map(tabInfo);
  },

  // One window per tab: a tab behind another in the same window stops drawing.
  async open({ url, thread }) {
    const { targetId } = await browserCall('Target.createTarget', { url: 'about:blank', newWindow: true, background: true, width: WIDTH, height: HEIGHT });
    await park(targetId).catch((e) => log('park failed', e.message));
    const { targetInfos } = await browserCall('Target.getTargets');
    const tab = track(targetInfos.find((t) => t.targetId === targetId));
    own(tab, thread);
    writeState();
    await goTo(tab, url);
    writeState();
    return tabInfo(tab);
  },

  async navigate({ tabId, url }) {
    return tabInfo(await goTo(tabOf(tabId), url));
  },

  async show({ tabId }) {
    return tabInfo(tabOf(tabId));
  },

  async focus({ tabId }) {
    return tabInfo(tabOf(tabId));
  },

  async reload() {
    setTimeout(() => process.exit(0), 100);
    return true;
  },

  async close({ tabId }) {
    await browserCall('Target.closeTarget', { targetId: tabOf(tabId).targetId });
    return true;
  },

  // No tab to move and no window to bring up: the panel in Threadbear is where
  // Mike does it. It watches this count and opens itself.
  async handoff({ tabId }) {
    const tab = tabOf(tabId);
    tab.handoffs += 1;
    writeState();
    return tabInfo(tab);
  },

  async probe({ tabId, text }) {
    const r = await browserCall('Runtime.evaluate', { expression: PROBE(text), returnByValue: true }, await sessionFor(tabOf(tabId)), 5_000).catch(() => null);
    return r?.result?.value ?? { signInForm: null, text: false };
  },

  async cdp({ tabId, method, params }) {
    return browserCall(method, params || {}, await sessionFor(tabOf(tabId)));
  },

  // The panel draws these. Nothing goes in the page, so a site can't see it.
  async mark({ tabId, mark }) {
    tabOf(tabId).mark = mark || null;
    writeState();
    return true;
  },

  async detach({ tabId }) {
    const tab = tabOf(tabId);
    const session = sessions.get(tab.targetId);
    if (session) await browserCall('Target.detachFromTarget', { sessionId: session }).catch(() => {});
    sessions.delete(tab.targetId);
    return true;
  },

  async download() {
    throw new Error("download isn't in the agent's Chrome yet: use a link click, which lands in its Downloads folder");
  },
};

// ---- The service ----

let sock = null;
const post = (msg) => sock?.write(line(msg));

async function onService(msg) {
  if (msg.type) return;
  const handler = ops[msg.op];
  try {
    if (!handler) throw new Error(`unknown op ${msg.op}`);
    post({ id: msg.id, ok: true, result: await handler(msg.args || {}) });
  } catch (e) {
    post({ id: msg.id, ok: false, error: String(e?.message || e) });
  }
}

function connectService(delay = 0) {
  setTimeout(() => {
    const s = net.createConnection(SOCKET);
    s.on('connect', () => {
      sock = s;
      s.write(line({ type: 'hello', instance: 'agent-chrome', email: null, name: 'agent', version: 'agent' }));
      log('connected to service');
    });
    s.on('data', lineReader(onService));
    s.on('error', (e) => log('service socket', e.code || e.message));
    s.on('close', () => {
      sock = null;
      connectService(Math.min(5000, delay * 2 || 250));
    });
  }, delay);
}

log('host up', os.hostname());
await connectChrome();
// For Threadbear, to hand the focus back when a page's popup takes it.
chromePid = (await browserCall('SystemInfo.getProcessInfo').catch(() => null))?.processInfo?.find((p) => p.type === 'browser')?.id ?? null;
const { targetInfos } = await browserCall('Target.getTargets');
targetInfos.forEach(track);
// --window-position only gets the first window part of the way (it landed
// whole on Mike's left-hand screen), so it's parked like the others. It stays
// open and empty, as Chrome would quit with its last window.
await Promise.all(targetInfos.filter(isTab).map((t) => park(t.targetId).catch((e) => log('park failed', e.message))));
writeState();
connectService();
