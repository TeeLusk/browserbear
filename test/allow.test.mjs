// Sites agents may use: open, goto and claim refuse sites off the list, a tab
// that's on one can't be worked in, an action that leads off it is sent back,
// and only the user (not an agent's thread) changes the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { matches, normalise } from '../service/allow.mjs';
import { root, startBear } from './harness.mjs';

const run = promisify(execFile);

test('site patterns', () => {
  assert.ok(matches('localhost', 'http://localhost:5173/x'));
  assert.ok(matches('localhost:5173', 'http://localhost:5173/x'));
  assert.ok(!matches('localhost:5173', 'http://localhost:3000/'));
  assert.ok(matches('example.com', 'https://example.com/'));
  assert.ok(!matches('example.com', 'https://www.example.com/'));
  assert.ok(matches('*.example.com', 'https://www.example.com/'));
  assert.ok(matches('*.example.com', 'https://example.com/'));
  assert.ok(!matches('*.example.com', 'https://badexample.com/'));
  assert.ok(matches('::1', 'http://[::1]:8080/'));
  assert.ok(matches('example.com:443', 'https://example.com/'));
  assert.ok(!matches('example.com', 'file:///etc/passwd'));
  assert.ok(matches('example.com', 'about:blank'));
  assert.equal(normalise('https://Example.com:8080/path'), 'example.com:8080');
  assert.equal(normalise('[::1]'), '::1');
  assert.equal(normalise('not a site!'), null);
});

test('agents keep to the allowed sites', async (t) => {
  const urls = { 1: 'http://localhost:3000/', 2: 'https://bank.example/', 3: 'http://localhost:3000/b' };
  const history = { 1: ['http://localhost:3000/'] };
  const sent = [];
  const { browserbear, env } = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') {
      return [
        { tabId: 1, url: urls[1], title: 'App', active: true, agent: true, bear: true },
        { tabId: 2, url: urls[2], title: 'Bank', active: true, agent: false, bear: false },
        { tabId: 3, url: urls[3], title: 'App b', active: false, agent: true, bear: true },
      ];
    }
    if (op === 'open') return { tabId: 5, url: args.url, title: 'Opened', active: true, agent: true, bear: true };
    if (op === 'navigate') return { tabId: args.tabId, url: (urls[args.tabId] = args.url), title: '' };
    if (op === 'mark') return true;
    if (op === 'cdp') {
      sent.push([args.tabId, args.method, args.params]);
      const { method, params } = args;
      if (method === 'Runtime.evaluate') {
        // The eval that leaves the site.
        if (/location\.href =/.test(params.expression)) {
          urls[args.tabId] = 'https://evil.example/';
          history[args.tabId].push(urls[args.tabId]);
        }
        return { result: { type: 'string', value: params.expression === 'document.readyState' ? 'complete' : 'ok' } };
      }
      if (method === 'Page.getNavigationHistory') {
        const entries = history[args.tabId].map((url, id) => ({ id, url }));
        return { currentIndex: entries.length - 1, entries };
      }
      if (method === 'Page.navigateToHistoryEntry') {
        urls[args.tabId] = history[args.tabId][params.entryId];
        return {};
      }
      if (method === 'Page.navigate') return (urls[args.tabId] = params.url), {};
      return { nodes: [{ nodeId: '1', role: { value: 'RootWebArea' } }] };
    }
    return true;
  });
  const fails = (p, re) => assert.rejects(p, (e) => (assert.match(e.stderr, re), true));
  // The CLI as an agent's thread runs it.
  const asThread = (id, ...a) => run(process.execPath, [path.join(root, 'cli.mjs'), ...a], { env: { ...env, THREADBEAR_THREAD_ID: id } }).then((r) => r.stdout.trim());

  // No list: anywhere, as before.
  assert.match(await browserbear('allow'), /every thread: any site/);
  assert.match(await browserbear('snap', '2'), /tab 2|RootWebArea/);

  assert.match(await browserbear('allow', 'add', 'localhost'), /every thread may use: localhost/);
  await fails(browserbear('open', 'https://news.example/'), /won't open news\.example, which isn't on the sites agents may use \(localhost\)/);
  await fails(browserbear('snap', '2'), /tab 2 is on bank\.example, which isn't on the sites/);
  await fails(browserbear('claim', '2'), /tab 2 is on bank\.example/);
  await fails(browserbear('goto', '1', 'https://news.example/'), /won't go to news\.example/);
  assert.match(await browserbear('open', 'http://localhost:3000/new'), /opened tab 5/);
  // Closing and handing over still work on an off-list tab.
  await browserbear('handoff', '2');

  // An eval that took the tab away gets it sent back.
  await fails(browserbear('eval', '1', 'location.href = "https://evil.example/"'), /took tab 1 to evil\.example.*sent back to http:\/\/localhost:3000\//s);
  assert.equal(urls[1], 'http://localhost:3000/');

  // An agent can read the list but not change it.
  await fails(asThread('th-1', 'allow', 'add', 'bank.example'), /only the user changes which sites agents may use/);
  assert.match(await asThread('th-1', 'allow'), /this thread may use: localhost/);

  // One thread's own sites add to every thread's, for that thread only.
  assert.match(await browserbear('allow', 'add', 'news.example', '--thread', 'th-1'), /thread th-1 may use: localhost, news\.example/);
  assert.match(await asThread('th-1', 'open', 'https://news.example/'), /opened tab 5/);
  await fails(asThread('th-2', 'open', 'https://news.example/'), /isn't on the sites/);
  assert.match(await browserbear('allow'), /thread th-1: news\.example/);

  // A lent tab: that thread may use that tab on its site, nothing else, until it's released.
  const lend = (tab, to) => new Promise((resolve, reject) => {
    const s = net.createConnection(path.join(env.BROWSERBEAR_HOME, 'browserbear.sock'));
    s.on('connect', () => s.write(JSON.stringify({ id: 1, cmd: 'lendTo', args: { tab, to } }) + '\n'));
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      s.end();
      const r = JSON.parse(buf);
      r.ok ? resolve(r.result) : reject(new Error(r.error));
    });
  });
  history[2] = ['https://bank.example/'];
  assert.match((await lend(2, 'th-3')).words, /only in this tab and only in this thread/);
  assert.match(await asThread('th-3', 'snap', '2'), /tab 2|RootWebArea/);
  await fails(asThread('th-4', 'snap', '2'), /tab 2 is on bank\.example, which isn't on the sites/);
  await fails(asThread('th-3', 'open', 'https://bank.example/other'), /won't open bank\.example/);
  assert.match(await asThread('th-3', 'allow'), /tab 2 is lent to this thread: it may be used on bank\.example in that tab only/);
  assert.doesNotMatch(await browserbear('allow'), /^thread th-3:/m);
  // Off the granted site, even in the lent tab, it's sent back.
  await fails(asThread('th-3', 'eval', '2', 'location.href = "https://evil.example/"'), /sent back to https:\/\/bank\.example\//);
  assert.equal(urls[2], 'https://bank.example/');
  await asThread('th-3', 'release', '2');
  await fails(asThread('th-3', 'snap', '2'), /tab 2 is on bank\.example/);

  // Clearing every thread's list leaves th-1's own list limiting th-1 only.
  await browserbear('allow', 'clear');
  assert.match(await browserbear('snap', '2'), /tab 2|RootWebArea/);
  await fails(asThread('th-1', 'snap', '2'), /isn't on the sites agents may use in this thread \(news\.example\)/);
});
