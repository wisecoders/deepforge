import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { detectLanguage } from "../extraction/languages/index.js";
import type { FileRecord } from "../types.js";
import type { IgnoreFilter } from "./ignore.js";

export function isGitRepo(projectRoot: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: projectRoot,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

export function gitScan(
  projectRoot: string,
  filter: IgnoreFilter,
  maxFileSize: number,
): FileRecord[] {
  const output = execSync("git ls-files -z", {
    cwd: projectRoot,
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });

  const files = output.split("\0").filter((f) => f.length > 0);
  const records: FileRecord[] = [];

  for (const relativePath of files) {
    if (filter.isIgnored(relativePath)) continue;

    const language = detectLanguage(relativePath);
    if (language === "unknown") continue;

    const fullPath = join(projectRoot, relativePath);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.size > maxFileSize) continue;
    if (!stat.isFile()) continue;

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

  return records;
}
