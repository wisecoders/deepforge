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
import { getCallees, getCallers, getTypeHierarchy, getChildren } from "../graph/traversal.js";

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

  // If no symbols matched, try searching by section title and description
  if (focalSymbols.length === 0) {
    const searchTerms = `${section.title} ${section.description}`;
    const results = store.searchNodes(searchTerms, { limit: 15 });
    for (const r of results) {
      focalSymbols.push(r.node);
    }
  }

  // Expand: for each focal class/interface, also grab its members
  const memberSymbols: SymbolNode[] = [];
  for (const symbol of focalSymbols) {
    if (
      symbol.kind === "class" ||
      symbol.kind === "interface" ||
      symbol.kind === "struct" ||
      symbol.kind === "enum" ||
      symbol.kind === "namespace"
    ) {
      const children = getChildren(store, symbol.id);
      for (const child of children) {
        if (!focalSymbols.some((s) => s.id === child.id)) {
          memberSymbols.push(child);
        }
      }
    }
  }

  const allSymbols = [...focalSymbols, ...memberSymbols];
  const relationships: Edge[] = [];
  const relatedFiles = new Set<string>();
  const sourceBlocks: SourceBlock[] = [];
  const callChains: CallChain[] = [];
  const typeHierarchies: TypeHierarchy[] = [];

  for (const symbol of allSymbols) {
    relatedFiles.add(symbol.filePath);

    // Edges from/to this symbol
    const fromEdges = store.getEdgesFrom(symbol.id);
    const toEdges = store.getEdgesTo(symbol.id);
    relationships.push(...fromEdges, ...toEdges);

    // Discover related files via edges
    for (const edge of [...fromEdges, ...toEdges]) {
      const other = store.getNode(
        edge.source === symbol.id ? edge.target : edge.source,
      );
      if (other) relatedFiles.add(other.filePath);
    }
  }

  // Source code blocks — prioritize focal symbols, include members
  for (const symbol of focalSymbols.slice(0, 15)) {
    const block = readSourceBlock(symbol, projectRoot);
    if (block) sourceBlocks.push(block);
  }
  for (const member of memberSymbols.slice(0, 20)) {
    if (member.kind === "method" || member.kind === "function") {
      const block = readSourceBlock(member, projectRoot);
      if (block) sourceBlocks.push(block);
    }
  }

  // Call chains — richer traversal
  for (const symbol of focalSymbols) {
    if (
      symbol.kind === "method" ||
      symbol.kind === "function" ||
      symbol.kind === "class"
    ) {
      const callees = getCallees(store, symbol.id, 3);
      if (callees.length > 0) {
        callChains.push({
          from: symbol,
          to: callees[callees.length - 1],
          path: [symbol, ...callees],
        });
      }
      const callers = getCallers(store, symbol.id, 2);
      if (callers.length > 0) {
        callChains.push({
          from: callers[0],
          to: symbol,
          path: [...callers.reverse(), symbol],
        });
      }
    }
  }

  // Type hierarchies
  for (const symbol of focalSymbols) {
    if (
      symbol.kind === "class" ||
      symbol.kind === "interface" ||
      symbol.kind === "struct"
    ) {
      const hierarchy = getTypeHierarchy(store, symbol.id);
      if (hierarchy.ancestors.length > 0 || hierarchy.descendants.length > 0) {
        typeHierarchies.push({ root: symbol, ...hierarchy });
      }
    }
  }

  return {
    title: section.title,
    number: section.number,
    description: section.description,
    focalSymbols,
    relationships: dedupeEdges(relationships),
    sourceBlocks: sourceBlocks.slice(0, 30),
    relatedFiles: [...relatedFiles],
    callChains: callChains.slice(0, 15),
    typeHierarchies: typeHierarchies.slice(0, 10),
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

    if (code.length > 3000) {
      return {
        node,
        code: code.slice(0, 3000) + "\n// ... truncated",
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
