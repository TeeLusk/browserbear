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

## The agents' own browser

`--profile agent` works in a browser of the agents' own instead of one of your
profiles, with no extension (`agent/agent-host.mjs`, started when it's first asked for).
It's [Helium](https://helium.computer) if it's installed, else Google Chrome
(`BROWSERBEAR_AGENT_APP=/path/to/Some.app` picks another), with its own folder
(`agent/helium-profile` in BrowserBear's folder; a Google Chrome left on its port is closed first) and a debugging port on this Mac only.
It stands in for the extension, so every command above works there.

Each page gets a real window of its own, opened behind your windows without taking the
focus. Agents keep working in it while it's covered. `handoff` brings the page's window
to the front for you, with any of the browser's own sheets (a passkey, a permission).
You sign in once per account, there, and those sign-ins stay in that folder.
Threadbear's Browser panel lists a thread's pages with a still of each, and its Show
window button brings one forward.

Why Helium (checked 8 Nov 2026, Helium 0.21): Google's sign-in accepts it with scripted
input and the port open, as it does real Chrome (it rejects CEF and headless Chrome
with "This browser or app may not be secure"). It's signed with Apple's passkey
entitlement for browsers, so Touch ID passkeys work, which is why BrowserBear launches
the installed app as it ships and never bundles or re-signs it. Unlike Google Chrome,
it still takes `--load-extension`. It updates itself. 1Password's app doesn't connect to
it; `browserbear fill` signs in from 1Password without that.

Not yet: `download`, and frames from other origins in `probe`. Any program on this Mac can reach
the debugging port, as it can reach BrowserBear's socket, so only sign this browser in to
what you'd let your agents use.

## Threadbear's Browser panel

The panel lists the pages a thread is using, in the agents' browser and in your own
Chrome profiles, each with a still of the page, the agent's mark (working, your turn)
and a Show window button that brings the page's real window to the front. It doesn't
stream pages or send input into them: you use the real window. It all goes through the
service's private Unix socket, and only the thread a page belongs to gets its still.

Stills of pages in the agents' browser are at most 3 s old while the panel asks. A page
in one of your Chrome profiles is captured through the extension's debugger, which keeps
Chrome's "started debugging" bar up, so its still is refreshed every 20 s at most, and
never once it's been handed to you. The service tracks the pages threads use in
`panel-tabs.json` (0600): profile, tab, thread and handoff count, no URLs or credentials.
Stills stay in memory.

`browserbear handoff <tab>` on a page in the agents' browser also asks Threadbear to
show the thread's Browser panel (without switching the thread you're on), as that
browser has no pill in the page; the panel's Done button finishes `handoff --wait`.

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
browserbear handoff 1234                       # your turn: the tab comes forward in your Chrome
browserbear handoff 1234 --wait                # ...and the agent carries on by itself when you've finished
```

Agents work in a window of BrowserBear's own, so they never take over the tab
you're looking at. When an agent needs you to do something in one of its tabs
(sign in, pay, approve), `handoff` moves the tab into the Chrome window you
last used and brings it to the front. `open` and `goto` say so when a page looks like
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
timeout (`--timeout <seconds>`, 20 minutes by default). The wait watches the tab's
address and a yes-or-no question to the page, without attaching a debugger just
to monitor it.

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

## Lending a tab

BrowserBear's toolbar button opens a popup for the tab you're on. Pick a recent
Threadbear thread (or New thread, with what you want done) and the tab is
lent to it: claimed for that thread, so it can click and type there without
`--user-tab`, and granted to it, so it may use that tab on its site even when
the site isn't on the allowed list. The grant is that tab and that thread only,
nothing goes on the list, and it ends when the tab is released (or ✕ on its
pill), closes, or the thread is archived or deleted. The thread gets a message
saying which tab it is. The tab stays yours: the thread is told not
to close it and to `release` it when it's done. Setup is a link at the bottom
of the popup.

## Sites agents may use

`allow.json` in BrowserBear's folder lists the sites agents may use: one list
for every thread, and one per thread that adds to it. With no list, agents may
use any site, as before. Once there is one, `open`, `goto`, `claim` and
`download` refuse other sites, every other command refuses a tab that's on one
(except `goto`, `close`, `release` and `handoff`, which get it out or give it to
you), and a click, key, eval or raw CDP call that lands a tab somewhere off the
list sends it back to the last allowed page in its history.

```sh
browserbear allow                                   # what's allowed
browserbear allow add localhost 127.0.0.1 '*.localhost'
browserbear allow add stripe.com --thread <id>      # one thread only
browserbear allow remove stripe.com --thread <id>
browserbear allow clear                             # every thread's list; any site again
```

Sites are hosts: `example.com` (that host), `*.example.com` (it and its
subdomains), `localhost:5173` (one port). Changing the list is refused from an
agent's thread (`THREADBEAR_THREAD_ID` set), so it's yours to change: in a
terminal, or with the popup's switch for the page's site. Lending a tab (the
popup, or Threadbear's @ picker) grants that one tab to that thread instead of
changing the list; `browserbear allow` lists the grants too.
It's a guardrail against agents wandering, not a sandbox: anything on this Mac
that can reach the service's socket could still change the file.

## Recording network traffic

```sh
browserbear har <tab> start
browserbear har <tab> stop [file] [--bodies] [--raw]   # writes a HAR 1.2 file, prints a summary
browserbear har <tab> status
```

While a tab records, the debugger stays on it (so in your own Chrome, its
"started debugging" bar stays up) and its Network events go to the service.
`stop` writes the file (0600, in `out/` unless you name one) and prints how
many requests there were, by host, and the failed and 4xx/5xx ones. Cookies and
auth headers are blanked unless `--raw`; bodies (response, and request ones)
are only kept with `--bodies`, and request bodies never when `fill` signed in
during the recording. A handoff detaches the debugger, so recording pauses
until the agent's next command in that tab; cancelling Chrome's bar, or a
service restart, ends it.

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
