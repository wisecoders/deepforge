/**
 * Deepforge — Generate structured wiki documentation for any code repository.
 *
 * @example
 * ```typescript
 * import { Deepforge } from "deepforge";
 *
 * const forge = await Deepforge.open("./my-project");
 * await forge.index();
 * await forge.generate("./wiki");
 * forge.close();
 * ```
 */

// Core types
export type {
  SymbolNode,
  Edge,
  NodeKind,
  EdgeKind,
  Language,
  FileRecord,
  ExtractionResult,
  UnresolvedReference,
  Subgraph,
  SearchResult,
  SearchOptions,
  TraversalOptions,
  GraphStats,
  WikiStructure,
  WikiSection,
  PageContext,
  DeepforgeConfig,
} from "./types.js";

// Errors
export {
  DeepforgeError,
  ExtractionError,
  ResolutionError,
  StoreError,
  GenerationError,
  ConfigError,
} from "./errors.js";

// Scanner
export { scanProject } from "./scanner/index.js";

// Extraction
export { extractProject } from "./extraction/index.js";

// Resolution
export { resolveReferences } from "./resolution/index.js";

// Store
export { GraphStore } from "./store/index.js";

// Graph queries
export {
  getChildren,
  getCallees,
  getCallers,
  getTypeHierarchy,
  getAncestors,
  traverse,
  getImpactRadius,
  findDeadCode,
  findCircularDependencies,
  getNodeMetrics,
} from "./graph/index.js";

// Generator
export { generateWiki } from "./generator/index.js";

// LLM
export { createProvider } from "./llm/index.js";
export type { LlmProvider } from "./llm/index.js";
