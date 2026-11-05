// Decides when the user has finished in a tab handed to them, from repeated
// looks at it, so they needn't go back to the thread and type "done" (5 Nov).
// Pure, and run by the CLI rather than the service: the service restarts
// whenever its code changes, and a wait can last twenty minutes.

// Long enough for a redirect chain (OAuth's hops are usually under a second
// each) to get to where it's going.
const SETTLE_MS = 2_500;
// Some apps never reach "complete" (the Cloud console's spinners).
const STILL_LOADING_MS = 15_000;
// Handed off mid-redirect: the page it lands on is the handoff page, not the hop.
const BASELINE_MS = 5_000;

// Pages of a sign-in, in the host and path only: a query can say anything
// (Google's says continue=console.cloud.google.com). Whole words, so "/authors"
// and "/verified-buyers" don't count. Moving between these isn't finishing:
// Google goes from a password page to a code page to a consent page.
const SIGN_IN_HOST = /^(accounts|login|signin|auth|sso|id)\./i;
const SIGN_IN_WORD = /(^|[./_-])(log-?_?in|sign-?_?(in|on|up)|o?auth\d?|reauth|authenticate|authentication|authori[sz]e|webauthn|sso|saml|oidc|mfa|2fa|2sv|two-?_?factor|otp|challenge|verify|verification|consent|checkpoint|captcha|password|accountchooser)([./_-]|$)/i;

export function looksLikeSignIn(url) {
  try {
    const u = new URL(url);
    return SIGN_IN_HOST.test(u.hostname) || SIGN_IN_WORD.test(u.hostname + u.pathname);
  } catch {
    return false;
  }
}

// Which page a URL is. Only a hash that routes counts ("#/billing"), not one
// that scrolls. A query change isn't a new page: sign-ins shuffle their state in it.
function pageOf(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname + (/^#[/!]/.test(u.hash) ? u.hash : '');
  } catch {
    return url;
  }
}

// `*` is any run of characters, and the rest is literal (URLs are full of `?`).
// With no `*` it's any part of the URL. A pattern needn't say https://.
export function urlMatches(pattern, url) {
  if (!pattern.includes('*')) return url.includes(pattern);
  const body = pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^(https?://)?${body}$`).test(url);
}

// see(look, at) takes what the service found (service.mjs, handoffLook) and
// returns why the user is finished, or null if they aren't yet.
export function createHandoffWatch({ untilUrl, untilText, start }) {
  let base = null;
  let left = false;
  let current = null;
  let changedAt = start;

  return {
    see(look, at) {
      if (look.doneClicked) return 'they clicked Done in the tab';
      if (!base || (base.status !== 'complete' && at - start < BASELINE_MS)) base = look;
      // Handed back: nothing else to wait for, wherever the page has got to.
      if (look.bear && !base.bear) return "they moved it back to BrowserBear's window";

      const here = pageOf(look.url);
      if (here !== current) {
        current = here;
        changedAt = at;
      }
      const quietFor = at - changedAt;
      const loaded = look.status === 'complete' || quietFor >= STILL_LOADING_MS;

      // Asked for something specific: that's the only thing that counts.
      if (untilText || untilUrl) {
        if (untilText && look.text) return `"${untilText}" is on the page`;
        if (untilUrl && urlMatches(untilUrl, look.url) && loaded && !look.loadError) return `the tab reached ${untilUrl}`;
        return null;
      }

      const away = here !== pageOf(base.url);
      left ||= away;
      if (look.loadError || !loaded || quietFor < SETTLE_MS) return null;
      if (looksLikeSignIn(look.url) || look.signInForm) return null;
      if (away) return 'the tab left the page it was handed over on';
      // Back where it started, by way of somewhere else: a sign-in that returns you.
      if (left) return 'the tab went away and came back';
      // A sign-in in the page itself, whose address never changes. Strictly
      // false: null means the page couldn't be asked, not that the form went.
      if (base.signInForm && look.signInForm === false) return 'the sign-in form on the page has gone';
      return null;
    },
  };
}
