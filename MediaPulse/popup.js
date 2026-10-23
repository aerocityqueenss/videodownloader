/**
 * MediaPulse Downloader — popup controller
 * -----------------------------------------------------------------
 * Renders the media captured for the active tab and drives downloads.
 *
 * The popup is a thin client: it never scans the page itself (the content
 * script and the background worker own that) and it never decides which URLs
 * may be downloaded (the background re-validates every request against its
 * own captured list). This keeps the popup simple and the trust boundary in
 * one place.
 */

'use strict';

/* ============================================================================
 * Constants and element references
 * ==========================================================================*/

const MSG = {
  GET_MEDIA: 'MP_GET_MEDIA',
  DOWNLOAD: 'MP_DOWNLOAD',
  CLEAR: 'MP_CLEAR',
  RESCAN: 'MP_RESCAN'
};

const EVENT_UPDATED = 'MP_UPDATED';

/** Pages Chrome does not allow extensions to script (plus its own UI pages). */
const RESTRICTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'devtools://',
  'edge://',
  'about:',
  'view-source:',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com'
];

const els = {
  list: document.getElementById('list'),
  emptyState: document.getElementById('emptyState'),
  errorState: document.getElementById('errorState'),
  errorTitle: document.getElementById('errorTitle'),
  errorText: document.getElementById('errorText'),
  countLabel: document.getElementById('countLabel'),
  clearBtn: document.getElementById('clearBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  pageHost: document.getElementById('pageHost'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  toast: document.getElementById('toast')
};

/** The tab this popup belongs to. */
let activeTab = null;

/** Last rendered entries, keyed by URL (used to avoid needless re-renders). */
let currentEntries = [];

/** Debounce timer for refresh events coming from the worker. */
let refreshTimer = null;

/* ============================================================================
 * Messaging helpers
 * ==========================================================================*/

/**
 * Promise wrapper around chrome.runtime.sendMessage that resolves with
 * `undefined` instead of throwing when the service worker is asleep/reloading.
 */
function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(undefined);
          return;
        }
        resolve(response);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** Promise wrapper around chrome.tabs.query. */
function queryTabs(query) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query(query, (tabs) => {
        resolve(chrome.runtime.lastError ? [] : tabs || []);
      });
    } catch {
      resolve([]);
    }
  });
}

/* ============================================================================
 * Formatting helpers
 * ==========================================================================*/

/** Uppercase format label shown in the badge ("MP4", "M3U8"). */
function formatLabel(entry) {
  const ext = (entry.ext || '').toUpperCase();
  if (ext) return ext === 'M3U' ? 'M3U8' : ext;
  return entry.kind === 'hls' ? 'HLS' : 'VIDEO';
}

/**
 * Secondary line content: host, size (if known) and extra context such as
 * the number of captured HLS fragments.
 */
function describe(entry) {
  const parts = [];

  if (entry.host) parts.push({ text: entry.host, className: 'host' });

  if (entry.sizeText) {
    parts.push({ text: entry.sizeText, className: 'size' });
  } else if (entry.kind === 'hls' && entry.segments > 0) {
    parts.push({ text: `${entry.segments} fragment${entry.segments === 1 ? '' : 's'}`, className: 'size' });
  } else if (entry.kind === 'hls') {
    parts.push({ text: 'stream', className: 'size' });
  }

  if (!parts.length) parts.push({ text: 'media file', className: 'size' });
  return parts;
}

/**
 * Human title for a row.
 *
 * Prefer a real page/track title when we have one; fall back to the file name
 * and finally to a generic label. A title that is merely the file name (which
 * is what the network layer records by default) adds nothing, so we skip it.
 */
function titleOf(entry) {
  const title = (entry.title || '').trim();
  const file = (entry.fileName || '').trim();

  if (title && title !== file) return title;
  if (file) return file;
  if (title) return title;
  return 'Untitled media';
}

/* ============================================================================
 * Rendering
 * ==========================================================================*/

/** Icons used inside the download button for its different states. */
const ICONS = {
  download:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12.5 5 5L20 6.5"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v6"/><path d="M12 17v.01"/></svg>'
};

/** Build the DOM node for one media entry. */
function createCard(entry, index) {
  const li = document.createElement('li');
  li.className = 'card';
  li.style.animationDelay = `${Math.min(index * 25, 250)}ms`;
  li.dataset.url = entry.url;

  // --- Format badge -------------------------------------------------------
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.dataset.kind = entry.kind === 'hls' ? 'hls' : 'video';
  badge.textContent = formatLabel(entry);
  badge.title = entry.kind === 'hls' ? 'HLS / streaming playlist' : 'Progressive video file';

  // --- Title + metadata ---------------------------------------------------
  const meta = document.createElement('div');
  meta.className = 'meta';

  const title = document.createElement('div');
  title.className = 'meta-title';
  title.textContent = titleOf(entry);
  title.title = entry.url; // full URL on hover

  const sub = document.createElement('div');
  sub.className = 'meta-sub';

  describe(entry).forEach((part, i) => {
    if (i > 0) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      sub.append(dot);
    }
    const span = document.createElement('span');
    span.className = part.className;
    span.textContent = part.text;
    sub.append(span);
  });

  meta.append(title, sub);

  // --- Download button ----------------------------------------------------
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'download';
  button.innerHTML = `${ICONS.download}<span>Download</span>`;
  button.setAttribute('aria-label', `Download ${titleOf(entry)}`);
  button.addEventListener('click', () => handleDownload(entry, button));

  // A live refresh may re-render while a download is in flight. Restore the
  // button to the state it was in so the UI does not appear to forget it.
  applyButtonState(button, entry.url);

  li.append(badge, meta, button);
  return li;
}

/** Render a full list of entries. */
function render(entries) {
  currentEntries = Array.isArray(entries) ? entries : [];

  els.list.replaceChildren();
  els.errorState.hidden = true;

  const hasMedia = currentEntries.length > 0;
  els.emptyState.hidden = hasMedia;
  els.list.hidden = !hasMedia;
  els.clearBtn.hidden = !hasMedia;

  if (hasMedia) {
    const fragment = document.createDocumentFragment();
    currentEntries.forEach((entry, index) => fragment.append(createCard(entry, index)));
    els.list.append(fragment);
  }

  updateCount();
}

/** Update the "N found" label and the clear button state. */
function updateCount() {
  const total = currentEntries.length;
  const hls = currentEntries.filter((e) => e.kind === 'hls').length;

  if (total === 0) {
    els.countLabel.textContent = 'No media found';
    return;
  }

  const parts = [`<strong>${total}</strong> ${total === 1 ? 'media file' : 'media files'}`];
  if (hls > 0) parts.push(`${hls} HLS stream${hls === 1 ? '' : 's'}`);
  els.countLabel.innerHTML = parts.join(' · ');
}

/** Show the "cannot inspect this page" state. */
function renderRestricted(reason) {
  currentEntries = [];
  els.list.replaceChildren();
  els.list.hidden = true;
  els.emptyState.hidden = true;
  els.clearBtn.hidden = true;
  els.countLabel.textContent = 'Unavailable';
  els.errorState.hidden = false;

  if (reason === 'no-tab') {
    els.errorTitle.textContent = 'No active tab';
    els.errorText.textContent = 'Open a webpage and try again.';
  } else {
    els.errorTitle.textContent = 'This page cannot be inspected';
    els.errorText.textContent =
      'Chrome blocks extensions on this page (internet settings, the Web Store or a browser-internal page). Open a regular webpage that plays a video and try again.';
  }

  setStatus('Inactive on this page', true);
}

/** Update the footer status line. */
function setStatus(text, warn = false) {
  els.statusText.textContent = text;
  els.statusDot.classList.toggle('is-warn', Boolean(warn));
}

/* ============================================================================
 * Toasts
 * ==========================================================================*/

let toastTimer = null;

function showToast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('is-error', isError);
  els.toast.classList.add('is-visible');

  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => els.toast.classList.remove('is-visible'), 2600);
}

/* ============================================================================
 * Actions
 * ==========================================================================*/

/**
 * Per-URL button state that must survive a re-render.
 *
 * Values: 'pending' (request in flight), 'done', 'error'. Entries are removed
 * as soon as the transient state expires, so the map never grows unbounded.
 */
const buttonStates = new Map();

const BUTTON_LABELS = {
  idle: { icon: ICONS.download, text: 'Download', className: '', disabled: false },
  pending: { icon: ICONS.download, text: 'Starting…', className: '', disabled: true },
  done: { icon: ICONS.check, text: 'Saved', className: 'is-done', disabled: true },
  error: { icon: ICONS.alert, text: 'Failed', className: 'is-error', disabled: true }
};

/** Paint a button for a given state. */
function paintButton(button, stateName) {
  const spec = BUTTON_LABELS[stateName] || BUTTON_LABELS.idle;
  button.classList.remove('is-done', 'is-error');
  if (spec.className) button.classList.add(spec.className);
  button.disabled = spec.disabled;
  button.innerHTML = `${spec.icon}<span>${spec.text}</span>`;
}

/** Apply the remembered state for a URL to a freshly created button. */
function applyButtonState(button, url) {
  const state = buttonStates.get(url);
  if (state) paintButton(button, state);
}

/** Find the currently rendered button for a URL (a re-render replaces it). */
function liveButtonFor(url) {
  const card = els.list?.querySelector(`.card[data-url="${CSS.escape(url)}"]`);
  return card ? card.querySelector('.download') : null;
}

/** Set the state for a URL and update whatever button is live for it. */
function setButtonState(url, stateName, button) {
  if (stateName === 'idle') buttonStates.delete(url);
  else buttonStates.set(url, stateName);

  // Prefer the live button: a refresh may have replaced the one we were given.
  const target = liveButtonFor(url) || button;
  if (target) paintButton(target, stateName);
}

/** Clear a transient button state after a delay, wherever the button now is. */
function expireButtonState(url, delay) {
  window.setTimeout(() => {
    buttonStates.delete(url);
    const button = liveButtonFor(url);
    if (button) paintButton(button, 'idle');
  }, delay);
}

/**
 * Ask the background worker to download one entry, then reflect the result in
 * the button itself (Download -> Saved / Failed, with a toast for detail).
 */
async function handleDownload(entry, button) {
  if (button.disabled) return;

  setButtonState(entry.url, 'pending', button);

  const result = await sendMessage({ type: MSG.DOWNLOAD, tabId: activeTab?.id, url: entry.url });

  if (result?.ok) {
    setButtonState(entry.url, 'done', button);
    showToast(`Downloading ${result.filename || 'file'}…`);

    // Re-enable after a moment so the user can download again if needed.
    expireButtonState(entry.url, 2400);
    return;
  }

  setButtonState(entry.url, 'error', button);
  showToast(result?.error || 'Download failed. Try again.', true);

  expireButtonState(entry.url, 2600);
}

/** Reload the list from the background worker. */
async function refreshList({ silent = false } = {}) {
  if (!activeTab) return;

  if (!silent) {
    els.refreshBtn.classList.add('spinning');
  }

  const response = await sendMessage({ type: MSG.GET_MEDIA, tabId: activeTab.id });

  if (!silent) {
    els.refreshBtn.classList.remove('spinning');
  }

  if (!response?.ok) {
    // The service worker may still be starting; keep whatever is on screen.
    setStatus('Waiting for extension…', true);
    return;
  }

  render(response.entries);

  if (response.entries.length > 0) {
    setStatus(`Watching network · updated ${timeAgo(response.updated)}`);
  } else {
    setStatus('Watching network');
  }
}

/** Human "just now" / "2m ago" for the footer. */
function timeAgo(timestamp) {
  if (!timestamp) return 'just now';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/**
 * Re-run the content script's scan. This is much faster than reloading the
 * page and helps with players that mount late. Failures are expected on
 * restricted pages and are ignored.
 */
async function rescanPage() {
  if (!activeTab?.id) return;

  els.refreshBtn.classList.add('spinning');

  try {
    await chrome.tabs.sendMessage(activeTab.id, { type: MSG.RESCAN });
  } catch {
    // No content script yet (installed after the page loaded, or a restricted
    // page). Inject it on demand when we have permission.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id, allFrames: true },
        files: ['content.js']
      });
      await chrome.tabs.sendMessage(activeTab.id, { type: MSG.RESCAN });
    } catch {
      /* Restricted page - nothing to do. */
    }
  }

  els.refreshBtn.classList.remove('spinning');

  // Give the flush a moment to reach the background worker.
  window.setTimeout(() => refreshList({ silent: true }), 450);
}

/** Clear the captured list for this tab. */
async function clearList() {
  if (!activeTab) return;

  await sendMessage({ type: MSG.CLEAR, tabId: activeTab.id });
  render([]);
  setStatus('Watching network');
  showToast('List cleared');
}

/* ============================================================================
 * Wiring
 * ==========================================================================*/

/** Click handlers. */
els.refreshBtn.addEventListener('click', () => {
  void rescanPage().then(() => refreshList({ silent: true }));
});

els.clearBtn.addEventListener('click', () => {
  void clearList();
});

/** Live updates pushed from the background worker. */
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== EVENT_UPDATED) return;
  if (!activeTab || message.tabId !== activeTab.id) return;

  // Coalesce bursts (a page can complete dozens of requests per second).
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => refreshList({ silent: true }), 220);
});

/** React to theme changes without reloading the popup. */
window
  .matchMedia('(prefers-color-scheme: dark)')
  .addEventListener?.('change', () => {
    document.documentElement.style.colorScheme = 'light dark';
  });

/* ============================================================================
 * Boot
 * ==========================================================================*/

async function init() {
  const tabs = await queryTabs({ active: true, currentWindow: true });
  activeTab = tabs[0] || null;

  if (!activeTab || typeof activeTab.id !== 'number') {
    renderRestricted('no-tab');
    return;
  }

  // Show the page host under the title.
  try {
    els.pageHost.textContent = new URL(activeTab.url).hostname.replace(/^www\./, '') || 'Detected media';
  } catch {
    els.pageHost.textContent = 'Detected media';
  }

  const url = activeTab.url || '';
  if (RESTRICTED_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    renderRestricted('restricted');
    return;
  }

  await refreshList();

  // Media often arrives right as the popup opens; do one follow-up pass.
  window.setTimeout(() => refreshList({ silent: true }), 600);
}

// The <script> tag sits at the end of <body>, so the DOM is parsed and every
// element above exists, but DOMContentLoaded has NOT fired yet at this point.
// Calling init() here runs it exactly once - do not also listen for the event,
// or the popup would render twice and fire duplicate download requests.
void init();
