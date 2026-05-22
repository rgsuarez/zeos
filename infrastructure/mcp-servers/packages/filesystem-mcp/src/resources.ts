import { Resource } from '@modelcontextprotocol/sdk/types.js';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { parseResourceURI, type ZeOSConfig } from '@zeos/shared';
import { ResourceNotFoundError, InvalidURIError } from '@zeos/shared';
import { uriToPath, getMimeType } from './utils.js';

/**
 * Recursively list files in directory
 */
export async function listFilesRecursive(dir: string, base: string = ''): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = base ? `${base}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Skip hidden directories and node_modules
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const subFiles = await listFilesRecursive(join(dir, entry.name), relativePath);
          files.push(...subFiles);
        }
      } else if (entry.isFile()) {
        // Only include relevant file types
        const ext = extname(entry.name).toLowerCase();
        if (['.md', '.json', '.yaml', '.yml', '.ts', '.js', '.sql'].includes(ext)) {
          files.push(relativePath);
        }
      }
    }
  } catch (error) {
    // Directory doesn't exist or not accessible
  }

  return files;
}

export async function listFilesystemResources(config: ZeOSConfig): Promise<Resource[]> {
  const resources: Resource[] = [];

  // Kernel resources
  const kernelDir = join(config.root, 'kernel');
  const kernelFiles = await listFilesRecursive(kernelDir);
  for (const file of kernelFiles) {
    resources.push({
      uri: `zeos://kernel/${file}`,
      name: file,
      mimeType: getMimeType(file),
      description: `Kernel file: ${file}`,
    });
  }

  // Active profile resources
  const profileDir = join(config.root, 'profiles', config.profile);
  const profileFiles = await listFilesRecursive(profileDir);
  for (const file of profileFiles) {
    resources.push({
      uri: `zeos://profile/${file}`,
      name: `${config.profile}/${file}`,
      mimeType: getMimeType(file),
      description: `Profile file: ${file}`,
    });
  }

  // Module resources
  const modulesDir = join(config.root, 'modules');
  const moduleFiles = await listFilesRecursive(modulesDir);
  for (const file of moduleFiles) {
    resources.push({
      uri: `zeos://module/${file}`,
      name: file,
      mimeType: getMimeType(file),
      description: `Module: ${file}`,
    });
  }

  return resources;
}

export async function readFilesystemResource(uri: string, config: ZeOSConfig): Promise<{ uri: string; mimeType: string; text: string }> {
  const parsed = parseResourceURI(uri);
  if (!parsed) {
    throw new InvalidURIError(uri);
  }

  const filePath = uriToPath(parsed, config);

  try {
    const content = await readFile(filePath, 'utf-8');
    return {
      uri,
      mimeType: getMimeType(filePath),
      text: content,
    };
  } catch (error) {
    throw new ResourceNotFoundError(uri);
  }
}
