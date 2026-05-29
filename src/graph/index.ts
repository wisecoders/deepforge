export {
  getChildren,
  getCallees,
  getCallers,
  getTypeHierarchy,
  getAncestors,
  traverse,
} from "./traversal.js";

export {
  getImpactRadius,
  findDeadCode,
  findCircularDependencies,
  getNodeMetrics,
} from "./analysis.js";

export type { NodeMetrics } from "./analysis.js";
