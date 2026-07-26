'use strict';
//
// Run with: node test/api.test.js
//
// Pins the endpoint migration: every path api.js builds, asserted against the
// oauth.reddit.com equivalent of the old unauthenticated .json URL. Network is
// never touched -- redditFetch is stubbed to record the path it was handed.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const harness = require('./harness');

let passed = 0;
const failures = [];

function check(name, fn) {
    try { fn(); passed++; } catch (err) { failures.push({ name, err }); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function eq(actual, expected) {
    assert(actual === expected, `\n      expected: ${expected}\n      actual:   ${actual}`);
}

harness.install();

// Record calls instead of making them.
let calls = [];
global.redditFetch = (p, opts) => {
    calls.push({ path: p, opts: opts || {} });
    return Promise.resolve(null);
};
global.currentUser = () => 'me';

vm.runInThisContext(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'api.js'), 'utf8'),
    { filename: 'api.js' },
);

function lastPath(fn) {
    calls = [];
    fn();
    assert(calls.length === 1, `expected exactly 1 call, got ${calls.length}`);
    return calls[0].path;
}

function lastCall(fn) {
    calls = [];
    fn();
    assert(calls.length === 1, `expected exactly 1 call, got ${calls.length}`);
    return calls[0];
}

// --- listings ------------------------------------------------------------

check('front page uses the authenticated feed, not a multireddit string', () => {
    eq(lastPath(() => api.frontPage({ limit: 25 })), '/hot?limit=25&raw_json=1');
});

check('front page keeps "best", which is only valid there', () => {
    eq(lastPath(() => api.frontPage({ sort: 'best', limit: 25 })), '/best?limit=25&raw_json=1');
});

check('subreddit listing drops .json and moves to the oauth host', () => {
    eq(lastPath(() => api.subreddit('rust', { sort: 'new', limit: 25 })),
        '/r/rust/new?limit=25&raw_json=1');
});

check('subreddit "best" is rewritten to hot (there is no /r/x/best)', () => {
    eq(lastPath(() => api.subreddit('rust', { sort: 'best', limit: 25 })),
        '/r/rust/hot?limit=25&raw_json=1');
});

check('an unknown sort falls back to hot rather than 404ing', () => {
    eq(lastPath(() => api.subreddit('rust', { sort: 'bogus', limit: 25 })),
        '/r/rust/hot?limit=25&raw_json=1');
});

check('time window is sent for top', () => {
    eq(lastPath(() => api.subreddit('rust', { sort: 'top', t: 'week', limit: 25 })),
        '/r/rust/top?limit=25&raw_json=1&t=week');
});

check('time window is dropped for sorts that ignore it', () => {
    eq(lastPath(() => api.subreddit('rust', { sort: 'new', t: 'week', limit: 25 })),
        '/r/rust/new?limit=25&raw_json=1');
});

check('pagination cursor is passed through', () => {
    eq(lastPath(() => api.subreddit('rust', { sort: 'hot', limit: 25, after: 't3_abc' })),
        '/r/rust/hot?limit=25&after=t3_abc&raw_json=1');
});

check('subreddit names are URL-encoded', () => {
    eq(lastPath(() => api.subreddit('a+b', { limit: 5 })), '/r/a%2Bb?limit=5&raw_json=1');
});

// --- comments ------------------------------------------------------------

check('comments use the permalink path with the trailing slash trimmed', () => {
    eq(lastPath(() => api.comments('/r/rust/comments/abc/title/', { sort: 'top' })),
        '/r/rust/comments/abc/title?limit=500&sort=top&raw_json=1');
});

check('morechildren POSTs with the ids in the body', () => {
    const call = lastCall(() => api.moreChildren('t3_abc', ['c1', 'c2']));
    eq(call.path, '/api/morechildren');
    eq(call.opts.method, 'POST');
    assert(call.opts.body.includes('link_id=t3_abc'), 'missing link_id');
    assert(call.opts.body.includes('children=c1%2Cc2'), 'missing children');
    assert(!call.opts.body.startsWith('?'), 'body must not start with ?');
});

// --- search --------------------------------------------------------------

check('global search', () => {
    eq(lastPath(() => api.search('rust lang', { limit: 25 })),
        '/search?limit=25&raw_json=1&q=rust%20lang&include_over_18=on');
});

check('subreddit-scoped search sets restrict_sr', () => {
    eq(lastPath(() => api.search('borrow', { subreddit: 'rust', limit: 25 })),
        '/r/rust/search?limit=25&raw_json=1&q=borrow&restrict_sr=on&include_over_18=on');
});

// --- users ---------------------------------------------------------------

check('user posts', () => {
    eq(lastPath(() => api.userPosts('bob', { limit: 25 })),
        '/user/bob/submitted?limit=25&raw_json=1');
});

check('user comments', () => {
    eq(lastPath(() => api.userComments('bob', { limit: 25 })),
        '/user/bob/comments?limit=25&raw_json=1');
});

// --- account -------------------------------------------------------------

check('subscribe POSTs an action of sub', () => {
    const call = lastCall(() => api.subscribe('rust', true));
    eq(call.path, '/api/subscribe');
    assert(call.opts.body.includes('action=sub'), 'expected action=sub');
    assert(call.opts.body.includes('sr_name=rust'), 'expected sr_name');
});

check('unsubscribe POSTs an action of unsub', () => {
    const call = lastCall(() => api.subscribe('rust', false));
    assert(call.opts.body.includes('action=unsub'), 'expected action=unsub');
});

check('save and unsave hit different endpoints', () => {
    eq(lastCall(() => api.save('t3_abc', true)).path, '/api/save');
    eq(lastCall(() => api.save('t3_abc', false)).path, '/api/unsave');
});

check('vote sends the direction', () => {
    const call = lastCall(() => api.vote('t3_abc', -1));
    eq(call.path, '/api/vote');
    assert(call.opts.body.includes('dir=-1'), 'expected dir=-1');
});

check('saved posts are read from the current user', () => {
    eq(lastPath(() => api.savedPosts({ limit: 25 })),
        '/user/me/saved?limit=25&raw_json=1&type=links');
});

check('autocomplete', () => {
    eq(lastPath(() => api.autocomplete('rus')),
        '/api/subreddit_autocomplete_v2?query=rus&include_profiles=false&include_over_18=true&limit=10&raw_json=1');
});

// --- report --------------------------------------------------------------

for (const { name, err } of failures) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
