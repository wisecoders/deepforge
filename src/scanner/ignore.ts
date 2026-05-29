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
  const rawPatterns = [...DEFAULT_IGNORE, ...extraPatterns];

  const gitignorePath = join(projectRoot, ".gitignore");
  try {
    const content = readFileSync(gitignorePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        rawPatterns.push(trimmed);
      }
    }
  } catch {
    // No .gitignore — use defaults only
  }

  const ignoreMatchers: Matcher[] = [];
  const negationMatchers: Matcher[] = [];

  for (const pattern of rawPatterns) {
    if (pattern.startsWith("!")) {
      negationMatchers.push(compilePattern(pattern.slice(1)));
    } else {
      ignoreMatchers.push(compilePattern(pattern));
    }
  }

  return {
    isIgnored(relativePath: string): boolean {
      const segments = relativePath.split("/");
      let ignored = false;
      for (const matcher of ignoreMatchers) {
        if (matcher(relativePath, segments)) {
          ignored = true;
          break;
        }
      }
      if (ignored) {
        for (const matcher of negationMatchers) {
          if (matcher(relativePath, segments)) return false;
        }
      }
      return ignored;
    },
  };
}

type Matcher = (path: string, segments: string[]) => boolean;

function compilePattern(pattern: string): Matcher {
  const p = pattern.replace(/\/$/, "");

  // Simple glob: *.ext
  if (p.startsWith("*.")) {
    const ext = p.slice(1);
    return (path) => path.endsWith(ext);
  }

  // Bracket expression patterns like [Dd]ebug
  if (p.includes("[")) {
    const regex = new RegExp(
      "^" +
        p
          .replace(/[.+^${}()|\\]/g, "\\$&")
          .replace(/\*\*/g, "<<DOUBLESTAR>>")
          .replace(/\*/g, "[^/]*")
          .replace(/<<DOUBLESTAR>>/g, ".*")
          .replace(/\?/g, "[^/]") +
        "(/.*)?$",
    );
    if (!p.includes("/")) {
      return (_path, segments) => segments.some((s) => regex.test(s));
    }
    return (path) => regex.test(path);
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
    return (path) => regex.test(path);
  }

  // Bare name: match any path segment
  if (!p.includes("/")) {
    if (p.includes("*") || p.includes("?")) {
      const regex = new RegExp(
        "^" +
          p
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, "[^/]") +
          "$",
      );
      return (_path, segments) => segments.some((s) => regex.test(s));
    }
    return (_path, segments) => segments.includes(p);
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
  return (path) => regex.test(path);
}
