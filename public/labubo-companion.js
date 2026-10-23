/**
 * labubo-companion.js — the clickable "Cute Labubo" companion.
 *
 * mounting       → floating button in the corner (always visible)
 * click          → speech bubble + progress panel with the project's live process
 * refresh        → re-fetches /api/project, so the panel is never stale
 */

import { mountLabubo, moodForProject, linesForProject } from "./labubo.js";

const STATUS_META = {
  done:    { label: "Done",    icon: "✓",  cls: "is-done" },
  active:  { label: "In progress", icon: "◐", cls: "is-active" },
  blocked: { label: "Blocked", icon: "!",  cls: "is-blocked" },
  todo:    { label: "Up next", icon: "○",  cls: "is-todo" },
};

const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/** Animate a number from → to inside an element. */
function countTo(el, to, { suffix = "%", duration = 900, decimals = 0 } = {}) {
  if (!el) return;
  const from = Number(String(el.textContent).replace(/[^\d.]/g, "")) || 0;
  if (from === to) { el.textContent = to.toFixed(decimals) + suffix; return; }
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const v = from + (to - from) * easeOut(t);
    el.textContent = v.toFixed(decimals) + suffix;
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function relTime(iso) {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function escapeHtml(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/**
 * Create and attach the companion. Returns a controller.
 * @param {{autoMount?: boolean}} [opts]
 */
export function createLabuboCompanion({ autoMount = true } = {}) {
  const root = document.getElementById("labuboRoot");
  const btn = document.getElementById("labuboBtn");
  const btnArt = document.getElementById("labuboBtnArt");
  const badge = document.getElementById("labuboBadge");
  const panel = document.getElementById("labuboPanel");
  const backdrop = document.getElementById("labuboBackdrop");
  const body = document.getElementById("labuboBody");
  const speech = document.getElementById("panelSpeechText");
  const sub = document.getElementById("panelSub");
  const avatar = document.getElementById("panelAvatar");
  const closeBtn = document.getElementById("labuboClose");
  const refreshBtn = document.getElementById("labuboRefresh");
  const overallEl = document.getElementById("panelOverall");
  const overallBar = document.getElementById("panelOverallBar");

  if (!root || !btn || !panel) {
    console.warn("[labubo] companion markup not found");
    return null;
  }

  let project = null;
  let open = false;
  let busy = false;
  let speechTimer = 0;
  let pollTimer = 0;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── mascot everywhere it appears ──────────────────────────────────────────
  const heroSlot = document.getElementById("heroMascotSlot");
  const heroMascot = document.getElementById("mascotFloat");
  const aboutMascot = document.getElementById("aboutMascot");
  const brandMark = document.getElementById("brandMark");
  mountLabubo(heroSlot, { mood: "happy", className: "mini" });
  mountLabubo(brandMark, { mood: "happy", className: "mini" });
  mountLabubo(heroMascot, { mood: "curious", className: "big" });
  mountLabubo(aboutMascot, { mood: "happy", className: "medium" });
  mountLabubo(avatar, { mood: "happy", className: "avatar" });
  mountLabubo(btnArt, { mood: "happy", className: "button" });

  // ── open / close ─────────────────────────────────────────────────────────
  function pickLine() {
    const lines = project ? linesForProject(project) : ["Hi! I'm Labubo 🐣"];
    return lines[Math.floor(Math.random() * lines.length)];
  }

  function say(text) {
    if (!speech) return;
    speech.textContent = text;
    speech.parentElement?.classList.remove("pop");
    void speech.parentElement?.offsetWidth;
    speech.parentElement?.classList.add("pop");
    clearTimeout(speechTimer);
    speechTimer = setTimeout(() => { speech.textContent = pickLine(); }, 6000);
  }

  async function openPanel() {
    if (open) { closePanel(); return; }
    open = true;
    panel.hidden = false;
    backdrop.hidden = false;
    requestAnimationFrame(() => {
      panel.classList.add("is-open");
      backdrop.classList.add("is-open");
      btn.classList.add("is-active");
    });
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-label", "Close Cute Labubo panel");
    badge.hidden = true;
    say(pickLine());
    await load({ silent: false });
    panel.querySelector(".panel-body")?.focus?.();
  }

  function closePanel() {
    open = false;
    panel.classList.remove("is-open");
    backdrop.classList.remove("is-open");
    btn.classList.remove("is-active");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Open Cute Labubo, your project companion");
    clearTimeout(speechTimer);
    setTimeout(() => {
      if (!open) { panel.hidden = true; backdrop.hidden = true; }
    }, reduced ? 0 : 260);
  }

  // ── data ─────────────────────────────────────────────────────────────────
  async function fetchProject() {
    const res = await fetch("/api/project", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function load({ silent = true } = {}) {
    if (busy) return;
    busy = true;
    if (!silent) showLoading();
    try {
      project = await fetchProject();
      render(project);
      applyMood(project);
      paintStats(project);
      paintPhases(project);
      const sync = document.getElementById("statSync");
      if (sync) sync.textContent = `synced ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      const hint = document.getElementById("connectHint");
      if (hint) hint.textContent = `🟢 Connected to “${project.project?.name ?? "project"}” — Labubo is live.`;
    } catch (err) {
      console.warn("[labubo] could not load project", err);
      showError(err);
      const hint = document.getElementById("connectHint");
      if (hint) hint.textContent = "🔴 Labubo can't reach the project server. Run `npm start`.";
      if (badge) badge.hidden = false;
    } finally {
      busy = false;
    }
  }

  // ── rendering ────────────────────────────────────────────────────────────
  function showLoading() {
    body.innerHTML = "";
    body.append(el("div", "panel-loading", `
      <div class="loader-dots"><i></i><i></i><i></i></div>
      <span>Labubo is reading your project…</span>`));
  }

  function showError(err) {
    body.innerHTML = "";
    body.append(el("div", "panel-error", `
      <strong>Oops, I lost the thread 🥺</strong>
      <p>${escapeHtml(err.message)}</p>
      <p class="muted">Start the app with <code>npm start</code> and tap refresh.</p>`));
  }

  function render(p) {
    body.innerHTML = "";
    const head = el("div", "panel-headinfo");
    head.innerHTML = `
      <div class="headinfo-main">
        <h4>${escapeHtml(p.project?.name ?? "Your project")}</h4>
        <p>${escapeHtml(p.project?.description ?? "")}</p>
      </div>
      <div class="headinfo-meta">
        <span class="chip phase-chip">📍 ${escapeHtml(p.current?.phase ?? "—")}</span>
        <span class="chip">${escapeHtml(p.current?.step ?? "No active step")}</span>
      </div>`;
    body.append(head);

    const activeTask = document.getElementById("statTask");
    if (activeTask) activeTask.textContent = p.current?.step ?? "Nothing running";
    if (sub) sub.textContent = `${p.project?.name ?? "Project"} · ${p.stats?.done ?? 0}/${p.stats?.total ?? 0} steps`;

    const phasesWrap = el("div", "phase-list");
    for (const phase of p.phases ?? []) {
      const phaseEl = el("section", `phase ${phase.status ?? "todo"}`);
      const done = (phase.steps ?? []).filter((s) => s.status === "done").length;
      const total = (phase.steps ?? []).length;
      const pct = total ? Math.round((done / total) * 100) : 0;

      const phHead = el("header", "phase-head");
      phHead.innerHTML = `
        <span class="phase-icon">${escapeHtml(phase.icon ?? "•")}</span>
        <div class="phase-titles">
          <h5>${escapeHtml(phase.title ?? "Phase")}</h5>
          ${phase.summary ? `<p>${escapeHtml(phase.summary)}</p>` : ""}
        </div>
        <span class="phase-count">${done}/${total}</span>`;
      phaseEl.append(phHead);

      const bar = el("div", "phase-bar");
      bar.innerHTML = `<span style="width:${pct}%"></span>`;
      phaseEl.append(bar);

      const list = el("ul", "step-list");
      for (const step of phase.steps ?? []) {
        const meta = STATUS_META[step.status] ?? STATUS_META.todo;
        const li = el("li", `step ${meta.cls}`);
        li.innerHTML = `
          <span class="step-dot" aria-hidden="true">${meta.icon}</span>
          <span class="step-main">
            <span class="step-title">${escapeHtml(step.title ?? "Step")}</span>
            ${step.detail ? `<span class="step-detail">${escapeHtml(step.detail)}</span>` : ""}
          </span>
          <span class="step-tag">${meta.label}</span>`;
        list.append(li);
      }
      phaseEl.append(list);
      phasesWrap.append(phaseEl);
    }
    body.append(phasesWrap);

    if (p.notes?.length) {
      const notes = el("div", "panel-notes");
      notes.innerHTML = `<h5>📝 Notes ${p.project?.version ? `<span class="chip">v${escapeHtml(p.project.version)}</span>` : ""}</h5>`
        + `<ul>${p.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`;
      body.append(notes);
    }

    countTo(overallEl, p.stats?.percent ?? 0);
    if (overallBar) requestAnimationFrame(() => { overallBar.style.width = `${p.stats?.percent ?? 0}%`; });

    // if the project name/description is very long, keep the header tidy
    const headinfo = body.querySelector(".headinfo-main h4");
    if (headinfo && headinfo.textContent.length > 42) headinfo.classList.add("truncate");
  }

  function applyMood(p) {
    const mood = moodForProject(p);
    const moodLabels = {
      celebrate: "Celebrating! 🎉", happy: "Feeling good 😊", curious: "Curious 👀", worried: "A bit worried 😟",
    };
    if (sub) sub.dataset.mood = mood;
    mountLabubo(heroMascot, { mood, className: "big" });
    mountLabubo(avatar, { mood, className: "avatar" });
    mountLabubo(btnArt, { mood, className: "button" });
    const moodEl = document.getElementById("statMood");
    if (moodEl) moodEl.textContent = moodLabels[mood] ?? "Watching 👀";
  }

  function paintStats(p) {
    const percent = p.stats?.percent ?? 0;
    const done = document.getElementById("statDone");
    const overall = document.getElementById("statOverall");
    const bar = document.getElementById("statOverallBar");
    const phase = document.getElementById("statPhase");
    const updated = document.getElementById("statUpdated");
    countTo(overall, percent);
    if (done) done.textContent = `${p.stats?.done ?? 0}/${p.stats?.total ?? 0}`;
    if (bar) requestAnimationFrame(() => { bar.style.width = `${percent}%`; });
    if (phase) phase.textContent = p.current?.phase ?? "—";
    if (updated) updated.textContent = relTime(p.project?.updatedAt);
    if (btn) btn.style.setProperty("--progress", `${percent}%`);
    document.title = `${percent}% · ${p.project?.name ?? "Project"} — Labubo`;
  }

  function paintPhases(p) {
    const grid = document.getElementById("phaseGrid");
    if (!grid) return;
    grid.innerHTML = "";
    (p.phases ?? []).forEach((phase, i) => {
      const total = (phase.steps ?? []).length;
      const done = (phase.steps ?? []).filter((s) => s.status === "done").length;
      const active = (phase.steps ?? []).find((s) => s.status === "active");
      const pct = total ? Math.round((done / total) * 100) : 0;
      const card = el("article", `phase-card ${phase.status ?? "todo"}`);
      card.style.animationDelay = `${i * 70}ms`;
      card.innerHTML = `
        <div class="phase-card-top">
          <span class="phase-card-icon">${escapeHtml(phase.icon ?? "•")}</span>
          <span class="phase-card-badge">${done}/${total}</span>
        </div>
        <h3>${escapeHtml(phase.title ?? "Phase")}</h3>
        <p>${escapeHtml(phase.summary ?? "")}</p>
        <div class="mini-bar"><span style="width:${pct}%"></span></div>
        <p class="phase-card-now">${active ? `▶ Now: ${escapeHtml(active.title)}` : phase.status === "done" ? "✓ Complete" : "⏳ Waiting"}</p>`;
      card.addEventListener("click", () => { if (!open) openPanel(); });
      grid.append(card);
    });
  }

  // ── wiring ───────────────────────────────────────────────────────────────
  btn.addEventListener("click", openPanel);
  closeBtn?.addEventListener("click", closePanel);
  backdrop?.addEventListener("click", closePanel);
  refreshBtn?.addEventListener("click", async () => {
    refreshBtn.classList.add("spinning");
    await load({ silent: false });
    refreshBtn.classList.remove("spinning");
    say("Fresh as a daisy! 🌼");
  });
  document.getElementById("openCompanionTop")?.addEventListener("click", () => { if (!open) openPanel(); });
  document.getElementById("openCompanionHero")?.addEventListener("click", () => { if (!open) openPanel(); });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) closePanel();
  });

  // gentle mascot reacts to the cursor on the hero
  if (!reduced) {
    const stage = document.getElementById("heroStage");
    stage?.addEventListener("pointermove", (e) => {
      const r = stage.getBoundingClientRect();
      const dx = (e.clientX - r.left - r.width / 2) / r.width;
      const dy = (e.clientY - r.top - r.height / 2) / r.height;
      heroMascot?.style.setProperty("--look-x", `${dx * 14}px`);
      heroMascot?.style.setProperty("--look-y", `${dy * 10}px`);
    });
  }

  if (autoMount) {
    load({ silent: false });
    // keep the companion in sync while the app is open
    pollTimer = setInterval(() => { if (!document.hidden) load({ silent: true }); }, 5000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && !busy) load({ silent: true }); });
  }

  return {
    open: openPanel,
    close: closePanel,
    refresh: () => load({ silent: false }),
    isOpen: () => open,
    destroy() { clearInterval(pollTimer); closePanel(); },
  };
}
