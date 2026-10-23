/**
 * MediaPulse Downloader — background service worker (Manifest V3)
 * -----------------------------------------------------------------
 * Responsibilities
 *   1. Observe network traffic with chrome.webRequest and remember every
 *      media URL (MP4, WebM, FLV, M3U8/HLS, TS/fMP4 fragments) per tab.
 *   2. Merge in media that the content script finds directly in the DOM
 *      (a <video src="...">, <source>, OG tags, JSON-LD, ...).
 *   3. Serve the merged list to the popup and handle download requests.
 *
 * Design notes (MV3 realities)
 *   - Service workers are killed after ~30 s of inactivity and keep no
 *     in-memory state. All tab state therefore lives in chrome.storage.session,
 *     which is fast and never hits disk.
 *   - Every chrome.* API call is awaited defensively; a browser update or a
 *     user closing a tab can make a listener throw, and an unhandled rejection
 *     would silently kill the rest of that event's handlers.
 *   - Tab state is created lazily and pruned on navigation/close to keep
 *     storage bounded no matter how long the browser runs.
 */

'use strict';

/* ============================================================================
 * Constants
 * ==========================================================================*/

/** Where per-tab media state is kept. */
const STORAGE_KEY = 'mediapulse:tabMedia';

/** Hard cap of remembered entries per tab (keeps storage and popup cheap). */
const MAX_ENTRIES_PER_TAB = 120;

/** Hard cap of remembered tabs (oldest tab is dropped first). */
const MAX_TABS = 40;

/** How long an entry survives without being seen again, in ms (30 min). */
const ENTRY_TTL_MS = 30 * 60 * 1000;

/** Minimum plausible size for a media entry, in bytes (anything smaller is junk). */
const MIN_MEDIA_SIZE = 1024;

/** Requests larger than this are streamed/unbounded; we do not claim a size. */
const UNKNOWN_SIZE = -1;

/**
 * Media types we understand. `kind` drives grouping + the download strategy:
 *   video    - a self-contained file (MP4, WebM, FLV, M4V, ...)
 *   hls      - an HLS playlist (M3U8)
 *   segment  - an HLS/fMP4 fragment (TS, M4S) - never offered on its own
 */
const MEDIA_TYPES = {
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  mkv: 'video',
  mov: 'video',
  flv: 'video',
  ogv: 'video',
  ogg: 'video',
  m3u8: 'hls',
  m3u: 'hls',
  mpd: 'hls', // DASH manifests share the playlist download strategy
  ts: 'segment',
  m4s: 'segment',
  fm4: 'segment',
  'cmfv': 'segment',
  'cmfa': 'segment'
};

/** MIME types that identify media when the URL extension is unhelpful. */
const MIME_TO_EXT = {
  'video/mp4': 'mp4',
  'video/x-m4v': 'mp4',
  'video/webm': 'webm',
  'video/x-flv': 'flv',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegurl': 'm3u8',
  'audio/mpegurl': 'm3u8',
  'audio/x-mpegurl': 'm3u8',
  'application/dash+xml': 'mpd',
  'video/mp2t': 'ts',
  'video/iso.segment': 'm4s'
};

/** Query-parameter names that commonly carry the real media URL. */
const URL_QUERY_KEYS = ['url', 'src', 'file', 'media', 'video', 'm3u8', 'stream', 'playlist', 'source', 'link'];

/** Request types worth inspecting. Sub-resource types cover <video src>. */
const REQUEST_TYPES = ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'object', 'other'];

/** Message types understood by the background worker. */
const MSG = {
  GET_MEDIA: 'MP_GET_MEDIA',
  ADD_MEDIA: 'MP_ADD_MEDIA',
  DOWNLOAD: 'MP_DOWNLOAD',
  CLEAR: 'MP_CLEAR',
  PING: 'MP_PING'
};

/** Broadcast to popups when the list for a tab changes. */
const EVENT_UPDATED = 'MP_UPDATED';

/* ============================================================================
 * Small helpers
 * ==========================================================================*/

/**
 * Normalise a URL: strip the hash (fragments are never sent to servers) and
 * resolve relative references. Returns null for unusable schemes.
 */
function normaliseUrl(raw, baseUrl) {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  let url;
  try {
    url = new URL(raw, baseUrl || undefined);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  return url.href;
}

/** Lowercased path extension of a URL, without the dot ("m3u8"). */
function extensionOf(href) {
  let pathname;
  try {
    pathname = new URL(href).pathname;
  } catch {
    return '';
  }
  const lastSlash = pathname.lastIndexOf('/');
  const name = lastSlash === -1 ? pathname : pathname.slice(lastSlash + 1);
  const dot = name.lastIndexOf('.');
  if (dot === -1 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Decide what a request is. Prefers the MIME type because many CDNs serve
 * extension-less URLs, then falls back to the URL path.
 *
 * @returns {{ext: string, kind: string, source: 'mime'|'extension'}|null}
 */
function classify(url, contentType) {
  if (contentType) {
    const mime = contentType.split(';')[0].trim().toLowerCase();
    const byMime = MIME_TO_EXT[mime];
    if (byMime) {
      return { ext: byMime, kind: MEDIA_TYPES[byMime] || 'video', source: 'mime' };
    }
  }

  const ext = extensionOf(url);
  if (ext && MEDIA_TYPES[ext]) {
    return { ext, kind: MEDIA_TYPES[ext], source: 'extension' };
  }

  return null;
}

/**
 * Some players wrap the real URL in a query parameter, e.g.
 *   /proxy?url=https%3A%2F%2Fcdn.example%2Fmovie.mp4
 * Try a shallow unwrap so those are not missed.
 */
function unwrapQueryUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  for (const key of URL_QUERY_KEYS) {
    const value = url.searchParams.get(key);
    if (!value) continue;

    // Guard against absurdly long values (signed tokens, base64 blobs).
    if (value.length > 2048 || !/^https?:\/\//i.test(value)) continue;

    const inner = normaliseUrl(value);
    if (inner && MEDIA_TYPES[extensionOf(inner)]) return inner;
  }

  return null;
}

/** Parse content-length headers; returns byte count or null. */
function parseContentLength(responseHeaders) {
  if (!Array.isArray(responseHeaders)) return null;
  for (const header of responseHeaders) {
    if (header && header.name && header.name.toLowerCase() === 'content-length') {
      const value = Number.parseInt(header.value, 10);
      if (Number.isFinite(value) && value >= 0) return value;
    }
  }
  return null;
}

/** Read a response header case-insensitively. */
function getHeader(responseHeaders, name) {
  if (!Array.isArray(responseHeaders)) return null;
  const wanted = name.toLowerCase();
  const hit = responseHeaders.find((h) => h && typeof h.name === 'string' && h.name.toLowerCase() === wanted);
  return hit ? hit.value : null;
}

/** Display name for a URL, used for download filenames and the UI title. */
function fileNameOf(href) {
  try {
    const last = new URL(href).pathname.split('/').filter(Boolean).pop() || 'media';
    return decodeURIComponent(last);
  } catch {
    return 'media';
  }
}

/** Host shown under each entry ("cdn.example.com"). */
function hostOf(href) {
  try {
    return new URL(href).hostname;
  } catch {
    return '';
  }
}

/** Human readable size: "1.4 MB", "812 KB", or "" when unknown. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

/**
 * Merge a previous entry with a new observation so we never lose information
 * (e.g. a size learned from one request and a duration learned from the DOM).
 * The freshest values win; everything else is kept.
 */
function mergeEntry(previous, incoming) {
  if (!previous) return incoming;

  const merged = { ...previous, ...incoming };

  // Keep the larger known size - later probes (range requests) may report
  // only the size of a single chunk.
  const sizes = [previous.size, incoming.size].filter((s) => Number.isFinite(s) && s > UNKNOWN_SIZE);
  merged.size = sizes.length ? Math.max(...sizes) : UNKNOWN_SIZE;

  // Prefer a real title over a generic filename.
  if (previous.title && previous.title !== previous.fileName && (!incoming.title || incoming.title === incoming.fileName)) {
    merged.title = previous.title;
  }

  merged.firstSeen = previous.firstSeen || incoming.firstSeen;
  merged.lastSeen = Math.max(previous.lastSeen || 0, incoming.lastSeen || 0);
  merged.segments = Math.max(previous.segments || 0, incoming.segments || 0);
  return merged;
}

/**
 * Turn one observation into the compact record we store and later show.
 * `entryKey` collapses HLS segments into a single playlist row where possible.
 */
function buildEntry({ url, ext, kind, size, tabId, pageUrl, source, title }) {
  const now = Date.now();
  return {
    url,
    ext,
    kind,
    size: Number.isFinite(size) && size >= MIN_MEDIA_SIZE ? size : UNKNOWN_SIZE,
    sizeText: Number.isFinite(size) && size >= MIN_MEDIA_SIZE ? formatBytes(size) : '',
    fileName: fileNameOf(url),
    host: hostOf(url),
    title: title || fileNameOf(url),
    pageUrl: pageUrl || '',
    tabId,
    source, // 'network' | 'dom' | 'media' | 'heuristic'
    segments: kind === 'segment' ? 1 : 0,
    firstSeen: now,
    lastSeen: now
  };
}

/* ============================================================================
 * Persistence layer (chrome.storage.session)
 * ==========================================================================*/

/**
 * Storage shape:
 *   { "mediapulse:tabMedia": { "<tabId>": { entries: { "<key>": Entry }, updated: ts } } }
 *
 * IMPORTANT: chrome.storage serialises values as JSON, so object keys always
 * come back as strings. Tab ids are therefore stored and looked up as strings
 * (`stateKey`) - mixing numeric writes with numeric reads silently loses every
 * entry, which would make every download fail with "no longer tracked".
 */
function stateKey(tabId) {
  return String(tabId);
}

async function readAll() {
  try {
    const bag = await chrome.storage.session.get(STORAGE_KEY);
    const all = bag && bag[STORAGE_KEY];
    return all && typeof all === 'object' ? all : {};
  } catch {
    return {};
  }
}

async function writeAll(all) {
  // Prune stale tabs before writing so storage cannot grow without bound.
  const tabIds = Object.keys(all);
  if (tabIds.length > MAX_TABS) {
    tabIds
      .sort((a, b) => (all[a].updated || 0) - (all[b].updated || 0))
      .slice(0, tabIds.length - MAX_TABS)
      .forEach((id) => delete all[id]);
  }

  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: all });
  } catch (err) {
    console.warn('[MediaPulse] storage write failed:', err);
  }
}

/**
 * Serialise every read-modify-write of the media store.
 *
 * A page playing HLS fires dozens of requests nearly simultaneously, and each
 * onCompleted does read -> merge -> write. Without this lock those
 * interleave and the last writer wins, silently discarding everything captured
 * by the others (a 40-fragment stream would keep only one fragment).
 */
let writeChain = Promise.resolve();

function withStoreLock(task) {
  const run = writeChain.then(task, task);
  // Keep the chain alive even if a task rejects.
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Drop entries that have not been seen for ENTRY_TTL_MS. */
function pruneEntries(tabState) {
  const cutoff = Date.now() - ENTRY_TTL_MS;
  let removed = 0;
  for (const [key, entry] of Object.entries(tabState.entries)) {
    if ((entry.lastSeen || 0) < cutoff) {
      delete tabState.entries[key];
      removed += 1;
    }
  }
  return removed;
}

/**
 * Collapse HLS fragments into their playlist where the URL pattern allows it.
 * `https://cdn/x/720p/seg-0031.ts` -> playlist `https://cdn/x/720p/index.m3u8`
 * is a guess, so segments are instead grouped by their *directory*: they are
 * counted against a synthetic row where a playlist was also seen, otherwise
 * they are hidden entirely (a TS fragment is useless on its own).
 */
function groupSegments(entries) {
  const byDir = new Map();

  for (const entry of entries) {
    if (entry.kind !== 'segment') continue;
    let dir;
    try {
      dir = new URL(entry.url).origin + new URL(entry.url).pathname.replace(/[^/]*$/, '');
    } catch {
      continue;
    }
    const bucket = byDir.get(dir) || { count: 0, lastSeen: 0 };
    bucket.count += entry.segments || 1;
    bucket.lastSeen = Math.max(bucket.lastSeen, entry.lastSeen || 0);
    byDir.set(dir, bucket);
  }

  return byDir;
}

/* ============================================================================
 * Core mutation: record an observation for a tab
 * ==========================================================================*/

/**
 * Record one media observation.
 *
 * @param {number} tabId   Chrome tab id (-1 when unknown, e.g. a worker request)
 * @param {object} observation  { url, ext?, kind?, size?, pageUrl?, source?, title? }
 * @param {object} [options]    { silent: boolean } - suppress the popup broadcast
 */
async function recordMedia(tabId, observation, options = {}) {
  if (!Number.isInteger(tabId) || tabId < 0) return null;

  const url = normaliseUrl(observation.url, observation.pageUrl);
  if (!url) return null;

  // Decide the classification up front: it is pure and needs no lock.
  let classification = classify(url, observation.contentType);
  if (!classification && observation.kind) {
    classification = { ext: observation.ext || '', kind: observation.kind, source: 'dom' };
  }
  // Unwrap proxy URLs before giving up entirely.
  if (!classification) {
    const inner = unwrapQueryUrl(url);
    if (inner) {
      classification = classify(inner, null);
    }
  }
  if (!classification) return null;

  const { ext, kind } = classification;

  return withStoreLock(async () => {
    const all = await readAll();
    const key0 = stateKey(tabId);
    const state = all[key0] || { entries: {}, updated: 0 };
    state.entries = state.entries || {};

    // Fragments are counted, not listed.
    const key = url;

    const entry = buildEntry({
      url,
      ext,
      kind,
      size: observation.size,
      tabId,
      pageUrl: observation.pageUrl,
      source: observation.source || 'network',
      title: observation.title
    });

    state.entries[key] = mergeEntry(state.entries[key], entry);

    // Enforce the per-tab cap: evict oldest-"last seen" first.
    const keys = Object.keys(state.entries);
    if (keys.length > MAX_ENTRIES_PER_TAB) {
      keys
        .sort((a, b) => (state.entries[a].lastSeen || 0) - (state.entries[b].lastSeen || 0))
        .slice(0, keys.length - MAX_ENTRIES_PER_TAB)
        .forEach((k) => delete state.entries[k]);
    }

    pruneEntries(state);
    state.updated = Date.now();
    all[key0] = state;
    await writeAll(all);

    if (!options.silent) {
      broadcastUpdate(tabId);
    }

    return entry;
  });
}

/**
 * Public view of a tab's media: deduplicated, sorted, ready for the popup.
 * HLS segments are folded into the playlist row they belong to.
 */
function buildView(tabId, state) {
  const entries = Object.values(state?.entries || {});
  const segmentsByDir = groupSegments(entries);

  const playlists = entries.filter((e) => e.kind !== 'segment');
  const visible = playlists.map((entry) => ({ ...entry }));

  // Attach segment counts to the playlist that shares a directory.
  for (const entry of visible) {
    if (entry.kind !== 'hls' && entry.kind !== 'video') continue;
    let dir;
    try {
      dir = new URL(entry.url).origin + new URL(entry.url).pathname.replace(/[^/]*$/, '');
    } catch {
      continue;
    }
    const bucket = segmentsByDir.get(dir);
    if (bucket) {
      entry.segments = bucket.count;
      entry.size = UNKNOWN_SIZE; // fragments mean the true size is unknown
      entry.sizeText = '';
    }
  }

  // Sort: playlists first, then by most-recently seen, then by size.
  const rank = { hls: 0, video: 1 };
  visible.sort((a, b) => {
    const byKind = (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9);
    if (byKind !== 0) return byKind;
    if ((b.lastSeen || 0) !== (a.lastSeen || 0)) return (b.lastSeen || 0) - (a.lastSeen || 0);
    return (b.size || 0) - (a.size || 0);
  });

  return {
    tabId,
    entries: visible,
    total: visible.length,
    updated: state?.updated || 0
  };
}

/**
 * Ask any open popup for this tab to re-render.
 *
 * The popup usually is not open, in which case sendMessage rejects; that is
 * the normal case and must never break the capture path. Older Chrome builds
 * may return undefined instead of a promise, so guard the chained .catch.
 */
function broadcastUpdate(tabId) {
  try {
    const pending = chrome.runtime.sendMessage({ type: EVENT_UPDATED, tabId });
    if (pending && typeof pending.catch === 'function') {
      pending.catch(() => {
        /* No popup is listening - normal, not an error. */
      });
    }
  } catch {
    /* The extension context can disappear on reload; ignore. */
  }
}

/* ============================================================================
 * Network interception
 * ==========================================================================*/

/**
 * Called for every completed request. We use onCompleted rather than
 * onHeadersReceived because:
 *   - it fires once per request (no double adds when headers arrive twice), and
 *   - responseHeaders is already available for content-length/MIME.
 * Requests are filtered cheaply in the listener (Chrome filters urls/hosts
 * before waking the worker), keeping CPU cost near zero.
 */
function handleCompleted(details) {
  try {
    if (!REQUEST_TYPES.includes(details.type)) return;

    const contentType = getHeader(details.responseHeaders, 'content-type');
    const classification = classify(details.url, contentType);

    // Second chance: unwrap ?url=https://cdn/x.mp4 style links.
    let url = details.url;
    let type = classification;
    if (!type) {
      const inner = unwrapQueryUrl(details.url);
      if (!inner) return;
      url = inner;
      type = classify(inner, null);
    }
    if (!type) return;

    const size = parseContentLength(details.responseHeaders);

    void recordMedia(details.tabId, {
      url,
      ext: type.ext,
      kind: type.kind,
      size: size === null ? UNKNOWN_SIZE : size,
      source: details.type === 'media' ? 'media' : 'network'
    });
  } catch (err) {
    // A listener that throws must never break subsequent events.
    console.warn('[MediaPulse] onCompleted handler failed:', err);
  }
}

/**
 * Complement onCompleted with onBeforeRedirect so that CDN redirects to the
 * real media file (e.g. /go/123 -> /files/movie.mp4) are not lost.
 */
function handleBeforeRedirect(details) {
  try {
    if (!REQUEST_TYPES.includes(details.type)) return;
    const target = details.redirectUrl;
    if (!target) return;

    const type = classify(target, null);
    if (!type) return;

    void recordMedia(details.tabId, {
      url: target,
      ext: type.ext,
      kind: type.kind,
      source: 'network'
    });
  } catch (err) {
    console.warn('[MediaPulse] onBeforeRedirect handler failed:', err);
  }
}

chrome.webRequest.onCompleted.addListener(handleCompleted, {
  urls: ['<all_urls>'],
  types: REQUEST_TYPES
});

chrome.webRequest.onBeforeRedirect.addListener(handleBeforeRedirect, {
  urls: ['<all_urls>'],
  types: REQUEST_TYPES
});

/* ============================================================================
 * Tab lifecycle
 * ==========================================================================*/

/** Forget everything we know about a tab (it navigated or closed). */
async function forgetTab(tabId) {
  await withStoreLock(async () => {
    const all = await readAll();
    const key = stateKey(tabId);
    if (!all[key]) return;
    delete all[key];
    await writeAll(all);
  });
  broadcastUpdate(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A fresh document means the old page's media is no longer on screen.
  if (changeInfo.status === 'loading' && changeInfo.url) {
    void forgetTab(tabId);
  }
});

/* ============================================================================
 * Downloads
 * ==========================================================================*/

/**
 * Validate a user-supplied filename. chrome.downloads rejects some characters
 * on Windows, and path traversal must never reach the filesystem.
 */
function sanitiseFilename(name, fallback) {
  let base = String(name || fallback || 'media')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');

  if (base.length > 150) {
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot) : '';
    base = base.slice(0, 150 - ext.length) + ext;
  }
  return base || 'media.bin';
}

/**
 * Suggested filename including the correct extension.
 *
 * Falls back through: explicit fileName -> title -> the URL's last path
 * segment -> "media". Without the URL fallback every download would be saved
 * as a generic "media.mp4", which is useless once a user has a few of them.
 */
function suggestedFilename(entry) {
  const ext = (entry.ext || '').toLowerCase();

  // A URL basename is often far more meaningful than the entry title, which
  // for network-captured rows is just the host. Try the explicit fields first.
  let name = String(entry.fileName || entry.title || '').trim();
  if (!name) {
    name = fileNameOf(entry.url || '');
  }
  name = name || 'media';

  // Strip an existing media extension, then append the canonical one.
  name = name.replace(/\.(mp4|m4v|webm|mkv|mov|flv|ogv|ogg|m3u8|m3u|mpd)$/i, '');

  // Playlist downloads get a .m3u8 suffix so players recognise them.
  const suffix = ext === 'm3u' || ext === 'mpd' ? ext : ext || 'bin';
  return sanitiseFilename(`${name}.${suffix}`, `media.${suffix}`);
}

/**
 * Download one entry. The popup sends { tabId, url } and we look up the entry
 * ourselves so a page cannot trick the worker into downloading arbitrary data
 * (the URL must already be in our captured set for that tab).
 */
async function downloadEntry({ tabId, url: requestedUrl }) {
  const all = await readAll();
  const state = all[stateKey(tabId)];
  const key = Object.keys(state?.entries || {}).find((k) => k === requestedUrl);

  if (!state || !key) {
    return { ok: false, error: 'This media is no longer tracked. Reload the page and try again.' };
  }

  const entry = state.entries[key];
  if (entry.kind === 'segment') {
    return { ok: false, error: 'Video fragments cannot be downloaded on their own. Download the playlist instead.' };
  }

  const filename = suggestedFilename(entry);

  try {
    const downloadId = await chrome.downloads.download({
      url: entry.url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false
    });

    return { ok: true, downloadId, filename };
  } catch (err) {
    // Downloads of cross-origin media can fail if the server forbids it.
    return { ok: false, error: err?.message || 'Chrome refused the download.' };
  }
}

/* ============================================================================
 * Popup actions: clear list / open (optional)
 * ==========================================================================*/

async function clearTab(tabId) {
  await forgetTab(tabId);
  return { ok: true };
}

/* ============================================================================
 * Message router
 * ==========================================================================*/

/**
 * Every onMessage handler replies asynchronously. Returning `true` keeps the
 * message channel open until sendResponse is called.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  // Never trust the sender's tabId for content-script messages: use the real
  // one from the sender so a malicious frame cannot pollute or read another
  // tab's list.
  const senderTabId = sender?.tab?.id;

  switch (message.type) {
    case MSG.PING:
      sendResponse({ ok: true, tabId: senderTabId ?? message.tabId ?? -1 });
      return false;

    case MSG.GET_MEDIA: {
      const tabId = Number.isInteger(message.tabId) ? message.tabId : senderTabId;
      readAll()
        .then((all) => {
          const state = all[stateKey(tabId)];
          sendResponse({ ok: true, ...buildView(tabId, state) });
        })
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    case MSG.ADD_MEDIA: {
      const tabId = senderTabId ?? message.tabId;
      const items = Array.isArray(message.items) ? message.items : [message.item];
      const pageUrl = message.pageUrl || sender?.tab?.url || '';

      (async () => {
        let added = 0;
        for (const item of items) {
          if (!item || !item.url) continue;
          const result = await recordMedia(tabId, { ...item, pageUrl, source: item.source || 'dom' }, { silent: true });
          if (result) added += 1;
        }
        if (added > 0) broadcastUpdate(tabId);
        sendResponse({ ok: true, added });
      })();

      return true; // async response
    }

    case MSG.DOWNLOAD: {
      // The popup supplies the tab it listed media for; fall back to the
      // sender tab so a payload without tabId still resolves.
      const tabId = Number.isInteger(message.tabId) ? message.tabId : senderTabId;
      downloadEntry({ tabId, url: message.url })
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    case MSG.CLEAR: {
      clearTab(message.tabId)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    default:
      return false;
  }
});

/* ============================================================================
 * Install / update housekeeping
 * ==========================================================================*/

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    try {
      await chrome.storage.session.clear();
    } catch {
      /* Nothing to clear on a brand-new profile. */
    }
  }
});

// Expose helpers for the popup's unit-test harness (no effect at runtime).
if (typeof globalThis !== 'undefined') {
  globalThis.__mediaPulseInternals = {
    classify,
    extensionOf,
    formatBytes,
    normaliseUrl,
    unwrapQueryUrl,
    suggestedFilename,
    sanitiseFilename,
    mergeEntry,
    parseContentLength,
    getHeader
  };
}
