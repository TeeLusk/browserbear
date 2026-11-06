import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createPanel } from '../service/panel.mjs';

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-panel-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = { instance: 'personal', name: 'Personal', email: 'me@example.com' };
  const calls = [];
  let target = 'target-7';
  const tabs = [{ tabId: 7, title: 'Signed-in page', url: 'https://example.com/', agent: true }];
  const deps = { home, profiles: () => [profile], mark: () => ({ state: 'yours' }),
    call: async (p, op, args) => {
      calls.push({ instance: p.instance, op, ...args });
      if (op === 'tabs') return tabs;
      if (op === 'cdp' && args.method === 'Target.getTargetInfo') return { targetInfo: { targetId: target } };
      if (op === 'cdp' && args.method === 'Page.captureScreenshot') return { data: 'aW1hZ2U=' };
      return {};
    } };
  const panel = createPanel(deps);
  t.after(() => panel.close());
  panel.remember(7, 'thread-one', profile.instance);
  const conn = new EventEmitter();
  conn.messages = [];
  conn.write = (line) => { conn.messages.push(JSON.parse(line)); return true; };
  conn.destroyed = false;
  const dispatch = (cmd, args = {}, thread = 'thread-one') => panel.dispatch(conn, { cmd, args, thread });
  return { home, deps, panel, calls, conn, dispatch, tabs, changeTarget: () => { target = 'different-page'; } };
}

test('only the owning thread can stream or send input, with the exact source profile', async (t) => {
  const { panel, dispatch, conn, calls } = setup(t);
  const state = await panel.state();
  assert.equal(state.tabs[0].thread, 'thread-one');
  assert.equal(state.tabs[0].profileEmail, 'me@example.com');
  await assert.rejects(dispatch('panelAttach', { tab: 7 }, 'other-thread'), /belongs to another thread/);
  await dispatch('panelAttach', { tab: 7 });
  await assert.rejects(dispatch('panelCdp', { method: 'Input.insertText', params: { text: 'wrong thread' } }, 'other-thread'), /belongs to another thread/);
  await dispatch('panelCdp', { method: 'Page.startScreencast', params: { quality: 80 } });
  for (let i = 0; i < 20 && !conn.messages.some(m => m.method === 'Page.screencastFrame'); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(conn.messages.some(m => m.method === 'Page.screencastFrame'));
  await dispatch('panelCdp', { method: 'Input.insertText', params: { text: 'hello' } });
  assert.ok(calls.some(c => c.instance === 'personal' && c.method === 'Input.insertText'));
  await assert.rejects(dispatch('panelCdp', { method: 'Network.getCookies' }), /not a panel command/);
  conn.emit('close');
  await new Promise(r => setTimeout(r, 20));
  assert.ok(calls.some(c => c.method === 'Emulation.clearDeviceMetricsOverride'));
  assert.ok(calls.some(c => c.method === 'Emulation.setFocusEmulationEnabled' && c.params.enabled === false));
});

test('a second panel cannot steal a stream, and stale tab IDs never show a different page', async (t) => {
  const { home, deps, panel, dispatch, changeTarget } = setup(t);
  await dispatch('panelAttach', { tab: 7 });
  const second = new EventEmitter();
  second.write = () => true;
  await assert.rejects(panel.dispatch(second, { cmd: 'panelAttach', args: { tab: 7 }, thread: 'thread-one' }), /already open/);
  await panel.close();
  const restored = createPanel(deps);
  t.after(() => restored.close());
  changeTarget();
  await assert.rejects(restored.dispatch(second, { cmd: 'panelAttach', args: { tab: 7 }, thread: 'thread-one' }), /changed since/);
  assert.ok(!fs.readFileSync(path.join(home, 'panel-tabs.json'), 'utf8').includes('example.com'));
});

test('native Chrome handoff pauses capture and releases emulation before detaching', async (t) => {
  const { dispatch, calls, conn } = setup(t);
  await dispatch('panelAttach', { tab: 7 });
  await dispatch('panelCdp', { method: 'Page.startScreencast' });
  await dispatch('panelWindow', { shown: true });
  const handoff = calls.findIndex(c => c.op === 'handoff');
  assert.ok(handoff > calls.findIndex(c => c.method === 'Emulation.clearDeviceMetricsOverride'));
  await assert.rejects(dispatch('panelCdp', { method: 'Input.insertText', params: { text: 'no' } }), /Chrome's window/);
  await dispatch('panelWindow', { shown: false });
  const before = conn.messages.length;
  await dispatch('panelCdp', { method: 'Page.startScreencast' });
  for (let i = 0; i < 20 && conn.messages.length === before; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(conn.messages.length > before, 'frames resume after returning from Chrome');
  await dispatch('panelCdp', { method: 'Input.insertText', params: { text: 'back' } });
});

test('Chrome detaching is respected without reattaching for cleanup', async (t) => {
  const { dispatch, panel, deps, calls } = setup(t);
  await dispatch('panelAttach', { tab: 7 });
  const before = calls.length;
  panel.event(deps.profiles()[0], { event: 'detached', tabId: 7 });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls.length, before);
  await assert.rejects(dispatch('panelAttach', { tab: 7 }), /explicitly to reconnect/);
  await dispatch('panelResume', { tab: 7 });
  await dispatch('panelAttach', { tab: 7 });
});

test('a native handoff survives panel remounting without reattaching during sign-in', async (t) => {
  const { panel, dispatch, calls, conn } = setup(t);
  panel.handedOff(7, 'personal', true);
  const before = calls.length;
  await assert.rejects(dispatch('panelAttach', { tab: 7 }), /explicitly to reconnect/);
  assert.equal(calls.length, before);
  await dispatch('panelResume', { tab: 7, profile: 'personal' });
  await dispatch('panelAttach', { tab: 7, profile: 'personal' });
  await dispatch('panelWindow', { shown: true });
  const after = calls.length;
  conn.emit('close');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls.length, after, 'closing a paused panel must not reattach the debugger');
});

test('one of the user’s own tabs needs an explicit Show this tab here action', async (t) => {
  const { tabs, dispatch, panel } = setup(t);
  tabs[0].agent = false;
  assert.equal((await panel.state()).tabs[0].requiresConsent, true);
  await assert.rejects(dispatch('panelAttach', { tab: 7 }), /Show this tab here/);
  await dispatch('panelResume', { tab: 7 });
  await dispatch('panelAttach', { tab: 7 });
});

test('agent Chrome and an existing profile cannot collide on the same numeric tab ID', async (t) => {
  const { panel, deps, dispatch } = setup(t);
  const p = deps.profiles()[0];
  const both = createPanel({ ...deps, profiles: () => [p, { instance: 'agent-chrome', name: 'agent' }] });
  t.after(() => both.close());
  both.remember(7, 'personal-thread', 'personal');
  both.remember(7, 'agent-thread', 'agent-chrome');
  const state = await both.state();
  assert.equal(state.tabs.length, 2);
  const conn = new EventEmitter(); conn.write = () => true;
  await assert.rejects(both.dispatch(conn, { cmd: 'panelAttach', thread: 'personal-thread', args: { tab: 7 } }), /exact Chrome profile/);
  await both.dispatch(conn, { cmd: 'panelAttach', thread: 'personal-thread', args: { tab: 7, profile: 'personal' } });
});

test('an alert answer can pass the click waiting on that alert', async (t) => {
  const { deps, panel, dispatch } = setup(t);
  const original = deps.call;
  let finishClick;
  deps.call = async (p, op, args) => {
    if (args?.method === 'Input.dispatchMouseEvent') return new Promise(resolve => { finishClick = resolve; });
    if (args?.method === 'Page.handleJavaScriptDialog') finishClick?.({});
    return original(p, op, args);
  };
  // The dependencies are captured by the controller, so construct this case
  // with the changed transport before attaching it.
  await panel.close();
  const dialogPanel = createPanel(deps);
  t.after(() => dialogPanel.close());
  dialogPanel.remember(7, 'thread-one', 'personal');
  const conn = new EventEmitter(); conn.write = () => true;
  await dialogPanel.dispatch(conn, { cmd: 'panelAttach', args: { tab: 7 }, thread: 'thread-one' });
  const click = dialogPanel.dispatch(conn, { cmd: 'panelCdp', thread: 'thread-one', args: { method: 'Input.dispatchMouseEvent' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  await dialogPanel.dispatch(conn, { cmd: 'panelCdp', thread: 'thread-one', args: { method: 'Page.handleJavaScriptDialog' } });
  await click;
});

test('viewport changes wait for a frame, while input can pass it', async (t) => {
  const { deps, panel } = setup(t);
  await panel.close();
  const original = deps.call;
  let finishFrame, changed = false, typed = false;
  deps.call = async (p, op, args) => {
    if (args?.method === 'Page.captureScreenshot') return new Promise(resolve => { finishFrame = resolve; });
    if (args?.method === 'Emulation.setDeviceMetricsOverride') changed = true;
    if (args?.method === 'Input.insertText') typed = true;
    return original(p, op, args);
  };
  const p = createPanel(deps);
  p.remember(7, 'thread-one', 'personal');
  const conn = new EventEmitter(); conn.write = () => true;
  const send = (cmd, args) => p.dispatch(conn, { cmd, args, thread: 'thread-one' });
  await send('panelAttach', { tab: 7 });
  await send('panelCdp', { method: 'Page.startScreencast' });
  await new Promise(r => setTimeout(r, 0));
  const resize = send('panelCdp', { method: 'Emulation.setDeviceMetricsOverride', params: { width: 360 } });
  await send('panelCdp', { method: 'Input.insertText', params: { text: 'hello' } });
  assert.equal(typed, true);
  assert.equal(changed, false, 'a concurrent resize can wedge Chromium during capture');
  finishFrame({ data: 'aW1hZ2U=' });
  await resize;
  assert.equal(changed, true);
  await p.close();
});

test('an existing dialog is replayed, kept alive, and the viewport restored after its answer', async (t) => {
  const { deps, panel, calls } = setup(t);
  await panel.close();
  const p = createPanel({ ...deps, dialog: () => ({ type: 'alert', message: 'Already open' }), heartbeatMs: 10 });
  t.after(() => p.close());
  p.remember(7, 'thread-one', 'personal');
  const conn = new EventEmitter(); conn.messages = []; conn.write = line => { conn.messages.push(JSON.parse(line)); return true; };
  const dispatch = (cmd, args = {}) => p.dispatch(conn, { cmd, args, thread: 'thread-one' });
  await dispatch('panelAttach', { tab: 7 });
  assert.ok(conn.messages.some(m => m.method === 'Page.javascriptDialogOpening'));
  await dispatch('panelCdp', { method: 'Emulation.setDeviceMetricsOverride', params: { width: 360, height: 600, deviceScaleFactor: 2, mobile: false } });
  await dispatch('panelCdp', { method: 'Page.startScreencast' });
  await new Promise(r => setTimeout(r, 35));
  assert.ok(calls.filter(c => c.method === 'Target.getTargetInfo').length > 1, 'keep the extension from idle-detaching');
  assert.ok(!conn.messages.some(m => m.method === 'Page.screencastFrame'));
  p.event(deps.profiles()[0], { event: 'dialogClosed', tabId: 7 });
  for (let i = 0; i < 30 && !conn.messages.some(m => m.method === 'Page.screencastFrame'); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(conn.messages.some(m => m.method === 'Page.screencastFrame'));
  assert.equal(calls.filter(c => c.method === 'Emulation.setDeviceMetricsOverride').length, 1, 'the initial resize waits until the dialog is answered');
});

test('popups use the exact opener tab and profile, never a shared URL', async (t) => {
  const { deps, panel, tabs } = setup(t);
  await panel.close();
  const p = createPanel({ ...deps, profiles: () => [{ ...deps.profiles()[0], panelPopups: true }] });
  t.after(() => p.close());
  p.remember(7, 'thread-one', 'personal');
  tabs.push({ tabId: 10, url: 'https://example.com/old', title: 'Existing child', openerTabId: 7 });
  const conn = new EventEmitter(); conn.write = () => true;
  await p.dispatch(conn, { cmd: 'panelAttach', args: { tab: 7 }, thread: 'thread-one' });
  await p.dispatch(conn, { cmd: 'panelCdp', args: { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed' } }, thread: 'thread-one' });
  tabs.push({ tabId: 8, url: 'https://example.com/login', title: 'Popup', openerTabId: 7 });
  tabs.push({ tabId: 9, url: 'https://example.com/login', title: 'Unrelated', openerTabId: 999 });
  const state = await p.state();
  assert.equal(state.tabs.find(t => t.tabId === 8)?.thread, 'thread-one');
  assert.ok(!state.tabs.some(t => t.tabId === 9));
  assert.ok(!state.tabs.some(t => t.tabId === 10), 'an existing child never inherits panel consent');
  assert.equal((await p.state()).tabs.length, 2, 'a second poll must not associate the unrelated tab');
});

test('a previous viewer restores the viewport before its replacement renders', async t => {
  const { deps, panel } = setup(t);
  await panel.close();
  const original = deps.call;
  let finishFrame;
  const order = [];
  deps.call = async (p, op, args) => {
    if (args?.method === 'Page.captureScreenshot') return new Promise(resolve => { finishFrame = resolve; });
    if (args?.method?.startsWith('Emulation.')) order.push(args.method);
    return original(p, op, args);
  };
  const p = createPanel(deps);
  t.after(() => p.close());
  p.remember(7, 'thread-one', 'personal');
  const a = new EventEmitter(); a.write = () => true;
  const b = new EventEmitter(); b.write = () => true;
  const send = (conn, cmd, args = {}) => p.dispatch(conn, { cmd, args, thread: 'thread-one' });
  await send(a, 'panelAttach', { tab: 7 });
  await send(a, 'panelCdp', { method: 'Page.startScreencast' });
  await new Promise(r => setTimeout(r, 0));
  a.emit('close');
  await send(b, 'panelAttach', { tab: 7 });
  const resize = send(b, 'panelCdp', { method: 'Emulation.setDeviceMetricsOverride', params: { width: 360 } });
  assert.deepEqual(order, []);
  finishFrame({ data: 'aW1hZ2U=' });
  await resize;
  assert.ok(order.indexOf('Emulation.clearDeviceMetricsOverride') < order.indexOf('Emulation.setDeviceMetricsOverride'));
});

test('divider dragging coalesces pending viewport changes behind a frame', async t => {
  const { deps, panel, calls } = setup(t);
  await panel.close();
  const original = deps.call;
  let finish;
  deps.call = async (p, op, args) => args?.method === 'Page.captureScreenshot'
    ? new Promise(r => { finish = r; }) : original(p, op, args);
  const p = createPanel(deps); t.after(() => p.close());
  p.remember(7, 'thread-one', 'personal');
  const conn = new EventEmitter(); conn.write = () => true;
  const send = (cmd, args) => p.dispatch(conn, { cmd, args, thread: 'thread-one' });
  await send('panelAttach', { tab: 7 });
  await send('panelCdp', { method: 'Page.startScreencast' });
  await new Promise(r => setTimeout(r, 0));
  const resizes = [400, 500, 600].map(width => send('panelCdp', { method: 'Emulation.setDeviceMetricsOverride', params: { width } }));
  await new Promise(r => setTimeout(r, 0));
  finish({ data: 'aW1hZ2U=' });
  await Promise.all(resizes);
  assert.deepEqual(calls.filter(c => c.method === 'Emulation.setDeviceMetricsOverride').map(c => c.params.width), [600]);
});

test('a second dialog does not turn the first dialog’s viewport restore into a disconnect', async t => {
  const { deps, panel } = setup(t);
  await panel.close();
  const original = deps.call;
  let rejectRestore;
  deps.call = async (profile, op, args) => {
    if (args?.method === 'Emulation.setFocusEmulationEnabled' && !rejectRestore) return new Promise((_, reject) => { rejectRestore = reject; });
    return original(profile, op, args);
  };
  const p = createPanel(deps); t.after(() => p.close());
  p.remember(7, 'thread-one', 'personal');
  const conn = new EventEmitter(); const events = [];
  conn.write = s => { events.push(JSON.parse(s)); return true; };
  await p.dispatch(conn, { cmd: 'panelAttach', args: { tab: 7 }, thread: 'thread-one' });
  const event = name => p.event(deps.profiles()[0], { event: name, tabId: 7, params: { type: 'alert', message: 'Alert' } });
  event('dialog'); event('dialogClosed');
  await new Promise(r => setTimeout(r, 0));
  event('dialog'); rejectRestore(new Error('dialog open'));
  await new Promise(r => setTimeout(r, 0));
  assert.ok(!events.some(e => e.method === 'panelError'));
  event('dialogClosed');
  await new Promise(r => setTimeout(r, 0));
  assert.ok(p.hasViewer(7, 'personal'));
});

test('one capture timeout retries without disconnecting the page', async t => {
  const { deps, panel } = setup(t);
  await panel.close();
  const original = deps.call;
  let captures = 0;
  deps.call = async (p, op, args) => {
    if (args?.method === 'Page.captureScreenshot' && ++captures === 1) throw Object.assign(new Error('capture timed out'), { timedOut: true });
    return original(p, op, args);
  };
  const p = createPanel(deps); t.after(() => p.close());
  p.remember(7, 'thread-one', 'personal');
  const conn = new EventEmitter(); const events = [];
  conn.write = line => { events.push(JSON.parse(line)); return true; };
  await p.dispatch(conn, { cmd: 'panelAttach', args: { tab: 7 }, thread: 'thread-one' });
  await p.dispatch(conn, { cmd: 'panelCdp', args: { method: 'Page.startScreencast' }, thread: 'thread-one' });
  for (let i = 0; i < 100 && !events.some(e => e.method === 'Page.screencastFrame'); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(events.some(e => e.method === 'Page.screencastFrame'));
  assert.ok(!events.some(e => e.method === 'panelError'));
});

test('extension 0.3.7 streams Chrome’s screencast, acks each frame once the panel took it, and stops it on close', async t => {
  const { deps, panel, dispatch, conn, calls } = setup(t);
  const profile = deps.profiles()[0];
  profile.screencast = true;
  await dispatch('panelAttach', { tab: 7 });
  await dispatch('panelCdp', { method: 'Page.startScreencast', params: { quality: 85, maxWidth: 1000, maxHeight: 1600 } });
  await new Promise(r => setTimeout(r, 20));
  const start = calls.find(c => c.method === 'Page.startScreencast');
  assert.deepEqual(start.params, { format: 'jpeg', quality: 85, everyNthFrame: 1, maxWidth: 1000, maxHeight: 1600 });

  // A new panel size restarts the cast at that size.
  await dispatch('panelCdp', { method: 'Page.startScreencast', params: { quality: 85, maxWidth: 800, maxHeight: 1600 } });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.filter(c => c.method === 'Page.startScreencast').at(-1).params.maxWidth, 800);

  panel.event(profile, { type: 'event', event: 'frame', tabId: 7, params: { data: 'ZnJhbWU=', sessionId: 3 } });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(conn.messages.at(-1), { method: 'Page.screencastFrame', params: { data: 'ZnJhbWU=' } });
  assert.deepEqual(calls.at(-1), { instance: 'personal', op: 'cdp', tabId: 7, method: 'Page.screencastFrameAck', params: { sessionId: 3 } });

  // A full socket: the ack waits for it to drain.
  conn.write = line => { conn.messages.push(JSON.parse(line)); return false; };
  panel.event(profile, { type: 'event', event: 'frame', tabId: 7, params: { data: 'Zm9v', sessionId: 4 } });
  await new Promise(r => setTimeout(r, 10));
  assert.ok(!calls.some(c => c.params?.sessionId === 4));
  conn.emit('drain');
  await new Promise(r => setTimeout(r, 10));
  assert.ok(calls.some(c => c.method === 'Page.screencastFrameAck' && c.params.sessionId === 4));

  conn.emit('close');
  await new Promise(r => setTimeout(r, 20));
  assert.ok(calls.some(c => c.method === 'Page.stopScreencast'));
  // A late frame after the panel went stops the cast rather than acking it.
  const before = calls.length;
  panel.event(profile, { type: 'event', event: 'frame', tabId: 7, params: { data: 'Zm9v', sessionId: 5 } });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(calls.slice(before).map(c => c.method), ['Page.stopScreencast']);
});

test('screenshots step aside while cast frames flow, and fill in for a hidden tab Chrome stops drawing', async t => {
  const { deps, panel, dispatch, conn, calls } = setup(t);
  const profile = deps.profiles()[0];
  profile.screencast = true;
  await dispatch('panelAttach', { tab: 7 });
  await dispatch('panelCdp', { method: 'Page.startScreencast', params: { quality: 80 } });
  const shots = () => calls.filter(c => c.method === 'Page.captureScreenshot').length;
  await new Promise(r => setTimeout(r, 100));
  assert.ok(shots() >= 1, 'screenshots until the first cast frame');
  const casting = setInterval(() => panel.event(profile, { event: 'frame', tabId: 7, params: { data: 'Zm9v', sessionId: 1 } }), 16);
  await new Promise(r => setTimeout(r, 100));
  const during = shots();
  await new Promise(r => setTimeout(r, 400));
  clearInterval(casting);
  assert.ok(shots() - during <= 0, `${shots() - during} screenshots while cast frames came`);
  await new Promise(r => setTimeout(r, 600));
  assert.ok(shots() > during, 'screenshots again once the cast went quiet');
  assert.ok(conn.messages.filter(m => m.method === 'Page.screencastFrame').length > 20);
});
