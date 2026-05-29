import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { scanProject } from "../../src/scanner/index.js";
import { createIgnoreFilter } from "../../src/scanner/ignore.js";

const TEST_DIR = join(
  tmpdir(),
  `deepforge-scanner-test-${Date.now()}`,
);

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "src"), { recursive: true });
  mkdirSync(join(TEST_DIR, "node_modules/lib"), { recursive: true });
  mkdirSync(join(TEST_DIR, "dist"), { recursive: true });

  writeFileSync(join(TEST_DIR, "src/index.ts"), "export const x = 1;\n");
  writeFileSync(join(TEST_DIR, "src/utils.ts"), "export function foo() {}\n");
  writeFileSync(join(TEST_DIR, "src/app.py"), "def main(): pass\n");
  writeFileSync(join(TEST_DIR, "src/readme.md"), "# Docs\n");
  writeFileSync(join(TEST_DIR, "dist/index.js"), "var x = 1;\n");
  writeFileSync(
    join(TEST_DIR, "node_modules/lib/index.js"),
    "module.exports = {};\n",
  );
  writeFileSync(join(TEST_DIR, ".gitignore"), "dist/\n*.log\n");

  // Init a git repo so git scanner is used
  execSync("git init", { cwd: TEST_DIR, stdio: "pipe" });
  execSync("git add -A", { cwd: TEST_DIR, stdio: "pipe" });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Scanner", () => {
  it("finds source files and detects languages", () => {
    const files = scanProject(TEST_DIR);
    const paths = files.map((f) => f.path);

    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/utils.ts");
    expect(paths).toContain("src/app.py");
  });

  it("ignores node_modules", () => {
    const files = scanProject(TEST_DIR);
    const paths = files.map((f) => f.path);
    expect(paths.every((p) => !p.includes("node_modules"))).toBe(true);
  });

  it("ignores dist directory", () => {
    const files = scanProject(TEST_DIR);
    const paths = files.map((f) => f.path);
    expect(paths.every((p) => !p.startsWith("dist/"))).toBe(true);
  });

  it("skips unknown languages", () => {
    const files = scanProject(TEST_DIR);
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain("src/readme.md");
  });

  it("detects correct languages", () => {
    const files = scanProject(TEST_DIR);
    const tsFile = files.find((f) => f.path === "src/index.ts");
    const pyFile = files.find((f) => f.path === "src/app.py");
    expect(tsFile?.language).toBe("typescript");
    expect(pyFile?.language).toBe("python");
  });

  it("computes content hashes", () => {
    const files = scanProject(TEST_DIR);
    for (const f of files) {
      expect(f.contentHash).toBeDefined();
      expect(f.contentHash.length).toBe(12);
    }
  });

  it("records file sizes", () => {
    const files = scanProject(TEST_DIR);
    for (const f of files) {
      expect(f.size).toBeGreaterThan(0);
    }
  });
});

describe("IgnoreFilter", () => {
  it("ignores default patterns", () => {
    const filter = createIgnoreFilter(TEST_DIR);
    expect(filter.isIgnored("node_modules/foo/bar.js")).toBe(true);
    expect(filter.isIgnored(".git/HEAD")).toBe(true);
    expect(filter.isIgnored("__pycache__/mod.pyc")).toBe(true);
  });

  it("reads .gitignore patterns", () => {
    const filter = createIgnoreFilter(TEST_DIR);
    expect(filter.isIgnored("dist/index.js")).toBe(true);
    expect(filter.isIgnored("app.log")).toBe(true);
  });

  it("does not ignore valid source files", () => {
    const filter = createIgnoreFilter(TEST_DIR);
    expect(filter.isIgnored("src/index.ts")).toBe(false);
    expect(filter.isIgnored("src/app.py")).toBe(false);
  });

  it("accepts extra patterns", () => {
    const filter = createIgnoreFilter(TEST_DIR, ["*.test.ts"]);
    expect(filter.isIgnored("src/foo.test.ts")).toBe(true);
    expect(filter.isIgnored("src/foo.ts")).toBe(false);
  });
});
