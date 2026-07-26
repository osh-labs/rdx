'use strict';
//
// Run with: node test/render.test.js
//
// Loads src/js/functions.js under the stub DOM and exercises the rendering
// functions against fixtures. Because functions.js runs in strict mode, any
// undeclared variable on these paths throws rather than leaking a global.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const harness = require('./harness');
const fx = require('./fixtures');

let passed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed++;
    } catch (err) {
        failures.push({ name, err });
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

function contains(haystack, needle, label) {
    assert(
        String(haystack).includes(needle),
        `${label || 'output'} missing ${JSON.stringify(needle)}`,
    );
}

harness.install();

// Load functions.js into the global context the stub set up.
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'functions.js'), 'utf8');
vm.runInThisContext(src, { filename: 'functions.js' });

// --- posts ---------------------------------------------------------------

check('text post renders title, subreddit and author', () => {
    const html = postbuilder(fx.textPost);
    contains(html, 'A post title');
    contains(html, 'r/programming');
    contains(html, 'someone');
    contains(html, '42 votes');
});

check('self text is decoded and reddit links are rewritten', () => {
    const html = postbuilder(fx.textPost);
    contains(html, 'Body with a');
    contains(html, 'subreddit.html?r=rust');
});

check('image post renders an img', () => {
    const html = postbuilder(fx.imagePost);
    contains(html, '<img src="https://i.redd.it/photo.jpg"');
});

check('link post renders an outbound link', () => {
    const html = postbuilder(fx.linkPost);
    contains(html, 'https://example.com/article');
});

check('v.redd.it post renders a dash video', () => {
    const html = postbuilder(fx.videoPost);
    contains(html, 'DASHPlaylist.mpd');
    contains(html, 'reddit_hls');
    contains(html, 'data-hls=');
});

check('gallery renders main image and both thumbnails', () => {
    const html = postbuilder(fx.galleryPost);
    contains(html, 'm1.jpg');
    contains(html, 'm1t.jpg');
    contains(html, 'm2t.jpg');
    contains(html, 'gallery_thumbs');
});

check('poll renders options, counts and total', () => {
    const html = postbuilder(fx.pollPost);
    contains(html, 'Yes');
    contains(html, 'No');
    contains(html, 'Total votes: 10');
});

check('removed post reports the removal category', () => {
    const html = postbuilder(fx.removedPost);
    contains(html, 'Removed by moderator');
});

check('nsfw post is gated behind the allow button', () => {
    const html = postbuilder(fx.nsfwPost);
    contains(html, 'sfwtoggle');
    contains(html, 'over18');
});

// --- crossposts ----------------------------------------------------------
//
// postbuilder() recurses for crossposts. The real bug here was the guard:
//
//   (x != null && x.length > 0) || (typeof x !== 'undefined' && x.length > 0)
//
// For x === null the first clause short-circuits safely, but the second
// passes the typeof test (typeof null === 'object') and dereferences null,
// throwing and killing the whole render. It survived in production only
// because Reddit omits the key rather than sending null -- the fixtures set
// it explicitly, which is what surfaced it.
//
// Note: `returnfpost` being a shared binding was NOT a bug. `a += f()`
// evaluates `a` before calling `f()`, so the parent's accumulated markup is
// captured first and restored by the assignment. It is a local now because
// strict mode requires the declaration and a shared accumulator across a
// recursive call is fragile; these tests pin the behaviour either way.

check('crosspost keeps BOTH the outer and inner post markup', () => {
    const html = postbuilder(fx.crosspostPost);
    contains(html, 'Outer crosspost title', 'crosspost output');
    contains(html, 'Inner original title', 'crosspost output');
    contains(html, 'r/outersub', 'crosspost output');
    contains(html, 'r/innersub', 'crosspost output');
});

check('crosspost renders the inner media', () => {
    const html = postbuilder(fx.crosspostPost);
    contains(html, 'inner.jpg', 'crosspost output');
});

check('crosspost does not corrupt a subsequent render', () => {
    postbuilder(fx.crosspostPost);
    const after = postbuilder(fx.textPost);
    contains(after, 'A post title', 'post rendered after a crosspost');
    assert(
        !after.includes('Inner original title'),
        'state leaked from the crosspost render into the next post',
    );
});

// --- comments ------------------------------------------------------------

check('comment renders author, score and decoded body', () => {
    const html = cbuilder(fx.comment);
    contains(html, 'commenter');
    contains(html, '5 votes');
    contains(html, 'A reply');
});

// --- helpers -------------------------------------------------------------

check('timeago produces a relative string', () => {
    const out = timeago(Date.now() - 3600 * 1000);
    assert(/^\d+[a-z]{1,2}$/.test(out), `unexpected timeago output: ${out}`);
});

check('replaceRedditLinks rewrites user and subreddit hrefs', () => {
    const out = replaceRedditLinks('<a href="/u/bob">bob</a> <a href="/r/rust">rust</a>');
    contains(out, 'user.html?u=bob');
    contains(out, 'subreddit.html?r=rust');
});

check('local subscription helpers round-trip', () => {
    harness.reset();
    addlc('subs', 'rust');
    assert(checklc('subs', 'rust'), 'expected rust to be subscribed');
    removelc('subs', 'rust');
    assert(!checklc('subs', 'rust'), 'expected rust to be removed');
});

// --- report --------------------------------------------------------------

for (const { name, err } of failures) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
