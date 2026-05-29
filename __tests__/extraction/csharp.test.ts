import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import { csharpExtractor } from "../../src/extraction/languages/csharp.js";
import type { ExtractionResult, SymbolNode, Edge } from "../../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "../fixtures/sample.cs");
const WASM_PATH = resolve(__dirname, "../../wasm/tree-sitter-c_sharp.wasm");

let result: ExtractionResult;

beforeAll(async () => {
  await Parser.init();
  const parser = new Parser();
  const lang = await Language.load(WASM_PATH);
  parser.setLanguage(lang);
  const source = readFileSync(FIXTURE_PATH, "utf-8");
  const tree = parser.parse(source);
  result = csharpExtractor.extract(source, "fixtures/sample.cs", tree);
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

describe("C# extractor", () => {
  it("produces a result without errors", () => {
    expect(result.errors).toHaveLength(0);
  });

  it("extracts file node", () => {
    const file = findNode("sample.cs");
    expect(file).toBeDefined();
    expect(file!.kind).toBe("file");
  });

  it("extracts namespace", () => {
    const ns = result.nodes.find((n) => n.kind === "namespace");
    expect(ns).toBeDefined();
    expect(ns!.name).toBe("MyApp.Services");
  });

  describe("interfaces", () => {
    it("extracts IService interface", () => {
      const node = findNode("IService");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("interface");
      expect(node!.visibility).toBe("public");
    });
  });

  describe("classes", () => {
    it("extracts BaseService abstract class", () => {
      const node = findNode("BaseService");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("class");
      expect(node!.isAbstract).toBe(true);
      expect(node!.visibility).toBe("public");
      expect(node!.docstring).toContain("Base service class");
    });

    it("extracts ConcreteService class", () => {
      const node = findNode("ConcreteService");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("class");
    });

    it("extracts static class", () => {
      const node = findNode("Constants");
      expect(node).toBeDefined();
      expect(node!.isStatic).toBe(true);
    });
  });

  describe("methods", () => {
    it("extracts methods", () => {
      const methods = findNodes("method");
      const names = methods.map((m) => m.name);
      expect(names).toContain("Execute");
      expect(names).toContain("RunAsync");
      expect(names).toContain("Dispose");
    });

    it("marks async methods", () => {
      const run = result.nodes.find(
        (n) => n.name === "RunAsync" && n.kind === "method" && n.isAsync,
      );
      expect(run).toBeDefined();
      expect(run!.isAsync).toBe(true);
    });

    it("marks abstract methods", () => {
      const exec = result.nodes.find(
        (n) => n.name === "Execute" && n.isAbstract,
      );
      expect(exec).toBeDefined();
    });
  });

  describe("properties and fields", () => {
    it("extracts properties", () => {
      const node = findNode("Name");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("property");
    });

    it("extracts fields", () => {
      const node = findNode("_logger");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("field");
    });

    it("extracts constants", () => {
      const node = findNode("MaxRetries");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("constant");
    });
  });

  describe("enums", () => {
    it("extracts enum", () => {
      const node = findNode("LogLevel");
      expect(node).toBeDefined();
      expect(node!.kind).toBe("enum");
    });

    it("extracts enum members", () => {
      const members = findNodes("enum_member");
      const names = members.map((m) => m.name);
      expect(names).toContain("Debug");
      expect(names).toContain("Info");
      expect(names).toContain("Warn");
      expect(names).toContain("Error");
    });
  });

  describe("imports", () => {
    it("extracts using directives", () => {
      const imports = findNodes("import");
      const names = imports.map((i) => i.name);
      expect(names).toContain("System");
      expect(names).toContain("System.Collections.Generic");
    });
  });

  describe("edges", () => {
    it("creates containment edges", () => {
      const contains = findEdges("contains");
      expect(contains.length).toBeGreaterThan(10);
    });
  });

  describe("unresolved references", () => {
    it("creates extends/implements references for base classes", () => {
      const baseService = findNode("BaseService");
      const refs = result.unresolvedReferences.filter(
        (r) => r.fromNodeId === baseService!.id,
      );
      const names = refs.map((r) => r.referenceName);
      expect(names).toContain("IService");
    });

    it("creates instantiates references", () => {
      const instantiates = result.unresolvedReferences.filter(
        (r) => r.referenceKind === "instantiates",
      );
      expect(instantiates.length).toBeGreaterThan(0);
      expect(instantiates.map((r) => r.referenceName)).toContain("Helper");
    });

    it("creates call references", () => {
      const calls = result.unresolvedReferences.filter(
        (r) => r.referenceKind === "calls",
      );
      expect(calls.length).toBeGreaterThan(0);
    });
  });
});
