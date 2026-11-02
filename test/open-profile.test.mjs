// A profile Chrome has no window open for has no extension running, so it
// isn't connected. BrowserBear opens it rather than giving up (Title lab,
// 2 Nov), by email or from Chrome's Profiles menu, without Chrome's Local
// State, which macOS usually won't let it read. Chrome is test/fakes/chrome-ctl.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startBear } from './harness.mjs';

const NO_LOCAL_STATE = '/nonexistent/Local State';
const MENU = 'Michael|Michael (convex.dev)=mike@convex.dev|Mike (gangbusters.io)=mike@gangbusters.io|Ghost (nobear.dev)';

async function bear(t, env = {}) {
  const log = path.join(fs.mkdtempSync('/tmp/browserbear-ctl-'), 'calls');
  t.after(() => fs.rmSync(path.dirname(log), { recursive: true, force: true }));
  const bear = await startBear(t, ({ op }) => (op === 'tabs' ? [] : true), {
    BROWSERBEAR_CHROME_LOCAL_STATE: NO_LOCAL_STATE,
    BROWSERBEAR_OPEN_WAIT_MS: '3000',
    FAKE_MENU: MENU,
    FAKE_CTL_LOG: log,
    ...env,
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter((l) => !l.startsWith('menu')) : []);
  return { ...bear, calls };
}

test('a profile asked for by email is opened with --profile-email', async (t) => {
  const { browserbear, calls } = await bear(t);
  assert.match(await browserbear('tabs', '--profile', 'mike@convex.dev'), /Michael \(convex\.dev\) \(mike@convex\.dev\):/);
  assert.deepEqual(calls(), ['email mike@convex.dev']);
  // Connected now, so asking again doesn't open another window.
  await browserbear('tabs', '--profile', 'mike@convex.dev');
  assert.deepEqual(calls(), ['email mike@convex.dev']);
});

test("a profile asked for by its menu name is opened from Chrome's Profiles menu", async (t) => {
  const { browserbear, calls } = await bear(t);
  assert.match(await browserbear('tabs', '--profile', 'gangbusters'), /Mike \(gangbusters\.io\) \(mike@gangbusters\.io\):/);
  assert.deepEqual(calls(), ['click Mike (gangbusters.io)']);
  // And it's found by that name from then on.
  assert.match(await browserbear('tabs', '--profile', 'Mike (gangbusters.io)'), /mike@gangbusters\.io/);
  assert.deepEqual(calls(), ['click Mike (gangbusters.io)']);
});

test('a connected profile is found by its menu name without opening anything', async (t) => {
  const { browserbear, calls } = await bear(t, { FAKE_MENU: `${MENU}|Me (example.com)` });
  assert.match(await browserbear('tabs', '--profile', 'Me (example.com)'), /Me \(example\.com\) \(me@example\.com\):/);
  assert.deepEqual(calls(), []);
});

test("profiles lists the menu's profiles that aren't connected", async (t) => {
  const { browserbear } = await bear(t);
  const out = await browserbear('profiles');
  assert.match(out, /● me@example\.com/);
  assert.match(out, /○ Michael \(convex\.dev\)/);
  assert.match(out, /○ Mike \(gangbusters\.io\)/);
  assert.match(out, /--profile "<name>"` opens it/);
});

test('when it can\'t be opened, the error says how to open it', async (t) => {
  const { browserbear, calls } = await bear(t);
  // In the menu, but BrowserBear isn't installed there: nothing connects.
  await assert.rejects(browserbear('tabs', '--profile', 'nobear'), /didn't connect in 3s.*computercub menu "Google Chrome" "Profiles > Ghost \(nobear\.dev\)"/);
  // Asked again, it doesn't open yet another window.
  await assert.rejects(browserbear('tabs', '--profile', 'nobear'), /never connected.*won't open another window/);
  assert.equal(calls().filter((c) => c === 'click Ghost (nobear.dev)').length, 1);
  // Not in the menu at all.
  await assert.rejects(browserbear('tabs', '--profile', 'Personal'), /no connected profile matches "Personal".*Profiles menu has "Michael".*isn't in Chrome's Profiles menu/);
  // Ambiguous.
  await assert.rejects(browserbear('tabs', '--profile', 'Mi'), /could be any of "Michael", "Michael \(convex\.dev\)", "Mike \(gangbusters\.io\)"/);
  // An email Chrome doesn't know.
  await assert.rejects(browserbear('tabs', '--profile', 'who@nowhere.dev'), /signed in as who@nowhere\.dev, but nothing new connected.*--profile-email=who@nowhere\.dev/);
});

test("without the menu (no Accessibility), an email still opens and a name says what to do", async (t) => {
  const { browserbear, calls } = await bear(t, { FAKE_CTL_FAIL: 'execution error: osascript is not allowed assistive access. (-1719)' });
  await assert.rejects(browserbear('tabs', '--profile', 'convex'), /couldn't read Chrome's Profiles menu \(macOS won't let BrowserBear use Chrome's menus.*--profile-email=<its email>.*use the email/);
  assert.match(await browserbear('tabs', '--profile', 'mike@convex.dev'), /mike@convex\.dev:/);
  assert.deepEqual(calls(), ['email mike@convex.dev']);
  assert.match(await browserbear('profiles'), /couldn't read Chrome's Profiles menu/);
});
