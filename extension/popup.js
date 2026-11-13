// The toolbar popup: lend the tab you're on to a Threadbear thread (or a new
// one), and say whether every agent may use its site. Everything goes through
// the background worker to the service on the Mac (see `asks` in
// service/service.mjs).
const $ = (id) => document.getElementById(id);

const ask = (cmd, args) => chrome.runtime.sendMessage({ type: 'ask', cmd, args });

function say(text, error = false) {
  $('status').textContent = text || '';
  $('status').className = error ? 'muted error' : 'muted';
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
$('setup').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ type: 'open-setup' });
  window.close();
});

let busy = false;
async function lend(thread) {
  if (busy) return;
  busy = true;
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  say(thread === 'new' ? 'Starting a thread…' : 'Lending…');
  const r = await ask('lend', { tabId: tab.id, thread, text: $('text').value });
  busy = false;
  if (!r?.ok) {
    for (const b of document.querySelectorAll('button')) b.disabled = false;
    return say(r?.error || "BrowserBear didn't answer", true);
  }
  if (r.result?.queued) {
    say("BrowserBear's service on the Mac isn't up yet. The tab is lent as soon as it is (… on the toolbar); open this again to cancel.");
    return setTimeout(() => window.close(), 2500);
  }
  say('Lent. The thread has the tab now.');
  setTimeout(() => window.close(), 900);
}

function render(v) {
  $('page-title').textContent = v.tab.title || tab.title || 'This tab';
  $('page-site').textContent = v.site || v.tab.url;
  if (v.tab.lentTo) {
    const t = v.threads.find((x) => x.id === v.tab.lentTo);
    $('lent').textContent = `A thread has this tab: ${t ? t.title : v.tab.lentTo}. Lending it again hands it to another thread.`;
    $('lent').hidden = false;
  }
  // Annotate: the thread the tab is lent to first, then the rest.
  $('annotate').hidden = !v.tb || !v.threads.length;
  const order = [...v.threads].sort((a, b) => (b.id === v.tab.lentTo) - (a.id === v.tab.lentTo));
  $('annotate-thread').replaceChildren(...order.map((t) => Object.assign(document.createElement('option'), { value: t.id, textContent: t.title })));
  $('no-tb').hidden = v.tb;
  $('new').hidden = !v.tb;
  $('text').hidden = !v.tb;
  $('threads').replaceChildren(
    ...v.threads.map((t) => {
      const b = document.createElement('button');
      const state = t.status === 'running' ? 'running' : t.needsYou ? 'you' : '';
      const dot = Object.assign(document.createElement('span'), { className: `dot ${state}` });
      const title = Object.assign(document.createElement('span'), { className: 't' });
      title.append(dot, t.title);
      const detail = Object.assign(document.createElement('span'), {
        className: 'd',
        textContent: [t.folder, t.status === 'running' ? 'working' : t.needsYou ? 'needs you' : 'idle'].filter(Boolean).join(' · '),
      });
      b.append(title, detail);
      b.addEventListener('click', () => lend(t.id));
      const li = document.createElement('li');
      li.append(b);
      return li;
    }),
  );

  // The site switch. With no list, turning it on starts one, which limits
  // every agent to the sites on it, so it says that first.
  $('sites').hidden = !v.site;
  if (v.site) {
    $('site-on').checked = Boolean(v.siteAllowed);
    $('site-label').textContent = v.restricted ? `Every agent may use ${v.site}` : `Only let agents use listed sites, starting with ${v.site}`;
    $('site-note').textContent = v.restricted
      ? 'Agents only use sites on the list. A tab you lend can be used by that thread on its site, in that tab only, until it\'s released.'
      : 'Agents may use any site now.';
  }
}

$('new').addEventListener('click', () => lend('new'));
$('annotate-go').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  const select = $('annotate-thread');
  say('Opening the annotation tools…');
  const r = await ask('annotate', { tabId: tab.id, thread: select.value, title: select.selectedOptions[0]?.textContent });
  busy = false;
  if (!r?.ok) {
    for (const b of document.querySelectorAll('button')) b.disabled = false;
    return say(r?.error || "BrowserBear didn't answer", true);
  }
  window.close();
});
$('site-on').addEventListener('change', async (e) => {
  const r = await ask('allowSite', { tabId: tab.id, on: e.target.checked });
  if (!r?.ok) {
    e.target.checked = !e.target.checked;
    return say(r?.error, true);
  }
  render(r.result);
  say('');
});

// The service may be starting (Chrome just opened, or it's restarting after an
// update): give it a moment, then offer what's known so a lend can wait for it.
async function serviceUp() {
  for (let i = 0; i < 15; i++) {
    const st = await chrome.runtime.sendMessage({ type: 'lend-state', tabId: tab.id });
    if (st.service || i === 14) return st;
    await new Promise((r) => setTimeout(r, 200));
  }
}

function renderWaiting(queued) {
  $('sites').hidden = true;
  $('text').hidden = true;
  $('new').hidden = true;
  $('threads').replaceChildren();
  const b = Object.assign(document.createElement('button'), { className: 'primary', textContent: 'Cancel the lend' });
  b.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'cancel-lend', tabId: tab.id });
    say('Cancelled.');
    setTimeout(() => window.close(), 700);
  });
  const li = document.createElement('li');
  li.append(b);
  $('threads').append(li);
  say(`Waiting for BrowserBear's service on the Mac to lend this tab to ${queued.thread === 'new' ? 'a new thread' : 'a thread'}.`);
}

if (!tab?.id || !/^https?:|^file:/.test(tab.url || '')) {
  say("This page can't be lent: only web pages can.");
  $('lend').hidden = true;
} else {
  say('Loading threads…');
  const st = await serviceUp();
  // A "!" from a lend that failed while waiting has been seen now.
  if (!st.queued) chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {});
  if (st.queued) renderWaiting(st.queued);
  else if (!st.service) {
    // Threads from the last time it answered; a lend waits for the service.
    render({ tab: { title: tab.title, url: tab.url }, threads: st.lastThreads, tb: st.lastTb || true, site: null });
    say("BrowserBear's service on the Mac isn't up yet. A lend waits for it, with … on the toolbar.");
    $('annotate').hidden = true; // the tools need the service to come back with them
  } else {
    const r = await ask('lendable', { tabId: tab.id });
    if (!r?.ok) say(r?.error || "BrowserBear's service on the Mac didn't answer. Setup shows what's missing.", true);
    else {
      say('');
      render(r.result);
    }
  }
}
