import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CFT, extensionInChrome } from './harness.mjs';

// The extension's half of the Browser panel's screencast: frames go to the
// service as events, and stop when the cast does.
test('the extension forwards screencast frames while a cast runs, and only then', { skip: !CFT }, async t => {
  // A page that draws all the time, so Chrome has frames to send.
  const server = http.createServer((_, res) => res.end('<div id=d style="width:200px;height:200px;background:red"></div><script>let n=0;(function f(){d.style.marginLeft=(n++%100)+"px";requestAnimationFrame(f)})()</script>'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const worker = await extensionInChrome(t);
  const tabId = await worker(`chrome.tabs.create({url:'http://127.0.0.1:${server.address().port}/'}).then(t=>t.id)`);
  await new Promise(r => setTimeout(r, 500));
  // Stand in for the native host: count frames and ack them, as the service does.
  await worker(`(self.__frames = 0, self.post = m => { if (m.event !== 'frame') return; self.__frames++; ops.cdp({ tabId: m.tabId, method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId } }); }, true)`);
  await worker(`ops.cdp({ tabId: ${tabId}, method: 'Page.startScreencast', params: { format: 'jpeg', quality: 80, everyNthFrame: 1 } }).then(() => true)`);
  await new Promise(r => setTimeout(r, 1000));
  const frames = await worker('self.__frames');
  t.diagnostic(`${frames} frames in a second`);
  assert.ok(frames > 15, `only ${frames} frames in a second`);
  await worker(`ops.cdp({ tabId: ${tabId}, method: 'Page.stopScreencast' }).then(() => true)`);
  await new Promise(r => setTimeout(r, 200));
  const stopped = await worker('self.__frames');
  await new Promise(r => setTimeout(r, 500));
  assert.equal(await worker('self.__frames'), stopped, 'no frames after the cast stopped');
});
