/**
 * app.js — page bootstrap: theme, hero mascot, stats, phase cards, companion.
 */
import { createLabuboCompanion } from "./labubo-companion.js";

// ── theme ──────────────────────────────────────────────────────────────────
const themeBtn = document.getElementById("themeToggle");
const saved = localStorage.getItem("labubo-theme");
if (saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
  document.documentElement.dataset.theme = "dark";
}
if (themeBtn) {
  themeBtn.textContent = document.documentElement.dataset.theme === "dark" ? "☀️" : "🌙";
  themeBtn.addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme === "dark";
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    localStorage.setItem("labubo-theme", dark ? "light" : "dark");
    themeBtn.textContent = dark ? "🌙" : "☀️";
  });
}

// ── companion ──────────────────────────────────────────────────────────────
const companion = createLabuboCompanion();

// expose for the console (handy while hacking on the project)
window.labubo = companion;

// reveal-on-scroll for the phase cards / sections
const io = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      entry.target.classList.add("is-visible");
      io.unobserve(entry.target);
    }
  }
}, { threshold: 0.12 });
document.querySelectorAll(".phase-card, .stat-card, .about-card").forEach((n, i) => {
  n.style.transitionDelay = `${Math.min(i * 45, 240)}ms`;
  io.observe(n);
});
