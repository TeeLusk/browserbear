// Threadbear's picture and input travel over the same private socket as the
// CLI. Capturing frames works with existing Store extensions: no new browser
// permission, debugging port, cookie export or extension update is needed.
import fs from 'node:fs';
import path from 'node:path';
import { line } from './wire.mjs';

const METHODS = new Set([
  'Page.enable', 'Page.reload', 'Page.navigate', 'Page.handleJavaScriptDialog',
  'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride', 'Emulation.setFocusEmulationEnabled',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Runtime.evaluate',
]);

export function createPanel({ home, profiles, call, mark, popup = () => {}, dialog = () => null, clearDialog = () => {}, heartbeatMs = 10_000 }) {
  const file = path.join(home, 'panel-tabs.json');
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  // A CDP target identity prevents a reused Chrome tab number after a browser
  // restart from silently displaying an unrelated page.
  const key = (instance, tabId) => `${instance}/${tabId}`;
  const tabs = new Map((Array.isArray(saved) ? saved : []).filter(t => t.targetId).map(t => [key(t.instance, t.tabId), { ...t, openedAt: t.openedAt || Date.now() }]));
  const ownTab = (tabId, instance) => {
    const hits = [...tabs.values()].filter(t => t.tabId === Number(tabId) && (!instance || t.instance === instance));
    if (hits.length > 1) throw new Error('Choose the exact Chrome profile for this page.');
    return hits[0];
  };
  const viewers = new Map(); // connection -> one tab; never a profile-wide stream
  const verified = new Set(); // identities confirmed in this service lifetime
  const attaching = new WeakMap();
  const rendering = new Map(); // tab -> render chain, including a previous viewer's cleanup
  const persist = () => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify([...tabs.values()]), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  const profileFor = t => profiles().find(p => p.instance === t.instance);
  const send = (v, method, params = {}, timeout = 8_000) => {
    const profile = profileFor(v);
    if (!profile) return Promise.reject(new Error('This Chrome profile disconnected.'));
    return call(profile, 'cdp', { tabId: v.tabId, method, params }, timeout);
  };
  const render = (v, action) => {
    const id = key(v.instance, v.tabId);
    const next = (rendering.get(id) || Promise.resolve()).catch(() => {}).then(action);
    rendering.set(id, next);
    next.finally(() => { if (rendering.get(id) === next) rendering.delete(id); }).catch(() => {});
    return next;
  };

  function remember(tabId, thread, instance, fresh = false) {
    if (!thread) return;
    const previous = tabs.get(key(instance, tabId));
    if (!fresh && previous?.thread === thread && previous.instance === instance) return;
    tabs.set(key(instance, tabId), { tabId, thread, instance, openedAt: Date.now(), handoffs: previous?.handoffs || 0 });
    verified.add(key(instance, tabId)); // an ordinary agent command just selected this tab
    persist();
    // A deliberate CLI claim by another thread also ends the old panel's input.
    for (const v of viewers.values()) if (v.tabId === tabId && v.instance === instance && v.thread !== thread) {
      v.conn.write(line({ method: 'panelError', params: { message: 'This page is now being used by another thread.' } }));
      release(v);
    }
  }

  async function state() {
    const connected = profiles();
    const rows = await Promise.all(connected.map(async p => {
      const list = await call(p, 'tabs', {}, 5_000).catch(() => null);
      if (!list) return [];
      if (p.panelPopups) for (const tab of list) {
        if (tab.openerTabId == null || tabs.has(key(p.instance, tab.tabId))) continue;
        const parent = [...viewers.values()].find(v => v.instance === p.instance && v.tabId === tab.openerTabId && !v.paused && !v.stopped);
        if (!parent || parent.knownTabs.has(tab.tabId) || Date.now() - (parent.lastInput || 0) > 5000 || !verified.has(key(p.instance, parent.tabId))) continue;
        tabs.set(key(p.instance, tab.tabId), { tabId: tab.tabId, instance: p.instance, thread: parent.thread, openedAt: Date.now(), consent: true, handoffs: 0 });
        verified.add(key(p.instance, tab.tabId));
        persist();
        popup(p, tab, parent.thread);
      }
      for (const v of viewers.values()) if (v.instance === p.instance) v.knownTabs = new Set(list.map(t => t.tabId));
      const byId = new Map(list.map(t => [t.tabId, t]));
      const out = [];
      for (const own of tabs.values()) {
        if (own.instance !== p.instance) continue;
        const tab = byId.get(own.tabId);
        if (!tab) { tabs.delete(key(own.instance, own.tabId)); continue; }
        const m = mark(own.tabId) || {};
        if (verified.has(key(own.instance, own.tabId)) && own.cachedTitle !== tab.title) { own.cachedTitle = tab.title; persist(); }
        const info = verified.has(key(own.instance, own.tabId)) ? tab : { tabId: own.tabId, title: own.cachedTitle || 'Chrome tab', url: 'about:blank' };
        out.push({ ...info, ...own, requiresConsent: !tab.agent && !own.consent,
          profile: p.instance, profileName: p.name || p.dir || p.instance.slice(0, 8), profileEmail: p.email,
          bridge: p.instance !== 'agent-chrome', state: m.state, action: m.action, finish: m.finish });
      }
      return out;
    }));
    return { profiles: connected.filter(p => p.instance !== 'agent-chrome').map(p => ({ id: p.instance, name: p.name, email: p.email, panelPopups: p.panelPopups === true })), tabs: rows.flat() };
  }

  async function reset(v, answered = Promise.resolve()) {
    clearTimeout(v.timer);
    // These run before Chrome's handoff detaches the debugger. Never leave a
    // user's real tab stuck at the panel's width after it closes or disconnects.
    await render(v, async () => {
      await answered;
      await Promise.allSettled([
        send(v, 'Emulation.clearDeviceMetricsOverride'),
        send(v, 'Emulation.setFocusEmulationEnabled', { enabled: false }),
      ]);
    });
  }

  async function release(v, restore = true) {
    if (viewers.get(v.conn) !== v) return;
    viewers.delete(v.conn);
    v.stopped = true;
    v.generation++;
    clearTimeout(v.timer);
    clearInterval(v.heartbeat);
    if (restore && !v.paused) {
      // Reserve cleanup's place before a replacement viewer can resize. The
      // answer itself bypasses rendering to unblock a capture behind an alert.
      const answered = v.dialog ? send(v, 'Page.handleJavaScriptDialog', { accept: false }).catch(() => {}) : Promise.resolve();
      await reset(v, answered);
    }
  }

  async function capture(v, generation) {
    if (v.stopped || v.paused || v.dialog || !v.capturing || v.conn.destroyed || generation !== v.generation) return;
    try {
      const result = await render(v, () => {
        if (v.stopped || v.paused || generation !== v.generation) throw new Error('Capture ended.');
        return send(v, 'Page.captureScreenshot', { format: 'jpeg', quality: v.quality, fromSurface: true, captureBeyondViewport: false });
      });
      if (v.stopped || v.paused || !v.capturing || v.conn.destroyed || generation !== v.generation) return;
      v.captureFailures = 0;
      // A bounded queue: don't capture another frame until this one drained.
      const ready = v.conn.write(line({ method: 'Page.screencastFrame', params: { data: result.data } }));
      if (!ready) await new Promise(resolve => {
        const finish = () => { v.conn.off('drain', finish); v.conn.off('close', finish); resolve(); };
        v.conn.once('drain', finish);
        v.conn.once('close', finish);
      });
      if (!v.stopped && !v.paused && v.capturing && generation === v.generation) v.timer = setTimeout(() => capture(v, generation), 70);
    } catch (e) {
      if (generation !== v.generation || v.dialog || v.paused || v.stopped) return;
      if (e.timedOut && (v.captureFailures = (v.captureFailures || 0) + 1) < 3) {
        v.timer = setTimeout(() => capture(v, generation), 500);
        return;
      }
      const own = tabs.get(key(v.instance, v.tabId));
      if (own) { own.suspended = true; persist(); }
      if (!v.stopped && !v.paused && !v.conn.destroyed) v.conn.write(line({ method: 'panelError', params: { message: e.message } }));
      await release(v);
    }
  }

  function suspend(v, message) {
    if (v.stopped) return;
    const own = tabs.get(key(v.instance, v.tabId));
    if (own) { own.suspended = true; persist(); }
    v.conn.write(line({ method: 'panelError', params: { message } }));
    release(v, false);
  }

  function dialogEnded(v) {
    if (!v.dialog || v.stopped) return;
    v.dialog = false;
    v.generation++;
    v.conn.write(line({ method: 'Page.javascriptDialogClosed' }));
    render(v, async () => {
      if (v.stopped || v.paused || v.dialog) return;
      await send(v, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      if (v.metrics) await send(v, 'Emulation.setDeviceMetricsOverride', v.metrics);
    }).then(() => {
      if (v.capturing && !v.paused && !v.stopped) capture(v, ++v.generation);
    }).catch(e => { if (!v.dialog && !v.stopped && !v.paused) suspend(v, e.message); });
  }

  async function handle(conn, { cmd, args = {}, thread }) {
    if (conn.destroyed) throw new Error('The panel connection closed.');
    if (cmd === 'panelShowChrome') {
      const own = ownTab(args.tab, args.profile);
      if (!thread || !own || own.thread !== thread) throw new Error('This page belongs to another thread.');
      const profile = profileFor(own);
      if (!profile) throw new Error('This Chrome profile is not connected.');
      own.inChrome = true;
      persist();
      for (const v of viewers.values()) if (v.tabId === own.tabId && v.instance === own.instance) {
        v.paused = true;
        v.capturing = false;
        v.generation++;
        await reset(v);
      }
      await call(profile, 'handoff', { tabId: own.tabId });
      return {};
    }
    if (cmd === 'panelResume') {
      const own = ownTab(args.tab, args.profile);
      if (!thread || !own || own.thread !== thread) throw new Error('This page belongs to another thread.');
      own.inChrome = false;
      own.suspended = false;
      own.consent = true;
      persist();
      return {};
    }
    if (cmd === 'panelAttach') {
      const own = ownTab(args.tab, args.profile);
      if (!thread || !own || own.thread !== thread) throw new Error('This page belongs to another thread, or is no longer open.');
      if (own.inChrome || own.suspended) throw new Error('Return this page to the panel explicitly to reconnect.');
      if ([...viewers.values()].some(v => v.tabId === own.tabId && v.instance === own.instance && v.conn !== conn)) throw new Error('This page is already open in another Browser panel.');
      if (viewers.has(conn)) await release(viewers.get(conn));
      const profile = profileFor(own);
      if (!profile) throw new Error('This Chrome profile is not connected to BrowserBear.');
      const list = await call(profile, 'tabs', {}, 5_000);
      const tab = list.find(t => t.tabId === own.tabId);
      if (!tab) throw new Error('This Chrome tab closed.');
      if (!tab.agent && !own.consent) throw new Error('Choose Show this tab here before displaying one of your own Chrome tabs.');
      const v = { conn, thread, instance: own.instance, profile, tabId: own.tabId, knownTabs: new Set(list.map(t => t.tabId)), quality: 80, stopped: false, paused: false, capturing: false, generation: 0 };
      const { targetInfo } = await send(v, 'Target.getTargetInfo');
      if (!targetInfo?.targetId) throw new Error('Chrome did not identify this page.');
      if (own.targetId && own.targetId !== targetInfo.targetId) {
        tabs.delete(key(own.instance, own.tabId));
        persist();
        throw new Error('This Chrome tab changed since it was last opened here. Open a new page in this thread.');
      }
      own.targetId = targetInfo.targetId;
      verified.add(key(own.instance, own.tabId));
      persist();
      if (conn.destroyed) throw new Error('The panel connection closed.');
      if (tabs.get(key(own.instance, own.tabId)) !== own || own.thread !== thread || own.inChrome || own.suspended) throw new Error('This page changed or moved to Chrome while connecting.');
      if ([...viewers.values()].some(v => v.tabId === own.tabId && v.instance === own.instance && v.conn !== conn)) throw new Error('This page is already open in another Browser panel.');
      viewers.set(conn, v);
      conn.once('close', () => release(v));
      const openDialog = dialog(v.tabId);
      if (openDialog) {
        v.dialog = true;
        conn.write(line({ method: 'Page.javascriptDialogOpening', params: openDialog }));
      }
      v.heartbeat = setInterval(() => {
        if (v.dialog && !v.paused && !v.stopped) send(v, 'Target.getTargetInfo').catch(e => suspend(v, e.message));
      }, heartbeatMs);
      v.heartbeat.unref();
      return {};
    }
    const v = viewers.get(conn);
    if (!thread || !v || v.thread !== thread || tabs.get(key(v.instance, v.tabId))?.thread !== thread) throw new Error('This page belongs to another thread, or the panel disconnected.');
    if (cmd === 'panelWindow') {
      v.paused = !!args.shown;
      const own = tabs.get(key(v.instance, v.tabId));
      own.inChrome = v.paused;
      persist();
      if (v.paused) {
        v.capturing = false;
        v.generation++;
        await reset(v);
        await call(v.profile, 'handoff', { tabId: v.tabId });
      }
      return {};
    }
    if (cmd !== 'panelCdp') throw new Error('Unknown panel command.');
    const { method, params = {} } = args;
    if (v.paused) throw new Error("Use Chrome's window, or return it to the panel first.");
    if ((method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') || (method === 'Input.dispatchKeyEvent' && ['keyDown', 'rawKeyDown'].includes(params.type))) v.lastInput = Date.now();
    if (method === 'Page.startScreencast') {
      v.quality = Math.max(30, Math.min(85, Number(params.quality) || 80));
      if (!v.capturing) { v.capturing = true; capture(v, ++v.generation); }
      return {};
    }
    if (method === 'Page.stopScreencast') {
      v.capturing = false;
      v.generation++;
      clearTimeout(v.timer);
      return {};
    }
    if (method === 'Page.handleJavaScriptDialog') {
      try { return await send(v, method, params); }
      catch (e) {
        if (/no dialog is showing/i.test(e.message)) { clearDialog(v.tabId); dialogEnded(v); return {}; }
        suspend(v, e.message);
        throw e;
      }
    }
    if (method === 'Emulation.setDeviceMetricsOverride') {
      v.metrics = params;
      if (!v.resizing) v.resizing = render(v, async () => {
        while (!v.stopped && !v.paused && !v.dialog && v.appliedMetrics !== v.metrics) {
          const latest = v.metrics;
          await send(v, method, latest);
          v.appliedMetrics = latest;
        }
        return {};
      }).finally(() => { v.resizing = null; });
      return v.resizing;
    }
    if (!METHODS.has(method)) throw new Error(`${method} is not a panel command.`);
    // Chromium can wedge a renderer when its viewport changes during a
    // screenshot. Only rendering changes wait here; input and dialog answers
    // must still be able to pass an in-flight frame.
    if (method.startsWith('Emulation.') || method === 'Page.navigate' || method === 'Page.reload') return render(v, () => send(v, method, params));
    return send(v, method, params);
  }

  return { remember, state,
    async prepareHandoff(tabId, instance) {
      const own = ownTab(tabId, instance);
      const profile = own && profileFor(own);
      if (!profile || own.inChrome || own.suspended) return false;
      try {
        const tab = (await call(profile, 'tabs', {}, 5000)).find(t => t.tabId === tabId);
        if (!tab || (!tab.agent && !own.consent)) return false;
        const { targetInfo } = await send(own, 'Target.getTargetInfo');
        if (!targetInfo?.targetId || (own.targetId && own.targetId !== targetInfo.targetId)) return false;
        own.targetId = targetInfo.targetId;
        verified.add(key(instance, tabId));
        persist();
        return true;
      } catch { return false; }
    },
    hasViewer(tabId, instance) { return [...viewers.values()].some(v => v.tabId === tabId && v.instance === instance && !v.paused && !v.stopped); },
    handedOff(tabId, instance, inChrome = false) { const t = ownTab(tabId, instance); if (t) { t.handoffs++; t.handoffAt = Date.now(); t.inChrome = inChrome; persist(); } },
    forget(tabId, instance) { tabs.delete(key(instance, tabId)); persist(); for (const v of viewers.values()) if (v.tabId === tabId && v.instance === instance) release(v); },
    event(profile, msg) {
      for (const v of viewers.values()) {
        if (v.instance !== profile.instance || v.tabId !== msg.tabId || v.paused || v.stopped) continue;
        if (msg.event === 'dialog') {
          v.dialog = true;
          v.generation++;
          clearTimeout(v.timer);
          v.conn.write(line({ method: 'Page.javascriptDialogOpening', params: msg.params }));
        }
        if (msg.event === 'dialogClosed') dialogEnded(v);
        // Detaching already clears emulation. Reattaching to clean up would
        // overrule Chrome's Stop button or interrupt a password manager.
        if (msg.event === 'detached') {
          const own = tabs.get(key(v.instance, v.tabId));
          if (own) { own.suspended = true; persist(); }
          v.conn.write(line({ method: 'panelError', params: { message: 'Chrome disconnected this page. Choose Reconnect to use it here again.' } }));
          release(v, false);
        }
      }
    },
    dispatch(conn, msg) {
      // Only wait for attachment. Serialising every response deadlocks a
      // click that opens an alert: its answer has to pass the pending click.
      if (msg.cmd === 'panelAttach') {
        const ready = handle(conn, msg);
        attaching.set(conn, ready);
        return ready;
      }
      if (msg.cmd === 'panelResume' || msg.cmd === 'panelShowChrome') return handle(conn, msg);
      return (attaching.get(conn) || Promise.resolve()).then(() => handle(conn, msg));
    },
    disconnected(instance) {
      for (const own of tabs.values()) if (own.instance === instance) {
        verified.delete(key(instance, own.tabId));
        if (!own.targetId) tabs.delete(key(instance, own.tabId));
      }
      for (const v of viewers.values()) if (v.instance === instance) {
        const own = tabs.get(key(v.instance, v.tabId));
        if (own) own.suspended = true;
        v.conn.write(line({ method: 'panelError', params: { message: 'This Chrome profile disconnected. Choose Reconnect once it is available.' } }));
        release(v, false);
      }
      persist();
    },
    async close() { await Promise.all([...viewers.values()].map(v => release(v))); },
  };
}
