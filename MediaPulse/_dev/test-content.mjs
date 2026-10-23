/**
 * test-content.mjs — runs content.js against a tiny hand-written DOM mock.
 *
 * We deliberately avoid jsdom: the content script only touches a small,
 * well-understood slice of the DOM API, and a focused mock makes the
 * assertions (what got reported, and how often) completely deterministic.
 *
 * Run:  node _dev/test-content.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/* --------------------------------------------------------------------------
 * Tiny DOM implementation
 * ------------------------------------------------------------------------ */
class FakeEventTarget {
  constructor() {
    this._listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  dispatch(type) {
    for (const fn of this._listeners.get(type) || []) fn({ type, target: this });
  }
}

class FakeElement extends FakeEventTarget {
  constructor(tagName, attrs = {}, children = []) {
    super();
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this._attrs = new Map(Object.entries(attrs).map(([k, v]) => [k.toLowerCase(), v]));
    this.children = children;
    this.parentNode = null;
    for (const child of children) child.parentNode = this;
    this.textContent = '';
    this.src = this.getAttribute('src') || '';
    this.currentSrc = '';
  }

  getAttribute(name) {
    return this._attrs.has(String(name).toLowerCase()) ? this._attrs.get(String(name).toLowerCase()) : null;
  }
  setAttribute(name, value) {
    this._attrs.set(String(name).toLowerCase(), value);
    if (name === 'src') this.src = value;
  }
  hasAttribute(name) {
    return this._attrs.has(String(name).toLowerCase());
  }

  /** Depth-first walk of descendants matching a simple selector list. */
  _walk(selectorList) {
    const out = [];
    const visit = (node) => {
      if (node.nodeType === 1 && matchesAny(node, selectorList)) out.push(node);
      for (const child of node.children || []) visit(child);
    };
    for (const child of this.children) visit(child);
    return out;
  }

  querySelectorAll(selectorList) {
    return this._walk(selectorList);
  }

  /** The content script calls scanRoot(node) on added nodes. */
  replaceChildren() {
    this.children = [];
  }
}

/**
 * Very small selector matcher supporting: TAG, TAG[attr], TAG[attr="value"]
 * and TAG[attr$="suffix"] (attribute-ends-with). That is everything
 * content.js uses, and real CSS handles all of these identically.
 */
function matches(node, selector) {
  const tag = node.tagName;

  const suffix = selector.match(/^([A-Z0-9]+)\[([a-z-]+)\$="([^"]*)"\]$/i);
  if (suffix) {
    if (suffix[1].toUpperCase() !== tag) return false;
    const attr = suffix[2].toLowerCase();
    if (!node.hasAttribute(attr)) return false;
    return String(node.getAttribute(attr)).endsWith(suffix[3]);
  }

  const m = selector.match(/^([A-Z0-9]+)(?:\[([a-z-]+)(?:="([^"]*)")?\])?$/i);
  if (!m) return false;
  if (m[1].toUpperCase() !== tag) return false;
  if (!m[2]) return true;
  const attr = m[2].toLowerCase();
  if (!node.hasAttribute(attr)) return false;
  if (m[3] === undefined) return true;
  return node.getAttribute(attr) === m[3];
}

/** Split a comma-separated selector list and test each part. */
function matchesAny(node, selectorList) {
  return selectorList
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((selector) => matches(node, selector));
}

/* --------------------------------------------------------------------------
 * Build a fake document
 * ------------------------------------------------------------------------ */
const videoWithSrc = new FakeElement('video', { src: '/media/hero.MP4', title: 'Hero clip' });
const videoWithSource = new FakeElement('video', {}, [
  new FakeElement('source', { src: 'https://cdn.test/alt.webm', type: 'video/webm' })
]);
const lazyVideo = new FakeElement('video', { 'data-src': 'https://cdn.test/lazy/movie.mp4', 'data-hls': 'https://cdn.test/lazy/master.m3u8' });
const anchor = new FakeElement('a', { href: '/downloads/clip.flv' });
anchor.textContent = 'Download FLV';
const plainAnchor = new FakeElement('a', { href: '/about' });
const blobVideo = new FakeElement('video', {});
blobVideo.currentSrc = 'blob:https://site.test/9c1f';
const imageNode = new FakeElement('img', { src: 'https://cdn.test/pic.jpg' });

const metaOg = new FakeElement('meta', { property: 'og:video', content: 'https://cdn.test/og/preview.mp4' });
const jsonLd = new FakeElement('script', { type: 'application/ld+json' });
jsonLd.textContent = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'VideoObject',
  name: 'JSON-LD Movie',
  contentUrl: 'https://cdn.test/ld/movie.mp4'
});
const jsonLdBroken = new FakeElement('script', { type: 'application/ld+json' });
jsonLdBroken.textContent = '{ this is not json ';

const body = new FakeElement('body', {}, [
  videoWithSrc,
  videoWithSource,
  lazyVideo,
  anchor,
  plainAnchor,
  blobVideo,
  imageNode
]);
const documentElement = new FakeElement('html', {}, [body]);

const document = new FakeElement('#document');
document.nodeType = 9;
document.documentElement = documentElement;
document.readyState = 'complete';
document.title = 'Test Page Title';

/**
 * The content script sees the WHOLE document, but in this harness the meta and
 * JSON-LD nodes live outside the main tree (they would normally be in <head>),
 * so the mock merges them into every document-level query result.
 */
const headNodes = [];
document.querySelectorAll = (selectorList) => {
  const direct = documentElement.querySelectorAll(selectorList);
  const extra = headNodes.filter((n) => matchesAny(n, selectorList));
  return [...direct, ...extra.filter((e) => !direct.includes(e))];
};
document.querySelector = (selectorList) => document.querySelectorAll(selectorList)[0] || null;

// These normally live in <head>; the harness exposes them as head nodes.
headNodes.push(metaOg, jsonLd, jsonLdBroken);
document.addEventListener = () => {};

/* --------------------------------------------------------------------------
 * Fake MutationObserver
 * ------------------------------------------------------------------------ */
let observerInstance = null;
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    observerInstance = this;
    this.observed = null;
  }
  observe(target, options) {
    this.observed = { target, options };
  }
}

/* --------------------------------------------------------------------------
 * Fake chrome runtime
 * ------------------------------------------------------------------------ */
const sentMessages = [];
const chrome = {
  runtime: {
    sendMessage: (message, callback) => {
      sentMessages.push(message);
      if (callback) callback();
    },
    onMessage: { addListener: () => {} },
    lastError: null,
    getURL: (p) => `chrome-extension://fake/${p}`
  }
};

/* --------------------------------------------------------------------------
 * Run content.js in an isolated context
 * ------------------------------------------------------------------------ */
const timers = [];
const windowMock = new FakeEventTarget();
windowMock.setTimeout = (fn, ms) => {
  timers.push({ fn, ms });
  return timers.length;
};
windowMock.clearTimeout = () => {};
windowMock.requestAnimationFrame = (fn) => {
  fn();
  return 1;
};
windowMock.location = { href: 'https://site.test/page' };

const sandbox = {
  window: windowMock,
  document,
  chrome,
  location: windowMock.location,
  MutationObserver: FakeMutationObserver,
  Node: { ELEMENT_NODE: 1, DOCUMENT_NODE: 9 },
  console,
  setTimeout: windowMock.setTimeout,
  clearTimeout: windowMock.clearTimeout,
  URL,
  WeakSet,
  Map,
  Set,
  Array,
  Object,
  JSON,
  Math,
  String,
  Number,
  RegExp
};
sandbox.globalThis = sandbox;
sandbox.window.document = document;

const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
runInNewContext(source, sandbox, { filename: 'content.js' });

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */
/** Run only the debounced flush timer, leaving scheduled rescans queued. */
function flushNow() {
  const flushes = timers.filter((t) => t.ms <= 300);
  for (let i = timers.length - 1; i >= 0; i -= 1) {
    if (timers[i].ms <= 300) timers.splice(i, 1);
  }
  for (const t of flushes) t.fn();
}

/** Run every queued rescan timer (1000 / 3000 / 8000 ms). */
function runRescans() {
  const rescans = timers.splice(0, timers.length);
  for (const t of rescans) t.fn();
}

/** All URLs reported so far, from every MP_ADD_MEDIA message. */
function reportedUrls() {
  const urls = [];
  for (const msg of sentMessages) {
    if (msg.type === 'MP_ADD_MEDIA') for (const item of msg.items) urls.push(item.url);
  }
  return urls;
}
function reportedItems() {
  const items = [];
  for (const msg of sentMessages) {
    if (msg.type === 'MP_ADD_MEDIA') items.push(...msg.items);
  }
  return items;
}

/* --------------------------------------------------------------------------
 * Tests
 * ------------------------------------------------------------------------ */
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

console.log('\nMediaPulse content.js tests\n');

await test('reports <video src> resolved to an absolute URL', () => {
  flushNow();
  const urls = reportedUrls();
  assert.ok(urls.includes('https://site.test/media/hero.MP4'), `got: ${urls.join(', ')}`);
});

await test('reports nested <source> elements', () => {
  assert.ok(reportedUrls().includes('https://cdn.test/alt.webm'));
});

await test('reports lazy data-src / data-hls attributes', () => {
  const urls = reportedUrls();
  assert.ok(urls.includes('https://cdn.test/lazy/movie.mp4'));
  assert.ok(urls.includes('https://cdn.test/lazy/master.m3u8'));
});

await test('classifies the HLS item with kind=hls', () => {
  const hls = reportedItems().find((i) => i.url.endsWith('master.m3u8'));
  assert.equal(hls.kind, 'hls');
  assert.equal(hls.ext, 'm3u8');
});

await test('reports same-origin media anchors but ignores normal links', () => {
  const urls = reportedUrls();
  assert.ok(urls.includes('https://site.test/downloads/clip.flv'));
  assert.ok(!urls.includes('https://site.test/about'));
});

await test('ignores images and blob: URLs', () => {
  const urls = reportedUrls();
  assert.ok(!urls.some((u) => u.includes('pic.jpg')));
  assert.ok(!urls.some((u) => u.startsWith('blob:')));
});

await test('reads Open Graph meta tags', () => {
  assert.ok(reportedUrls().includes('https://cdn.test/og/preview.mp4'));
});

await test('reads JSON-LD contentUrl and survives broken JSON', () => {
  assert.ok(reportedUrls().includes('https://cdn.test/ld/movie.mp4'));
});

await test('attaches a page title to DOM entries', () => {
  const item = reportedItems().find((i) => i.url.endsWith('hero.MP4'));
  assert.equal(item.title, 'Hero clip');
});

await test('sets up a MutationObserver on the document element', () => {
  assert.ok(observerInstance, 'MutationObserver was never constructed');
  assert.equal(observerInstance.observed.target, documentElement);
  assert.equal(observerInstance.observed.options.childList, true);
  assert.equal(observerInstance.observed.options.subtree, true);
  assert.equal(observerInstance.observed.options.attributes, true);
});

await test('a video added later (infinite scroll) is detected', () => {
  sentMessages.length = 0;
  const late = new FakeElement('video', { src: 'https://cdn.test/feed/item-42.mp4' });
  observerInstance.callback([{ type: 'childList', addedNodes: [late] }]);
  flushNow();
  assert.ok(reportedUrls().includes('https://cdn.test/feed/item-42.mp4'));
});

await test('an attribute change on a container is detected', () => {
  sentMessages.length = 0;
  const container = new FakeElement('div', {});
  container.setAttribute('data-video-url', 'https://cdn.test/players/mounted/movie.mp4');
  observerInstance.callback([{ type: 'attributes', attributeName: 'data-video-url', target: container }]);
  flushNow();
  assert.ok(reportedUrls().includes('https://cdn.test/players/mounted/movie.mp4'));
});

await test('an extension-less attribute set on a <video> is detected', () => {
  // The MutationObserver only reacts to attribute VALUES that look like media,
  // so a signed/extension-less URL is picked up through the element scan path
  // when it belongs to a <video>/<source> element.
  sentMessages.length = 0;
  const player = new FakeElement('video', {});
  player.setAttribute('src', 'https://cdn.test/players/signed-stream');
  observerInstance.callback([{ type: 'attributes', attributeName: 'src', target: player }]);
  flushNow();
  assert.ok(reportedUrls().includes('https://cdn.test/players/signed-stream'));
});

await test('the same URL is not reported twice', () => {
  const before = reportedUrls().filter((u) => u === 'https://site.test/media/hero.MP4').length;
  observerInstance.callback([{ type: 'childList', addedNodes: [videoWithSrc] }]);
  flushNow();
  const after = reportedUrls().filter((u) => u === 'https://site.test/media/hero.MP4').length;
  assert.equal(after, before, 'duplicate report for an already-sent URL');
});

await test('clicking play reveals a src that was empty at load', () => {
  sentMessages.length = 0;

  // A player whose src only appears once playback starts. It is added after
  // boot, so the MutationObserver must hook it immediately. (Real DOM: the
  // node is already inserted when the observer fires - mirror that here.)
  const player = new FakeElement('video', {});
  body.children.push(player);
  player.parentNode = body;
  observerInstance.callback([{ type: 'childList', addedNodes: [player] }]);
  flushNow();
  sentMessages.length = 0;

  player.currentSrc = 'https://cdn.test/play/on-click.mp4';
  player.dispatch('loadedmetadata');
  flushNow();

  assert.ok(reportedUrls().includes('https://cdn.test/play/on-click.mp4'), `got: ${reportedUrls().join(', ')}`);
});

await test('batches multiple findings into one message', () => {
  sentMessages.length = 0;
  const a = new FakeElement('video', { src: 'https://cdn.test/batch/a.mp4' });
  const b = new FakeElement('video', { src: 'https://cdn.test/batch/b.webm' });
  observerInstance.callback([{ type: 'childList', addedNodes: [a, b] }]);
  flushNow();
  const addMessages = sentMessages.filter((m) => m.type === 'MP_ADD_MEDIA');
  assert.equal(addMessages.length, 1, 'findings should be debounced into one message');
  assert.equal(addMessages[0].items.length, 2);
  assert.equal(addMessages[0].pageUrl, 'https://site.test/page');
});

await test('every message carries pageUrl for relative resolution', () => {
  for (const msg of sentMessages.filter((m) => m.type === 'MP_ADD_MEDIA')) {
    assert.equal(msg.pageUrl, 'https://site.test/page');
  }
});

await test('double injection is prevented', () => {
  assert.equal(windowMock.__mediaPulseContentLoaded, true);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
