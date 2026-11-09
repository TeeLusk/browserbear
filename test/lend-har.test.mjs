// Lending a tab from the toolbar popup, and recording a tab's network traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRecorder } from '../service/har.mjs';
import { startBear } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function answer(notices, rid) {
  for (let i = 0; i < 100; i++) {
    const a = notices.find((n) => n.type === 'answer' && n.rid === rid);
    if (a) return a;
    await sleep(50);
  }
  assert.fail(`no answer to ask ${rid}`);
}

test('the toolbar popup lends a tab to a thread, or to a new one', async (t) => {
  // A fake tb that lists two threads and writes down what it was asked.
  const dir = fs.mkdtempSync(path.join('/tmp', 'bb-tb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = path.join(dir, 'calls');
  const tb = path.join(dir, 'tb');
  fs.writeFileSync(path.join(dir, 'list.json'), JSON.stringify([
    { id: 'th-old', title: 'Older thread', status: 'idle', cwd: '/x/old', lastActivityAt: '2026-11-01T00:00:00Z' },
    { id: 'th-new', title: 'Newer thread', status: 'running', cwd: '/x/app', lastActivityAt: '2026-11-09T00:00:00Z' },
  ]));
  fs.writeFileSync(
    tb,
    `#!/bin/sh\nprintf '%s\\0' "$@" >> '${calls}'; printf '\\036' >> '${calls}'\ncase "$1" in\n  list) cat '${dir}/list.json' ;;\n  new) echo 11111111-2222-3333-4444-555555555555 ;;\n  send) echo turn-1 ;;\nesac\n`,
    { mode: 0o755 },
  );
  const tbCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\x1e').filter(Boolean).map((l) => l.split('\0').filter(Boolean)) : []);

  const { browserbear, notices, fromExtension, env } = await startBear(t, ({ op }) => {
    if (op === 'tabs') return [{ tabId: 7, url: 'https://app.example/page', title: 'App page', active: true, agent: false, bear: false }];
    if (op === 'mark') return true;
    if (op === 'cdp') return { nodes: [] };
    return true;
  }, { BROWSERBEAR_TB: tb });

  fromExtension({ type: 'ask', rid: 1, cmd: 'lendable', args: { tabId: 7 } });
  const view = (await answer(notices, 1)).result;
  assert.deepEqual(view.threads.map((x) => x.id), ['th-new', 'th-old']);
  assert.equal(view.threads[0].folder, 'app');
  assert.equal(view.site, 'app.example');
  assert.equal(view.restricted, false);

  // To a thread: it hears which tab, the tab's claimed, and its site is allowed for it.
  await browserbear('allow', 'add', 'localhost');
  fromExtension({ type: 'ask', rid: 2, cmd: 'lend', args: { tabId: 7, thread: 'th-new', text: 'Fix the layout here' } });
  assert.deepEqual((await answer(notices, 2)).result, { thread: 'th-new' });
  const send = tbCalls().find((c) => c[0] === 'send');
  assert.equal(send[1], 'th-new');
  assert.match(send[2], /^Fix the layout here\n\nI've lent you a tab in my Chrome .*tab 7, "App page" <https:\/\/app\.example\/page>.*browserbear snap 7/s);
  assert.match(await browserbear('allow'), /thread th-new: app\.example/);
  // Claimed: an act goes through without --user-tab (the type fails later, on the fake page).
  await assert.rejects(browserbear('key', '7', 'Enter'), (e) => (assert.doesNotMatch(e.stderr, /the user's own/), true));

  // To a new thread, started with the user's words.
  fromExtension({ type: 'ask', rid: 3, cmd: 'lend', args: { tabId: 7, thread: 'new', text: 'Look at this' } });
  assert.deepEqual((await answer(notices, 3)).result, { thread: '11111111-2222-3333-4444-555555555555' });
  const made = tbCalls().find((c) => c[0] === 'new');
  assert.match(made[1], /^Look at this\n\nI've lent you a tab/);
  assert.deepEqual(made.slice(2), ['--from', 'BrowserBear', '--why', 'a tab you lent it']);

  // The popup's switch puts the page's site on every thread's list.
  fromExtension({ type: 'ask', rid: 4, cmd: 'allowSite', args: { tabId: 7, on: true } });
  const after = (await answer(notices, 4)).result;
  assert.equal(after.siteAllowed, true);
  assert.match(await browserbear('allow'), /every thread: localhost, app\.example/);

  fromExtension({ type: 'ask', rid: 5, cmd: 'nope', args: {} });
  assert.match((await answer(notices, 5)).error, /unknown ask/);
  void env;
});

test('har records a tab and saves it, without cookies unless asked', async (t) => {
  const ops = [];
  const { browserbear, fromExtension } = await startBear(t, ({ op, args }) => {
    ops.push([op, args]);
    if (op === 'tabs') return [{ tabId: 4, url: 'https://shop.example/', title: 'Shop', active: true, agent: true, bear: true }];
    if (op === 'mark' || op === 'record') return true;
    if (op === 'cdp' && args.method === 'Network.getResponseBody') return { body: '{"ok":true}', base64Encoded: false };
    return {};
  });
  assert.match(await browserbear('har', '4', 'start'), /recording tab 4's network traffic/);
  assert.deepEqual(ops.find(([op]) => op === 'record')[1], { tabId: 4, on: true });
  const net = (method, params) => fromExtension({ type: 'event', event: 'net', tabId: 4, method, params });
  net('Network.requestWillBeSent', { requestId: 'a', timestamp: 10, wallTime: 1_762_700_000, type: 'Document', request: { method: 'GET', url: 'https://shop.example/', headers: { Cookie: 'sid=secret' } } });
  net('Network.responseReceived', { requestId: 'a', response: { status: 200, statusText: 'OK', headers: { 'Set-Cookie': 'sid=new' }, mimeType: 'text/html', protocol: 'h2' } });
  net('Network.loadingFinished', { requestId: 'a', timestamp: 10.25, encodedDataLength: 1234 });
  net('Network.requestWillBeSent', { requestId: 'b', timestamp: 10.3, wallTime: 1_762_700_000.3, type: 'Fetch', request: { method: 'POST', url: 'https://shop.example/api/cart?x=1', headers: {}, postData: '{"item":1}', hasPostData: true } });
  net('Network.responseReceived', { requestId: 'b', response: { status: 500, statusText: 'Server Error', headers: {}, mimeType: 'application/json' } });
  net('Network.loadingFinished', { requestId: 'b', timestamp: 10.4, encodedDataLength: 20 });
  net('Network.requestWillBeSent', { requestId: 'c', timestamp: 10.5, wallTime: 1_762_700_000.5, type: 'Image', request: { method: 'GET', url: 'https://cdn.example/x.png', headers: {} } });
  net('Network.loadingFailed', { requestId: 'c', timestamp: 10.6, errorText: 'net::ERR_NAME_NOT_RESOLVED' });
  await sleep(200);
  assert.match(await browserbear('har', '4', 'status'), /3 requests/);

  const dir = fs.mkdtempSync(path.join('/tmp', 'bb-har-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'out.har');
  const out = await browserbear('har', '4', 'stop', file, '--bodies');
  assert.match(out, new RegExp(`^${file}\\n3 requests \\(shop\\.example 2, cdn\\.example 1\\), 2 failed or 4xx/5xx`));
  assert.match(out, /500 POST https:\/\/shop\.example\/api\/cart\?x=1/);
  assert.match(out, /net::ERR_NAME_NOT_RESOLVED GET https:\/\/cdn\.example\/x\.png/);
  assert.deepEqual(ops.filter(([op]) => op === 'record').at(-1)[1], { tabId: 4, on: false });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const har = JSON.parse(fs.readFileSync(file, 'utf8'));
  const [a, b, c] = har.log.entries;
  assert.equal(a.request.headers[0].value, '(removed)');
  assert.equal(a.response.headers[0].value, '(removed)');
  assert.equal(a.time, 250);
  assert.equal(a.response.content.text, '{"ok":true}');
  assert.equal(b.request.postData.text, '{"item":1}');
  assert.deepEqual(b.request.queryString, [{ name: 'x', value: '1' }]);
  assert.equal(c.response.status, 0);
  assert.equal(c._error, 'net::ERR_NAME_NOT_RESOLVED');
  await assert.rejects(browserbear('har', '4', 'stop'), (e) => (assert.match(e.stderr, /isn't recording/), true));
});

test('a redirect is its own entry, and --raw keeps cookies', () => {
  const rec = createRecorder({ tabId: 1, url: 'https://a.example/' });
  rec.on('Network.requestWillBeSent', { requestId: 'r', timestamp: 1, wallTime: 1_700_000_000, request: { method: 'GET', url: 'http://a.example/', headers: { Cookie: 'k=v' } } });
  rec.on('Network.requestWillBeSent', { requestId: 'r', timestamp: 1.1, wallTime: 1_700_000_000.1, redirectResponse: { status: 301, statusText: 'Moved', headers: { Location: 'https://a.example/' } }, request: { method: 'GET', url: 'https://a.example/', headers: {} } });
  rec.on('Network.responseReceived', { requestId: 'r', response: { status: 200, statusText: 'OK', headers: {} } });
  rec.on('Network.loadingFinished', { requestId: 'r', timestamp: 1.3, encodedDataLength: 10 });
  const har = rec.build({ raw: true });
  assert.equal(har.log.entries.length, 2);
  assert.equal(har.log.entries[0].response.status, 301);
  assert.equal(har.log.entries[0].response.redirectURL, 'https://a.example/');
  assert.equal(har.log.entries[0].request.headers[0].value, 'k=v');
  assert.equal(har.log.entries[1].response.status, 200);
  assert.deepEqual(rec.finished(), ['r']);
});
