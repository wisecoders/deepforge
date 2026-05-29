import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../../src/store/index.js";
import {
  getChildren,
  getCallees,
  getCallers,
  getTypeHierarchy,
  getAncestors,
  traverse,
  getNodeMetrics,
} from "../../src/graph/index.js";
import type { SymbolNode, Edge, ExtractionResult } from "../../src/types.js";

function makeNode(overrides: Partial<SymbolNode>): SymbolNode {
  return {
    id: "default",
    kind: "function",
    name: "default",
    qualifiedName: "default",
    filePath: "test.ts",
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
  dbPath = join(tmpdir(), `deepforge-graph-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  store = new GraphStore(dbPath);
});

afterEach(() => {
  store.close();
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(dbPath + "-wal"); } catch {}
  try { unlinkSync(dbPath + "-shm"); } catch {}
});

describe("Graph queries", () => {
  describe("getChildren", () => {
    it("returns children connected by contains edges", () => {
      const nodes = [
        makeNode({ id: "class1", kind: "class", name: "MyClass" }),
        makeNode({ id: "method1", kind: "method", name: "doA" }),
        makeNode({ id: "method2", kind: "method", name: "doB" }),
      ];
      const edges: Edge[] = [
        { source: "class1", target: "method1", kind: "contains", provenance: "tree-sitter" },
        { source: "class1", target: "method2", kind: "contains", provenance: "tree-sitter" },
      ];
      store.ingestFile(
        { path: "test.ts", language: "typescript", contentHash: "a", size: 100, modifiedAt: 0, indexedAt: 0, nodeCount: 3 },
        makeResult(nodes, edges),
      );

      const children = getChildren(store, "class1");
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.name).sort()).toEqual(["doA", "doB"]);
    });
  });

  describe("getCallees / getCallers", () => {
    it("follows call edges", () => {
      const nodes = [
        makeNode({ id: "fn1", name: "main" }),
        makeNode({ id: "fn2", name: "helper" }),
        makeNode({ id: "fn3", name: "util" }),
      ];
      const edges: Edge[] = [
        { source: "fn1", target: "fn2", kind: "calls", provenance: "tree-sitter" },
        { source: "fn2", target: "fn3", kind: "calls", provenance: "tree-sitter" },
      ];
      store.ingestFile(
        { path: "test.ts", language: "typescript", contentHash: "a", size: 100, modifiedAt: 0, indexedAt: 0, nodeCount: 3 },
        makeResult(nodes, edges),
      );

      const callees = getCallees(store, "fn1", 2);
      expect(callees.map((c) => c.name)).toContain("helper");
      expect(callees.map((c) => c.name)).toContain("util");

      const callers = getCallers(store, "fn3", 2);
      expect(callers.map((c) => c.name)).toContain("helper");
      expect(callers.map((c) => c.name)).toContain("main");
    });
  });

  describe("getTypeHierarchy", () => {
    it("returns ancestors and descendants", () => {
      const nodes = [
        makeNode({ id: "c1", kind: "class", name: "Animal" }),
        makeNode({ id: "c2", kind: "class", name: "Dog" }),
        makeNode({ id: "c3", kind: "class", name: "GoldenRetriever" }),
      ];
      const edges: Edge[] = [
        { source: "c2", target: "c1", kind: "extends", provenance: "tree-sitter" },
        { source: "c3", target: "c2", kind: "extends", provenance: "tree-sitter" },
      ];
      store.ingestFile(
        { path: "test.ts", language: "typescript", contentHash: "a", size: 100, modifiedAt: 0, indexedAt: 0, nodeCount: 3 },
        makeResult(nodes, edges),
      );

      const hierarchy = getTypeHierarchy(store, "c2");
      expect(hierarchy.ancestors.map((a) => a.name)).toContain("Animal");
      expect(hierarchy.descendants.map((d) => d.name)).toContain("GoldenRetriever");
    });
  });

  describe("getAncestors (containment)", () => {
    it("walks up the containment tree", () => {
      const nodes = [
        makeNode({ id: "file1", kind: "file", name: "app.ts" }),
        makeNode({ id: "class1", kind: "class", name: "App" }),
        makeNode({ id: "method1", kind: "method", name: "run" }),
      ];
      const edges: Edge[] = [
        { source: "file1", target: "class1", kind: "contains", provenance: "tree-sitter" },
        { source: "class1", target: "method1", kind: "contains", provenance: "tree-sitter" },
      ];
      store.ingestFile(
        { path: "test.ts", language: "typescript", contentHash: "a", size: 100, modifiedAt: 0, indexedAt: 0, nodeCount: 3 },
        makeResult(nodes, edges),
      );

      const ancestors = getAncestors(store, "method1");
      expect(ancestors.map((a) => a.name)).toEqual(["App", "app.ts"]);
    });
  });

  describe("traverse", () => {
    it("performs BFS with depth limit", () => {
      const nodes = [
        makeNode({ id: "n1", name: "a" }),
        makeNode({ id: "n2", name: "b" }),
        makeNode({ id: "n3", name: "c" }),
        makeNode({ id: "n4", name: "d" }),
      ];
      const edges: Edge[] = [
        { source: "n1", target: "n2", kind: "calls", provenance: "tree-sitter" },
        { source: "n2", target: "n3", kind: "calls", provenance: "tree-sitter" },
        { source: "n3", target: "n4", kind: "calls", provenance: "tree-sitter" },
      ];
      store.ingestFile(
        { path: "test.ts", language: "typescript", contentHash: "a", size: 100, modifiedAt: 0, indexedAt: 0, nodeCount: 4 },
        makeResult(nodes, edges),
      );

      const depth1 = traverse(store, "n1", { maxDepth: 1 });
      expect(depth1).toHaveLength(1);

      const depth2 = traverse(store, "n1", { maxDepth: 2 });
      expect(depth2).toHaveLength(2);

      const all = traverse(store, "n1", { maxDepth: 10 });
      expect(all).toHaveLength(3);
    });

    it("filters by edge kind", () => {
      const nodes = [
        makeNode({ id: "n1", name: "a" }),
        makeNode({ id: "n2", name: "b" }),
        makeNode({ id: "n3", name: "c" }),
      ];
      const edges: Edge[] = [
        { source: "n1", target: "n2", kind: "calls", provenance: "tree-sitter" },
        { source: "n1", target: "n3", kind: "contains", provenance: "tree-sitter" },
      ];
      store.ingestFile(
        { path: "test.ts", language: "typescript", contentHash: "a", size: 100, modifiedAt: 0, indexedAt: 0, nodeCount: 3 },
        makeResult(nodes, edges),
      );

      const callsOnly = traverse(store, "n1", { edgeKinds: ["calls"] });
      expect(callsOnly).toHaveLength(1);
      expect(callsOnly[0].name).toBe("b");
    });
  });

  describe("getNodeMetrics", () => {
    it("computes degree metrics", () => {
      const nodes = [
        makeNode({ id: "n1", name: "caller" }),
        makeNode({ id: "n2", name: "target" }),
        makeNode({ id: "n3", name: "other" }),
      ];
      const edges: Edge[] = [
        { source: "n1", target: "n2", kind: "calls", provenance: "tree-sitter" },
        { source: "n3", target: "n2", kind: "calls", provenance: "tree-sitter" },
      ];
      store.ingestFile(
        { path: "test.ts", language: "typescript", contentHash: "a", size: 100, modifiedAt: 0, indexedAt: 0, nodeCount: 3 },
        makeResult(nodes, edges),
      );

      const metrics = getNodeMetrics(store, "n2");
      expect(metrics.inDegree).toBe(2);
      expect(metrics.fanIn).toBe(2);
    });
  });
});
