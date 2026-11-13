// HAR redaction (redact.mjs) through the recorder, with CDP Network events made up here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from '../service/har.mjs';
import { secretName, tokenLike } from '../service/redact.mjs';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const ACCESS = 'ya29.A0ARrdaM-very-long-access-token-value';
const REFRESH = 'rt_9f8e7d6c5b4a39281706f5e4d3c2b1a0';

function record(t, reqs) {
  const rec = createRecorder({ tabId: 1, url: 'https://app.example/' });
  let n = 0;
  for (const r of reqs) {
    const id = `r${++n}`;
    rec.on('Network.requestWillBeSent', { requestId: id, timestamp: n, wallTime: 1_700_000_000 + n, type: 'Fetch', request: { method: r.method || 'GET', url: r.url, headers: r.headers || {}, postData: r.postData, hasPostData: r.postData != null } });
    rec.on('Network.responseReceived', { requestId: id, response: { status: 200, statusText: 'OK', mimeType: r.mime || 'application/json', headers: r.resHeaders || {}, protocol: 'h2' } });
    rec.on('Network.loadingFinished', { requestId: id, timestamp: n + 0.5, encodedDataLength: 10 });
    r.id = id;
  }
  return rec;
}

const build = (rec, reqs, opts = {}) => {
  const bodies = new Map(reqs.filter((r) => r.body != null).map((r) => [r.id, { text: r.body, base64: false, size: r.body.length }]));
  return rec.build({ bodies, postData: true, ...opts });
};

test('names: secrets, not things about them', () => {
  for (const n of ['password', 'access_token', 'refreshToken', 'x-goog-api-key', 'client_secret', 'sessionId', 'X-Amz-Signature', 'apiKey', 'csrf']) assert.ok(secretName(n), n);
  for (const n of ['token_type', 'expires_at', 'author', 'keyword', 'passport', 'monkey', 'tokens_used', 'title']) assert.ok(!secretName(n), n);
});

test('path segments: tokens, not slugs or ids', () => {
  assert.ok(tokenLike(JWT));
  assert.ok(tokenLike('a3f9c2e1b4d5a6f7e8c9b0a1d2e3f4a5b6c7'));
  assert.ok(tokenLike('Xk9pQ2mZ7vR4tL8nB3cY6wJ1'));
  for (const s of ['how-to-install-the-extension', 'Getting-Started-With-Browse-2024', '123e4567-e89b-12d3-a456-426614174000', '12345678901234567890123456', 'settings']) assert.ok(!tokenLike(s), s);
});

test('a HAR keeps the shape of the traffic and loses its secrets', (t) => {
  const reqs = [
    {
      url: `https://api.example/v1/items?access_token=${ACCESS}&page=2&q=shoes#frag`,
      headers: { Authorization: `Bearer ${ACCESS}`, 'x-goog-api-key': 'AIzaSyD-abcdefghijklmnop', Referer: `https://app.example/cb#id_token=${JWT}&state=xyz`, ':path': `/v1/items?access_token=${ACCESS}&page=2` },
      resHeaders: { 'access-control-allow-credentials': 'true', 'set-cookie': 'sid=s3cr3tSessionValue1234567; Path=/; HttpOnly', 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ name: 'Shoe', price: 10 }], token_type: 'Bearer', expires_at: 123, refresh_token: REFRESH, next: `https://api.example/v1/items?cursor=${REFRESH}` }),
    },
    { url: `https://files.example/share/${JWT}/doc.pdf`, mime: 'text/html', body: `<a href="/x?t=${ACCESS}">link</a>` },
    { method: 'POST', url: 'https://app.example/login', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, postData: 'user=tyler&password=hunter2hunter2&remember=1' },
    { method: 'POST', url: 'https://app.example/verify', headers: { 'content-type': 'application/json' }, postData: JSON.stringify({ code_entered: '482913', note: 'pin 482913 sent' }) },
    { url: 'https://accounts.example/oauth/callback?code=4/0AbCdEf&state=s1&scope=email' },
    { url: 'https://app.example/how-to-install-the-extension?page=2' },
  ];
  const rec = record(t, reqs);
  rec.typed.add('482913');
  const har = build(rec, reqs);
  const text = JSON.stringify(har);
  for (const secret of [ACCESS, REFRESH, JWT, 'AIzaSyD-abcdefghijklmnop', 's3cr3tSessionValue1234567', 'hunter2hunter2', '482913', '4/0AbCdEf']) {
    assert.ok(!text.includes(secret), `${secret} is still in the HAR`);
    assert.ok(!text.includes(encodeURIComponent(secret)), `${secret} (encoded) is still in the HAR`);
  }
  const [api, file, login, verify, cb, slug] = har.log.entries;
  assert.match(api.request.url, /^https:\/\/api\.example\/v1\/items\?access_token=REDACTED&page=2&q=shoes#frag$/);
  assert.deepEqual(api.request.queryString.find((q) => q.name === 'page'), { name: 'page', value: '2' });
  assert.equal(api.request.headers.find((h) => h.name === 'Authorization').value, '(removed)');
  assert.match(api.request.headers.find((h) => h.name === 'Referer').value, /#id_token=REDACTED&state=xyz$/);
  assert.equal(api.request.headers.find((h) => h.name === ':path').value, '/v1/items?access_token=REDACTED&page=2');
  assert.equal(api.response.headers.find((h) => h.name === 'access-control-allow-credentials').value, 'true');
  const body = JSON.parse(api.response.content.text);
  assert.deepEqual(body.items, [{ name: 'Shoe', price: 10 }]);
  assert.equal(body.token_type, 'Bearer');
  assert.equal(body.refresh_token, 'REDACTED');
  assert.equal(body.next, 'https://api.example/v1/items?cursor=REDACTED');
  assert.equal(file.request.url, 'https://files.example/share/REDACTED/doc.pdf');
  assert.equal(file.response.content.text, '<a href="/x?t=REDACTED">link</a>');
  assert.equal(login.request.postData.text, 'user=tyler&password=REDACTED&remember=1');
  assert.equal(JSON.parse(verify.request.postData.text).note, 'pin REDACTED sent');
  assert.equal(cb.request.url, 'https://accounts.example/oauth/callback?code=REDACTED&state=s1&scope=email');
  assert.equal(slug.request.url, 'https://app.example/how-to-install-the-extension?page=2');
});

test('--raw keeps everything', (t) => {
  const reqs = [{ url: `https://api.example/v1?access_token=${ACCESS}`, headers: { Authorization: `Bearer ${ACCESS}` }, body: JSON.stringify({ refresh_token: REFRESH }) }];
  const rec = record(t, reqs);
  const text = JSON.stringify(build(rec, reqs, { raw: true }));
  assert.ok(text.includes(ACCESS) && text.includes(REFRESH));
});

// A short value blanked by its name is blanked where a value is exactly it,
// but not inside other text (opencode Browse #198: session=42 turned
// "order 1423 at 4:42" into "order 1REDACTED3 at 4:REDACTED").
test('short secret values: whole values only, never inside other text', () => {
  const reqs = [
    { url: 'https://app.example/a?session=4242', body: JSON.stringify({ sid: '4242', note: 'order 14242 at 4:42', echo: '4242' }) },
    { url: 'https://app.example/b?sid=42', body: JSON.stringify({ n: '42' }) },
  ];
  const har = build(record(null, reqs), reqs);
  const [a, b] = har.log.entries;
  assert.match(a.request.url, /session=REDACTED/);
  const body = JSON.parse(a.response.content.text);
  assert.equal(body.sid, 'REDACTED');
  assert.equal(body.echo, 'REDACTED');
  assert.equal(body.note, 'order 14242 at 4:42');
  // Too short to mean anything elsewhere: only blanked where it was named.
  assert.match(b.request.url, /sid=REDACTED/);
  assert.equal(JSON.parse(b.response.content.text).n, '42');
});
