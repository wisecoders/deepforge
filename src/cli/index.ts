#!/usr/bin/env node

/**
 * Deepforge CLI entry point.
 */

import { Command } from "commander";

const program = new Command();

program
  .name("deepforge")
  .description("Generate structured wiki documentation for any code repository")
  .version("0.1.0");

program
  .command("generate <projectPath>")
  .description("Index a codebase and generate wiki documentation")
  .option("-o, --output <path>", "Output directory for wiki files", "./wiki")
  .option("--skip-index", "Skip indexing, use existing graph database")
  .option("--provider <provider>", "LLM provider: claude, openai, ollama", "claude")
  .option("--model <model>", "LLM model name")
  .action(async (projectPath: string, options) => {
    console.log(`Deepforge: generating wiki for ${projectPath}`);
    console.log(`Output: ${options.output}`);
    console.log("(not yet implemented)");
  });

program
  .command("index <projectPath>")
  .description("Index a codebase into a knowledge graph (no wiki generation)")
  .action(async (projectPath: string) => {
    console.log(`Deepforge: indexing ${projectPath}`);
    console.log("(not yet implemented)");
  });

program
  .command("status <projectPath>")
  .description("Show knowledge graph statistics")
  .action(async (projectPath: string) => {
    console.log(`Deepforge: status for ${projectPath}`);
    console.log("(not yet implemented)");
  });

program
  .command("query <projectPath> <query>")
  .description("Query the knowledge graph")
  .option("-k, --top-k <number>", "Number of results", "10")
  .action(async (projectPath: string, query: string, options) => {
    console.log(`Deepforge: querying "${query}" in ${projectPath}`);
    console.log("(not yet implemented)");
  });

program.parse();
