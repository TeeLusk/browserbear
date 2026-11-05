// Plain type into rich editors (contenteditable), in real headless Chrome. On
// Ordinal's Tiptap captions (5 Nov), focus, Meta+a, then type - "His favorite
// number is e" left the caption saying it twice: the editor showed the inserted
// text late, type took it as ignored and typed it again as real keys. These
// editors stand in for ProseMirror's ways of taking input, without needing it
// off the network: `late` puts text in a moment after it's given, `twice` puts
// each insert in twice, `fickle` throws focus to another editor instead, and
// `slow` takes real keys at once but inserted text only after a long wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { CHROME, headlessChrome, startBear } from './harness.mjs';

const PAGE = `<!doctype html><title>Captions</title>
<div id="late" contenteditable aria-label="late"><p><br></p></div>
<div id="twice" contenteditable aria-label="twice"><p><br></p></div>
<div id="fickle" contenteditable aria-label="fickle"><p><br></p></div>
<div id="other" contenteditable aria-label="other"><p><br></p></div>
<div id="slow" contenteditable aria-label="slow"><p><br></p></div>
<input id="same" aria-label="same" value="hello">
<div id="decor" contenteditable aria-label="decor"><p><br></p></div>
<script>
// Each editor keeps its own model and draws it, as ProseMirror does.
const draw = (el, text) => { el.innerHTML = text ? '<p>' + text + '</p>' : '<p><br></p>'; };
const model = { late: '', twice: '' };
const take = (el, apply) => el.addEventListener('beforeinput', (e) => {
  e.preventDefault();
  if (e.inputType === 'insertText') apply(e.data);
});
take(late, (data) => setTimeout(() => { model.late += data; draw(late, model.late); }, 900));
take(twice, (data) => { model.twice += data + data; draw(twice, model.twice); });
take(fickle, () => other.focus());
// Inserted text very late (after type's wait, before its check on the keys), but
// real keys straight away.
let slowText = '';
slow.addEventListener('beforeinput', (e) => {
  e.preventDefault();
  if (e.inputType !== 'insertText') return;
  const add = () => { slowText += e.data; draw(slow, slowText); };
  if (e.data.length > 1) setTimeout(add, 3500); else add();
});
// Ignores inserted text but redraws a decoration as it does, and takes keys.
let decorText = '';
decor.addEventListener('beforeinput', (e) => {
  e.preventDefault();
  if (e.data?.length > 1) { decor.querySelector('.badge')?.remove(); decor.insertAdjacentHTML('beforeend', '<span class="badge">!</span>'); }
});
decor.addEventListener('keydown', (e) => { if (e.key.length === 1 && !e.metaKey) { decorText += e.key; decor.innerHTML = '<p>' + decorText + '</p>'; } });
window.reset = () => { model.late = model.twice = slowText = decorText = ''; for (const el of [late, twice, fickle, other, slow, decor]) draw(el, ''); };
</script>`;

test('type puts text into a rich editor once, and says what it holds', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
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
    if (op === 'tabs') return [{ tabId: 1, url, title: 'Captions', active: true }];
    if (op === 'cdp') return page(args.method, args.params);
    throw new Error(`unexpected op ${op}`);
  });
  // The steps from Ordinal: focus by script, select all, type into what's focused.
  const typeInto = async (id, text) => {
    await value(`reset(); ${id}.focus(); true`);
    await browserbear('key', '1', 'Meta+a');
    return browserbear('type', '1', '-', text);
  };
  const caption = 'His favorite number is e';

  // Late to show it: waited for, not typed again, and what it holds is said.
  const out = await typeInto('late', caption);
  assert.equal(await value('late.innerText.trim()'), caption);
  assert.doesNotMatch(out, /real key presses/);
  assert.match(out, /the field now holds "His favorite number is e"/);

  // In twice: an error that shows the doubled text, not a quiet success.
  await assert.rejects(typeInto('twice', caption), /went in more than once, and the field now holds "His favorite number is eHis favorite number is e"/);

  // Focus moved to another editor: no keys typed into it on top.
  await assert.rejects(typeInto('fickle', caption), /focus had moved off it/);
  assert.equal(await value('other.innerText.trim()'), '');
  assert.equal(await value('fickle.innerText.trim()'), '');

  // Later still, after keys have gone in: caught as doubled, not a success.
  await assert.rejects(typeInto('slow', 'abc'), /went in more than once/);

  // The same text over a selection of it changes nothing, and isn't typed again.
  await value('same.focus(); same.select(); true');
  await browserbear('type', '1', '-', 'hello');
  assert.equal(await value('same.value'), 'hello');

  // A redraw that doesn't bring the text isn't the text going in: keys follow.
  assert.match(await typeInto('decor', 'abc'), /real key presses/);
  assert.equal(await value('decor.innerText.trim()'), 'abc');

  // Doubled over a selection of what was there: still a double.
  await value(`reset(); model.twice = 'abc'; draw(twice, 'abc'); twice.focus(); true`);
  await browserbear('key', '1', 'Meta+a');
  await assert.rejects(browserbear('type', '1', '-', 'abc'), /went in more than once/);

  // Punctuation alone, in twice, is caught too.
  await assert.rejects(typeInto('twice', '!!'), /went in more than once/);
});
