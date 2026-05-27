import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import { typescriptExtractor } from "../../src/extraction/languages/typescript.js";
import type { ExtractionResult, SymbolNode, Edge } from "../../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "../fixtures/sample.ts");
const WASM_PATH = resolve(__dirname, "../../wasm/tree-sitter-typescript.wasm");

let result: ExtractionResult;

beforeAll(async () => {
  await Parser.init();
  const parser = new Parser();
  const lang = await Language.load(WASM_PATH);
  parser.setLanguage(lang);

  const source = readFileSync(FIXTURE_PATH, "utf-8");
  const tree = parser.parse(source);

  result = typescriptExtractor.extract(source, "fixtures/sample.ts", tree);
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

describe("TypeScript extractor", () => {
  it("produces a result without errors", () => {
    expect(result.errors).toHaveLength(0);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("extracts a file node", () => {
    const file = findNode("sample.ts");
    expect(file).toBeDefined();
    expect(file!.kind).toBe("file");
    expect(file!.language).toBe("typescript");
  });

  describe("interfaces", () => {
    it("extracts EventHandler interface", () => {
      const node = findNode("EventHandler");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("interface");
      expect(node!.isExported).toBe(true);
    });

    it("extracts Disposable interface", () => {
      const node = findNode("Disposable");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("interface");
    });
  });

  describe("enums", () => {
    it("extracts LogLevel enum", () => {
      const node = findNode("LogLevel");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("enum");
      expect(node!.isExported).toBe(true);
    });

    it("extracts enum members", () => {
      const members = findNodes("enum_member");
      expect(members.length).toBeGreaterThanOrEqual(4);
      const names = members.map((m) => m.name);
      expect(names).toContain("Debug");
      expect(names).toContain("Info");
      expect(names).toContain("Warn");
      expect(names).toContain("Error");
    });
  });

  describe("type aliases", () => {
    it("extracts EventCallback type alias", () => {
      const node = findNode("EventCallback");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("type_alias");
      expect(node!.isExported).toBe(true);
    });
  });

  describe("classes", () => {
    it("extracts BaseEmitter class", () => {
      const node = findNode("BaseEmitter");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("class");
      expect(node!.isExported).toBe(true);
      expect(node!.isAbstract).toBe(true);
      expect(node!.docstring).toContain("Base class");
    });

    it("extracts TypedEmitter class", () => {
      const node = findNode("TypedEmitter");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("class");
      expect(node!.isExported).toBe(true);
    });

    it("extracts methods inside classes", () => {
      const methods = findNodes("method");
      const methodNames = methods.map((m) => m.name);
      expect(methodNames).toContain("getName");
      expect(methodNames).toContain("emit");
      expect(methodNames).toContain("dispose");
      expect(methodNames).toContain("handle");
      expect(methodNames).toContain("setLevel");
    });

    it("extracts properties inside classes", () => {
      const props = findNodes("property");
      const propNames = props.map((p) => p.name);
      expect(propNames).toContain("listeners");
      expect(propNames).toContain("level");
    });

    it("marks visibility on members", () => {
      const listeners = findNode("listeners");
      expect(listeners).toBeDefined();
      expect(listeners!.visibility).toBe("private");
    });
  });

  describe("functions", () => {
    it("extracts arrow function assigned to const as function", () => {
      const node = findNode("createEmitter");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("function");
      expect(node!.isExported).toBe(true);
    });

    it("extracts async function declaration", () => {
      const node = findNode("waitForEvent");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("function");
      expect(node!.isAsync).toBe(true);
      expect(node!.isExported).toBe(true);
    });

    it("extracts non-exported function", () => {
      const node = findNode("loadConfig");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("function");
      expect(node!.isExported).toBeUndefined();
    });
  });

  describe("constants", () => {
    it("extracts DEFAULT_TIMEOUT constant", () => {
      const node = findNode("DEFAULT_TIMEOUT");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("constant");
      expect(node!.isExported).toBe(true);
    });
  });

  describe("imports", () => {
    it("extracts import statement", () => {
      const imports = findNodes("import");
      const importNames = imports.map((i) => i.name);
      expect(importNames).toContain("fs");
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
    it("creates extends reference from TypedEmitter to BaseEmitter", () => {
      const typedEmitter = findNode("TypedEmitter");
      const extendsRefs = result.unresolvedReferences.filter(
        (r) => r.fromNodeId === typedEmitter!.id && r.referenceKind === "extends",
      );
      expect(extendsRefs.length).toBe(1);
      expect(extendsRefs[0].referenceName).toBe("BaseEmitter");
    });

    it("creates implements reference from TypedEmitter to EventHandler", () => {
      const typedEmitter = findNode("TypedEmitter");
      const implRefs = result.unresolvedReferences.filter(
        (r) =>
          r.fromNodeId === typedEmitter!.id && r.referenceKind === "implements",
      );
      expect(implRefs.length).toBe(1);
      expect(implRefs[0].referenceName).toContain("EventHandler");
    });

    it("creates implements reference from BaseEmitter to Disposable", () => {
      const baseEmitter = findNode("BaseEmitter");
      const implRefs = result.unresolvedReferences.filter(
        (r) =>
          r.fromNodeId === baseEmitter!.id && r.referenceKind === "implements",
      );
      expect(implRefs.length).toBe(1);
      expect(implRefs[0].referenceName).toBe("Disposable");
    });

    it("creates call references for function calls", () => {
      const callRefs = result.unresolvedReferences.filter(
        (r) => r.referenceKind === "calls",
      );
      expect(callRefs.length).toBeGreaterThan(0);
    });

    it("creates instantiates reference for new expressions", () => {
      const instantiates = result.unresolvedReferences.filter(
        (r) => r.referenceKind === "instantiates",
      );
      expect(instantiates.length).toBeGreaterThan(0);
      const names = instantiates.map((r) => r.referenceName);
      expect(names).toContain("TypedEmitter");
    });
  });
});
