/**
 * Structured logging for zeos MCP servers
 *
 * Outputs JSON to stderr (MCP requirement) with correlation IDs.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  correlationId?: string;
  component?: string;
  details?: Record<string, unknown>;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

let currentLevel: LogLevel = (process.env.ZEOS_LOG_LEVEL as LogLevel) || 'info';
let currentCorrelationId: string | undefined;

/**
 * Set the minimum log level
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Get the current log level
 */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * Set correlation ID for request tracing
 */
export function setCorrelationId(id: string): void {
  currentCorrelationId = id;
}

/**
 * Clear correlation ID
 */
export function clearCorrelationId(): void {
  currentCorrelationId = undefined;
}

/**
 * Generate a new correlation ID
 */
export function generateCorrelationId(): string {
  return `zeos-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a logger for a specific component
 */
export function createLogger(component: string) {
  const log = (level: LogLevel, message: string, details?: Record<string, unknown>): void => {
    if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      component
    };

    if (currentCorrelationId) {
      entry.correlationId = currentCorrelationId;
    }

    if (details) {
      // Sanitize details to remove potential secrets
      entry.details = sanitizeDetails(details);
    }

    // MCP requires logging to stderr
    process.stderr.write(JSON.stringify(entry) + '\n');
  };

  return {
    debug: (message: string, details?: Record<string, unknown>) => log('debug', message, details),
    info: (message: string, details?: Record<string, unknown>) => log('info', message, details),
    warn: (message: string, details?: Record<string, unknown>) => log('warn', message, details),
    error: (message: string, details?: Record<string, unknown>) => log('error', message, details)
  };
}

/**
 * Sanitize log details to remove sensitive information
 */
function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = [
    'password',
    'token',
    'secret',
    'key',
    'authorization',
    'credential',
    'pat',
    'api_key',
    'apikey'
  ];

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(details)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = sensitiveKeys.some(sk => lowerKey.includes(sk));

    if (isSensitive) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeDetails(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Log a request/response pair for MCP operations
 */
export function logMcpOperation(
  logger: ReturnType<typeof createLogger>,
  method: string,
  params: unknown,
  result: unknown,
  duration: number
): void {
  logger.info(`MCP ${method}`, {
    method,
    params: typeof params === 'object' ? params : { value: params },
    resultType: typeof result,
    durationMs: duration
  });
}

// Default logger instance
export const defaultLogger = createLogger('zeos-mcp');
