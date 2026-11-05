import test from 'node:test';
import assert from 'node:assert/strict';
import { CFT, extensionInChrome } from './harness.mjs';

test('the extension preserves Chrome’s exact opener tab identity', { skip: !CFT }, async t => {
  const inWorker = await extensionInChrome(t);
  const result = await inWorker(`(async () => {
    const parent = await chrome.tabs.create({ url: 'about:blank' });
    const child = await chrome.tabs.create({ url: 'about:blank', openerTabId: parent.id });
    await ops.cdp({ tabId: parent.id, method: 'Runtime.evaluate', params: {
      expression: "window.open('about:blank', 'sign-in', 'popup,width=500,height=600'); true", userGesture: true
    } });
    await new Promise(resolve => setTimeout(resolve, 200));
    const tabs = await ops.tabs();
    const popup = tabs.find(t => t.tabId !== parent.id && t.tabId !== child.id && t.openerTabId === parent.id);
    return { parent: parent.id, opener: tabs.find(t => t.tabId === child.id).openerTabId, popupOpener: popup?.openerTabId };
  })()`);
  assert.equal(result.opener, result.parent);
  assert.equal(result.popupOpener, result.parent, 'a real window.open popup retains its exact opener');
});
