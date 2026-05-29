import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileRecord, ExtractionResult } from "../types.js";
import { getExtractor } from "./languages/index.js";
import { initTreeSitter, getParser, parseSource } from "./tree-sitter.js";

// Register extractors on import
import "./languages/typescript.js";
import "./languages/python.js";

export interface ExtractionSummary {
  totalFiles: number;
  extractedFiles: number;
  skippedFiles: number;
  totalNodes: number;
  totalEdges: number;
  totalUnresolved: number;
  totalErrors: number;
  durationMs: number;
  results: Map<string, ExtractionResult>;
}

export async function extractProject(
  projectRoot: string,
  files: FileRecord[],
): Promise<ExtractionSummary> {
  const start = performance.now();
  await initTreeSitter();

  const results = new Map<string, ExtractionResult>();
  let skippedFiles = 0;
  let totalNodes = 0;
  let totalEdges = 0;
  let totalUnresolved = 0;
  let totalErrors = 0;

  for (const file of files) {
    const extractor = getExtractor(file.language);
    if (!extractor) {
      skippedFiles++;
      continue;
    }

    const parser = await getParser(file.language);
    if (!parser) {
      skippedFiles++;
      continue;
    }

    const fullPath = join(projectRoot, file.path);
    let source: string;
    try {
      source = readFileSync(fullPath, "utf-8");
    } catch {
      skippedFiles++;
      continue;
    }

    const tree = parseSource(parser, source);
    const result = extractor.extract(source, file.path, tree);

    results.set(file.path, result);
    totalNodes += result.nodes.length;
    totalEdges += result.edges.length;
    totalUnresolved += result.unresolvedReferences.length;
    totalErrors += result.errors.length;
  }

  return {
    totalFiles: files.length,
    extractedFiles: results.size,
    skippedFiles,
    totalNodes,
    totalEdges,
    totalUnresolved,
    totalErrors,
    durationMs: performance.now() - start,
    results,
  };
}
