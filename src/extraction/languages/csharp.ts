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

function nn(node: SyntaxNode): SyntaxNode[] {
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

function getModifiers(node: SyntaxNode): string[] {
  const mods: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "modifier") mods.push(child.text);
  }
  return mods;
}

function getVisibility(mods: string[]): SymbolNode["visibility"] | undefined {
  if (mods.includes("public")) return "public";
  if (mods.includes("private")) return "private";
  if (mods.includes("protected")) return "protected";
  if (mods.includes("internal")) return "internal";
  return undefined;
}

function getDocstring(node: SyntaxNode): string | undefined {
  const prev = node.previousNamedSibling;
  if (prev?.type === "comment") {
    return prev.text
      .replace(/^\/\/\/\s?/gm, "")
      .replace(/<[^>]+>/g, "")
      .trim();
  }
  return undefined;
}

function getAttributes(node: SyntaxNode): string[] | undefined {
  const attrs: string[] = [];
  let sibling = node.previousNamedSibling;
  while (sibling?.type === "attribute_list") {
    attrs.push(sibling.text);
    sibling = sibling.previousNamedSibling;
  }
  return attrs.length > 0 ? attrs.reverse() : undefined;
}

function getBaseList(node: SyntaxNode): SyntaxNode[] {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "base_list") return nn(child);
  }
  return [];
}

function getSignature(node: SyntaxNode, source: string): string | undefined {
  const body = node.childForFieldName("body") ??
    nn(node).find((c) => c.type === "block");
  if (body) return source.slice(node.startIndex, body.startIndex).trim();
  return source.slice(node.startIndex, node.endIndex).split("\n")[0]?.trim();
}

const PRIMITIVES = new Set([
  "void", "int", "long", "short", "byte", "float", "double", "decimal",
  "bool", "char", "string", "object", "dynamic", "var",
  "String", "Int32", "Int64", "Boolean", "Double", "Single", "Decimal",
  "Object", "Byte", "Char",
]);

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

function extractTypeName(node: SyntaxNode): string | undefined {
  if (node.type === "identifier" || node.type === "predefined_type")
    return node.text;
  if (node.type === "generic_name") {
    const nameNode = node.childForFieldName("name") ?? nn(node)[0];
    return nameNode?.text;
  }
  if (node.type === "qualified_name") return node.text;
  if (node.type === "nullable_type") {
    const inner = nn(node)[0];
    return inner ? extractTypeName(inner) : undefined;
  }
  return node.text;
}

interface Ctx {
  filePath: string;
  source: string;
  nodes: SymbolNode[];
  edges: Edge[];
  unresolvedRefs: UnresolvedReference[];
  scopeStack: string[];
}

function qName(ctx: Ctx, name: string): string {
  if (ctx.scopeStack.length === 0) return `${ctx.filePath}::${name}`;
  return `${ctx.scopeStack[ctx.scopeStack.length - 1]}.${name}`;
}

function addContains(ctx: Ctx, childId: string, line: number): void {
  if (ctx.scopeStack.length > 0) {
    const parentQN = ctx.scopeStack[ctx.scopeStack.length - 1];
    ctx.edges.push({
      source: makeId(ctx.filePath, parentQN),
      target: childId,
      kind: "contains",
      line,
      provenance: "tree-sitter",
    });
  }
}

function extractNamespace(node: SyntaxNode, ctx: Ctx): void {
  const nameNode = node.childForFieldName("name") ?? nn(node).find(
    (c) => c.type === "identifier" || c.type === "qualified_name",
  );
  if (!nameNode) return;

  const name = nameNode.text;
  const q = qName(ctx, name);
  const id = makeId(ctx.filePath, q);

  ctx.nodes.push({
    id,
    kind: "namespace",
    name,
    qualifiedName: q,
    filePath: ctx.filePath,
    language: "csharp",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    contentHash: contentHash(ctx.source, node.startIndex, node.endIndex),
    updatedAt: Date.now(),
  });
  addContains(ctx, id, node.startPosition.row + 1);

  ctx.scopeStack.push(q);
  const body = nn(node).find((c) => c.type === "declaration_list");
  if (body) extractChildren(body, ctx);
  ctx.scopeStack.pop();
}

function extractClass(node: SyntaxNode, ctx: Ctx): void {
  const nameNode = node.childForFieldName("name") ?? nn(node).find(
    (c) => c.type === "identifier",
  );
  if (!nameNode) return;

  const name = nameNode.text;
  const q = qName(ctx, name);
  const id = makeId(ctx.filePath, q);
  const mods = getModifiers(node);

  const kind: NodeKind = node.type === "struct_declaration" ? "struct" : "class";

  ctx.nodes.push({
    id,
    kind,
    name,
    qualifiedName: q,
    filePath: ctx.filePath,
    language: "csharp",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: getSignature(node, ctx.source),
    docstring: getDocstring(node),
    visibility: getVisibility(mods),
    isExported: mods.includes("public") || undefined,
    isStatic: mods.includes("static") || undefined,
    isAbstract: mods.includes("abstract") || undefined,
    decorators: getAttributes(node),
    contentHash: contentHash(ctx.source, node.startIndex, node.endIndex),
    updatedAt: Date.now(),
  });
  addContains(ctx, id, node.startPosition.row + 1);

  for (const base of getBaseList(node)) {
    const baseName = extractTypeName(base);
    if (baseName && !PRIMITIVES.has(baseName)) {
      const refKind = baseName.startsWith("I") && baseName.length > 1 && baseName[1] === baseName[1].toUpperCase()
        ? "implements" : "extends";
      ctx.unresolvedRefs.push({
        fromNodeId: id,
        referenceName: baseName,
        referenceKind: refKind,
        filePath: ctx.filePath,
        language: "csharp",
        line: base.startPosition.row + 1,
        column: base.startPosition.column,
      });
    }
  }

  ctx.scopeStack.push(q);
  const body = nn(node).find((c) => c.type === "declaration_list");
  if (body) extractChildren(body, ctx);
  ctx.scopeStack.pop();
}

function extractInterface(node: SyntaxNode, ctx: Ctx): void {
  const nameNode = node.childForFieldName("name") ?? nn(node).find(
    (c) => c.type === "identifier",
  );
  if (!nameNode) return;

  const name = nameNode.text;
  const q = qName(ctx, name);
  const id = makeId(ctx.filePath, q);
  const mods = getModifiers(node);

  ctx.nodes.push({
    id,
    kind: "interface",
    name,
    qualifiedName: q,
    filePath: ctx.filePath,
    language: "csharp",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: getSignature(node, ctx.source),
    docstring: getDocstring(node),
    visibility: getVisibility(mods),
    isExported: mods.includes("public") || undefined,
    decorators: getAttributes(node),
    contentHash: contentHash(ctx.source, node.startIndex, node.endIndex),
    updatedAt: Date.now(),
  });
  addContains(ctx, id, node.startPosition.row + 1);

  for (const base of getBaseList(node)) {
    const baseName = extractTypeName(base);
    if (baseName && !PRIMITIVES.has(baseName)) {
      ctx.unresolvedRefs.push({
        fromNodeId: id,
        referenceName: baseName,
        referenceKind: "extends",
        filePath: ctx.filePath,
        language: "csharp",
        line: base.startPosition.row + 1,
        column: base.startPosition.column,
      });
    }
  }

  ctx.scopeStack.push(q);
  const body = nn(node).find((c) => c.type === "declaration_list");
  if (body) extractChildren(body, ctx);
  ctx.scopeStack.pop();
}

function extractMethod(node: SyntaxNode, ctx: Ctx): void {
  const nameNode = node.childForFieldName("name") ?? nn(node).find(
    (c) => c.type === "identifier",
  );
  if (!nameNode) return;

  const name = nameNode.text;
  const q = qName(ctx, name);
  const id = makeId(ctx.filePath, q);
  const mods = getModifiers(node);

  const kind: NodeKind = ctx.scopeStack.length > 1 ? "method" : "function";

  ctx.nodes.push({
    id,
    kind,
    name,
    qualifiedName: q,
    filePath: ctx.filePath,
    language: "csharp",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: getSignature(node, ctx.source),
    docstring: getDocstring(node),
    visibility: getVisibility(mods),
    isAsync: mods.includes("async") || undefined,
    isStatic: mods.includes("static") || undefined,
    isAbstract: mods.includes("abstract") || undefined,
    decorators: getAttributes(node),
    contentHash: contentHash(ctx.source, node.startIndex, node.endIndex),
    updatedAt: Date.now(),
  });
  addContains(ctx, id, node.startPosition.row + 1);

  // Return type
  const retType = node.childForFieldName("type") ?? nn(node).find(
    (c) => c.type === "predefined_type" || c.type === "identifier" ||
           c.type === "generic_name" || c.type === "qualified_name",
  );
  if (retType) {
    const typeName = extractTypeName(retType);
    if (typeName && !PRIMITIVES.has(typeName)) {
      ctx.unresolvedRefs.push({
        fromNodeId: id,
        referenceName: typeName,
        referenceKind: "returns",
        filePath: ctx.filePath,
        language: "csharp",
        line: retType.startPosition.row + 1,
        column: retType.startPosition.column,
      });
    }
  }

  // Calls in body
  const body = node.childForFieldName("body") ?? nn(node).find((c) => c.type === "block");
  if (body) extractCallsFromBody(body, id, ctx);
}

function extractConstructor(node: SyntaxNode, ctx: Ctx): void {
  const nameNode = node.childForFieldName("name") ?? nn(node).find(
    (c) => c.type === "identifier",
  );
  if (!nameNode) return;

  const name = nameNode.text;
  const q = qName(ctx, name);
  const id = makeId(ctx.filePath, q);
  const mods = getModifiers(node);

  ctx.nodes.push({
    id,
    kind: "method",
    name,
    qualifiedName: q,
    filePath: ctx.filePath,
    language: "csharp",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: getSignature(node, ctx.source),
    visibility: getVisibility(mods),
    contentHash: contentHash(ctx.source, node.startIndex, node.endIndex),
    updatedAt: Date.now(),
  });
  addContains(ctx, id, node.startPosition.row + 1);

  const body = node.childForFieldName("body") ?? nn(node).find((c) => c.type === "block");
  if (body) extractCallsFromBody(body, id, ctx);
}

function extractProperty(node: SyntaxNode, ctx: Ctx): void {
  const nameNode = node.childForFieldName("name") ?? nn(node).find(
    (c) => c.type === "identifier",
  );
  if (!nameNode) return;

  const name = nameNode.text;
  const q = qName(ctx, name);
  const id = makeId(ctx.filePath, q);
  const mods = getModifiers(node);

  ctx.nodes.push({
    id,
    kind: "property",
    name,
    qualifiedName: q,
    filePath: ctx.filePath,
    language: "csharp",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    visibility: getVisibility(mods),
    isStatic: mods.includes("static") || undefined,
    contentHash: contentHash(ctx.source, node.startIndex, node.endIndex),
    updatedAt: Date.now(),
  });
  addContains(ctx, id, node.startPosition.row + 1);
}

function extractField(node: SyntaxNode, ctx: Ctx): void {
  const decl = nn(node).find((c) => c.type === "variable_declaration");
  if (!decl) return;

  const declarator = nn(decl).find((c) => c.type === "variable_declarator");
  if (!declarator) return;

  const nameNode = declarator.childForFieldName("name") ?? nn(declarator).find(
    (c) => c.type === "identifier",
  );
  if (!nameNode) return;

  const name = nameNode.text;
  const q = qName(ctx, name);
  const id = makeId(ctx.filePath, q);
  const mods = getModifiers(node);
  const isConst = mods.includes("const");

  ctx.nodes.push({
    id,
    kind: isConst ? "constant" : "field",
    name,
    qualifiedName: q,
    filePath: ctx.filePath,
    language: "csharp",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    visibility: getVisibility(mods),
    isStatic: mods.includes("static") || mods.includes("const") || undefined,
    contentHash: contentHash(ctx.source, node.startIndex, node.endIndex),
    updatedAt: Date.now(),
  });
  addContains(ctx, id, node.startPosition.row + 1);
}

function extractEnum(node: SyntaxNode, ctx: Ctx): void {
  const nameNode = node.childForFieldName("name") ?? nn(node).find(
    (c) => c.type === "identifier",
  );
  if (!nameNode) return;

  const name = nameNode.text;
  const q = qName(ctx, name);
  const id = makeId(ctx.filePath, q);
  const mods = getModifiers(node);

  ctx.nodes.push({
    id,
    kind: "enum",
    name,
    qualifiedName: q,
    filePath: ctx.filePath,
    language: "csharp",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    docstring: getDocstring(node),
    visibility: getVisibility(mods),
    isExported: mods.includes("public") || undefined,
    contentHash: contentHash(ctx.source, node.startIndex, node.endIndex),
    updatedAt: Date.now(),
  });
  addContains(ctx, id, node.startPosition.row + 1);

  const body = nn(node).find(
    (c) => c.type === "enum_member_declaration_list",
  );
  if (body) {
    for (const member of nn(body)) {
      if (member.type === "enum_member_declaration") {
        const memberName = member.childForFieldName("name")?.text ?? nn(member)[0]?.text;
        if (!memberName) continue;
        const mq = `${q}.${memberName}`;
        const mid = makeId(ctx.filePath, mq);
        ctx.nodes.push({
          id: mid,
          kind: "enum_member",
          name: memberName,
          qualifiedName: mq,
          filePath: ctx.filePath,
          language: "csharp",
          startLine: member.startPosition.row + 1,
          endLine: member.endPosition.row + 1,
          startColumn: member.startPosition.column,
          endColumn: member.endPosition.column,
          contentHash: contentHash(ctx.source, member.startIndex, member.endIndex),
          updatedAt: Date.now(),
        });
        ctx.edges.push({
          source: id,
          target: mid,
          kind: "contains",
          line: member.startPosition.row + 1,
          provenance: "tree-sitter",
        });
      }
    }
  }
}

function extractUsing(node: SyntaxNode, ctx: Ctx): void {
  const nameNode = nn(node).find(
    (c) => c.type === "identifier" || c.type === "qualified_name",
  );
  if (!nameNode) return;

  const name = nameNode.text;
  const q = `${ctx.filePath}::using(${name})`;
  const id = makeId(ctx.filePath, q);

  ctx.nodes.push({
    id,
    kind: "import",
    name,
    qualifiedName: q,
    filePath: ctx.filePath,
    language: "csharp",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    contentHash: contentHash(ctx.source, node.startIndex, node.endIndex),
    updatedAt: Date.now(),
  });
  addContains(ctx, id, node.startPosition.row + 1);
}

function extractCallsFromBody(body: SyntaxNode, fromId: string, ctx: Ctx): void {
  const calls = findDescendants(body, "invocation_expression");
  for (const call of calls) {
    const fn = nn(call)[0];
    if (!fn) continue;
    const callName = fn.type === "member_access_expression"
      ? fn.text
      : fn.type === "identifier"
        ? fn.text
        : null;
    if (!callName) continue;
    ctx.unresolvedRefs.push({
      fromNodeId: fromId,
      referenceName: callName,
      referenceKind: "calls",
      filePath: ctx.filePath,
      language: "csharp",
      line: call.startPosition.row + 1,
      column: call.startPosition.column,
    });
  }

  const news = findDescendants(body, "object_creation_expression");
  for (const newExpr of news) {
    const typeNode = nn(newExpr).find(
      (c) => c.type === "identifier" || c.type === "generic_name" || c.type === "qualified_name",
    );
    if (typeNode) {
      const name = extractTypeName(typeNode);
      if (name && !PRIMITIVES.has(name)) {
        ctx.unresolvedRefs.push({
          fromNodeId: fromId,
          referenceName: name,
          referenceKind: "instantiates",
          filePath: ctx.filePath,
          language: "csharp",
          line: newExpr.startPosition.row + 1,
          column: newExpr.startPosition.column,
        });
      }
    }
  }
}

function extractNode(node: SyntaxNode, ctx: Ctx): void {
  switch (node.type) {
    case "namespace_declaration":
    case "file_scoped_namespace_declaration":
      extractNamespace(node, ctx);
      break;
    case "class_declaration":
    case "struct_declaration":
    case "record_declaration":
      extractClass(node, ctx);
      break;
    case "interface_declaration":
      extractInterface(node, ctx);
      break;
    case "method_declaration":
      extractMethod(node, ctx);
      break;
    case "constructor_declaration":
      extractConstructor(node, ctx);
      break;
    case "property_declaration":
      extractProperty(node, ctx);
      break;
    case "field_declaration":
      extractField(node, ctx);
      break;
    case "enum_declaration":
      extractEnum(node, ctx);
      break;
    case "using_directive":
      extractUsing(node, ctx);
      break;
  }
}

function extractChildren(node: SyntaxNode, ctx: Ctx): void {
  for (const child of nn(node)) {
    extractNode(child, ctx);
  }
}

const csharpExtractor: LanguageExtractor = {
  language: "csharp",
  extensions: ["cs"],

  extract(source: string, filePath: string, tree: Tree): ExtractionResult {
    const start = performance.now();

    const fileId = makeId(filePath, filePath);
    const fileNode: SymbolNode = {
      id: fileId,
      kind: "file",
      name: filePath.split("/").pop() ?? filePath,
      qualifiedName: filePath,
      filePath,
      language: "csharp",
      startLine: 1,
      endLine: tree.rootNode.endPosition.row + 1,
      startColumn: 0,
      endColumn: 0,
      contentHash: createHash("sha256").update(source).digest("hex").slice(0, 12),
      updatedAt: Date.now(),
    };

    const ctx: Ctx = {
      filePath,
      source,
      nodes: [fileNode],
      edges: [],
      unresolvedRefs: [],
      scopeStack: [filePath],
    };

    extractChildren(tree.rootNode, ctx);

    return {
      nodes: ctx.nodes,
      edges: ctx.edges,
      unresolvedReferences: ctx.unresolvedRefs,
      errors: [],
      durationMs: performance.now() - start,
    };
  },
};

registerExtractor(csharpExtractor);

export { csharpExtractor };
