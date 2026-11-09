// har against a real headless Chrome's Network events: a redirect, a 404, a
// fetch with a body, and a host that doesn't resolve.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { CHROME, startBear } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// headlessChrome() in the harness drops CDP events; this keeps them.
async function chromeWithEvents(t, onEvent) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browserbear-chrome-'));
  const chrome = spawn(CHROME, ['--headless', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  t.after(async () => {
    const gone = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await gone;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const read = () => (fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8').split('\n') : []);
  for (let i = 0; i < 100 && !read()[1]; i++) await sleep(100);
  const [port, wsPath] = read();
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  t.after(() => ws.close());
  let next = 1;
  const waiting = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (!msg.id) return onEvent(msg);
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    msg.error ? w?.reject(new Error(msg.error.message)) : w?.resolve(msg.result);
  };
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
}

const PAGE = `<!doctype html><title>Shop</title><img src="/missing.png"><img src="http://no-such-host.invalid/x.png">
<script>fetch('/api', { method: 'POST', body: JSON.stringify({ item: 1 }) }).then(() => { document.title = 'Done'; });</script>`;

test('har saves what a real page loaded', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/old') return res.writeHead(302, { location: '/' }).end();
    if (req.url === '/api') return res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=abc' }).end('{"ok":true}');
    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    res.writeHead(404).end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  let recording = false;
  let forward = () => {};
  let sessionId;
  const send = await chromeWithEvents(t, (m) => {
    if (recording && m.sessionId === sessionId && m.method.startsWith('Network.')) forward(m.method, m.params);
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  const page = (method, params) => send(method, params, sessionId);

  const { browserbear, fromExtension } = await startBear(t, async ({ op, args }) => {
    if (op === 'tabs') return [{ tabId: 1, url: base, title: 'Shop', active: true, agent: true, bear: true }];
    if (op === 'mark') return true;
    if (op === 'record') {
      recording = args.on;
      if (args.on) await page('Network.enable', { maxPostDataSize: 65536 });
      return true;
    }
    if (op === 'cdp') return page(args.method, args.params);
    throw new Error(`unexpected op ${op}`);
  });
  forward = (method, params) => fromExtension({ type: 'event', event: 'net', tabId: 1, method, params });

  await browserbear('har', '1', 'start');
  await page('Page.navigate', { url: `${base}/old` });
  for (let i = 0; i < 50; i++) {
    const { result } = await page('Runtime.evaluate', { expression: 'document.title' });
    if (result.value === 'Done') break;
    await sleep(100);
  }
  await sleep(1000); // the failed host lookup and the events' trip through the host

  const dir = fs.mkdtempSync(path.join('/tmp', 'bb-har-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'shop.har');
  const out = await browserbear('har', '1', 'stop', file, '--bodies');
  const { entries } = JSON.parse(fs.readFileSync(file, 'utf8')).log;
  const find = (re, status) => entries.find((e) => re.test(e.request.url) && (status === undefined || e.response.status === status));

  assert.ok(find(/\/old$/, 302), 'the redirect hop');
  assert.equal(find(/\/old$/, 302).response.redirectURL, '/');
  const doc = find(/:\d+\/$/, 200);
  assert.ok(doc, 'the page it redirected to');
  assert.match(doc.response.content.text, /<title>Shop/);
  assert.ok(doc.time >= 0 && doc.startedDateTime.startsWith('20'));
  assert.ok(find(/missing\.png$/, 404));
  const api = find(/\/api$/, 200);
  assert.equal(api.request.method, 'POST');
  assert.equal(api.request.postData.text, '{"item":1}');
  assert.equal(api.response.content.text, '{"ok":true}');
  assert.ok(api.response.headers.some((h) => /set-cookie/i.test(h.name) && h.value === '(removed)'));
  assert.ok(entries.find((e) => /no-such-host/.test(e.request.url))?._error, 'the host that did not resolve');
  assert.match(out, /404 GET .*missing\.png/);
});
