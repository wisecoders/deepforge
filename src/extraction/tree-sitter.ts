import { Parser, Language } from "web-tree-sitter";
import type { Tree } from "web-tree-sitter";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WASM_DIR = resolve(__dirname, "../../wasm");

const GRAMMAR_MAP: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  javascript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  jsx: "tree-sitter-tsx.wasm",
  python: "tree-sitter-python.wasm",
};

let initialized = false;
const loadedLanguages = new Map<string, Language>();
const parsers = new Map<string, Parser>();

export async function initTreeSitter(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
}

export async function getParser(language: string): Promise<Parser | null> {
  await initTreeSitter();

  if (parsers.has(language)) return parsers.get(language)!;

  const grammarFile = GRAMMAR_MAP[language];
  if (!grammarFile) return null;

  const wasmPath = resolve(WASM_DIR, grammarFile);
  if (!existsSync(wasmPath)) return null;

  let lang = loadedLanguages.get(grammarFile);
  if (!lang) {
    lang = await Language.load(wasmPath);
    loadedLanguages.set(grammarFile, lang);
  }

  const parser = new Parser();
  parser.setLanguage(lang);
  parsers.set(language, parser);
  return parser;
}

export function parseSource(parser: Parser, source: string): Tree {
  return parser.parse(source)!;
}
