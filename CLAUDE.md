# Deepforge — Coding Agent Conventions

Read DESIGN.md first. It describes the architecture, data model, and pipeline stages.

## Project structure

TypeScript project. Node.js 20+. ESM modules throughout.

```
src/
  types.ts          — All type definitions. Single source of truth.
  errors.ts         — Error class hierarchy.
  scanner/          — Find source files in a project.
  extraction/       — Parse files with tree-sitter, extract symbols + edges.
  resolution/       — Cross-file reference resolution.
  store/            — SQLite graph storage with FTS5.
  graph/            — Graph query algorithms (traversal, search, analysis).
  generator/        — LLM-based wiki generation pipeline.
  llm/              — LLM provider abstraction (Claude, OpenAI, Ollama).
  cli/              — CLI entry point.
__tests__/          — Tests mirror src/ structure.
wasm/               — Tree-sitter WASM grammar files.
```

## Commands

```bash
npm run build       # Build with tsup
npm run test        # Run tests with vitest
npm run typecheck   # Type-check with tsc --noEmit
npm run lint        # Lint with eslint
```

## Conventions

- All types live in `src/types.ts`. Do not scatter type definitions across files.
- Errors extend the hierarchy in `src/errors.ts`.
- Each pipeline stage (scanner, extraction, resolution, store, graph, generator) is independently testable.
- Per-language extractors implement the `LanguageExtractor` interface from `extraction/languages/index.ts`.
- SQLite schema lives in `store/schema.sql`. Changes require a migration in `store/migrations.ts`.
- Tests use real code fixtures from `__tests__/fixtures/`, not synthetic examples.
- Prefer `better-sqlite3` synchronous API. SQLite is single-writer; async adds complexity without benefit.
- Tree-sitter runs via WASM (`web-tree-sitter`), not native bindings. This ensures cross-platform compatibility.

## Pipeline flow

```
Scanner → Extractor → Resolver → Store → Graph Queries → Generator → Wiki
```

Each stage takes the output of the previous stage. No stage reaches back to call an earlier one.

## Testing

- Extraction tests: parse a fixture file, assert the correct symbols and edges are extracted.
- Resolution tests: provide two files with cross-references, assert edges are created.
- Store tests: insert nodes/edges, query them back.
- Graph tests: build a small graph, test traversal algorithms.
- Generator tests: mock the LLM, test context assembly and output formatting.
