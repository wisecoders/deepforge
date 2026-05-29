import type { SymbolNode, Edge, UnresolvedReference } from "../types.js";
import { buildSymbolIndex, resolveImports } from "./import-resolver.js";
import { resolveByName } from "./name-matcher.js";

export interface ResolutionResult {
  resolvedEdges: Edge[];
  unresolvedCount: number;
  durationMs: number;
}

export function resolveReferences(
  nodes: SymbolNode[],
  unresolvedRefs: UnresolvedReference[],
  filePaths: string[],
): ResolutionResult {
  const start = performance.now();

  const index = buildSymbolIndex(nodes);
  const fileMap = new Map<string, string>();
  for (const path of filePaths) {
    fileMap.set(path, path);
  }

  // Phase 1: import resolution
  const importEdges = resolveImports(unresolvedRefs, index, fileMap);

  const alreadyResolved = new Set<string>();
  for (const edge of importEdges) {
    for (const ref of unresolvedRefs) {
      if (ref.fromNodeId === edge.source && ref.referenceKind === edge.kind) {
        alreadyResolved.add(`${ref.fromNodeId}:${ref.referenceName}:${ref.referenceKind}`);
      }
    }
  }

  // Phase 2: name-based resolution for extends, implements, calls, etc.
  const nonImportRefs = unresolvedRefs.filter((r) => r.referenceKind !== "imports");
  const nameEdges = resolveByName(nonImportRefs, index, alreadyResolved);

  const resolvedEdges = [...importEdges, ...nameEdges];
  const resolvedKeys = new Set(
    resolvedEdges.map((e) => `${e.source}:${e.kind}`),
  );

  const unresolvedCount = unresolvedRefs.filter((r) => {
    const key = `${r.fromNodeId}:${r.referenceKind}`;
    return !resolvedKeys.has(key);
  }).length;

  return {
    resolvedEdges,
    unresolvedCount,
    durationMs: performance.now() - start,
  };
}

export { buildSymbolIndex } from "./import-resolver.js";
