import { describe, it, expect } from "vitest";
import { resolveReferences } from "../../src/resolution/index.js";
import { buildSymbolIndex } from "../../src/resolution/import-resolver.js";
import type { SymbolNode, UnresolvedReference } from "../../src/types.js";

function makeNode(overrides: Partial<SymbolNode>): SymbolNode {
  return {
    id: "default",
    kind: "function",
    name: "default",
    qualifiedName: "default",
    filePath: "file.ts",
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

describe("Resolution", () => {
  describe("buildSymbolIndex", () => {
    it("indexes nodes by id, name, qualifiedName, and file", () => {
      const nodes = [
        makeNode({ id: "n1", name: "Foo", qualifiedName: "a.ts::Foo", filePath: "a.ts" }),
        makeNode({ id: "n2", name: "Bar", qualifiedName: "b.ts::Bar", filePath: "b.ts" }),
        makeNode({ id: "n3", name: "Foo", qualifiedName: "c.ts::Foo", filePath: "c.ts" }),
      ];
      const index = buildSymbolIndex(nodes);

      expect(index.byId.get("n1")?.name).toBe("Foo");
      expect(index.byName.get("Foo")?.length).toBe(2);
      expect(index.byQualifiedName.get("a.ts::Foo")?.id).toBe("n1");
      expect(index.byFile.get("a.ts")?.length).toBe(1);
    });

    it("tracks exported symbols", () => {
      const nodes = [
        makeNode({ id: "n1", name: "Foo", filePath: "a.ts", isExported: true, kind: "class" }),
        makeNode({ id: "n2", name: "bar", filePath: "a.ts", kind: "function" }),
      ];
      const index = buildSymbolIndex(nodes);
      expect(index.exports.get("a.ts")?.length).toBe(1);
    });
  });

  describe("resolveReferences", () => {
    it("resolves extends references by name", () => {
      const nodes = [
        makeNode({ id: "n1", name: "BaseEmitter", qualifiedName: "a.ts::BaseEmitter", filePath: "a.ts", isExported: true, kind: "class" }),
        makeNode({ id: "n2", name: "TypedEmitter", qualifiedName: "b.ts::TypedEmitter", filePath: "b.ts", kind: "class" }),
      ];
      const refs: UnresolvedReference[] = [
        {
          fromNodeId: "n2",
          referenceName: "BaseEmitter",
          referenceKind: "extends",
          filePath: "b.ts",
          language: "typescript",
          line: 1,
          column: 0,
        },
      ];

      const result = resolveReferences(nodes, refs, ["a.ts", "b.ts"]);
      expect(result.resolvedEdges.length).toBe(1);
      expect(result.resolvedEdges[0].source).toBe("n2");
      expect(result.resolvedEdges[0].target).toBe("n1");
      expect(result.resolvedEdges[0].kind).toBe("extends");
    });

    it("resolves call references by name", () => {
      const nodes = [
        makeNode({ id: "n1", name: "helper", qualifiedName: "utils.ts::helper", filePath: "utils.ts", isExported: true }),
        makeNode({ id: "n2", name: "main", qualifiedName: "app.ts::main", filePath: "app.ts" }),
      ];
      const refs: UnresolvedReference[] = [
        {
          fromNodeId: "n2",
          referenceName: "helper",
          referenceKind: "calls",
          filePath: "app.ts",
          language: "typescript",
          line: 5,
          column: 4,
        },
      ];

      const result = resolveReferences(nodes, refs, ["utils.ts", "app.ts"]);
      expect(result.resolvedEdges.length).toBe(1);
      expect(result.resolvedEdges[0].kind).toBe("calls");
    });

    it("skips built-in names", () => {
      const nodes = [
        makeNode({ id: "n1", name: "main", qualifiedName: "app.ts::main", filePath: "app.ts" }),
      ];
      const refs: UnresolvedReference[] = [
        {
          fromNodeId: "n1",
          referenceName: "console",
          referenceKind: "calls",
          filePath: "app.ts",
          language: "typescript",
          line: 2,
          column: 0,
        },
      ];

      const result = resolveReferences(nodes, refs, ["app.ts"]);
      expect(result.resolvedEdges.length).toBe(0);
    });

    it("reports unresolved count", () => {
      const nodes = [
        makeNode({ id: "n1", name: "main", filePath: "app.ts" }),
      ];
      const refs: UnresolvedReference[] = [
        {
          fromNodeId: "n1",
          referenceName: "UnknownType",
          referenceKind: "extends",
          filePath: "app.ts",
          language: "typescript",
          line: 1,
          column: 0,
        },
      ];

      const result = resolveReferences(nodes, refs, ["app.ts"]);
      expect(result.unresolvedCount).toBe(1);
    });
  });
});
