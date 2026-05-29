import type { SymbolNode, WikiStructure, WikiSection } from "../types.js";
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
    .slice(0, 200);

  const symbolSummary = topLevelSymbols
    .map((n) => {
      let desc = `- ${n.kind}: ${n.qualifiedName}`;
      if (n.docstring) desc += ` — ${n.docstring.slice(0, 80)}`;
      if (n.signature) desc += ` | sig: ${n.signature.slice(0, 60)}`;
      return desc;
    })
    .join("\n");

  const dirTree = buildDirectoryTree(files);

  const fileSummary = files
    .map((f) => `- ${f.path} (${f.language}, ${f.nodeCount} symbols)`)
    .slice(0, 80)
    .join("\n");

  const inheritanceInfo = buildInheritanceSummary(store, topLevelSymbols);

  const prompt = `You are analyzing a codebase to plan comprehensive technical wiki documentation.

## Codebase Statistics
- ${stats.fileCount} files, ${stats.nodeCount} symbols, ${stats.edgeCount} relationships
- Languages: ${Object.entries(stats.filesByLanguage).map(([l, c]) => `${l} (${c})`).join(", ")}
- Symbol breakdown: ${Object.entries(stats.nodesByKind).map(([k, c]) => `${c} ${k}s`).join(", ")}

## Project Directory Structure
${dirTree}

## Files (first 80)
${fileSummary}

## Key Symbols (classes, interfaces, enums, namespaces)
${symbolSummary}

## Inheritance Relationships
${inheritanceInfo}

## Instructions
Generate a comprehensive table of contents for a technical wiki, similar to what DeepWiki.com produces.

Requirements:
1. Generate 8-12 top-level sections covering ALL major architectural concerns
2. Each section should have 2-5 subsections for detailed coverage
3. Always include these kinds of sections:
   - Overview (architecture, tech stack, project structure)
   - Domain/data model (entities, value objects, relationships)
   - Core business logic (services, handlers, specifications)
   - Infrastructure (data access, repositories, external integrations)
   - API layer (endpoints, controllers, request/response flow)
   - UI/Frontend (if applicable: views, components, pages)
   - Configuration & deployment (settings, docker, CI/CD)
   - Testing (test organization, strategies)
4. Group related files and symbols into coherent sections
5. Each section/subsection description should be specific about what code it covers
6. For relevantSymbolIds, include IDs of the most important symbols for that section

Return ONLY valid JSON in this exact format:
{
  "title": "Project Name — Technical Wiki",
  "description": "2-3 sentence project description explaining what the project does and its architecture",
  "sections": [
    {
      "number": "1",
      "title": "Section Title",
      "description": "Specific description of what code and concepts this section covers",
      "relevantSymbolIds": [],
      "subsections": [
        {
          "number": "1.1",
          "title": "Subsection Title",
          "description": "Specific description",
          "relevantSymbolIds": []
        }
      ]
    }
  ]
}`;

  const response = await provider.generate(prompt, {
    systemPrompt:
      "You are a technical documentation architect. Analyze the codebase structure and produce a comprehensive wiki table of contents as JSON. Be thorough — cover every major module and architectural layer. Return only valid JSON, no markdown fences or commentary.",
    temperature: 0.3,
    maxTokens: 4096,
  });

  try {
    const cleaned = response
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .replace(/^[^{]*/, "")
      .replace(/[^}]*$/, "")
      .trim();
    const parsed = JSON.parse(cleaned) as WikiStructure;
    if (!parsed.sections || parsed.sections.length < 3) {
      return fallbackStructure(files, topLevelSymbols, stats);
    }
    return assignSymbolIds(parsed, topLevelSymbols);
  } catch {
    return fallbackStructure(files, topLevelSymbols, stats);
  }
}

function buildDirectoryTree(
  files: { path: string; language: string; nodeCount: number }[],
): string {
  const dirs = new Map<string, number>();
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 1; i <= parts.length - 1; i++) {
      const dir = parts.slice(0, i).join("/");
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    }
  }

  const sorted = [...dirs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 40);

  return sorted
    .map(([dir, count]) => {
      const depth = dir.split("/").length - 1;
      const indent = "  ".repeat(depth);
      const name = dir.split("/").pop();
      return `${indent}${name}/ (${count} files)`;
    })
    .join("\n");
}

function buildInheritanceSummary(
  store: GraphStore,
  symbols: SymbolNode[],
): string {
  const lines: string[] = [];
  const classesAndInterfaces = symbols.filter(
    (s) => s.kind === "class" || s.kind === "interface",
  );

  for (const sym of classesAndInterfaces.slice(0, 50)) {
    const extendsEdges = store.getEdgesFrom(sym.id, "extends");
    const implEdges = store.getEdgesFrom(sym.id, "implements");

    const parts: string[] = [];
    for (const e of extendsEdges) {
      const target = store.getNode(e.target);
      if (target) parts.push(`extends ${target.name}`);
    }
    for (const e of implEdges) {
      const target = store.getNode(e.target);
      if (target) parts.push(`implements ${target.name}`);
    }

    if (parts.length > 0) {
      lines.push(`- ${sym.name} ${parts.join(", ")}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "(no inheritance detected)";
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
  const words = lower.split(/\W+/).filter((w) => w.length > 2);

  return symbols
    .filter((s) => {
      const nameWords = s.name
        .replace(/([A-Z])/g, " $1")
        .toLowerCase()
        .split(/\W+/);
      return (
        lower.includes(s.name.toLowerCase()) ||
        nameWords.some((nw) => nw.length > 3 && words.some((w) => w.includes(nw)))
      );
    })
    .map((s) => s.id)
    .slice(0, 15);
}

function fallbackStructure(
  files: { path: string; language: string; nodeCount: number }[],
  symbols: SymbolNode[],
  stats: { nodeCount: number; edgeCount: number; fileCount: number; filesByLanguage: Record<string, number> },
): WikiStructure {
  const dirs = new Map<string, typeof files>();
  for (const f of files) {
    const parts = f.path.split("/");
    const topDir = parts.length > 1 ? parts.slice(0, 2).join("/") : ".";
    const list = dirs.get(topDir) ?? [];
    list.push(f);
    dirs.set(topDir, list);
  }

  const sections: WikiSection[] = [
    {
      number: "1",
      title: "Architecture Overview",
      description: "High-level system architecture, project structure, and technology stack.",
      relevantSymbolIds: symbols
        .filter((s) => s.kind === "namespace" || s.kind === "class")
        .slice(0, 15)
        .map((s) => s.id),
      subsections: [
        {
          number: "1.1",
          title: "Project Structure",
          description: "Directory organization and module boundaries.",
          relevantSymbolIds: [],
        },
        {
          number: "1.2",
          title: "Architecture Patterns",
          description: "Design patterns and architectural decisions used in the codebase.",
          relevantSymbolIds: [],
        },
      ],
    },
  ];

  let idx = 2;
  for (const [dir, dirFiles] of [...dirs.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 9)) {
    const dirSymbols = symbols.filter((s) => s.filePath.startsWith(dir));
    const classes = dirSymbols.filter((s) => s.kind === "class");
    const interfaces = dirSymbols.filter((s) => s.kind === "interface");

    const subsections = [];
    if (classes.length > 0) {
      subsections.push({
        number: `${idx}.1`,
        title: "Classes & Services",
        description: `Core classes in ${dir}: ${classes.slice(0, 5).map((c) => c.name).join(", ")}`,
        relevantSymbolIds: classes.slice(0, 10).map((s) => s.id),
      });
    }
    if (interfaces.length > 0) {
      subsections.push({
        number: `${idx}.${subsections.length + 1}`,
        title: "Interfaces & Contracts",
        description: `Interfaces defined in ${dir}: ${interfaces.slice(0, 5).map((i) => i.name).join(", ")}`,
        relevantSymbolIds: interfaces.slice(0, 10).map((s) => s.id),
      });
    }
    if (subsections.length === 0) {
      const topSymbols = dirSymbols.slice(0, 10);
      if (topSymbols.length > 0) {
        subsections.push({
          number: `${idx}.1`,
          title: "Key Components",
          description: `Main components: ${topSymbols.slice(0, 5).map((s) => s.name).join(", ")}`,
          relevantSymbolIds: topSymbols.map((s) => s.id),
        });
      }
    }

    sections.push({
      number: String(idx),
      title: dir === "." ? "Root Module" : dir.split("/").pop() ?? dir,
      description: `Components and services in ${dir} (${dirFiles.length} files)`,
      relevantSymbolIds: dirSymbols.slice(0, 15).map((s) => s.id),
      subsections,
    });
    idx++;
  }

  sections.push({
    number: String(idx),
    title: "Development & Configuration",
    description: "Build configuration, deployment settings, and development workflow.",
    relevantSymbolIds: [],
    subsections: [],
  });

  const langs = Object.entries(stats.filesByLanguage)
    .map(([l, c]) => `${l} (${c})`)
    .join(", ");

  return {
    title: "Project Documentation",
    description: `Auto-generated documentation covering ${stats.fileCount} files with ${stats.nodeCount} symbols across ${langs}.`,
    sections,
  };
}
