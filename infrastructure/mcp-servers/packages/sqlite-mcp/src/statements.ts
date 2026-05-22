import Database from 'better-sqlite3';

export function getPreparedStatements(db: Database.Database) {
  return {
    // Sync queue
    insertQueue: db.prepare(`
      INSERT INTO sync_queue (id, operation, path, content, sha, status, priority)
      VALUES (@id, @operation, @path, @content, @sha, @status, @priority)
    `),
    getQueue: db.prepare(`
      SELECT * FROM sync_queue WHERE status = @status ORDER BY priority DESC, created_at ASC
    `),
    updateQueueStatus: db.prepare(`
      UPDATE sync_queue SET status = @status, updated_at = datetime('now'), attempts = attempts + 1, last_error = @error
      WHERE id = @id
    `),
    deleteQueue: db.prepare(`DELETE FROM sync_queue WHERE id = @id`),
    clearQueue: db.prepare(`DELETE FROM sync_queue WHERE status = @status`),
    countQueue: db.prepare(`SELECT COUNT(*) as count FROM sync_queue WHERE status = @status`),

    // Session state
    getState: db.prepare(`SELECT value FROM session_state WHERE key = @key`),
    setState: db.prepare(`
      INSERT OR REPLACE INTO session_state (key, value, updated_at)
      VALUES (@key, @value, datetime('now'))
    `),
    deleteState: db.prepare(`DELETE FROM session_state WHERE key = @key`),
    getAllState: db.prepare(`SELECT key, value FROM session_state`),

    // Sessions
    getActiveSession: db.prepare(`
      SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 1
    `),
    createSession: db.prepare(`
      INSERT INTO sessions (session_id, profile, project, status)
      VALUES (@session_id, @profile, @project, 'active')
    `),
    endSession: db.prepare(`
      UPDATE sessions SET status = @status, last_checkpoint = datetime('now')
      WHERE session_id = @session_id
    `),

    // Checkpoints
    addCheckpoint: db.prepare(`
      INSERT INTO checkpoints (id, session_id, commit_sha, note, files_changed)
      VALUES (@id, @session_id, @commit_sha, @note, @files_changed)
    `),
    getCheckpoints: db.prepare(`
      SELECT * FROM checkpoints WHERE session_id = @session_id ORDER BY created_at DESC
    `),
    updateSessionCheckpoint: db.prepare(`
      UPDATE sessions SET last_checkpoint = datetime('now'), checkpoint_count = checkpoint_count + 1
      WHERE session_id = @session_id
    `),
  };
}

export type PreparedStatements = ReturnType<typeof getPreparedStatements>;
