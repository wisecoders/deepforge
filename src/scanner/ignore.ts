import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_IGNORE = [
  "node_modules",
  "dist",
  "build",
  "out",
  ".git",
  ".hg",
  ".svn",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "venv",
  ".venv",
  "env",
  ".env",
  ".tox",
  "coverage",
  ".coverage",
  ".nyc_output",
  ".next",
  ".nuxt",
  ".cache",
  ".parcel-cache",
  ".turbo",
  "vendor",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
  ".DS_Store",
  "Thumbs.db",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "*.pb.go",
  "*.generated.*",
];

export interface IgnoreFilter {
  isIgnored(relativePath: string): boolean;
}

export function createIgnoreFilter(
  projectRoot: string,
  extraPatterns: string[] = [],
): IgnoreFilter {
  const patterns = [...DEFAULT_IGNORE, ...extraPatterns];

  const gitignorePath = join(projectRoot, ".gitignore");
  try {
    const content = readFileSync(gitignorePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        patterns.push(trimmed);
      }
    }
  } catch {
    // No .gitignore — use defaults only
  }

  const matchers = patterns.map(compilePattern);

  return {
    isIgnored(relativePath: string): boolean {
      const segments = relativePath.split("/");
      for (const matcher of matchers) {
        if (matcher(relativePath, segments)) return true;
      }
      return false;
    },
  };
}

type Matcher = (path: string, segments: string[]) => boolean;

function compilePattern(pattern: string): Matcher {
  let p = pattern.replace(/\/$/, "");
  const negated = p.startsWith("!");
  if (negated) p = p.slice(1);

  // Simple glob: *.ext
  if (p.startsWith("*.")) {
    const ext = p.slice(1);
    const check: Matcher = (path) => path.endsWith(ext);
    return negated ? (path, segs) => !check(path, segs) : check;
  }

  // Double-star patterns: **/foo or foo/**/bar
  if (p.includes("**")) {
    const regex = new RegExp(
      "^" +
        p
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, ".*")
          .replace(/(?<!\.)(\*)/g, "[^/]*")
          .replace(/\?/g, "[^/]") +
        "(/.*)?$",
    );
    const check: Matcher = (path) => regex.test(path);
    return negated ? (path, segs) => !check(path, segs) : check;
  }

  // Bare name: match any path segment
  if (!p.includes("/")) {
    // Also handle wildcard in bare name: *.generated.*
    if (p.includes("*") || p.includes("?")) {
      const regex = new RegExp(
        "^" +
          p
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, "[^/]") +
          "$",
      );
      const check: Matcher = (_path, segments) =>
        segments.some((s) => regex.test(s));
      return negated
        ? (path, segs) => !check(path, segs)
        : check;
    }
    const check: Matcher = (_path, segments) => segments.includes(p);
    return negated ? (path, segs) => !check(path, segs) : check;
  }

  // Path pattern with slashes
  const regex = new RegExp(
    "^" +
      p
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]") +
      "(/.*)?$",
  );
  const check: Matcher = (path) => regex.test(path);
  return negated ? (path, segs) => !check(path, segs) : check;
}
