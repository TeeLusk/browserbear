// A code split across one-character boxes, in real headless Chrome. On OpenAI's
// device page (5 Nov) type "0CJF-J2ZBZ" into the first of nine boxes left "0"
// there and failed, and the way round it was an eval setting each box by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { CHROME, headlessChrome, startBear } from './harness.mjs';

const boxes = (id, n, attrs = '') => Array.from({ length: n }, (_, i) => `<input id="${id}${i}" ${attrs} aria-label="${id} ${i + 1}">`).join('');
const PAGE = `<!doctype html><title>Device</title>
<style>input { width: 200px } .small input { width: 40px }</style>
<form id="f">
<div class="small">${Array.from({ length: 9 }, (_, i) => `<input id="a${i}" aria-label="Code character ${i + 1} of 9">`).join('')}</div>
<div class="small">${boxes('b', 4, 'maxlength="1"')}</div>
<div class="small">${boxes('c', 4, 'autocomplete="one-time-code"')}</div>
<div class="small">${Array.from({ length: 4 }, (_, i) => `<input id="n${i}" type="number" aria-label="Quantity ${i + 1}">`).join('')}</div>
<div class="small">${boxes('g', 3, 'maxlength="1"')}</div>
<div class="small">${boxes('d', 3, 'maxlength="1"')}</div>
<div class="small">${boxes('e', 3, 'maxlength="1"')}</div>
<div>${Array.from({ length: 2 }, (_, i) => `<input id="q${i}" aria-label="Answer ${i + 1} of 2">`).join('')}</div>
<div class="small">${Array.from({ length: 3 }, (_, i) => `<input id="sort${i}" maxlength="2" aria-label="Sort code ${i + 1} of 3">`).join('')}</div>
<div class="small">${boxes('h', 3, 'maxlength="1"')}</div>
<input id="lone" maxlength="1" aria-label="lone">
<div class="small"><input id="s0" aria-label="s0" maxlength="4"><input id="s1" aria-label="s1" maxlength="4"><input id="s2" aria-label="s2" maxlength="4"><input id="s3" aria-label="s3" maxlength="4"></div>
<button>Send</button>
</form>
<script>
const row = (id) => [...document.querySelectorAll('input[id^=' + id + ']')];
// The usual shape of these: keeps one character, moves focus along by itself,
// and the moving can come a little after the input event.
row('a').forEach((box, i, all) => box.addEventListener('input', () => {
  box.value = box.value.slice(0, 1).toUpperCase();
  setTimeout(() => all[i + 1]?.focus(), 20);
}));
// Does its own typing from keydown and refuses inserted text.
row('c').forEach((box, i, all) => {
  box.addEventListener('beforeinput', (e) => e.preventDefault());
  box.addEventListener('keydown', (e) => { if (/^\\w$/.test(e.key)) { box.value = e.key; all[i + 1]?.focus(); } });
});
// Only takes digits.
row('d').forEach((box) => box.addEventListener('input', () => { box.value = box.value.replace(/\\D/g, ''); }));
// Submits when the last box is filled.
e2.addEventListener('input', () => { location.href = '/done'; });
// Swaps the form out after the first character, for a screen with its own field.
h0.addEventListener('input', () => {
  document.body.innerHTML = '<h1>Your name</h1><input id="next" aria-label="Your name">';
  next.focus();
});
// Verifies by itself and swaps the form for the next screen, with no page load.
g2.addEventListener('input', () => {
  document.body.innerHTML = '<h1>Authorize this device?</h1><button id="auth" autofocus onclick="window.authorized = true">Authorize</button>';
  auth.focus();
});
window.submits = 0;
f.addEventListener('submit', (e) => { e.preventDefault(); window.submits++; });
</script>`;

test('a code split across boxes goes in one character per box', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/done' ? '<!doctype html><title>Done</title><h1>Code accepted</h1><button>Authorize</button>' : PAGE);
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
    if (op === 'tabs') return [{ tabId: 1, url, title: 'Device', active: true }];
    if (op === 'cdp') return page(args.method, args.params);
    throw new Error(`unexpected op ${op}`);
  });
  const snap = await browserbear('snap', '1');
  const ref = (name) => snap.match(new RegExp(`(e\\d+) \\w+ "${name}"`))[1];
  const type = (name, text, ...flags) => browserbear('type', '1', ref(name), text, ...flags);
  const held = (id) => value(`[...document.querySelectorAll('input[id^=${id}]')].map((i) => i.value).join('')`);

  // OpenAI's: the dash is on the page, not in a box, and the page moves focus itself.
  assert.match(await type('Code character 1 of 9', '0cjf-j2zbz'), /split across 9 boxes, so it went in one character per box/);
  assert.equal(await held('a'), '0CJFJ2ZBZ');

  // Again, over what's there.
  await type('Code character 1 of 9', '123456789');
  assert.equal(await held('a'), '123456789');

  // From part-way along the row, and --replace takes the same path.
  await type('Code character 8 of 9', 'XY', '--replace');
  assert.equal(await held('a'), '1234567XY');

  // Marked only by maxlength.
  assert.match(await type('b 1', '4 2 4 2'), /one character per box/);
  assert.equal(await held('b'), '4242');

  // Narrow boxes that say they're a code and ignore inserted text get real keys.
  assert.match(await type('c 1', 'WXYZ'), /one character per box/);
  assert.equal(await held('c'), 'WXYZ');

  // Too long for the row: nothing typed at all, and says why.
  await assert.rejects(type('b 1', '123456'), /split across 4 one-character boxes.*needs 6.*Nothing was typed/s);
  assert.equal(await held('b'), '4242');

  // A row that won't take it says so.
  await assert.rejects(type('d 1', '1x3'), /split across 3 one-character boxes.*hold "13", not "1x3"/s);

  // Not code boxes, so ordinary typing: wide fields numbered "1 of 2", narrow ones
  // of a longer length, a row of small quantity fields, and a one-character box on its own.
  await type('Quantity 1', '12');
  assert.equal(await value('n0.value'), '12');
  assert.equal(await value('n1.value'), '');
  assert.doesNotMatch(await type('Answer 1 of 2', 'hello there'), /boxes/);
  assert.equal(await value('q0.value'), 'hello there');
  // Numbered like a code, but its limit says each one takes more than a character.
  await type('Sort code 1 of 3', '12');
  assert.equal(await value('sort0.value'), '12');
  assert.equal(await value('sort1.value'), '');
  await type('s0', '4111');
  assert.equal(await value('s0.value'), '4111');
  assert.equal(await value('s1.value'), '');
  await assert.rejects(type('lone', 'ab'), /holds "a".*row of one-character boxes, type each character into its own box/s);

  // One character into a full box replaces it, as the errors above suggest doing.
  await type('b 1', '9');
  assert.equal(await held('b'), '9242');

  // Nothing above pressed Enter.
  assert.equal(await value('window.submits'), 0);

  // The screen swaps part-way: the rest doesn't go into the next screen's field.
  const early = await type('h 1', 'abc');
  assert.match(early, /moved on after 1 of 3/);
  assert.equal(await value('next.value'), '');
  await page('Page.navigate', { url });
  for (let i = 0; i < 50 && !(await value('!!window.g2 && document.readyState === "complete"')); i++) await new Promise((r) => setTimeout(r, 100));
  const fresh = await browserbear('snap', '1', '--full');

  // The last box swaps the screen without a page load: --submit doesn't press
  // Enter on the Authorize button that now has focus. Last in this test but one,
  // as it takes the page with it, so the page comes back for the next.
  const swapped = await browserbear('type', '1', fresh.match(/(e\d+) textbox "g 1"/)[1], 'abc', '--submit');
  assert.match(swapped, /Authorize this device/);
  assert.match(swapped, /moved on/);
  assert.equal(await value('window.authorized ?? false'), false);
  await page('Page.navigate', { url });
  for (let i = 0; i < 50 && !(await value('!!window.e2 && document.readyState === "complete"')); i++) await new Promise((r) => setTimeout(r, 100));
  const again = await browserbear('snap', '1', '--full');

  // The last box submits by itself: shows the next page, and --submit doesn't
  // press Enter on it.
  const out = await browserbear('type', '1', again.match(/(e\d+) textbox "e 1"/)[1], 'abc', '--submit');
  assert.match(out, /Code accepted/);
  assert.match(out, /moved on/);
});
