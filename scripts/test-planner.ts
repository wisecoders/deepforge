#!/usr/bin/env npx tsx
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url).pathname, "utf-8").split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
}

import { GraphStore } from "../src/store/index.js";
import { createProvider } from "../src/llm/index.js";
import { planWikiStructure } from "../src/generator/planner.js";

const store = new GraphStore("/Users/muthu/Documents/workspace/eShopOnWeb/.deepforge/graph.db");
const provider = await createProvider({ provider: "claude", apiKey: process.env.ANTHROPIC_API_KEY });
const structure = await planWikiStructure(store, provider);

console.log("Title:", structure.title);
console.log("Sections:", structure.sections.length, "with", structure.sections.reduce((s, sec) => s + sec.subsections.length, 0), "subsections");
console.log("---");
for (const s of structure.sections) {
  console.log(`${s.number}. ${s.title}`);
  for (const sub of s.subsections) {
    console.log(`  ${sub.number}. ${sub.title}`);
  }
}
store.close();
