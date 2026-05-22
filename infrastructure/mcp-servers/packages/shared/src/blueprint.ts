/**
 * Blueprint types for zeos tactical planning
 *
 * These types align with the official Blueprint Spec v2:
 * https://github.com/my-org/my-repo/blob/main/docs/BLUEPRINT_SPEC.md
 *
 * @packageDocumentation
 */

/**
 * Blueprint lifecycle status
 */
export type BlueprintStatus = 'draft' | 'active' | 'complete' | 'archived';

/**
 * Task execution status
 */
export type TaskStatus =
  | 'not_started'
  | 'in_progress'
  | 'complete'
  | 'blocked'
  | 'skipped'
  | 'checkpointed';

/**
 * Blueprint document metadata (frontmatter)
 */
export interface BlueprintMetadata {
  /** Unique identifier for the blueprint */
  blueprint_id?: string;
  /** Current lifecycle status */
  status: BlueprintStatus;
  /** Creation date (ISO 8601) */
  created: string;
  /** Last update date (ISO 8601) */
  updated: string;
  /** Author (agent or human) */
  author?: string;
  /** Estimated number of sessions to complete */
  estimated_sessions?: number;
  /** Completion timestamp (ISO 8601) - set when status = complete */
  completed_at?: string;
  /** Archive timestamp (ISO 8601) - set when status = archived */
  archived_at?: string;
}

/**
 * Input/output interface definition
 */
export interface TaskInterface {
  /** Description of input requirements */
  input: string;
  /** Input type: file_path, value, or none */
  input_type: 'file_path' | 'value' | 'none';
  /** Description of output produced */
  output: string;
  /** Output type: file_path, value, or none */
  output_type: 'file_path' | 'value' | 'none';
}

/**
 * Input binding from a previous task
 */
export interface InputBinding {
  /** Source task ID */
  source: string;
  /** Output port name from source task */
  output_port: string;
  /** Transfer method: file, value, or stream */
  transfer: 'file' | 'value' | 'stream';
  /** Whether this binding is required */
  required: boolean;
}

/**
 * Output port definition
 */
export interface OutputPort {
  /** Port type */
  type: 'file_path' | 'value' | 'stream';
  /** Optional description */
  description?: string;
}

/**
 * Task output configuration
 */
export interface TaskOutput {
  /** Where the output is stored: file, memory, or stream */
  location: 'file' | 'memory' | 'stream';
  /** Path for file outputs */
  path?: string;
  /** Output format */
  format?: 'text' | 'json' | 'yaml' | 'binary';
  /** Named output ports for downstream binding */
  ports?: Record<string, OutputPort>;
}

/**
 * Verification command definition
 */
export interface VerificationCommand {
  /** Shell command to run */
  command: string;
  /** Timeout in ISO 8601 duration format (e.g., PT5S, PT2M) */
  timeout: string;
  /** Expected exit code (default: 0) */
  expected_exit_code?: number;
}

/**
 * Verification configuration
 */
export interface TaskVerification {
  /** Quick smoke test - should always be present */
  smoke: VerificationCommand;
  /** Unit/integration tests */
  unit?: VerificationCommand;
  /** End-to-end tests */
  e2e?: VerificationCommand;
}

/**
 * Execution context for a task
 */
export interface ExecutionContext {
  /** Working directory for command execution */
  working_directory?: string;
  /** Environment variables to set */
  environment_variables?: Record<string, string>;
  /** Execution timeout in ISO 8601 duration format */
  timeout?: string;
  /** Setup command to run before main task */
  setup_command?: string;
  /** Cleanup command to run after task (success or failure) */
  cleanup_command?: string;
}

/**
 * Task block - the atomic unit of work in a blueprint
 */
export interface TaskBlock {
  /** Unique task identifier (e.g., T0.1, T1.2) */
  task_id: string;
  /** Human-readable task name */
  name: string;
  /** Current execution status */
  status: TaskStatus;
  /** Assigned agent or human */
  assignee?: string | null;
  /** Estimated sessions to complete */
  estimated_sessions?: number;
  /** Task IDs that must complete before this task */
  dependencies?: string[];
  /** Input bindings from previous tasks */
  input_bindings?: Record<string, InputBinding>;
  /** Input/output interface contract */
  interface: TaskInterface;
  /** Output configuration */
  output?: TaskOutput;
  /** Required capabilities (e.g., node>=18, docker) */
  required_capabilities?: string[];
  /** Execution context settings */
  execution_context?: ExecutionContext;
  /** Files this task will create */
  files_to_create?: string[];
  /** Files this task will modify */
  files_to_modify?: string[];
  /** Acceptance criteria (all must be met) */
  acceptance_criteria: string[];
  /** Verification tests */
  verification: TaskVerification;
  /** Rollback command on failure */
  rollback?: string;
  /** Additional notes for the executing agent */
  notes?: string;
}

/**
 * Execution configuration for the blueprint
 */
export interface ExecutionConfig {
  /** Shell to use for commands */
  shell: string;
  /** Shell flags */
  shell_flags?: string[];
  /** Maximum parallel tasks */
  max_parallel_tasks?: number;
  /** Resource locks (prevent concurrent access) */
  resource_locks?: string[];
  /** Preflight checks before any task */
  preflight_checks?: {
    command: string;
    expected_exit_code: number;
    error_message: string;
  }[];
  /** Secret resolution policy */
  secret_resolution?: {
    on_missing: 'abort' | 'skip' | 'prompt';
    sources: {
      type: 'env' | 'file' | 'vault';
      prefix?: string;
      path?: string;
    }[];
  };
}

/**
 * Success metric definition
 */
export interface SuccessMetric {
  /** Metric name */
  metric: string;
  /** Target value or threshold */
  target: string;
  /** How to validate the metric */
  validation: string;
}

/**
 * Complete Blueprint document
 */
export interface BlueprintDocument {
  /** Document metadata */
  metadata: BlueprintMetadata;
  /** Strategic vision (why this work matters) */
  strategic_vision: string;
  /** Measurable success criteria */
  success_metrics: SuccessMetric[];
  /** Execution configuration */
  execution: ExecutionConfig;
  /** Organized task blocks by tier */
  tiers: Record<string, TaskBlock[]>;
  /** Dependency graph in YAML format */
  dependency_graph?: Record<string, {
    depends_on: string[];
    input_bindings?: Record<string, string>;
  }>;
}

/**
 * Blueprint progress summary
 */
export interface BlueprintProgress {
  /** Blueprint filename */
  filename: string;
  /** Current status */
  status: BlueprintStatus;
  /** Total number of tasks */
  total_tasks: number;
  /** Number of completed tasks */
  completed_tasks: number;
  /** Number of blocked tasks */
  blocked_tasks: number;
  /** Next actionable task ID */
  next_task_id?: string;
  /** Next actionable task name */
  next_task_name?: string;
  /** Progress by tier */
  tier_progress: Record<string, {
    completed: number;
    total: number;
  }>;
}

/**
 * Calculate blueprint progress from document
 */
export function calculateProgress(doc: BlueprintDocument): BlueprintProgress {
  const allTasks = Object.values(doc.tiers).flat();
  const completed = allTasks.filter(t => t.status === 'complete').length;
  const blocked = allTasks.filter(t => t.status === 'blocked').length;

  // Find next actionable task
  const completedIds = new Set(
    allTasks.filter(t => t.status === 'complete').map(t => t.task_id)
  );

  const nextTask = allTasks.find(t =>
    t.status === 'not_started' &&
    (t.dependencies || []).every(d => completedIds.has(d))
  );

  // Calculate per-tier progress
  const tierProgress: Record<string, { completed: number; total: number }> = {};
  for (const [tier, tasks] of Object.entries(doc.tiers)) {
    tierProgress[tier] = {
      completed: tasks.filter(t => t.status === 'complete').length,
      total: tasks.length
    };
  }

  const result: BlueprintProgress = {
    filename: doc.metadata.blueprint_id || 'unknown',
    status: doc.metadata.status,
    total_tasks: allTasks.length,
    completed_tasks: completed,
    blocked_tasks: blocked,
    tier_progress: tierProgress
  };

  if (nextTask) {
    result.next_task_id = nextTask.task_id;
    result.next_task_name = nextTask.name;
  }

  return result;
}
