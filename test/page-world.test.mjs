// Against a real headless Chrome: BrowserBear's own looks at a page leave nothing
// the page can see, eval calls a function it's given, and console shows what the
// page logged. After opencode Browse's isolated worlds, #268 and its console tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { CHROME, chromeWithEvents, startBear } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGES = {
  '/': `<!doctype html><title>Home</title><h1>Home</h1>
<button onclick="document.title = 'Clicked'">Stay</button>
<a href="/next">Next</a>
<img src="/missing.png">
<script>
  console.log('hello', { a: 1, b: 'two' }, [1, 2]);
  console.warn('careful');
  setTimeout(() => { throw new Error('boom'); }, 0);
</script>`,
  '/next': `<!doctype html><title>Next</title><h1>Next page</h1><script>console.error('on next')</script>`,
};

async function setUp(t) {
  const server = http.createServer((req, res) => {
    const body = PAGES[req.url];
    if (!body) return res.writeHead(404).end('nope');
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  let consoling = false;
  let forward = () => {};
  let sessionId;
  const send = await chromeWithEvents(t, (m) => {
    if (consoling && m.sessionId === sessionId && /^(Runtime\.(consoleAPICalled|exceptionThrown)|Log\.entryAdded)$/.test(m.method)) forward(m.method, m.params);
  });
  const { targetId } = await send('Target.createTarget', { url: `${base}/` });
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  const page = (method, params) => send(method, params, sessionId);
  await page('Page.enable');
  for (let i = 0; i < 50; i++) {
    const { result } = await page('Runtime.evaluate', { expression: 'document.readyState' });
    if (result.value === 'complete') break;
    await sleep(100);
  }
  const ops = [];
  const bear = await startBear(t, async ({ op, args }) => {
    ops.push(op);
    if (op === 'tabs') {
      const { result } = await page('Runtime.evaluate', { expression: '[location.href, document.title]', returnByValue: true });
      return [{ tabId: 1, url: result.value[0], title: result.value[1], active: true, agent: true, bear: true }];
    }
    if (op === 'show') return { tabId: 1, url: base, title: 'Home', active: true };
    if (op === 'frames' || op === 'mark') return op === 'frames' ? [] : true;
    if (op === 'console') {
      consoling = args.on;
      if (args.on) {
        await page('Runtime.enable');
        await page('Log.enable');
      } else {
        await page('Runtime.disable');
        await page('Log.disable');
      }
      return true;
    }
    if (op === 'cdp') return page(args.method, args.params);
    throw new Error(`unexpected op ${op}`);
  });
  forward = (method, params) => bear.fromExtension({ type: 'event', event: 'console', tabId: 1, method, params });
  return { ...bear, page, ops };
}

const refOf = (snap, name) => snap.match(new RegExp(`(e\\d+) \\w+ "${name}"`))[1];

test("BrowserBear's marks are out of the page's sight, and a navigation is still seen", { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
  const { browserbear, page } = await setUp(t);
  const snap = await browserbear('snap', '1', '--full');
  // A click that doesn't navigate: marked, settled, and nothing left on window.
  await browserbear('click', '1', refOf(snap, 'Stay'));
  const { result } = await page('Runtime.evaluate', { expression: `Object.keys(window).filter((k) => /browserbear/i.test(k)).join(',')`, returnByValue: true });
  assert.equal(result.value, '');
  assert.equal(await browserbear('eval', '1', 'typeof window.__browserbear'), 'undefined');
  // A click that does: it waits for the next page and shows it.
  const next = await browserbear('click', '1', refOf(snap, 'Next'));
  assert.match(next, /Next page/);
});

test('eval calls a function it is given, and runs other code as it is', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
  const { browserbear } = await setUp(t);
  assert.equal(await browserbear('eval', '1', '() => document.title'), 'Home');
  assert.equal(await browserbear('eval', '1', 'async () => location.pathname'), '/');
  assert.equal(await browserbear('eval', '1', 'document.title'), 'Home');
  // Not one function: as given, which ends on 2.
  assert.equal(await browserbear('eval', '1', '() => 1; 2'), '2');
  // The page's own globals are there: eval runs in the page's world.
  assert.equal(await browserbear('eval', '1', 'typeof console.log'), 'function');
});

test('console shows what the page logged, then only what is new', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
  const { browserbear, page, ops } = await setUp(t);
  const first = await browserbear('console', '1');
  // What Chrome kept from before capturing started.
  assert.match(first, /\[log\] hello \{"a":1,"b":"two"\} \[1,2\]/);
  assert.match(first, /\[warn\] careful/);
  assert.match(first, /\[exception\] (Uncaught )?Error: boom/);
  assert.match(first, /\[error\] Failed to load resource.*missing\.png/);
  assert.match(first, /capturing tab 1's console from now on/);

  assert.match(await browserbear('console', '1'), /nothing new/);
  await page('Runtime.evaluate', { expression: `console.info('later', { n: 2 })` });
  await sleep(300);
  const later = await browserbear('console', '1');
  assert.match(later, /\[info\] later (\{n: 2\}|\{"n":2\})/);
  assert.doesNotMatch(later, /hello/);
  assert.doesNotMatch(later, /capturing/);

  await page('Runtime.evaluate', { expression: `console.log('chatter'); console.error('bad')` });
  await sleep(300);
  const errors = await browserbear('console', '1', '--errors');
  assert.match(errors, /\[error\] bad/);
  assert.doesNotMatch(errors, /chatter/);
  assert.match(await browserbear('console', '1', '--all'), /hello[\s\S]*later[\s\S]*bad/);

  assert.match(await browserbear('console', '1', 'stop'), /stopped/);
  assert.equal(ops.filter((o) => o === 'console').length, 2);
});
