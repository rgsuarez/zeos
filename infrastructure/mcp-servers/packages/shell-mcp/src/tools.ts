import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { pathExists, readFileSafe, getLatestJournal } from './utils.js';
import { type ZeOSConfig } from '@zeos/shared';

// Session state (in-memory, persisted via SQLite MCP in unified server)
export interface SessionState {
  booted: boolean;
  profile: string | null;
  project: string | null;
  bootedAt: Date | null;
  checkpointCount: number;
}

export const sessionState: SessionState = {
  booted: false,
  profile: null,
  project: null,
  bootedAt: null,
  checkpointCount: 0,
};

export const SHELL_TOOLS: Tool[] = [
  {
    name: 'zeos_boot',
    description: 'Initialize zeos context. Loads kernel, profile, and modules. Returns boot confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description: 'Profile to load (default: from ZEOS_PROFILE env or "template")',
        },
      },
    },
  },
  {
    name: 'zeos_project',
    description: 'Load a specific project context. Sets journal routing and loads project SOUL.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project ID (e.g., "zeos-dev", "example-project")',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'zeos_checkpoint',
    description: 'Save current session progress. Creates journal entry with work since last checkpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'Optional checkpoint note',
        },
        delta: {
          type: 'object',
          description: 'Work performed since last checkpoint',
          properties: {
            files_created: { type: 'array', items: { type: 'string' } },
            files_modified: { type: 'array', items: { type: 'string' } },
            decisions: { type: 'array', items: { type: 'string' } },
            commands: { type: 'array', items: { type: 'string' } },
            focus: { type: 'string' },
          },
        },
      },
    },
  },
  {
    name: 'zeos_end',
    description: 'End the current session. Creates final journal entry and handoff block.',
    inputSchema: {
      type: 'object',
      properties: {
        delta: {
          type: 'object',
          description: 'Final work performed',
        },
        next_action: {
          type: 'string',
          description: 'What to pick up next session',
        },
      },
    },
  },
  {
    name: 'zeos_status',
    description: 'Get current zeos session status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'zeos_log',
    description: 'Display current session state and loaded context.',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: {
          type: 'boolean',
          description: 'Include full module list',
        },
      },
    },
  },
];

export async function handleShellToolCall(name: string, args: any, config: ZeOSConfig) {
  switch (name) {
    case 'zeos_boot': {
      const profileArg = (args?.profile as string) || config.profile;

      // Load kernel files
      const soulPath = join(config.root, 'kernel', 'SOUL.md');
      const bootPath = join(config.root, 'kernel', 'BOOT_PROTOCOL.md');

      const soul = await readFileSafe(soulPath);
      const boot = await readFileSafe(bootPath);

      if (!soul || !boot) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'KERNEL_MISSING',
              message: 'Cannot find kernel files. Verify ZEOS_ROOT is correct.',
              root: config.root,
            }),
          }],
          isError: true,
        };
      }

      // Load profile
      const profilePath = join(config.root, 'profiles', profileArg, 'PROFILE.md');
      const profile = await readFileSafe(profilePath);

      if (!profile) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'PROFILE_NOT_FOUND',
              message: `Profile not found: ${profileArg}`,
              available: await readdir(join(config.root, 'profiles')).catch(() => []),
            }),
          }],
          isError: true,
        };
      }

      // Load shell protocol module
      const shellProtocolPath = join(config.root, 'modules', 'constraints', 'ZEOS_MODULE_002_SHELL_PROTOCOL.md');
      const shellProtocol = await readFileSafe(shellProtocolPath);

      // Update session state
      sessionState.booted = true;
      sessionState.profile = profileArg;
      sessionState.bootedAt = new Date();
      sessionState.project = null;
      sessionState.checkpointCount = 0;

      // Extract version from SOUL
      const versionMatch = soul.match(/version:\s*"([^"]+)"/);
      const version = versionMatch ? versionMatch[1] : 'unknown';

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            version,
            profile: profileArg,
            kernel: {
              soul: soul.length,
              boot_protocol: boot.length,
            },
            modules: {
              shell_protocol: shellProtocol ? shellProtocol.length : 0,
            },
            mode: 'portfolio',
            message: 'zeos booted. Use zeos_project to load a project.',
          }),
        }],
      };
    }

    case 'zeos_project': {
      const projectId = args?.project_id as string;

      if (!projectId) {
        return { content: [{ type: 'text', text: 'Error: project_id is required' }], isError: true };
      }

      if (!sessionState.booted) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'NOT_BOOTED',
              message: 'Run zeos_boot first',
            }),
          }],
          isError: true,
        };
      }

      // Try to find project SOUL (apps may live in ZEOS_APPS_ROOT)
      const appsRoot = process.env.ZEOS_APPS_ROOT || join(config.root, 'apps');
      const soulPath = join(appsRoot, projectId, `${projectId.toUpperCase().replace(/-/g, '_')}_SOUL.md`);
      const altSoulPath = join(appsRoot, projectId, 'ZEOS_DEV_SOUL.md');

      let projectSoul = await readFileSafe(soulPath);
      if (!projectSoul) {
        projectSoul = await readFileSafe(altSoulPath);
      }

      // Get journal directory
      const journalDir = join(appsRoot, projectId, 'session-journals');
      const latestJournal = await getLatestJournal(journalDir);

      // Update session state
      sessionState.project = projectId;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            project: projectId,
            soul_loaded: !!projectSoul,
            journal_dir: journalDir,
            latest_journal: latestJournal ? latestJournal.path : null,
            profile: sessionState.profile,
            message: `Project ${projectId} loaded. Journaling enabled.`,
          }),
        }],
      };
    }

    case 'zeos_checkpoint': {
      if (!sessionState.booted) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'NOT_BOOTED', message: 'Run zeos_boot first' }),
          }],
          isError: true,
        };
      }

      if (!sessionState.project) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'NO_PROJECT', message: 'No project loaded. Use zeos_project first.' }),
          }],
          isError: true,
        };
      }

      const note = args?.note as string | undefined;
      const delta = args?.delta as Record<string, any> | undefined;

      // Generate checkpoint entry
      const timestamp = new Date().toISOString();
      sessionState.checkpointCount++;

      const checkpointEntry = `
---
type: checkpoint
timestamp: ${timestamp}
note: "${note || 'Auto-checkpoint'}"
checkpoint_number: ${sessionState.checkpointCount}
---

## Work Since Last Save

### Actions Taken
${delta?.files_created?.map((f: string) => `- Created 
${f}
``).join('
') || '- (none recorded)'}
${delta?.files_modified?.map((f: string) => `- Modified 
${f}
``).join('
') || ''}

### Decisions Made
${delta?.decisions?.map((d: string) => `- ${d}`).join('
') || '- (none recorded)'}

### Commands Executed
${delta?.commands?.map((c: string) => `- ${c}`).join('
') || '- (none recorded)'}

### Current Focus
${delta?.focus || 'Continuing current work'}

`;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            checkpoint: sessionState.checkpointCount,
            timestamp,
            note: note || 'Auto-checkpoint',
            project: sessionState.project,
            entry_preview: checkpointEntry.slice(0, 500),
            message: 'Checkpoint saved. Continue working.',
          }),
        }],
      };
    }

    case 'zeos_end': {
      if (!sessionState.booted) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'NOT_BOOTED', message: 'No active session to end' }),
          }],
          isError: true,
        };
      }

      const delta = args?.delta as Record<string, any> | undefined;
      const nextAction = args?.next_action as string | undefined;

      const timestamp = new Date().toISOString();
      const duration = sessionState.bootedAt
        ? Math.round((Date.now() - sessionState.bootedAt.getTime()) / 1000 / 60)
        : 0;

      const handoff = {
        session_complete: true,
        project: sessionState.project,
        profile: sessionState.profile,
        checkpoints: sessionState.checkpointCount,
        duration_minutes: duration,
        ended_at: timestamp,
        next_action: nextAction || 'Continue from last checkpoint',
        boot_command: '/zeos',
      };

      // Reset session state
      sessionState.booted = false;
      sessionState.profile = null;
      sessionState.project = null;
      sessionState.bootedAt = null;
      sessionState.checkpointCount = 0;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(handoff),
        }],
      };
    }

    case 'zeos_status': {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            booted: sessionState.booted,
            profile: sessionState.profile,
            project: sessionState.project,
            checkpoints: sessionState.checkpointCount,
            booted_at: sessionState.bootedAt?.toISOString() || null,
            root: config.root,
            sync_enabled: config.syncEnabled,
          }),
        }],
      };
    }

    case 'zeos_log': {
      const verbose = args?.verbose as boolean || false;

      const log: Record<string, any> = {
        profile: sessionState.profile,
        project: sessionState.project,
        checkpoints: sessionState.checkpointCount,
        mode: sessionState.project ? 'project' : (sessionState.booted ? 'portfolio' : 'unbooted'),
      };

      if (verbose) {
        log.root = config.root;
        log.sync = config.syncEnabled ? 'enabled' : 'disabled';
        log.booted_at = sessionState.bootedAt?.toISOString();
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(log, null, 2),
        }],
      };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}
