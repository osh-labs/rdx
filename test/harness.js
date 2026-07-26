'use strict';
//
// Minimal DOM/browser stub so the rendering half of functions.js can be
// exercised in Node without a browser. There is no build system and no test
// framework here by design -- this is plain `node test/render.test.js`.
//
// It exists mainly to prove the rendering functions are strict-mode clean:
// every undeclared variable in a code path this touches becomes a hard
// ReferenceError instead of silently creating a global.

const store = new Map();

class El {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.attributes = {};
        this.style = {};
        this.classList = {
            _s: new Set(),
            add(c) { this._s.add(c); },
            remove(c) { this._s.delete(c); },
            toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); },
            contains(c) { return this._s.has(c); },
        };
        this.innerHTML = '';
        this.textContent = '';
        this.className = '';
    }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k] ?? null; }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); }
    insertAdjacentHTML() {}
    addEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() {}
    scrollIntoView() {}
    focus() {}
}

const elements = new Map();

function install() {
    const documentStub = {
        title: '',
        head: new El('head'),
        body: new El('body'),
        documentElement: new El('html'),
        createElement: (tag) => new El(tag),
        getElementById: (id) => {
            if (!elements.has(id)) elements.set(id, new El());
            return elements.get(id);
        },
        getElementsByClassName: () => [],
        getElementsByTagName: () => [new El()],
        querySelector: () => null,
        querySelectorAll: () => [],
    };
    documentStub.documentElement.style.setProperty = () => {};

    // Node >=21 ships read-only `navigator` and `location` globals, so plain
    // assignment throws. defineProperty overrides them.
    const def = (name, value) =>
        Object.defineProperty(global, name, { value, writable: true, configurable: true });

    const localStorageStub = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
    const locationStub = { href: 'https://rdx.test/index.html', origin: 'https://rdx.test' };

    def('document', documentStub);
    def('localStorage', localStorageStub);
    def('navigator', { userAgent: 'node', language: 'en-US', share: undefined });
    def('location', locationStub);
    def('window', {
        location: locationStub,
        localStorage: localStorageStub,
        onload: null,
        screen: { width: 1280, height: 800 },
        innerWidth: 1280,
        innerHeight: 800,
    });
    def('history', { pushState() {} });
    def('XMLHttpRequest', class { open() {} send() {} setRequestHeader() {} });
    def('IntersectionObserver', class { observe() {} });
    def('DOMParser', class {
        parseFromString(input) {
            // Good enough for htmlDecode(): resolve the handful of entities
            // Reddit actually emits in *_html fields.
            const text = String(input)
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                .replace(/&amp;/g, '&');
            return { body: { textContent: text } };
        }
    });
    def('fetch', () => Promise.reject(new Error('network disabled in tests')));
    def('alert', () => {});
    def('confirm', () => true);
}

function reset() {
    store.clear();
    elements.clear();
}

module.exports = { install, reset, store, elements, El };
