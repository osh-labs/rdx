# Devvit as a Replacement Path: Evaluation

**Date:** 2026-10-14
**Context:** The Data API route is closed to this project: a new OAuth app could not be obtained (§0 of `serverless-plan.md`), and Reddit has announced that public API access ends by March 2027. This document evaluates Reddit's Developer Platform (Devvit) as the alternative.

**Sources:** the Devvit documentation source (`github.com/reddit/devvit-docs`, docs version 0.14) and the `@devvit/web` / `@devvit/reddit` SDK reference, both at 0.14.8, published 2026-10-14. `developers.reddit.com` itself could not be fetched from the build environment, so everything below cites the docs source.

**Verdict:** Devvit can host a **limited, private, ad-free reading view inside the official Reddit app**, for free and with no API credentials. It **cannot** recreate RDX as a standalone client: it has no access to your front page, subscriptions, votes, saves or inbox, can display only Reddit-hosted media, and runs only inside a post in a subreddit. Before planning anything, run a ~2 hour spike (§5) to settle three facts the docs leave open.

---

## 1. What Devvit is

- Apps run **on Reddit's infrastructure**, hosted for free. A Devvit Web app is a client (HTML/CSS/JS in a webview) plus a Node server whose routes must live under `/api/*`, with Redis storage and a Reddit client.
- The UI appears **inside a post** in a subreddit where the app is installed. *Inline* mode renders in the feed card; *expanded* mode is a modal on web and **full screen on mobile** (`view_modes_entry_points.md`).
- There are **no API keys**. "Unlike traditional Reddit API usage, you don't need to create an app at reddit.com/prefs/apps or manage API keys" (`reddit-api.mdx`).
- **Private use needs no review.** "You can use Devvit and test your app without needing to submit it to Reddit's App Review" (`devvit_rules.md`). `devvit upload` creates a **private** playtest subreddit (under 200 subscribers) with you as moderator and the app pre-installed. An installed version stays installed after a playtest ends (`playtest.md`). Review is needed only to list the app publicly or to unlock premium features such as HTTP fetch.

## 2. Capability matrix for a reader

| RDX feature | Devvit | Evidence |
|---|---|---|
| Browse a subreddit (hot/new/top/rising/controversial) | **Yes**, the API takes any `subredditName`. **Unverified whether subreddits other than the installed one work.** | `RedditClient.getHotPosts({subredditName})` etc. |
| Comments, including expanding threads | Yes | `getComments({postId})` |
| Search | Yes, **scoped to a subreddit** | `searchPosts({query, subredditName})` |
| User pages (posts/comments) | Yes, public data | `getPostsByUser`, `getCommentsByUser` |
| **Your front page** | **No.** `getBestPosts()` runs as the *app account*. "To get the front page for a user, please contact Reddit." | `RedditClient.md` |
| **Your subscriptions** | **No.** `getSubscribedSubredditsForCurrentUser()` runs as the app account; private data list includes "Subscribed subreddits." | `reddit-api.mdx` §Private user data |
| **Voting** | **No, prohibited.** "Apps cannot upvote or downvote posts or comments, either as the app account or on behalf of the logged-in user." | `userActions.mdx` |
| **Reddit saves** | **No**, private data | `reddit-api.mdx` |
| **Inbox** | **No.** `getMessages()` reads the authenticated account, which for app code is the app account. | `RedditClient.md` |
| Comment / post as yourself | **Yes for you**, even unapproved: "User actions taken by the app owner will be attributed to the app owner's username." | `userActions.mdx` §playtesting |
| Subscribe | Only to *the subreddit the app is installed in* | `subscribeToCurrentSubreddit()` |
| Reddit-hosted images (`i.redd.it`) | Yes: "Apps can only display media hosted on Reddit." | `media-uploads.mdx` |
| `preview.redd.it`, galleries, `v.redd.it` video | **Unverified.** The `Post` model exposes `gallery` and `secureMedia` (Reddit video metadata), but webview playback isn't documented. | `models/classes/Post.md` |
| Imgur, redgifs, other external media | **No.** The client "can't have any external requests other than the app's webview domain." | `devvit_web_overview.mdx` |
| Your own domain, a standalone home-screen app | **No.** It lives in a post; you open it through Reddit's app or website. | Architecture |
| Themes, compact mode, infinite scroll, your own layout | Yes, the UI is yours | |
| Persisted settings / local subscription list / local saves | Yes, in Redis (5 GB per installation). **Not** `localStorage`, which "clears on app updates." | `redis.mdx`, `devvit_web_overview.mdx` |
| Hosting cost | Free | `quickstart-mod-tool.md` |
| Survives the March 2027 Data API end | **Yes.** This is the platform Reddit is moving apps to. | `guides/migrate/public-api.md` |

**Platform limits:** 30 s per request, 4 MB payload, 10 MB response, no streaming or websockets, no outbound fetch from the client, and server-side fetch only to allowlisted domains (personal domains "will not be approved").

## 3. What it would be in practice

A private subreddit (say `r/<you>_reader`) containing one pinned post. Opening that post in the Reddit app and tapping it switches to full-screen expanded mode, which shows your reader:

- **A subreddit list you curate**, stored in Redis. This replaces your real subscriptions, the way upstream RDX's local list did; upstream never used your account's subscriptions either.
- **A "home" view** that merges hot posts across that list.
- Subreddit, comment, search and user views, with RDX's themes and compact mode.
- **Local "saved" items** in Redis, like upstream RDX's `localStorage` saves.
- Commenting as yourself.

No voting, no Reddit saves, no inbox, and posts whose media is hosted off Reddit (imgur, redgifs) show as links only.

In short: **a themed, ad-free reading surface inside the official app, not a replacement for the official app.** There is no ad inside the full-screen view, but you still go through the official app's shell to reach it.

## 4. How much of RDX carries over

| Part | Carries over? |
|---|---|
| `postbuilder` / `cbuilder` / `urlpreview` / `pollbuilder` rendering, `styles.css`, themes | Mostly. Devvit returns typed `Post`/`Comment` objects (`title`, `url`, `permalink`, `score`, `numberOfComments`, `thumbnail`, `bodyHtml`, `gallery`, `secureMedia`, `pollData`, `nsfw`, …), not raw Listing JSON. A server-side adapter that maps them to the shape `postbuilder` expects lets the renderer stay largely as-is. |
| `api.js`, `auth.js`, OAuth, the AWS plan, `build.sh`, the multi-page structure | No. Devvit handles auth; the server becomes Hono routes under `/api/*`; the client becomes a single-page app (one entrypoint) built with Vite. |
| Tests | The render fixtures carry over; Devvit adds `devvit test` / a UI simulator. |

Language: TypeScript/JavaScript only, and the backend is Node (Hono or Express), not Python.

## 5. Spike before any plan (about 2 hours)

The docs leave three facts open that each decide the outcome. Settle them first:

1. `npm create devvit@latest` (React template) → `devvit upload` → `devvit playtest`. This creates the private test subreddit.
2. Add one server route that returns `reddit.getHotPosts({ subredditName: 'programming', limit: 10 })` and `getComments` for the first post. Render titles, the first image, and one `v.redd.it` video in the client.
3. Open the post on your iPhone in the Reddit app and tap into expanded mode.

| # | Check | If it fails |
|---|---|---|
| 1 | A subreddit **other than the installed one** returns posts | Stop. The reader would be confined to one subreddit. |
| 2 | `i.redd.it` and `preview.redd.it` images render in the webview | Stop, or accept text-only. |
| 3 | `v.redd.it` video plays (from the `secureMedia` URLs) | Accept: videos show as links. |
| 4 | Expanded mode on iPhone is usable full screen, including scrolling and back navigation | Judge it yourself. |
| 5 | NSFW posts appear (content is fetched as the app account) | Note it; it may not matter to you. |

If checks 1 and 2 pass, the build is a few days: a server adapter plus porting the renderer, a curated subreddit list in Redis, home/subreddit/comments/search/user views, and settings. I'd write that plan after the spike, not before.

## 6. The other route, for comparison (not evaluated in depth)

Reddit's May 2026 announcement said "logged-in and authenticated access won't be impacted." A **Safari extension or userscript running on `reddit.com` itself** could use your logged-in session and get what Devvit can't: your real front page, subscriptions, votes, saves and inbox, rendered in RDX's style. This is the model of Reddit Enhancement Suite.

The trade-offs:

- It depends on Reddit's undocumented web endpoints, which can change without notice.
- It runs in Safari, not in the Reddit app.
- It is a grey area under Reddit's terms rather than a supported platform.

I have not verified that logged-in `.json` still works; that needs a signed-in browser. It is the only route that keeps the full feature set, so it is worth a 15-minute check if Devvit's limits are a deal-breaker.
