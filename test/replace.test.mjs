// type --replace in real headless Chrome, on fields that fight it. Webull's API
// key form (1 Nov) turned "stocks-cli" into "stocks-clistocks cli", and the agent
// only noticed by reading the output.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { CHROME, headlessChrome, startBear } from './harness.mjs';

const PAGE = `<!doctype html><title>Form</title>
<form id="f">
<label>plain <input id="plain" value="stocks-cli"></label>
<label>amount <input id="amount" type="number" step="any" value="0.07199999690055847"></label>
<label>notes <textarea id="notes">old</textarea></label>
<div id="rich" contenteditable role="textbox" aria-label="rich"><p>old <b>rich</b></p></div>
<label>snapback <input id="snapback" value="stocks-cli"></label>
<label>noshortcuts <input id="noshortcuts" value="stocks-cli"></label>
<label>rewrites <input id="rewrites" value="old"></label>
<label>secret <input id="secret" type="password" value="hunter2"></label>
<button>Send</button>
</form>
<script>
// Controlled like a React field: emptied, it goes back to the value it had.
let kept = snapback.value;
snapback.addEventListener('input', () => { if (snapback.value) kept = snapback.value; else snapback.value = kept; });
noshortcuts.addEventListener('keydown', (e) => { if (e.metaKey || e.key === 'Backspace') e.preventDefault(); });
// Changes whatever goes in, like a page that re-derives an amount from its state.
for (const el of [rewrites, secret]) el.addEventListener('input', () => { el.value = 'not-what-you-typed'; });
window.submits = 0;
f.addEventListener('submit', (e) => { e.preventDefault(); window.submits++; });
</script>`;

test('type --replace replaces the text, or says it did not', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
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
    if (op === 'tabs') return [{ tabId: 1, url, title: 'Form', active: true }];
    if (op === 'cdp') return page(args.method, args.params);
    throw new Error(`unexpected op ${op}`);
  });
  const snap = await browserbear('snap', '1');
  const ref = (name) => snap.match(new RegExp(`(e\\d+) \\w+ "${name}"`))[1];
  const replace = (name, text, ...flags) => browserbear('type', '1', ref(name), text, '--replace', ...flags);

  for (const [name, text] of [['plain', 'stocks cli'], ['amount', '12.5'], ['notes', 'new'], ['snapback', 'stocks cli'], ['noshortcuts', 'stocks cli']]) {
    await replace(name, text);
    assert.equal(await value(`document.getElementById('${name}').value`), text, name);
  }
  await replace('rich', 'new rich');
  assert.equal(await value('rich.innerText.trim()'), 'new rich');

  // Clearing, with nothing to type in its place.
  await replace('plain', '');
  assert.equal(await value('plain.value'), '');

  // With no ref it's the focused field.
  await value('plain.focus()');
  await browserbear('type', '1', '-', 'by focus', '--replace');
  assert.equal(await value('plain.value'), 'by focus');

  // A field that ends up holding something else fails, and isn't submitted.
  await assert.rejects(replace('rewrites', 'mine', '--submit'), /holds "not-what-you-typed", not "mine"/);
  assert.equal(await value('window.submits'), 0);

  // What a password field holds isn't printed.
  await assert.rejects(replace('secret', 'mine'), (e) => {
    assert.match(e.stderr, /password field/);
    assert.doesNotMatch(e.stderr, /not-what-you-typed/);
    return true;
  });

  // The ordinary case still submits.
  await replace('plain', 'done', '--submit');
  assert.equal(await value('window.submits'), 1);
});
