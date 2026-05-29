import type { SymbolNode, Edge } from "../types.js";
import type { GraphStore } from "../store/index.js";
import { getCallees, getCallers } from "./traversal.js";

export interface NodeMetrics {
  inDegree: number;
  outDegree: number;
  fanIn: number;
  fanOut: number;
  depth: number;
}

export function getImpactRadius(
  store: GraphStore,
  nodeId: string,
  depth: number = 3,
): SymbolNode[] {
  const callers = getCallers(store, nodeId, depth);
  const visited = new Set(callers.map((n) => n.id));

  const referencing = store.getEdgesTo(nodeId, "references");
  for (const edge of referencing) {
    if (visited.has(edge.source)) continue;
    const node = store.getNode(edge.source);
    if (node) {
      callers.push(node);
      visited.add(node.id);
    }
  }

  return callers;
}

export function findDeadCode(store: GraphStore): SymbolNode[] {
  const allNodes = [
    ...store.getNodesByKind("function"),
    ...store.getNodesByKind("method"),
    ...store.getNodesByKind("class"),
  ];

  const dead: SymbolNode[] = [];
  for (const node of allNodes) {
    if (node.isExported) continue;
    if (node.name.startsWith("_")) continue;

    const incomingCalls = store.getEdgesTo(node.id, "calls");
    const incomingRefs = store.getEdgesTo(node.id, "references");
    const incomingContains = store.getEdgesTo(node.id, "contains");

    const hasExternalRef = [...incomingCalls, ...incomingRefs].some(
      (e) => {
        const src = store.getNode(e.source);
        return src && src.filePath !== node.filePath;
      },
    );

    if (
      incomingCalls.length === 0 &&
      incomingRefs.length === 0 &&
      incomingContains.length <= 1 &&
      !hasExternalRef
    ) {
      dead.push(node);
    }
  }

  return dead;
}

export function findCircularDependencies(
  store: GraphStore,
): SymbolNode[][] {
  const files = store.getAllFiles();
  const fileNodes = new Map<string, string[]>();

  for (const file of files) {
    const nodes = store.getNodesByFile(file.path);
    const importTargetFiles = new Set<string>();

    for (const node of nodes) {
      if (node.kind !== "import") continue;
      const edges = store.getEdgesFrom(node.id, "imports");
      for (const edge of edges) {
        const target = store.getNode(edge.target);
        if (target && target.filePath !== file.path) {
          importTargetFiles.add(target.filePath);
        }
      }
    }
    fileNodes.set(file.path, [...importTargetFiles]);
  }

  const cycles: SymbolNode[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  function dfs(path: string): void {
    if (inStack.has(path)) {
      const cycleStart = stack.indexOf(path);
      const cycle = stack.slice(cycleStart);
      const cycleNodes = cycle
        .map((p) => store.getNodesByFile(p).find((n) => n.kind === "file"))
        .filter((n): n is SymbolNode => n != null);
      if (cycleNodes.length > 1) cycles.push(cycleNodes);
      return;
    }
    if (visited.has(path)) return;

    visited.add(path);
    inStack.add(path);
    stack.push(path);

    const deps = fileNodes.get(path) ?? [];
    for (const dep of deps) {
      dfs(dep);
    }

    stack.pop();
    inStack.delete(path);
  }

  for (const file of files) {
    dfs(file.path);
  }

  return cycles;
}

export function getNodeMetrics(
  store: GraphStore,
  nodeId: string,
): NodeMetrics {
  const outEdges = store.getEdgesFrom(nodeId);
  const inEdges = store.getEdgesTo(nodeId);

  const callees = getCallees(store, nodeId, 1);
  const callers = getCallers(store, nodeId, 1);

  let depth = 0;
  let current = nodeId;
  while (depth < 20) {
    const parents = store.getEdgesTo(current, "contains");
    if (parents.length === 0) break;
    current = parents[0].source;
    depth++;
  }

  return {
    inDegree: inEdges.length,
    outDegree: outEdges.length,
    fanIn: callers.length,
    fanOut: callees.length,
    depth,
  };
}
