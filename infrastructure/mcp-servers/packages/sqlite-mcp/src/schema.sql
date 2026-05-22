-- zeos MCP SQLite Schema
-- Version: 1.0.0
-- Purpose: Local state management and sync queue for offline operation

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT
);

-- Sync queue for offline operations
-- Queues file changes for async GitHub sync
CREATE TABLE IF NOT EXISTS sync_queue (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
    path TEXT NOT NULL,
    content TEXT,
    sha TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    priority INTEGER NOT NULL DEFAULT 0
);

-- Index for queue processing
CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_sync_queue_path ON sync_queue(path);

-- File cache for tracking local vs remote state
CREATE TABLE IF NOT EXISTS file_cache (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    last_modified TEXT NOT NULL,
    synced_at TEXT,
    remote_sha TEXT,
    is_dirty INTEGER NOT NULL DEFAULT 0
);

-- Index for dirty file detection
CREATE INDEX IF NOT EXISTS idx_file_cache_dirty ON file_cache(is_dirty) WHERE is_dirty = 1;

-- Session state key-value store
CREATE TABLE IF NOT EXISTS session_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Active sessions tracking
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    profile TEXT NOT NULL,
    project TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_checkpoint TEXT,
    checkpoint_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'abandoned'))
);

-- Index for active session lookup
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, started_at DESC);

-- Checkpoint history
CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    commit_sha TEXT,
    note TEXT,
    files_changed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    synced INTEGER NOT NULL DEFAULT 0
);

-- Index for checkpoint lookup
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at DESC);
