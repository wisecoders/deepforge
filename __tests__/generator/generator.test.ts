import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../../src/store/index.js";
import { assemblePageContext } from "../../src/generator/context-assembler.js";
import { assembleWiki, pagePathFromNumber } from "../../src/generator/assembler.js";
import type { SymbolNode, Edge, ExtractionResult, WikiStructure } from "../../src/types.js";

function makeNode(overrides: Partial<SymbolNode>): SymbolNode {
  return {
    id: "default",
    kind: "function",
    name: "default",
    qualifiedName: "default",
    filePath: "src/app.ts",
    language: "typescript",
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 0,
    contentHash: "abc",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeResult(nodes: SymbolNode[], edges: Edge[] = []): ExtractionResult {
  return { nodes, edges, unresolvedReferences: [], errors: [], durationMs: 0 };
}

let store: GraphStore;
let dbPath: string;

beforeEach(() => {
  dbPath = join(tmpdir(), `deepforge-gen-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  store = new GraphStore(dbPath);
});

afterEach(() => {
  store.close();
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(dbPath + "-wal"); } catch {}
  try { unlinkSync(dbPath + "-shm"); } catch {}
});

describe("Context assembler", () => {
  it("assembles context from section with symbol IDs", () => {
    const nodes = [
      makeNode({ id: "n1", kind: "class", name: "UserService", isExported: true }),
      makeNode({ id: "n2", kind: "method", name: "getUser" }),
    ];
    const edges: Edge[] = [
      { source: "n1", target: "n2", kind: "contains", provenance: "tree-sitter" },
    ];
    store.ingestFile(
      { path: "src/app.ts", language: "typescript", contentHash: "a", size: 100, modifiedAt: 0, indexedAt: 0, nodeCount: 2 },
      makeResult(nodes, edges),
    );

    const section = {
      number: "1",
      title: "User Service",
      description: "The user service module",
      relevantSymbolIds: ["n1"],
      subsections: [],
    };

    const ctx = assemblePageContext(section, store, tmpdir());
    expect(ctx.focalSymbols).toHaveLength(1);
    expect(ctx.focalSymbols[0].name).toBe("UserService");
    expect(ctx.title).toBe("User Service");
    expect(ctx.relatedFiles).toContain("src/app.ts");
  });

  it("falls back to FTS search when no symbol IDs match", () => {
    const nodes = [
      makeNode({ id: "n1", kind: "class", name: "UserService", isExported: true }),
    ];
    store.ingestFile(
      { path: "src/app.ts", language: "typescript", contentHash: "a", size: 100, modifiedAt: 0, indexedAt: 0, nodeCount: 1 },
      makeResult(nodes),
    );

    const section = {
      number: "1",
      title: "UserService",
      description: "User management",
      relevantSymbolIds: ["nonexistent"],
      subsections: [],
    };

    const ctx = assemblePageContext(section, store, tmpdir());
    expect(ctx.focalSymbols.length).toBeGreaterThan(0);
  });
});

describe("Wiki assembler", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = join(tmpdir(), `deepforge-wiki-test-${Date.now()}`);
  });

  afterEach(() => {
    try { rmSync(outputDir, { recursive: true }); } catch {}
  });

  it("writes index.md and page files", () => {
    const structure: WikiStructure = {
      title: "Test Wiki",
      description: "A test wiki",
      sections: [
        {
          number: "1",
          title: "Overview",
          description: "System overview",
          relevantSymbolIds: [],
          subsections: [],
        },
      ],
    };

    const pages = [
      {
        path: "1-overview.md",
        title: "Overview",
        number: "1",
        content: "This is the overview page.",
      },
    ];

    assembleWiki(structure, pages, outputDir);

    expect(existsSync(join(outputDir, "index.md"))).toBe(true);
    expect(existsSync(join(outputDir, "1-overview.md"))).toBe(true);

    const index = readFileSync(join(outputDir, "index.md"), "utf-8");
    expect(index).toContain("Test Wiki");
    expect(index).toContain("1-overview.md");

    const page = readFileSync(join(outputDir, "1-overview.md"), "utf-8");
    expect(page).toContain("Overview");
    expect(page).toContain("This is the overview page.");
  });
});

describe("pagePathFromNumber", () => {
  it("generates slug paths", () => {
    expect(pagePathFromNumber("1", "Architecture Overview")).toBe(
      "1-architecture-overview.md",
    );
    expect(pagePathFromNumber("2.1", "Auth Service")).toBe(
      "2.1-auth-service.md",
    );
  });
});
