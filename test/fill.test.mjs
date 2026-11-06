// fill signs in from 1Password in the agent's own Chrome. What it types comes
// from op and goes into the page; the agent only hears which login and fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startBear, root } from './harness.mjs';
import { pickLogin, sameSite } from '../service/onepassword.mjs';

test('sameSite and pickLogin', () => {
  assert.ok(sameSite('accounts.google.com', 'google.com'));
  assert.ok(sameSite('google.com', 'accounts.google.com'));
  assert.ok(!sameSite('notgoogle.com', 'google.com'));
  const logins = [{ id: 'a', title: 'Work' }, { id: 'b', title: 'Home' }];
  assert.equal(pickLogin(logins, 'home', 'https://x.test').id, 'b');
  assert.throws(() => pickLogin(logins, undefined, 'https://x.test'), /2 logins for x\.test; say which with --item/);
  assert.throws(() => pickLogin([], undefined, 'https://x.test'), /no login saved for x\.test.*handoff/);
});

test("fill types the login into the agent's page and never prints it", async (t) => {
  const typed = [];
  let fields = { user: true, password: true, otp: false };
  const { browserbear } = await startBear(
    t,
    ({ op, args }) => {
      if (op === 'tabs') return [{ tabId: 7, url: 'https://example.com/login', title: 'Sign in', active: true, agent: true, bear: true }];
      if (op === 'cdp' && args.method === 'Runtime.evaluate') {
        if (args.params.expression.includes('FIND') || args.params.expression.includes('compareDocumentPosition')) return { result: { value: fields } };
        if (args.params.expression.includes('activeElement')) return { result: { value: true } };
        return { result: { value: null } };
      }
      if (op === 'cdp' && args.method === 'Input.insertText') return typed.push(args.params.text), {};
      return {};
    },
    { BROWSERBEAR_OP: path.join(root, 'test', 'fakes', 'op.mjs') },
    // As the agent's own Chrome, the only place fill works.
    { instance: 'agent-chrome' },
  );
  const fails = (p, re) => assert.rejects(p, (e) => (assert.match(e.stderr, re), true));

  // Two logins for the site: it asks which, by name.
  await fails(browserbear('fill', '7'), /2 logins for example\.com; say which with --item.*"Example work" \(aaa/s);
  const out = await browserbear('fill', '7', '--item', 'Example personal');
  assert.deepEqual(typed, ['user-bbb@example.com', 'pw-bbb-secret']);
  assert.match(out, /filled the username, password from 1Password \("Example personal"\) in tab 7/);
  assert.doesNotMatch(out, /pw-bbb|user-bbb/);

  // The code step of a two-step sign-in.
  typed.length = 0;
  fields = { user: false, password: false, otp: true };
  assert.match(await browserbear('fill', '7', '--item', 'aaa'), /filled the one-time code/);
  assert.deepEqual(typed, ['123456']);
  await fails(browserbear('fill', '7', '--item', 'bbb'), /wants a one-time code, but "Example personal" in 1Password has none/);
});

test("fill won't sign in in the user's own profiles", async (t) => {
  const { browserbear } = await startBear(t, ({ op }) => (op === 'tabs' ? [{ tabId: 7, url: 'https://example.com/', title: 'X', active: true, agent: true, bear: true }] : {}), {
    BROWSERBEAR_OP: path.join(root, 'test', 'fakes', 'op.mjs'),
  });
  await assert.rejects(browserbear('fill', '7'), (e) => (assert.match(e.stderr, /fill only signs in in the agent's own Chrome/), true));
});
