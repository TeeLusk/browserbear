// Iframes in snapshots, through the agents' browser host and a real headless
// Chrome (no window: the host finds it already on its port). A frame on the
// page's own site is in the page's debugger session; one from another site
// (localhost against 127.0.0.1) is a session of its own, and so is a frame
// inside that from a third. Clicks and typing go to refs in all of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { CHROME, startBear } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = CHROME.replace(/\/Contents\/MacOS\/.*$/, '');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function headlessOn(t, port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browserbear-frames-'));
  const chrome = spawn(CHROME, ['--headless', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  t.after(async () => {
    const gone = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await gone;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false)) return;
    await sleep(100);
  }
  throw new Error("headless Chrome didn't come up");
}

test('snapshots show what is in iframes, and refs in them can be clicked and typed into', { skip: !fs.existsSync(CHROME) && 'no Chrome', timeout: 90_000 }, async (t) => {
  let port;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const other = `http://localhost:${port}`;
    if (req.url === '/') {
      return res.end(`<title>Shop</title><h1>Checkout</h1><button onclick="document.title='top'">Top button</button>
        <div style="height:700px"></div>
        <iframe src="/same" style="width:400px;height:80px"></iframe>
        <iframe title="Card form" src="${other}/card" style="margin:13px;border:6px solid;padding:4px;width:500px;height:260px"></iframe>
        <iframe src="${other}/pixel" style="width:1px;height:1px"></iframe>`);
    }
    if (req.url === '/same') return res.end(`<button onclick="parent.document.title='same'">Same-site button</button>`);
    if (req.url === '/card') {
      return res.end(`<h2>Card details</h2><div style="height:60px"></div>
        <label>Name on card <input id=name></label>
        <button onclick="document.getElementById('paid').textContent = 'Paid ' + document.getElementById('name').value">Pay</button>
        <p id=paid></p>
        <iframe src="http://[::1]:${port}/verify" style="width:300px;height:60px"></iframe>`);
    }
    if (req.url === '/verify') return res.end(`<button onclick="this.textContent='Verified'">Verify</button>`);
    res.end('');
  });
  await new Promise((r) => server.listen(0, '::', r));
  port = server.address().port;
  t.after(() => server.close());

  const cdpPort = await freePort();
  await headlessOn(t, cdpPort);
  const { browserbear } = await startBear(t, () => true, { BROWSERBEAR_AGENT_PORT: String(cdpPort), BROWSERBEAR_AGENT_APP: APP });

  const opened = await browserbear('open', `http://127.0.0.1:${port}/`, '--profile', 'agent');
  const tab = /tab (\d+)/.exec(opened)[1];
  // The frames can still be loading when the page is.
  let snap = '';
  for (let i = 0; i < 20 && !/Verify/.test(snap); i++) {
    await sleep(300);
    snap = await browserbear('snap', tab, '--full');
  }
  const ref = (name) => new RegExp(`(e\\d+) \\w+ "${name}"`).exec(snap)?.[1];
  assert.match(snap, /\[frame 127\.0\.0\.1:\d+\]\n {2}e\d+ button "Same-site button"/);
  assert.match(snap, /\[frame localhost:\d+\]\n {2}## Card details\n {2}e\d+ textbox "Name on card"\n {2}e\d+ button "Pay"/);
  assert.match(snap, /\n {2}\[frame \[::1\]:\d+\]\n {4}e\d+ button "Verify"/);
  assert.doesNotMatch(snap, /\[frame localhost:\d+\]\n(?! )/, 'the 1px frame with nothing in it is left out');

  // The card frame is below the fold: it's scrolled to, then typed and clicked into.
  await browserbear('type', tab, ref('Name on card'), 'Ada Lovelace');
  const paid = await browserbear('click', tab, ref('Pay'));
  assert.doesNotMatch(paid, /script click/, 'a real click, not the fallback');
  assert.equal(await browserbear('eval', tab, 'document.title'), 'Shop');
  // A frame inside the card frame, from a third site.
  let card = '';
  for (let i = 0; i < 10 && !/Verified/.test(card); i++) {
    if (i === 0) await browserbear('click', tab, ref('Verify'));
    await sleep(200);
    card = await browserbear('snap', tab, '--full');
  }
  assert.match(card, /button "Verified"/);
  assert.match(card, /textbox "Name on card" = "Ada Lovelace"/);

  // The page's own frame still works through the page's session.
  await browserbear('click', tab, ref('Same-site button'));
  assert.equal(await browserbear('eval', tab, 'document.title'), 'same');
});
