// Plain type in real headless Chrome, on fields that ignore inserted text. On
// eToro's order panel (2 Nov) type "600" left the amount empty and said
// "(no change)", while key 6, 0, 0 worked: a silent no-op on a money field.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { CHROME, headlessChrome, startBear } from './harness.mjs';

const PAGE = `<!doctype html><title>Order</title>
<form id="f">
<label>masked <input id="masked" inputmode="decimal"></label>
<label>resets <input id="resets"></label>
<label>dead <input id="dead"></label>
<label>short <input id="short" maxlength="2"></label>
<label>commas <input id="commas"></label>
<label>plain <input id="plain" value="x"></label>
<label>box1 <input id="box1"></label>
<label>box2 <input id="box2"></label>
<button>Send</button>
</form>
<script>
// A masked amount: it does its own typing from keydown, and cancels the rest.
// A keyCode of 46 is Delete, not a full stop, whatever e.key says.
masked.addEventListener('beforeinput', (e) => e.preventDefault());
masked.addEventListener('keydown', (e) => {
  if (e.keyCode === 46 || e.metaKey) return;
  if (/^[0-9.]$/.test(e.key)) masked.value += e.key;
});
// Only believes input that came with a key press.
let keyed = false, kept = '';
resets.addEventListener('keydown', () => { keyed = true; });
resets.addEventListener('input', () => { if (keyed) kept = resets.value; else resets.value = kept; keyed = false; });
dead.addEventListener('beforeinput', (e) => e.preventDefault());
commas.addEventListener('input', () => { commas.value = Number(commas.value.replace(/,/g, '')).toLocaleString('en-US'); });
// A code box that moves on as soon as it has a digit.
box1.addEventListener('input', () => box2.focus());
window.submits = 0;
f.addEventListener('submit', (e) => { e.preventDefault(); window.submits++; });
</script>`;

test('type gets the text in, or says it did not', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;

  const send = await headlessChrome(t);
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  const value = async (expression) => (await page('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  for (let i = 0; i < 50 && (await value('document.readyState')) !== 'complete'; i++) await new Promise((r) => setTimeout(r, 100));

  const { browserbear } = await startBear(t, async ({ op, args }) => {
    if (op === 'tabs') return [{ tabId: 1, url, title: 'Order', active: true }];
    if (op === 'cdp') return page(args.method, args.params);
    throw new Error(`unexpected op ${op}`);
  });
  const snap = await browserbear('snap', '1');
  const ref = (name) => snap.match(new RegExp(`(e\\d+) \\w+ "${name}"`))[1];
  const type = (name, text, ...flags) => browserbear('type', '1', ref(name), text, ...flags);

  // Falls back to real keys, says so, and a full stop is a full stop.
  assert.match(await type('masked', '12.5'), /real key presses/);
  assert.equal(await value('masked.value'), '12.5');

  // Input that comes without a key press gets thrown out.
  assert.match(await type('resets', '600'), /real key presses/);
  assert.equal(await value('resets.value'), '600');

  // --replace falls back the same way.
  await type('resets', '42', '--replace');
  assert.equal(await value('resets.value'), '42');

  // Nothing gets in at all: an error, and no submit.
  await assert.rejects(type('dead', '600', '--submit'), /field still holds "", so "600" didn't go in/);
  assert.equal(await value('window.submits'), 0);

  // Some of it got in.
  await assert.rejects(type('short', '600'), /field holds "60"/);

  // The page's own formatting is fine, and so is typing onto what's there.
  assert.doesNotMatch(await type('commas', '1234'), /real key presses/);
  assert.equal(await value('commas.value'), '1,234');
  await type('plain', 'yz');
  assert.match(await value('plain.value'), /^(xyz|yzx)$/);

  // Focus moving on isn't the text being ignored: it isn't typed again.
  await value('box1.focus()');
  await browserbear('type', '1', '-', '7');
  assert.equal(await value('box1.value'), '7');
  assert.equal(await value('box2.value'), '');
});
