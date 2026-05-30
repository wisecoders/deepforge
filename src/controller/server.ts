/**
 * Deepforge Controller API
 *
 * Lightweight HTTP server that:
 * 1. Accepts GitHub / Azure DevOps repo URLs with auth (PAT or Service Principal)
 * 2. Clones the repo, indexes it, generates wiki documentation
 * 3. Persists wiki to PVC and exposes it at a stable subdomain URL
 * 4. Supports resync (re-clone + regenerate) to pick up repo changes
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execSync, spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const WIKIS_DIR = join(DATA_DIR, "wikis");
const REPOS_DIR = join(DATA_DIR, "repos");
const JOBS_FILE = join(DATA_DIR, "jobs.json");
const BASE_DOMAIN = process.env.BASE_DOMAIN ?? "deepforge.local";
const CONTROLLER_URL = process.env.CONTROLLER_URL ?? `https://api.${BASE_DOMAIN}`;

mkdirSync(WIKIS_DIR, { recursive: true });
mkdirSync(REPOS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AuthMethod = "none" | "pat" | "service_principal";

interface WikiJob {
  id: string;
  repoUrl: string;
  slug: string;
  status: "cloning" | "indexing" | "generating" | "ready" | "failed";
  authMethod: AuthMethod;
  createdAt: string;
  lastSyncedAt?: string;
  error?: string;
  wikiUrl?: string;
  pages?: number;
}

// Auth credentials are stored separately — never returned in API responses
interface StoredAuth {
  slug: string;
  method: AuthMethod;
  pat?: string;
  servicePrincipal?: { tenantId: string; clientId: string; clientSecret: string };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const AUTH_FILE = join(DATA_DIR, "auth.json");

function loadJobs(): WikiJob[] {
  if (!existsSync(JOBS_FILE)) return [];
  return JSON.parse(readFileSync(JOBS_FILE, "utf-8"));
}

function saveJobs(jobs: WikiJob[]): void {
  writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function getJob(idOrSlug: string): WikiJob | undefined {
  return loadJobs().find((j) => j.id === idOrSlug || j.slug === idOrSlug);
}

function upsertJob(job: WikiJob): void {
  const jobs = loadJobs();
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) {
    jobs[idx] = job;
  } else {
    jobs.push(job);
  }
  saveJobs(jobs);
}

function updateJob(id: string, update: Partial<WikiJob>): void {
  const jobs = loadJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx >= 0) {
    jobs[idx] = { ...jobs[idx], ...update };
    saveJobs(jobs);
  }
}

function loadAuthStore(): StoredAuth[] {
  if (!existsSync(AUTH_FILE)) return [];
  return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
}

function saveAuth(auth: StoredAuth): void {
  const store = loadAuthStore();
  const idx = store.findIndex((a) => a.slug === auth.slug);
  if (idx >= 0) store[idx] = auth;
  else store.push(auth);
  writeFileSync(AUTH_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function getAuth(slug: string): StoredAuth | undefined {
  return loadAuthStore().find((a) => a.slug === slug);
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

interface CloneOptions {
  repoUrl: string;
  targetDir: string;
  pat?: string;
  servicePrincipal?: { tenantId: string; clientId: string; clientSecret: string };
}

function buildAuthUrl(opts: CloneOptions): string {
  const url = new URL(opts.repoUrl);
  if (opts.pat) {
    url.username = opts.pat;
    url.password = "";
    return url.toString();
  }
  if (opts.servicePrincipal) {
    url.username = opts.servicePrincipal.clientId;
    url.password = opts.servicePrincipal.clientSecret;
    return url.toString();
  }
  return opts.repoUrl;
}

function cloneRepo(opts: CloneOptions): void {
  const authUrl = buildAuthUrl(opts);
  // Clean target if it exists (resync case)
  if (existsSync(opts.targetDir)) {
    rmSync(opts.targetDir, { recursive: true, force: true });
  }
  execSync(`git clone --depth 1 "${authUrl}" "${opts.targetDir}"`, {
    stdio: "pipe",
    timeout: 300_000,
  });
}

function repoSlug(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    const parts = url.pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean)
      .filter((p) => p !== "_git");
    return parts.join("-").toLowerCase().replace(/[^a-z0-9-]/g, "");
  } catch {
    return randomBytes(4).toString("hex");
  }
}

// ---------------------------------------------------------------------------
// Wiki generation
// ---------------------------------------------------------------------------

async function runGeneration(job: WikiJob): Promise<void> {
  const repoDir = join(REPOS_DIR, job.slug);
  const wikiDir = join(WIKIS_DIR, job.slug);
  const auth = getAuth(job.slug);

  try {
    // Clone
    updateJob(job.id, { status: "cloning" });
    cloneRepo({
      repoUrl: job.repoUrl,
      targetDir: repoDir,
      pat: auth?.pat,
      servicePrincipal: auth?.servicePrincipal,
    });

    // Generate
    updateJob(job.id, { status: "indexing" });

    const child = spawn(
      "node",
      [
        resolve("dist/cli/index.js"),
        "generate",
        repoDir,
        "--output",
        wikiDir,
        "--concurrency",
        "2",
      ],
      { env: { ...process.env }, stdio: "pipe" },
    );

    let lastLine = "";
    child.stdout.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) lastLine = line;
      if (line.includes("Generating")) {
        updateJob(job.id, { status: "generating" });
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      console.error(`[${job.slug}] ${data.toString().trim()}`);
    });

    await new Promise<void>((resolveP, reject) => {
      child.on("close", (code) => {
        if (code === 0) resolveP();
        else reject(new Error(`Generation failed (exit ${code}): ${lastLine}`));
      });
      child.on("error", reject);
    });

    // Inject resync metadata into the generated wiki
    injectWikiMeta(wikiDir, job);

    const pages = readdirSync(wikiDir).filter((f) => f.endsWith(".md")).length;
    const wikiUrl = `https://${job.slug}.${BASE_DOMAIN}`;
    const lastSyncedAt = new Date().toISOString();

    updateJob(job.id, { status: "ready", wikiUrl, pages, lastSyncedAt });
    console.log(`[${job.slug}] Wiki ready: ${pages} pages at ${wikiUrl}`);
  } catch (err: any) {
    updateJob(job.id, { status: "failed", error: err.message });
    console.error(`[${job.slug}] Failed: ${err.message}`);
  }
}

/**
 * Inject a metadata JSON file and patch the docsify index.html
 * to show "Last synced" timestamp and a Resync button.
 */
function injectWikiMeta(wikiDir: string, job: WikiJob): void {
  const now = new Date().toISOString();
  const resyncUrl = `${CONTROLLER_URL}/?repo=${encodeURIComponent(job.repoUrl)}`;

  // Write metadata file for the wiki frontend to read
  writeFileSync(
    join(wikiDir, "_deepforge_meta.json"),
    JSON.stringify({
      repoUrl: job.repoUrl,
      slug: job.slug,
      generatedAt: now,
      resyncUrl,
      controllerUrl: CONTROLLER_URL,
    }),
  );

  // Patch index.html to add the resync banner
  const htmlPath = join(wikiDir, "index.html");
  if (existsSync(htmlPath)) {
    let html = readFileSync(htmlPath, "utf-8");

    // Inject CSS + JS for the top-right banner before </head>
    const bannerAssets = `
  <style>
    #deepforge-banner {
      position: fixed;
      top: 0;
      right: 0;
      z-index: 9999;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px;
      color: #666;
      background: rgba(255,255,255,0.95);
      border-bottom-left-radius: 8px;
      box-shadow: -2px 2px 8px rgba(0,0,0,0.1);
    }
    #deepforge-banner .sync-time { opacity: 0.7; }
    #deepforge-banner .resync-btn {
      padding: 4px 12px;
      background: #3F51B5;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      text-decoration: none;
    }
    #deepforge-banner .resync-btn:hover { background: #303F9F; }
  </style>`;

    const bannerScript = `
  <script>
    // Load deepforge metadata and render banner
    fetch('_deepforge_meta.json').then(r => r.json()).then(meta => {
      const banner = document.createElement('div');
      banner.id = 'deepforge-banner';
      const date = new Date(meta.generatedAt);
      const timeStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
      banner.innerHTML =
        '<span class="sync-time">Last synced: ' + timeStr + '</span>' +
        '<a class="resync-btn" href="' + meta.resyncUrl + '" title="Re-generate wiki from latest source">&#x21bb; Resync</a>';
      document.body.appendChild(banner);
    }).catch(() => {});
  </script>`;

    html = html.replace("</head>", bannerAssets + "\n</head>");
    html = html.replace("</body>", bannerScript + "\n</body>");
    writeFileSync(htmlPath, html);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function isValidRepoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      (parsed.hostname.includes("github.com") ||
        parsed.hostname.includes("dev.azure.com") ||
        parsed.hostname.includes("visualstudio.com") ||
        parsed.hostname.includes("gitlab.com") ||
        parsed.hostname.includes("bitbucket.org"))
    );
  } catch {
    return false;
  }
}

/** Sanitize job for API response — never expose auth details. */
function publicJob(job: WikiJob): Omit<WikiJob, never> {
  return { ...job };
}

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

function renderDashboard(prefillRepo?: string): string {
  const jobs = loadJobs();

  const jobRows = jobs
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((j) => {
      const statusBadge =
        j.status === "ready"
          ? '<span style="color:#4CAF50">&#x2713; Ready</span>'
          : j.status === "failed"
            ? '<span style="color:#F44336">&#x2717; Failed</span>'
            : '<span style="color:#FF9800">&#x25cf; ' + j.status + "</span>";

      const wikiLink = j.wikiUrl
        ? `<a href="${j.wikiUrl}" target="_blank">${j.wikiUrl}</a>`
        : "—";

      const lastSync = j.lastSyncedAt
        ? new Date(j.lastSyncedAt).toLocaleString()
        : "—";

      const resyncBtn =
        j.status === "ready" || j.status === "failed"
          ? `<a href="/?repo=${encodeURIComponent(j.repoUrl)}" class="btn btn-sm">Resync</a>`
          : "";

      return `<tr>
        <td><code>${j.slug}</code></td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${j.repoUrl}</td>
        <td>${statusBadge}</td>
        <td>${j.pages ?? "—"}</td>
        <td>${lastSync}</td>
        <td>${wikiLink}</td>
        <td>${resyncBtn}</td>
      </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Deepforge — Wiki Generator</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; }
    .container { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
    h1 { font-size: 28px; margin-bottom: 4px; }
    .subtitle { color: #666; margin-bottom: 32px; }
    .card { background: white; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 24px; }
    .card h2 { font-size: 18px; margin-bottom: 16px; }
    .form-row { display: flex; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
    .form-row label { display: block; font-size: 13px; color: #666; margin-bottom: 4px; }
    .form-row input, .form-row select { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }
    .form-row input[type="url"] { flex: 1; min-width: 300px; }
    .form-row .field { display: flex; flex-direction: column; }
    .btn { padding: 8px 20px; background: #3F51B5; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; text-decoration: none; display: inline-block; }
    .btn:hover { background: #303F9F; }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    .auth-fields { display: none; margin-top: 12px; padding-top: 12px; border-top: 1px solid #eee; }
    .auth-fields.visible { display: flex; flex-wrap: wrap; gap: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #eee; }
    th { font-weight: 600; color: #666; font-size: 12px; text-transform: uppercase; }
    .status-msg { margin-top: 12px; padding: 12px; border-radius: 4px; display: none; }
    .status-msg.visible { display: block; }
    .status-msg.success { background: #E8F5E9; color: #2E7D32; }
    .status-msg.error { background: #FFEBEE; color: #C62828; }
    .status-msg.info { background: #E3F2FD; color: #1565C0; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Deepforge</h1>
    <p class="subtitle">Generate wiki documentation from any code repository</p>

    <div class="card">
      <h2>Generate Wiki</h2>
      <form id="genForm">
        <div class="form-row">
          <div class="field" style="flex:1">
            <label for="repoUrl">Repository URL</label>
            <input type="url" id="repoUrl" name="repoUrl" placeholder="https://github.com/org/repo" value="${prefillRepo ?? ""}" required>
          </div>
          <div class="field">
            <label for="authMethod">Authentication</label>
            <select id="authMethod" name="authMethod">
              <option value="none">Public (no auth)</option>
              <option value="pat">Personal Access Token</option>
              <option value="service_principal">Service Principal</option>
            </select>
          </div>
        </div>

        <div id="patFields" class="auth-fields">
          <div class="field" style="flex:1">
            <label for="pat">Personal Access Token</label>
            <input type="password" id="pat" name="pat" placeholder="ghp_... or Azure DevOps PAT" style="width:100%">
          </div>
        </div>

        <div id="spFields" class="auth-fields">
          <div class="field">
            <label for="tenantId">Tenant ID</label>
            <input type="text" id="tenantId" name="tenantId" placeholder="xxxxxxxx-xxxx-...">
          </div>
          <div class="field">
            <label for="clientId">Client ID</label>
            <input type="text" id="clientId" name="clientId" placeholder="xxxxxxxx-xxxx-...">
          </div>
          <div class="field" style="flex:1">
            <label for="clientSecret">Client Secret</label>
            <input type="password" id="clientSecret" name="clientSecret" placeholder="secret">
          </div>
        </div>

        <div class="form-row" style="margin-top: 16px;">
          <button type="submit" class="btn" id="submitBtn">Generate Wiki</button>
        </div>
      </form>
      <div id="statusMsg" class="status-msg"></div>
    </div>

    <div class="card">
      <h2>Generated Wikis</h2>
      ${
        jobs.length === 0
          ? "<p style='color:#999'>No wikis generated yet. Submit a repository URL above.</p>"
          : `<table>
        <thead>
          <tr><th>Slug</th><th>Repository</th><th>Status</th><th>Pages</th><th>Last Synced</th><th>Wiki URL</th><th></th></tr>
        </thead>
        <tbody>${jobRows}</tbody>
      </table>`
      }
    </div>
  </div>

  <script>
    const authSelect = document.getElementById('authMethod');
    const patFields = document.getElementById('patFields');
    const spFields = document.getElementById('spFields');

    authSelect.addEventListener('change', () => {
      patFields.classList.toggle('visible', authSelect.value === 'pat');
      spFields.classList.toggle('visible', authSelect.value === 'service_principal');
    });

    // Trigger change on load in case prefilled
    authSelect.dispatchEvent(new Event('change'));

    const form = document.getElementById('genForm');
    const statusMsg = document.getElementById('statusMsg');
    const submitBtn = document.getElementById('submitBtn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';
      statusMsg.className = 'status-msg';

      const body = { repoUrl: document.getElementById('repoUrl').value };
      const auth = authSelect.value;
      if (auth === 'pat') {
        body.auth = { method: 'pat', pat: document.getElementById('pat').value };
      } else if (auth === 'service_principal') {
        body.auth = {
          method: 'service_principal',
          tenantId: document.getElementById('tenantId').value,
          clientId: document.getElementById('clientId').value,
          clientSecret: document.getElementById('clientSecret').value,
        };
      }

      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (res.ok) {
          statusMsg.className = 'status-msg visible info';
          statusMsg.innerHTML = 'Job submitted! Status: <strong>' + data.status + '</strong>. ' +
            (data.wikiUrl ? 'Wiki: <a href="' + data.wikiUrl + '">' + data.wikiUrl + '</a>' : 'Refresh this page to check progress.') +
            ' <br>Job ID: <code>' + data.id + '</code>';
          // Poll for completion
          if (data.status !== 'ready') pollJob(data.id);
        } else {
          statusMsg.className = 'status-msg visible error';
          statusMsg.textContent = data.error || 'Request failed';
        }
      } catch (err) {
        statusMsg.className = 'status-msg visible error';
        statusMsg.textContent = 'Network error: ' + err.message;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Generate Wiki';
      }
    });

    async function pollJob(id) {
      const check = async () => {
        try {
          const res = await fetch('/api/jobs/' + id);
          const data = await res.json();
          if (data.status === 'ready') {
            statusMsg.className = 'status-msg visible success';
            statusMsg.innerHTML = 'Wiki ready! <a href="' + data.wikiUrl + '" target="_blank">' + data.wikiUrl + '</a> (' + data.pages + ' pages)';
            setTimeout(() => location.reload(), 2000);
          } else if (data.status === 'failed') {
            statusMsg.className = 'status-msg visible error';
            statusMsg.textContent = 'Generation failed: ' + (data.error || 'Unknown error');
          } else {
            statusMsg.className = 'status-msg visible info';
            statusMsg.innerHTML = 'Status: <strong>' + data.status + '</strong>... (auto-refreshing)';
            setTimeout(check, 5000);
          }
        } catch { setTimeout(check, 5000); }
      };
      setTimeout(check, 3000);
    }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // -----------------------------------------------------------------------
  // Dashboard UI
  // -----------------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/") {
    const prefillRepo = url.searchParams.get("repo") ?? undefined;
    html(res, 200, renderDashboard(prefillRepo));
    return;
  }

  // -----------------------------------------------------------------------
  // POST /api/generate — submit or resync a wiki job
  // -----------------------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/generate") {
    try {
      const body = await parseBody(req);
      const repoUrl = body.repoUrl as string;

      if (!repoUrl || !isValidRepoUrl(repoUrl)) {
        json(res, 400, {
          error: "Invalid repoUrl. Must be a GitHub, Azure DevOps, GitLab, or Bitbucket HTTPS URL.",
        });
        return;
      }

      const slug = repoSlug(repoUrl);

      // Store auth credentials if provided
      const auth = body.auth as
        | { method: "pat"; pat: string }
        | { method: "service_principal"; tenantId: string; clientId: string; clientSecret: string }
        | undefined;

      if (auth?.method === "pat" && auth.pat) {
        saveAuth({ slug, method: "pat", pat: auth.pat });
      } else if (auth?.method === "service_principal" && auth.clientId) {
        saveAuth({
          slug,
          method: "service_principal",
          servicePrincipal: {
            tenantId: auth.tenantId,
            clientId: auth.clientId,
            clientSecret: auth.clientSecret,
          },
        });
      } else {
        // Check for env-level defaults
        if (process.env.GIT_PAT) {
          saveAuth({ slug, method: "pat", pat: process.env.GIT_PAT });
        } else if (process.env.AZURE_SP_TENANT_ID) {
          saveAuth({
            slug,
            method: "service_principal",
            servicePrincipal: {
              tenantId: process.env.AZURE_SP_TENANT_ID,
              clientId: process.env.AZURE_SP_CLIENT_ID!,
              clientSecret: process.env.AZURE_SP_CLIENT_SECRET!,
            },
          });
        } else {
          saveAuth({ slug, method: "none" });
        }
      }

      const jobs = loadJobs();
      const existing = jobs.find((j) => j.slug === slug);

      // If in-progress, return current status
      if (existing && !["ready", "failed"].includes(existing.status)) {
        json(res, 200, publicJob(existing));
        return;
      }

      // Create or update job
      const job: WikiJob = {
        id: existing?.id ?? randomBytes(8).toString("hex"),
        repoUrl,
        slug,
        status: "cloning",
        authMethod: auth?.method ?? (existing?.authMethod ?? "none"),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };

      upsertJob(job);

      // Run in background
      runGeneration(job).catch((err) => {
        console.error(`[${slug}] Unhandled error:`, err);
      });

      json(res, 202, publicJob(job));
    } catch (err: any) {
      json(res, 400, { error: err.message });
    }
    return;
  }

  // -----------------------------------------------------------------------
  // GET /api/jobs — list all jobs
  // -----------------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/api/jobs") {
    json(res, 200, loadJobs().map(publicJob));
    return;
  }

  // -----------------------------------------------------------------------
  // GET /api/jobs/:id — single job status
  // -----------------------------------------------------------------------
  if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
    const id = url.pathname.split("/").pop()!;
    const job = getJob(id);
    if (job) json(res, 200, publicJob(job));
    else json(res, 404, { error: "Job not found" });
    return;
  }

  // -----------------------------------------------------------------------
  // Health check
  // -----------------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/healthz") {
    json(res, 200, { status: "ok", jobs: loadJobs().length });
    return;
  }

  json(res, 404, { error: "Not found" });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Request error:", err);
    json(res, 500, { error: "Internal server error" });
  });
});

server.listen(PORT, () => {
  console.log(`Deepforge controller listening on :${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  Base domain: ${BASE_DOMAIN}`);
  console.log(`  Data dir: ${DATA_DIR}`);
});
