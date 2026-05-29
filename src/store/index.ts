import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SymbolNode,
  Edge,
  FileRecord,
  UnresolvedReference,
  ExtractionResult,
  GraphStats,
  SearchResult,
  SearchOptions,
} from "../types.js";
import { StoreError } from "../errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, "../../src/store/schema.sql");
const SCHEMA_PATH_DIST = resolve(__dirname, "../store/schema.sql");

function loadSchema(): string {
  try {
    return readFileSync(SCHEMA_PATH, "utf-8");
  } catch {
    return readFileSync(SCHEMA_PATH_DIST, "utf-8");
  }
}

export class GraphStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath);
    } catch (err) {
      throw new StoreError(`Failed to open database: ${dbPath}`, { cause: err });
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(loadSchema());
  }

  close(): void {
    this.db.close();
  }

  // ─── Bulk ingestion ─────────────────────────────────────────────────────────

  ingestFile(file: FileRecord, result: ExtractionResult): void {
    const tx = this.db.transaction(() => {
      // Clear previous data for this file
      this.deleteFileData(file.path);

      // Insert file record
      this.insertFile(file, result);

      // Insert nodes
      for (const node of result.nodes) {
        this.insertNode(node);
      }

      // Insert edges (skip if target doesn't exist yet — cross-file)
      for (const edge of result.edges) {
        this.insertEdge(edge);
      }

      // Insert unresolved references
      for (const ref of result.unresolvedReferences) {
        this.insertUnresolvedRef(ref);
      }
    });
    tx();
  }

  // ─── Node operations ───────────────────────────────────────────────────────

  private _insertNode: Database.Statement | null = null;

  private insertNode(node: SymbolNode): void {
    if (!this._insertNode) {
      this._insertNode = this.db.prepare(`
        INSERT OR REPLACE INTO nodes
          (id, kind, name, qualified_name, file_path, language,
           start_line, end_line, start_column, end_column,
           signature, docstring, visibility,
           is_exported, is_async, is_static, is_abstract,
           decorators, content_hash, updated_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    }
    this._insertNode.run(
      node.id,
      node.kind,
      node.name,
      node.qualifiedName,
      node.filePath,
      node.language,
      node.startLine,
      node.endLine,
      node.startColumn,
      node.endColumn,
      node.signature ?? null,
      node.docstring ?? null,
      node.visibility ?? null,
      node.isExported ? 1 : 0,
      node.isAsync ? 1 : 0,
      node.isStatic ? 1 : 0,
      node.isAbstract ? 1 : 0,
      node.decorators ? JSON.stringify(node.decorators) : null,
      node.contentHash,
      node.updatedAt,
    );
  }

  getNode(id: string): SymbolNode | undefined {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE id = ?")
      .get(id) as NodeRow | undefined;
    return row ? rowToNode(row) : undefined;
  }

  getNodesByFile(filePath: string): SymbolNode[] {
    const rows = this.db
      .prepare("SELECT * FROM nodes WHERE file_path = ?")
      .all(filePath) as NodeRow[];
    return rows.map(rowToNode);
  }

  getNodesByKind(kind: string): SymbolNode[] {
    const rows = this.db
      .prepare("SELECT * FROM nodes WHERE kind = ?")
      .all(kind) as NodeRow[];
    return rows.map(rowToNode);
  }

  getNodeByQualifiedName(qualifiedName: string): SymbolNode | undefined {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE qualified_name = ?")
      .get(qualifiedName) as NodeRow | undefined;
    return row ? rowToNode(row) : undefined;
  }

  // ─── Edge operations ───────────────────────────────────────────────────────

  private _insertEdge: Database.Statement | null = null;

  private insertEdge(edge: Edge): void {
    if (!this._insertEdge) {
      this._insertEdge = this.db.prepare(`
        INSERT OR IGNORE INTO edges (source, target, kind, line, col, provenance)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
    }
    this._insertEdge.run(
      edge.source,
      edge.target,
      edge.kind,
      edge.line ?? null,
      edge.column ?? null,
      edge.provenance,
    );
  }

  getEdgesFrom(nodeId: string, kind?: string): Edge[] {
    if (kind) {
      return (
        this.db
          .prepare("SELECT * FROM edges WHERE source = ? AND kind = ?")
          .all(nodeId, kind) as EdgeRow[]
      ).map(rowToEdge);
    }
    return (
      this.db
        .prepare("SELECT * FROM edges WHERE source = ?")
        .all(nodeId) as EdgeRow[]
    ).map(rowToEdge);
  }

  getEdgesTo(nodeId: string, kind?: string): Edge[] {
    if (kind) {
      return (
        this.db
          .prepare("SELECT * FROM edges WHERE target = ? AND kind = ?")
          .all(nodeId, kind) as EdgeRow[]
      ).map(rowToEdge);
    }
    return (
      this.db
        .prepare("SELECT * FROM edges WHERE target = ?")
        .all(nodeId) as EdgeRow[]
    ).map(rowToEdge);
  }

  // ─── File operations ───────────────────────────────────────────────────────

  private insertFile(file: FileRecord, result: ExtractionResult): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO files
         (path, language, content_hash, size, modified_at, indexed_at, node_count, errors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        file.path,
        file.language,
        file.contentHash,
        file.size,
        file.modifiedAt,
        Date.now(),
        result.nodes.length,
        result.errors.length > 0 ? JSON.stringify(result.errors) : null,
      );
  }

  getFile(path: string): FileRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM files WHERE path = ?")
      .get(path) as FileRow | undefined;
    return row ? rowToFileRecord(row) : undefined;
  }

  getAllFiles(): FileRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM files")
      .all() as FileRow[];
    return rows.map(rowToFileRecord);
  }

  // ─── Unresolved references ────────────────────────────────────────────────

  private _insertRef: Database.Statement | null = null;

  private insertUnresolvedRef(ref: UnresolvedReference): void {
    if (!this._insertRef) {
      this._insertRef = this.db.prepare(`
        INSERT INTO unresolved_refs
          (from_node_id, reference_name, reference_kind, file_path, language, line, col, candidates)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
    }
    this._insertRef.run(
      ref.fromNodeId,
      ref.referenceName,
      ref.referenceKind,
      ref.filePath,
      ref.language,
      ref.line,
      ref.column,
      ref.candidates ? JSON.stringify(ref.candidates) : null,
    );
  }

  getUnresolvedRefs(filePath?: string): UnresolvedReference[] {
    const rows = filePath
      ? (this.db
          .prepare("SELECT * FROM unresolved_refs WHERE file_path = ?")
          .all(filePath) as RefRow[])
      : (this.db.prepare("SELECT * FROM unresolved_refs").all() as RefRow[]);
    return rows.map(rowToRef);
  }

  // ─── Delete ──────────────────────────────────────────────────────────────

  private deleteFileData(filePath: string): void {
    this.db
      .prepare("DELETE FROM unresolved_refs WHERE file_path = ?")
      .run(filePath);
    this.db
      .prepare("DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)")
      .run(filePath);
    this.db
      .prepare("DELETE FROM edges WHERE target IN (SELECT id FROM nodes WHERE file_path = ?)")
      .run(filePath);
    this.db.prepare("DELETE FROM nodes WHERE file_path = ?").run(filePath);
    this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
  }

  // ─── Search ──────────────────────────────────────────────────────────────

  searchNodes(query: string, options: SearchOptions = {}): SearchResult[] {
    const limit = options.limit ?? 20;
    const ftsQuery = query
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w}"*`)
      .join(" OR ");

    if (!ftsQuery) return [];

    const rows = this.db
      .prepare(
        `SELECT n.*, rank
         FROM nodes_fts
         JOIN nodes n ON n.rowid = nodes_fts.rowid
         WHERE nodes_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as (NodeRow & { rank: number })[];

    return rows.map((row) => ({
      node: rowToNode(row),
      score: -row.rank,
    }));
  }

  // ─── Statistics ──────────────────────────────────────────────────────────

  getStats(): GraphStats {
    const nodeCount = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM nodes").get() as { cnt: number }
    ).cnt;
    const edgeCount = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM edges").get() as { cnt: number }
    ).cnt;
    const fileCount = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM files").get() as { cnt: number }
    ).cnt;
    const unresolvedRefCount = (
      this.db
        .prepare("SELECT COUNT(*) as cnt FROM unresolved_refs")
        .get() as { cnt: number }
    ).cnt;

    const nodesByKind: Record<string, number> = {};
    for (const row of this.db
      .prepare("SELECT kind, COUNT(*) as cnt FROM nodes GROUP BY kind")
      .all() as { kind: string; cnt: number }[]) {
      nodesByKind[row.kind] = row.cnt;
    }

    const edgesByKind: Record<string, number> = {};
    for (const row of this.db
      .prepare("SELECT kind, COUNT(*) as cnt FROM edges GROUP BY kind")
      .all() as { kind: string; cnt: number }[]) {
      edgesByKind[row.kind] = row.cnt;
    }

    const filesByLanguage: Record<string, number> = {};
    for (const row of this.db
      .prepare("SELECT language, COUNT(*) as cnt FROM files GROUP BY language")
      .all() as { language: string; cnt: number }[]) {
      filesByLanguage[row.language] = row.cnt;
    }

    return {
      nodeCount,
      edgeCount,
      fileCount,
      nodesByKind,
      edgesByKind,
      filesByLanguage,
      unresolvedRefCount,
      dbSizeBytes: 0,
      lastUpdated: Date.now(),
    };
  }
}

// ─── Row type mapping ──────────────────────────────────────────────────────────

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  signature: string | null;
  docstring: string | null;
  visibility: string | null;
  is_exported: number;
  is_async: number;
  is_static: number;
  is_abstract: number;
  decorators: string | null;
  content_hash: string;
  updated_at: number;
}

interface EdgeRow {
  source: string;
  target: string;
  kind: string;
  line: number | null;
  col: number | null;
  provenance: string;
}

interface FileRow {
  path: string;
  language: string;
  content_hash: string;
  size: number;
  modified_at: number;
  indexed_at: number;
  node_count: number;
  errors: string | null;
}

interface RefRow {
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  file_path: string;
  language: string;
  line: number;
  col: number;
  candidates: string | null;
}

function rowToNode(row: NodeRow): SymbolNode {
  return {
    id: row.id,
    kind: row.kind as SymbolNode["kind"],
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    language: row.language as SymbolNode["language"],
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
    signature: row.signature ?? undefined,
    docstring: row.docstring ?? undefined,
    visibility: row.visibility as SymbolNode["visibility"],
    isExported: row.is_exported === 1 ? true : undefined,
    isAsync: row.is_async === 1 ? true : undefined,
    isStatic: row.is_static === 1 ? true : undefined,
    isAbstract: row.is_abstract === 1 ? true : undefined,
    decorators: row.decorators ? JSON.parse(row.decorators) : undefined,
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
  };
}

function rowToEdge(row: EdgeRow): Edge {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind as Edge["kind"],
    line: row.line ?? undefined,
    column: row.col ?? undefined,
    provenance: row.provenance as Edge["provenance"],
  };
}

function rowToFileRecord(row: FileRow): FileRecord {
  return {
    path: row.path,
    language: row.language as FileRecord["language"],
    contentHash: row.content_hash,
    size: row.size,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    nodeCount: row.node_count,
    errors: row.errors ? JSON.parse(row.errors) : undefined,
  };
}

function rowToRef(row: RefRow): UnresolvedReference {
  return {
    fromNodeId: row.from_node_id,
    referenceName: row.reference_name,
    referenceKind: row.reference_kind as UnresolvedReference["referenceKind"],
    filePath: row.file_path,
    language: row.language as UnresolvedReference["language"],
    line: row.line,
    column: row.col,
    candidates: row.candidates ? JSON.parse(row.candidates) : undefined,
  };
}
