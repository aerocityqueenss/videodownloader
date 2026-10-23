/**
 * MediaPulse Downloader — content script
 * -----------------------------------------------------------------
 * Finds media that is only discoverable from inside the page, because the
 * network layer never sees a plain URL for it:
 *
 *   - <video>/<source>/<audio> elements (including infinite-scroll feeds and
 *     players that mount long after load)
 *   - lazy attributes on those elements (data-src, data-src-hd, ...)
 *   - Open Graph / Twitter meta tags and JSON-LD VideoObject blocks
 *   - same-origin <a href="...mp4"> download links
 *   - blob: URLs - the actual bytes are then recovered by a MAIN-world probe
 *     (see MAIN_WORLD_PROBE below)
 *
 * Everything found is forwarded to the background worker, which merges it
 * with its network observations. This script never downloads anything and
 * deliberately does not try to defeat site protections: it only reports URLs
 * the page itself is already able to fetch.
 */

'use strict';

(() => {
  /**
   * Guard against double injection. Chrome injects this script once per
   * document, but the popup may also ask the background to inject it as a
   * fallback on pages loaded before the extension was installed.
   */
  if (window.__mediaPulseContentLoaded) return;
  window.__mediaPulseContentLoaded = true;

  const MSG_ADD_MEDIA = 'MP_ADD_MEDIA';
  const MSG_DOWNLOAD = 'MP_DOWNLOAD';

  /** Extensions we accept from DOM attributes (network layer handles the rest). */
  const MEDIA_RE = /\.(mp4|m4v|webm|mkv|mov|flv|ogv|ogg|m3u8|m3u|mpd)(\?|#|$)/i;

  /** Attributes that may hold a media URL, best first. */
  const SRC_ATTRS = [
    'src',
    'data-src',
    'data-url',
    'data-video',
    'data-video-src',
    'data-source',
    'data-src-hd',
    'data-hd',
    'data-mp4',
    'data-stream',
    'data-playlist',
    'data-m3u8',
    'data-hls',
    'data-file'
  ];

  /** Container attributes that commonly hold a player manifest URL. */
  const CONTAINER_ATTRS = ['data-video-url', 'data-m3u8', 'data-hls', 'data-playlist-url', 'data-hls-url', 'data-manifest'];

  /** Debounce window for DOM -> background flushes, in ms. */
  const FLUSH_DEBOUNCE_MS = 300;

  /** Pending observations keyed by URL; flushed together to reduce IPC. */
  const pending = new Map();
  let flushTimer = null;

  /** URLs already sent, so we do not re-scan the same video every mutation. */
  const sent = new Set();

  /* ========================================================================
   * URL helpers
   * ======================================================================*/

  /** Resolve relative URLs and return an http(s) href, or null. */
  function toHttpUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const value = raw.trim();
    // Ignore data:, javascript:, and empty placeholders.
    if (!value || /^(javascript|data|mailto|tel):/i.test(value)) return null;

    try {
      const url = new URL(value, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  }

  /** Lowercased extension of a URL. */
  function extensionOf(href) {
    try {
      const name = new URL(href).pathname.split('/').pop() || '';
      const dot = name.lastIndexOf('.');
      return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
    } catch {
      return '';
    }
  }

  /** Map an extension to the kind understood by the background worker. */
  function kindOf(ext) {
    if (ext === 'm3u8' || ext === 'm3u' || ext === 'mpd') return 'hls';
    if (ext === 'ts' || ext === 'm4s') return 'segment';
    return 'video';
  }

  /** Best-effort human title for an entry. */
  function titleFor(el, fallbackUrl) {
    const candidates = [
      el?.getAttribute?.('title'),
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('data-title'),
      document.querySelector('meta[property="og:title"]')?.content,
      document.title
    ];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim().length > 0) return value.trim().slice(0, 200);
    }
    try {
      return decodeURIComponent(new URL(fallbackUrl).pathname.split('/').pop() || 'media');
    } catch {
      return 'media';
    }
  }

  /* ========================================================================
   * Reporting
   * ======================================================================*/

  /** Queue one observation; repeated URLs are ignored. */
  function report(url, { kind, ext, source, title } = {}) {
    const href = toHttpUrl(url);
    if (!href) return;

    const finalExt = ext || extensionOf(href);
    const key = href;

    if (sent.has(key) || pending.has(key)) return;

    pending.set(key, {
      url: href,
      ext: finalExt,
      kind: kind || kindOf(finalExt),
      source: source || 'dom',
      title
    });

    scheduleFlush();
  }

  /** Report without deduplication (used when the same URL gains a better title). */
  function reportTitle(url, title) {
    const href = toHttpUrl(url);
    if (!href || !title) return;
    if (pending.has(href)) {
      pending.get(href).title = title;
      return;
    }
    if (!sent.has(href)) return; // nothing to update yet
    pending.set(`${href}#title`, { url: href, title, source: 'dom', ext: extensionOf(href), kind: kindOf(extensionOf(href)) });
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer !== null) return;
    flushTimer = window.setTimeout(flush, FLUSH_DEBOUNCE_MS);
  }

  /** Send everything queued in a single message. */
  function flush() {
    flushTimer = null;
    if (pending.size === 0) return;

    const items = Array.from(pending.values());
    pending.clear();
    for (const item of items) {
      sent.add(item.url);
      sent.delete(`${item.url}#title`);
    }

    try {
      chrome.runtime.sendMessage(
        { type: MSG_ADD_MEDIA, items, pageUrl: location.href },
        () => {
          // Reading lastError marks the message as handled; if the service
          // worker was reloading we simply retry the URLs on the next scan.
          if (chrome.runtime.lastError) {
            for (const item of items) sent.delete(item.url);
          }
        }
      );
    } catch {
      for (const item of items) sent.delete(item.url);
    }
  }

  /* ========================================================================
   * DOM scanning
   * ======================================================================*/

  /** Inspect one <video>/<audio>/<source> element for usable URLs. */
  function scanMediaElement(el) {
    const title = titleFor(el, el.currentSrc || el.src || location.href);

    // 1) The currently playing source is the most accurate signal.
    if (el.currentSrc) report(el.currentSrc, { source: 'dom', title });

    // 2) Explicit src plus a long tail of lazy-loading attributes.
    for (const attr of SRC_ATTRS) {
      const value = el.getAttribute?.(attr);
      if (value) report(value, { source: 'dom', title });
    }

    // 3) srcset-style attributes on the element itself.
    const srcset = el.getAttribute?.('srcset');
    if (srcset) parseSrcset(srcset).forEach((url) => report(url, { source: 'dom', title }));

    // 4) Nested <source> children.
    el.querySelectorAll?.('source').forEach((source) => {
      const src = source.getAttribute('src') || source.getAttribute('data-src');
      if (src) report(src, { source: 'dom', title });
      // A <source> without src contributes nothing; its MIME type alone tells
      // us nothing actionable, so we rely on the network layer for it.
    });

    // 5) blob: URLs cannot be downloaded directly - the player built them from
    //    the fragments it fetched. Those fragments are already captured by the
    //    network layer, so there is nothing to report for this element.
    const sources = [el.currentSrc, el.src].filter(Boolean);
    for (const src of sources) {
      if (src.startsWith('blob:')) noteBlobUrl(el);
    }
  }

  /** Split a srcset value into URL candidates. */
  function parseSrcset(value) {
    return String(value)
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  /**
   * Blob URL handling (deliberately a no-op beyond bookkeeping).
   *
   * A `blob:` URL (what MSE/hls.js players attach to <video>) cannot be
   * downloaded directly - it only exists for the lifetime of the page. The
   * real bytes are the fragments the player fetched from the network, which the
   * background worker already captures and folds into the playlist row.
   *
   * We intentionally do NOT read the MediaSource from the main world: that
   * would require injecting into page context to work around site protections.
   */
  const seenBlobs = new WeakSet();

  function noteBlobUrl(el) {
    // Remember the element so repeated scans stay cheap.
    seenBlobs.add(el);
  }

  /** Scan a whole subtree (or the document) for media elements. */
  function scanRoot(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;

    // The root itself may be a video element.
    if (root.nodeType === Node.ELEMENT_NODE && /^(VIDEO|AUDIO|SOURCE)$/i.test(root.tagName)) {
      scanMediaElement(root);
    }

    root.querySelectorAll?.('video, audio, source').forEach(scanMediaElement);

    // Anchors that point straight at a media file.
    root.querySelectorAll?.('a[href]').forEach((anchor) => {
      const href = anchor.getAttribute('href');
      if (href && MEDIA_RE.test(href)) {
        report(href, { source: 'dom', title: anchor.textContent?.trim() || undefined });
      }
    });

    // Players often keep the manifest in an attribute on a container. We look
    // at every element that carries one of the known attributes rather than
    // hard-coding per-library selector lists.
    root.querySelectorAll?.(CONTAINER_ATTRS.map((attr) => `[${attr}]`).join(',')).forEach((node) => {
      for (const attr of CONTAINER_ATTRS) {
        const value = node.getAttribute(attr);
        if (value) report(value, { source: 'dom' });
      }
    });
  }

  /* ========================================================================
   * Metadata sources
   * ======================================================================*/

  /**
   * Open Graph and Twitter card video URLs.
   *
   * We match only on the attribute suffix rather than on exact, quoted values.
   * That keeps the selector simple and predictable for any engine/mock, and it
   * also catches RDFa variants such as `property="og:video:secure_url"`.
   */
  const META_SELECTOR = 'meta[property$="video"], meta[property$="video:url"], meta[property$="video:secure_url"], meta[name$="player:stream"]';

  function scanMetaTags() {
    document.querySelectorAll(META_SELECTOR).forEach((meta) => {
      const content = meta.getAttribute('content');
      if (content) report(content, { source: 'dom', title: document.title });
    });
  }

  /** JSON-LD VideoObject / contentUrl blocks. */
  function scanJsonLd() {
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      const text = script.textContent;
      if (!text || text.length > 500000) return; // skip pathological payloads

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }

      const stack = [data];
      let guard = 0;

      while (stack.length > 0 && guard < 5000) {
        guard += 1;
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;

        for (const [key, value] of Object.entries(node)) {
          if (typeof value === 'string') {
            if (key === 'contentUrl' || key === 'embedUrl' || key === 'url') {
              if (MEDIA_RE.test(value)) report(value, { source: 'dom', title: node.name });
            }
          } else if (value && typeof value === 'object') {
            stack.push(value);
          }
        }
      }
    });
  }

  /* ========================================================================
   * MutationObserver
   * ======================================================================*/

  /**
   * Watch for videos that appear after load: infinite scroll, SPAs swapping
   * <video> elements, and players that set `src` lazily. We batch mutations
   * per animation frame so a heavy page cannot starve the main thread.
   */
  let mutationScheduled = false;

  function onMutations(mutations) {
    if (mutationScheduled) return;
    mutationScheduled = true;

    window.requestAnimationFrame(() => {
      mutationScheduled = false;

      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          const target = mutation.target;
          if (target && /^(VIDEO|AUDIO|SOURCE)$/i.test(target.tagName)) {
            scanMediaElement(target);
            if (target.tagName === 'VIDEO') {
              const src = target.currentSrc || target.src;
              if (src && MEDIA_RE.test(src)) reportTitle(src, titleFor(target, src));
            }
          } else if (target && target.getAttribute) {
            const value = target.getAttribute(mutation.attributeName);
            if (value && MEDIA_RE.test(value)) report(value, { source: 'dom' });
          }
          continue;
        }

        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) scanRoot(node);
        }
      }

      // Newly added players may start playing immediately, so hook them now
      // rather than waiting for the next scheduled rescan.
      attachVideoListeners();
      flush();
    });
  }

  const observer = new MutationObserver(onMutations);

  function startObserver() {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [...SRC_ATTRS, 'srcset', 'poster']
    });
  }

  /* ========================================================================
   * Video event hooks
   * ======================================================================*/

  /**
   * A newly playing video may reveal its src only after `loadedmetadata`.
   *
   * This single handler covers every playback path (click, autoplay, a
   * player swapping sources mid-stream): we re-scan the element rather than
   * only reading `currentSrc`, because a click often also populates lazy
   * attributes (`data-hls`, `data-src`, ...) that were empty until then.
   */
  function attachVideoListeners() {
    if (typeof document.querySelectorAll !== 'function') return;

    const videos = document.querySelectorAll('video');
    if (!videos || typeof videos.forEach !== 'function') return;

    videos.forEach((video) => {
      if (!video || video.__mediaPulseHooked) return;
      video.__mediaPulseHooked = true;

      const onPlay = () => {
        try {
          scanMediaElement(video);
          const src = video.currentSrc || video.src;
          if (src) report(src, { source: 'media', title: titleFor(video, src) });
        } catch {
          /* A detached or exotic element must never break the listener. */
        }
      };

      video.addEventListener?.('loadedmetadata', onPlay, { passive: true });
      video.addEventListener?.('play', onPlay, { passive: true });
      video.addEventListener?.('loadstart', onPlay, { passive: true });
    });
  }

  /* ========================================================================
   * Boot
   * ======================================================================*/

  function initialScan() {
    scanRoot(document);
    scanMetaTags();
    scanJsonLd();
    attachVideoListeners();
    flush();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialScan, { once: true });
  } else {
    initialScan();
  }

  startObserver();

  // The popup can ask for an immediate rescan (e.g. after the user pressed
  // "Refresh" in the UI, which is much faster than reloading the page).
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'MP_RESCAN') {
      sent.clear();
      initialScan();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // Late-loading players: retry a few times with increasing delays, then stop.
  [1000, 3000, 8000].forEach((delay) => {
    window.setTimeout(() => {
      attachVideoListeners();
      scanRoot(document);
      scanMetaTags();
      flush();
    }, delay);
  });
})();
