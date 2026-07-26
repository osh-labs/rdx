'use strict';
//
// OAuth token lifecycle and the single entry point for every Reddit API call.
//
// Reddit shut down unauthenticated .json endpoints in May 2026, so reads now
// need a bearer token exactly like writes always did. Both halves of the flow
// are CORS-enabled (Access-Control-Allow-Origin: * with Authorization in
// Access-Control-Allow-Headers on www.reddit.com/api/v1/access_token and on
// oauth.reddit.com), so this runs entirely in the browser with no proxy.
//
// The client is registered with Reddit as an "installed app": a public client
// with NO secret. The token request sends Basic base64(client_id + ":") --
// note the trailing colon with nothing after it. That is why it is safe to
// enter the client ID in the UI: there is no secret to protect.

var OAUTH_BASE = 'https://oauth.reddit.com';
var WWW_BASE = 'https://www.reddit.com';

// `read` is the one that matters and the one upstream was missing: it
// authorises listing and comment fetches. Without it every content request
// 403s even with a valid token, because upstream only ever provisioned for
// writing back when reading was unauthenticated.
var RDX_SCOPES = [
    'read',
    'identity',
    'mysubreddits',
    'history',
    'subscribe',
    'save',
    'vote',
    'submit',
    'edit',
    'privatemessages',
].join(',');

// Refresh this many ms before the token actually expires, so a request never
// races the boundary.
var REFRESH_MARGIN_MS = 60 * 1000;

function RedditError(status, path, detail) {
    this.name = 'RedditError';
    this.status = status;
    this.path = path;
    this.message = 'Reddit returned ' + status + ' for ' + path + (detail ? ': ' + detail : '');
}
RedditError.prototype = Object.create(Error.prototype);

function RateLimitError(resetSeconds) {
    this.name = 'RateLimitError';
    this.resetSeconds = resetSeconds;
    this.message = 'Rate limited by Reddit' +
        (resetSeconds ? '; retry in ' + resetSeconds + 's' : '');
}
RateLimitError.prototype = Object.create(Error.prototype);

function NotAuthenticatedError() {
    this.name = 'NotAuthenticatedError';
    this.message = 'Not connected to Reddit';
}
NotAuthenticatedError.prototype = Object.create(Error.prototype);

// --- stored credentials --------------------------------------------------

function getClientId() {
    return localStorage.getItem('clientId');
}

function setClientId(id) {
    localStorage.setItem('clientId', id.trim());
}

function isLoggedIn() {
    return localStorage.getItem('refreshToken') !== null;
}

function currentUser() {
    return localStorage.getItem('userName');
}

function logout() {
    ['clientId', 'accessToken', 'refreshToken', 'expiresIn', 'userName',
        'subsCache', 'subsCacheAt'].forEach(function (k) {
        localStorage.removeItem(k);
    });
}

// The redirect URI is DERIVED, never hardcoded. Upstream pinned
// https://rdx.overdevs.com/login.html in two places, which meant the login
// flow could only ever work on the author's own domain. Resolving against the
// current page keeps one build working on a tailnet hostname and on
// localhost, and correctly handles being served from a subdirectory.
//
// Whatever this returns must be registered verbatim at reddit.com/prefs/apps;
// Reddit matches it exactly.
function redirectUri() {
    return new URL('login.html', window.location.href).href;
}

// --- authorisation -------------------------------------------------------

function randomState() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) {
        return b.toString(16).padStart(2, '0');
    }).join('');
}

// Upstream sent the literal string "state=random_state" and never checked it
// on return, which is no CSRF protection at all.
function beginAuth(clientId) {
    setClientId(clientId);
    var state = randomState();
    sessionStorage.setItem('oauth_state', state);
    var url = WWW_BASE + '/api/v1/authorize' +
        '?client_id=' + encodeURIComponent(clientId) +
        '&response_type=code' +
        '&state=' + encodeURIComponent(state) +
        '&redirect_uri=' + encodeURIComponent(redirectUri()) +
        '&duration=permanent' +
        '&scope=' + encodeURIComponent(RDX_SCOPES);
    window.location.href = url;
}

function tokenRequest(body) {
    var clientId = getClientId();
    if (!clientId) { return Promise.reject(new NotAuthenticatedError()); }
    return fetch(WWW_BASE + '/api/v1/access_token', {
        method: 'POST',
        headers: {
            // Installed app: public client, empty password after the colon.
            'Authorization': 'Basic ' + btoa(clientId + ':'),
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body,
    }).then(function (res) {
        if (!res.ok) {
            throw new RedditError(res.status, '/api/v1/access_token');
        }
        return res.json();
    }).then(function (data) {
        if (data.error) {
            throw new RedditError(400, '/api/v1/access_token', String(data.error));
        }
        storeToken(data);
        return data.access_token;
    });
}

function storeToken(data) {
    localStorage.setItem('accessToken', data.access_token);
    // A refresh_token only comes back on the initial authorization_code
    // exchange; refresh responses may omit it, so never clobber it with
    // undefined.
    if (data.refresh_token) {
        localStorage.setItem('refreshToken', data.refresh_token);
    }
    localStorage.setItem('expiresIn', String(Date.now() + (data.expires_in * 1000)));
}

function completeAuth(code, state) {
    var expected = sessionStorage.getItem('oauth_state');
    if (!expected || state !== expected) {
        return Promise.reject(new Error('OAuth state mismatch; aborting'));
    }
    sessionStorage.removeItem('oauth_state');
    return tokenRequest(
        'grant_type=authorization_code' +
        '&code=' + encodeURIComponent(code) +
        '&redirect_uri=' + encodeURIComponent(redirectUri())
    ).then(function (token) {
        return fetchIdentity(token);
    });
}

function fetchIdentity(token) {
    return fetch(OAUTH_BASE + '/api/v1/me', {
        headers: { 'Authorization': 'bearer ' + token },
    }).then(function (res) { return res.json(); })
      .then(function (me) {
          if (me && me.name) { localStorage.setItem('userName', me.name); }
          return me;
      });
}

// --- token access --------------------------------------------------------

// Single in-flight refresh. Without this, infinite scroll firing several
// requests just as the token expires would start N parallel refreshes that
// race each other, and Reddit may invalidate a refresh token that is
// redeemed concurrently.
var refreshInFlight = null;

function forceRefresh() {
    if (refreshInFlight) { return refreshInFlight; }
    var refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) { return Promise.reject(new NotAuthenticatedError()); }

    refreshInFlight = tokenRequest(
        'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refreshToken)
    ).then(function (token) {
        refreshInFlight = null;
        return token;
    }, function (err) {
        refreshInFlight = null;
        throw err;
    });
    return refreshInFlight;
}

function getValidToken() {
    if (!isLoggedIn()) { return Promise.reject(new NotAuthenticatedError()); }
    var token = localStorage.getItem('accessToken');
    var expiresAt = parseInt(localStorage.getItem('expiresIn'), 10);
    if (token && expiresAt && Date.now() < expiresAt - REFRESH_MARGIN_MS) {
        return Promise.resolve(token);
    }
    return forceRefresh();
}

// --- the one call every request goes through -----------------------------

// Remaining requests in the current rate-limit window, or null before the
// first call. Reddit exposes these headers to JS via
// Access-Control-Expose-Headers, so the real budget is readable.
var lastRateLimitRemaining = null;

function redditFetch(path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET';
    var body = opts.body;
    var retry = opts.retry !== false;

    return getValidToken().then(function (token) {
        var headers = { 'Authorization': 'bearer ' + token };
        if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
        return fetch(OAUTH_BASE + path, { method: method, headers: headers, body: body });
    }).then(function (res) {
        var remaining = res.headers.get('X-Ratelimit-Remaining');
        if (remaining !== null) { lastRateLimitRemaining = parseFloat(remaining); }
        // 401 despite a token we believed was live: it was revoked or the
        // clock drifted. Refresh once and retry, then give up.
        if (res.status === 401 && retry) {
            return forceRefresh().then(function () {
                return redditFetch(path, { method: method, body: body, retry: false });
            });
        }
        if (res.status === 429) {
            throw new RateLimitError(res.headers.get('X-Ratelimit-Reset'));
        }
        if (!res.ok) {
            throw new RedditError(res.status, path);
        }
        // Some write endpoints answer 204 or an empty body.
        return res.text().then(function (text) {
            return text ? JSON.parse(text) : null;
        });
    });
}

function rateLimitRemaining() {
    return lastRateLimitRemaining;
}
