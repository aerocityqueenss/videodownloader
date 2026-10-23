/**
 * labubo.js — the Cute Labubo mascot.
 *
 * A hand-drawn SVG labubu-style creature that can be reused anywhere in the app.
 * It is injected as innerHTML so CSS can animate each part (ears, eyes, bubble).
 */

const SVG_PARTS = `
  <defs>
    <radialGradient id="lb-body" cx="42%" cy="30%" r="78%">
      <stop offset="0%" stop-color="#FFF6E9"/>
      <stop offset="55%" stop-color="#FDE6C8"/>
      <stop offset="100%" stop-color="#F2C79B"/>
    </radialGradient>
    <radialGradient id="lb-belly" cx="50%" cy="38%" r="70%">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#FBE9D2"/>
    </radialGradient>
    <linearGradient id="lb-ear" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#F8D9B6"/>
      <stop offset="100%" stop-color="#EFC093"/>
    </linearGradient>
    <radialGradient id="lb-eye" cx="38%" cy="32%" r="72%">
      <stop offset="0%" stop-color="#5B3A2E"/>
      <stop offset="60%" stop-color="#38211B"/>
      <stop offset="100%" stop-color="#23120F"/>
    </radialGradient>
    <radialGradient id="lb-cheek" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#FF9FB5" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#FF9FB5" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="lb-scarf" cx="30%" cy="20%" r="90%">
      <stop offset="0%" stop-color="#FF8FB4"/>
      <stop offset="100%" stop-color="#E85E8F"/>
    </radialGradient>
    <filter id="lb-soft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="1.6"/>
    </filter>
  </defs>

  <!-- ground shadow -->
  <ellipse class="lb-ground" cx="100" cy="196" rx="46" ry="8" fill="#8A5A3B" opacity="0.16"/>

  <g class="lb-figure">
    <!-- ears -->
    <g class="lb-ear lb-ear-l">
      <path d="M58 60 C40 30 44 10 60 8 C78 6 86 32 82 56 Z"
            fill="url(#lb-ear)" stroke="#D9A472" stroke-width="2.2" stroke-linejoin="round"/>
      <path d="M63 52 C54 32 57 20 64 18 C73 17 76 34 73 50 Z" fill="#FFB9C7" opacity="0.85"/>
    </g>
    <g class="lb-ear lb-ear-r">
      <path d="M142 60 C160 30 156 10 140 8 C122 6 114 32 118 56 Z"
            fill="url(#lb-ear)" stroke="#D9A472" stroke-width="2.2" stroke-linejoin="round"/>
      <path d="M137 52 C146 32 143 20 136 18 C127 17 124 34 127 50 Z" fill="#FFB9C7" opacity="0.85"/>
    </g>

    <!-- body -->
    <path class="lb-body"
          d="M100 34 C138 34 162 66 162 112 C162 158 138 186 100 186 C62 186 38 158 38 112 C38 66 62 34 100 34 Z"
          fill="url(#lb-body)" stroke="#D9A472" stroke-width="2.4"/>
    <path class="lb-belly" d="M100 118 C124 118 138 138 138 162 C138 178 122 186 100 186 C78 186 62 178 62 162 C62 138 76 118 100 118 Z"
          fill="url(#lb-belly)"/>

    <!-- hair tuft -->
    <path class="lb-tuft" d="M92 36 C94 24 100 18 106 22 C112 26 110 36 106 40"
          fill="none" stroke="#D9A472" stroke-width="2.6" stroke-linecap="round"/>

    <!-- cheeks -->
    <ellipse cx="66" cy="126" rx="15" ry="11" fill="url(#lb-cheek)"/>
    <ellipse cx="134" cy="126" rx="15" ry="11" fill="url(#lb-cheek)"/>

    <!-- eyes -->
    <g class="lb-eye lb-eye-l">
      <ellipse cx="76" cy="106" rx="15.5" ry="17.5" fill="url(#lb-eye)"/>
      <circle cx="71" cy="99" r="5.2" fill="#FFFFFF" opacity="0.95"/>
      <circle cx="82" cy="114" r="2.3" fill="#FFFFFF" opacity="0.7"/>
    </g>
    <g class="lb-eye lb-eye-r">
      <ellipse cx="124" cy="106" rx="15.5" ry="17.5" fill="url(#lb-eye)"/>
      <circle cx="119" cy="99" r="5.2" fill="#FFFFFF" opacity="0.95"/>
      <circle cx="130" cy="114" r="2.3" fill="#FFFFFF" opacity="0.7"/>
    </g>

    <!-- little brows -->
    <path class="lb-brow lb-brow-l" d="M63 84 Q76 77 89 83" fill="none" stroke="#C98F5C"
          stroke-width="2.6" stroke-linecap="round" opacity="0.75"/>
    <path class="lb-brow lb-brow-r" d="M111 83 Q124 77 137 84" fill="none" stroke="#C98F5C"
          stroke-width="2.6" stroke-linecap="round" opacity="0.75"/>

    <!-- snout + mouth -->
    <path class="lb-mouth" d="M100 132 q-10 8 -17 1 q7 -7 17 -1 q10 -6 17 1 q-7 7 -17 -1 Z"
          fill="#E86A88" stroke="#C94A6B" stroke-width="1.4"/>
    <!-- fangs -->
    <path class="lb-fang lb-fang-l" d="M88 134 l4 9 l4 -9 Z" fill="#FFFFFF" stroke="#E4CDB6" stroke-width="1"/>
    <path class="lb-fang lb-fang-r" d="M108 134 l4 9 l4 -9 Z" fill="#FFFFFF" stroke="#E4CDB6" stroke-width="1"/>

    <!-- scarf -->
    <g class="lb-scarf-g">
      <path d="M56 150 C76 166 124 166 144 150 C150 160 146 172 138 176 C118 188 82 188 62 176 C54 172 50 160 56 150 Z"
            fill="url(#lb-scarf)"/>
      <path d="M138 174 C150 176 158 186 162 198 C158 200 148 196 142 188 Z" fill="#E85E8F"/>
      <circle cx="100" cy="164" r="6" fill="#FFD3E0"/>
      <circle cx="100" cy="164" r="3" fill="#FFF3F7"/>
    </g>

    <!-- arms -->
    <g class="lb-arm lb-arm-l">
      <ellipse cx="38" cy="150" rx="11" ry="15" fill="#F9DCBB" stroke="#D9A472" stroke-width="2.2" transform="rotate(-18 38 150)"/>
    </g>
    <g class="lb-arm lb-arm-r">
      <ellipse cx="162" cy="150" rx="11" ry="15" fill="#F9DCBB" stroke="#D9A472" stroke-width="2.2" transform="rotate(18 162 150)"/>
    </g>

    <!-- feet -->
    <ellipse cx="76" cy="188" rx="16" ry="8" fill="#F2C79B" stroke="#D9A472" stroke-width="2"/>
    <ellipse cx="124" cy="188" rx="16" ry="8" fill="#F2C79B" stroke="#D9A472" stroke-width="2"/>
  </g>
`;

const HEARTS = `
  <g class="lb-hearts" aria-hidden="true">
    <text class="lb-heart h1" x="150" y="40">♥</text>
    <text class="lb-heart h2" x="34" y="52">♥</text>
    <text class="lb-heart h3" x="160" y="86">♥</text>
  </g>
`;

/**
 * Build a Labubo SVG string.
 * @param {{mood?: string, className?: string, title?: string}} [opts]
 * @returns {string} SVG markup
 */
export function labuboSvg({ mood = "happy", className = "", title = "Cute Labubo" } = {}) {
  return `
<svg class="labubo-svg mood-${mood} ${className}" viewBox="0 0 200 210"
     role="img" aria-label="${title}" xmlns="http://www.w3.org/2000/svg">
  <title>${title}</title>
  ${SVG_PARTS}
  ${mood === "celebrate" ? HEARTS : ""}
</svg>`.trim();
}

/**
 * Replace a container's contents with a Labubo.
 * @param {Element | null} el
 * @param {{mood?: string, className?: string}} [opts]
 */
export function mountLabubo(el, opts = {}) {
  if (!el) return;
  el.innerHTML = labuboSvg(opts);
  const svg = el.querySelector("svg");
  if (svg) svg.removeAttribute("role");
  return svg;
}

/** Pick a mood from the project progress data. */
export function moodForProject(project) {
  const p = project?.stats?.percent ?? 0;
  if (project?.stats?.total === 0) return "curious";
  if (p >= 100) return "celebrate";
  if (project?.phases?.some((ph) => ph.steps?.some((s) => s.status === "blocked"))) return "worried";
  if (p >= 60) return "happy";
  return "curious";
}

/** Floating speech lines — served fresh each open. */
export function linesForProject(project) {
  const name = project?.project?.name ?? "your project";
  const pct = project?.stats?.percent ?? 0;
  const active = project?.phases
    ?.flatMap((ph) => (ph.steps || []).filter((s) => s.status === "active")
      .map((s) => ({ phase: ph.title, step: s.title })))
    ?.[0];

  const lines = [];
  if (pct >= 100) {
    lines.push(`All done! ${name} is live in my heart 💕`);
    lines.push("Every single step finished. Can I do a happy dance?");
  } else if (active) {
    lines.push(`Right now we're on "${active.step}" in ${active.phase}!`);
    lines.push(`${pct}% complete — not bad for a little labubu 🐣`);
    lines.push("Tap me any time to see the whole build story.");
  } else if (pct === 0) {
    lines.push(`Let's begin! ${name} is waiting for its first step.`);
    lines.push("Add a step to my status file and I'll track it.");
  } else {
    lines.push(`${name} is ${pct}% done. I'm keeping an eye on it!`);
    lines.push("Click me to peek at your project's process.");
  }
  if (project?.phases?.some((ph) => ph.steps?.some((s) => s.status === "blocked"))) {
    lines.unshift("Uh oh — something's blocked. Let's fix it together! 😟");
  }
  return lines;
}
