# Deepforge

Generate comprehensive wiki documentation from any code repository. Deepforge indexes your codebase into a knowledge graph, then uses LLMs to produce DeepWiki-quality documentation with real code references, architecture diagrams, and cross-linked pages.

## Architecture

```
                                ┌─────────────────────────────────────────────┐
                                │            Kubernetes Cluster               │
                                │                                             │
  User ──POST /api/generate──►  │  ┌──────────────────────┐                   │
  (repo URL + auth)             │  │  Controller Pod       │                  │
                                │  │                       │                  │
                                │  │  ┌─────────────────┐  │   ┌───────────┐  │
                                │  │  │  Controller API  │──┼──►│           │  │
                                │  │  │  :8080           │  │   │   PVC     │  │
                                │  │  └────────┬────────┘  │   │  /data    │  │
                                │  │           │           │   │           │  │
                                │  │  ┌────────▼────────┐  │   │  /repos   │  │
                                │  │  │  Wiki Server    │──┼──►│  /wikis   │  │
                                │  │  │  :8081          │  │   │  /jobs    │  │
                                │  │  └─────────────────┘  │   └───────────┘  │
                                │  └──────────────────────┘                   │
                                │                                             │
  <slug>.deepforge.example.com  │  ┌──────────────────────┐                   │
  ──────────────────────────►   │  │  Ingress Controller   │                  │
                                │  │  (nginx/traefik)      │                  │
                                │  │  Wildcard *.domain    │                  │
                                │  └──────────────────────┘                   │
                                └─────────────────────────────────────────────┘
```

### Processing Pipeline

When a repository URL is submitted, Deepforge runs a multi-stage pipeline:

```
  Clone repo ──► Scan files ──► Extract symbols ──► Resolve refs ──► Store graph ──► Plan wiki ──► Generate pages ──► Assemble wiki
                                (tree-sitter)       (cross-file)     (SQLite)        (LLM)         (LLM × N)         (docsify)
```

1. **Scanner** — discovers source files, detects languages, applies ignore rules
2. **Extractor** — parses each file with tree-sitter WASM grammars, extracts symbols (classes, methods, interfaces) and intra-file relationships
3. **Resolver** — resolves cross-file references (imports, inheritance, calls) into graph edges
4. **Store** — persists the knowledge graph in SQLite with FTS5 full-text search
5. **Planner** — LLM analyzes the graph and plans a concept-based wiki structure (sections + subsections)
6. **Page Writer** — LLM generates each wiki page with real code snippets, file:line citations, Mermaid diagrams, and cross-references
7. **Assembler** — writes markdown files + docsify site with sidebar navigation and search

### Component Structure

```
src/
  scanner/          Source file discovery and language detection
  extraction/       Tree-sitter parsing, per-language symbol extraction
  resolution/       Cross-file reference resolution
  store/            SQLite graph storage with FTS5
  graph/            Graph traversal and query algorithms
  generator/        LLM-based wiki generation pipeline
    planner.ts        Wiki structure planning
    context-assembler.ts  Page context assembly from graph
    page-writer.ts    LLM prompt engineering for page generation
    assembler.ts      Markdown + docsify output assembly
  llm/              LLM provider abstraction
  cli/              Command-line interface
  controller/       Kubernetes controller API + wiki server
```

## Quick Start (Local)

```bash
# Install
npm install

# Set your LLM provider in .env (see .env.example)
cp .env.example .env
# Edit .env — set LLM_PROVIDER and the corresponding API key

# Generate wiki for a local repo
npx deepforge generate /path/to/your/repo --output ./wiki

# Serve the wiki
cd wiki && python3 -m http.server 3000
# Open http://localhost:3000
```

## LLM Provider Configuration

Deepforge supports four LLM providers. Set `LLM_PROVIDER` in your `.env` file:

| Provider | `LLM_PROVIDER` | Required env vars | Notes |
|----------|----------------|-------------------|-------|
| **Claude** | `claude` | `ANTHROPIC_API_KEY` | Best quality. Uses prompt caching to reduce costs. |
| **OpenAI** | `openai` | `OPENAI_API_KEY` | GPT-4o default. Set `OPENAI_BASE_URL` for compatible APIs. |
| **Azure OpenAI** | `azure` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` | Enterprise deployments. Supports `retry-after` headers. |
| **Ollama** | `ollama` | (none) | Local models. Set `OLLAMA_BASE_URL` (default: `localhost:11434`). |

CLI flags (`--provider`, `--model`, `--api-key`) override `.env` values.

## CLI Usage

```bash
# Full pipeline: index + generate
npx deepforge generate <projectPath> [options]

# Index only (no wiki generation)
npx deepforge index <projectPath>

# View knowledge graph stats
npx deepforge status <projectPath>

# Search the knowledge graph
npx deepforge query <projectPath> "BasketService"
```

### Generate Options

| Flag | Description | Default |
|------|-------------|---------|
| `-o, --output <path>` | Wiki output directory | `./wiki` |
| `--skip-index` | Skip indexing, use existing graph | — |
| `--provider <name>` | LLM provider | from `.env` |
| `--model <name>` | Model name | provider default |
| `--api-key <key>` | API key | from `.env` |
| `--concurrency <n>` | Parallel page generation | `3` |

## Kubernetes Deployment

Deepforge ships as a single container image with two processes:

- **Controller API** (`:8080`) — accepts repo URLs, manages jobs, triggers wiki generation
- **Wiki Server** (`:8081`) — serves generated wikis via subdomain or path routing

### Prerequisites

- Kubernetes cluster with an ingress controller (nginx-ingress or traefik)
- Wildcard DNS record: `*.deepforge.example.com → ingress IP`
- Wildcard TLS certificate (or cert-manager with DNS challenge)
- A persistent volume for `/data`

### Deploy

```bash
# 1. Configure secrets
#    Edit deploy/k8s/secrets.yaml with your LLM API key and git credentials

# 2. Update domain
#    Search-replace "deepforge.example.com" in deploy/k8s/ with your domain

# 3. Build and push the image
docker build -t myregistry/deepforge:latest .
docker push myregistry/deepforge:latest

# 4. Update image reference in controller.yaml
#    Change "deepforge:latest" to "myregistry/deepforge:latest"

# 5. Apply
kubectl apply -k deploy/k8s/
```

### Controller API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard UI — submit repos, view status, resync |
| `/api/generate` | POST | Submit a wiki generation job |
| `/api/jobs` | GET | List all jobs |
| `/api/jobs/:id` | GET | Get job status by ID or slug |
| `/healthz` | GET | Health check |

#### POST /api/generate

```json
{
  "repoUrl": "https://github.com/org/repo",
  "auth": {
    "method": "pat",
    "pat": "ghp_xxxxxxxxxxxx"
  }
}
```

Authentication options:

| `auth.method` | Fields | Use case |
|---------------|--------|----------|
| *(omitted)* | — | Public repositories |
| `pat` | `pat` | GitHub PAT, Azure DevOps PAT |
| `service_principal` | `tenantId`, `clientId`, `clientSecret` | Azure DevOps with AAD service principal |

Response:

```json
{
  "id": "a1b2c3d4e5f6g7h8",
  "repoUrl": "https://github.com/org/repo",
  "slug": "org-repo",
  "status": "cloning",
  "authMethod": "pat",
  "createdAt": "2025-01-15T10:30:00Z"
}
```

When `status` becomes `ready`:

```json
{
  "status": "ready",
  "wikiUrl": "https://org-repo.deepforge.example.com",
  "pages": 43,
  "lastSyncedAt": "2025-01-15T10:45:00Z"
}
```

### Wiki Resync

Each generated wiki includes a **Resync** button (top right) that links back to the controller dashboard with the repo URL pre-filled. Clicking it triggers a fresh clone + regeneration cycle while preserving the same wiki URL.

The controller dashboard at `/` shows all generated wikis with their status, page count, last sync time, and wiki URL.

### Subdomain Routing

Generated wikis are served at stable subdomain URLs derived from the repository:

| Repository URL | Wiki URL |
|---------------|----------|
| `github.com/NimblePros/eShopOnWeb` | `nimblepros-eshoponweb.deepforge.example.com` |
| `dev.azure.com/myorg/myproject/_git/api` | `myorg-myproject-api.deepforge.example.com` |

If wildcard subdomains aren't available, path-based routing works too: `/wiki/<slug>/`

## Development

```bash
npm run build       # Build with tsup
npm run test        # Run tests with vitest
npm run typecheck   # Type-check with tsc --noEmit
npm run lint        # Lint with eslint
```

### Testing individual components

```bash
# Test the planner alone
npx tsx scripts/test-planner.ts

# Test a single page generation
npx tsx scripts/test-page.ts /path/to/repo "Section Title" claude
```

## Supported Languages

TypeScript, JavaScript, Python, C#, Go, Rust, Java, Kotlin, Swift, Ruby, PHP, C, C++

Language support is provided by tree-sitter WASM grammars. Adding a new language requires implementing the `LanguageExtractor` interface in `src/extraction/languages/`.

## License

MIT
