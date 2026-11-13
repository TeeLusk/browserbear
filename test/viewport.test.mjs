// A page size set with raw cdp on one of the user's own tabs letterboxes the
// page in their real window, so the agent is told, and release puts it back
// (twice, as Chrome can drop a clear that races the set). After opencode
// Browse's #227.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBear } from './harness.mjs';

test("a page size set on the user's tab is undone on release", async (t) => {
  const sent = [];
  const { browserbear } = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') {
      return [
        { tabId: 2, url: 'http://localhost:5173/', title: 'Mine', active: true, agent: false, bear: false },
        { tabId: 1, url: 'http://localhost:5173/', title: 'Agent', active: true, agent: true, bear: true },
      ];
    }
    if (op === 'cdp') {
      sent.push([args.tabId, args.method]);
      if (args.method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', role: { value: 'RootWebArea' } }] };
      if (args.method === 'Runtime.evaluate') return { result: { type: 'string', value: 'visible' } };
      return {};
    }
    if (op === 'detach') return sent.push([args.tabId, 'detach']), true;
    return op === 'frames' ? [] : true;
  });
  await browserbear('claim', '2');
  const out = await browserbear('cdp', '2', 'Emulation.setDeviceMetricsOverride', '{"width":390,"height":844,"deviceScaleFactor":3,"mobile":true}');
  assert.match(out, /tab 2 is the user's own, so its window now shows the page at that size, letterboxed.*release does it too/);

  sent.length = 0;
  await browserbear('release', '2');
  assert.deepEqual(sent, [[2, 'Emulation.clearDeviceMetricsOverride'], [2, 'Emulation.clearDeviceMetricsOverride'], [2, 'detach']]);

  // Cleared by the agent itself: nothing left for release to do.
  await browserbear('claim', '2');
  await browserbear('cdp', '2', 'Emulation.setDeviceMetricsOverride', '{"width":390,"height":844,"deviceScaleFactor":3,"mobile":true}');
  await browserbear('cdp', '2', 'Emulation.clearDeviceMetricsOverride');
  sent.length = 0;
  await browserbear('release', '2');
  assert.deepEqual(sent, [[2, 'detach']]);

  // The agent's own tab, in BrowserBear's window: no note.
  await browserbear('snap', '1');
  assert.doesNotMatch(await browserbear('cdp', '1', 'Emulation.setDeviceMetricsOverride', '{"width":390,"height":844,"deviceScaleFactor":3,"mobile":true}'), /letterboxed/);
});
