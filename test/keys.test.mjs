// Real keys in real headless Chrome. Discord's message box ignored Shift+Enter
// (2 Nov), because the keydown went without its text, so Chrome sent no keypress and
// no beforeinput. Slate editors act on that beforeinput, as this page does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { CHROME, headlessChrome, startBear } from './harness.mjs';

const PAGE = `<!doctype html><title>Editor</title>
<div id="box" contenteditable role="textbox" aria-label="box"></div>
<script>
window.seen = [];
box.addEventListener('beforeinput', (e) => {
  seen.push(e.inputType);
  // Enter sends in these editors, so the test can tell the two apart.
  if (e.inputType === 'insertParagraph') e.preventDefault();
});
</script>`;

test('Shift+Enter makes a line break in a rich editor', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
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
  const TAB = 7;
  const { browserbear } = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') return [{ tabId: TAB, url, title: 'Editor', active: true, windowId: 1, status: 'complete' }];
    if (op === 'cdp') return send(args.method, args.params, sessionId);
    return true;
  });

  for (let i = 0; i < 50 && (await browserbear('eval', String(TAB), 'document.readyState')) !== 'complete'; i++) await new Promise((r) => setTimeout(r, 100));
  await browserbear('eval', String(TAB), 'box.focus()');
  await browserbear('type', String(TAB), '-', 'one');
  await browserbear('key', String(TAB), 'Shift+Enter');
  await browserbear('type', String(TAB), '-', 'two');
  assert.deepEqual(JSON.parse(await browserbear('eval', String(TAB), 'JSON.stringify(seen)')), ['insertText', 'insertLineBreak', 'insertText']);
  assert.match(await browserbear('eval', String(TAB), 'box.innerText'), /^one\ntwo\s*$/);

  // Other modified keys still don't type anything.
  await browserbear('key', String(TAB), 'Shift+Tab');
  await browserbear('key', String(TAB), 'Meta+b');
  assert.match(await browserbear('eval', String(TAB), 'box.innerText'), /^one\ntwo\s*$/);
});
