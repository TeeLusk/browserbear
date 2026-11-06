// Mike's agent-only trial (6 Nov 2026): with the switch on, agents keep to the
// agent's own Chrome and his profiles are refused with what to do instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBear } from './harness.mjs';

test("agent-only refuses the user's profiles and their tabs, and is off by default", async (t) => {
  const { browserbear } = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') return [{ tabId: 1, url: 'https://x.com/', title: 'X', active: true, agent: true, bear: true }];
    if (op === 'open') return { tabId: 2, url: args.url, title: 'Opened', active: true, agent: true, bear: true };
    if (op === 'cdp') return { nodes: [{ nodeId: '1', role: { value: 'RootWebArea' } }] };
    return true;
  });
  const fails = (p, re) => assert.rejects(p, (e) => (assert.match(e.stderr, re), true));

  // Off: the user's profile works as before.
  assert.match(await browserbear('agent-only'), /agent-only is off/);
  assert.equal(await browserbear('open', 'https://example.com/', '--profile', 'me@example.com', '--id'), '2');

  assert.match(await browserbear('agent-only', 'on'), /agent-only is on/);
  await fails(browserbear('open', 'https://example.com/', '--profile', 'me@example.com'), /agent-only on this Mac .*won't use the profile "me@example.com".*--profile agent.*handoff <tab> --wait/s);
  await fails(browserbear('tabs', '--profile', 'me@example.com'), /won't use the profile/);
  await fails(browserbear('claim', 'x.com', '--profile', 'me@example.com'), /won't use the profile/);
  // A tab in one of the user's profiles, even one an agent opened there earlier.
  await fails(browserbear('snap', '1'), /won't work in tab 1, which is in one of Mike's own profiles/);
  await fails(browserbear('close', '1'), /won't work in tab 1/);
  // Status and the profile list still answer.
  assert.match(await browserbear('profiles'), /me@example\.com/);

  assert.match(await browserbear('agent-only', 'off'), /agent-only is off/);
  assert.match(await browserbear('snap', '1'), /RootWebArea|1/);
});
