// Network capture for `browserbear har`: the tab's CDP Network events while
// it records, turned into a HAR 1.2 file when it stops. The extension (or the
// agents' browser's host) forwards only the events named in NET_EVENTS, and
// only for tabs that are recording.
//
// HARs carry sign-ins, so cookies and auth headers are blanked unless `raw`,
// request bodies are left out unless `bodies`, and the file is 0600.
export const NET_EVENTS = new Set([
  'Network.requestWillBeSent',
  'Network.requestWillBeSentExtraInfo',
  'Network.responseReceived',
  'Network.responseReceivedExtraInfo',
  'Network.loadingFinished',
  'Network.loadingFailed',
]);

const SECRET_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
const MAX_BODY = 1_000_000;
const MAX_BODIES = 20_000_000;

const headerList = (h) => Object.entries(h || {}).flatMap(([name, value]) => String(value).split('\n').map((v) => ({ name, value: v })));
const queryOf = (url) => {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
};
const ms = (a, b) => (a >= 0 && b >= 0 && b >= a ? +(b - a).toFixed(3) : -1);

export function createRecorder({ tabId, url }) {
  const started = Date.now();
  const entries = []; // in the order requests started
  const live = new Map(); // requestId -> the entry for its latest hop
  const extra = new Map(); // requestId -> { request, response } headers from the ExtraInfo events
  let gaps = 0;

  function begin(p) {
    const e = {
      requestId: p.requestId,
      wallTime: p.wallTime,
      start: p.timestamp,
      type: p.type,
      request: { method: p.request.method, url: p.request.url + (p.request.urlFragment || ''), headers: p.request.headers, postData: p.request.postData, hasPostData: p.request.hasPostData },
      response: null,
      end: null,
      size: -1,
      error: null,
    };
    entries.push(e);
    live.set(p.requestId, e);
    return e;
  }

  return {
    tabId,
    url,
    started,
    get count() { return entries.length; },
    gap() { gaps++; },
    on(method, p) {
      if (method === 'Network.requestWillBeSent') {
        const prev = live.get(p.requestId);
        // A redirect reuses the id: the hop before it ends with this response.
        if (prev && p.redirectResponse) {
          prev.response = p.redirectResponse;
          prev.end = p.timestamp;
        }
        begin(p);
      } else if (method === 'Network.requestWillBeSentExtraInfo') {
        (extra.get(p.requestId) || extra.set(p.requestId, {}).get(p.requestId)).request = p.headers;
      } else if (method === 'Network.responseReceivedExtraInfo') {
        (extra.get(p.requestId) || extra.set(p.requestId, {}).get(p.requestId)).response = p.headers;
      } else {
        const e = live.get(p.requestId);
        if (!e) return;
        if (method === 'Network.responseReceived') e.response = p.response;
        if (method === 'Network.loadingFinished') { e.end = p.timestamp; e.size = p.encodedDataLength; }
        if (method === 'Network.loadingFailed') { e.end = p.timestamp; e.error = p.canceled ? 'canceled' : p.errorText; }
      }
    },

    // Finished requests' ids, for fetching bodies before build.
    finished: () => entries.filter((e) => e.end != null && !e.error && e.response && live.get(e.requestId) === e).map((e) => e.requestId),

    build({ raw = false, bodies = null, postData = false, creator = 'BrowserBear' } = {}) {
      const clean = (list) => (raw ? list : list.map((h) => (SECRET_HEADERS.test(h.name) ? { ...h, value: '(removed)' } : h)));
      const out = entries.map((e) => {
        const x = live.get(e.requestId) === e ? extra.get(e.requestId) : null;
        const reqHeaders = headerList(x?.request || e.request.headers);
        const r = e.response;
        const resHeaders = headerList(x?.response || r?.headers);
        const t = r?.timing;
        // CDP times are seconds; a response's timing is ms from its requestTime.
        const total = e.end != null ? ms(e.start * 1000, e.end * 1000) : -1;
        let timings = { send: 0, wait: Math.max(0, total), receive: 0 };
        if (t) {
          timings = {
            blocked: Math.max(0, ms(0, t.dnsStart >= 0 ? t.dnsStart : t.connectStart >= 0 ? t.connectStart : t.sendStart)),
            dns: ms(t.dnsStart, t.dnsEnd),
            connect: ms(t.connectStart, t.connectEnd),
            ssl: ms(t.sslStart, t.sslEnd),
            send: Math.max(0, ms(t.sendStart, t.sendEnd)),
            wait: Math.max(0, ms(t.sendEnd, t.receiveHeadersEnd)),
          };
          // Whatever's left of the request's time is the body arriving.
          const spent = ['blocked', 'dns', 'connect', 'send', 'wait'].reduce((s, k) => s + Math.max(0, timings[k]), 0);
          timings.receive = Math.max(0, +(Math.max(0, total) - spent).toFixed(3));
        }
        const body = bodies?.get(e.requestId);
        const posted = postData && e.request.postData != null;
        return {
          startedDateTime: new Date((e.wallTime ?? started / 1000) * 1000).toISOString(),
          time: Math.max(0, total),
          request: {
            method: e.request.method,
            url: e.request.url,
            httpVersion: r?.protocol || 'unknown',
            cookies: [],
            headers: clean(reqHeaders),
            queryString: queryOf(e.request.url),
            ...(posted ? { postData: { mimeType: e.request.headers?.['Content-Type'] || e.request.headers?.['content-type'] || '', text: e.request.postData } } : {}),
            headersSize: -1,
            bodySize: posted ? Buffer.byteLength(e.request.postData) : e.request.hasPostData ? -1 : 0,
          },
          response: {
            status: e.error ? 0 : r?.status ?? 0,
            statusText: e.error ? e.error : r?.statusText ?? '',
            httpVersion: r?.protocol || 'unknown',
            cookies: [],
            headers: clean(resHeaders),
            content: {
              size: body ? body.size : -1,
              mimeType: r?.mimeType || '',
              ...(body ? { text: body.text, ...(body.base64 ? { encoding: 'base64' } : {}) } : {}),
            },
            redirectURL: resHeaders.find((h) => /^location$/i.test(h.name))?.value || '',
            headersSize: -1,
            bodySize: e.size,
          },
          cache: {},
          timings,
          ...(r?.remoteIPAddress ? { serverIPAddress: r.remoteIPAddress } : {}),
          _resourceType: e.type ? e.type.toLowerCase() : undefined,
          ...(e.error ? { _error: e.error } : {}),
        };
      });
      return {
        log: {
          version: '1.2',
          creator: { name: creator, version: '1' },
          pages: [],
          entries: out,
          ...(gaps ? { comment: `the debugger was cut off ${gaps} time(s) while recording, so requests in those gaps are missing` } : {}),
        },
      };
    },

    // A few lines for the agent: what's in the file, without reading it.
    summary(har) {
      const es = har.log.entries;
      const failed = es.filter((e) => e._error || e.response.status >= 400);
      const hosts = new Map();
      for (const e of es) {
        try {
          const h = new URL(e.request.url).host;
          hosts.set(h, (hosts.get(h) || 0) + 1);
        } catch {}
      }
      const top = [...hosts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h, n]) => `${h} ${n}`).join(', ');
      const lines = [`${es.length} request${es.length === 1 ? '' : 's'}${top ? ` (${top})` : ''}, ${failed.length} failed or 4xx/5xx`];
      for (const e of failed.slice(0, 10)) lines.push(`  ${e._error || e.response.status} ${e.request.method} ${e.request.url.slice(0, 120)}`);
      if (failed.length > 10) lines.push(`  … ${failed.length - 10} more`);
      if (gaps) lines.push(`(the debugger was cut off ${gaps} time(s), so some requests may be missing)`);
      return lines.join('\n');
    },
  };
}

export { MAX_BODY, MAX_BODIES };
