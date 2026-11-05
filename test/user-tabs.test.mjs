// The user's own tabs are theirs. On 5 Nov an agent opened x.com/mikeysee, then
// found "its" tab by grepping `tabs` for that address, got Mike's own tab on the
// same page (he was replying to his launch post in it), ran eval on it, which
// put a thread's name on its title, and closed it. Looking at a user's tab stays
// easy; changing or closing one needs the user to have asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBear } from './harness.mjs';

test("close, goto and the like refuse the user's own tabs; looking doesn't mark them", async (t) => {
  const closed = [];
  const marked = [];
  const sentCdp = [];
  const { browserbear, fromExtension } = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') {
      return [
        // Opened by an agent, in BrowserBear's window.
        { tabId: 1, url: 'https://x.com/mikeysee', title: 'Mikey (@mikeysee) / X', active: true, agent: true, bear: true },
        // Mike's own, on the same page.
        { tabId: 2, url: 'https://x.com/mikeysee', title: 'Mikey (@mikeysee) / X', active: true, agent: false, bear: false },
        // An agent's, handed to Mike and now in his window.
        { tabId: 3, url: 'https://accounts.example/', title: 'Sign in', active: false, agent: true, bear: false },
        { tabId: 4, url: 'https://linkedin.com/notifications', title: 'Notifications | LinkedIn', active: false, agent: false, bear: false },
        { tabId: 6, url: 'https://news.example/', title: 'News', active: false, agent: false, bear: false },
        // A sign-in popup an agent's page opened, in a popup window of its own.
        { tabId: 8, url: 'https://claude.example/', title: 'Claude', active: true, agent: true, bear: true },
        // From an extension too old to say whose a tab is.
        { tabId: 10, url: 'https://old.example/', title: 'Old', active: false },
        { tabId: 9, url: 'https://accounts.google.example/', title: 'Sign in', active: true, agent: false, bear: false, openerTabId: 8 },
      ].filter((x) => !closed.includes(x.tabId));
    }
    if (op === 'open') return { tabId: 5, url: args.url, title: 'Opened', active: true, agent: true, bear: true };
    // Moved nowhere: a profile with no other window, or a popup.
    if (op === 'handoff') return { tabId: args.tabId, url: 'https://example/', title: 'Handed', active: true };
    if (op === 'close') return closed.push(args.tabId), true;
    if (op === 'mark') return marked.push([args.tabId, args.mark && args.mark.name]), true;
    if (op === 'cdp') {
      sentCdp.push([args.tabId, args.method]);
      if (args.method === 'Runtime.evaluate') return { result: { type: 'string', value: 'page' } };
      return { nodes: [{ nodeId: '1', role: { value: 'RootWebArea' } }] };
    }
    return true;
  });
  const fails = (p, re) => assert.rejects(p, (e) => (assert.match(e.stderr, re), true));

  // tabs says which is the user's, so a grep for the address isn't the only clue.
  const list = await browserbear('tabs');
  assert.match(list, /\n {2}2\* .*<https:\/\/x\.com\/mikeysee> \(the user's\)/);
  assert.match(list, /\n {2}3  .*\(handed to the user\)/);
  assert.doesNotMatch(list, /\n {2}1\* .*\(the user's\)/);

  // open --id prints only the id.
  assert.equal(await browserbear('open', 'https://x.com/mikeysee', '--id'), '5');

  // close refuses the user's tab, and one handed to them, and says how to go ahead.
  await fails(browserbear('close', '2'), /tab 2 is the user's own, not one an agent opened .*Mikey.*won't close it.*use the id browserbear open printed.*browserbear close 2 --user-tab/s);
  await fails(browserbear('close', '3'), /tab 3 is one an agent handed to the user, so it's theirs now/);
  assert.deepEqual(closed, []);
  assert.equal(await browserbear('close', '1'), 'closed tab 1');
  assert.equal(await browserbear('close', '2', '--user-tab'), 'closed tab 2');
  assert.deepEqual(closed, [1, 2]);

  // Changing a user's tab needs claim or --user-tab; nothing reaches the page first.
  await fails(browserbear('goto', '4', 'https://example.com'), /tab 4 is the user's own .*won't goto in it.*browserbear claim 4, or add --user-tab/s);
  await fails(browserbear('cdp', '4', 'Page.reload'), /won't cdp in it/);
  assert.deepEqual(sentCdp.filter(([tab]) => tab === 4), []);
  // A handed-off tab is still the agent's to carry on in once the user's finished.
  await browserbear('cdp', '3', 'Page.reload');

  // Looking still works, and leaves no marks on the user's tab.
  assert.equal(await browserbear('eval', '4', 'document.title'), 'page');
  await browserbear('show', '4');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(marked.filter(([tab]) => tab === 4), []);

  // Lent with --user-tab, it's worked in and marked like an agent's.
  await browserbear('cdp', '4', 'Page.reload', '--user-tab');
  await browserbear('eval', '4', 'document.title');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(marked.some(([tab, name]) => tab === 4 && name), 'a lent tab is marked');
  // release takes the marks off and lets go: it's the user's again.
  assert.match(await browserbear('release', '4'), /let go of tab 4/);
  assert.deepEqual(marked.at(-1), [4, null]);
  await fails(browserbear('cdp', '4', 'Page.reload'), /won't cdp in it/);

  // An agent's popup is the agent's to work in and close, until it's handed over.
  await browserbear('cdp', '9', 'Page.reload');
  await browserbear('handoff', '9');
  await fails(browserbear('close', '9'), /tab 9 is one an agent handed to the user/);
  assert.equal(await browserbear('close', '9', '--user-tab'), 'closed tab 9');
  // So is a tab handed over that stays in BrowserBear's window.
  await browserbear('handoff', '8');
  assert.match(await browserbear('tabs'), /\n {2}8\* .*\(handed to the user\)/);
  await fails(browserbear('close', '8'), /tab 8 is one an agent handed to the user/);
  await browserbear('cdp', '8', 'Page.reload'); // the agent can still carry on in it

  // claim takes a tab id too, and lets the agent in.
  await fails(browserbear('cdp', '6', 'Page.reload'), /won't cdp in it/);
  await browserbear('claim', '6');
  await browserbear('cdp', '6', 'Page.reload');
  // The pill's ✕ takes the claim back too.
  fromExtension({ type: 'event', event: 'mark', action: 'release', tabId: 6 });
  await new Promise((r) => setTimeout(r, 300));
  await fails(browserbear('cdp', '6', 'Page.reload'), /won't cdp in it/);

  // A tab nobody can place isn't closed without asking.
  await fails(browserbear('close', '10'), /tab 10 is one BrowserBear can't place .*--user-tab/s);
  assert.ok(!closed.includes(10));
});
