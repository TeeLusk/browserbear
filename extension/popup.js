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
      ? 'Agents only use sites on the list. Lending a tab lets that thread use its site.'
      : 'Agents may use any site now.';
  }
}

$('new').addEventListener('click', () => lend('new'));
$('site-on').addEventListener('change', async (e) => {
  const r = await ask('allowSite', { tabId: tab.id, on: e.target.checked });
  if (!r?.ok) {
    e.target.checked = !e.target.checked;
    return say(r?.error, true);
  }
  render(r.result);
  say('');
});

if (!tab?.id || !/^https?:|^file:/.test(tab.url || '')) {
  say("This page can't be lent: only web pages can.");
  $('lend').hidden = true;
} else {
  say('Loading threads…');
  const r = await ask('lendable', { tabId: tab.id });
  if (!r?.ok) say(r?.error || "BrowserBear's service on the Mac didn't answer. Setup shows what's missing.", true);
  else {
    say('');
    render(r.result);
  }
}
