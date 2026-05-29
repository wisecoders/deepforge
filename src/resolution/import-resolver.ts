import type { SymbolNode, Edge, UnresolvedReference } from "../types.js";

export interface SymbolIndex {
  byId: Map<string, SymbolNode>;
  byName: Map<string, SymbolNode[]>;
  byQualifiedName: Map<string, SymbolNode>;
  byFile: Map<string, SymbolNode[]>;
  exports: Map<string, SymbolNode[]>;
}

export function buildSymbolIndex(nodes: SymbolNode[]): SymbolIndex {
  const byId = new Map<string, SymbolNode>();
  const byName = new Map<string, SymbolNode[]>();
  const byQualifiedName = new Map<string, SymbolNode>();
  const byFile = new Map<string, SymbolNode[]>();
  const exports = new Map<string, SymbolNode[]>();

  for (const node of nodes) {
    byId.set(node.id, node);
    byQualifiedName.set(node.qualifiedName, node);

    const nameList = byName.get(node.name) ?? [];
    nameList.push(node);
    byName.set(node.name, nameList);

    const fileList = byFile.get(node.filePath) ?? [];
    fileList.push(node);
    byFile.set(node.filePath, fileList);

    if (node.isExported && node.kind !== "file" && node.kind !== "import") {
      const expList = exports.get(node.filePath) ?? [];
      expList.push(node);
      exports.set(node.filePath, expList);
    }
  }

  return { byId, byName, byQualifiedName, byFile, exports };
}

export function resolveImports(
  refs: UnresolvedReference[],
  index: SymbolIndex,
  fileMap: Map<string, string>,
): Edge[] {
  const edges: Edge[] = [];

  const importRefs = refs.filter((r) => r.referenceKind === "imports");

  for (const ref of importRefs) {
    const candidates = ref.candidates ?? [];
    for (const candidate of candidates) {
      const resolvedPath = resolveModulePath(candidate, ref.filePath, fileMap);
      if (!resolvedPath) continue;

      const exported = index.exports.get(resolvedPath) ?? [];
      const match = exported.find((e) => e.name === ref.referenceName);
      if (match) {
        edges.push({
          source: ref.fromNodeId,
          target: match.id,
          kind: "imports",
          line: ref.line,
          column: ref.column,
          provenance: "import-resolution",
        });
      }
    }
  }

  return edges;
}

function resolveModulePath(
  modulePath: string,
  fromFile: string,
  fileMap: Map<string, string>,
): string | undefined {
  if (!modulePath.startsWith(".")) {
    return undefined;
  }

  const fromDir = fromFile.split("/").slice(0, -1).join("/");
  const segments = modulePath.split("/");
  const resolved: string[] = fromDir ? fromDir.split("/") : [];

  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }

  const base = resolved.join("/");

  const extensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".cs", ""];
  const suffixes = ["", "/index"];

  for (const suffix of suffixes) {
    for (const ext of extensions) {
      const candidate = base + suffix + ext;
      if (fileMap.has(candidate)) return candidate;
    }
  }

  return undefined;
}
