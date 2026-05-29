import type { SymbolNode, Edge } from "../types.js";
import type { GraphStore } from "../store/index.js";

export function buildArchitectureDiagram(store: GraphStore): string {
  const files = store.getAllFiles();
  const dirs = new Map<string, string[]>();

  for (const f of files) {
    const dir = f.path.split("/").slice(0, -1).join("/") || "root";
    const list = dirs.get(dir) ?? [];
    list.push(f.path.split("/").pop() ?? f.path);
    dirs.set(dir, list);
  }

  let mermaid = "graph TD\n";
  for (const [dir, dirFiles] of dirs) {
    const safeDir = sanitizeId(dir);
    mermaid += `  subgraph ${safeDir}["${dir}"]\n`;
    for (const f of dirFiles.slice(0, 10)) {
      const safeFile = sanitizeId(dir + "/" + f);
      mermaid += `    ${safeFile}["${f}"]\n`;
    }
    mermaid += "  end\n";
  }

  return mermaid;
}

export function buildClassDiagram(
  nodes: SymbolNode[],
  edges: Edge[],
): string {
  const classes = nodes.filter(
    (n) =>
      n.kind === "class" ||
      n.kind === "interface" ||
      n.kind === "struct" ||
      n.kind === "enum",
  );

  if (classes.length === 0) return "";

  let mermaid = "classDiagram\n";

  for (const cls of classes.slice(0, 20)) {
    const prefix =
      cls.kind === "interface"
        ? "<<interface>> "
        : cls.kind === "struct"
          ? "<<struct>> "
          : cls.kind === "enum"
            ? "<<enumeration>> "
            : cls.isAbstract
              ? "<<abstract>> "
              : "";

    mermaid += `  class ${sanitizeId(cls.name)} {\n`;
    if (prefix) mermaid += `    ${prefix}\n`;
    mermaid += "  }\n";
  }

  const classIds = new Set(classes.map((c) => c.id));

  for (const edge of edges) {
    if (!classIds.has(edge.source) || !classIds.has(edge.target)) continue;

    const src = nodes.find((n) => n.id === edge.source);
    const tgt = nodes.find((n) => n.id === edge.target);
    if (!src || !tgt) continue;

    const srcName = sanitizeId(src.name);
    const tgtName = sanitizeId(tgt.name);

    switch (edge.kind) {
      case "extends":
        mermaid += `  ${tgtName} <|-- ${srcName}\n`;
        break;
      case "implements":
        mermaid += `  ${tgtName} <|.. ${srcName}\n`;
        break;
      case "contains":
        mermaid += `  ${srcName} *-- ${tgtName}\n`;
        break;
    }
  }

  return mermaid;
}

export function buildDependencyDiagram(store: GraphStore): string {
  const files = store.getAllFiles();
  let mermaid = "graph LR\n";

  const fileSet = new Set(files.map((f) => f.path));
  const addedEdges = new Set<string>();

  for (const file of files.slice(0, 30)) {
    const nodes = store.getNodesByFile(file.path);
    const imports = nodes.filter((n) => n.kind === "import");

    for (const imp of imports) {
      const edges = store.getEdgesFrom(imp.id, "imports");
      for (const edge of edges) {
        const target = store.getNode(edge.target);
        if (target && target.filePath !== file.path && fileSet.has(target.filePath)) {
          const key = `${file.path}->${target.filePath}`;
          if (addedEdges.has(key)) continue;
          addedEdges.add(key);

          const srcName = sanitizeId(file.path);
          const tgtName = sanitizeId(target.filePath);
          mermaid += `  ${srcName}["${shortPath(file.path)}"] --> ${tgtName}["${shortPath(target.filePath)}"]\n`;
        }
      }
    }
  }

  return mermaid;
}

function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.length > 2
    ? `.../${parts.slice(-2).join("/")}`
    : path;
}
