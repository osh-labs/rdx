# Analytics and Tracking Removal

**Date:** 2026-07-26

Audit of every analytics, tracking, and third-party data-disclosure vector in the upstream codebase, and what was done about each.

---

## Removed

### 1. Cloudflare Web Analytics beacon

The only actual analytics package in the codebase, reporting to **the upstream author's account** — every page view from your self-hosted instance would have been sent to `overdevs`.

```html
<!-- Web Analytics --><script defer src="https://static.cloudflareinsights.com/beacon.min.js"
  data-cf-beacon='{"token": "5ce6e4ad5599462c8e3c36f2223a7184"}'></script>
```

Present in **10 files**. `run.php:43` was the source of truth — it injected the beacon into every page the build generated — with the rest being generated output or hand-maintained pages that bypass the build:

| File | Role |
|---|---|
| `run.php:43` | Build template — **the origin** |
| `public/index.html`, `subreddit.html`, `comments.html`, `search.html`, `user.html`, `userc.html` | Generated output |
| `public/inf.html` | Hand-maintained, bypasses the build |
| `public/r/subreddit.html`, `public/r/GainIt.html` | Stale snapshot of an older build |

All 10 removed. Verified zero remaining references to `cloudflareinsights` or `data-cf-beacon`.

### 2. Google reCAPTCHA (`contact.html`)

```html
<script src="https://www.google.com/recaptcha/api.js" async defer></script>
<div class="g-recaptcha" data-sitekey="6Ld4JBgoAAAAAJnSjUrI84em4zJ4m3A9rfPsBUwd"></div>
```

reCAPTCHA is a well-documented tracking and browser-fingerprinting vector, and the site key belongs to upstream — it would never have validated against your instance regardless. Both the loader and the widget div removed.

### 3. Browser fingerprint auto-collection (`contact.html`)

The contact form silently pre-filled the message body with a device fingerprint before the user typed anything:

```js
textarea.value += `User Agent: ${navigator.userAgent}\n`;
textarea.value += `Browser Language: ${navigator.language}\n`;
textarea.value += `Screen Resolution: ${window.screen.width}x${window.screen.height}\n`;
textarea.value += `Window Size: ${window.innerWidth}x${window.innerHeight}\n`;
```

Combined, those four values are a strong fingerprint, and they were posted to a third-party host (§4 below). Removed, along with the now-unused `const textarea` binding. Verified no orphaned references remain.

### 4. README accuracy

`README.md` claimed *"minimal tracking (Cloudflare anonymous analytics)"*. No longer true — updated to state this fork has none, and to point here.

---

## Remaining third-party callouts — not analytics, but worth knowing

These are functional dependencies rather than tracking, but each discloses your IP address, `User-Agent`, and referring URL to a third party. All are already scheduled in `implementation-plan.md`; listed here so the accounting is complete.

### Automatic requests on every page load

| Host | What | Disposition |
|---|---|---|
| `cdnjs.cloudflare.com` | `dashjs` 4.7.1 — `v.redd.it` video playback | Vendor into `assets/` — plan §7, phase 10 |
| `cdn.jsdelivr.net` | `ios-pwa-splash` 1.0.0 — iOS PWA splash screens | Drop; cosmetic only on a private instance |

### Conditional

| Host | What | Disposition |
|---|---|---|
| `fonts.googleapis.com` | Google Fonts, requested only when a non-default font is chosen in Settings (`functions.js:39`, and inline copies in `settings.html`, `contact.html`, `themes.html`) | Self-host the fonts you actually use — plan §7, phase 10 |

Once all three are removed, the `connect-src` / `script-src` CSP in plan §7 needs no third-party allowances at all, which is what makes that policy tight enough to be worth having.

### User-initiated

| Host | What | Recommendation |
|---|---|---|
| `support.overdevs.com` | `contact.html` posts the feedback form here (`contact.html:65`) | **Delete `contact.html`.** It sends feedback to the upstream author, who has abandoned the project. Left in place for now because deleting a page is beyond the scope of "remove analytics" — flagging rather than doing it silently. |

### Outbound links only

No automatic requests; they fire only if clicked: `buymeacoffee.com`, `apps.apple.com`, `play.google.com`, `github.com`, `offchess.com`, `at4klauncher.com`, `policies.google.com`, `www.apple.com`. Plan phase 10 strips the donation footer, store banners, and the OffChess promo interstitial (`functions.js:743`) as upstream cruft.

---

## Also worth flagging

**`public/privacy.html` is now misleading.** Its entire content describes in-app purchase data handling for the upstream iOS and Android apps — Google Play and App Store transaction records, receipt information, donation processing. None of that applies to a self-hosted web instance that has no payments and no app store presence. It should be rewritten or deleted during the restructure. Not touched here, since it is inaccurate documentation rather than active tracking.

**`rdx.overdevs.com`** remains hardcoded in `login.html:87` and `functions.js:904` as the OAuth redirect URI. Not a tracking issue — a functional one — and it is replaced by an origin-derived value in plan §3.2.

---

## Verification

```
$ grep -rniE "cloudflareinsight|recaptcha|gtag|google-analytics|googletagmanager|beacon|data-cf-beacon" \
    --include=*.html --include=*.js --include=*.php .
none
```

No analytics, tag manager, session recorder, error reporter, or advertising SDK exists anywhere in the tree. Once the two CDN loads and Google Fonts are vendored per the plan, a page load on the self-hosted instance will make requests to exactly two origins: your own, and Reddit's.
