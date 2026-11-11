// Iframes through the real extension in Chrome for Testing, with the service
// in front of it: the extension's ops are called in its service worker for
// each op the service sends. A frame from another site is an auto-attached
// session of the extension's, and stays usable after the extension lets go of
// the tab and attaches again (new session ids). Skipped without Chrome for Testing.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CFT, extensionInChrome, startBear } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the extension shows and works in frames from another site', { skip: !CFT && 'no Chrome for Testing', timeout: 120_000 }, async (t) => {
  let port;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/') {
      return res.end(`<title>Shop</title><h1>Checkout</h1><div style="height:900px"></div>
        <iframe src="http://localhost:${port}/card" style="margin:9px;border:3px solid;width:500px;height:200px"></iframe>`);
    }
    if (req.url === '/card') {
      return res.end(`<h2>Card details</h2><div style="height:50px"></div><label>Name on card <input id=name></label>
        <button onclick="this.textContent = 'Paid by ' + document.getElementById('name').value">Pay</button>`);
    }
    res.end('');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  t.after(() => server.close());

  const inWorker = await extensionInChrome(t);
  const { browserbear } = await startBear(t, ({ op, args }) => inWorker(`ops[${JSON.stringify(op)}](${JSON.stringify(args ?? {})})`));

  const opened = await browserbear('open', `http://127.0.0.1:${port}/`, '--profile', 'Work');
  const tab = /tab (\d+)/.exec(opened)[1];
  let snap = '';
  for (let i = 0; i < 20 && !/Pay/.test(snap); i++) {
    await sleep(300);
    snap = await browserbear('snap', tab, '--full');
  }
  assert.match(snap, /\[frame localhost:\d+\]\n {2}## Card details\n {2}e\d+ textbox "Name on card"\n {2}e\d+ button "Pay"/);
  const ref = (name) => new RegExp(`(e\\d+) \\w+ "${name}`).exec(snap)[1];

  await browserbear('type', tab, ref('Name on card'), 'Ada');
  // The extension lets go (as after 30 s idle) and the frame's session is a new one.
  await inWorker(`ops.detach({ tabId: ${tab} })`);
  const out = await browserbear('click', tab, ref('Pay'));
  assert.doesNotMatch(out, /script click/);
  assert.match(out, /button "Paid by Ada"/);
});
