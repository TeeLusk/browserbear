// Opening Chrome profiles that aren't connected yet, without Chrome's Local
// State (macOS refuses that file to other apps, so BrowserBear often can't
// learn a profile's name or folder). Two routes that don't need it:
//  - Chrome's --profile-email switch opens a window for the profile signed in
//    as that email. Needs no permissions at all.
//  - Chrome's Profiles menu lists every profile by name ("Michael (convex.dev)")
//    and clicking one opens it. Reading and clicking it goes through System
//    Events, so it needs Accessibility for whatever app BrowserBear runs under.
// BROWSERBEAR_CHROME_CTL swaps in a script for all of this, so tests never
// touch the real Chrome: `ctl menu` prints one name per line, `ctl email <e>`
// and `ctl click <name>` open a profile.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CTL = process.env.BROWSERBEAR_CHROME_CTL;

const MENU = `
tell application "System Events"
  if not (exists process "Google Chrome") then return ""
  tell process "Google Chrome"
    set out to ""
    repeat with m in menu items of menu 1 of menu bar item "Profiles" of menu bar 1
      set n to name of m
      -- The profiles come first; a separator (no name) starts Edit… and Add Profile….
      if n is missing value then exit repeat
      set out to out & n & linefeed
    end repeat
    return out
  end tell
end tell`;

const CLICK = `
on run argv
  tell application "System Events" to tell process "Google Chrome"
    click menu item (item 1 of argv) of menu 1 of menu bar item "Profiles" of menu bar 1
  end tell
end run`;

// Why osascript failed, in words an agent can act on.
function why(e) {
  const text = `${e.stderr || ''} ${e.message}`;
  if (/assistive|-1719|-25211|not allowed/i.test(text)) return "macOS won't let BrowserBear use Chrome's menus (it needs Accessibility)";
  return text.trim().split('\n').pop();
}

// The names in Chrome's Profiles menu, [] when Chrome isn't running, or
// { error } when the menu can't be read.
export async function menuProfiles() {
  try {
    const { stdout } = CTL ? await run(CTL, ['menu']) : await run('osascript', ['-e', MENU], { timeout: 10_000 });
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    return { error: why(e) };
  }
}

export async function openByEmail(email) {
  // -n so Chrome gets the switch even when it's already running (it hands it
  // to the running Chrome); -g so the window doesn't take Mike's focus.
  if (CTL) await run(CTL, ['email', email]);
  else await run('open', ['-g', '-n', '-a', 'Google Chrome', '--args', `--profile-email=${email}`], { timeout: 10_000 });
}

export async function openByMenu(name) {
  try {
    if (CTL) await run(CTL, ['click', name]);
    else await run('osascript', ['-e', CLICK, name], { timeout: 10_000 });
  } catch (e) {
    throw new Error(why(e));
  }
}

// "convex.dev" for "Michael (convex.dev)": Chrome names a profile signed in
// to a work account after its domain.
export const domainOf = (menuName) => /\(([^()\s]+\.[^()\s]+)\)\s*$/.exec(menuName)?.[1]?.toLowerCase() || null;

export const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
