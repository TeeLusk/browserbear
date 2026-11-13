// Annotate a page in the user's own Chrome for a Threadbear thread: select
// elements, mark regions or draw, add a comment, then Attach. Started from the
// toolbar popup (asks.annotate) or Threadbear's Browser panel (panelAnnotate).
// The extension draws the tools (extension/annotation.js) and, on Attach,
// sends what was marked with a screenshot. That goes in a file of its own
// here, and Threadbear is opened on threadbear://thread/<id>?annotation=<id>,
// which puts it in that thread's message box. Nothing is sent to the agent
// until the user presses Send there.
import fs from 'node:fs';
import path from 'node:path';

const THREAD = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION = /^[0-9a-f-]{36}$/;
const MAX_JSON = 512 * 1024;
const MAX_PNG = 20 * 1024 * 1024; // base64 of a big Retina screen
const KEEP_MS = 24 * 60 * 60_000; // ones Threadbear never picked up
const PNG = 'data:image/png;base64,';

export function createAnnotations({ home, call, open, log = () => {} }) {
  const dir = path.join(home, 'annotations');
  const live = new Map(); // sessionId -> { thread, instance, tabId }

  function tidy() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const file = path.join(dir, name);
      try { if (Date.now() - fs.statSync(file).mtimeMs > KEEP_MS) fs.rmSync(file, { force: true }); } catch {}
    }
  }

  return {
    dir,

    // Puts the tools on the tab and brings it forward. One session per tab:
    // starting again replaces the last.
    async start(profile, tabId, thread, title) {
      if (!THREAD.test(String(thread || ''))) throw new Error('say which thread the annotation is for');
      for (const [id, s] of live) if (s.instance === profile.instance && s.tabId === tabId) live.delete(id);
      const sessionId = crypto.randomUUID();
      live.set(sessionId, { thread, instance: profile.instance, tabId });
      try {
        await call(profile, 'annotate', { tabId, sessionId, threadTitle: typeof title === 'string' ? title.slice(0, 80) : null }, 15_000);
      } catch (e) {
        live.delete(sessionId);
        throw new Error(`Annotate couldn't start on this page: ${e.message}. Chrome's own pages and the Web Store can't be annotated.`);
      }
      log('annotating tab', tabId, 'for', thread);
      return { sessionId, thread };
    },

    // Attach: keeps it for Threadbear and opens the thread there.
    async attached(profile, { tabId, sessionId, annotation, png }) {
      const s = live.get(sessionId);
      if (!SESSION.test(String(sessionId)) || !s || s.instance !== profile.instance || s.tabId !== tabId) {
        throw new Error('This annotation has ended. Start Annotate again.');
      }
      const json = JSON.stringify(annotation ?? null);
      if (!annotation || typeof annotation !== 'object' || json.length > MAX_JSON) throw new Error('This annotation is too big. Mark less of the page and Attach again.');
      const picture = typeof png === 'string' && png.startsWith(PNG) && png.length <= MAX_PNG ? Buffer.from(png.slice(PNG.length), 'base64') : null;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      tidy();
      if (picture?.length) fs.writeFileSync(path.join(dir, `${sessionId}.png`), picture, { mode: 0o600 });
      // Written last: Threadbear takes the .json as the sign it's all there.
      fs.writeFileSync(path.join(dir, `${sessionId}.json.tmp`), JSON.stringify({ thread: s.thread, annotation, screenshot: Boolean(picture?.length) }), { mode: 0o600 });
      fs.renameSync(path.join(dir, `${sessionId}.json.tmp`), path.join(dir, `${sessionId}.json`));
      live.delete(sessionId);
      const url = `threadbear://thread/${s.thread}?annotation=${sessionId}`;
      if (!(await open(url))) throw new Error("Threadbear didn't open. Is it installed on this Mac?");
      log('annotation for', s.thread, 'from tab', tabId);
      return { thread: s.thread };
    },

    // Cancel in the overlay, or the tab closed.
    cancelled({ tabId, sessionId }, instance) {
      for (const [id, s] of live) if (id === sessionId || (s.instance === instance && s.tabId === tabId)) live.delete(id);
    },
  };
}
