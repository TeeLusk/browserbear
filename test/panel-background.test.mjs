import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { CFT, extensionInChrome } from './harness.mjs';
import { createPanel } from '../service/panel.mjs';

test('two panels capture and accept input in background tabs, and an alert survives the idle timeout', { skip: !CFT }, async t => {
  const server = http.createServer((_, res) => res.end('<button style="width:100px;height:80px" onclick="this.textContent=++window.clicks">Click</button><script>window.clicks=0</script>'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const worker = await extensionInChrome(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-real-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = { instance: 'test' };
  const call = (_, op, args) => {
    let timer;
    return Promise.race([
      worker(`ops[${JSON.stringify(op)}](${JSON.stringify(args)})`),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${op} ${args.method || ''} timed out`)), 8000); }),
    ]).finally(() => clearTimeout(timer));
  };
  const panel = createPanel({ home, profiles: () => [profile], call, mark: () => ({}) });
  t.after(() => panel.close());
  const clients = [];
  for (let i = 0; i < 2; i++) {
    const id = await worker(`chrome.tabs.create({url:${JSON.stringify(url)}}).then(t=>t.id)`);
    await new Promise(r => setTimeout(r, 400));
    panel.remember(id, `thread-${i}`, 'test', true);
    const conn = new EventEmitter();
    let frames = 0;
    conn.write = line => { const m = JSON.parse(line); if (m.method === 'Page.screencastFrame') frames++; assert.notEqual(m.method, 'panelError', m.params?.message); return true; };
    const send = (cmd, args = {}) => panel.dispatch(conn, { cmd, args, thread: `thread-${i}` });
    await send('panelResume', { tab: id });
    await send('panelAttach', { tab: id });
    await send('panelCdp', { method: 'Emulation.setDeviceMetricsOverride', params: { width: 360, height: 600, deviceScaleFactor: 1, mobile: false } });
    await send('panelCdp', { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } });
    await send('panelCdp', { method: 'Page.startScreencast' });
    clients.push({ id, send, frames: () => frames });
  }
  t.diagnostic('both viewers attached');
  await worker("chrome.tabs.create({url:'about:blank'})"); // both viewed pages are hidden
  for (let round = 0; round < 4; round++) {
    const before = clients.map(c => c.frames());
    await new Promise(r => setTimeout(r, 10000));
    for (const [i, c] of clients.entries()) {
      assert.ok(c.frames() > before[i], 'hidden tabs keep producing frames');
      const start = Date.now();
      await c.send('panelCdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 40, y: 40, button: 'left', buttons: 1, clickCount: 1 } });
      await c.send('panelCdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 40, y: 40, button: 'left', buttons: 0, clickCount: 1 } });
      assert.ok(Date.now() - start < 5000, 'background input responds promptly');
    }
    t.diagnostic(`background round ${round + 1} passed`);
  }
  for (const c of clients) {
    const r = await call(profile, 'cdp', { tabId: c.id, method: 'Runtime.evaluate', params: { expression: 'window.clicks', returnByValue: true } });
    assert.equal(r.result.value, 4);
  }
  const c = clients[0];
  await c.send('panelCdp', { method: 'Page.stopScreencast' });
  await new Promise(r => setTimeout(r, 200));
  await call(profile, 'cdp', { tabId: c.id, method: 'Runtime.evaluate', params: { expression: 'setTimeout(()=>alert("Panel alert"), 10); true' } });
  panel.event(profile, { event: 'dialog', tabId: c.id, params: { type: 'alert', message: 'Panel alert' } });
  await c.send('panelCdp', { method: 'Page.startScreencast' });
  await new Promise(r => setTimeout(r, 35000));
  await c.send('panelCdp', { method: 'Page.handleJavaScriptDialog', params: { accept: true } });
  panel.event(profile, { event: 'dialogClosed', tabId: c.id });
  const before = c.frames();
  await new Promise(r => setTimeout(r, 500));
  assert.ok(c.frames() > before, 'capture resumes after the long-lived alert');
});
