# Deepforge — Design Document

Generate structured wiki documentation for any code repository.

Deepforge parses a codebase into a semantic knowledge graph — symbols, relationships, call chains, type hierarchies — then uses LLM synthesis to produce DeepWiki-style documentation: a navigable wiki with architecture pages, component docs, source citations, and Mermaid diagrams.

## 1. What this project does

Given a repository path, Deepforge produces a structured documentation site:

```
deepforge generate ./my-project --output ./wiki
```

Output:
```
wiki/
├── index.md                    # Overview + table of contents
├── 1-architecture.md           # System architecture with diagrams
├── 2-core-components/
│   ├── 2.1-auth-service.md     # Component doc with source citations
│   ├── 2.2-order-pipeline.md
│   └── ...
├── 3-data-flow.md
├── ...
└── assets/
    └── diagrams/               # Generated Mermaid diagrams
```

Each page contains:
- Coherent technical narrative (not just symbol dumps)
- Source citations: `[src/auth/service.ts:42-67](link)`
- Mermaid diagrams for architecture and data flow
- Cross-references to related pages
- Symbol-level detail grounded in actual code

## 2. Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   Scanner   │────►│  Extractor  │────►│   Resolver   │────►│    Store     │
│ (find files)│     │ (tree-sitter│     │ (cross-file  │     │  (SQLite +   │
│             │     │  → symbols  │     │  references)  │     │   FTS5)      │
│             │     │  + edges)   │     │              │     │              │
└─────────────┘     └─────────────┘     └──────────────┘     └──────┬───────┘
                                                                    │
                                                              ┌─────▼───────┐
                                                              │  Generator  │
                                                              │ (LLM wiki   │
                                                              │  synthesis) │
                                                              └─────────────┘
```

Five pipeline stages, each independently testable:

1. **Scanner** — Find source files, respect .gitignore, detect languages
2. **Extractor** — Parse each file with tree-sitter, emit symbol nodes and intra-file edges
3. **Resolver** — Link symbols across files via imports, build the full graph
4. **Store** — Persist the graph in SQLite with FTS5 search
5. **Generator** — Query the graph, assemble context, prompt LLM, produce wiki pages

## 3. Data model

Adapted from CodeGraph's battle-tested schema, trimmed to what wiki generation needs.

### 3.1 Symbol nodes

```typescript
interface SymbolNode {
  /** Unique ID: hash of filePath + qualifiedName */
  id: string;

  /** What kind of code element */
  kind: NodeKind;

  /** Simple name: "calculateTotal" */
  name: string;

  /** Fully qualified: "src/utils.ts::MathHelper.calculateTotal" */
  qualifiedName: string;

  /** Relative file path */
  filePath: string;

  /** Detected language */
  language: Language;

  /** Location in source */
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;

  /** Optional metadata */
  signature?: string;
  docstring?: string;
  visibility?: "public" | "private" | "protected" | "internal";
  isExported?: boolean;
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  decorators?: string[];

  /** Content hash for incremental updates */
  contentHash: string;

  /** Timestamp */
  updatedAt: number;
}
```

Node kinds (from CodeGraph, covers all common patterns):

```typescript
type NodeKind =
  | "file"
  | "module"
  | "class"
  | "struct"
  | "interface"
  | "trait"
  | "protocol"
  | "function"
  | "method"
  | "property"
  | "field"
  | "variable"
  | "constant"
  | "enum"
  | "enum_member"
  | "type_alias"
  | "namespace"
  | "import"
  | "export"
  | "route"
  | "component";
```

### 3.2 Edges

```typescript
interface Edge {
  /** Source symbol ID */
  source: string;

  /** Target symbol ID */
  target: string;

  /** Relationship type */
  kind: EdgeKind;

  /** Where the relationship occurs in source */
  line?: number;
  column?: number;

  /** How this edge was discovered */
  provenance: "tree-sitter" | "import-resolution" | "scope-resolution" | "heuristic";
}
```

Edge kinds:

```typescript
type EdgeKind =
  | "contains"      // file→class, class→method
  | "calls"         // function calls function
  | "imports"       // file imports from file
  | "exports"       // file exports symbol
  | "extends"       // class extends class
  | "implements"    // class implements interface
  | "references"    // generic symbol reference
  | "type_of"       // variable/param has type
  | "returns"       // function returns type
  | "instantiates"  // creates instance of class
  | "overrides"     // method overrides parent
  | "decorates";    // decorator applied to symbol
```

### 3.3 File records

```typescript
interface FileRecord {
  path: string;
  language: Language;
  contentHash: string;
  size: number;
  modifiedAt: number;
  indexedAt: number;
  nodeCount: number;
  errors?: ExtractionError[];
}
```

### 3.4 Unresolved references

Extracted during the per-file pass, resolved in the cross-file pass:

```typescript
interface UnresolvedReference {
  fromNodeId: string;
  referenceName: string;
  referenceKind: EdgeKind;
  filePath: string;
  language: Language;
  line: number;
  column: number;
  candidates?: string[];
}
```

## 4. Pipeline stages

### 4.1 Scanner

Finds source files in a project directory.

- Uses `git ls-files` when inside a git repo (fast, respects .gitignore)
- Falls back to filesystem walk with .gitignore parsing
- Filters: max file size (1MB), ignore patterns (node_modules, dist, build, .git, __pycache__, venv, etc.)
- Detects language from file extension
- Returns `FileRecord[]` with content hashes for incremental updates

Adapted from: CodeGraph's `ExtractionOrchestrator` scanning phase.

### 4.2 Extractor

Parses each file with tree-sitter, emits symbols and intra-file edges.

Per-language extractors implement a shared interface:

```typescript
interface LanguageExtractor {
  language: Language;
  extensions: string[];

  extract(
    source: string,
    filePath: string,
    tree: Tree,
  ): ExtractionResult;
}
```

Each extractor:
1. Walks the AST top-down
2. Identifies symbol nodes (classes, functions, methods, etc.)
3. Extracts metadata: name, signature, docstring, visibility, decorators
4. Builds the containment tree (file→class→method) as `contains` edges
5. Identifies local references: function calls, type references, attribute access
6. Returns unresolved references for the cross-file resolution pass

**Phase 1 languages** (covers most real-world repos):
- TypeScript / JavaScript (including JSX/TSX)
- Python

**Phase 2 languages:**
- Go
- Java
- C# 
- Rust

**Fallback:** Files without a first-class extractor get a `file` node with basic metadata (path, size, language) but no symbol-level extraction.

Adapted from: CodeGraph's `src/extraction/languages/` structure. Reference sem's scope-aware resolution for accuracy.

### 4.3 Resolver

Links symbols across file boundaries. Three resolution phases (adapted from sem):

**Phase 1 — Import resolution:**
Parse import/require/from statements per language. Map each import to a target file and optionally a specific exported symbol. Handle:
- Relative imports (`./module`, `../utils`)
- Absolute/aliased imports (`@/`, `~/`, tsconfig paths)
- Barrel re-exports (`export { x } from './other'`) — follow chain up to depth 8 with cycle detection
- Language-specific patterns (Python `from X import Y`, Go package imports, Java FQN imports)

**Phase 2 — Scope-aware resolution (sem's approach):**
For each unresolved reference:
1. Build a scope tree for the file (module → class → function → block)
2. Walk up the scope chain looking for a definition matching the reference name
3. Track variable types through assignments (`x = Foo()` → `x` has type `Foo`)
4. Resolve `self.method()` / `this.property` through the class scope

**Phase 3 — Heuristic fallback:**
For remaining unresolved references:
- Match against the global symbol table by simple name
- Filter false positives: exclude common variable names, language keywords
- Mark edges with `provenance: "heuristic"` so consumers know the confidence level

Adapted from: sem's `scope_resolve.rs` for phases 1-2, CodeGraph's `import-resolver.ts` for barrel re-export handling.

### 4.4 Store

SQLite database with FTS5 for text search.

```sql
-- Core tables
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  language TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  signature TEXT,
  docstring TEXT,
  visibility TEXT,
  is_exported INTEGER DEFAULT 0,
  is_async INTEGER DEFAULT 0,
  is_static INTEGER DEFAULT 0,
  is_abstract INTEGER DEFAULT 0,
  decorators TEXT,          -- JSON array
  content_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE edges (
  source TEXT NOT NULL REFERENCES nodes(id),
  target TEXT NOT NULL REFERENCES nodes(id),
  kind TEXT NOT NULL,
  line INTEGER,
  col INTEGER,
  provenance TEXT NOT NULL DEFAULT 'tree-sitter',
  UNIQUE(source, target, kind)
);

CREATE TABLE files (
  path TEXT PRIMARY KEY,
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  node_count INTEGER DEFAULT 0,
  errors TEXT                -- JSON array
);

CREATE TABLE unresolved_refs (
  from_node_id TEXT NOT NULL,
  reference_name TEXT NOT NULL,
  reference_kind TEXT NOT NULL,
  file_path TEXT NOT NULL,
  language TEXT NOT NULL,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  candidates TEXT            -- JSON array
);

-- Full-text search
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  name,
  qualified_name,
  docstring,
  signature,
  content='nodes',
  content_rowid='rowid'
);

-- Performance indexes
CREATE INDEX idx_nodes_file ON nodes(file_path);
CREATE INDEX idx_nodes_kind ON nodes(kind);
CREATE INDEX idx_nodes_name ON nodes(name);
CREATE INDEX idx_edges_source_kind ON edges(source, kind);
CREATE INDEX idx_edges_target_kind ON edges(target, kind);
CREATE INDEX idx_edges_kind ON edges(kind);
CREATE INDEX idx_unresolved_file ON unresolved_refs(file_path);
```

Adapted from: CodeGraph's `src/db/schema.sql`.

### 4.5 Graph queries

Built on top of the store, these power the wiki generator:

```typescript
interface GraphQueries {
  // Traversal
  getCallers(nodeId: string, depth?: number): SymbolNode[];
  getCallees(nodeId: string, depth?: number): SymbolNode[];
  getTypeHierarchy(nodeId: string): { ancestors: SymbolNode[]; descendants: SymbolNode[] };
  getChildren(nodeId: string): SymbolNode[];
  getAncestors(nodeId: string): SymbolNode[];

  // Search
  searchNodes(query: string, options?: SearchOptions): SearchResult[];
  findByQualifiedName(pattern: string): SymbolNode[];

  // Analysis
  getImpactRadius(nodeId: string, depth?: number): SymbolNode[];
  findCircularDependencies(): SymbolNode[][];
  findDeadCode(): SymbolNode[];
  getNodeMetrics(nodeId: string): NodeMetrics;

  // Context assembly (for wiki generation)
  getFileStructure(): FileTree;
  getModuleGraph(): { nodes: SymbolNode[]; edges: Edge[] };
  getSubgraph(nodeIds: string[], depth?: number): Subgraph;
  getSourceCode(nodeId: string): string;
}
```

Adapted from: CodeGraph's `src/graph/queries.ts` and `src/graph/traversal.ts`.

### 4.6 Generator (the novel part)

This is what neither CodeGraph nor sem does. It turns the knowledge graph into documentation.

**Step 1 — Structure planning:**
Query the graph for the high-level shape of the codebase:
- Top-level files and directories
- Major classes, modules, and namespaces
- Entry points (exported functions, route handlers, main files)
- Dependency clusters (groups of tightly-coupled symbols)

Prompt the LLM:
```
Given this codebase structure, generate a table of contents for a technical wiki.
8-15 top-level sections, 2-5 subsections each.
Each section should cover a coherent architectural concern.
Return as JSON: [{ title, subsections: [{ title, description, relevantSymbols }] }]
```

**Step 2 — Per-page context assembly:**
For each planned wiki page:
1. Identify the focal symbols (from the planner's `relevantSymbols`)
2. Query the graph: get their relationships, callers/callees, type hierarchies
3. Read source code for key symbols (the actual code, not just metadata)
4. Assemble a structured context object:

```typescript
interface PageContext {
  title: string;
  description: string;
  focalSymbols: SymbolNode[];
  relationships: Edge[];
  sourceBlocks: { node: SymbolNode; code: string }[];
  relatedFiles: string[];
  callChains: { from: SymbolNode; to: SymbolNode; path: SymbolNode[] }[];
  typeHierarchies: { root: SymbolNode; children: SymbolNode[] }[];
}
```

**Step 3 — Page generation:**
For each page, prompt the LLM with the assembled context:
```
Write a technical documentation page about: {title}

## Context
Symbols: {focalSymbols with signatures and docstrings}
Relationships: {edges in human-readable form}
Source code: {key source blocks with file:line citations}
Call chains: {A → B → C flow descriptions}

## Requirements
- Write a coherent technical narrative, not a symbol dump
- Include Mermaid diagrams for architecture and data flow where useful
- Cite source files as [filename:startLine-endLine]
- Cross-reference related sections: "See also: [Section X.Y](link)"
- Target audience: developer new to this codebase
```

**Step 4 — Assembly:**
- Generate index.md with the table of contents
- Add cross-references between pages
- Validate all source citations point to real files/lines
- Output as markdown files (can be rendered by any static site generator)

**LLM provider:** Configurable. Default to Claude API. Support OpenAI, Ollama for local generation.

## 5. Project structure

```
deepforge/
├── package.json
├── tsconfig.json
├── DESIGN.md                       # this document
├── CLAUDE.md                       # coding agent conventions
├── README.md
├── src/
│   ├── index.ts                    # public API: Deepforge class
│   ├── types.ts                    # SymbolNode, Edge, NodeKind, etc.
│   ├── errors.ts                   # DeepforgeError hierarchy
│   ├── scanner/
│   │   ├── index.ts                # scanProject(): find files
│   │   ├── git-scanner.ts          # git ls-files based scanning
│   │   ├── fs-scanner.ts           # filesystem walk fallback
│   │   └── ignore.ts               # .gitignore parsing
│   ├── extraction/
│   │   ├── index.ts                # ExtractionOrchestrator
│   │   ├── tree-sitter.ts          # shared tree-sitter helpers
│   │   ├── tree-sitter-types.ts    # TS types for tree-sitter WASM
│   │   └── languages/
│   │       ├── index.ts            # language registry
│   │       ├── typescript.ts       # TS/JS/JSX/TSX extractor
│   │       ├── python.ts           # Python extractor
│   │       ├── go.ts               # Go extractor
│   │       ├── java.ts             # Java extractor
│   │       ├── csharp.ts           # C# extractor
│   │       └── rust.ts             # Rust extractor
│   ├── resolution/
│   │   ├── index.ts                # ReferenceResolver orchestrator
│   │   ├── import-resolver.ts      # cross-file import resolution
│   │   ├── scope-resolver.ts       # scope-chain name resolution
│   │   └── name-matcher.ts         # heuristic fallback matching
│   ├── store/
│   │   ├── index.ts                # GraphStore class
│   │   ├── schema.sql              # SQLite schema
│   │   ├── migrations.ts           # schema versioning
│   │   └── queries.ts              # prepared statement builders
│   ├── graph/
│   │   ├── index.ts                # GraphQueryManager
│   │   ├── traversal.ts            # BFS/DFS, callers/callees
│   │   └── analysis.ts             # impact, dead code, cycles
│   ├── generator/
│   │   ├── index.ts                # WikiGenerator orchestrator
│   │   ├── planner.ts              # LLM-based TOC planning
│   │   ├── context-assembler.ts    # build PageContext from graph
│   │   ├── page-writer.ts          # LLM-based page generation
│   │   ├── diagram-builder.ts      # Mermaid diagram generation
│   │   └── assembler.ts            # stitch pages + cross-refs
│   ├── llm/
│   │   ├── index.ts                # LLM provider abstraction
│   │   ├── claude.ts               # Anthropic Claude provider
│   │   ├── openai.ts               # OpenAI provider
│   │   └── ollama.ts               # Local Ollama provider
│   └── cli/
│       ├── index.ts                # CLI entry point
│       ├── generate.ts             # deepforge generate command
│       ├── index-cmd.ts            # deepforge index command
│       ├── query.ts                # deepforge query command
│       └── status.ts               # deepforge status command
├── __tests__/
│   ├── extraction/
│   ├── resolution/
│   ├── store/
│   ├── graph/
│   ├── generator/
│   └── fixtures/                   # real code samples for testing
└── wasm/                           # tree-sitter WASM grammars
```

## 6. CLI

```bash
# Full pipeline: index + generate wiki
deepforge generate ./my-project --output ./wiki

# Index only (build the graph, skip wiki generation)
deepforge index ./my-project

# Query the graph interactively
deepforge query ./my-project "how does authentication work"

# Show graph statistics
deepforge status ./my-project

# Incremental re-index after code changes
deepforge sync ./my-project

# Re-generate wiki from existing index
deepforge generate ./my-project --output ./wiki --skip-index
```

## 7. Configuration

```json
// deepforge.config.json (optional, in project root)
{
  "languages": ["typescript", "python"],
  "ignore": ["**/*.test.ts", "**/__mocks__/**"],
  "maxFileSize": 1048576,
  "llm": {
    "provider": "claude",
    "model": "claude-sonnet-4-20250514",
    "maxTokensPerPage": 4000
  },
  "wiki": {
    "maxSections": 15,
    "maxSubsections": 5,
    "includeDiagrams": true,
    "includeSourceCitations": true,
    "outputFormat": "markdown"
  }
}
```

## 8. What we take from existing projects

### From CodeGraph (primary influence):
- Node/edge data model and type taxonomy
- SQLite schema with FTS5
- Per-language extractor architecture
- Graph traversal algorithms (BFS/DFS, callers/callees, impact)
- Worker-based parallel parsing
- Git-based file scanning with .gitignore respect
- Barrel re-export resolution chaining

### From sem (reference resolution):
- Scope-aware name resolution (scope tree → scope chain lookup)
- Type tracking through assignments
- Three-phase resolution strategy (scope → dot-chain → heuristic)
- Edge provenance tracking (confidence levels)

### Novel to Deepforge:
- LLM-based wiki structure planning
- Graph-to-context assembly for documentation pages
- LLM page generation with source citations
- Mermaid diagram generation from graph structure
- Cross-reference and table-of-contents assembly

## 9. Dependencies

**Required:**
- `web-tree-sitter` — parsing engine (WASM, cross-platform)
- `better-sqlite3` — graph storage (with `node-sqlite3-wasm` fallback)
- `commander` — CLI framework
- Language-specific tree-sitter WASM grammars

**Optional (for generation):**
- `@anthropic-ai/sdk` — Claude API client
- `openai` — OpenAI API client

**Dev:**
- `typescript`
- `vitest` — test runner
- `tsup` — bundler
- `eslint` + `prettier`

## 10. Build phases

### Phase 1: Foundation (weeks 1-2)
- [ ] Project scaffolding (package.json, tsconfig, CI)
- [ ] Type definitions (SymbolNode, Edge, NodeKind, etc.)
- [ ] Scanner (git + filesystem)
- [ ] SQLite store with schema
- [ ] Tree-sitter WASM setup

### Phase 2: TypeScript/Python extraction (weeks 3-4)
- [ ] Tree-sitter helper layer
- [ ] TypeScript/JavaScript extractor (classes, functions, methods, imports, exports)
- [ ] Python extractor (classes, functions, methods, imports)
- [ ] Containment edge extraction (file→class→method)
- [ ] Local call/reference extraction

### Phase 3: Cross-file resolution (weeks 5-6)
- [ ] Import resolver (TS relative/absolute, Python module imports)
- [ ] Scope-aware resolution for intra-file references
- [ ] Global symbol table construction
- [ ] Barrel re-export chaining
- [ ] Heuristic fallback matcher

### Phase 4: Graph queries (week 7)
- [ ] BFS/DFS traversal with edge-kind filters
- [ ] Callers/callees recursive traversal
- [ ] Type hierarchy (extends/implements)
- [ ] Impact analysis
- [ ] FTS5 search integration

### Phase 5: Wiki generation (weeks 8-10)
- [ ] LLM provider abstraction (Claude, OpenAI, Ollama)
- [ ] Structure planner (graph → table of contents)
- [ ] Context assembler (graph query → PageContext)
- [ ] Page writer (PageContext → markdown with citations)
- [ ] Diagram builder (graph → Mermaid)
- [ ] Cross-reference assembler
- [ ] CLI: `deepforge generate`

### Phase 6: Polish (weeks 11-12)
- [ ] Incremental sync (re-index changed files only)
- [ ] Additional language extractors (Go, Java, C#, Rust)
- [ ] Output quality tuning (prompt engineering, citation accuracy)
- [ ] Performance optimization (batch parsing, parallel extraction)
- [ ] Documentation and README

## 11. Quality bar for v1

A successful v1 means: run `deepforge generate` on a medium-sized open-source repo (Flask, Express, FastAPI) and produce a wiki that a developer new to the codebase would find genuinely useful for understanding the architecture, finding relevant code, and navigating the codebase.

Specifically:
- Table of contents covers all major architectural concerns
- Each page is a coherent narrative, not a symbol dump
- Source citations point to real files and correct line numbers
- Mermaid diagrams accurately reflect the actual architecture
- Cross-references link related concepts correctly
- Total generation time under 10 minutes for a 10k-file repo
- The output is comparable in structure and depth to DeepWiki's output for the same repo

## 12. What Deepforge deliberately does not do

- **No live agent integration.** No MCP server, no real-time queries. Wiki generation is batch. Agent tooling can be added later but is not the goal.
- **No file watching.** Explicit `sync` command for incremental updates. No daemon.
- **No embedding / vector search.** The graph + FTS5 provides the retrieval layer. No need for vector similarity when you have structured relationships.
- **No hosted service.** CLI tool that runs locally. Output is static markdown files.
- **No chunking.** Symbols are the unit, not text chunks. Source code is read on demand from the filesystem during generation.
