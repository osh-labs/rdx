'use strict';
//
// Browser smoke test. Serves dist/ and loads every page in headless Chromium,
// failing on any uncaught exception, console error, or request to a host other
// than our own origin.
//
// This catches what the Node harness cannot: load-order problems between
// auth.js/api.js/functions.js, missing DOM elements a page's inline script
// assumes, and accidental third-party requests.
//
// Requires playwright. Skips cleanly (exit 0) if it is not installed, so CI
// without it still passes:
//     npm install --no-save playwright && node test/smoke.test.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const PAGES = [
    'index.html', 'subreddit.html?r=rust', 'comments.html?url=https://www.reddit.com/r/rust/comments/a/b/',
    'search.html?q=test', 'user.html?u=bob', 'userc.html?u=bob',
    'saved.html', 'settings.html', 'themes.html', 'login.html', 'inbox.html',
];

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
};

let chromium;
try {
    ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright'));
} catch (e) {
    try {
        ({ chromium } = require('/tmp/node_modules/playwright'));
    } catch (e2) {
        console.log('playwright not installed; skipping browser smoke test');
        process.exit(0);
    }
}

function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
            const file = path.join(DIST, rel);
            if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
                res.writeHead(404); res.end('not found'); return;
            }
            res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
            res.end(fs.readFileSync(file));
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

(async () => {
    if (!fs.existsSync(DIST)) {
        console.error('dist/ not built; run ./build.sh first');
        process.exit(1);
    }

    const server = await serve();
    const base = `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
        .catch(() => chromium.launch());

    const failures = [];
    let passed = 0;

    for (const page of PAGES) {
        const ctx = await browser.newContext();
        const tab = await ctx.newPage();
        const problems = [];

        tab.on('pageerror', (err) => problems.push('uncaught: ' + err.message));
        tab.on('console', (msg) => {
            if (msg.type() === 'error') { problems.push('console.error: ' + msg.text()); }
        });
        // Nothing should reach a third-party host on a cold, logged-out load.
        tab.on('request', (req) => {
            const url = req.url();
            if (!url.startsWith(base) && !url.startsWith('data:')) {
                problems.push('offsite request: ' + url);
            }
        });

        try {
            await tab.goto(base + page, { waitUntil: 'networkidle', timeout: 15000 });
            // Every page should have rendered its shell.
            const hasBody = await tab.$('#body');
            if (!hasBody) { problems.push('no #body element rendered'); }
        } catch (err) {
            problems.push('navigation failed: ' + err.message);
        }

        await ctx.close();

        if (problems.length) {
            failures.push({ page, problems });
        } else {
            passed++;
        }
    }

    await browser.close();
    server.close();

    for (const { page, problems } of failures) {
        console.error(`FAIL  ${page}`);
        problems.forEach((p) => console.error(`      ${p}`));
    }
    console.log(`\n${passed} pages clean, ${failures.length} with problems`);
    process.exit(failures.length ? 1 : 0);
})();
