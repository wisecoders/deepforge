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
  EdgeKind,
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

function getDocstring(node: SyntaxNode, source: string): string | undefined {
  let prev = node.previousNamedSibling;
  // If node is inside an export_statement, check the export's previous sibling
  if (!prev && node.parent?.type === "export_statement") {
    prev = node.parent.previousNamedSibling;
  }
  // Also check the export_statement's previous sibling even when the node has
  // a non-comment previous sibling (the export itself may have the docstring)
  if (prev?.type !== "comment" && node.parent?.type === "export_statement") {
    prev = node.parent.previousNamedSibling;
  }
  if (prev?.type === "comment") {
    const text = prev.text;
    if (text.startsWith("/**") || text.startsWith("//")) {
      return text
        .replace(/^\/\*\*?\s*/, "")
        .replace(/\s*\*\/$/, "")
        .replace(/^\s*\*\s?/gm, "")
        .trim();
    }
  }
  return undefined;
}

function getVisibility(
  node: SyntaxNode,
): "public" | "private" | "protected" | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === "accessibility_modifier") {
      const text = child.text as "public" | "private" | "protected";
      return text;
    }
  }
  return undefined;
}

function hasModifier(node: SyntaxNode, modifier: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === modifier || child.text === modifier) return true;
  }
  return false;
}

function getDecorators(node: SyntaxNode): string[] | undefined {
  const decorators: string[] = [];
  let sibling = node.previousNamedSibling;
  while (sibling?.type === "decorator") {
    decorators.push(sibling.text);
    sibling = sibling.previousNamedSibling;
  }
  return decorators.length > 0 ? decorators.reverse() : undefined;
}

function getSignature(node: SyntaxNode, source: string): string | undefined {
  const body =
    node.childForFieldName("body") ??
    node.children.find((c): c is SyntaxNode => c?.type === "statement_block");
  if (body) {
    return source.slice(node.startIndex, body.startIndex).trim();
  }
  const end = node.endIndex;
  const text = source.slice(node.startIndex, end);
  const firstLine = text.split("\n")[0];
  return firstLine.length < 200 ? firstLine : undefined;
}

function isExported(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (parent?.type === "export_statement") return true;
  if (hasModifier(node, "export")) return true;
  return false;
}

interface ExtractionContext {
  filePath: string;
  source: string;
  nodes: SymbolNode[];
  edges: Edge[];
  unresolvedRefs: UnresolvedReference[];
  scopeStack: string[];
  language: "typescript" | "javascript" | "tsx" | "jsx";
}

function qualifiedName(ctx: ExtractionContext, name: string): string {
  if (ctx.scopeStack.length === 0) {
    return `${ctx.filePath}::${name}`;
  }
  const scope = ctx.scopeStack[ctx.scopeStack.length - 1];
  return `${scope}.${name}`;
}

function contentHash(source: string, start: number, end: number): string {
  return createHash("sha256").update(source.slice(start, end)).digest("hex").slice(0, 12);
}

function extractClass(node: SyntaxNode, ctx: ExtractionContext): void {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return;

  const name = nameNode.text;
  const qName = qualifiedName(ctx, name);
  const id = makeId(ctx.filePath, qName);
  const exported = isExported(node);

  const symbolNode: SymbolNode = {
    id,
    kind: "class",
    name,
    qualifiedName: qName,
    filePath: ctx.filePath,
    language: ctx.language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: getSignature(node, ctx.source),
    docstring: getDocstring(node, ctx.source),
    visibility: getVisibility(node),
    isExported: exported || undefined,
    isAbstract: hasModifier(node, "abstract") || undefined,
    decorators: getDecorators(node),
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

  // extends / implements — inside class_heritage node
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const targets =
      child.type === "class_heritage"
        ? namedChildren(child)
        : [child];
    for (const clause of targets) {
      if (clause.type === "extends_clause") {
        const typeNode = namedChildren(clause)[0];
        if (typeNode) {
          ctx.unresolvedRefs.push({
            fromNodeId: id,
            referenceName: extractTypeName(typeNode) ?? typeNode.text,
            referenceKind: "extends",
            filePath: ctx.filePath,
            language: ctx.language,
            line: typeNode.startPosition.row + 1,
            column: typeNode.startPosition.column,
          });
        }
      }
      if (clause.type === "implements_clause") {
        for (const typeChild of namedChildren(clause)) {
          ctx.unresolvedRefs.push({
            fromNodeId: id,
            referenceName: extractTypeName(typeChild) ?? typeChild.text,
            referenceKind: "implements",
            filePath: ctx.filePath,
            language: ctx.language,
            line: typeChild.startPosition.row + 1,
            column: typeChild.startPosition.column,
          });
        }
      }
    }
  }

  ctx.scopeStack.push(qName);
  const body = node.childForFieldName("body");
  if (body) {
    extractChildren(body, ctx);
  }
  ctx.scopeStack.pop();
}

function extractInterface(node: SyntaxNode, ctx: ExtractionContext): void {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return;

  const name = nameNode.text;
  const qName = qualifiedName(ctx, name);
  const id = makeId(ctx.filePath, qName);

  const symbolNode: SymbolNode = {
    id,
    kind: "interface",
    name,
    qualifiedName: qName,
    filePath: ctx.filePath,
    language: ctx.language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: getSignature(node, ctx.source),
    docstring: getDocstring(node, ctx.source),
    isExported: isExported(node) || undefined,
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

  // extends clause for interfaces
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "extends_type_clause" || child?.type === "extends_clause") {
      for (const typeChild of namedChildren(child)) {
        ctx.unresolvedRefs.push({
          fromNodeId: id,
          referenceName: typeChild.text,
          referenceKind: "extends",
          filePath: ctx.filePath,
          language: ctx.language,
          line: typeChild.startPosition.row + 1,
          column: typeChild.startPosition.column,
        });
      }
    }
  }

  ctx.scopeStack.push(qName);
  const body = node.childForFieldName("body");
  if (body) {
    extractChildren(body, ctx);
  }
  ctx.scopeStack.pop();
}

function extractFunction(
  node: SyntaxNode,
  ctx: ExtractionContext,
  kind: NodeKind = "function",
): void {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return;

  const name = nameNode.text;
  const qName = qualifiedName(ctx, name);
  const id = makeId(ctx.filePath, qName);

  const symbolNode: SymbolNode = {
    id,
    kind,
    name,
    qualifiedName: qName,
    filePath: ctx.filePath,
    language: ctx.language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: getSignature(node, ctx.source),
    docstring: getDocstring(node, ctx.source),
    visibility: getVisibility(node),
    isExported: isExported(node) || undefined,
    isAsync: hasModifier(node, "async") || undefined,
    isStatic: hasModifier(node, "static") || undefined,
    isAbstract: hasModifier(node, "abstract") || undefined,
    decorators: getDecorators(node),
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

  // Extract return type as unresolved reference
  const returnType = node.childForFieldName("return_type");
  if (returnType) {
    const typeText = extractTypeName(returnType);
    if (typeText && !isPrimitive(typeText)) {
      ctx.unresolvedRefs.push({
        fromNodeId: id,
        referenceName: typeText,
        referenceKind: "returns",
        filePath: ctx.filePath,
        language: ctx.language,
        line: returnType.startPosition.row + 1,
        column: returnType.startPosition.column,
      });
    }
  }

  // Extract function calls within the body
  ctx.scopeStack.push(qName);
  const body = node.childForFieldName("body");
  if (body) {
    extractCallsFromBody(body, id, ctx);
  }
  ctx.scopeStack.pop();
}

function extractMethod(node: SyntaxNode, ctx: ExtractionContext): void {
  extractFunction(node, ctx, "method");
}

function extractProperty(node: SyntaxNode, ctx: ExtractionContext): void {
  const nameNode =
    node.childForFieldName("name") ?? namedChildren(node)[0];
  if (!nameNode) return;

  const name = nameNode.text;
  const qName = qualifiedName(ctx, name);
  const id = makeId(ctx.filePath, qName);

  const kind: NodeKind = ctx.scopeStack.length > 0 ? "property" : "variable";

  const symbolNode: SymbolNode = {
    id,
    kind,
    name,
    qualifiedName: qName,
    filePath: ctx.filePath,
    language: ctx.language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    visibility: getVisibility(node),
    isStatic: hasModifier(node, "static") || undefined,
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

  // Type annotation as unresolved reference
  const typeAnn = node.childForFieldName("type");
  if (typeAnn) {
    const typeText = extractTypeName(typeAnn);
    if (typeText && !isPrimitive(typeText)) {
      ctx.unresolvedRefs.push({
        fromNodeId: id,
        referenceName: typeText,
        referenceKind: "type_of",
        filePath: ctx.filePath,
        language: ctx.language,
        line: typeAnn.startPosition.row + 1,
        column: typeAnn.startPosition.column,
      });
    }
  }
}

function extractEnum(node: SyntaxNode, ctx: ExtractionContext): void {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return;

  const name = nameNode.text;
  const qName = qualifiedName(ctx, name);
  const id = makeId(ctx.filePath, qName);

  const symbolNode: SymbolNode = {
    id,
    kind: "enum",
    name,
    qualifiedName: qName,
    filePath: ctx.filePath,
    language: ctx.language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    docstring: getDocstring(node, ctx.source),
    isExported: isExported(node) || undefined,
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

  // Extract enum members
  const body = node.childForFieldName("body");
  if (body) {
    for (const child of namedChildren(body)) {
      if (child.type === "enum_assignment" || child.type === "property_identifier") {
        const memberName = child.childForFieldName("name")?.text ?? child.text;
        const memberQName = `${qName}.${memberName}`;
        const memberId = makeId(ctx.filePath, memberQName);
        ctx.nodes.push({
          id: memberId,
          kind: "enum_member",
          name: memberName,
          qualifiedName: memberQName,
          filePath: ctx.filePath,
          language: ctx.language,
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          startColumn: child.startPosition.column,
          endColumn: child.endPosition.column,
          contentHash: contentHash(ctx.source, child.startIndex, child.endIndex),
          updatedAt: Date.now(),
        });
        ctx.edges.push({
          source: id,
          target: memberId,
          kind: "contains",
          line: child.startPosition.row + 1,
          provenance: "tree-sitter",
        });
      }
    }
  }
}

function extractTypeAlias(node: SyntaxNode, ctx: ExtractionContext): void {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return;

  const name = nameNode.text;
  const qName = qualifiedName(ctx, name);
  const id = makeId(ctx.filePath, qName);

  const symbolNode: SymbolNode = {
    id,
    kind: "type_alias",
    name,
    qualifiedName: qName,
    filePath: ctx.filePath,
    language: ctx.language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    signature: ctx.source.slice(node.startIndex, node.endIndex).split("\n")[0],
    docstring: getDocstring(node, ctx.source),
    isExported: isExported(node) || undefined,
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
}

function extractVariableDeclaration(
  node: SyntaxNode,
  ctx: ExtractionContext,
): void {
  // Only extract top-level or module-level variable declarations
  if (ctx.scopeStack.length > 1) return;

  for (const declarator of namedChildren(node)) {
    if (declarator.type !== "variable_declarator") continue;

    const nameNode = declarator.childForFieldName("name");
    if (!nameNode) continue;
    // Only extract simple identifiers (not destructured)
    if (nameNode.type !== "identifier") continue;

    const name = nameNode.text;
    const qName = qualifiedName(ctx, name);
    const id = makeId(ctx.filePath, qName);

    // Determine if this is a constant (const keyword)
    const isConst = node.children.some((c) => c?.text === "const");

    const value = declarator.childForFieldName("value");
    // If the value is an arrow function or function expression, extract as function
    if (
      value &&
      (value.type === "arrow_function" || value.type === "function_expression" || value.type === "function")
    ) {
      const symbolNode: SymbolNode = {
        id,
        kind: "function",
        name,
        qualifiedName: qName,
        filePath: ctx.filePath,
        language: ctx.language,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
        signature: getSignature(value, ctx.source),
        docstring: getDocstring(node, ctx.source),
        isExported: isExported(node) || undefined,
        isAsync:
          hasModifier(value, "async") || value.text.startsWith("async") || undefined,
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

      ctx.scopeStack.push(qName);
      const body = value.childForFieldName("body");
      if (body) {
        extractCallsFromBody(body, id, ctx);
      }
      ctx.scopeStack.pop();
      continue;
    }

    const symbolNode: SymbolNode = {
      id,
      kind: isConst ? "constant" : "variable",
      name,
      qualifiedName: qName,
      filePath: ctx.filePath,
      language: ctx.language,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      docstring: getDocstring(node, ctx.source),
      isExported: isExported(node) || undefined,
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
    const typeAnn = declarator.childForFieldName("type");
    if (typeAnn) {
      const typeText = extractTypeName(typeAnn);
      if (typeText && !isPrimitive(typeText)) {
        ctx.unresolvedRefs.push({
          fromNodeId: id,
          referenceName: typeText,
          referenceKind: "type_of",
          filePath: ctx.filePath,
          language: ctx.language,
          line: typeAnn.startPosition.row + 1,
          column: typeAnn.startPosition.column,
        });
      }
    }
  }
}

function extractImport(node: SyntaxNode, ctx: ExtractionContext): void {
  const sourceNode = node.childForFieldName("source");
  if (!sourceNode) return;

  const modulePath = sourceNode.text.replace(/['"]/g, "");
  const qName = `${ctx.filePath}::import(${modulePath})`;
  const id = makeId(ctx.filePath, qName);

  const symbolNode: SymbolNode = {
    id,
    kind: "import",
    name: modulePath,
    qualifiedName: qName,
    filePath: ctx.filePath,
    language: ctx.language,
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

  // Each imported name is an unresolved reference
  const clause = node.children.find(
    (c): c is SyntaxNode =>
      c?.type === "import_clause" ||
      c?.type === "named_imports" ||
      c?.type === "import_specifier",
  );
  if (clause) {
    const namedImports = findDescendants(clause, "import_specifier");
    for (const spec of namedImports) {
      const importedName =
        spec.childForFieldName("name")?.text ?? spec.text;
      ctx.unresolvedRefs.push({
        fromNodeId: id,
        referenceName: importedName,
        referenceKind: "imports",
        filePath: ctx.filePath,
        language: ctx.language,
        line: spec.startPosition.row + 1,
        column: spec.startPosition.column,
        candidates: [modulePath],
      });
    }
  }
}

function extractExport(node: SyntaxNode, ctx: ExtractionContext): void {
  // export_statement wraps declarations — extract the inner declaration
  const declaration = node.childForFieldName("declaration") ?? namedChildren(node).find(
    (c) =>
      c.type === "class_declaration" ||
      c.type === "abstract_class_declaration" ||
      c.type === "function_declaration" ||
      c.type === "interface_declaration" ||
      c.type === "enum_declaration" ||
      c.type === "type_alias_declaration" ||
      c.type === "lexical_declaration" ||
      c.type === "variable_declaration",
  );
  if (declaration) {
    extractNode(declaration, ctx);
    return;
  }

  // Re-export: export { x } from './module'
  // or export default ...
  // Just record as-is for the resolution pass
}

function extractCallsFromBody(
  body: SyntaxNode,
  fromId: string,
  ctx: ExtractionContext,
): void {
  const calls = findDescendants(body, "call_expression");
  for (const call of calls) {
    const fn = call.childForFieldName("function");
    if (!fn) continue;

    let callName: string;
    if (fn.type === "member_expression") {
      callName = fn.text;
    } else if (fn.type === "identifier") {
      callName = fn.text;
    } else {
      continue;
    }

    if (isBuiltin(callName)) continue;

    ctx.unresolvedRefs.push({
      fromNodeId: fromId,
      referenceName: callName,
      referenceKind: "calls",
      filePath: ctx.filePath,
      language: ctx.language,
      line: call.startPosition.row + 1,
      column: call.startPosition.column,
    });
  }

  // new expressions → instantiates
  const news = findDescendants(body, "new_expression");
  for (const newExpr of news) {
    const constructor = newExpr.childForFieldName("constructor");
    if (!constructor) continue;
    const name = constructor.text;
    if (name && !isPrimitive(name)) {
      ctx.unresolvedRefs.push({
        fromNodeId: fromId,
        referenceName: name,
        referenceKind: "instantiates",
        filePath: ctx.filePath,
        language: ctx.language,
        line: newExpr.startPosition.row + 1,
        column: newExpr.startPosition.column,
      });
    }
  }
}

function extractNode(node: SyntaxNode, ctx: ExtractionContext): void {
  switch (node.type) {
    case "class_declaration":
    case "abstract_class_declaration":
      extractClass(node, ctx);
      break;
    case "interface_declaration":
      extractInterface(node, ctx);
      break;
    case "function_declaration":
    case "generator_function_declaration":
      extractFunction(node, ctx);
      break;
    case "method_definition":
      extractMethod(node, ctx);
      break;
    case "public_field_definition":
    case "property_signature":
    case "method_signature":
      extractProperty(node, ctx);
      break;
    case "enum_declaration":
      extractEnum(node, ctx);
      break;
    case "type_alias_declaration":
      extractTypeAlias(node, ctx);
      break;
    case "lexical_declaration":
    case "variable_declaration":
      extractVariableDeclaration(node, ctx);
      break;
    case "import_statement":
      extractImport(node, ctx);
      break;
    case "export_statement":
      extractExport(node, ctx);
      break;
  }
}

function extractChildren(node: SyntaxNode, ctx: ExtractionContext): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) extractNode(child, ctx);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function findDescendants(node: SyntaxNode, type: string): SyntaxNode[] {
  const results: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === type) {
      results.push(current);
    }
    for (let i = 0; i < current.childCount; i++) {
      const child = current.child(i);
      if (child) stack.push(child);
    }
  }
  return results;
}

function extractTypeName(node: SyntaxNode): string | undefined {
  if (node.type === "type_annotation") {
    const child = namedChildren(node)[0];
    if (child) return extractTypeName(child);
  }
  if (node.type === "type_identifier" || node.type === "identifier") {
    return node.text;
  }
  if (node.type === "generic_type") {
    const nameNode = node.childForFieldName("name") ?? namedChildren(node)[0];
    return nameNode?.text;
  }
  return undefined;
}

const PRIMITIVES = new Set([
  "string", "number", "boolean", "void", "null", "undefined",
  "any", "never", "unknown", "object", "symbol", "bigint",
  "String", "Number", "Boolean",
]);

function isPrimitive(name: string): boolean {
  return PRIMITIVES.has(name);
}

const BUILTINS = new Set([
  "console.log", "console.error", "console.warn", "console.info",
  "console.debug", "console.trace",
  "parseInt", "parseFloat", "isNaN", "isFinite",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "JSON.parse", "JSON.stringify",
  "Object.keys", "Object.values", "Object.entries", "Object.assign",
  "Array.isArray", "Array.from",
  "Promise.resolve", "Promise.reject", "Promise.all", "Promise.allSettled",
  "require",
]);

function isBuiltin(name: string): boolean {
  return BUILTINS.has(name);
}

// ─── Extractor implementation ──────────────────────────────────────────────────

const typescriptExtractor: LanguageExtractor = {
  language: "typescript",
  extensions: ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"],

  extract(source: string, filePath: string, tree: Tree): ExtractionResult {
    const start = performance.now();

    const lang = filePath.endsWith(".tsx")
      ? "tsx"
      : filePath.endsWith(".jsx")
        ? "jsx"
        : filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")
          ? "javascript"
          : "typescript";

    // Create file node
    const fileQName = filePath;
    const fileId = makeId(filePath, fileQName);

    const fileNode: SymbolNode = {
      id: fileId,
      kind: "file",
      name: filePath.split("/").pop() ?? filePath,
      qualifiedName: fileQName,
      filePath,
      language: lang,
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
      language: lang,
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

registerExtractor(typescriptExtractor);

export { typescriptExtractor };
