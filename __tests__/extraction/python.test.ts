import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import { pythonExtractor } from "../../src/extraction/languages/python.js";
import type { ExtractionResult, SymbolNode, Edge } from "../../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "../fixtures/sample.py");
const WASM_PATH = resolve(__dirname, "../../wasm/tree-sitter-python.wasm");

let result: ExtractionResult;

beforeAll(async () => {
  await Parser.init();
  const parser = new Parser();
  const lang = await Language.load(WASM_PATH);
  parser.setLanguage(lang);

  const source = readFileSync(FIXTURE_PATH, "utf-8");
  const tree = parser.parse(source);

  result = pythonExtractor.extract(source, "fixtures/sample.py", tree);
});

function findNode(name: string): SymbolNode | undefined {
  return result.nodes.find((n) => n.name === name);
}

function findNodes(kind: string): SymbolNode[] {
  return result.nodes.filter((n) => n.kind === kind);
}

function findEdges(kind: string): Edge[] {
  return result.edges.filter((e) => e.kind === kind);
}

describe("Python extractor", () => {
  it("produces a result without errors", () => {
    expect(result.errors).toHaveLength(0);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("extracts a file node", () => {
    const file = findNode("sample.py");
    expect(file).toBeDefined();
    expect(file!.kind).toBe("file");
    expect(file!.language).toBe("python");
  });

  describe("classes", () => {
    it("extracts EventHandler class with docstring", () => {
      const node = findNode("EventHandler");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("class");
      expect(node!.docstring).toContain("Interface for handling events");
    });

    it("extracts BaseEmitter class with docstring", () => {
      const node = findNode("BaseEmitter");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("class");
      expect(node!.docstring).toContain("Base class");
    });

    it("extracts TypedEmitter class", () => {
      const node = findNode("TypedEmitter");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("class");
    });
  });

  describe("methods", () => {
    it("extracts methods inside classes", () => {
      const methods = findNodes("method");
      const names = methods.map((m) => m.name);
      expect(names).toContain("handle");
      expect(names).toContain("__init__");
      expect(names).toContain("emit");
      expect(names).toContain("dispose");
      expect(names).toContain("wait_for");
    });

    it("marks async methods", () => {
      const waitFor = result.nodes.find(
        (n) => n.name === "wait_for" && n.kind === "method",
      );
      expect(waitFor).toBeDefined();
      expect(waitFor!.isAsync).toBe(true);
    });

    it("marks static methods", () => {
      const create = result.nodes.find(
        (n) => n.name === "create" && n.kind === "method",
      );
      expect(create).toBeDefined();
      expect(create!.isStatic).toBe(true);
    });
  });

  describe("functions", () => {
    it("extracts top-level functions", () => {
      const node = findNode("create_emitter");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("function");
    });
  });

  describe("constants", () => {
    it("extracts module-level constants", () => {
      const node = findNode("MAX_LISTENERS");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("constant");
    });
  });

  describe("imports", () => {
    it("extracts import statements", () => {
      const imports = findNodes("import");
      const names = imports.map((i) => i.name);
      expect(names).toContain("os");
      expect(names).toContain("pathlib");
      expect(names).toContain("typing");
    });
  });

  describe("edges", () => {
    it("creates containment edges from file to top-level symbols", () => {
      const containsEdges = findEdges("contains");
      expect(containsEdges.length).toBeGreaterThan(5);
    });

    it("creates containment edges from class to methods", () => {
      const baseEmitter = findNode("BaseEmitter");
      const containsEdges = findEdges("contains").filter(
        (e) => e.source === baseEmitter!.id,
      );
      expect(containsEdges.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("unresolved references", () => {
    it("creates extends reference for base classes", () => {
      const typedEmitter = findNode("TypedEmitter");
      const extendsRefs = result.unresolvedReferences.filter(
        (r) =>
          r.fromNodeId === typedEmitter!.id && r.referenceKind === "extends",
      );
      expect(extendsRefs.length).toBe(2);
      const names = extendsRefs.map((r) => r.referenceName);
      expect(names).toContain("BaseEmitter");
      expect(names).toContain("EventHandler");
    });

    it("creates call references", () => {
      const callRefs = result.unresolvedReferences.filter(
        (r) => r.referenceKind === "calls",
      );
      expect(callRefs.length).toBeGreaterThan(0);
    });

    it("creates return type references", () => {
      const returnRefs = result.unresolvedReferences.filter(
        (r) => r.referenceKind === "returns",
      );
      expect(returnRefs.length).toBeGreaterThan(0);
      const names = returnRefs.map((r) => r.referenceName);
      expect(names).toContain("TypedEmitter");
    });
  });
});
