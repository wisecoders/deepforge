import type { SymbolNode, WikiStructure, WikiSection, WikiSubsection } from "../types.js";
import type { GraphStore } from "../store/index.js";
import type { LlmProvider } from "../llm/index.js";

export async function planWikiStructure(
  store: GraphStore,
  provider: LlmProvider,
): Promise<WikiStructure> {
  const stats = store.getStats();
  const files = store.getAllFiles();

  const topLevelSymbols = [
    ...store.getNodesByKind("class"),
    ...store.getNodesByKind("interface"),
    ...store.getNodesByKind("function"),
    ...store.getNodesByKind("namespace"),
    ...store.getNodesByKind("enum"),
  ]
    .filter((n) => n.isExported || n.kind === "namespace")
    .slice(0, 100);

  const symbolSummary = topLevelSymbols
    .map((n) => `- ${n.kind}: ${n.qualifiedName}${n.docstring ? ` — ${n.docstring.slice(0, 80)}` : ""}`)
    .join("\n");

  const fileSummary = files
    .map((f) => `- ${f.path} (${f.language}, ${f.nodeCount} symbols)`)
    .slice(0, 50)
    .join("\n");

  const prompt = `Given this codebase structure, generate a table of contents for a technical wiki.

## Codebase overview
- ${stats.fileCount} files, ${stats.nodeCount} symbols, ${stats.edgeCount} relationships
- Languages: ${Object.entries(stats.filesByLanguage).map(([l, c]) => `${l} (${c})`).join(", ")}

## Files
${fileSummary}

## Key symbols
${symbolSummary}

## Instructions
Generate 4-10 top-level sections, each with 1-4 subsections.
Each section should cover a coherent architectural concern.
Return ONLY valid JSON in this exact format:
{
  "title": "Project Name Documentation",
  "description": "Brief project description",
  "sections": [
    {
      "number": "1",
      "title": "Section Title",
      "description": "What this section covers",
      "relevantSymbolIds": [],
      "subsections": [
        {
          "number": "1.1",
          "title": "Subsection Title",
          "description": "What this subsection covers",
          "relevantSymbolIds": []
        }
      ]
    }
  ]
}`;

  const response = await provider.generate(prompt, {
    systemPrompt:
      "You are a technical documentation planner. Return only valid JSON, no markdown fences.",
    temperature: 0.3,
  });

  try {
    const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as WikiStructure;
    return assignSymbolIds(parsed, topLevelSymbols);
  } catch {
    return fallbackStructure(files, topLevelSymbols);
  }
}

function assignSymbolIds(
  structure: WikiStructure,
  symbols: SymbolNode[],
): WikiStructure {
  for (const section of structure.sections) {
    if (section.relevantSymbolIds.length === 0) {
      section.relevantSymbolIds = findRelevantSymbols(
        section.title + " " + section.description,
        symbols,
      );
    }
    for (const sub of section.subsections) {
      if (sub.relevantSymbolIds.length === 0) {
        sub.relevantSymbolIds = findRelevantSymbols(
          sub.title + " " + sub.description,
          symbols,
        );
      }
    }
  }
  return structure;
}

function findRelevantSymbols(text: string, symbols: SymbolNode[]): string[] {
  const lower = text.toLowerCase();
  return symbols
    .filter((s) => lower.includes(s.name.toLowerCase()))
    .map((s) => s.id)
    .slice(0, 10);
}

function fallbackStructure(
  files: { path: string; language: string; nodeCount: number }[],
  symbols: SymbolNode[],
): WikiStructure {
  const dirs = new Map<string, typeof files>();
  for (const f of files) {
    const dir = f.path.split("/").slice(0, -1).join("/") || ".";
    const list = dirs.get(dir) ?? [];
    list.push(f);
    dirs.set(dir, list);
  }

  const sections: WikiSection[] = [
    {
      number: "1",
      title: "Architecture Overview",
      description: "High-level system architecture and design.",
      relevantSymbolIds: symbols.filter((s) => s.kind === "namespace" || s.kind === "class").slice(0, 10).map((s) => s.id),
      subsections: [],
    },
  ];

  let idx = 2;
  for (const [dir, dirFiles] of [...dirs.entries()].slice(0, 8)) {
    const dirSymbols = symbols.filter((s) => s.filePath.startsWith(dir));
    sections.push({
      number: String(idx),
      title: dir === "." ? "Root Module" : dir.replace(/\//g, " / "),
      description: `Components in ${dir}`,
      relevantSymbolIds: dirSymbols.slice(0, 10).map((s) => s.id),
      subsections: dirFiles.slice(0, 4).map((f, j) => ({
        number: `${idx}.${j + 1}`,
        title: f.path.split("/").pop() ?? f.path,
        description: `Symbols in ${f.path}`,
        relevantSymbolIds: symbols
          .filter((s) => s.filePath === f.path)
          .slice(0, 5)
          .map((s) => s.id),
      })),
    });
    idx++;
  }

  return {
    title: "Project Documentation",
    description: "Auto-generated documentation",
    sections,
  };
}
