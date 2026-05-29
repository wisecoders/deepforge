import type { FileRecord } from "../types.js";
import { createIgnoreFilter } from "./ignore.js";
import { isGitRepo, gitScan } from "./git-scanner.js";
import { fsScan } from "./fs-scanner.js";

const DEFAULT_MAX_FILE_SIZE = 1024 * 1024; // 1MB

export interface ScanOptions {
  ignore?: string[];
  maxFileSize?: number;
}

export function scanProject(
  projectRoot: string,
  options: ScanOptions = {},
): FileRecord[] {
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const filter = createIgnoreFilter(projectRoot, options.ignore);

  if (isGitRepo(projectRoot)) {
    return gitScan(projectRoot, filter, maxFileSize);
  }
  return fsScan(projectRoot, filter, maxFileSize);
}

export { createIgnoreFilter } from "./ignore.js";
