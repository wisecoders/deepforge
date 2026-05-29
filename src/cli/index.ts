#!/usr/bin/env node

import { Command } from "commander";
import { resolve } from "node:path";
import { scanProject } from "../scanner/index.js";
import { extractProject } from "../extraction/index.js";
import { resolveReferences } from "../resolution/index.js";
import { GraphStore } from "../store/index.js";
import { generateWiki } from "../generator/index.js";
import type { LlmConfig } from "../types.js";

const program = new Command();

program
  .name("deepforge")
  .description("Generate structured wiki documentation for any code repository")
  .version("0.1.0");

program
  .command("generate <projectPath>")
  .description("Index a codebase and generate wiki documentation")
  .option("-o, --output <path>", "Output directory for wiki files", "./wiki")
  .option("--skip-index", "Skip indexing, use existing graph database")
  .option("--provider <provider>", "LLM provider: claude, openai, ollama", "claude")
  .option("--model <model>", "LLM model name")
  .option("--api-key <key>", "LLM API key (or set env var)")
  .option("--base-url <url>", "LLM base URL (for ollama)")
  .action(async (projectPath: string, options) => {
    const root = resolve(projectPath);
    const dbPath = resolve(root, ".deepforge/graph.db");

    const store = new GraphStore(dbPath);

    try {
      if (!options.skipIndex) {
        await runIndex(root, store);
      }

      const llmConfig: LlmConfig = {
        provider: options.provider,
        model: options.model,
        apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY,
        baseUrl: options.baseUrl,
      };

      await generateWiki(store, {
        outputDir: resolve(options.output),
        projectRoot: root,
        llmConfig,
        onProgress: (msg) => console.log(`  ${msg}`),
      });
    } finally {
      store.close();
    }
  });

program
  .command("index <projectPath>")
  .description("Index a codebase into a knowledge graph (no wiki generation)")
  .action(async (projectPath: string) => {
    const root = resolve(projectPath);
    const dbPath = resolve(root, ".deepforge/graph.db");
    const store = new GraphStore(dbPath);
    try {
      await runIndex(root, store);
    } finally {
      store.close();
    }
  });

program
  .command("status <projectPath>")
  .description("Show knowledge graph statistics")
  .action(async (projectPath: string) => {
    const root = resolve(projectPath);
    const dbPath = resolve(root, ".deepforge/graph.db");
    const store = new GraphStore(dbPath);
    try {
      const stats = store.getStats();
      console.log("Deepforge Knowledge Graph Statistics");
      console.log("====================================");
      console.log(`Files:    ${stats.fileCount}`);
      console.log(`Nodes:    ${stats.nodeCount}`);
      console.log(`Edges:    ${stats.edgeCount}`);
      console.log(`Unresolved refs: ${stats.unresolvedRefCount}`);
      console.log();
      console.log("Nodes by kind:");
      for (const [kind, count] of Object.entries(stats.nodesByKind).sort(
        (a, b) => b[1] - a[1],
      )) {
        console.log(`  ${kind}: ${count}`);
      }
      console.log();
      console.log("Edges by kind:");
      for (const [kind, count] of Object.entries(stats.edgesByKind).sort(
        (a, b) => b[1] - a[1],
      )) {
        console.log(`  ${kind}: ${count}`);
      }
      console.log();
      console.log("Files by language:");
      for (const [lang, count] of Object.entries(stats.filesByLanguage).sort(
        (a, b) => b[1] - a[1],
      )) {
        console.log(`  ${lang}: ${count}`);
      }
    } finally {
      store.close();
    }
  });

program
  .command("query <projectPath> <query>")
  .description("Query the knowledge graph")
  .option("-k, --top-k <number>", "Number of results", "10")
  .action(async (projectPath: string, query: string, options) => {
    const root = resolve(projectPath);
    const dbPath = resolve(root, ".deepforge/graph.db");
    const store = new GraphStore(dbPath);
    try {
      const results = store.searchNodes(query, {
        limit: parseInt(options.topK, 10),
      });
      if (results.length === 0) {
        console.log("No results found.");
        return;
      }
      for (const r of results) {
        console.log(
          `${r.node.kind.padEnd(12)} ${r.node.qualifiedName}  [${r.node.filePath}:${r.node.startLine}]`,
        );
        if (r.node.signature) {
          console.log(`             ${r.node.signature}`);
        }
        if (r.node.docstring) {
          console.log(`             ${r.node.docstring.slice(0, 100)}`);
        }
        console.log();
      }
    } finally {
      store.close();
    }
  });

async function runIndex(root: string, store: GraphStore): Promise<void> {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(resolve(root, ".deepforge"), { recursive: true });

  console.log(`Scanning ${root}...`);
  const files = scanProject(root);
  console.log(`  Found ${files.length} source files`);

  console.log("Extracting symbols...");
  const extraction = await extractProject(root, files);
  console.log(
    `  Extracted ${extraction.totalNodes} nodes, ${extraction.totalEdges} edges (${extraction.durationMs.toFixed(0)}ms)`,
  );

  console.log("Ingesting into store...");
  const allNodes = [];
  const allUnresolved = [];
  for (const [filePath, result] of extraction.results) {
    const fileRecord = files.find((f) => f.path === filePath)!;
    store.ingestFile(fileRecord, result);
    allNodes.push(...result.nodes);
    allUnresolved.push(...result.unresolvedReferences);
  }

  console.log("Resolving cross-file references...");
  const resolution = resolveReferences(
    allNodes,
    allUnresolved,
    files.map((f) => f.path),
  );
  console.log(
    `  Resolved ${resolution.resolvedEdges.length} references, ${resolution.unresolvedCount} remaining`,
  );

  // Ingest resolved edges
  for (const edge of resolution.resolvedEdges) {
    const sourceNode = store.getNode(edge.source);
    const targetNode = store.getNode(edge.target);
    if (sourceNode && targetNode) {
      const fileRecord = files.find((f) => f.path === sourceNode.filePath);
      if (fileRecord) {
        const existing = store.getNodesByFile(fileRecord.path);
        const existingEdges = existing.flatMap((n) =>
          store.getEdgesFrom(n.id),
        );
        store.ingestFile(fileRecord, {
          nodes: existing,
          edges: [...existingEdges, edge],
          unresolvedReferences: [],
          errors: [],
          durationMs: 0,
        });
      }
    }
  }

  const stats = store.getStats();
  console.log(
    `Done. ${stats.nodeCount} nodes, ${stats.edgeCount} edges across ${stats.fileCount} files.`,
  );
}

program.parse();
