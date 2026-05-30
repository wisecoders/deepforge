#!/usr/bin/env npx tsx
/**
 * Quick test: generate a single wiki page to check prompt quality.
 * Usage: npx tsx scripts/test-page.ts <projectPath> [sectionTitle] [provider] [model]
 */
import { readFileSync } from "node:fs";
// Load .env manually (tsx's built-in dotenv is unreliable)
const envPath = new URL("../.env", import.meta.url).pathname;
for (const line of readFileSync(envPath, "utf-8").split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
}
import { resolve } from "node:path";
import { GraphStore } from "../src/store/index.js";
import { createProvider } from "../src/llm/index.js";
import { planWikiStructure } from "../src/generator/planner.js";
import { assemblePageContext } from "../src/generator/context-assembler.js";
import { generatePage } from "../src/generator/page-writer.js";

const projectPath = process.argv[2] ?? "/Users/muthu/Documents/workspace/eShopOnWeb";
const targetTitle = process.argv[3]; // optional: match a section title

import { mkdirSync } from "node:fs";
import { scanProject } from "../src/scanner/index.js";
import { extractProject } from "../src/extraction/index.js";
import { resolveReferences } from "../src/resolution/index.js";

const root = resolve(projectPath);
const dbDir = resolve(root, ".deepforge");
mkdirSync(dbDir, { recursive: true });
const dbPath = resolve(dbDir, "graph.db");
const store = new GraphStore(dbPath);

// Index if empty
if (store.getStats().fileCount === 0) {
  console.error("Indexing project...");
  const files = scanProject(root);
  console.error(`  Found ${files.length} source files`);
  const extraction = await extractProject(root, files);
  console.error(`  Extracted ${extraction.totalNodes} nodes, ${extraction.totalEdges} edges`);
  const allNodes: any[] = [];
  const allUnresolved: any[] = [];
  for (const [filePath, result] of extraction.results) {
    const fileRecord = files.find((f) => f.path === filePath)!;
    store.ingestFile(fileRecord, result);
    allNodes.push(...result.nodes);
    allUnresolved.push(...result.unresolvedReferences);
  }
  const resolution = resolveReferences(allNodes, allUnresolved, files.map((f) => f.path));
  console.error(`  Resolved ${resolution.resolvedEdges.length} references`);
  for (const edge of resolution.resolvedEdges) {
    const sourceNode = store.getNode(edge.source);
    const targetNode = store.getNode(edge.target);
    if (sourceNode && targetNode) {
      const fileRecord = files.find((f) => f.path === sourceNode.filePath);
      if (fileRecord) {
        const existing = store.getNodesByFile(fileRecord.path);
        const existingEdges = existing.flatMap((n) => store.getEdgesFrom(n.id));
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
  console.error(`  Done: ${store.getStats().nodeCount} nodes, ${store.getStats().edgeCount} edges`);
}

const llmProvider = process.argv[4] ?? "ollama";
const llmModel = process.argv[5];
const provider = await createProvider({
  provider: llmProvider,
  model: llmModel,
  apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY,
  baseUrl: llmProvider === "ollama" ? "http://localhost:11434" : undefined,
});

console.error("Planning wiki structure...");
const structure = await planWikiStructure(store, provider);

// Pick a section to test — default to "3. Core Business Logic" > "3.1. Services"
let section = structure.sections[2]?.subsections[0]; // 3.1 Services
if (targetTitle) {
  // Search for matching section
  for (const s of structure.sections) {
    if (s.title.toLowerCase().includes(targetTitle.toLowerCase())) {
      section = s as any;
      break;
    }
    for (const sub of s.subsections) {
      if (sub.title.toLowerCase().includes(targetTitle.toLowerCase())) {
        section = sub;
        break;
      }
    }
  }
}

if (!section) {
  console.error("No matching section found. Available sections:");
  for (const s of structure.sections) {
    console.error(`  ${s.number}. ${s.title}`);
    for (const sub of s.subsections) {
      console.error(`    ${sub.number}. ${sub.title}`);
    }
  }
  process.exit(1);
}

console.error(`\nGenerating page: ${section.number}. ${section.title}`);
console.error(`Description: ${section.description}`);
console.error("---\n");

const context = assemblePageContext(section, store, root);
console.error(`Context: ${context.focalSymbols.length} symbols, ${context.relationships.length} relationships, ${context.sourceBlocks.length} source blocks\n`);

const content = await generatePage(context, provider, {
  wikiStructure: structure,
  store,
});

// Output the generated page to stdout
console.log(`# ${section.number}. ${section.title}\n`);
console.log(content);

store.close();
