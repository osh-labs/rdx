# rdx — self-hosted Reddit reader

A fork of [overdevs/rdx](https://github.com/avadhesh18/rdx), rebuilt to run as a
private single-user instance against Reddit's authenticated API.

Upstream is abandoned. In May 2026 Reddit
[shut down unauthenticated `.json` endpoints](https://www.reddit.com/r/modnews/comments/1tq9vxo/protecting_communities_from_scrapers_and_platform/),
which is what the original depended on entirely, and it has not worked since.
This fork reads Reddit through your own account instead.

## What it is

A static site. No backend, no database, no build toolchain, no dependencies.
`build.sh` (bash + coreutils) assembles `src/` into `dist/`; nginx serves it;
**your browser talks to Reddit directly.** The server never contacts Reddit and
holds no credentials.

That last point matters for hosting: because the API calls originate in your
browser, the instance's own IP address is never seen by Reddit, so datacenter-IP
reputation is not a factor.

## Requirements

- A Reddit account.
- Somewhere to serve static files. A `t4g.nano` is ample.
- HTTPS. Reddit requires an `https://` OAuth redirect URI (only `localhost` is
  exempt), and holding a refresh token over plain HTTP is indefensible.

## Setup

```bash
git clone <this repo> && cd rdx
./build.sh                       # -> dist/
python3 -m http.server -d dist   # or deploy properly, see below
```

Then open the site, go to **Connect Reddit account**, and follow the four steps
it shows. In short:

1. At [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps), create an app
   of type **installed app**.
2. Set the redirect URI to exactly the value the login page displays.
3. Copy the client ID — the string under the app name, *not* the secret.
4. Paste it in and authorise.

An installed app is a public OAuth client, so there is no secret to enter or
store anywhere. The client ID and tokens stay in your browser's `localStorage`.

### Deploying privately

The recommended shape is nginx bound to loopback, published over Tailscale:

```bash
sudo mkdir -p /var/www/rdx && sudo chown "$USER" /var/www/rdx
sudo cp deploy/nginx.conf /etc/nginx/conf.d/rdx.conf
sudo nginx -t && sudo systemctl reload nginx
./deploy/deploy.sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080
```

Tailscale terminates TLS with a real Let's Encrypt certificate for the
`*.ts.net` name, so there is no certbot, no DNS, and no public listener. The
security group needs no inbound rule at all.

**Keep it private.** Reddit's free API tier is 100 queries/minute per client ID
and is for non-commercial personal use. One person browsing is nowhere near
that. Serving other people's browsing through your client ID is what turns a
personal tool into a service.

## What changed from upstream

**Transport.** Every JSONP and XHR call site now goes through the authenticated
API at `oauth.reddit.com`. JSONP was doubly dead — the endpoints return 403, and
a `<script src>` tag cannot carry an `Authorization` header.

**Authentication.** Installed-app flow with no client secret, a derived redirect
URI, a real CSRF state nonce, serialised token refresh, and the `read` scope
that upstream never requested (without it, every content request 403s).

**Features that authentication makes real**, replacing local-only stand-ins:

| Upstream | Here |
|---|---|
| Subscriptions in `localStorage`, imported by pasting a bookmarklet into old.reddit.com | Your actual Reddit subscriptions, synced, with working sub/unsub |
| Home feed built as `r/sub1+sub2+sub3` (breaks past URL length limits) | Your real front page |
| Saved posts in `localStorage`, invisible to Reddit | Real Reddit saves |
| `vote` scope requested but no vote UI | Upvote/downvote on posts and comments |

**Privacy.** All analytics removed — see [`docs/analytics-removal.md`](docs/analytics-removal.md).
dash.js is vendored and lazy-loaded; the Google Fonts picker is replaced with
system font stacks. A page load reaches exactly two origins: yours and Reddit's.
The shipped nginx config sets a CSP whose `connect-src` is restricted to Reddit,
so injected script cannot exfiltrate your token.

**Build.** `run.php` is gone. It only built 5 of the 15 pages; the rest were
hand-maintained copies in `public/`, which is where the duplication came from.
All pages are now sources under `src/pages/`.

**Bugs.** Several latent ones fixed — see the Phase 3 commit and
[`docs/implementation-plan.md`](docs/implementation-plan.md).

## Layout

```
build.sh            bash build: src/ -> dist/
src/pages/          all 11 pages
src/partials/       shared head, chrome, footer, reply modal
src/js/auth.js      OAuth token lifecycle + redditFetch()
src/js/api.js       endpoint construction
src/js/functions.js rendering and UI
src/vendor/         dash.js (vendored, lazy-loaded)
assets/             icons and manifest
deploy/             nginx config and deploy script
test/               node tests, no framework
docs/               evaluation, implementation plan, analytics audit
```

## Tests

```bash
node test/render.test.js   # rendering, against fixtures
node test/api.test.js      # every constructed endpoint URL
node test/smoke.test.js    # loads all 11 pages in headless Chromium
```

The smoke test fails on any uncaught exception, console error, or request to an
offsite host. It needs playwright (`npm install --no-save playwright`) and skips
cleanly if absent.

There is deliberately no `package.json`; the tests are plain Node.

## Status

Code-complete and verified as far as it can be without credentials. Everything
that requires a live Reddit token — the OAuth round trip, real listings, media
rendering, writes — needs a manual pass. The checklist is in
[`docs/implementation-plan.md`](docs/implementation-plan.md) §11.

*Not affiliated with Reddit Inc.*
