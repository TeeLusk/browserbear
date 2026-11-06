// Chrome's own windows over a page: the passkey sheet, the password manager,
// a permission prompt. They're native, so the page's picture in Threadbear's
// panel never shows them, and Chrome keeps them on a screen even when their
// tab's window is parked off it, so one turned up hanging off the edge of
// Mike's left monitor with nothing to say what it was (6 Nov 2026).
//
// Nothing in CDP says one has opened, so this watches the window server for
// windows of the agent's Chrome that aren't one of its tab windows. They're
// child windows, so moving the tab's window brings its sheet along with it.
import { spawn } from 'node:child_process';

// Smaller than this is a tooltip, the link-preview bar or a 1-point helper
// window; Chrome's sheets and bubbles are a few hundred points across.
const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;

const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
function overlap(a, b) {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}
const same = (a, b) => ['left', 'top', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= 2);

/** Whether a sheet sits on a window: Chrome puts it inside its window once that's on screen. */
export const sitsOn = (sheet, rect) => overlap(sheet, rect) >= 0.8 * area(sheet);

/** How much of a rectangle is on some screen, 0 to 1. */
export function onScreen(rect, screens) {
  const a = area(rect);
  if (!a) return 0;
  return Math.min(1, screens.reduce((sum, s) => sum + overlap(rect, s), 0) / a);
}

// Gap between two rectangles, 0 when they touch or overlap, then how far
// apart their middles are, for windows parked on top of each other.
function distance(a, b) {
  const dx = Math.max(0, a.left - (b.left + b.width), b.left - (a.left + a.width));
  const dy = Math.max(0, a.top - (b.top + b.height), b.top - (a.top + a.height));
  const mid = (r) => [r.left + r.width / 2, r.top + r.height / 2];
  const [ax, ay] = mid(a);
  const [bx, by] = mid(b);
  return Math.hypot(dx, dy) * 1e6 + Math.hypot(ax - bx, ay - by);
}

/**
 * Which tab each extra window belongs to.
 * windows: the agent Chrome's on-screen, layer-0 windows from the window server.
 * tabWindows: [{ tabId, bounds, thread, activeAt }], bounds from CDP.
 * claimed: Map window id -> tabId, for sheets already matched to a tab.
 * wrong: Map window id -> Set of tabIds it turned out not to belong to.
 * Returns Map tabId -> the sheet's window.
 */
export function findSheets(windows, tabWindows, screens, claimed = new Map(), wrong = new Map()) {
  const found = new Map();
  if (!tabWindows.length) return found;
  for (const w of windows) {
    if (w.width < MIN_WIDTH || w.height < MIN_HEIGHT) continue;
    if (tabWindows.some((t) => same(t.bounds, w))) continue;
    const mine = tabWindows.find((t) => t.tabId === claimed.get(w.id));
    if (mine) {
      found.set(mine.tabId, w);
      continue;
    }
    // One off every screen can't be what Mike's looking at.
    if (onScreen(w, screens) < 0.5) continue;
    // Chrome centres a sheet on its window and pulls it in to the screen's
    // edge, so its window is the nearest one. New windows all park in the
    // same corner, though, so between those it's the page last busy (a
    // passkey sheet comes up as a page loads or is clicked), and never the
    // blank window Chrome started with.
    const better = (a, b) => {
      const d = distance(w, a.bounds) - distance(w, b.bounds);
      if (Math.abs(d) > 1) return d < 0;
      if (!!a.thread !== !!b.thread) return !!a.thread;
      return (a.activeAt ?? 0) > (b.activeAt ?? 0);
    };
    // A window that's on screen has its sheet inside it, so one that isn't
    // can't own a sheet sitting elsewhere.
    const left = tabWindows.filter((t) => !wrong.get(w.id)?.has(t.tabId) && (onScreen(t.bounds, screens) < 0.5 || sitsOn(w, t.bounds)));
    if (!left.length) continue;
    const owner = left.reduce((best, t) => (better(t, best) ? t : best));
    if (!found.has(owner.tabId)) found.set(owner.tabId, w);
  }
  return found;
}

/** Where a window goes so Mike sees it: the middle of the screen he's using. */
export function placeOn(screen, size) {
  const width = Math.min(size.width, screen.width);
  const height = Math.min(size.height, screen.height);
  return {
    left: Math.round(screen.left + (screen.width - width) / 2),
    top: Math.round(screen.top + (screen.height - height) / 2),
    width,
    height,
  };
}

// One osascript for the life of the host, so it's a few milliseconds a look
// rather than a process each time. Bounds and owners don't need Screen
// Recording; only window titles would. The screens are in the same top-left
// coordinates as CDP's window bounds, and `focus` is the visible part of the
// screen with the key window, where Mike is working.
const WATCH = `
ObjC.import('CoreGraphics'); ObjC.import('AppKit');
function run(argv) {
  const pid = Number(argv[0]), every = Number(argv[1]);
  const out = $.NSFileHandle.fileHandleWithStandardOutput;
  const rect = (f, h) => ({ left: f.origin.x, top: h - f.origin.y - f.size.height, width: f.size.width, height: f.size.height });
  for (;;) {
    // 1 | 16: on screen only, and not the desktop.
    const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0));
    const windows = [];
    for (let i = 0; i < list.count; i++) {
      const w = list.objectAtIndex(i);
      if (w.objectForKey('kCGWindowOwnerPID').js !== pid || w.objectForKey('kCGWindowLayer').js !== 0) continue;
      const b = w.objectForKey('kCGWindowBounds');
      windows.push({ id: w.objectForKey('kCGWindowNumber').js, left: b.objectForKey('X').js, top: b.objectForKey('Y').js, width: b.objectForKey('Width').js, height: b.objectForKey('Height').js });
    }
    const all = $.NSScreen.screens, h = all.count ? all.objectAtIndex(0).frame.size.height : 0;
    const screens = [];
    for (let i = 0; i < all.count; i++) screens.push(rect(all.objectAtIndex(i).frame, h));
    const main = $.NSScreen.mainScreen;
    const focus = main.isNil() ? screens[0] : rect(main.visibleFrame, h);
    out.writeData($(JSON.stringify({ windows, screens, focus }) + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
    delay(every);
  }
}`;

/** Calls onLook({ windows, screens, focus }) every `every` seconds. Returns a stop function. */
export function watchWindows(pid, onLook, { every = 0.75, log = () => {} } = {}) {
  const child = spawn('osascript', ['-l', 'JavaScript', '-e', WATCH, String(pid), String(every)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let pending = '';
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const text = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      try {
        onLook(JSON.parse(text));
      } catch (e) {
        log('sheet watch', e.message);
      }
    }
  });
  child.stderr.on('data', (d) => log('sheet watch', String(d).trim()));
  let stopped = false;
  // osascript can die (killed, or the window server hiccups): start another,
  // or sheets stay marked open with nothing to notice them close.
  child.on('exit', (code) => {
    log('sheet watch stopped', code);
    if (!stopped) {
      setTimeout(() => {
        if (!stopped) stop = watchWindows(pid, onLook, { every, log });
      }, 5_000).unref();
    }
  });
  child.unref();
  let stop = () => {
    stopped = true;
    child.kill();
  };
  return () => stop();
}
