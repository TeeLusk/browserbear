// Annotate a page for a Threadbear thread: started from the toolbar popup or
// the Browser panel, attached from the overlay, handed to Threadbear as a file
// and a threadbear:// link that puts it in the thread's message box.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startBear } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const annotation = { url: 'http://localhost:5173/', title: 'App', comment: 'Make this bigger', elements: [], regions: [{ x: 1, y: 2, width: 30, height: 40 }], strokes: [], viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 } };

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annotate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opened = path.join(dir, 'opened');
  const opener = path.join(dir, 'open');
  fs.writeFileSync(opener, `#!/bin/sh\necho "$1" >> '${opened}'\n`, { mode: 0o755 });
  const tb = path.join(dir, 'tb');
  fs.writeFileSync(tb, `#!/bin/sh\ncase "$1" in list) echo '[{"id":"thread-one","title":"Fix the app"}]' ;; esac\n`, { mode: 0o755 });
  const ops = [];
  const tab = { tabId: 7, url: 'http://localhost:5173/', title: 'App', active: true, agent: false, bear: false, status: 'complete' };
  const bear = await startBear(t, async ({ op, args }) => {
    ops.push({ op, args });
    if (op === 'tabs') return [tab];
    if (op === 'annotate') return { tabId: args.tabId, url: tab.url };
    if (op === 'mark' || op === 'detach') return true;
    if (op === 'cdp') return {};
    throw new Error(`unexpected ${op}`);
  }, { BROWSERBEAR_TB: tb, BROWSERBEAR_OPEN: opener });
  let rid = 100;
  const ask = async (cmd, args) => {
    const id = rid++;
    bear.fromExtension({ type: 'ask', rid: id, cmd, args });
    for (let i = 0; i < 100; i++) {
      const a = bear.notices.find((n) => n.type === 'answer' && n.rid === id);
      if (a) return a;
      await sleep(50);
    }
    assert.fail(`no answer to ${cmd}`);
  };
  const rpc = (cmd, args = {}, thread = 'thread-one') => new Promise((resolve, reject) => {
    const conn = net.createConnection(path.join(bear.home, 'browserbear.sock'));
    let buffer = '';
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, cmd, args, thread }) + '\n'));
    conn.on('data', (d) => { buffer += d; if (buffer.includes('\n')) { conn.end(); const m = JSON.parse(buffer.split('\n')[0]); m.ok ? resolve(m.result) : reject(new Error(m.error)); } });
    conn.on('error', reject);
  });
  const openedLinks = () => (fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8').trim().split('\n') : []);
  return { ...bear, ask, rpc, ops, openedLinks };
}

test('the popup annotates a tab for a thread, and Attach opens it in Threadbear', async (t) => {
  const b = await setup(t);
  const started = await b.ask('annotate', { tabId: 7, thread: 'thread-one', title: 'Fix the app' });
  assert.equal(started.ok, true, started.error);
  const { sessionId } = started.result;
  const op = b.ops.find((o) => o.op === 'annotate');
  assert.deepEqual(op.args, { tabId: 7, sessionId, threadTitle: 'Fix the app' });

  const done = await b.ask('annotated', { tabId: 7, sessionId, annotation, png: PNG });
  assert.equal(done.ok, true, done.error);
  assert.deepEqual(b.openedLinks(), [`threadbear://thread/thread-one?annotation=${sessionId}`]);
  const dir = path.join(b.home, 'annotations');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, `${sessionId}.json`), 'utf8'));
  assert.deepEqual(saved, { thread: 'thread-one', annotation, screenshot: true });
  assert.deepEqual(fs.readFileSync(path.join(dir, `${sessionId}.png`)), Buffer.from('iVBORw0KGgo=', 'base64'));
  assert.equal(fs.statSync(path.join(dir, `${sessionId}.json`)).mode & 0o777, 0o600);

  // Once only.
  const again = await b.ask('annotated', { tabId: 7, sessionId, annotation, png: PNG });
  assert.match(again.error, /has ended/);
});

test("an annotation from another tab, a cancelled one or one too big isn't taken", async (t) => {
  const b = await setup(t);
  const { sessionId } = (await b.ask('annotate', { tabId: 7, thread: 'thread-one' })).result;
  assert.match((await b.ask('annotated', { tabId: 8, sessionId, annotation })).error, /has ended/);
  assert.match((await b.ask('annotated', { tabId: 7, sessionId, annotation: { comment: 'x'.repeat(600_000) } })).error, /too big/);
  b.fromExtension({ type: 'event', event: 'annotation', action: 'cancel', tabId: 7, sessionId });
  await sleep(200);
  assert.match((await b.ask('annotated', { tabId: 7, sessionId, annotation })).error, /has ended/);
  assert.deepEqual(b.openedLinks(), []);
  assert.match((await b.ask('annotate', { tabId: 7, thread: '../../etc' })).error, /which thread/);
});

test("the Browser panel's Annotate works on the thread's own page only", async (t) => {
  const b = await setup(t);
  // Lend the tab so it's this thread's page in the panel.
  b.fromExtension({ type: 'ask', rid: 1, cmd: 'lend', args: { tabId: 7, thread: 'thread-one' } });
  await sleep(500);
  const instance = (await b.rpc('panelState')).tabs[0].profile;
  await assert.rejects(b.rpc('panelAnnotate', { tab: 7, profile: instance }, 'thread-two'), /another thread/);
  const r = await b.rpc('panelAnnotate', { tab: 7, profile: instance, title: 'Fix the app' });
  assert.equal(r.thread, 'thread-one');
  assert.ok(b.ops.some((o) => o.op === 'annotate' && o.args.sessionId === r.sessionId));
});
