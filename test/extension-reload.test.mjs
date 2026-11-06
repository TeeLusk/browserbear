// Reloading the extension (browserbear reload, an update) wipes
// chrome.storage.session, not only quitting Chrome. On 6 Nov another thread's
// reload landed partway through an agent's job on the Convex dashboard: the
// extension forgot which window was BrowserBear's, so the tab the agent had
// opened there counted as Mike's and every click after it was refused.
//
// Chrome for Testing unloads an extension loaded from the command line when
// it calls chrome.runtime.reload() rather than starting it again, so this does
// to the extension what a reload does (empties session storage), then what a
// freshly started worker does (restoreKept).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFT, extensionInChrome } from './harness.mjs';

test("an agent's tab stays the agent's when the extension reloads", { skip: !CFT && 'no Chrome for Testing' }, async (t) => {
  const inWorker = await extensionInChrome(t);
  const tabId = await inWorker("ops.open({ url: 'about:blank#agent' }).then((t) => t.tabId)");
  const handedId = await inWorker("ops.open({ url: 'about:blank#handed' }).then((t) => t.tabId)");
  await inWorker(`ops.handoff({ tabId: ${handedId} })`);
  const whose = async () => Object.fromEntries((await inWorker('ops.tabs()')).map((t) => [t.tabId, { agent: t.agent, bear: t.bear }]));
  assert.deepEqual((await whose())[tabId], { agent: true, bear: true });
  assert.equal((await whose())[handedId].agent, true);
  // Copied to local storage as it changes, which takes a moment.
  await new Promise((r) => setTimeout(r, 300));

  await inWorker('chrome.storage.session.clear()');
  assert.deepEqual((await whose())[tabId], { agent: false, bear: false }, 'the bug: a wiped session forgets the window');
  await inWorker('restoreKept()');

  const after = await whose();
  assert.deepEqual(after[tabId], { agent: true, bear: true });
  assert.equal(after[handedId].agent, true, 'a handed-over tab is still known as one an agent opened');
  // New tabs still go into the same window, rather than a second one.
  const again = await inWorker("ops.open({ url: 'about:blank#again' }).then((t) => t.windowId)");
  assert.equal(again, await inWorker(`chrome.tabs.get(${tabId}).then((t) => t.windowId)`));

  // Something that has since gone isn't put back.
  await inWorker(`chrome.tabs.remove(${handedId})`);
  await new Promise((r) => setTimeout(r, 300));
  await inWorker('chrome.storage.session.clear()');
  await inWorker('restoreKept()');
  assert.deepEqual(await inWorker("chrome.storage.session.get('handedOff')"), {});
});

// After Chrome restarts, the ids kept from its last run may belong to the
// user's own windows now. Putting them back writes the session, whose copy to
// local storage lands after the startup cleanup: it mustn't bring them back.
test("ids from Chrome's last run are dropped when it starts again", { skip: !CFT && 'no Chrome for Testing' }, async (t) => {
  const inWorker = await extensionInChrome(t);
  // A window of the user's that has the id BrowserBear's had last time.
  const userWin = await inWorker("chrome.windows.create({ url: 'about:blank#mine', focused: false }).then((w) => w.id)");
  await inWorker(`chrome.storage.session.clear().then(() => chrome.storage.local.set({ kept: { bearWindow: ${userWin} } }))`);
  // As at a real start: onStartup queues the cleanup while the restore is still going.
  await inWorker('(() => { const back = restoreKept(); queue(async () => forgetLastRun(await back)); })()');
  await new Promise((r) => setTimeout(r, 500));
  await inWorker('restored');
  assert.deepEqual(await inWorker("chrome.storage.session.get('bearWindow')"), {});
  assert.equal((await inWorker("chrome.storage.local.get('kept')")).kept.bearWindow, undefined);
});
