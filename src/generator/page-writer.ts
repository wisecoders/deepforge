import type { PageContext } from "../types.js";
import type { LlmProvider } from "../llm/index.js";

export async function generatePage(
  context: PageContext,
  provider: LlmProvider,
): Promise<string> {
  const symbolDescriptions = context.focalSymbols
    .map((s) => {
      let desc = `- **${s.kind}** \`${s.qualifiedName}\``;
      if (s.signature) desc += `\n  Signature: \`${s.signature}\``;
      if (s.docstring) desc += `\n  ${s.docstring}`;
      return desc;
    })
    .join("\n\n");

  const edgeDescriptions = context.relationships
    .slice(0, 30)
    .map((e) => `  ${e.source} —[${e.kind}]→ ${e.target}`)
    .join("\n");

  const sourceCodeBlocks = context.sourceBlocks
    .slice(0, 10)
    .map(
      (b) =>
        `### ${b.node.qualifiedName} [${b.filePath}:${b.startLine}-${b.endLine}]\n\`\`\`${b.language}\n${b.code}\n\`\`\``,
    )
    .join("\n\n");

  const callChainDesc = context.callChains
    .map((c) => `  ${c.path.map((n) => n.name).join(" → ")}`)
    .join("\n");

  const hierarchyDesc = context.typeHierarchies
    .map((h) => {
      const ancestors = h.ancestors.map((a) => a.name).join(" ← ");
      const descendants = h.descendants.map((d) => d.name).join(", ");
      let desc = `  ${h.root.name}`;
      if (ancestors) desc += ` extends ${ancestors}`;
      if (descendants) desc += ` | subtypes: ${descendants}`;
      return desc;
    })
    .join("\n");

  const prompt = `Write a technical documentation page about: ${context.title}

## Description
${context.description}

## Symbols
${symbolDescriptions || "(no symbols)"}

## Relationships
${edgeDescriptions || "(none)"}

## Source Code
${sourceCodeBlocks || "(no source available)"}

## Call Chains
${callChainDesc || "(none)"}

## Type Hierarchies
${hierarchyDesc || "(none)"}

## Related Files
${context.relatedFiles.join(", ") || "(none)"}

## Requirements
- Write a coherent technical narrative, not a symbol dump
- Include Mermaid diagrams for architecture and data flow where appropriate
- Cite source files as [filename:startLine-endLine]
- Cross-reference related sections where appropriate
- Target audience: developer new to this codebase
- Use markdown formatting`;

  const systemPrompt = `You are a technical documentation writer. Write clear, well-structured documentation pages for a code wiki. Focus on explaining what the code does, how components interact, and why design decisions were made. Include Mermaid diagrams where they aid understanding.`;

  return await provider.generate(prompt, {
    systemPrompt,
    temperature: 0.4,
  });
}
