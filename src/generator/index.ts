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
  onProgress?: (message: string) => void;
}

export async function generateWiki(
  store: GraphStore,
  options: GenerateOptions,
): Promise<WikiStructure> {
  const log = options.onProgress ?? (() => {});
  const provider = await createProvider(options.llmConfig);

  // Step 1: Plan structure
  log("Planning wiki structure...");
  const structure = await planWikiStructure(store, provider);
  log(`Planned ${structure.sections.length} sections`);

  // Step 2: Generate pages
  const pages: WikiPage[] = [];

  for (const section of structure.sections) {
    log(`Generating: ${section.number}. ${section.title}`);
    const context = assemblePageContext(section, store, options.projectRoot);
    const content = await generatePage(context, provider);
    pages.push({
      path: pagePathFromNumber(section.number, section.title),
      title: section.title,
      number: section.number,
      content,
    });

    for (const sub of section.subsections) {
      log(`Generating: ${sub.number}. ${sub.title}`);
      const subContext = assemblePageContext(sub, store, options.projectRoot);
      const subContent = await generatePage(subContext, provider);
      pages.push({
        path: pagePathFromNumber(sub.number, sub.title),
        title: sub.title,
        number: sub.number,
        content: subContent,
      });
    }
  }

  // Step 3: Assemble
  log("Assembling wiki...");
  assembleWiki(structure, pages, options.outputDir);
  log(`Wiki generated: ${pages.length} pages in ${options.outputDir}`);

  return structure;
}

export { planWikiStructure } from "./planner.js";
export { assemblePageContext } from "./context-assembler.js";
export { generatePage } from "./page-writer.js";
export { assembleWiki, pagePathFromNumber } from "./assembler.js";
