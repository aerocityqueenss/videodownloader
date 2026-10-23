/**
 * server.mjs — tiny zero-dependency static server + project-status API.
 *
 *   GET /                 → public/index.html
 *   GET /api/project      → normalised project status (computed stats)
 *   GET /api/health       → liveness probe
 *
 * Run:  npm start        (http://127.0.0.1:4173)
 *       PORT=8080 npm start
 */

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const STATUS_FILE = path.join(__dirname, "project-status.json");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const VALID_STATUS = new Set(["done", "active", "blocked", "todo"]);

/** Read and normalise project-status.json into the shape the companion renders. */
export async function readProjectStatus() {
  let raw;
  try {
    raw = JSON.parse(await readFile(STATUS_FILE, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read project-status.json: ${err.message}`);
  }

  const phases = (raw.phases ?? []).map((phase) => {
    const steps = (phase.steps ?? []).map((s) => ({
      title: String(s.title ?? "Untitled step"),
      detail: s.detail ? String(s.detail) : "",
      status: VALID_STATUS.has(s.status) ? s.status : "todo",
    }));
    const done = steps.filter((s) => s.status === "done").length;
    const status = steps.length && done === steps.length
      ? "done"
      : steps.some((s) => s.status === "active") ? "active"
      : steps.some((s) => s.status === "done") ? "partial" : "todo";
    return { ...phase, steps, done, status };
  });

  const allSteps = phases.flatMap((p) => p.steps);
  const total = allSteps.length;
  const done = allSteps.filter((s) => s.status === "done").length;
  const blocked = allSteps.filter((s) => s.status === "blocked").length;
  const percent = total ? Math.round((done / total) * 100) : 0;

  const activePhase = phases.find((p) => p.status === "active") ?? phases.find((p) => p.status !== "done") ?? null;
  const activeStep = activePhase?.steps.find((s) => s.status === "active")
    ?? activePhase?.steps.find((s) => s.status === "todo")
    ?? null;

  let updatedAt = raw.updatedAt ?? null;
  try { updatedAt = (await stat(STATUS_FILE)).mtime.toISOString(); } catch { /* keep declared value */ }

  return {
    project: {
      name: raw.name ?? "My Project",
      version: raw.version ?? "1.0.0",
      description: raw.description ?? "",
      updatedAt,
    },
    stats: { total, done, blocked, percent },
    current: { phase: activePhase?.title ?? "All done", step: activeStep?.title ?? "Nothing in progress" },
    phases,
    notes: Array.isArray(raw.notes) ? raw.notes : [],
  };
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const resolved = path.normalize(path.join(root, decoded));
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
  return resolved;
}

async function serveStatic(req, res, urlPath) {
  let target = safeJoin(PUBLIC_DIR, urlPath === "/" ? "/index.html" : urlPath);
  if (!target) return sendPlain(res, 403, "Forbidden");

  try {
    let info = await stat(target);
    if (info.isDirectory()) {
      target = path.join(target, "index.html");
      info = await stat(target);
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      "x-content-type-options": "nosniff",
    });
    createReadStream(target).pipe(res);
  } catch {
    sendPlain(res, 404, "Not found");
  }
}

function sendPlain(res, code, text) {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);

    if (url.pathname === "/api/health") return sendJson(res, 200, { ok: true, uptime: process.uptime() });

    if (url.pathname === "/api/project") {
      try {
        return sendJson(res, 200, await readProjectStatus());
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (req.method !== "GET" && req.method !== "HEAD") return sendPlain(res, 405, "Method not allowed");
    return serveStatic(req, res, url.pathname);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`\n  🐣  Labubo is awake!`);
    console.log(`      →  http://${HOST}:${PORT}\n`);
  });
  const shutdown = () => { server.close(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
