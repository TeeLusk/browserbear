// A tab lent from the toolbar while BrowserBear's service on the Mac isn't up
// waits, with "…" on the badge, survives the worker sleeping, and goes once
// the service says hello; opening the popup again can cancel it. After
// opencode Browse's #237.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFT, extensionInChrome } from './harness.mjs';

test('a lend made while the service is down waits for it', { skip: !CFT && 'no Chrome for Testing' }, async (t) => {
  const inWorker = await extensionInChrome(t);
  // No native host in this Chrome, so the service is never up by itself.
  assert.equal(await inWorker('link.service'), false);
  const [a, b, c] = await inWorker(`Promise.all(['a', 'b', 'c'].map((h) => chrome.tabs.create({ url: 'about:blank#' + h }).then((t) => t.id)))`);
  const badgeOf = (id) => inWorker(`chrome.action.getBadgeText({ tabId: ${id} })`);

  for (const [id, thread] of [[a, 'new'], [b, 'thread-1'], [c, 'thread-2']]) await inWorker(`queueLend({ tabId: ${id}, thread: '${thread}', text: 'look at this' })`);
  assert.equal(await badgeOf(a), '…');
  assert.match(await inWorker(`chrome.action.getTitle({ tabId: ${a} })`), /waiting for its service/);

  // Cancelled by a second visit to the popup.
  assert.equal(await inWorker(`cancelLend(${c})`), true);
  assert.equal(await badgeOf(c), '');

  // The worker starting again (a sleep): closed tabs drop out, the rest keep the badge.
  await inWorker(`chrome.tabs.remove(${b})`);
  await new Promise((r) => setTimeout(r, 200));
  await inWorker(`chrome.action.setBadgeText({ tabId: ${a}, text: '' })`);
  await inWorker('restoreLends()');
  assert.deepEqual(await inWorker('queuedLends().then((l) => l.map((q) => q.tabId))'), [a]);
  assert.equal(await badgeOf(a), '…');

  // The service says hello: the lend goes, once, and the badge clears.
  await inWorker(`(self.sent = [], ask = async (cmd, args) => (self.sent.push([cmd, args]), { ok: true, result: { thread: 'abc' } }))`);
  await inWorker(`onMessage({ type: 'welcome', name: 'Work' }).then(() => flushLends())`);
  assert.deepEqual(await inWorker('self.sent'), [['lend', { tabId: a, thread: 'new', text: 'look at this' }]]);
  assert.equal(await badgeOf(a), '');
  assert.deepEqual(await inWorker('queuedLends()'), []);

  // One that fails says why on the badge.
  await inWorker(`(link.service = false, queueLend({ tabId: ${a}, thread: 'gone', text: '' }))`);
  await inWorker(`(ask = async () => ({ ok: false, error: "Threadbear didn't take the message" }), onMessage({ type: 'welcome' }).then(() => flushLends()))`);
  assert.equal(await badgeOf(a), '!');
  assert.match(await inWorker(`chrome.action.getTitle({ tabId: ${a} })`), /couldn't lend this tab: Threadbear didn't take the message/);
});
