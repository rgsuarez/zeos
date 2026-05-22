#!/usr/bin/env node
/**
 * zeos MCP SQLite Migrator
 * 
 * Applies database migrations in order, tracking which have been applied.
 * Uses better-sqlite3 for synchronous operations.
 * 
 * Usage:
 *   pnpm tsx src/migrator.ts <database_path>
 *   pnpm tsx src/migrator.ts ~/.zeos/state.db
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Migration {
  version: number;
  filename: string;
  description: string;
  sql: string;
}

interface AppliedMigration {
  version: number;
  applied_at: string;
  description: string | null;
}

/**
 * Load all migrations from the migrations directory
 */
function loadMigrations(): Migration[] {
  const migrationsDir = join(__dirname, 'migrations');
  
  if (!existsSync(migrationsDir)) {
    console.error(`Migrations directory not found: ${migrationsDir}`);
    return [];
  }
  
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();
  
  return files.map(filename => {
    const match = filename.match(/^(\d+)_(.+)\.sql$/);
    if (!match) {
      throw new Error(`Invalid migration filename: ${filename}. Expected format: NNN_description.sql`);
    }
    
    const [, versionStr, description] = match;
    const version = parseInt(versionStr, 10);
    const sql = readFileSync(join(migrationsDir, filename), 'utf-8');
    
    return {
      version,
      filename,
      description: description.replace(/_/g, ' '),
      sql
    };
  });
}

/**
 * Get list of already applied migrations
 */
function getAppliedMigrations(db: Database.Database): AppliedMigration[] {
  // Check if schema_versions table exists
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name='schema_versions'
  `).get();
  
  if (!tableExists) {
    return [];
  }
  
  return db.prepare(`
    SELECT version, applied_at, description 
    FROM schema_versions 
    ORDER BY version
  `).all() as AppliedMigration[];
}

/**
 * Apply a single migration
 */
function applyMigration(db: Database.Database, migration: Migration): void {
  console.log(`Applying migration ${migration.version}: ${migration.description}`);
  
  db.exec(migration.sql);
  
  console.log(`  ✓ Migration ${migration.version} applied`);
}

/**
 * Run all pending migrations
 */
function runMigrations(dbPath: string): { applied: number; skipped: number } {
  console.log(`Opening database: ${dbPath}`);
  
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  
  try {
    const migrations = loadMigrations();
    const applied = getAppliedMigrations(db);
    const appliedVersions = new Set(applied.map(m => m.version));
    
    console.log(`Found ${migrations.length} migrations, ${applied.length} already applied`);
    
    let appliedCount = 0;
    let skippedCount = 0;
    
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        skippedCount++;
        continue;
      }
      
      // Run migration in a transaction
      db.transaction(() => {
        applyMigration(db, migration);
      })();
      
      appliedCount++;
    }
    
    console.log(`\nMigration complete: ${appliedCount} applied, ${skippedCount} skipped`);
    
    return { applied: appliedCount, skipped: skippedCount };
  } finally {
    db.close();
  }
}

/**
 * Verify database schema
 */
function verifySchema(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  
  try {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' 
      ORDER BY name
    `).all() as { name: string }[];
    
    const requiredTables = [
      'schema_versions',
      'sync_queue',
      'file_cache',
      'session_state',
      'sessions',
      'checkpoints'
    ];
    
    const tableNames = new Set(tables.map(t => t.name));
    const missing = requiredTables.filter(t => !tableNames.has(t));
    
    if (missing.length > 0) {
      console.error(`Missing tables: ${missing.join(', ')}`);
      return false;
    }
    
    console.log(`Schema verified: ${requiredTables.length} required tables present`);
    return true;
  } finally {
    db.close();
  }
}

// CLI entry point
if (process.argv[1] === __filename || process.argv[1]?.endsWith('migrator.ts')) {
  const dbPath = process.argv[2];
  
  if (!dbPath) {
    console.error('Usage: migrator.ts <database_path>');
    console.error('Example: migrator.ts ~/.zeos/state.db');
    process.exit(1);
  }
  
  try {
    const result = runMigrations(dbPath);
    
    if (result.applied > 0) {
      verifySchema(dbPath);
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { runMigrations, verifySchema, loadMigrations, getAppliedMigrations };
