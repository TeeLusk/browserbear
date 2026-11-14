// A JS dialog blocks the page, so commands say so at once rather than time out
// as "the page's own scripts are stuck", and goto answers the leave-site
// dialog it set off itself (Amazon Ads' draft editor, 14 Nov).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBear } from './harness.mjs';

test("eval says a dialog is open; goto leaves past the page's leave-site warning", async (t) => {
  let dialogOpen = null;
  let navigated = 0;
  const handled = [];
  let bear;
  bear = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') return [{ tabId: 4, url: 'http://localhost:3000/draft', title: 'Draft', active: true, agent: true, bear: true }];
    if (op === 'mark') return true;
    if (op === 'cdp') {
      const { method, params } = args;
      if (method === 'Page.navigate') {
        // The page's beforeunload asks first; Chrome holds the navigation.
        dialogOpen = { type: 'beforeunload', message: '' };
        bear.fromExtension({ type: 'event', event: 'dialog', tabId: 4, params: dialogOpen });
        return new Promise(() => {});
      }
      if (method === 'Page.handleJavaScriptDialog') {
        handled.push(params.accept);
        dialogOpen = null;
        navigated++;
        return {};
      }
      if (dialogOpen && method === 'Runtime.evaluate') return new Promise(() => {}); // blocked behind it
      if (method === 'Runtime.evaluate') return { result: { value: params.expression.includes('readyState') ? 'complete' : 'visible' } };
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [] };
      return {};
    }
    return true;
  });
  const { browserbear, fromExtension } = bear;

  // A dialog the page opened by itself: eval hears about it straight away.
  fromExtension({ type: 'event', event: 'dialog', tabId: 4, params: { type: 'beforeunload', message: '' } });
  dialogOpen = { type: 'beforeunload' };
  const started = Date.now();
  await assert.rejects(browserbear('eval', '4', '1+1'), (e) => (assert.match(e.stderr, /\[js beforeunload "" is open; nothing else works until: browserbear dialog 4 accept\|dismiss\]/), true));
  assert.ok(Date.now() - started < 5_000, 'it should not wait for a timeout');
  await browserbear('dialog', '4', 'dismiss');
  assert.deepEqual(handled, [false]);

  // goto: the leave-site dialog it set off is accepted, and it says so.
  const out = await browserbear('goto', '4', 'http://localhost:3000/draft');
  assert.match(out, /the page warned that changes may not be saved; goto left it anyway/);
  assert.deepEqual(handled, [false, true]);
  assert.equal(await browserbear('eval', '4', 'document.visibilityState'), 'visible');
});
