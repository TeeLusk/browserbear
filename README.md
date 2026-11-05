# BrowserBear

Lets your local AI agents use your real Chrome: your profiles, your sign-ins, the tabs
you already have open. Any agent that can run a command can use it (Claude, Codex,
anything else), and Threadbear will give its threads BrowserBear tools of their own.

It's early: macOS and Chrome only, tested on Chrome 156. It was called Paws until 30 Oct 2026.

## Why

The agents' own browser tools kept letting us down: picking the wrong Chrome profile
or Google account, dropping the connection, clicks timing out, and secrets having to be
smuggled out through the clipboard. BrowserBear keeps the agent in the profile you named and
the tab you pointed at, and keeps everything on your Mac.

## How it fits together

```
browserbear CLI (or Threadbear)
  → BrowserBear service, one per Mac, on a Unix socket in ~/Library/Application Support/BrowserBear
  → native host, one per Chrome profile, started by Chrome
  → the BrowserBear extension in that profile (a thin pipe to chrome.debugger)
  → the tab
```

- Profiles are named the way Chrome names them ("Work"), or by email or folder,
  never by a number that changes between connects. It has to be the whole thing (in
  any case): part of a name gets you the candidates back rather than a guess, and
  `open` prints the profile it used. Names and folders come from
  Chrome's `Local State` file; where macOS blocks that, the email and the names in
  Chrome's Profiles menu ("Michael (convex.dev)") still work, and
  `browserbear profiles` lists the menu's profiles too.
- A profile with no Chrome window open has no extension running, so it isn't
  connected. Ask for it anyway and BrowserBear opens a window for it (by email with
  Chrome's `--profile-email`, or by name from the Profiles menu, which needs
  Accessibility), waits for it to connect and carries on.
- Snapshots list headings and things you can click or type in, with refs (`e12`) that
  stay on the same element. After the first look you get only what changed, so most
  steps cost a few hundred tokens rather than 15k.
- Everything that changes a page answers with that diff, so there's no separate look.
- The extension detaches from a tab 30 s after its last command, so Chrome's "started
  debugging this browser" bar doesn't hang around.
- All the page logic is in the service; the extension rarely needs to change. The
  service restarts itself within a couple of seconds of its code changing (once nothing
  is in flight), so there's nothing to kill after an edit. Refs don't survive that: snap
  again.
- A click, key or submit that starts a navigation waits for the next page before it
  answers, and `read` waits for a page with a body. A button that seems to have done
  nothing gets a few seconds more before that's reported, and a tab that closes itself
  (a sign-in popup finishing) is reported as that, not as a failure or "(no change)".
- `type` into a code split across one-character boxes fills the row one character per
  box, leaving out spaces and dashes, and reads it back.
- `type` reads the field back. If inserted text changed nothing after a couple of
  seconds it uses real key presses, as a masked amount field needs, and if the field
  still hasn't changed, doesn't end up with the text in it, or has it in twice, that's
  an error, before any `--submit`. With `-`, it won't fall back to keys once focus has
  left the field. A rich editor's text is printed, since the snapshot doesn't show it.
- `type --replace` puts the text in over a selection as one edit, since a controlled
  field can restore its old value the moment it's emptied. It then reads the field back
  and fails, before any `--submit`, unless it holds exactly that text.
- Chrome won't let a debugger into a tab holding another extension's frame (a password
  manager's inline menu), so the extension blanks those frames and gets back in. That
  needs the `scripting` permission. It has to scan the page's DOM to find them, shadow
  roots included: `webNavigation.getAllFrames` doesn't list other extensions' frames, and
  `chrome.dom.openOrClosedShadowRoot` throws on non-HTML elements like `<svg>`, so call
  it on HTML elements only. A frame can also say `about:blank` and then send itself to
  its extension's page (1Password's sign-on frame), so an iframe that says blank but
  whose document is shut to us counts too.
- `key Shift+Enter` adds a line break in rich editors, and `type` keeps the newlines in
  its text. Neither sends a Discord message; only `Enter` or `--submit` do.

## The agent's own Chrome

`--profile agent` works in a Chrome of the agent's own instead of one of your
profiles, with no extension (`agent/agent-host.mjs`, started when it's first asked for).
It's real Google Chrome with its own folder (`agent/chrome-profile` in BrowserBear's
folder), on a debugging port on this Mac only, and it stands in for the extension, so every
command above works there. Each page gets a window of its own, parked in a corner of a
screen where about 40 points of it show. Threadbear's Browser panel draws the thread's pages and
sends your mouse and keys to them, and `handoff` opens that panel, so nothing comes to the front.
You sign in once per account, in the panel, and those sign-ins stay in that folder.

Tried on 5 Nov 2026: Google's sign-in takes this, with scripted input and the port
open. It rejects CEF and headless Chrome with "This browser or app may not be secure".
Chrome stops drawing a minimised window, a hidden app and a background tab (0 frames
a second, 5 s for a mouse event), hence a window per page; parked, a page streams at 60
frames a second with about 33 ms from a click to the frame showing it.

Not yet: `download`, and frames from other origins in `probe`. Any program on this Mac can reach
the debugging port, as it can reach BrowserBear's socket, so only sign this Chrome in to
what you'd let your agents use. It leaves a second Chrome icon in the Dock and in ⌘-Tab.

## Threadbear's Browser panel with existing Chrome profiles

The panel can also use this extension's existing Chrome profile and sign-ins,
through the service's private Unix socket. The profile's name and email stay
visible, and the profile menu opens a page in the exact connected profile selected.
No cookie or credential import is involved, and existing Store extensions work.

The service tracks pages used by threads in `panel-tabs.json` (0600), storing
profile/tab/target identities and cached titles, without full URLs or credentials.
A stream checks the thread's ownership and Chrome's target identity, and only
one panel controls a tab. A user-owned tab needs an explicit Show this tab here
before the panel changes its viewport. Closing the panel restores its normal size.
Frames remain in memory on this Mac.

The native-window button pauses capture for Chrome's passkeys, password managers
and other native UI. Returning to the panel is explicit; Chrome's debugger Stop
is respected until Reconnect. Existing-profile frames use sequential screenshots
with backpressure rather than the separate agent Chrome's 60 fps screencast.
Viewport changes wait for a capture to finish, while input and dialog answers
can pass it. Extension 0.3.6 also preserves Chrome's exact opener tab ID, so popups
join the correct thread. Older extensions open new windows in Chrome; the
panel says so. No hostname or URL matching is used to assign a popup.

## Install (for now)

```sh
./scripts/install.sh     # native host for every profile, and `browserbear` on your PATH
```

Then add the extension to each Chrome profile you want agents to use. Once the
Chrome Web Store listing is live (it's in review), `./scripts/install.sh --store` makes
Chrome offer it in every profile, and each one asks you once. Until then:
`chrome://extensions`, turn on Developer mode, Load unpacked, pick this repo's `extension`
folder. For uploads, open
the extension's Details and turn on "Allow access to file URLs". The extension's id is
fixed (`iljcldkflmlnmfhbllafbbfnchhoccok`) by the key in its manifest.

The extension opens a setup page when it's first added, and again whenever you
click its toolbar button. It checks the Mac side, the name agents will use for that
profile, and file access, and each row turns green by itself once it's done.
`browserbear profiles` shows which profiles are connected.

## Use

```sh
browserbear profiles
browserbear tabs --profile Work
browserbear claim studio.youtube.com          # one of your open tabs, and what's on it
browserbear open https://example.com --profile Work
browserbear click 1234 e12
browserbear type 1234 e7 "Hello" --submit
browserbear upload 1234 e12 ~/talk.mp3         # e12 can be the "Choose files" button
browserbear read 1234                          # page text; long pages go to a file
browserbear shot 1234                          # prints the PNG path
browserbear handoff 1234                       # your turn: the tab moves into your window
browserbear handoff 1234 --wait                # ...and the agent carries on by itself when you've finished
```

Agents work in a window of BrowserBear's own, so they never take over the tab
you're looking at. When an agent needs you to do something in one of its tabs
(sign in, pay, approve), `handoff` moves that tab into the Chrome window you
last used and brings it to the front, since BrowserBear's window may be on a
screen you aren't looking at. `open` and `goto` say so when a page looks like
a sign-in. Given a URL, `handoff` finds the agent tab on that page; Threadbear
does that when you click a link an agent gave you, so you don't end up with
two tabs of the same sign-in.

Your own tabs stay yours. An agent can look at one (`snap`, `read`, `shot`,
`eval`, `show`) without it getting marked, but `click`, `type`, `key`, `goto`,
`upload`, `dialog` and `cdp` refuse a tab no agent opened until it's lent with
`claim` (by address, title or id) or `--user-tab`. `close` refuses your tabs,
and agent tabs that were handed to you, unless it's given `--user-tab`, since you
may be halfway through something there. `tabs` marks yours `(the user's)`, and
`open --id` prints just the new tab's id, so an agent never has to find its tab
again by grepping for its address. Grepping is how one closed Mike's X tab while he
was replying to his launch post, since he had the same page open. `release` takes
the marks off a tab and lets go of it.

With `--wait`, you don't have to go back and tell the agent you've finished. It
waits (run it as a background task) until the tab has left the page it was handed
over on and settled somewhere that isn't another sign-in step, so a password page
leading to a code page leading to a consent page still counts as one job. The bar
on the tab has a Done button for whatever that can't see. When you've finished the
bar goes green and says "Thanks, carrying on", then fades, and the command prints
where the tab ended up. If a page's address won't change, or a checkout has several
steps, the agent says what finished looks like: `--until-url '*console.cloud.google.com/*'`
or `--until-text "Payment received"`. Exits 0 when you've finished (including if you
drag the tab back to BrowserBear's window), 2 if you closed the tab and 124 at the
timeout (`--timeout <seconds>`, 20 minutes by default). It watches through the tab's
address and a yes-or-no question to the page, never the debugger, which would put
Chrome's debugging bar up and clear your password manager's menu while you type.

Every tab an agent uses is marked, so you can tell it from yours. The tab's
title starts with 🐻 and the thread's name, its icon gets a dot (green while
the agent works in it, amber when it's handed to you, grey while the thread
has it but isn't using it right now), and a pill in the page says what the
agent is doing, with Open thread (in the Threadbear app, or its website without it), Stop and ✕ (leave this tab alone). The marks
come off when the thread finishes its turn without needing you. The CLI passes
`THREADBEAR_THREAD_ID` along and the service asks Threadbear's `tb` for the
thread's name and state; outside Threadbear the tab just says "agent". The
pill steps aside while the agent clicks or takes a screenshot, and agents see
the page's own title.

Uploads never open Chrome's file picker. Give `upload` the file input itself
(`snap` lists them as `file-input`, hidden ones too, since sites usually hide the
real one), the button or label that stands for it, or a CSS selector, and it
finds the input and sets the files there. A button whose input only appears when
it's clicked gets clicked, with the picker caught before it opens. Pages that use
`showOpenFilePicker` instead of an input can't be filled this way.

When a tab stops answering, BrowserBear works out why instead of timing out
again and again. If Chrome answers but the page doesn't, the page's own scripts
are stuck or flat out (a live chart did this on BTC Markets), and the agent is
told to wait or open the page fresh; after that, each command takes a quick look
first rather than waiting the full 20 s. If Chrome doesn't answer either, the
debugger session is stuck, so BrowserBear drops it and starts a fresh one,
sending the command again only if it just reads the page.

A page that fails to load comes back as an error from `open` and `goto` saying why
(`certificate error on example.com (net::ERR_CERT_COMMON_NAME_INVALID)`), with the
tab's id, rather than looking like success. Chrome keeps debuggers out of its warning
pages (certificate errors, Safe Browsing), so `read`, `snap` and `eval` name the problem
there, and `goto` still gets the tab out, through `chrome.tabs` instead of the debugger.

A real click on a link that changes nothing but focus gets clicked again by
script, since following a link twice is harmless. For anything else that ignores
a real click, the agent is told about `--script`.

`browserbear help` lists everything.

## Tests

```sh
npm test
```

The end-to-end test plays the extension over native messaging to the real host, which
starts the real service, which the real CLI talks to. No Chrome needed.

## Not yet

- Cross-origin iframes (Google sign-in, payment frames) aren't in snapshots.
- No approvals yet for posting, sending or buying; Threadbear will own those.
- No `secret_to` (move a key from a page into Convex env or Keychain without it
  passing through the agent).
- Installing into every profile at once (unlisted Web Store listing plus an External
  Extensions file) and a LaunchAgent for the service.
