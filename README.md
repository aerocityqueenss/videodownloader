# 🐣 Labubo Project Hub

A cute **Labubo** companion that lives in the corner of your app. Click it and it
walks you through **the process of your project** — every phase, every step, what's
done, what's in progress, and what's blocked.

No dependencies. No build step. Just Node.

```bash
npm start
# → http://127.0.0.1:4173
```

Then **click the little labubu in the bottom-right corner.** 🧸

---

## What you get

| Piece | What it does |
|---|---|
| **Cute floating Labubo** | Hand-drawn SVG mascot — big ears, tiny fangs, wiggling ears, blinking eyes, floating idle bob. It reacts to your progress with different moods. |
| **Click → progress panel** | Opens a speech bubble + a full process view: overall %, current phase, and every phase with its steps colour-coded **done / in progress / blocked / up next**. |
| **Live sync** | The panel re-reads your project every 5 seconds — edit the status file and it updates itself, no reload. |
| **Landing page** | Hero, live stat cards, and phase cards. Clicking any phase card also opens Labubo. |
| **Mobile + a11y** | Works at 390px wide, keyboard/Esc to close, `aria-expanded`, `role="dialog"`, and respects `prefers-reduced-motion`. |
| **Dark mode** | 🌙 toggle in the header, remembered in `localStorage`. |

---

## Telling Labubo about your project

Everything Labubo knows comes from **`project-status.json`** in this folder:

```json
{
  "name": "My Project",
  "version": "1.0.0",
  "description": "What the project does.",
  "phases": [
    {
      "title": "Discover",
      "icon": "🔍",
      "summary": "Understand what we're building.",
      "steps": [
        { "title": "Define the goal", "detail": "Optional extra line.", "status": "done" },
        { "title": "Sketch it", "status": "active" }
      ]
    }
  ],
  "notes": ["Anything you want Labubo to mention"]
}
```

**Step statuses**

| status | meaning | looks like |
|---|---|---|
| `done` | finished | green ✓ |
| `active` | currently working on it | orange pulsing ◐ |
| `blocked` | stuck / waiting | red ! |
| `todo` | not started | grey ○ |

Labubo computes everything else for you — per-phase counts, the overall
percentage, the current phase/step, and its own mood:

- **curious** — early days (< 60%)
- **happy** — good progress (≥ 60%)
- **worried** — something is `blocked`
- **celebrate** — 100%, it hops and throws hearts 💕

---

## Using the companion in *your own* app

The companion is three files, fully decoupled. Drop them in and it works:

```
public/labubo.js            ← the SVG mascot (moods, blink, ears)
public/labubo-companion.js  ← the floating button + panel
public/styles.css           ← companion styles (see the "Companion" section)
```

Add the markup from `index.html` (the `<div class="labubo-root">` block), then:

```js
import { createLabuboCompanion } from "./labubo-companion.js";
createLabuboCompanion();
```

It calls `GET /api/project`, which must return this shape (that's what
`server.mjs` builds from `project-status.json`):

```ts
{
  project: { name, version, description, updatedAt },
  stats:   { total, done, blocked, percent },
  current: { phase, step },
  phases:  [{ title, icon, summary, status, done, steps: [{ title, detail, status }] }],
  notes:   string[]
}
```

Console helpers while developing: `window.labubo.open()`, `.close()`, `.refresh()`.

---

## Scripts

```bash
npm start                  # serve on :4173
PORT=8080 npm start        # custom port
node test-companion.mjs    # 33 headless UI assertions (needs playwright-core + Chrome)
node shots.mjs             # write reference screenshots to .shots/
```

The app itself has **zero** runtime dependencies — `playwright-core` is only
used by the two optional scripts above.

---

## Files

```
server.mjs              zero-dep static server + /api/project
project-status.json     ← the one file you edit to drive Labubo
public/
  index.html            landing page + companion markup
  styles.css            all styling, mascot animations, companion panel
  labubo.js             SVG mascot + mood logic + speech lines
  labubo-companion.js   the clickable companion widget
  app.js                theme, stat cards, scroll reveal, bootstrap
  favicon.svg           tiny Labubo face
test-companion.mjs      UI test suite
shots.mjs               screenshot helper
```
