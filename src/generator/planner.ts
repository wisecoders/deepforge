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

  const prompt = `Analyze this codebase and generate a wiki table of contents.

## Codebase Info
- ${stats.fileCount} files, ${stats.nodeCount} symbols, ${stats.edgeCount} relationships
- Languages: ${Object.entries(stats.filesByLanguage).map(([l, c]) => `${l} (${c})`).join(", ")}
- Symbols: ${Object.entries(stats.nodesByKind).map(([k, c]) => `${c} ${k}s`).join(", ")}

## Directory Structure
${dirTree}

## Key Symbols
${symbolSummary}

## Inheritance
${inheritanceInfo}

## REQUIREMENTS

Generate 8-12 sections organized by CONCEPT (not by directory). Each section needs 2-4 subsections.

CRITICAL: Do NOT organize by folder name. Do NOT use generic titles like "Classes & Services".
Instead, organize by architectural concept and feature domain.

Example structure for a web app:
1. Overview → Architecture, Tech Stack, Project Structure
2. Domain Model → Entities, Value Objects, Aggregates
3. Core Services → Order Processing, Basket Management, Catalog Service
4. Data Access → Repository Pattern, Database Contexts, Migrations
5. Web Application → Controllers, Views & Razor Pages, Authentication
6. API Layer → Endpoint Architecture, Catalog Endpoints, User Management
7. Admin UI → Components, State Management, CRUD Operations
8. Shopping Features → Basket Flow, Checkout Process, Order Lifecycle
9. Configuration → App Settings, Dependency Injection, Environment Config
10. Testing → Unit Tests, Integration Tests, Functional Tests
11. Deployment → Docker, CI/CD, Azure

Return ONLY valid JSON (no markdown fences, no commentary before/after):
{"title":"Project Name — Technical Wiki","description":"2-3 sentences about what this project does","sections":[{"number":"1","title":"Section Title","description":"What this section covers","relevantSymbolIds":[],"subsections":[{"number":"1.1","title":"Subsection Title","description":"Specific description","relevantSymbolIds":[]}]}]}`;

  const response = await provider.generate(prompt, {
    systemPrompt:
      "You are a technical documentation architect. Analyze the codebase structure and produce a comprehensive wiki table of contents as JSON. Organize by CONCEPT not by directory. Keep descriptions concise (under 20 words each). Return only valid JSON, no markdown fences or commentary.",
    temperature: 0.3,
    maxTokens: 8192,
  });

  try {
    // Robust JSON extraction — handle markdown fences, preamble, trailing text
    let cleaned = response
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    // Find the first { and last } to extract JSON
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
    const parsed = JSON.parse(cleaned) as WikiStructure;
    if (!parsed.sections || parsed.sections.length < 3) {
      console.error("  [planner] LLM returned < 3 sections, using fallback structure");
      return fallbackStructure(files, topLevelSymbols, stats);
    }
    return assignSymbolIds(parsed, topLevelSymbols);
  } catch (err) {
    console.error("  [planner] Failed to parse LLM response as JSON, using fallback structure");
    console.error("  [planner] Error:", (err as Error).message);
    console.error("  [planner] Response preview:", response.slice(0, 200));
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
