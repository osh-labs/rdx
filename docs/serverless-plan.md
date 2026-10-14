# RDX on AWS: Serverless Implementation Plan

**Date:** 2026-10-14
**Goal:** Run the fork end to end on AWS using the architecture of `osh-labs/SEM-Configurator`: CloudFront in front of a private S3 site bucket and a Lambda container behind `/api/*`, a CloudFront Function login gate, a retained S3 state bucket, and GitHub Actions deploying via OIDC.

**Decisions locked in (2026-10-14):**

| Decision | Choice |
|---|---|
| Backend role | **Token broker.** Lambda holds the Reddit refresh token and hands browsers 1-hour access tokens. Content still loads browser to `oauth.reddit.com` directly. |
| Login gate | **Signed session cookie**, verified by a CloudFront Function (not SEM's HTTP basic auth). |
| Address | **A personal domain** (e.g. `reader.<your-domain>`), passed as a template parameter. |
| Region | `us-east-2`, same as SEM. Certificate in `us-east-1` (CloudFront requirement). |
| Supersedes | The EC2 + Tailscale deployment in `docs/implementation-plan.md` §9 and `deploy/`. |

---

## 0. Read first: Reddit's API timeline, a go/no-go gate

This section changes what the rest of the plan is worth, so it comes before any architecture.

### 0.1 What Reddit has announced

| Date | Event | Source | Confidence |
|---|---|---|---|
| 2025-11-11 | Self-service API access closed. `reddit.com/prefs/apps` no longer issues a client ID/secret; new access needs a request to Reddit Developer Support and manual approval under the **Responsible Builder Policy**. Existing credentials kept working. | r/redditdev announcement, quoted in [reddit-mcp-server #29](https://github.com/jordanburke/reddit-mcp-server/issues/29); several secondary reports | High |
| 2026-05-28 | Unauthenticated `.json` shut down (the change that broke upstream RDX). | r/modnews; verified by probe in `docs/self-host-evaluation.md` | Verified |
| 2026-09-30 | Announcement of RSS shutdown and end of public API access. | [TechCrunch](https://techcrunch.com/2026/09/30/reddit-is-killing-rss-feeds-ending-public-api-access-because-of-ai-bots/) | High |
| **2026-10-31** | Reddit stops accepting **new** public API access requests. | [Secondary timeline](https://blog.pebblous.ai/blog/reddit-rss-public-api-shutdown/en/) only; not in TechCrunch | Medium |
| 2026-11-13 | RSS ends site-wide. | TechCrunch | High |
| **2027-01-12** | API access removed for approved apps that have **not registered** at `developers.reddit.com/app-registration`. | TechCrunch | High |
| **2027-03 (no day)** | "Public API access will also end by March 2027." | TechCrunch | High |

What is still unknown: whether a *registered* personal app keeps any Data API access after March 2027. Reddit's stated direction is moving apps onto its Developer Platform (Devvit), which runs code *inside* Reddit and is not a path for an external reader client. Plan as if access ends in March 2027 unless Reddit says otherwise.

### 0.2 What this means

1. **You need an existing Reddit OAuth app.** A new one cannot be self-created, and new requests reportedly close on 2026-10-31 with personal-use approvals described as rare. Upstream RDX's login page told users to create a *script* app with redirect `https://rdx.overdevs.com/login.html`. If you ever used RDX's reply/login feature, you probably have one.
2. **The useful life of anything built on the Data API is about five months.** That is true of this plan, the EC2 plan, and every third-party client.

### 0.3 Correction to earlier documents

`README.md`, `src/pages/login.html`, and `docs/implementation-plan.md` tell you to *create an installed app at reddit.com/prefs/apps*. That path was already closed on 2025-11-11, before those documents were written on 2026-07-26. I missed the Responsible Builder Policy when I researched the July evaluation. The instructions were wrong at the time they were written, not just outdated now.

### 0.4 Phase 0: do these now (owner: you, about 30 minutes, time-critical)

1. **Check for an existing app.** Signed in as your account, open `https://www.reddit.com/prefs/apps`. Note each app's **type** (script / web app / installed app), **client ID**, **secret**, and **redirect URI**.
2. **If one exists: register it** at `developers.reddit.com/app-registration` before **2027-01-12**. Do it this week; it costs nothing and keeps the option open.
3. **Check whether the redirect URI is still editable** (the `edit` link on the app). The token broker needs it changed to `https://<your-domain>/api/auth/callback`. If editing is blocked, see the fallback in §5.6.
4. **If no app exists:** file a request through Reddit Developer Support (`support.reddithelp.com`, Developer Support form) before **2026-10-31**, describing a single-user, non-commercial personal reader. Expect a refusal or no answer.
5. **Decide.** Proceed to Phase 1 only if you hold working credentials **and** about 3 to 4 days of build work is worth roughly five months of use. Otherwise stop here. Nothing below has been built yet, so stopping costs nothing.

---

## 1. Target architecture

```
                    ┌────────────────────────── CloudFront (reader.<domain>) ──────────────────────────┐
  iPhone / desktop  │  viewer-request: CloudFront Function "gate"                                       │
  browser ─────────►│    valid rdx_session cookie? ──no──► 302 /login.html  (API paths: 401)            │
                    │                                                                                    │
                    │  default  ──OAC──► S3 web bucket (private)   dist/ from build.sh                  │
                    │  /api/*   ──OAC──► Lambda function URL (AWS_IAM)   FastAPI + Mangum container       │
                    └──────────────────────────────────────────────────────┬───────────────────────────┘
                                                                           │
                                  S3 state bucket (private, retained) ◄────┤  auth/reddit.json (refresh token)
                                                                           │  prefs/prefs.json (optional, §6.6)
                                  www.reddit.com/api/v1/access_token ◄─────┘  refresh, ~once/hour

  browser ──Authorization: bearer <1h token>──► oauth.reddit.com   (every listing, comment, vote, save)
  browser ──────────────────────────────────►  i.redd.it, preview.redd.it, v.redd.it, i.imgur.com (media)
```

### 1.1 Mapping from SEM-Configurator

| SEM-Configurator | RDX | Same or changed |
|---|---|---|
| `infra/template.yaml` (SAM): CloudFront, OAC for S3 + Lambda, `/api/*` behavior | Same structure, one distribution | Same |
| `BasicAuth` CloudFront Function | `Gate` function: HMAC-signed cookie | **Changed** (§4.3) |
| `EngineFunction` (Python 3.14 container, FastAPI + Mangum, 2048 MB) | `ApiFunction`, same stack, 256 MB | Same pattern, smaller |
| `DesignsBucket` (Retain, versioned, SSE) | `StateBucket` (Retain, versioned, SSE, short noncurrent expiry on `auth/`) | Same, plus one lifecycle rule |
| Managed `SecurityHeadersPolicy` | Custom `ResponseHeadersPolicy` with a CSP | **Changed:** the browser calls Reddit, so `connect-src` must be spelled out |
| `infra/bootstrap.yaml` (OIDC deploy role) | Copy, RDX ids, role name outside the app prefix | Same, with one security fix (§7.4) |
| `.github/workflows/deploy.yml` | Same two jobs: test, then deploy on `main` | Same |
| `config/production.toml` | Small `config/production.toml` (session length, scopes) | Same convention |
| `x-amz-content-sha256` on every POST body | Same helper in the frontend | Same (§4.5) |
| Cloudflare DNS, grey-cloud CNAME | Your domain's DNS, DNS-only CNAME | Same |

### 1.2 Why a token broker, and what it buys

- **One Reddit connection for every device.** Today each browser runs its own OAuth flow and keeps its own refresh token. With the broker, you connect Reddit once (from any browser) and every signed-in device gets tokens.
- **The refresh token never reaches a browser.** It lives in S3, readable only by the Lambda role. Browsers hold a 1-hour access token in `sessionStorage`.
- **Content traffic does not come from AWS.** Reads go browser to `oauth.reddit.com` as now; only the token refresh comes from a Lambda IP. That matters because Reddit's block pages cite "network policy". A datacenter probe of the token endpoint (`docs/implementation-plan.md` §0) returned a normal `401 WWW-Authenticate` challenge, not a block page. Phase 2 confirms that a real refresh works from Lambda before the frontend changes.
- **The frontend change is small.** `redditFetch()` and all of `api.js` stay; only where `getValidToken()` gets its token changes.

### 1.3 Why a cookie instead of SEM's basic auth

On iPhone, a home-screen web app handles HTTP basic-auth prompts poorly and may ask on every launch. A signed `HttpOnly` cookie set once by a login page persists for the cookie's lifetime. Two iOS details shape the design:

- A home-screen app has **its own cookie jar**, separate from Safari. You sign in once inside the home-screen app itself.
- Leaving the app's origin (to `reddit.com` for OAuth) can open an in-app browser that **doesn't share the app's cookies**. The OAuth callback must therefore work without the session cookie, and is protected by a signed `state` instead (§4.3). Simpler still: connect Reddit once from a desktop browser. The token is server-side, so the phone never needs to do the OAuth step.

---

## 2. Request flows

### 2.1 Site sign-in

```
GET  /anything        (no cookie)  → gate → 302 /login.html?next=/anything
GET  /login.html                    → gate allows (open path) → S3
POST /api/login {password}          → gate allows (open path) → Lambda
     (header x-amz-content-sha256)    compare_digest(password); on failure sleep 1 s, 401
                                      on success: Set-Cookie rdx_session=<exp>.<nonce>.<mac>
                                      HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<days>
→ browser goes to `next` (relative paths only)
```

### 2.2 Connect Reddit (once, from any signed-in browser)

```
GET /account.html → "Connect Reddit"
GET /api/auth/start                → gate checks cookie → Lambda
     302 → https://www.reddit.com/api/v1/authorize?client_id=…&response_type=code
           &state=<exp>.<nonce>.<mac>&redirect_uri=https://<domain>/api/auth/callback
           &duration=permanent&scope=read,identity,mysubreddits,history,subscribe,save,vote,submit,edit,privatemessages
GET /api/auth/callback?code&state  → gate allows (open path) → Lambda verifies state MAC + expiry,
     POST access_token (grant_type=authorization_code, Basic client_id:secret),
     GET /api/v1/me, write auth/reddit.json to S3, 302 /account.html?connected=1
```

### 2.3 Reading

```
page load → getValidToken(): token in sessionStorage and >60 s left? use it
          : GET /api/token → Lambda: in-memory cached access token, else refresh via S3 refresh token
            → {access_token, expires_at, user, scopes}   Cache-Control: no-store
→ fetch https://oauth.reddit.com/... with bearer token (unchanged code path)
→ Reddit 401 → drop cached token, GET /api/token once, retry once (as today)
```

Every navigation is a full page load in this multi-page app, so the in-memory cache dies on each click. The token is cached in `sessionStorage` so `/api/token` is called about once an hour per tab, not on every page.

### 2.4 Expiry and sign-out

| Situation | Response | Frontend behavior |
|---|---|---|
| Session cookie expired or missing | gate: `401` on `/api/*`, `302 /login.html` elsewhere | `/api/token` 401 → `location = 'login.html?next=…'` |
| Signed in, Reddit not connected | `/api/token` → `409 {"error":"not_connected"}` | Connect prompt linking to `account.html` |
| Refresh token revoked at Reddit | `/api/token` → `409 {"error":"reconnect"}` | Same prompt, wording "reconnect" |
| Sign out | `POST /api/logout` clears the cookie | → `login.html` |
| Disconnect Reddit | `POST /api/auth/disconnect`: revoke at Reddit, delete `auth/reddit.json` | → `account.html` |
| Revoke every session | Rotate `SESSION_KEY` secret, re-run deploy | All cookies invalid |

---

## 3. Repository layout after the change

```
api/                         NEW  backend (mirrors SEM's engine/)
  __init__.py
  app.py                     FastAPI routes, /api/* only (+ static dist/ in local dev)
  config.py                  env + config/production.toml, validated at startup
  session.py                 cookie and OAuth-state sign/verify (HMAC-SHA256)
  reddit.py                  code exchange, refresh, revoke, /api/v1/me (stdlib urllib)
  store.py                   S3 store, or a local directory when STATE_BUCKET is unset
  lambda_handler.py          Mangum(app, lifespan="off")
  tests/                     pytest: routes, session vectors, store, Lambda event shape
config/production.toml       NEW  session days, scopes, user agent template
infra/                       NEW
  template.yaml              SAM application stack
  bootstrap.yaml             one-time OIDC deploy role
  Dockerfile                 public.ecr.aws/lambda/python:3.14, copies api/ + config/
  gate.js                    CloudFront Function source (inlined into template by test-checked copy, §4.3)
src/js/auth.js               CHANGED  token from /api/token; no client ID, no refresh token in the browser
src/js/net.js                NEW  apiFetch() with the x-amz-content-sha256 header
src/pages/login.html         CHANGED  becomes the site sign-in page (password)
src/pages/account.html       NEW  Reddit connection status, connect, disconnect, sign out
.github/workflows/deploy.yml REPLACES ci.yml: test + deploy
test/gate.test.js            NEW  runs infra/gate.js in node against shared vectors
test/vectors/session.json    NEW  cookie/state vectors shared by gate.test.js and api/tests
requirements.txt             NEW  fastapi, mangum
requirements-dev.txt         NEW  pytest, httpx, uvicorn, cfn-lint
.dockerignore                NEW
docs/deploy.md               NEW  one-time setup + day-to-day, SEM's format
deploy/                      REMOVED  nginx.conf + deploy.sh (EC2 path; in git history)
```

---

## 4. Infrastructure (`infra/template.yaml`)

### 4.1 Parameters

| Parameter | Notes |
|---|---|
| `DomainName` | e.g. `reader.<your-domain>`. No default. |
| `CertificateArn` | `AllowedPattern: arn:aws:acm:us-east-1:…` exactly as SEM. |
| `SitePassword` | `NoEcho`, 20+ printable characters, SEM's character rules (no space, quotes, backslash). |
| `SessionKey` | `NoEcho`, exactly 64 hex characters (`openssl rand -hex 32`). Used by both the gate and Lambda. |
| `SessionDays` | Default 90. Deploy reads it from `config/production.toml`. |
| `RedditClientId` | From Phase 0. Not a secret; GitHub variable. |
| `RedditClientSecret` | `NoEcho`. Empty string allowed (installed-app type has none). |
| `RedditUsername` | For the User-Agent Reddit's API rules require: `web:<DomainName>:v2 (by /u/<user>)`. |

### 4.2 Resources

| Resource | Type | Key properties |
|---|---|---|
| `ApiLogs` | `AWS::Logs::LogGroup` | `/rdx/${AWS::StackName}/api`, 90 days |
| `ApiFunction` | `AWS::Serverless::Function` | `PackageType: Image`, x86_64, 256 MB, timeout 10 s, `FunctionUrlConfig.AuthType: AWS_IAM`, env: `STATE_BUCKET`, `SITE_PASSWORD`, `SESSION_KEY`, `SESSION_DAYS`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `PUBLIC_ORIGIN`, `USER_AGENT`. Policy: `s3:GetObject/PutObject/DeleteObject` on `${StateBucket.Arn}/*`, `s3:ListBucket` on the bucket. Optional `ReservedConcurrentExecutions: 2` (§5.5). |
| `CloudFrontInvokeUrl`, `CloudFrontInvoke` | `AWS::Lambda::Permission` | Both, exactly as SEM (`lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`, scoped to the distribution ARN) |
| `StateBucket` | `AWS::S3::Bucket` | `DeletionPolicy/UpdateReplacePolicy: Retain`, public access blocked, `BucketOwnerEnforced`, SSE AES256, versioning on. Lifecycle: `auth/` noncurrent versions expire after 1 day, plus a rule that clears expired delete markers (so revoked refresh tokens don't linger as old versions). |
| `WebBucket` + `WebBucketPolicy` | | As SEM: CloudFront-only `s3:GetObject` with `AWS:SourceArn` condition |
| `S3OriginAccess`, `LambdaOriginAccess` | `AWS::CloudFront::OriginAccessControl` | As SEM, `SigningBehavior: always` (this also overwrites any viewer `Authorization` header) |
| `Gate` | `AWS::CloudFront::Function` | `cloudfront-js-2.0`, code below, `!Sub` injects `SessionKey` |
| `SiteHeaders` | `AWS::CloudFront::ResponseHeadersPolicy` | CSP (§4.4), HSTS 1 yr, nosniff, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` |
| `Distribution` | `AWS::CloudFront::Distribution` | As SEM: `DefaultRootObject index.html`, `PriceClass_100`, `http2and3`, TLS 1.2_2021; default behavior → web (CachingOptimized); `/api/*` → Lambda (CachingDisabled, `AllViewerExceptHostHeader`, all methods). `Gate` on viewer-request of **both** behaviors. `SiteHeaders` on both. |

Outputs: `SiteUrl`, `DistributionDomain`, `DistributionId`, `WebBucketName`, `StateBucketName`, `ApiFunctionName`.

### 4.3 The gate function

```js
// infra/gate.js — runtime cloudfront-js-2.0. Inlined into template.yaml with !Sub;
// avoid JS template literals, whose ${...} would collide with !Sub.
var crypto = require('crypto');
var KEY = '${SessionKey}';

// Reachable without a session: the sign-in page and what it loads, the login call,
// and the OAuth callback (protected by its own signed state; see §1.3).
var OPEN = {
  '/login.html': 1, '/styles.css': 1, '/net.js': 1, '/favicon.ico': 1, '/favicon.png': 1,
  '/512.png': 1, '/manifest.json': 1, '/api/login': 1, '/api/auth/callback': 1
};

function validSession(value) {
  var p = value.split('.');
  if (p.length !== 3) return false;
  var exp = parseInt(p[0], 10);
  if (!(exp > Date.now() / 1000)) return false;
  var mac = crypto.createHmac('sha256', KEY).update('session.' + p[0] + '.' + p[1]).digest('base64url');
  return mac === p[2];
}

function handler(event) {
  var req = event.request;
  if (OPEN[req.uri]) return req;
  var c = req.cookies && req.cookies.rdx_session;
  if (c && validSession(c.value)) return req;
  if (req.uri.indexOf('/api/') === 0) {
    return { statusCode: 401, statusDescription: 'Unauthorized',
             headers: { 'cache-control': { value: 'no-store' } } };
  }
  return { statusCode: 302, statusDescription: 'Found',
           headers: { location: { value: '/login.html?next=' + encodeURIComponent(req.uri) },
                      'cache-control': { value: 'no-store' } } };
}
```

Notes:

- **Purpose prefixes** (`session.` here, `state.` for OAuth state) stop a valid OAuth `state` from being replayed as a session cookie, since both use the same key.
- **Key in function code, not KeyValueStore.** The login-gate option I described when asking you mentioned KeyValueStore. Embedding the key with `!Sub` matches SEM, which embeds its basic-auth credentials the same way, and removes a resource and a deploy step. Rotation is a secret change plus a redeploy. Like SEM's credentials, the key is visible to anyone in the AWS account with `cloudfront:DescribeFunction`.
- **String comparison is not constant-time.** CloudFront Functions has no timing-safe compare. A timing attack against an HMAC over a CDN's network jitter is not practical, so this is acceptable.
- **`manifest.json` is open** because browsers fetch the web-app manifest without cookies by default.
- **SameSite must be `Lax`.** `Strict` would drop the cookie on the top-level redirect back from `reddit.com`, and the page after connecting would bounce to sign-in.
- **Testing.** The template copy and `infra/gate.js` must match. `test/gate.test.js` extracts the `FunctionCode` from `template.yaml`, substitutes a test key, runs it in Node's `vm` against `test/vectors/session.json` (valid, expired, tampered, wrong-purpose, open-path, API-401 and page-302 cases), and fails if the inlined code differs from `gate.js`. `api/tests` run the same vectors against `session.py`, so the Python signer and the JS verifier cannot drift apart. SEM has no test for its CloudFront Function; this closes that gap here.

### 4.4 Content Security Policy

```
default-src 'self';
connect-src 'self' https://oauth.reddit.com;
img-src 'self' data: https://*.redd.it https://*.redditmedia.com https://i.imgur.com;
media-src 'self' blob: https://*.redd.it https://i.imgur.com https://*.redgifs.com;
frame-src https://www.redgifs.com https://redgifs.com;
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

Changes from `deploy/nginx.conf`:

- **`www.reddit.com` leaves `connect-src`.** The browser no longer calls the token endpoint; Lambda does. A script injected into the page can now reach only `oauth.reddit.com` and this origin, and it can no longer obtain a refresh token at all.
- **Fixes a bug in the current nginx CSP:** it omitted `i.imgur.com` (direct images and `.gifv` → `.mp4` in `urlpreview()`) and the redgifs media hosts. Those posts would have rendered blank on the EC2 deployment.

### 4.5 The POST payload hash

CloudFront signs requests to a Lambda function URL with SigV4 and needs the SHA-256 of every POST/PUT body from the client in an `x-amz-content-sha256` header. Without it, POSTs fail. SEM's `web/app.js` already handles this (`sha256Hex()` + header). RDX adds the same thing as `src/js/net.js`:

```js
async function apiFetch(path, body) {
  var init = { credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    var text = JSON.stringify(body);
    var d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    var hex = Array.from(new Uint8Array(d)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    init.method = 'POST'; init.body = text;
    init.headers = { 'Content-Type': 'application/json', 'x-amz-content-sha256': hex };
  }
  return fetch(path, init);
}
```

This also rules out a plain HTML `<form method="post">` for sign-in: a form cannot add the header. The sign-in page posts with `apiFetch`. `GET /api/token` has no body and needs no hash.

---

## 5. Backend (`api/`)

### 5.1 Endpoints

| Method + path | Gate | Purpose | Response |
|---|---|---|---|
| `GET /api/health` | cookie | Warm-up and liveness | `{"ok":true,"version":…}` |
| `POST /api/login` | open | Check password, set session cookie | 204 + `Set-Cookie`, or 401 after a 1 s delay |
| `POST /api/logout` | cookie | Clear cookie | 204 + expired `Set-Cookie` |
| `GET /api/auth/status` | cookie | `{connected, user, scopes, connected_at}` | 200 |
| `GET /api/auth/start` | cookie | Build signed `state` (10 min), redirect to Reddit | 302 |
| `GET /api/auth/callback` | open | Verify `state`, exchange `code`, store refresh token, fetch identity | 302 `/account.html?connected=1`, or `/account.html?error=…` |
| `POST /api/auth/disconnect` | cookie | `POST /api/v1/revoke_token`, delete `auth/reddit.json` | 204 |
| `GET /api/token` | cookie | Access token for the browser | `{access_token, expires_at, user, scopes}`, `Cache-Control: no-store`; 409 `not_connected` / `reconnect` |
| `GET/PUT /api/prefs` | cookie | Optional, §6.6 | |

Lambda **re-verifies the session cookie** on every gated route (shared `session.py`). The function URL is reachable only through CloudFront by IAM, so this is defense in depth, and it also keeps local development (no CloudFront) honest.

### 5.2 `reddit.py`

- Standard library `urllib.request` only: no `httpx` or `requests` in the image.
- Every request sends `User-Agent: web:<domain>:v2.0 (by /u/<RedditUsername>)`. The browser can't set a User-Agent; the server can, and Reddit's API rules require a descriptive one.
- Token request: `Authorization: Basic base64(client_id + ":" + secret)`. An empty secret gives the installed-app form, so all three app types work.
- `refresh()` keeps the access token in a module-level cache with its expiry and refreshes when fewer than 5 minutes remain. A warm Lambda therefore serves `/api/token` without calling Reddit. If Reddit ever returns a new `refresh_token`, it is written back to S3.
- `invalid_grant` on refresh means the token was revoked → mark `auth/reddit.json` as `{"state":"reconnect"}` → `/api/token` returns 409 `reconnect`.

### 5.3 `store.py`

Same shape as SEM's `engine/designs.py`: S3 when `STATE_BUCKET` is set, otherwise a local directory (`.local-state/`, gitignored). `boto3` is imported lazily: it ships in the Lambda base image and isn't needed locally. Objects:

```json
// auth/reddit.json
{ "refresh_token": "…", "user": "you", "scopes": ["read", "…"],
  "connected_at": "2026-…Z", "client_id": "…", "state": "ok" }
```

### 5.4 `session.py`

```
cookie = f"{exp}.{nonce}.{b64url(HMAC_SHA256(key, 'session.' + exp + '.' + nonce))}"
state  = f"{exp}.{nonce}.{b64url(HMAC_SHA256(key, 'state.'   + exp + '.' + nonce))}"
```

`secrets.token_urlsafe(12)` for the nonce, `hmac.compare_digest` for checks. `next` redirect targets are accepted only when they start with `/` and not `//` (no open redirect).

### 5.5 Brute-force posture

`/api/login` is the only open endpoint that checks a secret. There is no WAF (a rate-based rule costs about $6/month, more than everything else combined). Instead:

1. A long random password: 20+ characters, enforced by the deploy check (§7.2). At 120 bits, guessing is not a real threat at any request rate.
2. A 1 s delay on every failure, and every failure logged.
3. `ReservedConcurrentExecutions: 2` on the function. This caps attempts at about 2 per second and caps cost if someone hammers the endpoint. **Caveat:** new AWS accounts sometimes have a total concurrency limit of 10, which forbids reserving any. If the deploy fails on this, remove the line.
4. Optional later: a CloudWatch metric filter on failures plus an SNS email alarm (still free tier).

### 5.6 Fallback if the app's redirect URI can't be edited

If Phase 0 step 3 finds the redirect URI locked, the authorization-code flow can't return to your domain. A **script** app can instead use `grant_type=password` (the account's own username and password), with the password stored in SSM Parameter Store as a `SecureString`. It is worse in every way: it holds the Reddit password itself, it fails with 2FA enabled, and it returns no refresh token (the Lambda re-authenticates hourly). Use it only if nothing else works. `reddit.py` isolates the grant so this is about 30 lines.

### 5.7 Local development

- `uvicorn api.app:app --reload` with `RDX_LOCAL=1`: serves `/api/*` and mounts `dist/` at `/`. A middleware applies the same `session.py` check as the gate, so local behaves like production.
- **There is no separate dev Reddit app.** You can't create one, and an app has one redirect URI, which points at production. Local OAuth therefore can't complete. `python -m api.cli import-token` copies `auth/reddit.json` from the production bucket (`aws s3 cp`) into `.local-state/`. A refresh token works from both places, because Reddit does not invalidate it on use.

---

## 6. Frontend changes

| File | Change |
|---|---|
| `src/js/auth.js` | Delete `beginAuth`, `completeAuth`, `tokenRequest`, `storeToken`, `forceRefresh`, `RDX_SCOPES`, `redirectUri`, and the client-ID helpers. `getValidToken()` reads `sessionStorage`, else `GET /api/token` (one in-flight request, as today). `redditFetch()` stays; on a Reddit 401 it clears the cached token and retries once. `isLoggedIn()` stays **synchronous**: it reads a `rdxConnected` hint in `localStorage`, refreshed from each `/api/token` and `/api/auth/status` reply. The server is the source of truth; the hint only avoids making about 20 call sites async. |
| `src/js/net.js` (new) | `apiFetch()` with the payload hash (§4.5). Loaded by `login.html` and the `scripts` partial. |
| `src/pages/login.html` | Becomes **site sign-in**: one password field, `apiFetch('/api/login', {password})`, then go to `next`. Includes nothing beyond the open paths in §4.3. |
| `src/pages/account.html` (new) | Shows Reddit status, **Connect Reddit** (→ `/api/auth/start`), **Disconnect**, **Sign out**, and a note that connecting from a desktop browser is easiest. |
| `src/js/functions.js` | `renderConnectPrompt()`, the sidebar, and `apiAction()` point at `account.html` instead of `login.html`. `logout()` callers go to `/api/logout`. |
| `src/partials/head.html` | `<link rel="apple-touch-icon" href="512.png">`; `<meta name="mobile-web-app-capable">` alongside the Apple one. |
| `src/pages/settings.html` | The account line links to `account.html`. |
| `deploy/` | Remove (EC2 path, superseded; in history). |
| `README.md`, `docs/implementation-plan.md` | Replace the "create an app" instructions (§0.3) and the EC2 section with a pointer to `docs/deploy.md`. |

### 6.6 Optional: preferences synced across devices

Theme, font, posts per page, compact mode, infinite scroll, the NSFW opt-in, and the pre-migration saved-links list live in `localStorage` per device today. `GET/PUT /api/prefs` (one JSON document, `prefs/prefs.json`, versioned by the bucket) syncs them: apply local values immediately, fetch the server copy, apply it if its `updated_at` is newer, and `PUT` on change. This is worth doing only if you'll use more than one device. It isn't required for the move.

---

## 7. CI/CD

### 7.1 `.github/workflows/deploy.yml` (replaces `ci.yml`)

```
on: push (main), pull_request, workflow_dispatch
permissions: contents: read
env: AWS_REGION: us-east-2, STACK_NAME: rdx

test:
  shellcheck build.sh
  ./build.sh
  node test/render.test.js && node test/api.test.js && node test/gate.test.js
  playwright smoke (dist/, gate not involved: static load + no offsite requests)
  pip install -r requirements-dev.txt && python -m pytest api/tests -q
  cfn-lint infra/template.yaml infra/bootstrap.yaml --regions us-east-2

deploy:  needs test; main only; concurrency deploy-production; id-token: write
  configure-aws-credentials (role-to-assume: secrets.AWS_DEPLOY_ROLE_ARN)
  setup-sam
  Check settings     (SEM's pattern: names the rule a value breaks without printing it)
  sam build --template-file infra/template.yaml
  sam deploy --resolve-s3 --resolve-image-repos --capabilities CAPABILITY_IAM
             --no-confirm-changeset --no-fail-on-empty-changeset --parameter-overrides …
  read outputs
  ./build.sh
  aws s3 sync dist/ s3://$bucket --delete --exclude "*.png" --exclude "*.ico" --exclude "dash.all.min.js"
             --cache-control "no-cache"
  aws s3 sync dist/ s3://$bucket --exclude "*" --include "*.png" --include "*.ico" --include "dash.all.min.js"
             --cache-control "public, max-age=2592000"
  cloudfront create-invalidation --paths "/*"
  summary: CloudFront domain
```

Pin third-party actions to commit SHAs rather than tags (`aws-actions/setup-sam@v2` and others). A workflow holding an AWS deploy role should not run code whose tag can be moved.

### 7.2 Secrets and variables

| Name | Kind | Value |
|---|---|---|
| `AWS_DEPLOY_ROLE_ARN` | secret | Output of the bootstrap stack |
| `CERTIFICATE_ARN` | secret | us-east-1 ACM certificate |
| `SITE_PASSWORD` | secret | 20+ printable characters; no spaces, quotes, or backslash |
| `SESSION_KEY` | secret | `openssl rand -hex 32` |
| `REDDIT_CLIENT_SECRET` | secret | From Phase 0; leave unset for an installed app |
| `DOMAIN_NAME` | variable | `reader.<your-domain>` |
| `REDDIT_CLIENT_ID` | variable | From Phase 0 |
| `REDDIT_USERNAME` | variable | Your username, for the User-Agent |

As in SEM, short values are **variables**, because GitHub masks every occurrence of a secret's value in logs.

### 7.3 `infra/bootstrap.yaml`

Copy SEM's, then change: `GitHubRepo: rdx`, `GitHubRepoId:` (look up with `gh api repos/osh-labs/rdx --jq .id`), `GitHubOwnerId: 68129277` (osh-labs, already SEM's default), `AppStackName: rdx`. Set `CreateGitHubProvider: no` if this is the same AWS account as SEM: the OIDC provider already exists, and a second one fails.

### 7.4 One fix to carry over, and a finding in SEM

In SEM's bootstrap, the deploy role is named `${AppStackName}-github-deploy` (`sem-patches-github-deploy`), and its `AppRoles` statement grants `iam:PutRolePolicy` and `iam:AttachRolePolicy` on `role/${AppStackName}-*`. That pattern matches **the deploy role itself**, so the role can attach `AdministratorAccess` to itself. Likewise, `cloudformation:*` on `stack/${AppStackName}*` matches the bootstrap stack. Anyone who can get code onto SEM's `main`, including through a compromised or re-tagged third-party action, can escalate to account admin.

For RDX: name the role `github-deploy-rdx` and the bootstrap stack `bootstrap-rdx`, so neither matches the `rdx-*` / `rdx*` patterns. SEM should get the same fix. That is outside this repository, so it's noted here rather than changed.

---

## 8. One-time setup (operator runbook)

This becomes `docs/deploy.md`, in SEM's step-by-step format. In order:

1. **Phase 0 done:** client ID, secret (if any), redirect URI editable or fallback chosen.
2. **Certificate (us-east-1):** ACM → request a public cert for `reader.<your-domain>`, DNS validation, add the CNAME at your DNS host (DNS-only if Cloudflare), wait for *Issued*, copy the ARN.
3. **Bootstrap (us-east-2):** CloudFormation → upload `infra/bootstrap.yaml`, stack name `bootstrap-rdx`, `CreateGitHubProvider: no` if SEM shares the account. Copy `DeployRoleArn`.
4. **GitHub:** add the secrets and variables in §7.2.
5. **Reddit app:** set its redirect URI to `https://reader.<your-domain>/api/auth/callback`.
6. **First deploy:** merge to `main`. Expect 10 to 20 minutes, mostly CloudFront.
7. **DNS:** CNAME `reader` → the CloudFront domain from the run summary, DNS-only.
8. **Sign in** at `https://reader.<your-domain>`, open **Account**, **Connect Reddit**.
9. **iPhone:** open the site in Safari → Share → **Add to Home Screen** → launch it → sign in once inside the app.

---

## 9. Testing

| Layer | What | How |
|---|---|---|
| Rendering | Existing 16 fixtures | `node test/render.test.js` (unchanged) |
| Endpoints | Existing 21 path checks | `node test/api.test.js` (unchanged) |
| Gate | Valid, expired, tampered, wrong-purpose, open paths, 401 vs 302, template copy matches `gate.js` | `node test/gate.test.js` (new) |
| Session crypto parity | The same vectors pass in Python and JS | `test/vectors/session.json` used by both |
| API routes | login (good/bad/delay), logout, status, start (state shape), callback (bad state, Reddit error, success writes store), token (cached, refresh, `invalid_grant` → 409), disconnect | pytest with `TestClient`; Reddit calls patched; local store |
| Lambda adapter | Payload-2.0 events through Mangum, including `Set-Cookie` delivered in the `cookies` field | Copy of SEM's `test_lambda.py` pattern |
| Template | Lint | `cfn-lint` |
| Browser | All pages load, no console errors, no offsite requests | Existing `test/smoke.test.js` against `dist/` |
| Live (manual, after deploy) | Sign-in, connect, read, vote/save/comment, token refresh after an hour, iPhone home-screen relaunch ×3, sign-out, session expiry | The checklist from `docs/implementation-plan.md` §11 plus these |

---

## 10. Phases

| # | Phase | Contents | Verifies | Effort |
|---|---|---|---|---|
| 0 | **Credential gate** (you) | §0.4 | You have credentials and want to proceed | 30 min |
| 1 | Hosting + sign-in | bootstrap, template (buckets, distribution, gate, headers), `api/` with `health` + `login` + `logout` only, `net.js`, sign-in page, workflow, `docs/deploy.md` | **The riskiest UX assumption:** iPhone home-screen sign-in that stays signed in across relaunches. The current site works behind it, still using per-device OAuth. | 1 day |
| 2 | Token broker | `reddit.py`, `store.py`, `auth/*` and `token` routes, tests | **The riskiest platform assumption:** a real refresh from a Lambda IP succeeds. Checked with `curl` against `/api/token` before any frontend change. | 1 day |
| 3 | Frontend cutover | `auth.js`, `account.html`, link rewrites, CSP via the headers policy, remove `deploy/`, fix docs (§0.3) | End to end on desktop and iPhone | 1 day |
| 4 | Hardening | Reserved concurrency, action pinning, failure alarm, CSP media hosts checked on real posts | | ½ day |
| 5 | Optional | Prefs sync (§6.6) | | ½ day |

**Minimum viable cut: phases 0 to 3, about 3 days.** Given §0's horizon, I'd stop there. Phases 1 and 2 each end on a check that could stop the project before the next phase's effort is spent.

---

## 11. Cost

| Item | Monthly |
|---|---|
| CloudFront requests, transfer, and function invocations | $0 (free tier: 1 TB, 10M requests, 2M function invocations) |
| Lambda | $0 (about a few hundred invocations) |
| S3 (web + state, a few MB) | < $0.05 |
| ECR image (about 150 MB) | ≈ $0.02 |
| CloudWatch Logs | ≈ $0 |
| **Total** | **Well under $1**, plus your domain. No Route 53 (DNS stays at your provider). |

---

## 12. Risks

| Risk | Likelihood | Effect | Mitigation |
|---|---|---|---|
| Reddit ends Data API access (by March 2027) | **Announced** | Project stops working | §0. Phase gates limit sunk cost. |
| No usable credentials | High if no pre-2025 app exists | Can't start | §0.4 |
| Redirect URI not editable | Unknown | Code flow impossible | §5.6 fallback (script apps only) |
| Unregistered app cut off 2027-01-12 | Certain if not registered | Early end | Register in Phase 0 |
| Token refresh blocked from AWS IPs | Low (datacenter probe got a normal auth challenge) | Broker can't mint tokens | Checked in Phase 2 before the frontend changes. Fallback: static-only option (per-device tokens, no Lambda). |
| iOS home-screen cookie behavior | Low | Re-sign-in more often than the cookie lifetime | Checked in Phase 1. Connect Reddit from desktop. |
| Password guessing | Very low with a 20+ char password | Account access | §5.5 |
| Session key leak (account admins can read it) | Low; same trust boundary as SEM | Forged sessions | Rotate `SESSION_KEY`, redeploy |
| Third-party action compromise in the deploy job | Low | AWS deploy-role access | Pin to SHAs (§7.1); deploy role name outside the `rdx-*` pattern (§7.4) |

---

## 13. Open questions for you

1. **Phase 0 result:** do you have a pre-November-2025 Reddit app, and of which type? Everything depends on this.
2. **Domain:** the exact hostname, and who hosts its DNS.
3. **AWS account:** the same one as SEM? This decides `CreateGitHubProvider`.
4. **Go/no-go:** given about five months of expected use, proceed with phases 1 to 3?

---

Sources: [Introducing the Responsible Builder Policy (quoted in reddit-mcp-server #29)](https://github.com/jordanburke/reddit-mcp-server/issues/29) · [TechCrunch, 2026-09-30](https://techcrunch.com/2026/09/30/reddit-is-killing-rss-feeds-ending-public-api-access-because-of-ai-bots/) · [Slashdot summary of TechCrunch](https://tech.slashdot.org/story/26/09/30/1841213/reddit-is-killing-rss-feeds-ending-public-api-access) · [Pebblous timeline (secondary; source of the 2026-10-31 date)](https://blog.pebblous.ai/blog/reddit-rss-public-api-shutdown/en/) · [Creuto, registration deadline summary (secondary)](https://creuto.com/reddit-data-api-registration-developer-platform-2026) · [AWS: CloudFront Functions JavaScript runtime 2.0](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-javascript-runtime-20.html)
