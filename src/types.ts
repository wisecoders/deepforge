/**
 * Deepforge core type definitions.
 *
 * Data model adapted from CodeGraph's battle-tested schema,
 * focused on what wiki generation needs.
 */

// =============================================================================
// Union types
// =============================================================================

/**
 * Symbol kinds in the knowledge graph.
 * Runtime-iterable array so the same source backs both the TS type
 * and any runtime validation (query parser, schema checks).
 */
export const NODE_KINDS = [
  "file",
  "module",
  "class",
  "struct",
  "interface",
  "trait",
  "protocol",
  "function",
  "method",
  "property",
  "field",
  "variable",
  "constant",
  "enum",
  "enum_member",
  "type_alias",
  "namespace",
  "import",
  "export",
  "route",
  "component",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * Relationship types between symbols.
 */
export const EDGE_KINDS = [
  "contains",
  "calls",
  "imports",
  "exports",
  "extends",
  "implements",
  "references",
  "type_of",
  "returns",
  "instantiates",
  "overrides",
  "decorates",
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * How an edge was discovered. Higher-confidence provenances are preferred
 * when the same edge could be inferred multiple ways.
 */
export type EdgeProvenance =
  | "tree-sitter"
  | "import-resolution"
  | "scope-resolution"
  | "heuristic";

/**
 * Supported programming languages.
 */
export const LANGUAGES = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "go",
  "rust",
  "java",
  "csharp",
  "kotlin",
  "swift",
  "ruby",
  "php",
  "cpp",
  "c",
  "unknown",
] as const;

export type Language = (typeof LANGUAGES)[number];

// =============================================================================
// Core graph types
// =============================================================================

/**
 * A symbol node in the knowledge graph.
 */
export interface SymbolNode {
  /** Unique ID: hash of filePath + qualifiedName */
  id: string;

  /** What kind of code element */
  kind: NodeKind;

  /** Simple name: "calculateTotal" */
  name: string;

  /** Fully qualified: "src/utils.ts::MathHelper.calculateTotal" */
  qualifiedName: string;

  /** File path relative to project root */
  filePath: string;

  /** Detected language */
  language: Language;

  /** Source location (1-indexed lines, 0-indexed columns) */
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;

  /** Function/method signature */
  signature?: string;

  /** Documentation string */
  docstring?: string;

  /** Visibility modifier */
  visibility?: "public" | "private" | "protected" | "internal";

  /** Whether the symbol is exported from its module */
  isExported?: boolean;

  /** Whether the symbol is async */
  isAsync?: boolean;

  /** Whether the symbol is static */
  isStatic?: boolean;

  /** Whether the symbol is abstract */
  isAbstract?: boolean;

  /** Decorators/annotations applied to this symbol */
  decorators?: string[];

  /** Content hash for change detection */
  contentHash: string;

  /** Last update timestamp (epoch ms) */
  updatedAt: number;
}

/**
 * A directed edge between two symbol nodes.
 */
export interface Edge {
  /** Source symbol ID */
  source: string;

  /** Target symbol ID */
  target: string;

  /** Relationship type */
  kind: EdgeKind;

  /** Line where the relationship occurs in source */
  line?: number;

  /** Column where the relationship occurs */
  column?: number;

  /** How this edge was discovered */
  provenance: EdgeProvenance;
}

// =============================================================================
// File tracking
// =============================================================================

/**
 * Metadata about a tracked source file.
 */
export interface FileRecord {
  /** File path relative to project root */
  path: string;

  /** Detected language */
  language: Language;

  /** Content hash for change detection */
  contentHash: string;

  /** File size in bytes */
  size: number;

  /** Last modification time (epoch ms) */
  modifiedAt: number;

  /** When the file was last indexed (epoch ms) */
  indexedAt: number;

  /** Number of symbol nodes extracted */
  nodeCount: number;

  /** Extraction errors, if any */
  errors?: ExtractionError[];
}

// =============================================================================
// Extraction types
// =============================================================================

/**
 * Result from parsing a single source file.
 */
export interface ExtractionResult {
  /** Extracted symbol nodes */
  nodes: SymbolNode[];

  /** Extracted edges (intra-file) */
  edges: Edge[];

  /** References that need cross-file resolution */
  unresolvedReferences: UnresolvedReference[];

  /** Errors encountered during extraction */
  errors: ExtractionError[];

  /** Extraction duration in milliseconds */
  durationMs: number;
}

/**
 * An error that occurred during extraction.
 */
export interface ExtractionError {
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  severity: "error" | "warning";
  code?: string;
}

/**
 * A reference that couldn't be resolved within a single file.
 * Collected during extraction, resolved in the cross-file pass.
 */
export interface UnresolvedReference {
  /** ID of the symbol containing this reference */
  fromNodeId: string;

  /** The name being referenced */
  referenceName: string;

  /** What kind of relationship this would be */
  referenceKind: EdgeKind;

  /** Source location */
  filePath: string;
  language: Language;
  line: number;
  column: number;

  /** Possible qualified names this might resolve to */
  candidates?: string[];
}

// =============================================================================
// Graph query types
// =============================================================================

/**
 * A subgraph: a slice of the full knowledge graph.
 */
export interface Subgraph {
  nodes: Map<string, SymbolNode>;
  edges: Edge[];
  roots: string[];
}

/**
 * Options for graph traversal.
 */
export interface TraversalOptions {
  maxDepth?: number;
  edgeKinds?: EdgeKind[];
  nodeKinds?: NodeKind[];
  direction?: "outgoing" | "incoming" | "both";
  limit?: number;
  includeStart?: boolean;
}

/**
 * Options for searching symbols.
 */
export interface SearchOptions {
  kinds?: NodeKind[];
  languages?: Language[];
  includePatterns?: string[];
  excludePatterns?: string[];
  limit?: number;
  offset?: number;
  caseSensitive?: boolean;
}

/**
 * A search result with relevance score.
 */
export interface SearchResult {
  node: SymbolNode;
  score: number;
  highlights?: string[];
}

// =============================================================================
// Wiki generation types
// =============================================================================

/**
 * Table of contents for a generated wiki.
 */
export interface WikiStructure {
  title: string;
  description: string;
  sections: WikiSection[];
}

/**
 * A section in the wiki table of contents.
 */
export interface WikiSection {
  /** Section number: "1", "2", etc. */
  number: string;

  /** Section title */
  title: string;

  /** Brief description of what this section covers */
  description: string;

  /** Symbol IDs that should be covered in this section */
  relevantSymbolIds: string[];

  /** Subsections */
  subsections: WikiSubsection[];
}

/**
 * A subsection within a wiki section.
 */
export interface WikiSubsection {
  /** Subsection number: "1.1", "1.2", etc. */
  number: string;

  /** Subsection title */
  title: string;

  /** Brief description */
  description: string;

  /** Symbol IDs relevant to this subsection */
  relevantSymbolIds: string[];
}

/**
 * Context assembled for generating one wiki page.
 */
export interface PageContext {
  /** Page title */
  title: string;

  /** Page number in the wiki */
  number: string;

  /** What this page should cover */
  description: string;

  /** Primary symbols this page documents */
  focalSymbols: SymbolNode[];

  /** Relationships between focal symbols */
  relationships: Edge[];

  /** Source code blocks for key symbols */
  sourceBlocks: SourceBlock[];

  /** Files involved */
  relatedFiles: string[];

  /** Call chains discovered between focal symbols */
  callChains: CallChain[];

  /** Type hierarchies for focal symbols */
  typeHierarchies: TypeHierarchy[];
}

/**
 * A source code block with its owning symbol.
 */
export interface SourceBlock {
  node: SymbolNode;
  code: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: Language;
}

/**
 * A call chain between two symbols.
 */
export interface CallChain {
  from: SymbolNode;
  to: SymbolNode;
  path: SymbolNode[];
}

/**
 * A type hierarchy rooted at a symbol.
 */
export interface TypeHierarchy {
  root: SymbolNode;
  ancestors: SymbolNode[];
  descendants: SymbolNode[];
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Deepforge project configuration.
 */
export interface DeepforgeConfig {
  /** Languages to extract (empty = all detected) */
  languages?: Language[];

  /** Glob patterns to ignore */
  ignore?: string[];

  /** Max file size in bytes (default: 1MB) */
  maxFileSize?: number;

  /** LLM configuration */
  llm?: LlmConfig;

  /** Wiki output configuration */
  wiki?: WikiConfig;
}

/**
 * LLM provider configuration.
 */
export interface LlmConfig {
  provider: "claude" | "openai" | "azure" | "ollama";
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokensPerPage?: number;
  /** Azure OpenAI deployment name (required for azure provider) */
  azureDeployment?: string;
  /** Azure OpenAI API version (default: 2024-06-01) */
  azureApiVersion?: string;
}

/**
 * Wiki output configuration.
 */
export interface WikiConfig {
  maxSections?: number;
  maxSubsections?: number;
  includeDiagrams?: boolean;
  includeSourceCitations?: boolean;
  outputFormat?: "markdown" | "html";
}

// =============================================================================
// Statistics
// =============================================================================

/**
 * Statistics about the indexed knowledge graph.
 */
export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  nodesByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
  filesByLanguage: Record<string, number>;
  unresolvedRefCount: number;
  dbSizeBytes: number;
  lastUpdated: number;
}
