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
  const totalSubs = structure.sections.reduce(
    (sum, s) => sum + s.subsections.length,
    0,
  );
  log(
    `Planned ${structure.sections.length} sections with ${totalSubs} subsections (${structure.sections.length + totalSubs} pages total)`,
  );

  // Step 2: Generate pages
  const pages: WikiPage[] = [];
  let pageNum = 0;
  const totalPages =
    structure.sections.length + totalSubs;

  for (const section of structure.sections) {
    pageNum++;
    log(
      `[${pageNum}/${totalPages}] Generating: ${section.number}. ${section.title}`,
    );
    const context = assemblePageContext(section, store, options.projectRoot);
    const content = await generatePage(context, provider, {
      wikiStructure: structure,
      store,
    });
    pages.push({
      path: pagePathFromNumber(section.number, section.title),
      title: section.title,
      number: section.number,
      content,
    });

    for (const sub of section.subsections) {
      pageNum++;
      log(
        `[${pageNum}/${totalPages}] Generating: ${sub.number}. ${sub.title}`,
      );
      const subContext = assemblePageContext(sub, store, options.projectRoot);
      const subContent = await generatePage(subContext, provider, {
        wikiStructure: structure,
        store,
      });
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
  const stats = store.getStats();
  assembleWiki(structure, pages, options.outputDir, { stats });
  log(`Wiki generated: ${pages.length} pages in ${options.outputDir}`);

  return structure;
}

export { planWikiStructure } from "./planner.js";
export { assemblePageContext } from "./context-assembler.js";
export { generatePage } from "./page-writer.js";
export { assembleWiki, pagePathFromNumber } from "./assembler.js";
