// A ref whose element the page has swapped out (a re-render) fails straight
// away with what it was, and the page as it is now, rather than a script click
// on a detached element that did nothing. After opencode Browse's #214.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { CHROME, headlessChrome, startBear } from './harness.mjs';

const PAGE = `<!doctype html><title>Shop</title><h1>Shop</h1>
<div id="bar"><button>Cart</button></div>
<button id="rerender" onclick="document.getElementById('bar').innerHTML = '<button>Cart</button>'">Re-render</button>
<button id="remove" onclick="document.getElementById('bar').innerHTML = ''">Remove</button>
<input aria-label="Search">`;

test('an action on a ref the page has re-rendered fails fast and says what to use now', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
  const send = await headlessChrome(t);
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (let i = 0; i < 50; i++) {
    const { result } = await send('Runtime.evaluate', { expression: 'document.readyState' }, sessionId);
    if (result.value === 'complete') break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const { browserbear } = await startBear(t, async ({ op, args }) => {
    if (op === 'tabs') return [{ tabId: 1, url, title: 'Shop', active: true, agent: true, bear: true }];
    if (op === 'show') return { tabId: 1, url, title: 'Shop', active: true };
    if (op === 'cdp') return send(args.method, args.params, sessionId);
    if (op === 'frames' || op === 'mark') return op === 'frames' ? [] : true;
    throw new Error(`unexpected op ${op}`);
  });
  const refOf = (snap, name) => snap.match(new RegExp(`(e\\d+) \\w+ "${name}"`))[1];

  const snap = await browserbear('snap', '1', '--full');
  const cart = refOf(snap, 'Cart');
  // Swapped for an identical button: the old ref is stale, and the new one is named.
  await browserbear('click', '1', refOf(snap, 'Re-render'));
  const started = Date.now();
  const err = await browserbear('click', '1', cart).then(() => null, (e) => e.stderr);
  assert.ok(Date.now() - started < 10_000, 'failed fast');
  assert.match(err, new RegExp(`ref ${cart} \\(button "Cart"\\) is stale: the page removed or re-rendered it; the same button "Cart" is e\\d+ now\\. Nothing was sent\\.`));
  assert.match(err, /tab 1: Shop/);
  const fresh = err.match(/is (e\d+) now/)[1];
  assert.notEqual(fresh, cart);
  // The fresh ref works.
  await browserbear('click', '1', fresh);

  // Gone altogether: no suggestion, and type is refused the same way.
  const now = await browserbear('snap', '1', '--full');
  await browserbear('click', '1', refOf(now, 'Remove'));
  const gone = await browserbear('type', '1', fresh, 'x').then(() => null, (e) => e.stderr);
  assert.match(gone, new RegExp(`ref ${fresh} \\(button "Cart"\\) is stale: the page removed or re-rendered it\\. Nothing was sent\\.`));

  // A ref that's still there is untouched by any of this.
  assert.match(await browserbear('type', '1', refOf(now, 'Search'), 'socks'), /Search/);
});
