'use strict';
// Utility functions [UNIVERSAL]

// --- subscriptions -------------------------------------------------------
//
// Backed by the Reddit account, not localStorage. Upstream kept subscriptions
// in a local array populated by a bookmarklet the user pasted into
// old.reddit.com to scrape their own sub list; subscribing here had no effect
// on Reddit and vice versa. The list is now fetched from
// /subreddits/mine/subscriber and cached, and the sub/unsub buttons write
// through to Reddit.

var SUBS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function cachedSubs() {
    try {
        return JSON.parse(localStorage.getItem('subsCache')) || [];
    } catch (e) {
        return [];
    }
}

function storeSubs(names) {
    names = names.slice().sort(function (a, b) {
        return a.toLowerCase().localeCompare(b.toLowerCase());
    });
    localStorage.setItem('subsCache', JSON.stringify(names));
    localStorage.setItem('subsCacheAt', String(Date.now()));
    renderSubscribedList();
    return names;
}

function subsCacheStale() {
    var at = parseInt(localStorage.getItem('subsCacheAt'), 10);
    return !at || (Date.now() - at) > SUBS_CACHE_TTL_MS;
}

function renderSubscribedList() {
    // Not every page has the sidebar (settings, themes, login).
    var target = document.getElementById('subscribed');
    if (!target) { return; }
    var names = cachedSubs();
    if (!names.length) {
        target.innerHTML = isLoggedIn()
            ? '<small>No subscriptions found.</small>'
            : '<small>Connect your account to see your subreddits.</small>';
        return;
    }
    var out = '';
    for (var i = 0; i < names.length; i++) {
        out += '<a href="subreddit.html?r=' + names[i] + '" class="homelinks">' + names[i] + '</a>';
    }
    target.innerHTML = out;
}

function refreshSubs(force) {
    if (!isLoggedIn()) { return Promise.resolve([]); }
    if (!force && !subsCacheStale()) { return Promise.resolve(cachedSubs()); }
    return api.mySubreddits().then(storeSubs).catch(function () {
        return cachedSubs();   // keep showing the stale list rather than blanking it
    });
}

function isSubscribed(name) {
    return cachedSubs().some(function (n) {
        return n.toLowerCase() === String(name).toLowerCase();
    });
}

function refreshSubButton(name) {
    var btn = document.getElementById('subbtn');
    if (!btn) { return; }
    if (!isLoggedIn()) { btn.style.display = 'none'; return; }
    var subscribed = isSubscribed(name);
    btn.innerHTML = subscribed ? 'Unsubscribe' : 'Subscribe';
    btn.setAttribute('onclick', (subscribed ? 'unsubscribe(' : 'subscribe(') +
        "'" + name + "')");
}

function setSubscription(name, want) {
    var btn = document.getElementById('subbtn');
    if (btn) { btn.innerHTML = want ? 'Subscribing...' : 'Unsubscribing...'; }
    return api.subscribe(name, want).then(function () {
        var names = cachedSubs().filter(function (n) {
            return n.toLowerCase() !== String(name).toLowerCase();
        });
        if (want) { names.push(name); }
        storeSubs(names);
        refreshSubButton(name);
    }).catch(function (e) {
        refreshSubButton(name);
        alert('Could not update subscription: ' + (e && e.message ? e.message : e));
    });
}

function subscribe(name) { return setSubscription(name, true); }
function unsubscribe(name) { return setSubscription(name, false); }

renderSubscribedList();


function toggletheme(){
const curtheme = localStorage.getItem('tname') || "default";
if(curtheme != 'default' && curtheme != 'Default'){
	document.documentElement.style.setProperty('--bodyc', localStorage.getItem('bodyc'));
document.documentElement.style.setProperty('--textc',  localStorage.getItem('textc'));
document.documentElement.style.setProperty('--linkc',  localStorage.getItem('linkc'));
document.documentElement.style.setProperty('--greyc',  localStorage.getItem('greyc'));
document.documentElement.style.setProperty('--lightc', localStorage.getItem('lightc'));
}
else {
document.documentElement.style.setProperty('--bodyc', 'white');
document.documentElement.style.setProperty('--textc', 'black');
document.documentElement.style.setProperty('--linkc', '#27598c');
document.documentElement.style.setProperty('--greyc', '#eee');
document.documentElement.style.setProperty('--lightc', '#444');
}
}
// Font choices are system stacks, not webfonts. Upstream offered ~20 Google
// Fonts and injected a <link> to fonts.googleapis.com on every page load that
// used one, disclosing your IP and the page you were on to Google. Vendoring
// that many families would add megabytes to a deliberately small app, so the
// picker now offers stacks that are already on the device.
var FONT_STACKS = {
    'default': 'sans-serif',
    'system': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    'grotesque': 'Helvetica, Arial, sans-serif',
    'humanist': 'Optima, Candara, "Segoe UI", Tahoma, sans-serif',
    'serif': 'Georgia, "Times New Roman", Times, serif',
    'slab': '"Bookman Old Style", Rockwell, Georgia, serif',
    'mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
};

function fontStack(name) {
    return FONT_STACKS[name] || FONT_STACKS['default'];
}

function togglefont(){
    var curfont = localStorage.getItem('fname') || 'default';
    document.body.style.fontFamily = fontStack(curfont);
}

var curinfi = localStorage.getItem('curinfi') || false;
if (window.location.href.indexOf("comments.html") == -1)
{
if(curinfi == "true") {
var style = document.createElement('style');
style.innerHTML = '.footer, .infotext, .next {display:none !important}';
document.head.appendChild(style);
}
}
toggletheme();
togglefont();

function toggle(id){
var x = document.getElementsByClassName("show");
for (var k = 0; k < x.length; k++) {
if(x[k].id != id) {
  x[k].classList.toggle("hidden");
  x[k].classList.toggle("show");  }
}
document.getElementById(id).classList.toggle("hidden");
document.getElementById(id).classList.toggle("show");
if(id == "subssearch"){
document.getElementById("subssearchi").focus();
}
}
//function htmlDecode(input){
 // var e = document.createElement('textarea');
 // e.innerHTML = input;
  // handle case of empty input
 // return e.childNodes.length === 0 ? "" : e.childNodes[0].nodeValue;
//}

// --- listing transport ---------------------------------------------------
//
// Replaces the JSONP implementation. JSONP is unusable now for two separate
// reasons: the .json endpoints it targeted return 403, and a <script src=...>
// tag cannot carry an Authorization header, so it could never reach the
// authenticated API even if the old URLs still worked.
//
// Pages hand in a fetcher closure rather than a URL string, so pagination can
// re-invoke the same query with a new `after` cursor without re-parsing
// anything out of window.location.

var listingFetcher = null;   // function(opts) -> Promise
var listingOpts = null;      // the opts the current page was loaded with
var nextAfter = null;        // pagination cursor, null when exhausted
var loadingMore = false;

// Set by comments.html to the post currently being viewed. Declared here
// because saveit() reads it, and under strict mode reading an undeclared
// global throws rather than yielding undefined.
var thisthread = null;

function bodyEl() {
    return document.getElementById('body');
}

// Shown instead of content when there is no connected account. Replaces the
// hardcoded shutdown notice upstream left in two places.
function renderConnectPrompt() {
    bodyEl().innerHTML =
        '<div class="notice">' +
        '<h2>Connect your Reddit account</h2>' +
        '<p>Reddit disabled unauthenticated access in May 2026, so this instance ' +
        'reads Reddit through your own account.</p>' +
        '<p><a class="bigbtn" href="login.html">Connect account</a></p>' +
        '</div>';
}

function renderError(err) {
    if (err && err.name === 'NotAuthenticatedError') {
        renderConnectPrompt();
        return;
    }
    var msg;
    if (err && err.name === 'RateLimitError') {
        msg = 'Reddit is rate limiting this client. ' +
            (err.resetSeconds ? 'Try again in ' + err.resetSeconds + ' seconds.' : 'Try again shortly.');
    } else if (err && err.status === 403) {
        msg = 'Reddit refused this request (403). If this just started, reconnect ' +
            'your account &mdash; the app may be missing the <code>read</code> scope.';
    } else if (err && err.status === 404) {
        msg = 'Not found. That subreddit or user may not exist, or may be private.';
    } else if (err && err.status === 429) {
        msg = 'Rate limited. Try again shortly.';
    } else {
        msg = 'Could not load content.' + (err && err.message ? '<br><small>' + err.message + '</small>' : '');
    }
    bodyEl().innerHTML = '<div class="notice"><p>' + msg + '</p>' +
        '<p><a class="bigbtn" href="' + window.location.href + '">Retry</a></p></div>';
}

// --- voting --------------------------------------------------------------
//
// The `vote` scope was requested by upstream from the start but no vote UI
// was ever built. `likes` is true/false/null for up/down/none.

function votebox(thing) {
    if (!isLoggedIn() || !thing['name']) { return ''; }
    var up = thing['likes'] === true ? ' voted' : '';
    var down = thing['likes'] === false ? ' voted' : '';
    return '<span class="votes" id="votes_' + thing['name'] + '">' +
        '<span class="vote up' + up + '" onclick="castvote(\'' + thing['name'] + '\',1)" title="Upvote">&#9650;</span>' +
        '<span class="vote down' + down + '" onclick="castvote(\'' + thing['name'] + '\',-1)" title="Downvote">&#9660;</span>' +
        '</span> ';
}

function castvote(fullname, dir) {
    var box = document.getElementById('votes_' + fullname);
    var scoreEl = document.getElementById('score_' + fullname);
    if (!box) { return; }
    var upEl = box.querySelector('.vote.up');
    var downEl = box.querySelector('.vote.down');

    var wasUp = upEl.classList.contains('voted');
    var wasDown = downEl.classList.contains('voted');
    var previous = wasUp ? 1 : (wasDown ? -1 : 0);
    // Clicking the direction you already chose clears the vote.
    var next = (previous === dir) ? 0 : dir;

    // Optimistic update, rolled back if Reddit rejects it.
    var score = scoreEl ? parseInt(scoreEl.textContent, 10) : null;
    function paint(v) {
        upEl.classList.toggle('voted', v === 1);
        downEl.classList.toggle('voted', v === -1);
        if (scoreEl && score !== null) {
            scoreEl.textContent = String(score - previous + v);
        }
    }
    paint(next);

    api.vote(fullname, next).catch(function (e) {
        paint(previous);
        alert('Could not vote: ' + (e && e.message ? e.message : e));
    });
}

// How to render one Listing child. Defaults to postbuilder; userc.html swaps
// in a comment renderer.
var listingItemRenderer = null;

function setListingRenderer(fn) {
    listingItemRenderer = fn;
}

function renderPosts(children) {
    var render = listingItemRenderer || postbuilder;
    var out = '';
    for (var i = 0; i < children.length; i++) {
        out += render(children[i]['data']);
    }
    return out;
}

// Build the "Next page" link from the current URL, replacing any existing
// after= cursor.
function nextPageHref(after) {
    var url = new URL(window.location.href);
    url.searchParams.set('after', after);
    return url.pathname + url.search;
}

function renderListing(res) {
    var data = (res && res.data) || {};
    var children = data.children || [];

    if (!children.length) {
        bodyEl().innerHTML = '<div class="notice"><p>Nothing to show here.</p></div>';
        return;
    }

    var fill = renderPosts(children);
    fill += '<div class="navigate">';
    nextAfter = data.after || null;
    if (nextAfter) {
        fill += '<a class="next" href="' + nextPageHref(nextAfter) + '">Next page</a>' +
            '<div id="sxpy"></div><div id="sentinel"> </div>';
    }
    fill += '</div>';
    bodyEl().innerHTML = fill;

    runhsl();
    if (curinfi == "true") {
        observe();
    }
}

// Entry point used by every listing page.
function loadListing(fetcher, opts) {
    listingFetcher = fetcher;
    listingOpts = opts || {};
    if (!isLoggedIn()) {
        renderConnectPrompt();
        return Promise.resolve();
    }
    bodyEl().innerHTML = '<div class="notice"><p>Loading&hellip;</p></div>';
    return fetcher(listingOpts).then(renderListing).catch(renderError);
}

// Append the next page during infinite scroll.
function scorllmore() {
    if (!nextAfter || !listingFetcher || loadingMore) { return false; }
    loadingMore = true;

    var opts = {};
    Object.keys(listingOpts).forEach(function (k) { opts[k] = listingOpts[k]; });
    opts.after = nextAfter;

    return listingFetcher(opts).then(function (res) {
        var data = (res && res.data) || {};
        var children = data.children || [];
        var target = document.getElementById('sxpy');
        if (target) { target.insertAdjacentHTML('beforeend', renderPosts(children)); }

        // Keep the address bar in step so a refresh resumes where you are.
        if (nextAfter) { history.pushState('', '', nextPageHref(nextAfter)); }

        nextAfter = data.after || null;
        var sentinel = document.getElementById('sentinel');
        if (sentinel) { sentinel.innerHTML = nextAfter ? ' ' : ''; }

        runhsl();
        loadingMore = false;
    }).catch(function (err) {
        loadingMore = false;
        nextAfter = null;
        var target = document.getElementById('sxpy');
        if (target) {
            target.insertAdjacentHTML('beforeend',
                '<div class="notice"><p>Could not load more.' +
                (err && err.message ? ' <small>' + err.message + '</small>' : '') + '</p></div>');
        }
    });
}



function observe() {
const options = {
        root: null,
        threshold: 1.0 
    };
let cantload = false;
    function callback(entries, observer) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                if(cantload == false) {
                    document.getElementById('sentinel').innerHTML = '<center>Loading more posts..</center>';
                cantload = true;
                setTimeout(() => {
               scorllmore();
               cantload  = false;
                }, 100);
                }
            }
        });
    }
    const observer = new IntersectionObserver(callback, options);
    const sentinel = document.getElementById('sentinel');
    if (sentinel) {
        observer.observe(sentinel);
    } 
}


function htmlDecode(input) {
  var parser = new DOMParser();
  var decoded = parser.parseFromString(input, 'text/html');
  return decoded.body.textContent;
}
function timeago(o){var t=Math.floor((new Date-o)/1e3),a=t/31536e3;return a>1?Math.floor(a)+"y":(a=t/2592e3)>1?Math.floor(a)+"mo":(a=t/86400)>1?Math.floor(a)+"d":(a=t/3600)>1?Math.floor(a)+"h":(a=t/60)>1?Math.floor(a)+"m":Math.floor(t)+"s"}
function addlc(to,data){
const addarr = JSON.parse(localStorage.getItem(to) || '[]');
addarr.push(data);
localStorage.setItem(to,JSON.stringify(addarr));
}

function checklc(to,cfor){
const chkarr = JSON.parse(localStorage.getItem(to) || '[]');
return chkarr.includes(cfor);

}
function removelc(to,cfor){
let addarr = JSON.parse(localStorage.getItem(to) || '[]');
addarr = addarr.filter(function(item) {
    return item !== cfor
})

localStorage.setItem(to,JSON.stringify(addarr));
}

// Subreddit autocomplete. Was an XHR against
// old.reddit.com/api/subreddit_autocomplete/.json (now 403); the authenticated
// _v2 endpoint returns a standard Listing rather than {subreddits:[...]}.
//
// Two fixes beyond the transport: Enter used to be handled synchronously
// straight after send(), so it navigated using the PREVIOUS query's results;
// and out-of-order responses could overwrite newer ones. Both are sequenced
// now.
var autocompleteSeq = 0;
var autocompleteResults = [];

function renderSubsList(names) {
    autocompleteResults = names;
    var out = '';
    for (var i = 0; i < names.length; i++) {
        out += '<a href="subreddit.html?r=' + names[i] + '">' + names[i] + '</a>';
    }
    var el = document.getElementById('subslist');
    if (el) { el.innerHTML = out; }
}

function searchsubs(q, event) {
    var key = event && (event.keyCode || event.charCode);
    if (key === 13) {
        // Navigate to the top result we actually have, not one we hope to get.
        if (autocompleteResults.length) {
            window.location = 'subreddit.html?r=' + autocompleteResults[0];
        } else if (q) {
            window.location = 'subreddit.html?r=' + encodeURIComponent(q);
        }
        return;
    }

    q = (q || '').trim();
    if (q.length < 2) { renderSubsList([]); return; }
    if (!isLoggedIn()) { return; }

    var seq = ++autocompleteSeq;
    api.autocomplete(q).then(function (res) {
        if (seq !== autocompleteSeq) { return; }   // a newer keystroke won
        var children = (res && res.data && res.data.children) || [];
        renderSubsList(children.map(function (c) { return c.data.display_name; }));
    }).catch(function () {
        if (seq === autocompleteSeq) { renderSubsList([]); }
    });
}

// subscribe()/unsubscribe() now live with the rest of the subscription code
// at the top of this file and write through to Reddit.

function replaceRedditLinks(htmlContent) {
  var replacedText = htmlContent.replace(/href="\/u\/([^"]+)"/g, 'href="user.html?u=$1"').replace(/href="\/r\/([^"]+)"/g, 'href="subreddit.html?r=$1"')
  .replace(/(href=\"https:\/\/(old.|www.|)reddit\.com\/r\/[^\/]+\/comments\/[^"]+)(\?[^"]+)?/g, function(match, p1, p2) {
                                  return 'href="comments.html?url=' + encodeURIComponent(p1).replace(/href%3D%22/g,'');
                                }).replace(/(href=\"https:\/\/reddit\.com\/r\/[^\/]+\/comments\/[^"]+)(\?[^"]+)?/g, function(match, p1, p2) {
                                  return 'comments.html?url=' + encodeURIComponent(p1 + (p2 || ""));
                                });  return replacedText;
}


function postbuilder(post){
// `returnfpost` MUST stay local: this function recurses for crossposts
// (below), and as an implicit global the recursive call wiped the parent's
// accumulated markup.
let returnfpost = '';
 let mode = localStorage.getItem('curmode') || "original";
if (window.location.href.indexOf("comments.html") != -1) {
 mode = "original";
}
const timeagoed = timeago(post['created_utc']*1000);
const sticky = post['stickied'] ? " sticky" :" ";
let over18 = '';
if(checklc('a18','yes') != true) {
over18 = post['over_18'] ? "over18" :" ";
}
const ismod = (post['distinguished'] == "moderator") ? " moderator" :" ";
returnfpost +=  '<div class="post '+mode+'" id="'+post['id']+'">';
if(mode == "comp") {
let thumbnail = post['thumbnail'];
if(thumbnail != "self" && thumbnail != "spoiler" && thumbnail != "default" && thumbnail != ""  && thumbnail != "nsfw") {
if(thumbnail == "image") {
thumbnail = post["preview"]['images'][0]['resolutions'][0]['url'];
}
returnfpost +=  '<div class="compthumb"><img src="'+thumbnail+'" alt="thumbnail"/></div><div class="rop">';
} else {
thumbnail = thumbnail || "&bull;"; 
	  const  mx = post?.preview?.images?.[0]?.resolutions?.[0]?.url || "none";
if(mx != "none") {
returnfpost +=  '<div class="compthumb"><img src="'+mx+'" alt="thumbnail"/></div><div class="rop">';

}
else {
returnfpost += '<div class="comptext">'+thumbnail+'</div><div class="rop">';
}
}
}
returnfpost +=  '<div class="post_author"><a href="subreddit.html?r='+post["subreddit"]+'">'+post["subreddit_name_prefixed"]+'</a> &bull;  <a href="user.html?u='+post["author"]+'">'+post["author"]+'</a>  &bull; '+timeagoed+'</div><div class="post_link'+ sticky+' '+ismod+'"><a href="comments.html?url=https://www.reddit.com'+ post['permalink']+'">'+post['title']+'</a></div>';

if(mode != "comp") {
if(post["selftext_html"] != null){
var replacedText = replaceRedditLinks(post["selftext_html"]);

returnfpost += '<div class="postc selftext">'+htmlDecode(replacedText)+'</div>';
}
let urli = post['url_overridden_by_dest'];
if (post['url'] && post['url'].includes('reddit.com/gallery')) {
        urli = post['url'];
    }

// The old guard was `(x != null && x.length) || (typeof x !== 'undefined' && x.length)`.
// For x === null the second clause passes the typeof test ("object") and then
// dereferences null. It only survived because Reddit omits the key rather
// than sending null.
const xpost = post['crosspost_parent_list'];
if(Array.isArray(xpost) && xpost.length > 0){
returnfpost += postbuilder(xpost[0]);
}
else {
if(over18 === 'over18') {returnfpost += '<button onclick="allown_sfw()" class="sfwtoggle">Click to Allow this content</button>';}
if(typeof urli != "undefined" && post['removed_by_category'] == null){  returnfpost += '<div class="urlpreview '+over18+'">'+urlpreview(urli,post)+'</div><div style="text-align: right;font-size:12px;"><a href="'+post['url']+'" target="_blank"><small>Open URL</small></a></div>'; }
if(post['removed_by_category'] != null) {
returnfpost += 'Removed by '+ post['removed_by_category'];
}
if(post['poll_data'] != null){
returnfpost += pollbuilder(post);
}
}
}


returnfpost += '<div class="post_meta">' + votebox(post) +
    '<span class="scorebox" id="score_' + post['name'] + '">' + post['score'] + '</span> votes &bull; ' +
    '<a href="comments.html?url=https://www.reddit.com' + post['permalink'] + '">' + post['num_comments'] + ' comments</a>';
if (localStorage.getItem('refreshToken') !== null && window.location.href.includes('comments.html')) {
  returnfpost += ' &bull; <span onclick="replyto(\'t3_' + post['id'] + '\')">Reply</span>';
}
returnfpost += '</div>';
if(mode == "comp") {
returnfpost += '</div>';
}

returnfpost += '</div>';
return returnfpost;
}
function allown_sfw(){
	addlc('a18','yes');
	window.location.reload();
}
function preloadImage(im_url) {
  let container = document.createElement('div');
  container.innerHTML = `<img src="${im_url}" />`;

  document.body.appendChild(container);
  setTimeout(function() {
    document.body.removeChild(container);
  }, 1);
}

function closegal(){
document.getElementById('newgallery').outerHTML = '';
}

function galleryopen(theid){
const jdiv = document.createElement('div');
jdiv.id = 'newgallery';
document.getElementsByTagName('body')[0].appendChild(jdiv);
jdiv.innerHTML = '<span id="closegal" onclick="closegal();">Close</span>';
document.querySelectorAll('[data-id="'+theid+'"]').forEach(el => {
jdiv.innerHTML += '<div class="displayimg"><img src="'+el.getAttribute('data-msrc')+'"></div>';
});
}
function urlpreview(urli,postjson) {
let returnpost = '';
let vidurl;
let vidposter;
	if (urli.match(/.(jpg|jpeg|png)$/i))
	{
		returnpost += '<div class="postc singleimage"><img src="'+ urli +'"/></div>';
	}
	else if (urli.match(/.(gif)$/i)){
	  const  x = postjson?.preview?.images?.[0]?.variants?.mp4?.source?.url || "none";
if(x == "none") {
		returnpost += '<div class="postc singleimage"><img src="'+ urli +'"/></div>';

}
else {
	vidposter = postjson["preview"];
		if(typeof vidposter == "undefined"){
			vidposter = postjson["thumbnail"];
		}
		else {
			
			vidposter = postjson["preview"]["images"]["0"]["source"]["url"];
		}
		returnpost += '<div class="postc video"><video src="'+ x +'#t=0.001" poster="'+vidposter+'" width="100%" height="240" preload="metadata" controls></video></div>';

}
	}
	else if (urli.match(/www.reddit.com\/gallery/g))
	{
	returnpost += '<div class="postc gallery">';
	const pjmd = postjson['media_metadata'];
	const pjgd = postjson['gallery_data'];
	let g_mimg;
	const pjmdsorted = {};
if(pjgd) {
pjgd.items.forEach((item, index) => {
  const mediaId = item.media_id;
  if (pjmd.hasOwnProperty(mediaId)) {
    pjmdsorted[mediaId] = pjmd[mediaId];
  }
});
}
let g_timgs = '<div class="gallery_thumbs">';
let fakect = ' actv';
	for(var singlept in pjmdsorted) {
	    
		if(pjmdsorted[singlept]['status'] != 'failed' && pjmdsorted[singlept]['status'] != 'unprocessed') {
		let singleptlink = pjmdsorted[singlept]['s']['u'];
		if(typeof singleptlink == "undefined"){          singleptlink = pjmdsorted[singlept]['s']['gif'];          }
		else {
		singleptlink = singleptlink.replace("preivew.redd", "i.redd");}
      	const singletmlink =  pjmdsorted[singlept]['p']['0']['u'];
      	if(fakect == ' actv') {
      	g_mimg  = '<img src="'+singleptlink+'" alt="main image" id="mi_'+postjson['id']+'" onclick="galleryopen(\''+postjson['id']+'\')"/>';
      	}
      	g_timgs += '<img class="gtumb'+fakect+'" src="'+singletmlink+'" data-msrc="'+singleptlink+'" alt="thumbnail" data-id="'+postjson['id']+'">';
      	 preloadImage(singleptlink);

		//returnpost +='<img src="'+singleptlink+'" />';
		}
		fakect = '';
	}
	returnpost += '<div class="gallery_main">';
	if(typeof g_mimg != "undefined") {
	returnpost += g_mimg;
	}
	returnpost += '</div>';
	returnpost +=  g_timgs;
    returnpost += '</div></div>';
	}
	else if (urli.match(/v.redd.it/g))
	{
	returnpost += '<div class="postc video">';
		if(postjson['secure_media'] != null) {
		vidurl =  postjson['secure_media']['reddit_video']['dash_url'];
		const hlsurl =  postjson['secure_media']['reddit_video']['hls_url'];
		const fallbackurl = postjson['secure_media']['reddit_video']['fallback_url'];
		vidposter = postjson["preview"];
		if(typeof vidposter == "undefined"){
			vidposter = postjson["thumbnail"];
		}
		else {
			
			vidposter = postjson["preview"]["images"]["0"]["source"]["url"];
		}
		returnpost +='<video id="v'+postjson['id']+'" src="'+vidurl+'#t=0.001" data-fallback="'+fallbackurl+'" data-hls="'+hlsurl+'" poster="'+vidposter+'" width="100%" height="300" preload="metadata" class="reddit_hls" style="max-width:100%;"  controls> </video>';
		}
		else {returnpost += 'crosspost';}
	returnpost += '</div>';
	}
	else if (urli.match(/redgifs/g) && postjson.preview)
	{
	returnpost += '<div class="postc video">';
	if(postjson['secure_media']) {
	vidurl = postjson['secure_media']['oembed']['thumbnail_url']; 
	if(typeof vidurl == "undefined"){
		vidurl = urli.replace("redgifs.com/watch/", "redgifs.com/ifr/");
		vidurl = '<iframe src="'+vidurl+'?autoplay=0" class="gifframe"></iframe>';
		returnpost += vidurl;
	}
	else {
		if(postjson['preview'] && typeof postjson['preview']['reddit_video_preview'] != "undefined") {
		vidurl = postjson['preview']['reddit_video_preview']['fallback_url'];
		}
		else if (postjson['secure_media']['oembed']['thumbnail_url']) {
		vidurl = postjson['secure_media']['oembed']['thumbnail_url'];
		}
		vidurl = vidurl.replace("size_restricted.gif", "mobile.mp4")
		
		returnpost +='<video src="'+vidurl+'#t=0.001" poster="'+postjson["preview"]["images"]["0"]["source"]["url"]+'" width="100%" height="240" preload="metadata" controls> </video>';
	}
	}
	returnpost += '</div>';
	}
	else if (urli.match(/i.imgur.com(.*?)gifv/g))
	{
	returnpost += '<div class="postc video">';
	vidurl = urli.replace(".gifv", ".mp4") 
	returnpost +='<video src="'+vidurl+'" poster="'+postjson["thumbnail"]+'#t=0.001" width="100%" height="240" preload="metadata" controls> </video>';
	returnpost += '</div>';
	}
	else {
	const thumbnailforit = '';
	if(postjson["thumbnail"] && postjson["thumbnail"].length > 9){
		returnpost += '<a href="'+ urli +'" target="_blank" class="wholethumb"><div class="postc thumblink"><div class="thumb"><img src="'+postjson["thumbnail"]+'"/></div><div class="thumblinklink">'+urli +'</div></div></a>';
	}
	else {
		returnpost += '<div class="postc link"><a href="'+ urli +'" target="_blank">'+thumbnailforit+''+urli +'</a></div>';
	}
	returnpost = replaceRedditLinks(returnpost);
	}
	return returnpost;
}


function pollbuilder(postjson) {
	let returnpoll = '<div class="poll">';
	for(const popt in postjson['poll_data']['options']){
		let vote_count = postjson['poll_data']['options'][popt]['vote_count'];
		"undefined"==typeof vote_count&&(vote_count=" ");
		returnpoll += '<div class="polloption"><span class="polloptiontext">'+postjson['poll_data']['options'][popt]['text']+'</span> <span  class="votecount">'+vote_count+'</span>';
		if(vote_count != ' '){
			returnpoll += '<div class="optionmeter" style="width:'+postjson['poll_data']['options'][popt]['vote_count']/postjson['poll_data']['total_vote_count']*100+'%;"></div>';
		}
		returnpoll += '</div>';
	}
	returnpoll += '<div class="totalvotes">Total votes: '+postjson['poll_data']['total_vote_count']+'</div>';
	returnpoll += '</div>';
	return returnpoll;
}
function playaud(id){
document.getElementById(id).play();
}
function pauseaud(id){
document.getElementById(id).pause();
}
function seeked(id){
//document.getElementById(id).pause();
document.getElementById('a'+id).currentTime  = document.getElementById('v'+id).currentTime;
}
function getget(name, url = window.location.href) {
    name = name.replace(/[\[\]]/g, '\\$&');
    var regex = new RegExp('[?&]' + name + '(=([^&#]*)|&|#|$)'),
        results = regex.exec(url);
    if (!results) return null;
    if (!results[2]) return '';
    return decodeURIComponent(results[2].replace(/\+/g, ' '));
}

function cbuilder(comment){
const timeagoed = timeago(comment['created_utc']*1000);
const isop = comment['is_submitter'] == true ? "isop" : "";
const ismod = comment['distinguished'] == 	" moderator" ? "ismod" : "";



let cret = '<div class="comment ccp'+comment['depth']+'" id="'+comment['id']+'"><div class="comment_author"><span class="authorttext '+isop+''+ismod+'"><a class="authorlink" href="user.html?u='+ comment['author'] +'">'+ comment['author'] +'</a></span>  <span class="comment_meta">'+ votebox(comment) + '<span class="scorebox" id="score_'+ comment['name'] +'">'+ comment['score'] +'</span> votes &bull; '+timeagoed+' </span></div><div class="comment_text">'+ replaceRedditLinks(htmlDecode(comment['body_html'])) +'</div>';
if(localStorage.getItem('refreshToken') != null){
cret += '<div class="comment-reply"><span onclick="replyto(\'t1_'+comment['id']+'\')">Reply</span>';
if(localStorage.getItem('userName') == comment['author']){
cret += '<span onclick="editto(\'t1_'+comment['id']+'\')">Edit</span><span onclick="deleteto(\'t1_'+comment['id']+'\')">Delete</span>';
}
cret += '</div>';
}
cret += '</div>';
return cret;
}
// Post-render wiring: video players and gallery thumbnails.
//
// The upstream version also injected an OffChess promo bar above the header
// and an App Store / Play Store install banner into every listing. Both are
// gone, along with axit()/hideprompt() which dismissed them.

// dash.js is 780 KB and only needed for v.redd.it DASH playback, so it is
// loaded on demand rather than in every page's <head>.
var dashLoading = null;

function loadDashJs() {
    if (typeof dashjs !== 'undefined') { return Promise.resolve(); }
    if (dashLoading) { return dashLoading; }
    dashLoading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'dash.all.min.js';
        s.onload = resolve;
        s.onerror = function () { reject(new Error('could not load dash.all.min.js')); };
        document.head.appendChild(s);
    });
    return dashLoading;
}

function attachVideos() {
    var videos = document.querySelectorAll('.reddit_hls:not(.goner)');
    if (!videos.length) { return; }

    var needsDash = [];
    var isIOS = /iPhone|iPad/i.test(navigator.userAgent);

    videos.forEach(function (video) {
        video.classList.add('goner');
        if (isIOS) {
            // Safari plays HLS natively; no player library needed.
            video.src = video.getAttribute('data-hls');
        } else {
            needsDash.push(video);
        }
    });

    if (!needsDash.length) { return; }
    loadDashJs().then(function () {
        needsDash.forEach(function (video) {
            var player = dashjs.MediaPlayer().create();
            player.initialize(video, video.src, false);
        });
    }).catch(function () {
        // Fall back to the progressive MP4 rather than leaving a dead player.
        needsDash.forEach(function (video) {
            var fallback = video.getAttribute('data-fallback');
            if (fallback) { video.src = fallback; }
        });
    });
}

function attachGalleries() {
    document.querySelectorAll('.gtumb').forEach(function (gtum) {
        gtum.addEventListener('click', function () {
            var id = this.getAttribute('data-id');
            var main = document.getElementById('mi_' + id);
            if (!main) { return; }
            main.src = this.getAttribute('data-msrc');
            document.querySelectorAll('[data-id="' + id + '"]').forEach(function (el) {
                el.classList.remove('actv');
            });
            this.classList.add('actv');
            main.scrollIntoView();
        });
    });
}

function runhsl(){
    attachVideos();
    attachGalleries();
}


  function shareit(){
  	if(navigator.share){const t=window.location.href;const n=document.title;const e={title:n,url:t};navigator.share(e).then(()=>{console.log("Shared successfully")}).catch(e=>{console.error("Error sharing:",e)})}
  	else{const t=window.location.href,n=document.createElement("textarea");n.value=t,document.body.appendChild(n),n.select(),document.execCommand("copy"),document.body.removeChild(n),alert("Link copied to clipboard: "+t)}
  }
  
// --- saved posts ---------------------------------------------------------
//
// Real Reddit saves. Upstream pushed {url, title, subreddit} into a
// localStorage array, so saves were invisible to Reddit and to every other
// client, and could not be read back on another device.
//
// Anything already in the old localStorage array is still shown, under a
// separate heading, so nothing you saved before is lost.

function saveit(el) {
    if (!thisthread || !thisthread.name) { return false; }
    if (!isLoggedIn()) { window.location.href = 'login.html'; return false; }

    var wasSaved = el.getAttribute('data-saved') === '1';
    el.innerHTML = wasSaved ? 'Unsaving...' : 'Saving...';

    api.save(thisthread.name, !wasSaved).then(function () {
        el.setAttribute('data-saved', wasSaved ? '0' : '1');
        el.innerHTML = wasSaved ? 'Save' : 'Saved';
    }).catch(function (e) {
        el.innerHTML = wasSaved ? 'Saved' : 'Save';
        alert('Could not update saved posts: ' + (e && e.message ? e.message : e));
    });
    return false;
}

function legacySavedLinks() {
    try {
        return JSON.parse(localStorage.getItem('savedlinks')) || [];
    } catch (e) {
        return [];
    }
}

function renderLegacySaved(container) {
    var links = legacySavedLinks();
    if (!links.length) { return; }
    var html = '<div class="notice"><p><b>Saved before this instance used your ' +
        'Reddit account.</b> These are stored only in this browser.</p></div>';
    for (var i = links.length - 1; i >= 0; i--) {
        var link = links[i];
        html += '<div class="post"><div class="post_author">' +
            '<a href="subreddit.html?r=' + String(link.s || '').replace('r/', '') + '">' + (link.s || '') + '</a>' +
            '<span onclick="removeit(' + i + ');" style="float:right;color:var(--lightc);cursor:pointer;">X</span>' +
            '</div><div class="post_link"><a href="' + link.u + '">' + link.t + '</a></div></div>';
    }
    container.insertAdjacentHTML('beforeend', html);
}

function displayit() {
    var container = document.getElementById('links-container');
    if (!container) { return; }

    if (!isLoggedIn()) {
        // Render into the container, not via renderConnectPrompt() -- that
        // rewrites #body and would detach the container underneath us.
        container.innerHTML =
            '<div class="notice"><h2>Connect your Reddit account</h2>' +
            '<p>Your Reddit saves live on your account.</p>' +
            '<p><a class="bigbtn" href="login.html">Connect account</a></p></div>';
        renderLegacySaved(container);
        return;
    }

    container.innerHTML = '<div class="notice"><p>Loading&hellip;</p></div>';
    api.savedPosts({ limit: 50 }).then(function (res) {
        var children = (res && res.data && res.data.children) || [];
        var html = '';
        for (var i = 0; i < children.length; i++) {
            html += postbuilder(children[i]['data']);
        }
        container.innerHTML = html || '<div class="notice"><p>You have no saved posts.</p></div>';
        renderLegacySaved(container);
        runhsl();
    }).catch(function (e) {
        container.innerHTML = '<div class="notice"><p>Could not load saved posts.' +
            (e && e.message ? '<br><small>' + e.message + '</small>' : '') + '</p></div>';
        renderLegacySaved(container);
    });
}

// Removes an entry from the pre-migration localStorage list only.
function removeit(index) {
    var links = legacySavedLinks();
    if (index >= 0 && index < links.length) {
        links.splice(index, 1);
        localStorage.setItem('savedlinks', JSON.stringify(links));
        displayit();
    }
}


function replyto(cmtid){
document.getElementById('popitup').style.display = 'block';
document.getElementById('cmtid').value = cmtid;
document.getElementById('actype').value = "c";
    let ebId = cmtid.replace(/^(t1_|t3_)/, '');
    if(document.getElementById(ebId).className != "post"){
    	    	document.getElementById('helptext').textContent = 'Reply to: '+document.getElementById(ebId).querySelector('.comment_text').textContent;
    	
    }
    else {
    	document.getElementById('helptext').textContent = 'Reply to:' +document.getElementById(ebId).querySelector('.post_link a').textContent;
    	
    }
    document.getElementById('commentText').focus();
}
function editto(cmtid){
document.getElementById('popitup').style.display = 'block';
document.getElementById('cmtid').value = cmtid;
let ebId = cmtid.replace(/^(t1_|t3_)/, '');
document.getElementById('commentText').value = document.getElementById(ebId).querySelector('.comment_text').textContent;
document.getElementById('actype').value = "e";
 document.getElementById('helptext').textContent = 'Editing: '+document.getElementById(ebId).querySelector('.comment_text').textContent;
 document.getElementById('commentText').focus();
}
function deleteto(cmtid){
 const confirmation = confirm("Are you sure you want to delete this?");
    if (confirmation) {
        document.getElementById('cmtid').value = cmtid;
        document.getElementById('actype').value = "d";
        apiAction();
    }
}

// --- write actions -------------------------------------------------------
//
// apiAction() used to hand-roll a token-expiry check and a refresh request
// with the client secret inline, then dispatch to four functions that each
// built their own fetch(). All of that now lives in redditFetch/api, so this
// is just dispatch plus DOM updates.

function inboxto() {
    document.getElementById('actype').value = "i";
    apiAction();
}

function apiAction() {
    if (!isLoggedIn()) {
        window.location.href = 'login.html';
        return;
    }
    switch (document.getElementById('actype').value) {
        case 'c': submitComment(); break;
        case 'e': editComment(); break;
        case 'd': delComment(); break;
        case 'i': getInbox(); break;
        default: break;
    }
}

function setSubmitBusy(busy) {
    var btn = document.getElementById('cmntbtn');
    if (!btn) { return; }
    btn.disabled = busy;
    btn.innerHTML = busy ? 'Submitting...' : 'Submit';
}

function closeReplyBox() {
    document.getElementById('popitup').style.display = 'none';
    document.getElementById('commentText').value = '';
}

// Reddit reports application-level failures inside a 200 response.
function apiErrors(res) {
    var errs = res && res.json && res.json.errors;
    return (errs && errs.length) ? errs.map(function (e) { return e.join(': '); }).join('; ') : null;
}

function submitComment() {
    var thingId = document.getElementById('cmtid').value;
    var text = document.getElementById('commentText').value;
    if (!text.trim()) { return; }
    setSubmitBusy(true);

    api.comment(thingId, text).then(function (res) {
        var err = apiErrors(res);
        if (err) { throw new Error(err); }
        setSubmitBusy(false);
        closeReplyBox();

        var anchorId = thingId.replace(/^(t1_|t3_)/, '');
        var anchor = document.getElementById(anchorId);
        if (!anchor) { return; }
        var cls = 'ccp0';
        if (anchor.className !== 'post') {
            var m = anchor.className.match(/ccp(\d+)/);
            if (m) { cls = 'ccp' + (parseInt(m[1], 10) + 1); }
        }
        // Render the real comment Reddit created rather than a fake stub, so
        // the id and score are correct if the user then edits or deletes it.
        var created = res && res.json && res.json.data && res.json.data.things &&
            res.json.data.things[0] && res.json.data.things[0].data;
        if (created) {
            anchor.insertAdjacentHTML('afterend', cbuilder(created));
        }
    }).catch(function (e) {
        setSubmitBusy(false);
        alert('Error submitting comment: ' + (e && e.message ? e.message : e));
    });
}

function editComment() {
    var thingId = document.getElementById('cmtid').value;
    var text = document.getElementById('commentText').value;
    setSubmitBusy(true);

    api.editComment(thingId, text).then(function (res) {
        var err = apiErrors(res);
        if (err) { throw new Error(err); }
        setSubmitBusy(false);
        closeReplyBox();
        var el = document.getElementById(thingId.replace(/^(t1_|t3_)/, ''));
        if (el) {
            var body = el.querySelector('.comment_text');
            if (body) { body.textContent = text; }
        }
    }).catch(function (e) {
        setSubmitBusy(false);
        alert('Error editing comment: ' + (e && e.message ? e.message : e));
    });
}

function delComment() {
    var thingId = document.getElementById('cmtid').value;
    api.deleteComment(thingId).then(function () {
        var el = document.getElementById(thingId.replace(/^(t1_|t3_)/, ''));
        if (el) { el.style.display = 'none'; }
    }).catch(function (e) {
        alert('Error deleting comment: ' + (e && e.message ? e.message : e));
    });
}

function getInbox() {
    var target = document.getElementById('inboxbody');
    if (!target) { return; }
    if (!isLoggedIn()) {
        target.innerHTML = '<div class="notice"><p>Connect your Reddit account to read your inbox.</p>' +
            '<p><a class="bigbtn" href="login.html">Connect account</a></p></div>';
        return;
    }
    target.innerHTML = '<div class="notice"><p>Loading&hellip;</p></div>';

    api.inbox().then(function (res) {
        var messages = (res && res.data && res.data.children) || [];
        if (!messages.length) {
            target.innerHTML = '<div class="notice"><p>Your inbox is empty.</p></div>';
            return;
        }
        var html = '';
        messages.forEach(function (item) {
            // Each Listing child is {kind, data}. The old code destructured
            // item.inboxMessages, which does not exist, so this threw on
            // every message. The reply target is `name` (a fullname like
            // t1_abc), not `tname`, and body_html arrives escaped.
            var kind = item.kind;
            var d = item.data || {};
            if (kind !== 't1' && kind !== 't4') { return; }

            var date = new Date(d.created_utc * 1000);
            var pad = function (n) { return String(n).padStart(2, '0'); };
            var when = date.getDate() + '/' + (date.getMonth() + 1) + '/' + date.getFullYear() +
                ' - ' + date.getHours() + ':' + pad(date.getMinutes());
            var body = d.body_html ? replaceRedditLinks(htmlDecode(d.body_html)) : '';

            html += '<div class="inboxmsgwrap">';
            html += '<div class="ibxmeta"><span class="ibxauthor"><a href="user.html?u=' + d.author + '">u/' + d.author + '</a>' +
                ' &bull; <span class="ibxtime">' + when + '</span></span></div>';
            html += '<div class="ibxsub">' + (d.subject || '') + '</div>';
            if (kind === 't1' && d.context) {
                html += '<div class="ibxlink"><a href="comments.html?url=https://www.reddit.com' + d.context + '">' +
                    (d.link_title || 'View context') + '</a></div>';
            }
            html += '<div class="ibxmsg">' + body + '</div>';
            html += '<div class="ibxactions"><button onclick="replyto(\'' + d.name + '\')">Reply</button></div>';
            html += '</div>';
        });
        target.innerHTML = html;
    }).catch(function (e) {
        target.innerHTML = '<div class="notice"><p>Could not load your inbox.' +
            (e && e.message ? '<br><small>' + e.message + '</small>' : '') + '</p></div>';
    });
}

// Sidebar: search form plus account links. Runs on every page that includes
// the full chrome.
window.onload = function () {
    var leftbar = document.getElementById('leftbar');
    if (!leftbar) { return; }

    var curq = getget('q') || '';
    var html = '<form class="search" action="search.html">' +
        '<input type="search" name="q" value="' + curq + '"/>' +
        '<input type="submit" value="Search"/><br style="clear:both;">';

    // Offer to scope the search to whatever this page is already showing.
    var sub = getget('r');
    var user = getget('u');
    if (sub) {
        html += '<input type="checkbox" id="chkr" name="r" value="' + sub + '" checked>' +
            '<label for="chkr"> Only search r/' + sub + '</label>';
    }
    if (user) {
        html += '<input type="checkbox" id="chku" name="u" value="' + user + '" checked>' +
            '<label for="chku"> Only search u/' + user + '</label>';
    }
    html += '</form>';

    if (isLoggedIn()) {
        var me = currentUser() || 'Account';
        // The stray "+" here produced links to u/+username.
        html += '<a href="user.html?u=' + me + '" class="homelinks">' + me + '</a>';
        html += '<a href="inbox.html" class="homelinks half">Inbox<span id="unreadbadge"></span></a>';
        html += '<a href="login.html" class="homelinks half">Account</a>';
    } else {
        html += '<a href="login.html" class="homelinks">Connect Reddit account</a>';
    }

    leftbar.insertAdjacentHTML('afterBegin', html);

    if (isLoggedIn()) {
        refreshSubs(false);
        api.unreadCount().then(function (n) {
            var badge = document.getElementById('unreadbadge');
            if (badge && n > 0) { badge.textContent = ' (' + n + ')'; }
        }).catch(function () { /* a badge is not worth surfacing an error for */ });
    }
};
