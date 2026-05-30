/**
 * Wiki static file server.
 *
 * Serves generated wiki sites based on subdomain or path prefix.
 * In Kubernetes, this runs behind an ingress that routes:
 *   <slug>.deepforge.local → this server
 *
 * Locally or in non-wildcard setups, use path-based routing:
 *   /wiki/<slug>/index.html → serves from /data/wikis/<slug>/
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const PORT = parseInt(process.env.WIKI_PORT ?? "8081", 10);
const WIKIS_DIR = process.env.WIKIS_DIR ?? "/data/wikis";
const BASE_DOMAIN = process.env.BASE_DOMAIN ?? "deepforge.local";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveFile(res: ServerResponse, filePath: string): void {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const ext = extname(filePath);
  const mime = MIME_TYPES[ext] ?? "application/octet-stream";
  const content = readFileSync(filePath);

  res.writeHead(200, {
    "Content-Type": mime,
    "Cache-Control": "public, max-age=300",
  });
  res.end(content);
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const host = req.headers.host ?? "";
  const url = new URL(req.url ?? "/", `http://${host}`);
  let slug: string | null = null;
  let filePath: string;

  // Try subdomain-based routing: <slug>.deepforge.local
  if (host.endsWith(`.${BASE_DOMAIN}`)) {
    slug = host.replace(`.${BASE_DOMAIN}`, "").split(":")[0];
    filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  }
  // Fall back to path-based routing: /wiki/<slug>/...
  else if (url.pathname.startsWith("/wiki/")) {
    const parts = url.pathname.replace("/wiki/", "").split("/");
    slug = parts[0];
    const rest = parts.slice(1).join("/") || "index.html";
    filePath = `/${rest}`;
  } else {
    // Root — show list of available wikis
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Deepforge Wiki Server", docs: "/wiki/<slug>/" }));
    return;
  }

  if (!slug) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing wiki slug");
    return;
  }

  // Security: prevent path traversal
  const safePath = filePath.replace(/\.\./g, "").replace(/\/\//g, "/");
  const fullPath = join(WIKIS_DIR, slug, safePath);

  // Ensure the resolved path is within the wiki directory
  if (!fullPath.startsWith(join(WIKIS_DIR, slug))) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  serveFile(res, fullPath);
}

const server = createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (err) {
    console.error("Request error:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal server error");
  }
});

server.listen(PORT, () => {
  console.log(`Deepforge wiki server listening on :${PORT}`);
  console.log(`  Serving wikis from: ${WIKIS_DIR}`);
  console.log(`  Subdomain routing: <slug>.${BASE_DOMAIN}`);
  console.log(`  Path routing: /wiki/<slug>/`);
});
