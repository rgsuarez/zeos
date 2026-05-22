import { join, extname } from 'node:path';
import { access } from 'node:fs/promises';
import { type ResourceURI, type ZeOSConfig, InvalidURIError } from '@zeos/shared';

/**
 * Get MIME type for file extension
 */
export function getMimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.ts': 'text/typescript',
    '.js': 'text/javascript',
    '.sql': 'text/x-sql',
    '.txt': 'text/plain',
  };
  return mimeTypes[ext] || 'text/plain';
}

/**
 * Map resource URI type to filesystem path
 */
export function uriToPath(uri: ResourceURI, config: ZeOSConfig): string {
  const { root, profile } = config;

  switch (uri.type) {
    case 'kernel':
      return join(root, 'kernel', uri.path);
    case 'profile':
      // Handle zeos://profile/{profile_id}/path or zeos://profile/path (uses active profile)
      const parts = uri.path.split('/');
      if (parts.length > 1 && !uri.path.startsWith('PROFILE')) {
        return join(root, 'profiles', parts[0], parts.slice(1).join('/'));
      }
      return join(root, 'profiles', profile, uri.path);
    case 'module':
      return join(root, 'modules', uri.path);
    case 'app': {
      const appsRoot = process.env.ZEOS_APPS_ROOT || join(root, 'apps');
      return join(appsRoot, uri.path);
    }
    case 'session': {
      // Session journals route to project repos
      const appsRootSession = process.env.ZEOS_APPS_ROOT || join(root, 'apps');
      const [appId, ...journalPath] = uri.path.split('/');
      return join(appsRootSession, appId, 'session-journals', journalPath.join('/'));
    }
    case 'state':
      return join(root, '.zeos', uri.path);
    default:
      throw new InvalidURIError(`zeos://${uri.type}/${uri.path}`);
  }
}

/**
 * Check if path exists
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
