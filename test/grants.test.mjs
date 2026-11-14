// Lent tabs (grants): a tb that fails mustn't end them, lending a tab to a
// second thread tells the first why it stopped working, and a lent tab that's
// hidden is woken like an agent's own (14 Nov: Amazon Ads in thread 83e8134a).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, startBear } from './harness.mjs';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(t, extraEnv = {}) {
  const awake = new Set();
  const emulated = [];
  return startBear(t, ({ op, args }) => {
    if (op === 'tabs') return [{ tabId: 2, url: 'https://ads.example/', title: 'Ads', active: true, agent: false, bear: false }];
    if (op === 'mark') return true;
    if (op === 'cdp') {
      const { tabId, method, params } = args;
      if (method === 'Emulation.setFocusEmulationEnabled') {
        emulated.push(tabId);
        awake.add(tabId);
        return {};
      }
      if (method === 'Runtime.evaluate') {
        const e = params.expression;
        if (e.includes('visibilityState')) return { result: { value: awake.has(tabId) ? 'visible' : 'hidden' } };
        if (e.includes('readyState')) return { result: { value: 'complete' } };
        return { result: { value: 'Campaign editor' } };
      }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [] };
      return {};
    }
    return true;
  }, extraEnv).then((bear) => {
    const ask = (cmd, args) => new Promise((resolve, reject) => {
      const s = net.createConnection(path.join(bear.env.BROWSERBEAR_HOME, 'browserbear.sock'));
      s.on('connect', () => s.write(JSON.stringify({ id: 1, cmd, args }) + '\n'));
      let buf = '';
      s.on('data', (d) => {
        buf += d;
        if (!buf.includes('\n')) return;
        s.end();
        const r = JSON.parse(buf);
        r.ok ? resolve(r.result) : reject(new Error(r.error));
      });
    });
    const asThread = (thread, ...a) => run(process.execPath, [path.join(root, 'cli.mjs'), ...a], { env: { ...bear.env, THREADBEAR_THREAD_ID: thread } }).then((r) => r.stdout.trim());
    return { ...bear, ask, asThread, emulated };
  });
}

const fails = (p, re) => assert.rejects(p, (e) => (assert.match(e.stderr || e.message, re), true));

test("a tb that fails doesn't end a lent tab's grant; a thread gone from two lists does", async (t) => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'bb-tb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mode = path.join(dir, 'mode');
  const tb = path.join(dir, 'tb');
  fs.writeFileSync(mode, 'fail');
  fs.writeFileSync(tb, `#!/bin/sh\ncase "$(cat '${mode}')" in\n  fail) exit 1 ;;\n  empty) echo '[]' ;;\n  live) echo '[{"id":"th-a"},{"id":"th-b"}]' ;;\n  gone) echo '[{"id":"th-b"}]' ;;\nesac\n`, { mode: 0o755 });
  const { browserbear, ask, asThread } = await setup(t, { BROWSERBEAR_TB: tb, BROWSERBEAR_GRANT_SWEEP_MS: '150' });
  await browserbear('allow', 'add', 'localhost');

  await ask('lendTo', { tab: 2, to: 'th-a' });
  await sleep(600); // a few sweeps with tb failing
  fs.writeFileSync(mode, 'empty');
  await sleep(600);
  fs.writeFileSync(mode, 'live');
  await sleep(600);
  assert.match(await asThread('th-a', 'snap', '2'), /tab 2/);

  fs.writeFileSync(mode, 'gone');
  await sleep(800);
  await fails(asThread('th-a', 'snap', '2'), /tab 2 is on ads\.example, which isn't on the sites/);
});

test('lending a tab to a second thread tells the first why it stopped working', async (t) => {
  const { browserbear, ask, asThread } = await setup(t);
  await browserbear('allow', 'add', 'localhost');

  assert.equal((await ask('lendTo', { tab: 2, to: 'th-a' })).previous, null);
  assert.match(await asThread('th-a', 'snap', '2'), /tab 2/);
  assert.equal((await ask('lendTo', { tab: 2, to: 'th-b' })).previous, 'th-a');
  assert.match(await asThread('th-b', 'snap', '2'), /tab 2/);
  await fails(asThread('th-a', 'snap', '2'), /tab 2 isn't lent to this thread any more: the user lent it to another thread \(th-b\)/);
  // A thread it was never lent to just hears it's off the list.
  await fails(asThread('th-c', 'snap', '2'), /tab 2 is on ads\.example, which isn't on the sites/);
  // Lent back: works again for th-a.
  assert.equal((await ask('lendTo', { tab: 2, to: 'th-a' })).previous, 'th-b');
  assert.match(await asThread('th-a', 'snap', '2'), /tab 2/);
});

test('a hidden lent tab is woken, and show wakes it too', async (t) => {
  const { browserbear, ask, asThread, emulated } = await setup(t);
  // Not lent: one of the user's own tabs is left alone.
  assert.equal(await browserbear('read', '2'), 'Campaign editor');
  assert.deepEqual(emulated, []);

  await ask('lendTo', { tab: 2, to: 'th-a' });
  await asThread('th-a', 'show', '2');
  assert.deepEqual(emulated, [2]);
});
