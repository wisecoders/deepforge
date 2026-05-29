import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { detectLanguage } from "../extraction/languages/index.js";
import type { FileRecord } from "../types.js";
import type { IgnoreFilter } from "./ignore.js";

export function fsScan(
  projectRoot: string,
  filter: IgnoreFilter,
  maxFileSize: number,
): FileRecord[] {
  const records: FileRecord[] = [];
  walk(projectRoot, projectRoot, filter, maxFileSize, records);
  return records;
}

function walk(
  dir: string,
  projectRoot: string,
  filter: IgnoreFilter,
  maxFileSize: number,
  records: FileRecord[],
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = relative(projectRoot, fullPath);

    if (filter.isIgnored(relativePath)) continue;

    if (entry.isDirectory()) {
      walk(fullPath, projectRoot, filter, maxFileSize, records);
      continue;
    }

    if (!entry.isFile()) continue;

    const language = detectLanguage(relativePath);
    if (language === "unknown") continue;

    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.size > maxFileSize) continue;

    const content = readFileSync(fullPath, "utf-8");
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);

    records.push({
      path: relativePath,
      language,
      contentHash: hash,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      indexedAt: 0,
      nodeCount: 0,
    });
  }
}
