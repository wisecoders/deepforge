import { createHash } from "node:crypto";
import type { Tree, Node as SyntaxNode } from "web-tree-sitter";
import type { LanguageExtractor } from "./index.js";
import { registerExtractor } from "./index.js";
import type {
  SymbolNode,
  Edge,
  UnresolvedReference,
  ExtractionResult,
  NodeKind,
} from "../../types.js";

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c != null);
}

function makeId(filePath: string, qualifiedName: string): string {
  return createHash("sha256")
    .update(`${filePath}::${qualifiedName}`)
    .digest("hex")
    .slice(0, 16);
}

function contentHash(source: string, start: number, end: number): string {
  return createHash("sha256").update(source.slice(start, end)).digest("hex").slice(0, 12);
}

function getDocstring(node: SyntaxNode): string | undefined {
  const body = node.childForFieldName("body");
  if (!body) return undefined;

  const first = namedChildren(body)[0];
  if (!first) return undefined;

  if (first.type === "expression_statement") {
    const expr = namedChildren(first)[0];
    if (expr?.type === "string" || expr?.type === "concatenated_string") {
      return expr.text
        .replace(/^("""|'''|"|')/, "")
        .replace(/("""|'''|"|')$/, "")
        .trim();
    }
  }
  return undefined;
}

function getDecorators(node: SyntaxNode): string[] | undefined {
  if (node.parent?.type !== "decorated_definition") return undefined;
  const decorators: string[] = [];
  for (const child of namedChildren(node.parent)) {
    if (child.type === "decorator") {
      decorators.push(child.text);
    }
  }
  return decorators.length > 0 ? decorators : undefined;
}

function isStaticMethod(node: SyntaxNode): boolean {
  if (node.parent?.type !== "decorated_definition") return false;
  return namedChildren(node.parent).some(
    (c) => c.type === "decorator" && c.text.includes("staticmethod"),
  );
}

function isClassMethod(node: SyntaxNode): boolean {
  if (node.parent?.type !== "decorated_definition") return false;
  return namedChildren(node.parent).some(
    (c) => c.type === "decorator" && c.text.includes("classmethod"),
  );
}

function isAbstractMethod(node: SyntaxNode): boolean {
  if (node.parent?.type !== "decorated_definition") return false;
  return namedChildren(node.parent).some(
    (c) => c.type === "decorator" && c.text.includes("abstractmethod"),
  );
}

function getSignature(node: SyntaxNode, source: string): string | undefined {
  const params = node.childForFieldName("parameters");
  const retType = node.childForFieldName("return_type");
  if (!params) return undefined;
  const end = retType ? retType.endIndex : params.endIndex;
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return undefined;
  return source.slice(nameNode.startIndex, end).trim();
}

function findDescendants(node: SyntaxNode, type: string): SyntaxNode[] {
  const results: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === type) results.push(current);
    for (let i = 0; i < current.childCount; i++) {
      const child = current.child(i);
      if (child) stack.push(child);
    }
  }
  return results;
}

interface ExtractionContext {
  filePath: string;
  source: string;
  nodes: SymbolNode[];
  edges: Edge[];
  unresolvedRefs: UnresolvedReference[];
  scopeStack: string[];
}

function qualifiedName(ctx: ExtractionContext, name: string): string {
  if (ctx.scopeStack.length === 0) {
    return `${ctx.filePath}::${name}`;
  }
  const scope = ctx.scopeStack[ctx.scopeStack.length - 1];
  return `${scope}.${name}`;
}

const PRIMITIVES = new Set([
  "int", "float", "str", "bool", "bytes", "None",
  "list", "dict", "tuple", "set", "frozenset",
  "Any", "Optional", "Union", "List", "Dict", "Tuple", "Set",
  "Callable", "Iterator", "Generator", "Coroutine",
  "type", "object",
]);

const BUILTINS = new Set([
  "print", "len", "range", "enumerate", "zip", "map", "filter",
  "sorted", "reversed", "isinstance", "issubclass", "hasattr",
  "getattr", "setattr", "delattr", "super", "property",
  "staticmethod", "classmethod", "abstractmethod",
  "int", "float", "str", "bool", "list", "dict", "tuple", "set",
  "type", "object", "repr", "id", "hash", "input", "open",
]);

function extractClass(node: SyntaxNode, ctx: ExtractionContext): void {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return;

  const name = nameNode.text;
  const qName = qualifiedName(ctx, name);
  const id = makeId(ctx.filePath, qName);

  const symbolNode: SymbolNode = {
    id,
    kind: "class",
    name,
    qualifiedName: qName,
    filePath: ctx.filePath,
    language: "python",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    docstring: getDocstring(node),
    decorators: getDecorators(node),
    isAbstract: isAbstractClass(node) || undefined,
    contentHash: contentHash(ctx.source, node.startIndex, node.endIndex),
    updatedAt: Date.now(),
  };
  ctx.nodes.push(symbolNode);

  if (ctx.scopeStack.length > 0) {
    const parentQName = ctx.scopeStack[ctx.scopeStack.length - 1];
    const parentId = makeId(ctx.filePath, parentQName);
    ctx.edges.push({
      source: parentId,
      target: id,
      kind: "contains",
      line: node.startPosition.row + 1,
      provenance: "tree-sitter",
    });
  }

  // Base classes (extends)
  const superclasses = node.childForFieldName("superclasses");
  if (superclasses) {
    for (const arg of namedChildren(superclasses)) {
      const baseName =
        arg.type === "identifier"
          ? arg.text
          : arg.type === "attribute"
            ? arg.text
            : null;
      if (baseName && !PRIMITIVES.has(baseName)) {
        ctx.unresolvedRefs.push({
          fromNodeId: id,
          referenceName: baseName,
          referenceKind: "extends",
          filePath: ctx.filePath,
          language: "python",
          line: arg.startPosition.row + 1,
          column: arg.startPosition.column,
        });
      }
    }
  }

  ctx.scopeStack.push(qName);
  const body = node.childForFieldName("body");
  if (body) extractBlock(body, ctx);
  ctx.scopeStack.pop();
}

function isAbstractClass(node: SyntaxNode): boolean {
  const body = node.childForFieldName("body");
  if (!body) return false;
  const methods = findDescendants(body, "function_definition");
  return methods.some(isAbstractMethod);
}

function extractFunction(
  node: SyntaxNode,
  ctx: ExtractionContext,
): void {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return;

  const name = nameNode.text;
  const qName = qualifiedName(ctx, name);
  const id = makeId(ctx.filePath, qName);

  const isMethod = ctx.scopeStack.length > 1;
  const kind: NodeKind = isMethod ? "method" : "function";
  const isAsync = node.text.startsWith("async ");

  const symbolNode: SymbolNode = {
    id,
    kind,
    name,
    qualifiedName: qName,
    filePath: ctx.filePath,
    language: "python",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: getSignature(node, ctx.source),
    docstring: getDocstring(node),
    decorators: getDecorators(node),
    isAsync: isAsync || undefined,
    isStatic: isStaticMethod(node) || undefined,
    isAbstract: isAbstractMethod(node) || undefined,
    contentHash: contentHash(ctx.source, node.startIndex, node.endIndex),
    updatedAt: Date.now(),
  };
  ctx.nodes.push(symbolNode);

  if (ctx.scopeStack.length > 0) {
    const parentQName = ctx.scopeStack[ctx.scopeStack.length - 1];
    const parentId = makeId(ctx.filePath, parentQName);
    ctx.edges.push({
      source: parentId,
      target: id,
      kind: "contains",
      line: node.startPosition.row + 1,
      provenance: "tree-sitter",
    });
  }

  // Return type reference
  const retType = node.childForFieldName("return_type");
  if (retType) {
    const typeName = extractTypeName(retType);
    if (typeName && !PRIMITIVES.has(typeName)) {
      ctx.unresolvedRefs.push({
        fromNodeId: id,
        referenceName: typeName,
        referenceKind: "returns",
        filePath: ctx.filePath,
        language: "python",
        line: retType.startPosition.row + 1,
        column: retType.startPosition.column,
      });
    }
  }

  // Extract calls from body
  ctx.scopeStack.push(qName);
  const body = node.childForFieldName("body");
  if (body) extractCallsFromBody(body, id, ctx);
  ctx.scopeStack.pop();
}

function extractImport(node: SyntaxNode, ctx: ExtractionContext): void {
  if (node.type === "import_statement") {
    for (const child of namedChildren(node)) {
      if (child.type === "dotted_name") {
        const moduleName = child.text;
        const qName = `${ctx.filePath}::import(${moduleName})`;
        const id = makeId(ctx.filePath, qName);
        ctx.nodes.push({
          id,
          kind: "import",
          name: moduleName,
          qualifiedName: qName,
          filePath: ctx.filePath,
          language: "python",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startColumn: node.startPosition.column,
          endColumn: node.endPosition.column,
          contentHash: contentHash(ctx.source, node.startIndex, node.endIndex),
          updatedAt: Date.now(),
        });
        if (ctx.scopeStack.length > 0) {
          const parentQName = ctx.scopeStack[ctx.scopeStack.length - 1];
          const parentId = makeId(ctx.filePath, parentQName);
          ctx.edges.push({
            source: parentId,
            target: id,
            kind: "contains",
            line: node.startPosition.row + 1,
            provenance: "tree-sitter",
          });
        }
      }
    }
  } else if (node.type === "import_from_statement") {
    const children = namedChildren(node);
    const moduleNode = children[0];
    if (!moduleNode) return;
    const moduleName = moduleNode.text;

    const qName = `${ctx.filePath}::import(${moduleName})`;
    const id = makeId(ctx.filePath, qName);

    ctx.nodes.push({
      id,
      kind: "import",
      name: moduleName,
      qualifiedName: qName,
      filePath: ctx.filePath,
      language: "python",
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      contentHash: contentHash(ctx.source, node.startIndex, node.endIndex),
      updatedAt: Date.now(),
    });

    if (ctx.scopeStack.length > 0) {
      const parentQName = ctx.scopeStack[ctx.scopeStack.length - 1];
      const parentId = makeId(ctx.filePath, parentQName);
      ctx.edges.push({
        source: parentId,
        target: id,
        kind: "contains",
        line: node.startPosition.row + 1,
        provenance: "tree-sitter",
      });
    }

    // Each imported name
    for (let i = 1; i < children.length; i++) {
      const imported = children[i];
      if (imported.type === "dotted_name") {
        ctx.unresolvedRefs.push({
          fromNodeId: id,
          referenceName: imported.text,
          referenceKind: "imports",
          filePath: ctx.filePath,
          language: "python",
          line: imported.startPosition.row + 1,
          column: imported.startPosition.column,
          candidates: [moduleName],
        });
      }
    }
  }
}

function extractVariable(node: SyntaxNode, ctx: ExtractionContext): void {
  // Module-level assignments: NAME = value or NAME: type = value
  if (ctx.scopeStack.length > 1) return;

  if (node.type !== "expression_statement") return;
  const child = namedChildren(node)[0];
  if (!child) return;

  if (child.type !== "assignment") return;

  const nameNode = child.childForFieldName("left");
  if (!nameNode || nameNode.type !== "identifier") return;

  const name = nameNode.text;
  // Skip dunder or private internals
  if (name.startsWith("_") && !name.startsWith("__")) return;

  const qName = qualifiedName(ctx, name);
  const id = makeId(ctx.filePath, qName);

  const isConst = name === name.toUpperCase() && name.length > 1;

  const symbolNode: SymbolNode = {
    id,
    kind: isConst ? "constant" : "variable",
    name,
    qualifiedName: qName,
    filePath: ctx.filePath,
    language: "python",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    contentHash: contentHash(ctx.source, node.startIndex, node.endIndex),
    updatedAt: Date.now(),
  };
  ctx.nodes.push(symbolNode);

  if (ctx.scopeStack.length > 0) {
    const parentQName = ctx.scopeStack[ctx.scopeStack.length - 1];
    const parentId = makeId(ctx.filePath, parentQName);
    ctx.edges.push({
      source: parentId,
      target: id,
      kind: "contains",
      line: node.startPosition.row + 1,
      provenance: "tree-sitter",
    });
  }

  // Type annotation
  const typeNode = child.childForFieldName("type");
  if (typeNode) {
    const typeName = extractTypeName(typeNode);
    if (typeName && !PRIMITIVES.has(typeName)) {
      ctx.unresolvedRefs.push({
        fromNodeId: id,
        referenceName: typeName,
        referenceKind: "type_of",
        filePath: ctx.filePath,
        language: "python",
        line: typeNode.startPosition.row + 1,
        column: typeNode.startPosition.column,
      });
    }
  }
}

function extractCallsFromBody(
  body: SyntaxNode,
  fromId: string,
  ctx: ExtractionContext,
): void {
  const calls = findDescendants(body, "call");
  for (const call of calls) {
    const fn = call.childForFieldName("function");
    if (!fn) continue;

    let callName: string;
    if (fn.type === "identifier") {
      callName = fn.text;
    } else if (fn.type === "attribute") {
      callName = fn.text;
    } else {
      continue;
    }

    if (BUILTINS.has(callName)) continue;

    ctx.unresolvedRefs.push({
      fromNodeId: fromId,
      referenceName: callName,
      referenceKind: "calls",
      filePath: ctx.filePath,
      language: "python",
      line: call.startPosition.row + 1,
      column: call.startPosition.column,
    });
  }
}

function extractTypeName(node: SyntaxNode): string | undefined {
  if (node.type === "type") {
    const child = namedChildren(node)[0];
    if (child) return extractTypeName(child);
  }
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") return node.text;
  if (node.type === "subscript") {
    const value = node.childForFieldName("value");
    return value?.text;
  }
  return undefined;
}

function extractNode(node: SyntaxNode, ctx: ExtractionContext): void {
  switch (node.type) {
    case "class_definition":
      extractClass(node, ctx);
      break;
    case "function_definition":
      extractFunction(node, ctx);
      break;
    case "decorated_definition": {
      const inner = namedChildren(node).find(
        (c) =>
          c.type === "class_definition" || c.type === "function_definition",
      );
      if (inner) extractNode(inner, ctx);
      break;
    }
    case "import_statement":
    case "import_from_statement":
      extractImport(node, ctx);
      break;
    case "expression_statement":
      extractVariable(node, ctx);
      break;
  }
}

function extractBlock(block: SyntaxNode, ctx: ExtractionContext): void {
  for (const child of namedChildren(block)) {
    extractNode(child, ctx);
  }
}

// ─── Extractor implementation ──────────────────────────────────────────────────

const pythonExtractor: LanguageExtractor = {
  language: "python",
  extensions: ["py", "pyi"],

  extract(source: string, filePath: string, tree: Tree): ExtractionResult {
    const start = performance.now();

    const fileQName = filePath;
    const fileId = makeId(filePath, fileQName);

    const fileNode: SymbolNode = {
      id: fileId,
      kind: "file",
      name: filePath.split("/").pop() ?? filePath,
      qualifiedName: fileQName,
      filePath,
      language: "python",
      startLine: 1,
      endLine: tree.rootNode.endPosition.row + 1,
      startColumn: 0,
      endColumn: 0,
      contentHash: createHash("sha256").update(source).digest("hex").slice(0, 12),
      updatedAt: Date.now(),
    };

    const ctx: ExtractionContext = {
      filePath,
      source,
      nodes: [fileNode],
      edges: [],
      unresolvedRefs: [],
      scopeStack: [fileQName],
    };

    for (const child of namedChildren(tree.rootNode)) {
      extractNode(child, ctx);
    }

    return {
      nodes: ctx.nodes,
      edges: ctx.edges,
      unresolvedReferences: ctx.unresolvedRefs,
      errors: [],
      durationMs: performance.now() - start,
    };
  },
};

registerExtractor(pythonExtractor);

export { pythonExtractor };
