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
  const readyJobs = jobs.filter((j) => j.status === "ready");
  const activeJobs = jobs.filter((j) => !["ready", "failed"].includes(j.status));
  const failedJobs = jobs.filter((j) => j.status === "failed");
  const totalPages = jobs.reduce((sum, j) => sum + (j.pages ?? 0), 0);

  const jobCards = jobs
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((j) => {
      const isReady = j.status === "ready";
      const isFailed = j.status === "failed";
      const isActive = !isReady && !isFailed;

      const statusClass = isReady ? "status-ready" : isFailed ? "status-failed" : "status-active";
      const statusIcon = isReady ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`
        : isFailed ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="spin"><path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M6.34 6.34L3.51 3.51"/></svg>`;

      const repoName = j.slug.split("-").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

      const lastSync = j.lastSyncedAt
        ? new Date(j.lastSyncedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })
        : "";

      const progress = j.progress ?? "";

      return `<div class="wiki-card ${statusClass}">
        <div class="wiki-card-header">
          <div class="wiki-card-status">${statusIcon}<span>${j.status}</span></div>
          <div class="wiki-card-actions">
            <a href="/api/jobs/${j.slug}/logs" target="_blank" class="action-btn" title="View logs"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></a>
            ${isReady || isFailed ? `<a href="/?repo=${encodeURIComponent(j.repoUrl)}" class="action-btn" title="Resync"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></a>` : ""}
          </div>
        </div>
        <h3 class="wiki-card-title">${repoName}</h3>
        <p class="wiki-card-repo" title="${j.repoUrl}">${j.repoUrl.replace(/^https?:\/\//, "")}</p>
        ${isActive ? `<div class="wiki-card-progress"><div class="progress-text">${progress}</div><div class="progress-bar"><div class="progress-bar-fill"></div></div></div>` : ""}
        <div class="wiki-card-footer">
          ${j.pages ? `<span class="wiki-card-meta"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>${j.pages} pages</span>` : ""}
          ${lastSync ? `<span class="wiki-card-meta"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${lastSync}</span>` : ""}
          ${isReady && j.wikiUrl ? `<a href="${j.wikiUrl}" target="_blank" class="wiki-link">Open Wiki <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>` : ""}
        </div>
      </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Deepforge</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #0f0f23;
      --bg-secondary: #1a1a3e;
      --bg-card: #1e1e42;
      --bg-card-hover: #252552;
      --bg-input: #151533;
      --border: #2d2d5e;
      --border-focus: #6366f1;
      --text-primary: #e2e8f0;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --accent: #6366f1;
      --accent-hover: #818cf8;
      --accent-glow: rgba(99, 102, 241, 0.15);
      --success: #10b981;
      --success-bg: rgba(16, 185, 129, 0.1);
      --warning: #f59e0b;
      --warning-bg: rgba(245, 158, 11, 0.1);
      --error: #ef4444;
      --error-bg: rgba(239, 68, 68, 0.1);
      --radius: 12px;
      --radius-sm: 8px;
      --shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; }

    /* Header */
    .header { background: linear-gradient(135deg, var(--bg-secondary) 0%, #1a1040 100%); border-bottom: 1px solid var(--border); padding: 20px 0; }
    .header-inner { max-width: 1400px; margin: 0 auto; padding: 0 32px; display: flex; align-items: center; justify-content: space-between; }
    .logo { display: flex; align-items: center; gap: 12px; }
    .logo-icon { width: 36px; height: 36px; background: linear-gradient(135deg, #6366f1, #8b5cf6); border-radius: 10px; display: flex; align-items: center; justify-content: center; }
    .logo-icon svg { width: 20px; height: 20px; color: white; }
    .logo-text { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; background: linear-gradient(135deg, #e2e8f0, #6366f1); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .header-meta { display: flex; align-items: center; gap: 20px; }
    .header-badge { padding: 5px 12px; border-radius: 20px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge-active { background: var(--warning-bg); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-ready { background: var(--success-bg); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.3); }

    /* Main */
    .main { max-width: 1400px; margin: 0 auto; padding: 32px; }

    /* Stats */
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 32px; }
    .stat-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; transition: transform 0.15s, border-color 0.15s; }
    .stat-card:hover { transform: translateY(-2px); border-color: var(--border-focus); }
    .stat-label { font-size: 12px; font-weight: 500; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
    .stat-value { font-size: 28px; font-weight: 700; color: var(--text-primary); }
    .stat-value.accent { color: var(--accent); }
    .stat-value.success { color: var(--success); }
    .stat-value.warning { color: var(--warning); }

    /* Generate Section */
    .generate-section { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 28px; margin-bottom: 32px; position: relative; overflow: hidden; }
    .generate-section::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, #6366f1, #8b5cf6, #6366f1); }
    .section-title { font-size: 16px; font-weight: 600; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; }
    .section-title svg { color: var(--accent); }

    .form-grid { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: end; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-group label { font-size: 12px; font-weight: 500; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.3px; }
    .form-group input, .form-group select { background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 11px 14px; font-size: 14px; color: var(--text-primary); transition: border-color 0.2s, box-shadow 0.2s; font-family: inherit; }
    .form-group input:focus, .form-group select:focus { outline: none; border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-glow); }
    .form-group input::placeholder { color: var(--text-muted); }
    .form-group select { cursor: pointer; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; padding-right: 36px; }

    .auth-fields { display: none; padding-top: 16px; margin-top: 16px; border-top: 1px solid var(--border); }
    .auth-fields.visible { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }

    .btn-generate { background: linear-gradient(135deg, #6366f1, #7c3aed); color: white; border: none; border-radius: var(--radius-sm); padding: 11px 28px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; font-family: inherit; white-space: nowrap; display: flex; align-items: center; gap: 8px; }
    .btn-generate:hover { background: linear-gradient(135deg, #818cf8, #8b5cf6); transform: translateY(-1px); box-shadow: 0 4px 16px rgba(99, 102, 241, 0.4); }
    .btn-generate:active { transform: translateY(0); }
    .btn-generate:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }

    /* Status message */
    .status-msg { margin-top: 16px; padding: 14px 16px; border-radius: var(--radius-sm); display: none; font-size: 13px; font-weight: 500; align-items: center; gap: 10px; }
    .status-msg.visible { display: flex; }
    .status-msg.success { background: var(--success-bg); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.2); }
    .status-msg.error { background: var(--error-bg); color: var(--error); border: 1px solid rgba(239, 68, 68, 0.2); }
    .status-msg.info { background: var(--accent-glow); color: var(--accent-hover); border: 1px solid rgba(99, 102, 241, 0.2); }
    .status-msg a { color: inherit; text-decoration: underline; }

    /* Log panel */
    #logPanel { margin-top: 16px; display: none; }
    #logPanel.visible { display: block; }
    #logPanel pre { background: #0d0d1a; color: #a5f3a6; padding: 18px; border-radius: var(--radius-sm); max-height: 350px; overflow: auto; font-size: 12px; line-height: 1.7; white-space: pre-wrap; font-family: 'JetBrains Mono', 'Fira Code', monospace; border: 1px solid var(--border); }
    #logPanel pre::-webkit-scrollbar { width: 6px; }
    #logPanel pre::-webkit-scrollbar-track { background: transparent; }
    #logPanel pre::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    /* Wikis Grid */
    .wikis-section { margin-bottom: 32px; }
    .wikis-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 16px; }

    .wiki-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; transition: all 0.2s; position: relative; overflow: hidden; }
    .wiki-card:hover { border-color: var(--border-focus); transform: translateY(-2px); box-shadow: var(--shadow); }
    .wiki-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; }
    .wiki-card.status-ready::before { background: var(--success); }
    .wiki-card.status-failed::before { background: var(--error); }
    .wiki-card.status-active::before { background: linear-gradient(90deg, var(--accent), var(--warning), var(--accent)); background-size: 200% 100%; animation: shimmer 2s infinite; }

    @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .spin { animation: spin 1.5s linear infinite; }

    .wiki-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .wiki-card-status { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .status-ready .wiki-card-status { color: var(--success); }
    .status-failed .wiki-card-status { color: var(--error); }
    .status-active .wiki-card-status { color: var(--warning); }
    .wiki-card-actions { display: flex; gap: 4px; }
    .action-btn { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; border-radius: 6px; color: var(--text-muted); transition: all 0.15s; text-decoration: none; }
    .action-btn:hover { background: rgba(99, 102, 241, 0.1); color: var(--accent); }

    .wiki-card-title { font-size: 16px; font-weight: 600; margin-bottom: 4px; color: var(--text-primary); }
    .wiki-card-repo { font-size: 12px; color: var(--text-muted); margin-bottom: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }

    .wiki-card-progress { margin-bottom: 12px; }
    .progress-text { font-size: 11px; color: var(--text-secondary); margin-bottom: 6px; }
    .progress-bar { height: 3px; background: var(--bg-input); border-radius: 2px; overflow: hidden; }
    .progress-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--warning)); border-radius: 2px; animation: shimmer 2s infinite; background-size: 200% 100%; width: 60%; }

    .wiki-card-footer { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .wiki-card-meta { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-muted); }
    .wiki-link { margin-left: auto; font-size: 12px; font-weight: 600; color: var(--accent); text-decoration: none; display: flex; align-items: center; gap: 4px; transition: color 0.15s; }
    .wiki-link:hover { color: var(--accent-hover); }

    /* Empty state */
    .empty-state { text-align: center; padding: 60px 20px; color: var(--text-muted); }
    .empty-state svg { width: 48px; height: 48px; margin-bottom: 16px; opacity: 0.4; }
    .empty-state p { font-size: 14px; }

    /* Responsive */
    @media (max-width: 768px) {
      .stats { grid-template-columns: repeat(2, 1fr); }
      .form-grid { grid-template-columns: 1fr; }
      .wikis-grid { grid-template-columns: 1fr; }
      .header-inner { flex-direction: column; gap: 12px; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-inner">
      <div class="logo">
        <div class="logo-icon"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></div>
        <span class="logo-text">Deepforge</span>
      </div>
      <div class="header-meta">
        ${activeJobs.length > 0 ? `<span class="header-badge badge-active">${activeJobs.length} generating</span>` : ""}
        ${readyJobs.length > 0 ? `<span class="header-badge badge-ready">${readyJobs.length} wikis live</span>` : ""}
      </div>
    </div>
  </div>

  <div class="main">
    <!-- Stats -->
    <div class="stats">
      <div class="stat-card">
        <div class="stat-label">Total Wikis</div>
        <div class="stat-value">${jobs.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Live</div>
        <div class="stat-value success">${readyJobs.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">In Progress</div>
        <div class="stat-value warning">${activeJobs.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Pages</div>
        <div class="stat-value accent">${totalPages}</div>
      </div>
    </div>

    <!-- Generate -->
    <div class="generate-section">
      <div class="section-title">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2m0 18v2m-7.07-3.93l1.41-1.41m10.32-10.32l1.41-1.41M1 12h2m18 0h2m-3.93 7.07l-1.41-1.41M6.34 6.34L4.93 4.93"/></svg>
        Generate Wiki
      </div>
      <form id="genForm">
        <div class="form-grid">
          <div class="form-group">
            <label for="repoUrl">Repository URL</label>
            <input type="url" id="repoUrl" name="repoUrl" placeholder="https://github.com/org/repo" value="${prefillRepo ?? ""}" required>
          </div>
          <div style="display:flex;gap:12px;align-items:end;">
            <div class="form-group">
              <label for="authMethod">Auth</label>
              <select id="authMethod" name="authMethod">
                <option value="none">Public</option>
                <option value="pat">PAT</option>
                <option value="service_principal">Service Principal</option>
              </select>
            </div>
            <button type="submit" class="btn-generate" id="submitBtn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              Generate
            </button>
          </div>
        </div>

        <div id="patFields" class="auth-fields">
          <div class="form-group">
            <label for="pat">Personal Access Token</label>
            <input type="password" id="pat" name="pat" placeholder="ghp_... or Azure DevOps PAT">
          </div>
        </div>

        <div id="spFields" class="auth-fields">
          <div class="form-group">
            <label for="tenantId">Tenant ID</label>
            <input type="text" id="tenantId" name="tenantId" placeholder="xxxxxxxx-xxxx-...">
          </div>
          <div class="form-group">
            <label for="clientId">Client ID</label>
            <input type="text" id="clientId" name="clientId" placeholder="xxxxxxxx-xxxx-...">
          </div>
          <div class="form-group">
            <label for="clientSecret">Client Secret</label>
            <input type="password" id="clientSecret" name="clientSecret" placeholder="secret">
          </div>
        </div>
      </form>
      <div id="statusMsg" class="status-msg"></div>
      <div id="logPanel"><pre id="logContent"></pre></div>
    </div>

    <!-- Wikis -->
    <div class="wikis-section">
      <div class="section-title" style="margin-bottom:20px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        Generated Wikis
      </div>
      ${jobs.length === 0
        ? `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg><p>No wikis generated yet. Paste a repository URL above to get started.</p></div>`
        : `<div class="wikis-grid">${jobCards}</div>`}
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
      submitBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin"><path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M6.34 6.34L3.51 3.51"/></svg> Processing...';
      statusMsg.className = 'status-msg';
      logPanel.className = 'visible';
      logContent.textContent = 'Initializing...\\n';

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
          statusMsg.innerHTML = 'Job submitted &mdash; streaming logs...';
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
        submitBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Generate';
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
            statusMsg.innerHTML = 'Wiki ready! <a href="' + job.wikiUrl + '" target="_blank">' + job.wikiUrl + '</a> &mdash; ' + job.pages + ' pages generated';
            setTimeout(() => location.reload(), 3000);
            return;
          } else if (job.status === 'failed') {
            statusMsg.className = 'status-msg visible error';
            statusMsg.textContent = 'Failed: ' + (job.error || 'Unknown error');
            return;
          }
          statusMsg.className = 'status-msg visible info';
          statusMsg.innerHTML = '<strong>' + job.status + '</strong> &mdash; ' + (job.progress || 'Processing...');
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
