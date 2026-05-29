/**
 * Language extractor registry.
 *
 * Each language gets its own extractor that knows how to walk the tree-sitter
 * AST and emit SymbolNode + Edge + UnresolvedReference for that language.
 */

import type { ExtractionResult, Language } from "../../types.js";
import type { Tree } from "web-tree-sitter";

/**
 * Contract for per-language symbol extraction.
 *
 * Each extractor receives a parsed tree-sitter tree and the source text,
 * and returns the symbols, relationships, and unresolved references found.
 */
export interface LanguageExtractor {
  /** Which language this extractor handles */
  readonly language: Language;

  /** File extensions this extractor handles (without leading dot) */
  readonly extensions: string[];

  /**
   * Extract symbols and relationships from a parsed file.
   *
   * @param source - Raw source text
   * @param filePath - Path relative to project root
   * @param tree - Parsed tree-sitter tree
   */
  extract(source: string, filePath: string, tree: Tree): ExtractionResult;
}

/** Registry of all available extractors, keyed by language. */
const registry = new Map<Language, LanguageExtractor>();

/** Static extension→language mapping (always available). */
const STATIC_EXTENSIONS: Record<string, Language> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  cs: "csharp",
  kt: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  h: "c",
  c: "c",
};

/** Map from file extension to language (extended by registered extractors). */
const extensionMap = new Map<string, Language>(
  Object.entries(STATIC_EXTENSIONS),
);

/**
 * Register a language extractor.
 */
export function registerExtractor(extractor: LanguageExtractor): void {
  registry.set(extractor.language, extractor);
  for (const ext of extractor.extensions) {
    extensionMap.set(ext, extractor.language);
  }
}

/**
 * Get the extractor for a language, if one exists.
 */
export function getExtractor(language: Language): LanguageExtractor | undefined {
  return registry.get(language);
}

/**
 * Detect language from a file extension.
 */
export function detectLanguage(filePath: string): Language {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return "unknown";
  return extensionMap.get(ext) ?? "unknown";
}

/**
 * Get all registered languages.
 */
export function getRegisteredLanguages(): Language[] {
  return [...registry.keys()];
}
