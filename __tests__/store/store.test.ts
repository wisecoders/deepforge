import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../../src/store/index.js";
import type {
  SymbolNode,
  Edge,
  FileRecord,
  ExtractionResult,
} from "../../src/types.js";

function makeNode(overrides: Partial<SymbolNode> = {}): SymbolNode {
  return {
    id: "node-1",
    kind: "function",
    name: "doStuff",
    qualifiedName: "src/utils.ts::doStuff",
    filePath: "src/utils.ts",
    language: "typescript",
    startLine: 10,
    endLine: 20,
    startColumn: 0,
    endColumn: 1,
    signature: "function doStuff(): void",
    docstring: "Does stuff.",
    contentHash: "abc123",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeResult(
  nodes: SymbolNode[],
  edges: Edge[] = [],
): ExtractionResult {
  return {
    nodes,
    edges,
    unresolvedReferences: [],
    errors: [],
    durationMs: 1,
  };
}

function makeFileRecord(path: string): FileRecord {
  return {
    path,
    language: "typescript",
    contentHash: "abc123",
    size: 500,
    modifiedAt: Date.now(),
    indexedAt: 0,
    nodeCount: 0,
  };
}

let store: GraphStore;
let dbPath: string;

beforeEach(() => {
  dbPath = join(tmpdir(), `deepforge-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  store = new GraphStore(dbPath);
});

afterEach(() => {
  store.close();
  try {
    unlinkSync(dbPath);
    unlinkSync(dbPath + "-wal");
    unlinkSync(dbPath + "-shm");
  } catch {
    // cleanup best-effort
  }
});

describe("GraphStore", () => {
  describe("node operations", () => {
    it("inserts and retrieves a node", () => {
      const node = makeNode();
      const file = makeFileRecord("src/utils.ts");
      store.ingestFile(file, makeResult([node]));

      const retrieved = store.getNode("node-1");
      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe("doStuff");
      expect(retrieved!.kind).toBe("function");
      expect(retrieved!.signature).toBe("function doStuff(): void");
      expect(retrieved!.docstring).toBe("Does stuff.");
    });

    it("retrieves nodes by file", () => {
      const nodes = [
        makeNode({ id: "n1", name: "foo" }),
        makeNode({ id: "n2", name: "bar" }),
      ];
      store.ingestFile(makeFileRecord("src/utils.ts"), makeResult(nodes));

      const result = store.getNodesByFile("src/utils.ts");
      expect(result).toHaveLength(2);
    });

    it("retrieves nodes by kind", () => {
      const nodes = [
        makeNode({ id: "n1", kind: "function" }),
        makeNode({ id: "n2", kind: "class" }),
        makeNode({ id: "n3", kind: "function" }),
      ];
      store.ingestFile(makeFileRecord("src/utils.ts"), makeResult(nodes));

      expect(store.getNodesByKind("function")).toHaveLength(2);
      expect(store.getNodesByKind("class")).toHaveLength(1);
    });

    it("handles boolean flags correctly", () => {
      const node = makeNode({
        isExported: true,
        isAsync: true,
        isStatic: true,
        isAbstract: true,
      });
      store.ingestFile(makeFileRecord("src/utils.ts"), makeResult([node]));

      const retrieved = store.getNode("node-1")!;
      expect(retrieved.isExported).toBe(true);
      expect(retrieved.isAsync).toBe(true);
      expect(retrieved.isStatic).toBe(true);
      expect(retrieved.isAbstract).toBe(true);
    });

    it("handles decorators as JSON array", () => {
      const node = makeNode({ decorators: ["@injectable", "@singleton"] });
      store.ingestFile(makeFileRecord("src/utils.ts"), makeResult([node]));

      const retrieved = store.getNode("node-1")!;
      expect(retrieved.decorators).toEqual(["@injectable", "@singleton"]);
    });
  });

  describe("edge operations", () => {
    it("inserts and retrieves edges", () => {
      const nodes = [
        makeNode({ id: "n1", name: "ClassA" }),
        makeNode({ id: "n2", name: "methodB" }),
      ];
      const edges: Edge[] = [
        {
          source: "n1",
          target: "n2",
          kind: "contains",
          line: 5,
          provenance: "tree-sitter",
        },
      ];
      store.ingestFile(
        makeFileRecord("src/utils.ts"),
        makeResult(nodes, edges),
      );

      const from = store.getEdgesFrom("n1");
      expect(from).toHaveLength(1);
      expect(from[0].kind).toBe("contains");

      const to = store.getEdgesTo("n2");
      expect(to).toHaveLength(1);
    });

    it("filters edges by kind", () => {
      const nodes = [
        makeNode({ id: "n1" }),
        makeNode({ id: "n2" }),
        makeNode({ id: "n3" }),
      ];
      const edges: Edge[] = [
        { source: "n1", target: "n2", kind: "contains", provenance: "tree-sitter" },
        { source: "n1", target: "n3", kind: "calls", provenance: "tree-sitter" },
      ];
      store.ingestFile(
        makeFileRecord("src/utils.ts"),
        makeResult(nodes, edges),
      );

      expect(store.getEdgesFrom("n1", "contains")).toHaveLength(1);
      expect(store.getEdgesFrom("n1", "calls")).toHaveLength(1);
    });
  });

  describe("file operations", () => {
    it("tracks file metadata", () => {
      const file = makeFileRecord("src/utils.ts");
      store.ingestFile(file, makeResult([makeNode()]));

      const retrieved = store.getFile("src/utils.ts");
      expect(retrieved).toBeDefined();
      expect(retrieved!.language).toBe("typescript");
      expect(retrieved!.nodeCount).toBe(1);
    });

    it("lists all files", () => {
      store.ingestFile(
        makeFileRecord("src/a.ts"),
        makeResult([makeNode({ id: "a1", filePath: "src/a.ts" })]),
      );
      store.ingestFile(
        makeFileRecord("src/b.ts"),
        makeResult([makeNode({ id: "b1", filePath: "src/b.ts" })]),
      );

      expect(store.getAllFiles()).toHaveLength(2);
    });
  });

  describe("re-ingestion", () => {
    it("replaces previous data for a file", () => {
      const file = makeFileRecord("src/utils.ts");
      store.ingestFile(
        file,
        makeResult([
          makeNode({ id: "old1", name: "oldFn" }),
          makeNode({ id: "old2", name: "oldClass" }),
        ]),
      );
      expect(store.getNodesByFile("src/utils.ts")).toHaveLength(2);

      store.ingestFile(
        file,
        makeResult([makeNode({ id: "new1", name: "newFn" })]),
      );
      const nodes = store.getNodesByFile("src/utils.ts");
      expect(nodes).toHaveLength(1);
      expect(nodes[0].name).toBe("newFn");
    });
  });

  describe("search", () => {
    it("finds nodes by name via FTS", () => {
      store.ingestFile(
        makeFileRecord("src/utils.ts"),
        makeResult([
          makeNode({ id: "n1", name: "calculateTotal" }),
          makeNode({ id: "n2", name: "calculateTax" }),
          makeNode({ id: "n3", name: "sendEmail" }),
        ]),
      );

      const results = store.searchNodes("calculate");
      expect(results.length).toBeGreaterThanOrEqual(2);
      const names = results.map((r) => r.node.name);
      expect(names).toContain("calculateTotal");
      expect(names).toContain("calculateTax");
    });
  });

  describe("statistics", () => {
    it("returns correct stats", () => {
      const nodes = [
        makeNode({ id: "n1", kind: "class" }),
        makeNode({ id: "n2", kind: "function" }),
        makeNode({ id: "n3", kind: "function" }),
      ];
      const edges: Edge[] = [
        { source: "n1", target: "n2", kind: "contains", provenance: "tree-sitter" },
      ];
      store.ingestFile(
        makeFileRecord("src/utils.ts"),
        makeResult(nodes, edges),
      );

      const stats = store.getStats();
      expect(stats.nodeCount).toBe(3);
      expect(stats.edgeCount).toBe(1);
      expect(stats.fileCount).toBe(1);
      expect(stats.nodesByKind["class"]).toBe(1);
      expect(stats.nodesByKind["function"]).toBe(2);
      expect(stats.edgesByKind["contains"]).toBe(1);
      expect(stats.filesByLanguage["typescript"]).toBe(1);
    });
  });
});
