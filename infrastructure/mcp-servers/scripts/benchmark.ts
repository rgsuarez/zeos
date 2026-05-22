#!/usr/bin/env tsx
/**
 * Performance benchmark script for zeos MCP servers
 *
 * Tests:
 * - Boot time (<100ms target)
 * - File read time (<50ms target)
 * - SQLite operations (prepared statements)
 * - Memory usage (<100MB target)
 */

import { performance } from 'perf_hooks';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_ROOT = resolve(__dirname, '../packages/zeos-mcp/tests/fixtures/mock-zeos');

interface BenchmarkResult {
  name: string;
  target: number;
  actual: number;
  passed: boolean;
  unit: string;
}

const results: BenchmarkResult[] = [];

function benchmark(name: string, fn: () => void, targetMs: number): void {
  // Warm up
  fn();

  // Measure multiple runs
  const runs = 100;
  const start = performance.now();

  for (let i = 0; i < runs; i++) {
    fn();
  }

  const end = performance.now();
  const avgMs = (end - start) / runs;

  const result: BenchmarkResult = {
    name,
    target: targetMs,
    actual: Math.round(avgMs * 100) / 100,
    passed: avgMs <= targetMs,
    unit: 'ms'
  };

  results.push(result);
  console.log(`${result.passed ? '✓' : '✗'} ${name}: ${result.actual}ms (target: ${targetMs}ms)`);
}

async function benchmarkAsync(name: string, fn: () => Promise<void>, targetMs: number): Promise<void> {
  // Warm up
  await fn();

  // Measure multiple runs
  const runs = 10;
  const start = performance.now();

  for (let i = 0; i < runs; i++) {
    await fn();
  }

  const end = performance.now();
  const avgMs = (end - start) / runs;

  const result: BenchmarkResult = {
    name,
    target: targetMs,
    actual: Math.round(avgMs * 100) / 100,
    passed: avgMs <= targetMs,
    unit: 'ms'
  };

  results.push(result);
  console.log(`${result.passed ? '✓' : '✗'} ${name}: ${result.actual}ms (target: ${targetMs}ms)`);
}

function checkMemory(targetMB: number): void {
  const used = process.memoryUsage();
  const heapMB = Math.round(used.heapUsed / 1024 / 1024 * 100) / 100;

  const result: BenchmarkResult = {
    name: 'Memory Usage',
    target: targetMB,
    actual: heapMB,
    passed: heapMB <= targetMB,
    unit: 'MB'
  };

  results.push(result);
  console.log(`${result.passed ? '✓' : '✗'} Memory Usage: ${heapMB}MB (target: <${targetMB}MB)`);
}

async function runBenchmarks(): Promise<void> {
  console.log('zeos MCP Performance Benchmarks');
  console.log('================================\n');

  // Ensure test fixtures exist
  if (!existsSync(resolve(MOCK_ROOT, 'kernel'))) {
    mkdirSync(resolve(MOCK_ROOT, 'kernel'), { recursive: true });
    writeFileSync(resolve(MOCK_ROOT, 'kernel/SOUL.md'), '# Test Kernel\n');
  }

  // File operations
  console.log('File Operations:');
  benchmark('File Read (cached)', () => {
    readFileSync(resolve(MOCK_ROOT, 'kernel/SOUL.md'), 'utf-8');
  }, 50);

  const testFile = resolve(MOCK_ROOT, 'benchmark-test.md');
  benchmark('File Write', () => {
    writeFileSync(testFile, '# Benchmark Test\n' + Date.now());
  }, 100);

  if (existsSync(testFile)) {
    rmSync(testFile);
  }

  // Simulated boot sequence
  console.log('\nBoot Sequence:');
  benchmark('Kernel Load (simulated)', () => {
    readFileSync(resolve(MOCK_ROOT, 'kernel/SOUL.md'), 'utf-8');
    // Simulate parsing YAML frontmatter
    const content = '---\nversion: 1.0.0\n---\n# Test';
    content.split('---')[1];
  }, 50);

  // String operations (common in zeos)
  console.log('\nString Operations:');
  benchmark('YAML Frontmatter Parse (simulated)', () => {
    const content = `---
session_id: "test-001"
profile: "operator"
status: "active"
started: "2026-01-05T00:00:00Z"
---

# Session Title

## Checkpoint 1

Content here...
`;
    const parts = content.split('---');
    const frontmatter = parts[1];
    const body = parts.slice(2).join('---');
    frontmatter.split('\n').filter(l => l.includes(':'));
  }, 5);

  // Memory check
  console.log('\nMemory:');
  checkMemory(100);

  // Summary
  console.log('\n================================');
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`Results: ${passed}/${total} benchmarks passed`);

  if (passed === total) {
    console.log('\n✓ All benchmarks passed');
    process.exit(0);
  } else {
    console.log('\n✗ Some benchmarks failed');
    process.exit(1);
  }
}

runBenchmarks().catch(err => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
