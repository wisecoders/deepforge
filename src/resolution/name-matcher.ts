import type { Edge, UnresolvedReference } from "../types.js";
import type { SymbolIndex } from "./import-resolver.js";

const SKIP_NAMES = new Set([
  "this", "self", "super", "cls",
  "true", "false", "null", "undefined", "None",
  "console", "window", "document", "global", "process",
  "Error", "Promise", "Array", "Map", "Set", "WeakMap", "WeakSet",
  "RegExp", "Date", "Math", "JSON", "Symbol", "Proxy", "Reflect",
]);

export function resolveByName(
  refs: UnresolvedReference[],
  index: SymbolIndex,
  alreadyResolved: Set<string>,
): Edge[] {
  const edges: Edge[] = [];

  for (const ref of refs) {
    const key = `${ref.fromNodeId}:${ref.referenceName}:${ref.referenceKind}`;
    if (alreadyResolved.has(key)) continue;

    const name = ref.referenceName.includes(".")
      ? ref.referenceName.split(".").pop()!
      : ref.referenceName;

    if (SKIP_NAMES.has(name)) continue;

    const candidates = index.byName.get(name);
    if (!candidates || candidates.length === 0) continue;

    // Filter: prefer symbols not in the same file, exclude file/import nodes
    const external = candidates.filter(
      (c) =>
        c.filePath !== ref.filePath &&
        c.kind !== "file" &&
        c.kind !== "import",
    );

    const sameFile = candidates.filter(
      (c) =>
        c.filePath === ref.filePath &&
        c.kind !== "file" &&
        c.kind !== "import" &&
        c.id !== ref.fromNodeId,
    );

    const best = external.length > 0 ? external : sameFile;
    if (best.length === 0) continue;

    // If ambiguous (multiple matches), pick the one that's exported or best-scoped
    const target =
      best.find((c) => c.isExported) ?? best[0];

    edges.push({
      source: ref.fromNodeId,
      target: target.id,
      kind: ref.referenceKind,
      line: ref.line,
      column: ref.column,
      provenance: best === external ? "scope-resolution" : "heuristic",
    });
  }

  return edges;
}
