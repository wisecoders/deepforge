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
  const symbolSection = buildSymbolSection(context, options?.store);
  const relationshipSection = buildRelationshipSection(context, options?.store);
  const sourceSection = buildSourceSection(context);
  const callChainSection = buildCallChainSection(context);
  const hierarchySection = buildHierarchySection(context);
  const crossLinks = options?.wikiStructure
    ? buildCrossLinks(context, options.wikiStructure)
    : "";

  const prompt = `Write a comprehensive technical documentation page for a code wiki.

## Page: ${context.number}. ${context.title}

## Topic Description
${context.description}

## Symbols to Document
${symbolSection || "(No specific symbols — write a conceptual overview based on the topic)"}

## Relationships Between Components
${relationshipSection || "(none detected)"}

## Source Code
${sourceSection || "(no source available)"}

## Call Chains (how components interact at runtime)
${callChainSection || "(none)"}

## Type Hierarchies (inheritance structure)
${hierarchySection || "(none)"}

## Related Source Files
${context.relatedFiles.slice(0, 20).join("\n") || "(none)"}

${crossLinks ? `## Other Wiki Pages (for cross-linking)\n${crossLinks}` : ""}

## WRITING REQUIREMENTS

You must produce a detailed, well-structured documentation page (1500-2500 words). Follow this structure:

### 1. Purpose and Scope (2-3 paragraphs)
- What this module/component does and why it exists
- Where it fits in the overall architecture
- Key design decisions and patterns used

### 2. Architecture / Component Overview
- Include a Mermaid diagram showing the component relationships:
  - Use \`classDiagram\` for entity/class relationships
  - Use \`graph TD\` or \`flowchart TD\` for architectural flows
  - Use \`sequenceDiagram\` for request/response flows
- Describe each component's role

### 3. Detailed Component Documentation
For each important class/interface/function:
- What it does and why
- Key methods/properties with their purpose
- How it connects to other components
- Reference source files as \`filename:startLine-endLine\`

### 4. Data Flow / Process Flow
- How data moves through these components
- Include a Mermaid \`sequenceDiagram\` or \`flowchart\` if appropriate
- Describe key interactions step by step

### 5. Key Implementation Details
- Important patterns (repository, specification, factory, etc.)
- Configuration and dependency injection
- Error handling approaches

### 6. Integration Points
- How this module connects to other parts of the system
- External dependencies
- Cross-reference other wiki pages where relevant

### FORMATTING RULES
- Use markdown headers (##, ###) to structure content
- Reference source files inline as \`filename:line\` (e.g., \`OrderService.cs:42\`)
- Include 2-4 Mermaid diagrams per page (class diagrams, flowcharts, sequence diagrams)
- Use tables where comparing multiple items (properties, endpoints, configuration options)
- Use bullet points for lists of properties, methods, or features
- Write for a developer who is new to this codebase
- Be specific and technical — avoid vague statements
- Do NOT start with "Okay" or "Sure" or any preamble — start directly with the content`;

  const systemPrompt = `You are a senior technical writer producing wiki documentation for a code repository. Write clear, thorough, well-structured pages that help developers understand the codebase quickly. Your pages should match the quality of DeepWiki.com documentation — comprehensive, well-diagrammed, and precisely referenced to source code.

Key principles:
- Every claim should be traceable to source code (cite files and line numbers)
- Diagrams should illustrate actual relationships from the code, not generic patterns
- Use Mermaid syntax for all diagrams
- Be comprehensive but focused — cover what's in scope for this page
- Cross-reference related wiki pages when mentioning topics covered elsewhere`;

  return await provider.generate(prompt, {
    systemPrompt,
    temperature: 0.4,
    maxTokens: 8192,
  });
}

function buildSymbolSection(
  context: PageContext,
  store?: GraphStore,
): string {
  if (context.focalSymbols.length === 0) return "";

  const groups = new Map<string, SymbolNode[]>();
  for (const s of context.focalSymbols) {
    const list = groups.get(s.kind) ?? [];
    list.push(s);
    groups.set(s.kind, list);
  }

  const lines: string[] = [];

  for (const [kind, symbols] of groups) {
    lines.push(`### ${kind.charAt(0).toUpperCase() + kind.slice(1)}s`);
    for (const s of symbols) {
      lines.push(`\n**${s.name}** (\`${s.filePath}:${s.startLine}-${s.endLine}\`)`);
      if (s.signature) lines.push(`  Signature: \`${s.signature}\``);
      if (s.visibility) lines.push(`  Visibility: ${s.visibility}`);
      if (s.docstring) lines.push(`  Doc: ${s.docstring.slice(0, 200)}`);
      if (s.isAbstract) lines.push("  Abstract: yes");
      if (s.isStatic) lines.push("  Static: yes");
      if (s.isAsync) lines.push("  Async: yes");
      if (s.decorators?.length) lines.push(`  Decorators: ${s.decorators.join(", ")}`);

      // Include members for classes
      if (
        store &&
        (s.kind === "class" || s.kind === "interface" || s.kind === "struct")
      ) {
        const children = store
          .getEdgesFrom(s.id, "contains")
          .map((e) => store.getNode(e.target))
          .filter((n): n is SymbolNode => n !== undefined);

        if (children.length > 0) {
          lines.push("  Members:");
          for (const child of children.slice(0, 15)) {
            let memberLine = `    - ${child.kind} \`${child.name}\``;
            if (child.signature) memberLine += ` — ${child.signature.slice(0, 80)}`;
            if (child.visibility) memberLine += ` [${child.visibility}]`;
            lines.push(memberLine);
          }
        }
      }
    }
  }

  return lines.join("\n");
}

function buildRelationshipSection(
  context: PageContext,
  store?: GraphStore,
): string {
  if (context.relationships.length === 0) return "";

  const lines: string[] = [];
  const grouped = new Map<string, { source: string; target: string }[]>();

  for (const e of context.relationships.slice(0, 50)) {
    const list = grouped.get(e.kind) ?? [];
    const srcNode = store?.getNode(e.source);
    const tgtNode = store?.getNode(e.target);
    list.push({
      source: srcNode ? `${srcNode.name} (${srcNode.kind})` : e.source,
      target: tgtNode ? `${tgtNode.name} (${tgtNode.kind})` : e.target,
    });
    grouped.set(e.kind, list);
  }

  for (const [kind, rels] of grouped) {
    lines.push(`### ${kind} relationships`);
    for (const r of rels.slice(0, 15)) {
      lines.push(`- ${r.source} → ${r.target}`);
    }
  }

  return lines.join("\n");
}

function buildSourceSection(context: PageContext): string {
  if (context.sourceBlocks.length === 0) return "";

  return context.sourceBlocks
    .slice(0, 15)
    .map(
      (b) =>
        `### ${b.node.kind}: ${b.node.name} [${b.filePath}:${b.startLine}-${b.endLine}]\n\`\`\`${b.language}\n${b.code}\n\`\`\``,
    )
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
