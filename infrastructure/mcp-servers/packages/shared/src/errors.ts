/**
 * Error classes for zeos MCP servers
 */

/**
 * Base error for all zeos MCP errors
 */
export class ZeOSError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'ZeOSError';
  }
}

/**
 * Sync conflict error - occurs when local and remote have diverged
 */
export class SyncConflictError extends ZeOSError {
  constructor(
    public path: string,
    public localSha: string,
    public remoteSha: string
  ) {
    super(`Sync conflict on ${path}: local=${localSha}, remote=${remoteSha}`, 'SYNC_CONFLICT');
    this.name = 'SyncConflictError';
  }
}

/**
 * Offline error - operation requires network but none available
 */
export class OfflineError extends ZeOSError {
  constructor(operation: string) {
    super(`Cannot perform ${operation} while offline`, 'OFFLINE');
    this.name = 'OfflineError';
  }
}

/**
 * Resource not found error
 */
export class ResourceNotFoundError extends ZeOSError {
  constructor(uri: string) {
    super(`Resource not found: ${uri}`, 'NOT_FOUND');
    this.name = 'ResourceNotFoundError';
  }
}

/**
 * Invalid URI error
 */
export class InvalidURIError extends ZeOSError {
  constructor(uri: string) {
    super(`Invalid zeos URI: ${uri}`, 'INVALID_URI');
    this.name = 'InvalidURIError';
  }
}

/**
 * Configuration error
 */
export class ConfigurationError extends ZeOSError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigurationError';
  }
}

/**
 * Boot failure error
 */
export class BootError extends ZeOSError {
  constructor(message: string, public missingComponent?: string) {
    super(message, 'BOOT_FAILED');
    this.name = 'BootError';
  }
}

/**
 * Session error - invalid session state
 */
export class SessionError extends ZeOSError {
  constructor(message: string) {
    super(message, 'SESSION_ERROR');
    this.name = 'SessionError';
  }
}

/**
 * Database error - SQLite operation failed
 */
export class DatabaseError extends ZeOSError {
  constructor(message: string, public operation?: string) {
    super(message, 'DATABASE_ERROR');
    this.name = 'DatabaseError';
  }
}

/**
 * Git operation error
 */
export class GitError extends ZeOSError {
  constructor(message: string, public command?: string) {
    super(message, 'GIT_ERROR');
    this.name = 'GitError';
  }
}

/**
 * Validation error - input/schema validation failed
 */
export class ValidationError extends ZeOSError {
  constructor(message: string, public field?: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

/**
 * Wrap an unknown error into a ZeOSError
 */
export function wrapError(error: unknown, context?: string): ZeOSError {
  if (error instanceof ZeOSError) {
    return error;
  }

  if (error instanceof Error) {
    const message = context ? `${context}: ${error.message}` : error.message;
    return new ZeOSError(message, 'UNKNOWN_ERROR');
  }

  const message = context ? `${context}: ${String(error)}` : String(error);
  return new ZeOSError(message, 'UNKNOWN_ERROR');
}

/**
 * Error response format for MCP
 */
export interface McpErrorResponse {
  code: number;
  message: string;
  data?: {
    type: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Convert a ZeOSError to MCP error response format
 */
export function toMcpError(error: ZeOSError): McpErrorResponse {
  // MCP uses JSON-RPC error codes
  const codeMap: Record<string, number> = {
    NOT_FOUND: -32001,
    INVALID_URI: -32602,
    CONFIG_ERROR: -32002,
    BOOT_FAILED: -32003,
    SESSION_ERROR: -32004,
    DATABASE_ERROR: -32005,
    GIT_ERROR: -32006,
    SYNC_CONFLICT: -32007,
    OFFLINE: -32008,
    VALIDATION_ERROR: -32602,
    UNKNOWN_ERROR: -32000
  };

  return {
    code: codeMap[error.code] || -32000,
    message: error.message,
    data: {
      type: error.name,
      details: {
        code: error.code
      }
    }
  };
}
