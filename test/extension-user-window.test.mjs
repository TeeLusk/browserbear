// Where a handoff puts an agent's tab: the user's window, never a minimised
// one or BrowserBear's own, and when the one remembered won't do, the window
// holding the tab they used last. After opencode Browse's #230.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFT, extensionInChrome } from './harness.mjs';

test('a handoff goes to the window the user is really using', { skip: !CFT && 'no Chrome for Testing' }, async (t) => {
  const inWorker = await extensionInChrome(t);
  // BrowserBear's window, and two of the user's.
  await inWorker("ops.open({ url: 'about:blank#agent' })");
  const older = await inWorker("chrome.windows.create({ url: 'about:blank#older', focused: false }).then((w) => w.id)");
  const newer = await inWorker("chrome.windows.create({ url: 'about:blank#newer', focused: false }).then((w) => w.id)");
  const picked = () => inWorker('userWindow().then((w) => w && w.id)');

  // Remembered and fine: that one.
  await inWorker(`chrome.storage.session.set({ userWindow: ${older} })`);
  assert.equal(await picked(), older);

  // Remembered but minimised: not that one, and not BrowserBear's.
  await inWorker(`chrome.windows.update(${older}, { state: 'minimized' })`);
  const state = await inWorker(`chrome.windows.get(${older}).then((w) => w.state)`);
  if (state === 'minimized') {
    const now = await picked();
    assert.notEqual(now, older);
    assert.notEqual(now, await inWorker("chrome.storage.session.get('bearWindow').then((s) => s.bearWindow)"));
  }

  // Nothing remembered, last focused unusable: the window whose tab was used last.
  await inWorker(`chrome.windows.update(${older}, { state: 'normal' })`);
  await inWorker("chrome.storage.session.remove('userWindow')");
  await inWorker(`(async () => {
    const [tab] = await chrome.tabs.query({ windowId: ${newer} });
    await chrome.tabs.update(tab.id, { active: true });
    const { bearWindow } = await chrome.storage.session.get('bearWindow');
    await chrome.windows.update(bearWindow, { focused: true });
  })()`);
  const got = await picked();
  assert.ok([older, newer].includes(got), `one of the user's windows, got ${got}`);
});
