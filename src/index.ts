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
