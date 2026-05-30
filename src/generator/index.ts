import type { WikiStructure, LlmConfig } from "../types.js";
import type { GraphStore } from "../store/index.js";
import { createProvider } from "../llm/index.js";
import { planWikiStructure } from "./planner.js";
import { assemblePageContext } from "./context-assembler.js";
import { generatePage } from "./page-writer.js";
import { assembleWiki, pagePathFromNumber } from "./assembler.js";
import type { WikiPage } from "./assembler.js";

export interface GenerateOptions {
  outputDir: string;
  projectRoot: string;
  llmConfig: LlmConfig;
  concurrency?: number; // parallel page generation (default: 3)
  onProgress?: (message: string) => void;
}

export async function generateWiki(
  store: GraphStore,
  options: GenerateOptions,
): Promise<WikiStructure> {
  const log = options.onProgress ?? (() => {});
  const provider = await createProvider(options.llmConfig);
  const concurrency = options.concurrency ?? 3;

  // Step 1: Plan structure
  log("Planning wiki structure...");
  const structure = await planWikiStructure(store, provider);
  const totalSubs = structure.sections.reduce(
    (sum, s) => sum + s.subsections.length,
    0,
  );
  const totalPages = structure.sections.length + totalSubs;
  log(
    `Planned ${structure.sections.length} sections with ${totalSubs} subsections (${totalPages} pages total)`,
  );

  // Step 2: Build all page tasks (context assembly is fast, CPU-only)
  interface PageTask {
    number: string;
    title: string;
    section: typeof structure.sections[0] | typeof structure.sections[0]["subsections"][0];
  }
  const tasks: PageTask[] = [];
  for (const section of structure.sections) {
    tasks.push({ number: section.number, title: section.title, section });
    for (const sub of section.subsections) {
      tasks.push({ number: sub.number, title: sub.title, section: sub });
    }
  }

  // Step 3: Generate pages with concurrency pool
  let completed = 0;
  const pages: WikiPage[] = new Array(tasks.length);

  async function processTask(idx: number): Promise<void> {
    const task = tasks[idx];
    const context = assemblePageContext(task.section, store, options.projectRoot);
    const content = await generatePage(context, provider, {
      wikiStructure: structure,
      store,
    });
    pages[idx] = {
      path: pagePathFromNumber(task.number, task.title),
      title: task.title,
      number: task.number,
      content,
    };
    completed++;
    log(`[${completed}/${totalPages}] Done: ${task.number}. ${task.title}`);
  }

  // Concurrency-limited execution
  log(`Generating ${totalPages} pages (concurrency: ${concurrency})...`);
  const executing = new Set<Promise<void>>();
  for (let i = 0; i < tasks.length; i++) {
    const p = processTask(i).then(() => { executing.delete(p); });
    executing.add(p);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);

  // Step 4: Assemble
  log("Assembling wiki...");
  const stats = store.getStats();
  assembleWiki(structure, pages, options.outputDir, { stats });
  log(`Wiki generated: ${pages.length} pages in ${options.outputDir}`);

  return structure;
}

export { planWikiStructure } from "./planner.js";
export { assemblePageContext } from "./context-assembler.js";
export { generatePage } from "./page-writer.js";
export { assembleWiki, pagePathFromNumber } from "./assembler.js";
