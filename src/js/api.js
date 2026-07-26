'use strict';
//
// Reddit endpoint construction. Every URL the app requests is built here, so
// no page string-builds one anymore.
//
// The migration rule from the old unauthenticated endpoints is mechanical:
// drop the ".json" suffix and point at oauth.reddit.com. Query parameters
// (limit, after, before, t, sort, restrict_sr, include_over_18) carry over
// unchanged, and the response schema is identical -- which is why postbuilder
// and cbuilder needed no changes.
//
//   old: https://www.reddit.com/r/rust/hot.json?limit=25&after=t3_x
//   new: https://oauth.reddit.com/r/rust/hot?limit=25&after=t3_x

// `best` is only a real sort on the front page. Upstream offered it in the
// subreddit and user sort menus too, producing /r/x/best, which the old
// endpoint quietly redirected to hot and the OAuth API 404s.
var SUBREDDIT_SORTS = ['hot', 'new', 'top', 'rising', 'controversial'];

function normaliseSort(sort, isFrontPage) {
    if (!sort) { return ''; }
    if (sort === 'best') { return isFrontPage ? 'best' : 'hot'; }
    return SUBREDDIT_SORTS.indexOf(sort) === -1 ? 'hot' : sort;
}

// `t` (time window) is only meaningful for top and controversial. Upstream
// appended it unconditionally.
function sortTakesTimeWindow(sort) {
    return sort === 'top' || sort === 'controversial';
}

function buildQuery(params) {
    var parts = [];
    Object.keys(params).forEach(function (k) {
        var v = params[k];
        if (v === null || v === undefined || v === '') { return; }
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? '?' + parts.join('&') : '';
}

function pageLimit() {
    return parseInt(localStorage.getItem('ppg'), 10) || 20;
}

// Common listing options: {sort, t, after, before, limit}
function listingQuery(opts, extra) {
    opts = opts || {};
    var params = {
        limit: opts.limit || pageLimit(),
        after: opts.after,
        before: opts.before,
        raw_json: 1,
    };
    if (sortTakesTimeWindow(opts.sort)) { params.t = opts.t; }
    if (extra) {
        Object.keys(extra).forEach(function (k) { params[k] = extra[k]; });
    }
    return buildQuery(params);
}

var api = {
    // Authenticated front page: your actual subscriptions, server-side.
    // Replaces upstream's r/sub1+sub2+sub3 string, which broke once you had
    // enough subscriptions to exceed URL length limits.
    frontPage: function (opts) {
        opts = opts || {};
        var sort = normaliseSort(opts.sort, true) || 'hot';
        return redditFetch('/' + sort + listingQuery(opts));
    },

    subreddit: function (name, opts) {
        opts = opts || {};
        var sort = normaliseSort(opts.sort, false);
        var path = '/r/' + encodeURIComponent(name) + (sort ? '/' + sort : '');
        return redditFetch(path + listingQuery(opts));
    },

    userPosts: function (username, opts) {
        opts = opts || {};
        return redditFetch('/user/' + encodeURIComponent(username) + '/submitted' +
            listingQuery(opts, { sort: opts.sort }));
    },

    userComments: function (username, opts) {
        opts = opts || {};
        return redditFetch('/user/' + encodeURIComponent(username) + '/comments' +
            listingQuery(opts, { sort: opts.sort }));
    },

    // permalink is the /r/sub/comments/id/slug/ path from a post.
    comments: function (permalink, opts) {
        opts = opts || {};
        var path = permalink.replace(/\/$/, '');
        return redditFetch(path + buildQuery({
            limit: opts.limit || 500,
            sort: opts.sort,
            comment: opts.comment,
            context: opts.context,
            raw_json: 1,
        }));
    },

    moreChildren: function (linkId, childIds) {
        return redditFetch('/api/morechildren', {
            method: 'POST',
            body: buildQuery({
                api_type: 'json',
                link_id: linkId,
                children: childIds.join(','),
                limit_children: false,
                raw_json: 1,
            }).slice(1),
        });
    },

    search: function (query, opts) {
        opts = opts || {};
        var path = opts.subreddit ? '/r/' + encodeURIComponent(opts.subreddit) + '/search' : '/search';
        return redditFetch(path + listingQuery(opts, {
            q: query,
            sort: opts.sort,
            t: opts.t,
            restrict_sr: opts.subreddit ? 'on' : null,
            include_over_18: 'on',
        }));
    },

    autocomplete: function (query) {
        return redditFetch('/api/subreddit_autocomplete_v2' + buildQuery({
            query: query,
            include_profiles: false,
            include_over_18: true,
            limit: 10,
            raw_json: 1,
        }));
    },

    // --- account ---------------------------------------------------------

    me: function () {
        return redditFetch('/api/v1/me');
    },

    // Your real subscription list, paginated. Replaces the localStorage list
    // populated by a bookmarklet pasted into old.reddit.com.
    mySubreddits: function () {
        var names = [];
        function page(after) {
            return redditFetch('/subreddits/mine/subscriber' +
                buildQuery({ limit: 100, after: after, raw_json: 1 })
            ).then(function (res) {
                var children = (res && res.data && res.data.children) || [];
                children.forEach(function (c) { names.push(c.data.display_name); });
                if (res.data.after) { return page(res.data.after); }
                return names;
            });
        }
        return page(null);
    },

    subscribe: function (name, subscribed) {
        return redditFetch('/api/subscribe', {
            method: 'POST',
            body: buildQuery({
                action: subscribed ? 'sub' : 'unsub',
                sr_name: name,
                api_type: 'json',
            }).slice(1),
        });
    },

    savedPosts: function (opts) {
        var user = currentUser();
        return redditFetch('/user/' + encodeURIComponent(user) + '/saved' +
            listingQuery(opts, { type: 'links' }));
    },

    save: function (fullname, saved) {
        return redditFetch(saved ? '/api/save' : '/api/unsave', {
            method: 'POST',
            body: buildQuery({ id: fullname }).slice(1),
        });
    },

    // dir: 1 upvote, 0 clear, -1 downvote
    vote: function (fullname, dir) {
        return redditFetch('/api/vote', {
            method: 'POST',
            body: buildQuery({ id: fullname, dir: dir, rank: 1 }).slice(1),
        });
    },

    inbox: function () {
        return redditFetch('/message/inbox' + buildQuery({ limit: 50, raw_json: 1 }));
    },

    unreadCount: function () {
        return redditFetch('/message/unread' + buildQuery({ limit: 100, raw_json: 1 }))
            .then(function (res) {
                return ((res && res.data && res.data.children) || []).length;
            });
    },

    comment: function (parentFullname, text) {
        return redditFetch('/api/comment', {
            method: 'POST',
            body: buildQuery({ api_type: 'json', thing_id: parentFullname, text: text }).slice(1),
        });
    },

    editComment: function (fullname, text) {
        return redditFetch('/api/editusertext', {
            method: 'POST',
            body: buildQuery({ api_type: 'json', thing_id: fullname, text: text }).slice(1),
        });
    },

    deleteComment: function (fullname) {
        return redditFetch('/api/del', {
            method: 'POST',
            body: buildQuery({ id: fullname }).slice(1),
        });
    },
};
