import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  SymbolNode,
  Edge,
  WikiSection,
  WikiSubsection,
  PageContext,
  SourceBlock,
  CallChain,
  TypeHierarchy,
} from "../types.js";
import type { GraphStore } from "../store/index.js";
import { getCallees, getTypeHierarchy, getChildren } from "../graph/traversal.js";

export function assemblePageContext(
  section: WikiSection | WikiSubsection,
  store: GraphStore,
  projectRoot: string,
): PageContext {
  const symbolIds = section.relevantSymbolIds;
  const focalSymbols: SymbolNode[] = [];

  for (const id of symbolIds) {
    const node = store.getNode(id);
    if (node) focalSymbols.push(node);
  }

  // If no symbols matched, try searching by section title
  if (focalSymbols.length === 0) {
    const results = store.searchNodes(section.title, { limit: 5 });
    for (const r of results) {
      focalSymbols.push(r.node);
    }
  }

  const relationships: Edge[] = [];
  const relatedFiles = new Set<string>();
  const sourceBlocks: SourceBlock[] = [];
  const callChains: CallChain[] = [];
  const typeHierarchies: TypeHierarchy[] = [];

  for (const symbol of focalSymbols) {
    relatedFiles.add(symbol.filePath);

    // Edges from/to this symbol
    const fromEdges = store.getEdgesFrom(symbol.id);
    const toEdges = store.getEdgesTo(symbol.id);
    relationships.push(...fromEdges, ...toEdges);

    // Source code
    const block = readSourceBlock(symbol, projectRoot);
    if (block) sourceBlocks.push(block);

    // Children source
    const children = getChildren(store, symbol.id);
    for (const child of children.slice(0, 5)) {
      const childBlock = readSourceBlock(child, projectRoot);
      if (childBlock) sourceBlocks.push(childBlock);
    }

    // Call chains
    const callees = getCallees(store, symbol.id, 2);
    if (callees.length > 0) {
      callChains.push({
        from: symbol,
        to: callees[callees.length - 1],
        path: [symbol, ...callees],
      });
    }

    // Type hierarchy
    if (
      symbol.kind === "class" ||
      symbol.kind === "interface" ||
      symbol.kind === "struct"
    ) {
      const hierarchy = getTypeHierarchy(store, symbol.id);
      if (hierarchy.ancestors.length > 0 || hierarchy.descendants.length > 0) {
        typeHierarchies.push({
          root: symbol,
          ...hierarchy,
        });
      }
    }
  }

  return {
    title: section.title,
    number: section.number,
    description: section.description,
    focalSymbols,
    relationships: dedupeEdges(relationships),
    sourceBlocks: sourceBlocks.slice(0, 20),
    relatedFiles: [...relatedFiles],
    callChains: callChains.slice(0, 10),
    typeHierarchies: typeHierarchies.slice(0, 5),
  };
}

function readSourceBlock(
  node: SymbolNode,
  projectRoot: string,
): SourceBlock | null {
  try {
    const fullPath = join(projectRoot, node.filePath);
    const content = readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, node.startLine - 1);
    const end = Math.min(lines.length, node.endLine);
    const code = lines.slice(start, end).join("\n");

    if (code.length > 2000) {
      return {
        node,
        code: code.slice(0, 2000) + "\n// ... truncated",
        filePath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
        language: node.language,
      };
    }

    return {
      node,
      code,
      filePath: node.filePath,
      startLine: node.startLine,
      endLine: node.endLine,
      language: node.language,
    };
  } catch {
    return null;
  }
}

function dedupeEdges(edges: Edge[]): Edge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.source}:${e.target}:${e.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
