// Handoffs bring the page's real window forward, and Threadbear's Browser
// panel lists a thread's pages with a still and a Show window button (8 Nov
// 2026: no more pages streamed into the panel).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startBear } from './harness.mjs';

async function setup(t, { agents = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-handoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'tb.mjs');
  const requests = path.join(dir, 'requests');
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'show-panel') { fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args)+'\\n'); console.log(JSON.stringify({available:true,shown:false,request:{panel:'threadbear.browser'}})); }
else if (args[0] === 'list') console.log(JSON.stringify([{id:'thread-one',title:'Browser work',status:'running'}]));
else console.log('');
`);
  const calls = { handoff: 0, focus: 0, still: 0, screenshot: 0, probe: 0 };
  const tab = { tabId: 8, url: 'https://example.com/check', title: 'Check', agent: true, bear: true, status: 'complete' };
  const bear = await startBear(t, async ({ op, args }) => {
    if (op === 'tabs') return [tab];
    if (op === 'open') return tab;
    if (op === 'mark') return true;
    if (op in calls) calls[op]++;
    if (op === 'handoff' || op === 'focus') return tab;
    if (op === 'probe') return {};
    if (op === 'still') return { data: 'c3RpbGw=', at: Date.now() };
    if (op === 'cdp' && args.method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 } };
    if (op === 'cdp' && args.method === 'Page.captureScreenshot') { calls.screenshot++; return { data: 'c2hvdA==' }; }
    throw new Error(`unexpected ${op} ${args?.method || ''}`);
  }, { BROWSERBEAR_TB: fake, THREADBEAR_THREAD_ID: 'thread-one' });
  const rpc = (cmd, args = {}, thread = 'thread-one') => new Promise((resolve, reject) => {
    const conn = net.createConnection(path.join(bear.home, 'browserbear.sock'));
    let buffer = '';
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, cmd, args, thread })+'\n'));
    conn.on('data', d => { buffer += d; if (buffer.includes('\n')) { conn.end(); const m = JSON.parse(buffer.split('\n')[0]); m.ok ? resolve(m.result) : reject(new Error(m.error)); } });
    conn.on('error', reject);
  });
  const profile = agents ? 'agent-chrome' : 'me@example.com';
  if (agents) bear.fromExtension({ type: 'hello', instance: 'agent-chrome', email: null, name: 'agent', browser: 'Helium', version: 'test' });
  // This fake opens the page but has no snapshot, which is all open complains of.
  await assert.rejects(rpc('open', { url: 'https://example.com/check', profile }), /couldn't look at it yet/);
  return { ...bear, rpc, tab, calls, profile, requests: () => fs.existsSync(requests) ? fs.readFileSync(requests, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test("handoff of a tab in the user's own Chrome brings it forward there, and opens no panel", async t => {
  const b = await setup(t);
  assert.deepEqual(b.requests(), [], 'ordinary work never opens a panel');
  assert.match(await b.browserbear('handoff', '8'), /own Chrome window/);
  assert.equal(b.calls.handoff, 1);
  assert.deepEqual(b.requests(), []);
  const state = await b.rpc('panelState');
  assert.equal(state.tabs[0].state, 'yours');
  assert.equal(state.tabs[0].handoffs, 1);
});

test("handoff in the agents' browser brings its window forward and shows the panel for Done", async t => {
  const b = await setup(t, { agents: true });
  const out = await b.browserbear('handoff', '8');
  assert.match(out, /agents' browser \(Helium\)/);
  assert.match(out, /Done is in this thread's Browser panel/);
  assert.equal(b.calls.handoff, 1);
  assert.deepEqual(b.requests(), [['show-panel', 'thread-one', 'browser', '--json']]);
});

test("a handoff wait in the agents' browser completes on the panel's Done", async t => {
  const b = await setup(t, { agents: true });
  const waiting = b.browserbear('handoff', '8', '--wait', '--timeout', '20');
  for (let i = 0; i < 100; i++) {
    if ((await b.rpc('panelState')).tabs[0]?.state === 'yours') break;
    await new Promise(r => setTimeout(r, 20));
  }
  await b.rpc('markDone', { tab: 8 });
  assert.match(await waiting, /clicked Done/);
});

test('a handoff wait completes when the page reaches its settled destination', async t => {
  const b = await setup(t, { agents: true });
  const waiting = b.browserbear('handoff', '8', '--wait', '--timeout', '20');
  for (let i = 0; i < 100 && !b.calls.probe; i++) await new Promise(r => setTimeout(r, 20));
  b.tab.url = 'https://example.com/finished';
  b.tab.title = 'Finished';
  assert.match(await waiting, /user has finished.*Finished/);
});

test("stills and Show window are only for the page's own thread", async t => {
  const b = await setup(t, { agents: true });
  const still = await b.rpc('panelStill', { tab: 8, profile: 'agent-chrome', width: 320 });
  assert.equal(still.data, 'c3RpbGw=');
  // A second ask within a few seconds gets the same picture.
  await b.rpc('panelStill', { tab: 8, profile: 'agent-chrome' });
  assert.equal(b.calls.still, 1);
  await assert.rejects(b.rpc('panelStill', { tab: 8, profile: 'agent-chrome' }, 'thread-two'), /another thread/);
  await assert.rejects(b.rpc('panelShow', { tab: 8, profile: 'agent-chrome' }, 'thread-two'), /another thread/);
  // The same tab number in another profile isn't this one.
  await assert.rejects(b.rpc('panelStill', { tab: 8, profile: 'someone-else' }), /another thread/);
  await b.rpc('panelShow', { tab: 8, profile: 'agent-chrome' });
  assert.equal(b.calls.focus, 1);
});

test("a still of the user's own Chrome tab, but none once it's handed to them", async t => {
  const b = await setup(t);
  const instance = (await b.rpc('panelState')).tabs[0].profile;
  assert.equal((await b.rpc('panelStill', { tab: 8, profile: instance })).data, 'c2hvdA==');
  assert.equal(b.calls.screenshot, 1);
  await b.browserbear('handoff', '8');
  // Cached, and no debugger on the page while they sign in.
  await b.rpc('panelStill', { tab: 8, profile: instance });
  assert.equal(b.calls.screenshot, 1);
});

test('an older Threadbear panel is told to update', async t => {
  const b = await setup(t);
  await assert.rejects(b.rpc('panelAttach', { tab: 8 }), /older Threadbear/);
});
