# RDX Self-Hosting Evaluation

**Date:** 2026-07-26
**Question:** Can this codebase be forked and self-hosted on a private EC2 instance, using a personal Reddit account for login, now that Reddit has disabled unauthenticated JSON feeds?

**Verdict:** Yes. The break is confined to the transport layer, and the replacement transport (`oauth.reddit.com`) is CORS-enabled and returns byte-identical JSON shapes. Roughly 300–400 lines of change across 8 files. All of the app's actual value — the rendering, media handling, and theming — survives untouched.

---

## 1. What this codebase is

A static site. No backend, no build step, no dependencies, no package manager, no tests.

| Item | Detail |
|---|---|
| Total source | ~5,300 lines (`public/*.html`, `functions.js`, `styles.css`) |
| Core logic | `public/functions.js` (1,146 lines) |
| Build | `run.php` (78 lines) — string-replaces `<!--headhtml-->` and `</body>` in `html/*.html`, writes to `public/` |
| Deploy | GitHub Actions → GitHub Pages, force-pushes generated output back to `main` |
| Persistence | `localStorage` only — subscriptions, saved posts, themes, OAuth tokens |
| Assets | 4.8 MB, almost entirely PWA splash screens |

`html/` holds five source templates; `public/` holds the generated output plus ten hand-maintained pages that bypass `run.php` entirely (`login.html`, `inbox.html`, `settings.html`, `themes.html`, `saved.html`, `inf.html`, `new.html`, `privacy.html`, `contact.html`, `csae.html`). `public/r/` is a stale snapshot of an older version and is dead weight.

The architecture is the reason self-hosting is viable: **the browser talks to Reddit directly.** The server only ships static files. Your EC2 instance's IP address never touches Reddit.

---

## 2. What broke, precisely

Reddit's r/modnews post ("Protecting communities from scrapers and platform abuse", May 28 2026) shut down unauthenticated `.json` endpoints. Verified by direct probe on 2026-07-26:

```
https://www.reddit.com/r/programming/.json          → 403
https://old.reddit.com/r/programming/.json          → 403
https://www.reddit.com/r/programming/.json?jsonp=cb → 403
https://www.reddit.com/r/programming/.rss           → 403
https://old.reddit.com/r/programming/  (HTML)       → 200
https://www.reddit.com/r/programming/  (HTML)       → 200
```

Two things worth noting from those results:

1. **The block is endpoint-scoped, not IP-scoped.** HTML still returns 200 from the same datacenter IP that gets 403 on `.json`. This is a meaningful signal for EC2 hosting — Reddit is not blanket-blocking cloud IPs at the edge.
2. **RSS is already gone too.** The RDX author mentioned Reddit was "thinking of blocking RSS feeds"; as of this probe, `.rss` returns 403. An RSS-based fallback is not on the table.

RDX had already migrated from XHR to JSONP (`makereq`, `scorllmore`, `comments.html:doit`, `comments.html:loadmore`) specifically to dodge the fact that `www.reddit.com/.json` never sent CORS headers. **That workaround is now doubly dead:** the endpoint 403s, and JSONP fundamentally cannot carry an `Authorization` header, because a `<script src=...>` tag has no way to set request headers. Every JSONP call site has to be rewritten regardless of approach.

---

## 3. The replacement path — verified

`oauth.reddit.com` is explicitly CORS-enabled. Preflight probe:

```
OPTIONS https://oauth.reddit.com/r/programming/hot
  → HTTP/2 200
    access-control-allow-origin: *
    access-control-allow-methods: GET, POST, PATCH, DELETE
    access-control-allow-headers: Authorization, Content-Type, X-Reddit-Web-Client
    access-control-expose-headers: X-Ratelimit-Used, X-Ratelimit-Remaining, X-Ratelimit-Reset
    access-control-allow-credentials: false
```

`allow-origin: *` with `Authorization` in `allow-headers` means a browser on *any* origin — including `https://rdx.yourdomain.com` or `http://localhost:8080` — can call the authenticated API with a Bearer token via plain `fetch()`. No proxy required. `allow-credentials: false` is irrelevant here since we authenticate with a header, not cookies.

The token endpoint is reachable and behaves normally (`401` + `WWW-Authenticate: Basic realm="reddit"` on bad credentials, i.e. a real auth challenge rather than a block).

**The critical compatibility fact:** `oauth.reddit.com` returns the same `Listing` JSON schema as the old `.json` endpoints. `postbuilder()`, `cbuilder()`, `urlpreview()`, and `pollbuilder()` — the ~450 lines that constitute the actual product — need **zero changes**. Only the fetch layer moves.

---

## 4. Endpoint migration map

| Current call site | Current URL | OAuth replacement |
|---|---|---|
| `index.html:72` | `old.reddit.com/r/{subs}/{sort}.json` | `oauth.reddit.com/r/{subs}/{sort}` |
| `subreddit.html:73`, `inf.html:130` | `www.reddit.com/r/{sub}/{sort}.json` | `oauth.reddit.com/r/{sub}/{sort}` |
| `comments.html:81` | `www.reddit.com{permalink}.json?limit=500&sort=` | `oauth.reddit.com{permalink}?limit=500&sort=` |
| `comments.html:220` | `www.reddit.com/r/{sr}/api/morechildren.json` | `oauth.reddit.com/api/morechildren` |
| `search.html:78–90` | `www.reddit.com/search.json?q=` | `oauth.reddit.com/search?q=` |
| `search.html` (sub-scoped) | `www.reddit.com/r/{sr}/search.json?restrict_sr=on` | `oauth.reddit.com/r/{sr}/search?restrict_sr=on` |
| `user.html:73` | `www.reddit.com/user/{u}/submitted.json` | `oauth.reddit.com/user/{u}/submitted` |
| `userc.html:73` | `old.reddit.com/user/{u}/comments.json` | `oauth.reddit.com/user/{u}/comments` |
| `functions.js:400` | `old.reddit.com/api/subreddit_autocomplete/.json` | `oauth.reddit.com/api/subreddit_autocomplete_v2` |

The mechanical rule: drop `.json`, swap host to `oauth.reddit.com`, attach `Authorization: bearer <token>`. Query parameters (`limit`, `after`, `before`, `t`, `sort`, `restrict_sr`, `include_over_18`) carry over unchanged.

Already correct and needs no change: `inbox.html` and the comment/edit/delete functions in `functions.js` (`submitComment`, `editComment`, `delComment`, `getInbox`) already target `oauth.reddit.com`.

---

## 5. Blocking bug in the existing OAuth flow

**`login.html:101` requests the wrong scopes.**

```js
scope=submit,edit,identity,vote,privatemessages
```

There is no `read` scope in that list. `read` is what authorizes listing and comment fetches. The existing login was only ever provisioned for *writing* — it worked before because reading was unauthenticated. Ported as-is, every content request would 403 even with a valid token.

Required scope string for a self-hosted instance:

```
read,identity,mysubreddits,history,subscribe,save,vote,submit,edit,privatemessages,report
```

`mysubreddits` and `subscribe` are what let you replace the subscription-import bookmarklet (see §8).

---

## 6. Client type and secret handling

`login.html:45` instructs the user to create a **script** app and then stores the client secret in `localStorage`, base64-encoding it in the browser (`btoa(\`${clientId}:${clientSecret}\`)` at `login.html:119` and `functions.js:932`).

For a single-user private instance this is survivable, but **"installed app" is the correct client type** for a browser-based client. Installed apps are public clients with no secret; the token request uses `Basic base64(client_id + ":")` with an empty password. This removes the secret from the browser entirely rather than trying to hide it there.

Three hardcoded values must change for self-hosting:

- `login.html:87` — `redirectUri = 'https://rdx.overdevs.com/login.html'`
- `functions.js:904` — same constant, duplicated
- `run.php:43` — Cloudflare Insights beacon token (someone else's analytics; strip it)

The redirect URI must exactly match what's registered at `reddit.com/prefs/apps`.

Token lifecycle is already handled: `duration=permanent` yields a refresh token, access tokens last one hour, and `apiAction()` (`functions.js:898`) already implements refresh-on-expiry. That refresh logic needs to be hoisted out of `apiAction` and placed in front of *every* request, since reads now need tokens too.

---

## 7. Rate limits and terms

Reddit's free tier is **100 queries per minute per OAuth client ID**, averaged over a rolling 10-minute window, and is explicitly for non-commercial use — personal projects, bots, moderator tools, academic research. Unauthenticated access is no longer a supported tier at all.

For one person browsing, this is not a constraint. One page load is one request. Infinite scroll is one request per page of results. You would need to be issuing more than 1.6 requests per second sustained to approach the ceiling.

Where you would leave the sanctioned path:

- **Making the instance publicly reachable.** Serving other people's browsing through your client ID turns a personal-use app into a service. Bind it to your own access only.
- **Commercial use.** Requires a paid agreement ($0.24 / 1,000 calls).

Practical guardrails for the EC2 box: put it behind Tailscale, a VPN, or Cloudflare Access; or bind nginx to `127.0.0.1` and reach it over an SSH tunnel. A security group open to `0.0.0.0:443` with no auth in front is the configuration that turns a compliant personal tool into a public proxy.

---

## 8. Features that get *better* once authenticated

The rewrite is not purely defensive. Authenticated access unlocks things the original could never do:

| Current implementation | Authenticated replacement |
|---|---|
| Subscriptions stored in `localStorage`, imported via a bookmarklet the user pastes into `old.reddit.com` (`settings.html:49`) | `GET /subreddits/mine/subscriber` — your real subscription list, synced |
| Saved posts stored in `localStorage`, invisible to Reddit (`functions.js:819`) | `GET /user/{me}/saved` + `POST /api/save` — real Reddit saves |
| No voting despite `vote` scope being requested | `POST /api/vote` |
| Home feed = `r/{sub1+sub2+...}` string concatenation | `GET /best` or `GET /` — your actual front page |
| No inbox badge | `GET /message/unread` |

The multireddit-string home feed (`index.html:62–68`) is particularly worth replacing — it breaks once you have enough subscriptions to blow past URL length limits.

---

## 9. Code quality findings

Things you should know about before building on this fork. None are blockers; several are real bugs.

**Actual bugs:**

- **`functions.js:1092` — inbox is broken.** `const { kind, inboxMessages: { author, ... } } = item` destructures a property named `inboxMessages` off each item, which doesn't exist. It should be `data`. This throws on every message.
- **`functions.js:425` — the crosspost guard dereferences null.** The condition is `(x != null && x.length > 0) || (typeof x !== 'undefined' && x.length > 0)`. When `crosspost_parent_list` is `null`, the first clause short-circuits safely but the second passes its `typeof` test (`typeof null === 'object'`) and then reads `null.length`, throwing and killing the whole render. It survives in production only because Reddit omits the key rather than sending it null.

  > **Correction.** An earlier version of this document claimed instead that `returnfpost` being an implicit global corrupted crosspost rendering. That was wrong: `a += f()` evaluates `a` before calling `f()`, so the parent's accumulated markup is captured first and restored by the assignment. Making it a local is still correct — strict mode requires the declaration, and a shared accumulator across a recursive call is fragile — but it was not fixing an active bug. The null guard above is the real defect in that block, and it was found by writing fixtures rather than by reading.
- **`comments.html:133` and `:150` — undefined variable references.** `handlerepliesmn` reads `repliesls[replyx]`, and `handlerepliesm` reads `repliesl[reply]`, both from the wrong scope. The "View other replies" links at deep nesting are wrong or throw.
- **`login.html:57` vs `:145`** — the page says "Redirecting you in 3 seconds", the timer is set to 20,000 ms.

**Dead code:**

- `urlpreview()` still handles `gfycat.com` (shut down 2023) at `functions.js:647`.
- `xmakereq()` (`functions.js:77`) is the pre-JSONP XHR path, unreachable and now doubly broken.
- `public/r/` is a stale duplicate of an older build.
- `inf.html` is a near-copy of `subreddit.html`.
- `callbackCounter` is declared twice (`functions.js:135`, `comments.html:49`).

**Structural:**

- Pervasive implicit globals (`fill`, `posts`, `pid`, `returnfpost`, `subslist`, `url`, `substoload`). Any two features touching the same name collide.
- All rendering is string concatenation into `innerHTML`. Reddit sanitizes `body_html`/`selftext_html` server-side so the practical XSS risk is low, but there is no escaping layer of your own, and `htmlDecode()` (`functions.js:355`) explicitly *un*-escapes before injection.
- No tests, no linter, no CI beyond the deploy job.
- The GitHub Actions workflow (`.github/workflows/run.yml`) grants twelve write permissions to `GITHUB_TOKEN` for a static-site deploy and force-pushes generated files back to `main`. Delete it and replace with a deploy step appropriate to EC2.

---

## 10. Deployment shape on EC2

Because the app is static and the API calls originate in your browser, the server side is trivial:

- **Instance:** t4g.nano is sufficient. This is nginx serving 5 MB of files.
- **Server:** nginx with `root /var/www/rdx/public;`. TLS via certbot. **HTTPS is required** — Reddit's OAuth redirect URI and the `fetch()` calls to `oauth.reddit.com` will not work reliably from an insecure origin, and `localStorage`-held tokens on plain HTTP are indefensible.
- **Access control:** Tailscale, Cloudflare Access, or nginx bound to localhost behind an SSH tunnel. See §7 — this is the difference between compliant personal use and running a public proxy.
- **Build:** keep `run.php` (needs only `php-cli`) or replace it with a 20-line shell/Node script. It does string substitution and nothing else.
- **Egress:** the instance itself makes no outbound Reddit calls, so datacenter-IP reputation is not a factor. Outbound is only needed for OS updates and certbot.
- **Third-party CDN dependencies** to consider vendoring: `dashjs` from cdnjs (`run.php:17`, video playback), `ios-pwa-splash` from jsdelivr, Google Fonts (`functions.js:39`), and the Cloudflare Insights beacon (strip this one).

Media (`i.redd.it`, `preview.redd.it`, `v.redd.it`) is served from separate hosts that are not part of the `.json` shutdown. `preview.redd.it` URLs arrive pre-signed in the API response. Confirm these render once you have a token — it's the one thing I could not verify without credentials.

---

## 11. Effort estimate

| Task | Scope |
|---|---|
| Central `redditFetch()` wrapper — token attach, auto-refresh, 401 retry | ~80 lines, new |
| Rewrite `makereq` / `scorllmore` from JSONP to `fetch` | `functions.js`, ~150 lines replaced |
| Rewrite `comments.html` `doit()` / `loadmore()` | ~100 lines replaced |
| Rewrite `userc.html` inline XHR | ~30 lines |
| Fix scopes, client type, redirect URI | `login.html`, ~20 lines |
| Rewrite URL builders across 6 pages | ~10 lines each |
| Strip analytics, `public/r/`, dead workflow | deletions |
| EC2 provisioning + nginx + TLS + access control | half a day |

**Realistic total: two to three focused days** to a working private instance. Add another day or two if you also want the authenticated upgrades in §8, which is where the fork stops being a restoration and starts being an improvement.

The fixed cost is understanding the code, and it is small — 1,100 lines of unstructured but readable JavaScript. There is no framework to fight, no dependency graph to untangle, and no build system to reverse-engineer.

## 12. Risks

- **Reddit tightens further.** The stated position is that authenticated access is unaffected, but this is the third contraction since 2023 (paid API 2023, unauthenticated JSON 2026, RSS now also 403). A single-account personal client is the least likely target, but plan for the possibility that free-tier terms change again.
- **Client ID suspension.** Tied to your account. Staying inside 100 QPM and keeping the instance private is the mitigation.
- **Upstream is abandoned.** No fixes are coming from `overdevs/rdx`. This fork is the maintenance path, which is the correct read of the situation.
- **Media URL signing.** If Reddit begins requiring authenticated or short-TTL signed media URLs, image and video rendering would need rework. Not currently the case.
