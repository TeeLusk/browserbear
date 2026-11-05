import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startBear } from './harness.mjs';

async function setup(t, { available = true, restricted = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-handoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'tb.mjs');
  const requests = path.join(dir, 'requests');
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'show-panel') { fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args)+'\\n'); console.log(JSON.stringify({available:${available},shown:false,request:{panel:'threadbear.browser'}})); }
else if (args[0] === 'list') console.log(JSON.stringify([{id:'thread-one',title:'Browser work',status:'running'}]));
else console.log('');
`);
  let focused = 0;
  const tab = { tabId: 8, url: 'https://example.com/check', title: 'Check', agent: true, bear: true, status: 'complete' };
  const bear = await startBear(t, async ({ op, args }) => {
    if (op === 'tabs') return [tab];
    if (op === 'open') return tab;
    if (op === 'handoff') { focused++; return tab; }
    if (op === 'mark') return true;
    if (op === 'probe') return {};
    if (op === 'cdp' && args.method === 'Target.getTargetInfo') {
      if (restricted) throw new Error('Cannot attach to this target');
      return { targetInfo: { targetId: 'target-8' } };
    }
    throw new Error(`unexpected ${op}`);
  }, { BROWSERBEAR_TB: fake, THREADBEAR_THREAD_ID: 'thread-one' });
  const rpc = (cmd, args = {}) => new Promise((resolve, reject) => {
    const conn = net.createConnection(path.join(bear.home, 'browserbear.sock'));
    let buffer = '';
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, cmd, args, thread: 'thread-one' })+'\n'));
    conn.on('data', d => { buffer += d; if (buffer.includes('\n')) { conn.end(); const m = JSON.parse(buffer.split('\n')[0]); m.ok ? resolve(m.result) : reject(new Error(m.error)); } });
    conn.on('error', reject);
  });
  return { ...bear, rpc, focused: () => focused, requests: () => fs.existsSync(requests) ? fs.readFileSync(requests, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('handoff queues the Browser panel without an existing viewer or a Chrome focus change', async t => {
  const b = await setup(t);
  // This fake extension opens the page but does not implement its snapshot.
  await assert.rejects(b.rpc('open', { url: 'https://example.com/check', profile: 'me@example.com' }), /couldn't look at it yet/);
  assert.deepEqual(b.requests(), [], 'ordinary work never opens a panel');
  const out = await b.browserbear('handoff', '8');
  assert.match(out, /this thread's Browser panel/);
  assert.match(out, /next open/);
  assert.equal(b.focused(), 0);
  assert.deepEqual(b.requests(), [['show-panel', 'thread-one', 'browser', '--json']]);
  const state = await b.rpc('panelState');
  assert.equal(state.tabs[0].inChrome, false);
  assert.equal(state.tabs[0].state, 'yours');
});

for (const options of [{ available: false }, { restricted: true }]) {
  test(`handoff falls back to Chrome when ${options.restricted ? 'the profile cannot display the tab' : 'the Mac app is unavailable'}`, async t => {
    const b = await setup(t, options);
    assert.match(await b.browserbear('handoff', '8'), /own Chrome window/);
    assert.equal(b.focused(), 1);
    if (options.restricted) assert.deepEqual(b.requests(), []);
  });
}

test('a panel handoff wait completes on Done while the tab stays in BrowserBear’s window', async t => {
  const b = await setup(t);
  const waiting = b.browserbear('handoff', '8', '--wait', '--timeout', '20');
  for (let i = 0; i < 100; i++) {
    if ((await b.rpc('panelState')).tabs[0]?.state === 'yours') break;
    await new Promise(r => setTimeout(r, 20));
  }
  await b.rpc('markDone', { tab: 8 });
  assert.match(await waiting, /clicked Done/);
  assert.equal(b.focused(), 0);
});
