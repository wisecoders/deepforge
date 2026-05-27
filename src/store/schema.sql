-- Deepforge knowledge graph schema — Version 1
-- Adapted from CodeGraph's battle-tested SQLite schema.

-- ============================================================================
-- Project metadata
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO project_metadata (key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO project_metadata (key, value) VALUES ('created_at', CAST(strftime('%s', 'now') * 1000 AS TEXT));

-- ============================================================================
-- Symbol nodes
-- ============================================================================

CREATE TABLE IF NOT EXISTS nodes (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file_path      TEXT NOT NULL,
  language       TEXT NOT NULL,
  start_line     INTEGER NOT NULL,
  end_line       INTEGER NOT NULL,
  start_column   INTEGER NOT NULL DEFAULT 0,
  end_column     INTEGER NOT NULL DEFAULT 0,
  signature      TEXT,
  docstring      TEXT,
  visibility     TEXT,
  is_exported    INTEGER NOT NULL DEFAULT 0,
  is_async       INTEGER NOT NULL DEFAULT 0,
  is_static      INTEGER NOT NULL DEFAULT 0,
  is_abstract    INTEGER NOT NULL DEFAULT 0,
  decorators     TEXT,          -- JSON array of strings
  content_hash   TEXT NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_file      ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_kind      ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name      ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_lang      ON nodes(language);

-- ============================================================================
-- Edges (relationships between symbols)
-- ============================================================================

CREATE TABLE IF NOT EXISTS edges (
  source     TEXT NOT NULL,
  target     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  line       INTEGER,
  col        INTEGER,
  provenance TEXT NOT NULL DEFAULT 'tree-sitter',
  UNIQUE(source, target, kind),
  FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
);

-- Composite indexes cover single-column lookups too (source-only, target-only).
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);
CREATE INDEX IF NOT EXISTS idx_edges_kind        ON edges(kind);

-- ============================================================================
-- Tracked files
-- ============================================================================

CREATE TABLE IF NOT EXISTS files (
  path         TEXT PRIMARY KEY,
  language     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size         INTEGER NOT NULL,
  modified_at  INTEGER NOT NULL,
  indexed_at   INTEGER NOT NULL,
  node_count   INTEGER NOT NULL DEFAULT 0,
  errors       TEXT             -- JSON array of ExtractionError objects
);

CREATE INDEX IF NOT EXISTS idx_files_lang ON files(language);

-- ============================================================================
-- Unresolved references (pending cross-file resolution)
-- ============================================================================

CREATE TABLE IF NOT EXISTS unresolved_refs (
  from_node_id   TEXT NOT NULL,
  reference_name TEXT NOT NULL,
  reference_kind TEXT NOT NULL,
  file_path      TEXT NOT NULL,
  language       TEXT NOT NULL,
  line           INTEGER NOT NULL,
  col            INTEGER NOT NULL,
  candidates     TEXT,           -- JSON array of possible qualified names
  FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_unresolved_file ON unresolved_refs(file_path);
CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(reference_name);

-- ============================================================================
-- Full-text search on symbol names, qualified names, docstrings, signatures
-- ============================================================================

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name,
  qualified_name,
  docstring,
  signature,
  content='nodes',
  content_rowid='rowid'
);

-- Keep FTS index in sync with the nodes table.
CREATE TRIGGER IF NOT EXISTS nodes_fts_insert AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, qualified_name, docstring, signature)
  VALUES (NEW.rowid, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_delete AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified_name, docstring, signature)
  VALUES ('delete', OLD.rowid, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_update AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified_name, docstring, signature)
  VALUES ('delete', OLD.rowid, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
  INSERT INTO nodes_fts(rowid, name, qualified_name, docstring, signature)
  VALUES (NEW.rowid, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;
