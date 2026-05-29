import type { SymbolNode, Edge, TraversalOptions } from "../types.js";
import type { GraphStore } from "../store/index.js";

export function getChildren(store: GraphStore, nodeId: string): SymbolNode[] {
  const edges = store.getEdgesFrom(nodeId, "contains");
  return edges
    .map((e) => store.getNode(e.target))
    .filter((n): n is SymbolNode => n != null);
}

export function getCallees(
  store: GraphStore,
  nodeId: string,
  depth: number = 1,
): SymbolNode[] {
  return traverseEdges(store, nodeId, "calls", "outgoing", depth);
}

export function getCallers(
  store: GraphStore,
  nodeId: string,
  depth: number = 1,
): SymbolNode[] {
  return traverseEdges(store, nodeId, "calls", "incoming", depth);
}

export function getTypeHierarchy(
  store: GraphStore,
  nodeId: string,
): { ancestors: SymbolNode[]; descendants: SymbolNode[] } {
  const ancestors = traverseEdges(store, nodeId, "extends", "outgoing", 10);
  const implementedAncestors = traverseEdges(store, nodeId, "implements", "outgoing", 10);
  const descendants = traverseEdges(store, nodeId, "extends", "incoming", 10);

  return {
    ancestors: [...ancestors, ...implementedAncestors],
    descendants,
  };
}

export function getAncestors(store: GraphStore, nodeId: string): SymbolNode[] {
  const containsEdges = store.getEdgesTo(nodeId, "contains");
  const result: SymbolNode[] = [];
  for (const edge of containsEdges) {
    const parent = store.getNode(edge.source);
    if (parent) {
      result.push(parent);
      result.push(...getAncestors(store, parent.id));
    }
  }
  return result;
}

export function traverse(
  store: GraphStore,
  startId: string,
  options: TraversalOptions = {},
): SymbolNode[] {
  const maxDepth = options.maxDepth ?? 3;
  const direction = options.direction ?? "outgoing";
  const limit = options.limit ?? 100;
  const edgeKinds = options.edgeKinds;
  const nodeKinds = options.nodeKinds;

  const visited = new Set<string>();
  const result: SymbolNode[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

  if (options.includeStart) {
    const startNode = store.getNode(startId);
    if (startNode) result.push(startNode);
  }

  while (queue.length > 0 && result.length < limit) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    if (visited.has(id)) continue;
    visited.add(id);

    const edges =
      direction === "incoming"
        ? store.getEdgesTo(id)
        : direction === "outgoing"
          ? store.getEdgesFrom(id)
          : [...store.getEdgesFrom(id), ...store.getEdgesTo(id)];

    for (const edge of edges) {
      if (edgeKinds && !edgeKinds.includes(edge.kind)) continue;

      const targetId = direction === "incoming" ? edge.source : edge.target;
      if (visited.has(targetId)) continue;

      const node = store.getNode(targetId);
      if (!node) continue;
      if (nodeKinds && !nodeKinds.includes(node.kind)) continue;

      result.push(node);
      queue.push({ id: targetId, depth: depth + 1 });
    }
  }

  return result;
}

function traverseEdges(
  store: GraphStore,
  startId: string,
  edgeKind: string,
  direction: "outgoing" | "incoming",
  maxDepth: number,
): SymbolNode[] {
  const visited = new Set<string>();
  const result: SymbolNode[] = [];
  const queue: Array<{ id: string; depth: number }> = [
    { id: startId, depth: 0 },
  ];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    if (visited.has(id)) continue;
    visited.add(id);

    const edges =
      direction === "outgoing"
        ? store.getEdgesFrom(id, edgeKind)
        : store.getEdgesTo(id, edgeKind);

    for (const edge of edges) {
      const targetId =
        direction === "outgoing" ? edge.target : edge.source;
      if (visited.has(targetId)) continue;

      const node = store.getNode(targetId);
      if (!node) continue;
      result.push(node);
      queue.push({ id: targetId, depth: depth + 1 });
    }
  }

  return result;
}
