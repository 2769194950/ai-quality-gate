// Typed error carrying the structured error contract of §6.5 forever.
export class QgateError extends Error {
  constructor(code, message, { jsonPointer = null, details = [], exitCode = 2, cause = null } = {}) {
    super(message);
    this.name = 'QgateError';
    this.code = code;
    this.jsonPointer = jsonPointer;
    this.details = details;
    this.exitCode = exitCode;
    if (cause) this.cause = cause;
  }

  /** Structured error object as printed on stdout with --json (§6.5). */
  toJSON() {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        jsonPointer: this.jsonPointer,
        details: this.details,
      },
    };
  }
}

export function configError(message, options = {}) {
  return new QgateError('CONFIG_INVALID', message, { exitCode: 2, ...options });
}

export function notFoundError(message, options = {}) {
  return new QgateError('CONFIG_NOT_FOUND', message, { exitCode: 2, ...options });
}

export function providerError(message, options = {}) {
  return new QgateError('PROVIDER_FAILED', message, { exitCode: 3, ...options });
}

export function internalError(message, options = {}) {
  return new QgateError('INTERNAL_ERROR', message, { exitCode: 3, ...options });
}

export function evidenceError(message, options = {}) {
  return new QgateError('EVIDENCE_UNRESOLVED', message, { exitCode: 3, ...options });
}

export function driftError(message, options = {}) {
  return new QgateError('CONTRACT_DRIFT', message, { exitCode: 3, ...options });
}

export function ioError(message, options = {}) {
  return new QgateError('IO_ERROR', message, { exitCode: 3, ...options });
}
