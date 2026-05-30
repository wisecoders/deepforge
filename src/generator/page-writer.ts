import type { PageContext, WikiStructure, SymbolNode, Edge } from "../types.js";
import type { LlmProvider } from "../llm/index.js";
import type { GraphStore } from "../store/index.js";

export interface PageWriterOptions {
  wikiStructure: WikiStructure;
  store: GraphStore;
}

export async function generatePage(
  context: PageContext,
  provider: LlmProvider,
  options?: PageWriterOptions,
): Promise<string> {
  const symbolSummary = buildSymbolSummary(context, options?.store);
  const relationshipSummary = buildRelationshipSummary(context, options?.store);
  const keySourceSnippets = buildKeySourceSnippets(context);
  const callChainSection = buildCallChainSection(context);
  const hierarchySection = buildHierarchySection(context);
  const crossLinks = options?.wikiStructure
    ? buildCrossLinks(context, options.wikiStructure)
    : "";

  // Build the list of relevant source files for the "Relevant Source Files" section
  const relevantFiles = context.relatedFiles.slice(0, 10);
  const relevantFilesSection = relevantFiles.length > 0
    ? relevantFiles.map((f) => `- \`${f}\``).join("\n")
    : "";

  const systemPrompt = `You are a senior technical writer creating wiki documentation for a code repository. You produce documentation comparable to DeepWiki.com — comprehensive, specific, and precisely referenced to source code. Your output is ONLY the markdown body of the wiki page — no preamble, no meta-commentary, no conversational text.

OUTPUT FORMAT — follow this structure exactly:

## Relevant Source Files
List the key source files this page documents (provided in the user message — copy them as-is into this section as a bullet list).

## Purpose and Scope
Write 2-3 paragraphs explaining:
- What this module/component does and what problem it solves
- Where it fits in the overall application architecture
- Key design decisions and patterns employed (e.g., Repository Pattern, Domain Events, Specification Pattern, CQRS, Dependency Injection)
- Why the code is structured this way — what benefits does this design provide

## [Topic-Specific Sections]
Create 3-5 sections with descriptive ### subheadings appropriate to the topic being documented. For each section:
- Start with 1-2 paragraphs of explanation about the component's purpose and design rationale
- Include short inline code snippets (3-10 lines) extracted from the reference data showing key implementation patterns
- Use markdown tables for listing methods, properties, endpoints, or configuration options with columns like: Name | Type/Parameters | Description | Source Location
- Cite source files inline using the exact paths from the reference data, formatted as \`src/Path/File.cs:34-58\`
- Explain HOW components interact and WHY they are designed the way they are
- For classes: explain their responsibilities, key methods, and how they collaborate with other classes
- For patterns: explain the pattern, show the concrete implementation, and describe the benefits
- For flows: describe the step-by-step process with source references at each step

## Integration with Other Components
Describe how this module connects to other parts of the system:
- Which other modules depend on this one, and which modules does this one depend on
- Link to other wiki pages inline using markdown links: "For more details on X, see [Page Title](page-filename.md)"
- Describe the data flow between this component and its collaborators
- Note any important interfaces or contracts that define the integration boundaries

WRITING RULES:
- Write 1000-2000 words of technical prose. Be specific, precise, and informative.
- Include EXACTLY 1 Mermaid diagram per page. Choose the most appropriate type for the topic:
  - classDiagram for pages about entities, aggregates, domain models, or class hierarchies
  - sequenceDiagram for pages about request flows, service interactions, or multi-step processes
  - flowchart TD for pages about pipelines, middleware chains, configuration loading, or data flow
  Place the diagram in the most relevant topic section (not at the top and not at the bottom).
- Also include short inline code snippets (3-10 lines) — code and diagrams serve different purposes.
- Tables must contain REAL method/class names and REAL file paths from the reference data provided.
- Every technical claim must be traceable to a source file. Use paths exactly as shown in the reference data.
- Do NOT use generic placeholder names like "FileName.cs" — always use the actual path such as \`src/ApplicationCore/Services/OrderService.cs:34\`.
- Do NOT echo or reproduce raw symbol lists, relationship lists, or source code blocks from the reference data verbatim.
- Do NOT include XML tags, reference_data markers, or any meta-structure from the input.
- Cross-reference other wiki pages inline where relevant (e.g., "see [Domain Entities](2.1-entities.md) for the entity definitions").
- Write for a developer who is new to this codebase and needs to understand both WHAT the code does and WHY it is designed that way.
- Focus on architectural significance and design rationale, not just describing what code exists.
- Start your output directly with "## Relevant Source Files" — no title heading, no introduction before it.

CODE SNIPPET GUIDELINES:
- Extract real code from the reference data — never fabricate or paraphrase code.
- Each snippet should demonstrate a specific pattern, design decision, or integration point.
- Annotate snippets with brief explanation of what makes them architecturally significant.
- Use the exact language identifier in fenced code blocks (e.g., \`\`\`csharp, \`\`\`typescript, \`\`\`python).
- When showing method signatures in tables, include the return type and key parameters.
- For configuration or setup code, show the key registration or binding lines, not boilerplate.

TABLE FORMATTING:
- Use tables for structured data: methods, properties, endpoints, configuration options, event types.
- Every cell must contain real values from the reference data — never use placeholder text.
- Include a "Source" or "Location" column with the file path and line range where the item is defined.
- Sort table rows by importance or logical grouping, not alphabetically.

MERMAID DIAGRAM RULES (mandatory — every page MUST have exactly one):
- Pick the single best visualization for this page's content. Do NOT include more than one diagram.
- Use classDiagram for inheritance/composition: show base classes, interfaces, and concrete implementations with their key methods.
- Use sequenceDiagram for flows: show the actors (Controller, Service, Repository, etc.) and the method calls between them.
- Use flowchart TD for pipelines/processes: show the stages and decision points.
- Keep diagrams focused — 4-8 nodes maximum. Show only architecturally significant relationships.
- Label edges with real method or event names from the codebase (e.g., "CreateOrderAsync()" not "creates").
- Every node must correspond to a real class, interface, or component from the reference data.
- Use \`\`\`mermaid fenced code blocks. Ensure valid Mermaid syntax (no trailing commas, proper quoting).`;

  const prompt = `Write the wiki page for section "${context.number}. ${context.title}".

Topic: ${context.description}

IMPORTANT: Start your output with this exact section:
## Relevant Source Files
${relevantFilesSection || "(none)"}

Then write the rest of the page using the reference data below.

<reference_data>
${symbolSummary ? `<symbols>\n${symbolSummary}\n</symbols>` : ""}
${relationshipSummary ? `<relationships>\n${relationshipSummary}\n</relationships>` : ""}
${keySourceSnippets ? `<source_snippets>\n${keySourceSnippets}\n</source_snippets>` : ""}
${callChainSection ? `<call_chains>\n${callChainSection}\n</call_chains>` : ""}
${hierarchySection ? `<type_hierarchy>\n${hierarchySection}\n</type_hierarchy>` : ""}
${crossLinks ? `<cross_links>\n${crossLinks}\n</cross_links>` : ""}
</reference_data>

Write the wiki page now. Use REAL file paths from the reference data above (never use placeholder "FileName.cs"). Include short code snippets showing key patterns. Cross-reference other wiki pages where relevant.`;

  return await provider.generate(prompt, {
    systemPrompt,
    temperature: 0.4,
    maxTokens: 8192,
  });
}

/**
 * Build a condensed summary of symbols — one line per symbol with key info.
 * Avoids verbose per-property dumps that local models echo verbatim.
 */
function buildSymbolSummary(
  context: PageContext,
  store?: GraphStore,
): string {
  if (context.focalSymbols.length === 0) return "";

  const lines: string[] = [];

  for (const s of context.focalSymbols) {
    // One-line summary per symbol
    const parts = [`${s.kind} ${s.name}`];
    if (s.signature) parts.push(`— ${s.signature.slice(0, 100)}`);
    parts.push(`(${s.filePath}:${s.startLine})`);
    if (s.isAbstract) parts.push("[abstract]");
    if (s.isStatic) parts.push("[static]");
    if (s.docstring) parts.push(`// ${s.docstring.slice(0, 100)}`);
    lines.push(parts.join(" "));

    // For classes/interfaces, list members as compact one-liners
    if (
      store &&
      (s.kind === "class" || s.kind === "interface" || s.kind === "struct")
    ) {
      const children = store
        .getEdgesFrom(s.id, "contains")
        .map((e) => store.getNode(e.target))
        .filter((n): n is SymbolNode => n !== undefined);

      for (const child of children.slice(0, 10)) {
        const sig = child.signature ? child.signature.slice(0, 60) : child.name;
        lines.push(`  └─ ${child.kind} ${sig} [${child.visibility ?? ""}]`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Build a condensed relationship summary — group by kind,
 * show only the most important relationships.
 */
function buildRelationshipSummary(
  context: PageContext,
  store?: GraphStore,
): string {
  if (context.relationships.length === 0) return "";

  // Filter to only interesting relationship types, skip contains/imports noise
  const skipKinds = new Set(["contains", "imports"]);
  const interesting = context.relationships.filter(
    (e) => !skipKinds.has(e.kind),
  );

  const grouped = new Map<string, string[]>();
  for (const e of interesting.slice(0, 30)) {
    const list = grouped.get(e.kind) ?? [];
    const srcNode = store?.getNode(e.source);
    const tgtNode = store?.getNode(e.target);
    const src = srcNode ? srcNode.name : e.source;
    const tgt = tgtNode ? tgtNode.name : e.target;
    list.push(`${src} → ${tgt}`);
    grouped.set(e.kind, list);
  }

  const lines: string[] = [];
  for (const [kind, rels] of grouped) {
    lines.push(`${kind}: ${rels.slice(0, 8).join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Build key source snippets — only the most important code blocks,
 * truncated to keep prompt size manageable.
 */
function buildKeySourceSnippets(context: PageContext): string {
  if (context.sourceBlocks.length === 0) return "";

  // Prioritize classes and important methods, skip trivial property-only classes
  const ranked = context.sourceBlocks
    .filter((b) => b.code.length > 50) // skip trivial one-liners
    .slice(0, 8); // max 8 snippets

  return ranked
    .map((b) => {
      const code = b.code.length > 1500
        ? b.code.slice(0, 1500) + "\n// ... truncated"
        : b.code;
      return `[${b.node.kind}: ${b.node.name}] ${b.filePath}:${b.startLine}-${b.endLine}\n\`\`\`${b.language}\n${code}\n\`\`\``;
    })
    .join("\n\n");
}

function buildCallChainSection(context: PageContext): string {
  if (context.callChains.length === 0) return "";

  return context.callChains
    .slice(0, 10)
    .map(
      (c) =>
        `- ${c.path.map((n) => `${n.name} (${n.filePath}:${n.startLine})`).join(" → ")}`,
    )
    .join("\n");
}

function buildHierarchySection(context: PageContext): string {
  if (context.typeHierarchies.length === 0) return "";

  return context.typeHierarchies
    .map((h) => {
      const parts: string[] = [`**${h.root.name}** (${h.root.filePath}:${h.root.startLine})`];
      if (h.ancestors.length > 0) {
        parts.push(`  Extends: ${h.ancestors.map((a) => `${a.name} (${a.filePath})`).join(" ← ")}`);
      }
      if (h.descendants.length > 0) {
        parts.push(`  Subtypes: ${h.descendants.map((d) => `${d.name} (${d.filePath})`).join(", ")}`);
      }
      return parts.join("\n");
    })
    .join("\n\n");
}

function buildCrossLinks(
  context: PageContext,
  structure: WikiStructure,
): string {
  const lines: string[] = [];
  for (const section of structure.sections) {
    if (section.number !== context.number) {
      const slug = section.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      lines.push(`- [${section.number}. ${section.title}](${section.number}-${slug}.md)`);
    }
    for (const sub of section.subsections) {
      if (sub.number !== context.number) {
        const slug = sub.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        lines.push(`  - [${sub.number}. ${sub.title}](${sub.number}-${slug}.md)`);
      }
    }
  }
  return lines.join("\n");
}
