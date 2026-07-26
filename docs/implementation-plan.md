# RDX Self-Host — Implementation Plan

**Target:** A single private instance on EC2, reachable only over Tailscale, reading and writing Reddit through the authenticated OAuth API, built by a shell script with no PHP.

**Decisions locked in:**

| Decision | Choice |
|---|---|
| Access | Tailscale private hostname (`https://rdx.<tailnet>.ts.net`) |
| OAuth client type | Installed app (public client, **no secret**) |
| Client ID | Entered at runtime in the UI, stored in `localStorage` |
| Redirect URI | Derived from `window.location.origin` — nothing hardcoded |
| CI | Build check on PRs only; no deploy, no write scopes |
| Build | `build.sh` (bash + coreutils), replacing `run.php` |

---

## 0. The finding that shapes everything

Both halves of the OAuth flow are CORS-enabled. Verified 2026-07-26:

```
OPTIONS https://www.reddit.com/api/v1/access_token
  → access-control-allow-origin: *
    access-control-allow-methods: POST
    access-control-allow-headers: Authorization

OPTIONS https://oauth.reddit.com/r/programming/hot
  → access-control-allow-origin: *
    access-control-allow-methods: GET, POST, PATCH, DELETE
    access-control-allow-headers: Authorization, Content-Type, X-Reddit-Web-Client
    access-control-expose-headers: X-Ratelimit-Used, X-Ratelimit-Remaining, X-Ratelimit-Reset
```

`Authorization` is permitted on both, and `application/x-www-form-urlencoded` is a CORS-safelisted `Content-Type` that needs no explicit grant. So the code exchange, the refresh, and every API call all run in the browser.

**Consequence: RDX stays a pure static site.** No proxy, no Node service, no secrets on the server. nginx serves files; your browser talks to Reddit. The EC2 instance's IP never touches Reddit, which sidesteps datacenter-IP reputation entirely.

Because the client is public (installed app), there is no client secret to leak — which is what makes runtime UI entry of the client ID safe. Today's code stores a *secret* in `localStorage` (`login.html:98`); after this change there is nothing secret to store.

---

## 1. Repository restructure

`run.php` only transforms the five files in `html/`. The other ten pages — including `login.html`, `settings.html`, and `inbox.html` — live only in `public/` and are hand-maintained, so they never receive the shared head or footer. That is the structural flaw underneath the duplication, and fixing it is a precondition for a clean build script.

**Before**

```
html/          5 page templates (built)
public/        5 generated + 10 hand-maintained pages + assets + functions.js
public/r/      stale snapshot of an older build
run.php        78-line PHP templater
```

**After**

```
build.sh              bash build, no PHP
config.example.json   documented defaults (scopes, user-visible strings)
src/
  pages/              ALL 15 pages, as sources
  partials/           head.html, header.html, footer.html, reply-modal.html
  js/
    auth.js           NEW — token lifecycle, redditFetch()
    api.js            NEW — endpoint builders, typed calls
    functions.js      EXISTING — rendering + UI, transport calls swapped
  css/styles.css
assets/               images, splash screens, manifest, favicons
dist/                 build output (gitignored)
```

**Deletions:** `run.php`, `public/r/` (stale duplicate), `public/inf.html` (near-copy of `subreddit.html`), `.github/workflows/run.yml`.

**Note on `dist/` being gitignored.** You chose "CI build check," whose sketch compared committed output with `git diff --exit-code public/`. I'd recommend not committing build output at all and having CI assert the build *succeeds and produces the expected files*. Same intent — catch build breakage — without the committed-generated-files problem that currently forces the workflow to push back to `main`. Say the word if you'd rather keep output committed; it's a two-line difference in the workflow.

---

## 2. `build.sh`

`run.php` does four things: splice a head blob into a marker, vary a robots meta tag, splice a footer + reply modal before `</body>`, and inject an SEO block into `index.html`. Three of those become unnecessary on a private instance.

**What gets dropped as dead weight on a private site:** the SEO infotext block, the `index,follow` robots variation (everything becomes `noindex,nofollow`), the App Store / Play Store banners, the Buy Me a Coffee footer, the OffChess promo interstitial (`functions.js:743`), and the Cloudflare Insights beacon (`run.php:43` — that's the upstream author's analytics token).

**Mechanism.** Pages declare a title and pull in partials:

```html
<!--#title Comments -->
<!--#include head -->
<!--#include header -->
...page body...
<!--#include reply-modal -->
<!--#include footer -->
```

The expander is a bash `while read` loop — no gawk, no sed multiline gymnastics, no external dependencies beyond coreutils:

```bash
expand() {                                    # $1 = file, $2 = depth guard
  (( $2 > 8 )) && { echo "build: include loop in $1" >&2; exit 1; }
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line =~ \<!--\#include\ ([a-zA-Z0-9_-]+)\ --\> ]]; then
      expand "$SRC/partials/${BASH_REMATCH[1]}.html" $(( $2 + 1 ))
    else
      printf '%s\n' "${line//\{\{TITLE\}\}/$TITLE}"
    fi
  done < "$1"
}
```

`build.sh` then: `set -euo pipefail` → clean `dist/` → copy `assets/`, `src/css`, `src/js` → for each page, read its `<!--#title -->`, expand, write to `dist/`. Idempotent, and it must pass `shellcheck`.

Roughly 60 lines. It replaces 78 lines of PHP and removes `php-cli` from the deployment entirely.

---

## 3. Auth layer — `src/js/auth.js` (new)

### 3.1 The blocking scope bug

`login.html:101` currently requests:

```
scope=submit,edit,identity,vote,privatemessages
```

No `read`. The existing flow was provisioned only for writing, because reading used to be unauthenticated. Ported as-is, **every content request would 403 even with a valid token.** New scope set:

```
read identity mysubreddits history subscribe save vote submit edit privatemessages
```

`mysubreddits` and `subscribe` are what enable the subscription work in §5.

### 3.2 Redirect URI

Derived, not hardcoded:

```js
const REDIRECT_URI = window.location.origin + '/login.html';
```

This deletes the hardcoded `https://rdx.overdevs.com/login.html` from both `login.html:87` and `functions.js:904`, and means the same build works on your Tailscale hostname and on `localhost` during development. You register `https://rdx.<tailnet>.ts.net/login.html` at `reddit.com/prefs/apps`; Reddit matches it exactly.

### 3.3 CSRF fix

`login.html:101` sends the literal string `state=random_state` and never checks it on return. Replace with a real nonce:

```js
const state = crypto.getRandomValues(new Uint8Array(16))
  .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
sessionStorage.setItem('oauth_state', state);
// on return: reject if params.get('state') !== sessionStorage.getItem('oauth_state')
```

### 3.4 Token exchange (installed app — empty secret)

```js
headers: { 'Authorization': 'Basic ' + btoa(clientId + ':') }
body:    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })
```

Note the trailing colon with nothing after it — that is the installed-app convention, and it is why no secret ever enters the browser.

### 3.5 `redditFetch()` — the core of the change

Today, refresh-on-expiry lives inside `apiAction()` (`functions.js:898`) and only guards *write* calls, because reads never needed a token. Every read now needs one, so refresh has to move in front of all traffic. One wrapper, used by everything:

```js
async function redditFetch(path, { method = 'GET', body, retry = true } = {}) {
  const token = await getValidToken();          // refreshes if within 60s of expiry
  const res = await fetch('https://oauth.reddit.com' + path, {
    method,
    headers: { 'Authorization': 'bearer ' + token,
               ...(body && { 'Content-Type': 'application/x-www-form-urlencoded' }) },
    body,
  });
  if (res.status === 401 && retry) {            // token rejected despite not looking expired
    await forceRefresh();
    return redditFetch(path, { method, body, retry: false });
  }
  if (res.status === 429) throw new RateLimitError(res.headers.get('X-Ratelimit-Reset'));
  if (!res.ok) throw new RedditError(res.status, path);
  return res.json();
}
```

Single in-flight refresh (a module-level promise) so concurrent calls during infinite scroll don't fire N parallel refreshes and race each other into invalidating the refresh token.

`X-Ratelimit-Remaining` is in `access-control-expose-headers`, so the actual budget is readable from JS and can be surfaced in Settings.

**Not-logged-in state.** Every page currently assumes content loads anonymously. Each entry point gains a guard: no refresh token → render a "Connect your Reddit account" panel linking to `login.html`, rather than the current failure mode of a blank page or an error blob. This replaces the hardcoded shutdown notice at `functions.js:112` and `:216`.

---

## 4. Transport rewrite — restoring reading

JSONP is unusable now for a reason beyond the 403: a `<script src=...>` tag cannot carry an `Authorization` header. Every JSONP call site must be rewritten no matter what, so all four go to `fetch` via `redditFetch`.

`src/js/api.js` centralises endpoint construction so no page string-builds URLs anymore:

| Call site | Current | Replacement |
|---|---|---|
| `functions.js:138` `makereq` (JSONP) | `www/old.reddit.com/….json` | `api.listing(path, opts)` |
| `functions.js:244` `scorllmore` (JSONP) | same + `after` | `api.listing(…, {after})` |
| `functions.js:77` `xmakereq` (XHR) | dead pre-JSONP path | **delete** |
| `comments.html:81` `doit` (JSONP) | `www.reddit.com{permalink}.json` | `api.comments(permalink, sort)` |
| `comments.html:220` `loadmore` (JSONP) | `…/api/morechildren.json` | `api.moreChildren(linkId, ids)` |
| `userc.html:78` (inline XHR) | `old.reddit.com/user/{u}/comments.json` | `api.userComments(u)` |
| `functions.js:400` `searchsubs` (XHR) | `old.reddit.com/api/subreddit_autocomplete` | `api.autocomplete(q)` |

The mechanical rule is: drop `.json`, host becomes `oauth.reddit.com`, attach the bearer token. Query params (`limit`, `after`, `before`, `t`, `sort`, `restrict_sr`, `include_over_18`) carry over unchanged.

**Two correctness fixes to fold in while touching these:**

- **`best` is not a valid subreddit sort.** `subreddit.html:49` and `index.html:50` both offer a "Best" link, producing `/r/x/best`. On the old endpoint that redirected to hot; on the OAuth API it 404s. Map `best → hot` for subreddit and user listings; keep `best` only for the front page, where it is real.
- **`t=` is only meaningful for `top` and `controversial`.** Currently appended unconditionally. Harmless before, worth gating now.

**What does not change:** `postbuilder()`, `cbuilder()`, `urlpreview()`, and `pollbuilder()` — about 450 lines, and the actual product. `oauth.reddit.com` returns identical `Listing` JSON. This is the reason the whole migration is tractable.

---

## 5. Authenticated feature upgrades

These are the §8 items from the evaluation. They are what turn this from a restoration into an improvement.

### 5.1 Real subscriptions

Today, subscriptions live in `localStorage` and are populated by a **bookmarklet you paste into `old.reddit.com`** to scrape your own sub list (`settings.html:49`). The home feed is then built by concatenating them into `r/sub1+sub2+sub3…` (`index.html:62–68`), which breaks past URL length limits once you have enough subs.

Replace with:

- `GET /subreddits/mine/subscriber?limit=100` — paginated through `after`, cached in `localStorage` with a timestamp, refreshed on demand from Settings.
- Home feed becomes `GET /hot` (or `/best`, `/new`, `/top`, `/rising`) on `oauth.reddit.com` — which *is* your front page when authenticated. The multireddit string disappears.
- Subscribe/unsubscribe buttons (`functions.js:411–416`) call `POST /api/subscribe` with `action=sub|unsub&sr_name=…`, writing through to Reddit instead of only to `localStorage`.
- **One-time migration:** on first authenticated load, if `localStorage.subs` exists, offer to merge it into your real Reddit subscriptions rather than silently discarding it.
- Retire the bookmarklet section of `settings.html` entirely.

### 5.2 Real saved posts

`saveit()` (`functions.js:819`) stores `{url, title, subreddit}` in `localStorage`, invisible to Reddit and to every other client. Replace with `POST /api/save` / `POST /api/unsave` and read `GET /user/{me}/saved`. Keep the local list as a read-only "legacy saves" section so nothing you already saved is lost.

### 5.3 Voting

`vote` scope has been requested since day one but no vote UI was ever built. Add up/down controls to `postbuilder` and `cbuilder` calling `POST /api/vote` (`id`, `dir` ∈ `1|0|-1`), with optimistic score updates and rollback on failure.

### 5.4 Inbox

Fix the destructuring bug (§6), add an unread badge from `GET /message/unread`, and wire the existing reply modal to inbox items.

---

## 6. Bug fixes

Carried from the evaluation, all confirmed by reading:

| Location | Bug | Fix |
|---|---|---|
| `functions.js:1092` | Destructures `item.inboxMessages`, which does not exist; throws on every message | Should be `item.data` |
| `functions.js:425` | Crosspost guard's second clause defeats its own null check: for `crosspost_parent_list === null` it passes `typeof x !== 'undefined'` and then reads `null.length`, throwing and killing the render | Use `Array.isArray()` |
| `comments.html:133` | `handlerepliesmn` reads `repliesls[replyx]` from the wrong scope | Use its own loop variable |
| `comments.html:150` | `handlerepliesm` reads `repliesl[reply]` from the wrong scope | Same |
| `login.html:57` vs `:145` | Says "3 seconds", timer is 20000 ms | 3000 ms |
| `comments.html:220` | Hardcoded `&r=AskReddit` in the morechildren URL | Use the actual subreddit |
| `functions.js:647` | gfycat branch — service shut down 2023 | Delete |
| `functions.js:135` / `comments.html:49` | `callbackCounter` declared twice | Moot once JSONP is gone |

**Implicit globals.** `fill`, `posts`, `pid`, `returnfpost`, `subslist`, `url`, `substoload` are all undeclared. Adding `'use strict'` to each module surfaces every one at load time rather than as silent cross-feature collisions. Doing this as its own commit makes the resulting diff reviewable.

---

## 7. Content security

All rendering is string concatenation into `innerHTML`, and `htmlDecode()` (`functions.js:355`) explicitly *un*-escapes `body_html` / `selftext_html` before injection. Reddit sanitizes that HTML server-side, so the practical risk is low — but your OAuth refresh token now lives in `localStorage` on the same origin, which raises the cost of being wrong.

Full CSP isn't reachable without eliminating inline `onclick=` handlers throughout — out of scope for this move. But a **`connect-src` restriction is reachable now and is the mitigation that actually matters**, because it means injected script cannot exfiltrate the token to an attacker-controlled host:

```nginx
add_header Content-Security-Policy "
  default-src 'self';
  connect-src 'self' https://oauth.reddit.com https://www.reddit.com;
  img-src 'self' data: https://*.redd.it https://*.redditmedia.com https://*.thumbs.redditmedia.com;
  media-src 'self' https://*.redd.it;
  frame-src https://www.redgifs.com;
  script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline';
" always;
```

`script-src 'unsafe-inline'` is the concession; everything else is tight. Vendor `dashjs` into `assets/` rather than loading it from cdnjs (`run.php:17`) so `script-src` needs no CDN allowance, and drop the jsdelivr `ios-pwa-splash` and Google Fonts loads (`functions.js:39`) for the same reason — self-host the fonts you actually use.

---

## 8. CI — `.github/workflows/ci.yml`

Delete `run.yml`. It grants twelve write scopes to `GITHUB_TOKEN` for a static-site deploy and force-pushes generated files back to `main`.

Replacement runs on pull requests with `permissions: contents: read` and no secrets:

```yaml
- run: shellcheck build.sh
- run: ./build.sh
- run: test -f dist/index.html && test -f dist/functions.js   # output sanity
- run: for f in src/js/*.js; do node --check "$f"; done        # syntax check, no deps
```

`node --check` gives a parse check on every JS file without introducing a `package.json` or a dependency tree. Worth having, given there are currently no tests of any kind.

---

## 9. Deployment — EC2 + Tailscale

The instance serves static files and makes no outbound Reddit calls, so this is small.

```
t4g.nano, Amazon Linux 2023 or Ubuntu 24.04
Security group: NO public inbound. Tailscale is outbound-only (UDP 41641, DERP fallback over 443).
```

```bash
# nginx bound to loopback only
server { listen 127.0.0.1:8080; root /var/www/rdx; ... }

# Tailscale terminates TLS with a real Let's Encrypt cert for the ts.net name
tailscale serve --bg --https=443 http://127.0.0.1:8080
```

This is the cleanest part of the whole design: **no certbot, no DNS, no public listener, and a valid certificate.** Reddit requires an `https://` redirect URI (only `localhost` is exempt), and `tailscale serve` provides exactly that for `rdx.<tailnet>.ts.net`.

Deploy is `git pull && ./build.sh && rsync -a --delete dist/ /var/www/rdx/`. A `deploy.sh` wrapping those three lines is worth committing.

**Reddit app registration:** `reddit.com/prefs/apps` → create app → type **installed app** → redirect URI `https://rdx.<tailnet>.ts.net/login.html`. Copy the client ID (the string under the app name). There is no secret for this app type.

---

## 10. Sequencing

One branch, one PR, but ordered commits so the diff stays reviewable. Phases 1–2 are mechanical and safe; 3–4 are where the real risk sits.

| # | Commit | Risk |
|---|---|---|
| 1 | Restructure into `src/` + `assets/`; add `build.sh`; delete `run.php`, `public/r/`, `inf.html` | Low — pure moves, output byte-comparable |
| 2 | Replace `run.yml` with `ci.yml` | Low |
| 3 | `'use strict'` + fix implicit globals + §6 bug fixes | Low, isolated |
| 4 | `auth.js` — scopes, installed-app flow, derived redirect URI, state nonce, `redditFetch` | **Medium** — nothing works until §5 lands |
| 5 | `api.js` + rewrite all 7 call sites from JSONP/XHR to `fetch` | **High — this is the one that restores reading** |
| 6 | Logged-out guards; remove the hardcoded shutdown notices | Low |
| 7 | Real subscriptions + `/hot` front page + migration prompt | Medium |
| 8 | Real saved posts; voting UI | Medium |
| 9 | Inbox fix + unread badge | Low |
| 10 | Vendor `dashjs`/fonts; strip analytics, store banners, promos | Low |
| 11 | `deploy.sh`, nginx conf, CSP header, README | Low |

**Estimate: 4–5 focused days.** Commits 1–5 (~2 days) get you to a working private instance; 7–9 (~1.5 days) are the upgrades; the rest is cleanup and deployment.

---

## 11. Verification

Each of these is a manual check against the live instance after deploy — there is no test harness to lean on, which is precisely why the list is explicit.

**Auth:** first-run client ID prompt → authorize → redirect back → username appears in the sidebar · reload survives · token auto-refreshes after 1 h (or fake it by rewinding `expiresIn`) · mismatched `state` is rejected · logout clears every key.

**Reading — this is "restore functionality":** front page loads · a specific subreddit loads · each sort (`hot`/`new`/`top`/`rising`) · `t=` variants on `top` · infinite scroll paginates via `after` without duplicating posts · comment thread loads · every comment sort · "Load More" expands deep threads · global search · subreddit-scoped search · user posts · user comments · subreddit autocomplete.

**Rendering (unchanged code — confirming the JSON shape really is identical):** self-post text · single image · GIF/MP4 · gallery with thumbnail switching · `v.redd.it` DASH video · redgifs embed · external link with thumbnail · crosspost — *specifically check this one*, since §6 fixes a state-corruption bug in exactly that path · poll · NSFW gate · removed/deleted posts.

**Media:** confirm `preview.redd.it` signed URLs still render. They arrive pre-signed in the API response and those hosts were not part of the `.json` shutdown, so I expect them to work — but it is the one thing I could not verify without a token, and it is worth checking first, since a failure there would change the media strategy.

**Writes:** subscribe/unsubscribe reflects on reddit.com · save/unsave reflects on reddit.com · upvote/downvote/clear · comment reply · edit own comment · delete own comment · inbox renders (currently throws) · unread badge.

**Rate limits:** watch `X-Ratelimit-Remaining` during heavy infinite scrolling; confirm normal use stays far inside 100 QPM.

**Build/deploy:** `build.sh` is idempotent · passes `shellcheck` · no PHP anywhere on the box · CI green on PR · site unreachable from the public internet (verify from a non-Tailscale network) · CSP header present and `connect-src` blocks a test request to an unlisted origin.

---

## 12. Open risks

- **Media URL signing.** If Reddit moves to authenticated or short-TTL signed media URLs, image and video rendering needs rework. Not currently the case.
- **Further contraction.** Third tightening since 2023 (paid API 2023, unauthenticated JSON 2026, RSS now also 403). A single-account personal client is the least likely target, but the trend is one direction.
- **Client ID suspension.** Tied to your account. Staying under 100 QPM and keeping the instance on Tailscale-only is the mitigation — see §7 of the evaluation on why public reachability is the line that matters.
- **No test coverage.** Everything above is verified by hand. If this becomes something you rely on daily, a small Playwright smoke suite against a recorded fixture set is the natural follow-up — deliberately out of scope here to keep the move to one reviewable change.
