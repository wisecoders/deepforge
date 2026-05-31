/**
 * Deepforge Controller API
 *
 * - Accepts GitHub / Azure DevOps repo URLs with auth (PAT or SP)
 * - Clones, indexes, generates wiki documentation
 * - Deploys each wiki as a separate K8s pod (named after the repo slug)
 * - Streams detailed progress logs for every stage
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execSync, spawn } from "node:child_process";
import {
  mkdirSync, existsSync, readFileSync, writeFileSync,
  readdirSync, rmSync, appendFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const WIKIS_DIR = join(DATA_DIR, "wikis");
const REPOS_DIR = join(DATA_DIR, "repos");
const LOGS_DIR = join(DATA_DIR, "logs");
const JOBS_FILE = join(DATA_DIR, "jobs.json");
const BASE_DOMAIN = process.env.BASE_DOMAIN ?? "deepforge.local";
const CONTROLLER_URL = process.env.CONTROLLER_URL ?? `http://deepforge.local`;
const NAMESPACE = process.env.NAMESPACE ?? "deepforge";
const WIKI_IMAGE = process.env.WIKI_IMAGE ?? "deepforge:latest";

mkdirSync(WIKIS_DIR, { recursive: true });
mkdirSync(REPOS_DIR, { recursive: true });
mkdirSync(LOGS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function jobLog(slug: string, message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  const logFile = join(LOGS_DIR, `${slug}.log`);
  appendFileSync(logFile, line);
  // Also to stdout so kubectl logs shows it
  process.stdout.write(`[${slug}] ${message}\n`);
}

function getJobLogs(slug: string): string {
  const logFile = join(LOGS_DIR, `${slug}.log`);
  if (!existsSync(logFile)) return "";
  return readFileSync(logFile, "utf-8");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AuthMethod = "none" | "pat" | "service_principal";

interface WikiJob {
  id: string;
  repoUrl: string;
  slug: string;
  status: "queued" | "cloning" | "indexing" | "generating" | "deploying" | "ready" | "failed";
  authMethod: AuthMethod;
  createdAt: string;
  lastSyncedAt?: string;
  error?: string;
  wikiUrl?: string;
  pages?: number;
  progress?: string;
}

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
  if (idx >= 0) jobs[idx] = job;
  else jobs.push(job);
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
// Git
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

function cloneRepo(slug: string, opts: CloneOptions): void {
  const authUrl = buildAuthUrl(opts);
  if (existsSync(opts.targetDir)) {
    rmSync(opts.targetDir, { recursive: true, force: true });
  }
  jobLog(slug, `Cloning ${opts.repoUrl} → ${opts.targetDir}`);
  const output = execSync(`git clone --depth 1 "${authUrl}" "${opts.targetDir}" 2>&1`, {
    encoding: "utf-8",
    timeout: 300_000,
  });
  if (output.trim()) jobLog(slug, output.trim());
  jobLog(slug, "Clone complete");
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
// Kubernetes API helpers
// ---------------------------------------------------------------------------

async function k8sApply(resource: any): Promise<void> {
  const kind = resource.kind;
  const name = resource.metadata.name;
  const ns = resource.metadata.namespace ?? NAMESPACE;

  // Use kubectl apply from within the pod
  const json = JSON.stringify(resource);
  try {
    execSync(`echo '${json.replace(/'/g, "'\\''")}' | kubectl apply -f - 2>&1`, {
      encoding: "utf-8",
      timeout: 30_000,
    });
    jobLog(name, `K8s ${kind}/${name} applied in namespace ${ns}`);
  } catch (err: any) {
    jobLog(name, `K8s apply failed for ${kind}/${name}: ${err.message}`);
    throw err;
  }
}

function buildWikiPodResources(slug: string): any[] {
  const labels = { app: "deepforge-wiki", wiki: slug };

  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: `wiki-${slug}`, namespace: NAMESPACE, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          containers: [{
            name: "wiki",
            image: WIKI_IMAGE,
            imagePullPolicy: "Never",
            command: ["node", "dist/controller/wiki-server.js"],
            ports: [{ containerPort: 8081, name: "http" }],
            env: [
              { name: "WIKI_PORT", value: "8081" },
              { name: "WIKIS_DIR", value: "/data/wikis" },
              { name: "BASE_DOMAIN", value: BASE_DOMAIN },
            ],
            volumeMounts: [{ name: "data", mountPath: "/data", readOnly: true }],
            resources: {
              requests: { cpu: "50m", memory: "64Mi" },
              limits: { cpu: "200m", memory: "128Mi" },
            },
          }],
          volumes: [{ name: "data", persistentVolumeClaim: { claimName: "deepforge-data" } }],
        },
      },
    },
  };

  const service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: `wiki-${slug}`, namespace: NAMESPACE, labels },
    spec: {
      selector: labels,
      ports: [{ name: "http", port: 80, targetPort: 8081 }],
    },
  };

  const ingress = {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: `wiki-${slug}`,
      namespace: NAMESPACE,
      labels,
      annotations: { "nginx.ingress.kubernetes.io/proxy-read-timeout": "30" },
    },
    spec: {
      ingressClassName: "nginx",
      rules: [{
        host: `${slug}.${BASE_DOMAIN}`,
        http: {
          paths: [{
            path: "/",
            pathType: "Prefix",
            backend: { service: { name: `wiki-${slug}`, port: { name: "http" } } },
          }],
        },
      }],
    },
  };

  return [deployment, service, ingress];
}

async function deployWikiPod(slug: string): Promise<void> {
  jobLog(slug, "Deploying wiki pod...");
  const resources = buildWikiPodResources(slug);
  for (const res of resources) {
    await k8sApply(res);
  }
  jobLog(slug, `Wiki pod deployed: wiki-${slug}`);
}

// ---------------------------------------------------------------------------
// Wiki generation pipeline
// ---------------------------------------------------------------------------

async function runGeneration(job: WikiJob): Promise<void> {
  const repoDir = join(REPOS_DIR, job.slug);
  const wikiDir = join(WIKIS_DIR, job.slug);
  const auth = getAuth(job.slug);

  // Clear old log
  const logFile = join(LOGS_DIR, `${job.slug}.log`);
  if (existsSync(logFile)) writeFileSync(logFile, "");

  try {
    // ---- Clone ----
    updateJob(job.id, { status: "cloning", progress: "Cloning repository..." });
    cloneRepo(job.slug, {
      repoUrl: job.repoUrl,
      targetDir: repoDir,
      pat: auth?.pat,
      servicePrincipal: auth?.servicePrincipal,
    });

    // ---- Index + Generate ----
    updateJob(job.id, { status: "indexing", progress: "Scanning and indexing..." });
    jobLog(job.slug, "Starting deepforge generate...");

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

    // Stream ALL output to logs
    child.stdout.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter((l) => l.trim());
      for (const line of lines) {
        jobLog(job.slug, line.trim());

        // Update status/progress based on output
        if (line.includes("Planning wiki")) {
          updateJob(job.id, { status: "indexing", progress: "Planning wiki structure..." });
        } else if (line.includes("Planned")) {
          updateJob(job.id, { status: "indexing", progress: line.trim() });
        } else if (line.includes("Generating")) {
          updateJob(job.id, { status: "generating", progress: line.trim() });
        } else if (line.includes("Done:")) {
          updateJob(job.id, { progress: line.trim() });
        } else if (line.includes("Assembling")) {
          updateJob(job.id, { progress: "Assembling wiki..." });
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter((l) => l.trim());
      for (const line of lines) {
        jobLog(job.slug, `[stderr] ${line.trim()}`);
      }
    });

    const exitCode = await new Promise<number>((resolveP, reject) => {
      child.on("close", (code) => resolveP(code ?? 1));
      child.on("error", reject);
    });

    if (exitCode !== 0) {
      throw new Error(`Generation process exited with code ${exitCode}`);
    }

    jobLog(job.slug, "Generation complete");

    // ---- Deploy wiki pod ----
    updateJob(job.id, { status: "deploying", progress: "Deploying wiki pod..." });
    try {
      await deployWikiPod(job.slug);
    } catch (err: any) {
      // Non-fatal — wiki files exist on PVC, just pod deploy failed
      jobLog(job.slug, `WARNING: Wiki pod deployment failed (${err.message}). Files are still on PVC.`);
    }

    // ---- Done ----
    const pages = readdirSync(wikiDir).filter((f) => f.endsWith(".md")).length;
    const wikiUrl = `http://${job.slug}.${BASE_DOMAIN}`;
    const lastSyncedAt = new Date().toISOString();

    updateJob(job.id, {
      status: "ready",
      wikiUrl,
      pages,
      lastSyncedAt,
      progress: `Ready — ${pages} pages`,
    });
    jobLog(job.slug, `Wiki ready: ${pages} pages at ${wikiUrl}`);
  } catch (err: any) {
    updateJob(job.id, { status: "failed", error: err.message, progress: `Failed: ${err.message}` });
    jobLog(job.slug, `FAILED: ${err.message}`);
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
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function htmlResp(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function textResp(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
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
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

function renderDashboard(prefillRepo?: string): string {
  const jobs = loadJobs();

  const jobRows = jobs
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((j) => {
      const statusColor =
        j.status === "ready" ? "#4CAF50"
        : j.status === "failed" ? "#F44336"
        : "#FF9800";
      const statusBadge = `<span style="color:${statusColor};font-weight:600">${j.status}</span>`;

      const wikiLink = j.wikiUrl
        ? `<a href="${j.wikiUrl}" target="_blank">${j.wikiUrl}</a>`
        : "—";

      const lastSync = j.lastSyncedAt
        ? new Date(j.lastSyncedAt).toLocaleString()
        : "—";

      const progress = j.progress ?? "";

      return `<tr>
        <td><code>${j.slug}</code></td>
        <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${j.repoUrl}">${j.repoUrl}</td>
        <td>${statusBadge}</td>
        <td style="font-size:11px;color:#666;max-width:250px;overflow:hidden;text-overflow:ellipsis" title="${progress}">${progress}</td>
        <td>${j.pages ?? "—"}</td>
        <td>${lastSync}</td>
        <td>${wikiLink}</td>
        <td>
          <a href="/api/jobs/${j.slug}/logs" target="_blank" style="font-size:11px;margin-right:8px">logs</a>
          ${j.status === "ready" || j.status === "failed" ? `<a href="/?repo=${encodeURIComponent(j.repoUrl)}" class="btn btn-sm">Resync</a>` : ""}
        </td>
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
    .container { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }
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
    th, td { padding: 10px 8px; text-align: left; border-bottom: 1px solid #eee; }
    th { font-weight: 600; color: #666; font-size: 11px; text-transform: uppercase; }
    .status-msg { margin-top: 12px; padding: 12px; border-radius: 4px; display: none; }
    .status-msg.visible { display: block; }
    .status-msg.success { background: #E8F5E9; color: #2E7D32; }
    .status-msg.error { background: #FFEBEE; color: #C62828; }
    .status-msg.info { background: #E3F2FD; color: #1565C0; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
    #logPanel { margin-top: 12px; display: none; }
    #logPanel.visible { display: block; }
    #logPanel pre { background: #1e1e1e; color: #d4d4d4; padding: 16px; border-radius: 4px; max-height: 400px; overflow: auto; font-size: 12px; line-height: 1.5; white-space: pre-wrap; }
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
      <div id="logPanel"><pre id="logContent"></pre></div>
    </div>

    <div class="card">
      <h2>Generated Wikis</h2>
      ${jobs.length === 0
        ? "<p style='color:#999'>No wikis generated yet.</p>"
        : `<table>
        <thead><tr><th>Slug</th><th>Repository</th><th>Status</th><th>Progress</th><th>Pages</th><th>Last Synced</th><th>Wiki URL</th><th></th></tr></thead>
        <tbody>${jobRows}</tbody>
      </table>`}
    </div>
  </div>

  <script>
    const authSelect = document.getElementById('authMethod');
    document.getElementById('patFields').classList.toggle('visible', authSelect.value === 'pat');
    document.getElementById('spFields').classList.toggle('visible', authSelect.value === 'service_principal');
    authSelect.addEventListener('change', () => {
      document.getElementById('patFields').classList.toggle('visible', authSelect.value === 'pat');
      document.getElementById('spFields').classList.toggle('visible', authSelect.value === 'service_principal');
    });

    const form = document.getElementById('genForm');
    const statusMsg = document.getElementById('statusMsg');
    const logPanel = document.getElementById('logPanel');
    const logContent = document.getElementById('logContent');
    const submitBtn = document.getElementById('submitBtn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';
      statusMsg.className = 'status-msg';
      logPanel.className = 'visible';
      logContent.textContent = 'Starting...\\n';

      const body = { repoUrl: document.getElementById('repoUrl').value };
      const auth = authSelect.value;
      if (auth === 'pat') body.auth = { method: 'pat', pat: document.getElementById('pat').value };
      else if (auth === 'service_principal') body.auth = {
        method: 'service_principal',
        tenantId: document.getElementById('tenantId').value,
        clientId: document.getElementById('clientId').value,
        clientSecret: document.getElementById('clientSecret').value,
      };

      try {
        const res = await fetch('/api/generate', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const data = await res.json();
        if (res.ok) {
          statusMsg.className = 'status-msg visible info';
          statusMsg.innerHTML = 'Job submitted — <strong>' + data.status + '</strong>. Streaming logs...';
          pollLogs(data.slug, data.id);
        } else {
          statusMsg.className = 'status-msg visible error';
          statusMsg.textContent = data.error || 'Failed';
          logPanel.className = '';
        }
      } catch (err) {
        statusMsg.className = 'status-msg visible error';
        statusMsg.textContent = 'Network error: ' + err.message;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Generate Wiki';
      }
    });

    async function pollLogs(slug, jobId) {
      const check = async () => {
        try {
          const [logsRes, jobRes] = await Promise.all([
            fetch('/api/jobs/' + slug + '/logs'),
            fetch('/api/jobs/' + jobId),
          ]);
          const logs = await logsRes.text();
          const job = await jobRes.json();

          logContent.textContent = logs || 'Waiting for output...\\n';
          logPanel.querySelector('pre').scrollTop = logPanel.querySelector('pre').scrollHeight;

          if (job.status === 'ready') {
            statusMsg.className = 'status-msg visible success';
            statusMsg.innerHTML = 'Wiki ready! <a href="' + job.wikiUrl + '" target="_blank">' + job.wikiUrl + '</a> (' + job.pages + ' pages)';
            setTimeout(() => location.reload(), 3000);
            return;
          } else if (job.status === 'failed') {
            statusMsg.className = 'status-msg visible error';
            statusMsg.textContent = 'Failed: ' + (job.error || 'Unknown');
            return;
          }
          statusMsg.className = 'status-msg visible info';
          statusMsg.innerHTML = 'Status: <strong>' + job.status + '</strong> — ' + (job.progress || '');
          setTimeout(check, 3000);
        } catch { setTimeout(check, 3000); }
      };
      setTimeout(check, 2000);
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

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Dashboard
  if (req.method === "GET" && url.pathname === "/") {
    htmlResp(res, 200, renderDashboard(url.searchParams.get("repo") ?? undefined));
    return;
  }

  // POST /api/generate
  if (req.method === "POST" && url.pathname === "/api/generate") {
    try {
      const body = await parseBody(req);
      const repoUrl = body.repoUrl as string;

      if (!repoUrl || !isValidRepoUrl(repoUrl)) {
        json(res, 400, { error: "Invalid repoUrl. Must be a GitHub, Azure DevOps, GitLab, or Bitbucket HTTPS URL." });
        return;
      }

      const slug = repoSlug(repoUrl);

      // Store auth
      const auth = body.auth as any;
      if (auth?.method === "pat" && auth.pat) {
        saveAuth({ slug, method: "pat", pat: auth.pat });
      } else if (auth?.method === "service_principal" && auth.clientId) {
        saveAuth({ slug, method: "service_principal", servicePrincipal: { tenantId: auth.tenantId, clientId: auth.clientId, clientSecret: auth.clientSecret } });
      } else if (process.env.GIT_PAT) {
        saveAuth({ slug, method: "pat", pat: process.env.GIT_PAT });
      } else {
        saveAuth({ slug, method: "none" });
      }

      const jobs = loadJobs();
      const existing = jobs.find((j) => j.slug === slug);

      // If in-progress, return current status
      if (existing && !["ready", "failed"].includes(existing.status)) {
        json(res, 200, existing);
        return;
      }

      const job: WikiJob = {
        id: existing?.id ?? randomBytes(8).toString("hex"),
        repoUrl,
        slug,
        status: "queued",
        authMethod: auth?.method ?? "none",
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        progress: "Queued...",
      };

      upsertJob(job);
      jobLog(slug, `Job created: ${repoUrl}`);

      runGeneration(job).catch((err) => {
        jobLog(slug, `Unhandled: ${err.message}`);
      });

      json(res, 202, job);
    } catch (err: any) {
      json(res, 400, { error: err.message });
    }
    return;
  }

  // GET /api/jobs
  if (req.method === "GET" && url.pathname === "/api/jobs") {
    json(res, 200, loadJobs());
    return;
  }

  // GET /api/jobs/:id/logs
  if (req.method === "GET" && url.pathname.match(/^\/api\/jobs\/[^/]+\/logs$/)) {
    const idOrSlug = url.pathname.split("/")[3];
    const job = getJob(idOrSlug);
    if (!job) { json(res, 404, { error: "Job not found" }); return; }
    const logs = getJobLogs(job.slug);
    textResp(res, 200, logs || "(no logs yet)\n");
    return;
  }

  // GET /api/jobs/:id
  if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
    const id = url.pathname.split("/")[3];
    const job = getJob(id);
    if (job) json(res, 200, job);
    else json(res, 404, { error: "Job not found" });
    return;
  }

  // Health
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
  console.log(`  Wiki image: ${WIKI_IMAGE}`);
});
