'use strict';
// Hand-built fixtures matching the shape oauth.reddit.com returns for a
// Listing child's `data` object. Trimmed to the fields postbuilder/cbuilder
// actually read.

function basePost(over = {}) {
    return {
        id: 'abc123',
        subreddit: 'programming',
        subreddit_name_prefixed: 'r/programming',
        author: 'someone',
        title: 'A post title',
        permalink: '/r/programming/comments/abc123/a_post_title/',
        created_utc: 1750000000,
        score: 42,
        num_comments: 7,
        stickied: false,
        over_18: false,
        distinguished: null,
        thumbnail: 'self',
        selftext_html: null,
        url: 'https://www.reddit.com/r/programming/comments/abc123/a_post_title/',
        url_overridden_by_dest: undefined,
        removed_by_category: null,
        poll_data: null,
        crosspost_parent_list: null,
        preview: undefined,
        secure_media: null,
        media_metadata: undefined,
        gallery_data: undefined,
        ...over,
    };
}

const preview = {
    images: [{
        source: { url: 'https://preview.redd.it/src.jpg?s=sig' },
        resolutions: [{ url: 'https://preview.redd.it/small.jpg?s=sig' }],
        variants: {},
    }],
};

module.exports = {
    textPost: basePost({
        selftext_html: '&lt;div class="md"&gt;&lt;p&gt;Body with a &lt;a href="/r/rust"&gt;link&lt;/a&gt;&lt;/p&gt;&lt;/div&gt;',
    }),

    imagePost: basePost({
        id: 'img001',
        url_overridden_by_dest: 'https://i.redd.it/photo.jpg',
        thumbnail: 'https://b.thumbs.redditmedia.com/t.jpg',
        preview,
    }),

    linkPost: basePost({
        id: 'lnk001',
        url_overridden_by_dest: 'https://example.com/article',
        thumbnail: 'https://b.thumbs.redditmedia.com/thumb.jpg',
        preview,
    }),

    videoPost: basePost({
        id: 'vid001',
        url_overridden_by_dest: 'https://v.redd.it/xyz',
        preview,
        secure_media: {
            reddit_video: {
                dash_url: 'https://v.redd.it/xyz/DASHPlaylist.mpd',
                hls_url: 'https://v.redd.it/xyz/HLSPlaylist.m3u8',
                fallback_url: 'https://v.redd.it/xyz/DASH_720.mp4',
                width: 1280,
                height: 720,
            },
        },
    }),

    galleryPost: basePost({
        id: 'gal001',
        url: 'https://www.reddit.com/gallery/gal001',
        url_overridden_by_dest: 'https://www.reddit.com/gallery/gal001',
        gallery_data: { items: [{ media_id: 'm1' }, { media_id: 'm2' }] },
        media_metadata: {
            m1: { status: 'valid', s: { u: 'https://preview.redd.it/m1.jpg?s=a' }, p: [{ u: 'https://preview.redd.it/m1t.jpg?s=a' }] },
            m2: { status: 'valid', s: { u: 'https://preview.redd.it/m2.jpg?s=b' }, p: [{ u: 'https://preview.redd.it/m2t.jpg?s=b' }] },
        },
    }),

    pollPost: basePost({
        id: 'pol001',
        poll_data: {
            total_vote_count: 10,
            options: [
                { text: 'Yes', vote_count: 7 },
                { text: 'No', vote_count: 3 },
            ],
        },
    }),

    // The regression case: postbuilder recurses into crosspost_parent_list.
    // Before the fix, `returnfpost` was an implicit global, so the recursive
    // call wiped the parent's accumulated markup.
    crosspostPost: basePost({
        id: 'xp001',
        title: 'Outer crosspost title',
        subreddit: 'outersub',
        subreddit_name_prefixed: 'r/outersub',
        crosspost_parent_list: [basePost({
            id: 'inner1',
            title: 'Inner original title',
            subreddit: 'innersub',
            subreddit_name_prefixed: 'r/innersub',
            url_overridden_by_dest: 'https://i.redd.it/inner.jpg',
            preview,
        })],
    }),

    nsfwPost: basePost({
        id: 'nsw001',
        over_18: true,
        url_overridden_by_dest: 'https://i.redd.it/nsfw.jpg',
        preview,
    }),

    removedPost: basePost({
        id: 'rmv001',
        removed_by_category: 'moderator',
        url_overridden_by_dest: 'https://i.redd.it/gone.jpg',
    }),

    comment: {
        id: 'c0001',
        author: 'commenter',
        body_html: '&lt;div class="md"&gt;&lt;p&gt;A reply&lt;/p&gt;&lt;/div&gt;',
        score: 5,
        created_utc: 1750000500,
        depth: 0,
        is_submitter: false,
        distinguished: null,
        replies: '',
    },
};
