// Check registry: wires the seven per-type executor modules together
// (docs/01-architecture.md §5.1, REQ-003).
import { checkFileExists, type as tFileExists, description as dFileExists } from './file_exists.mjs';
import { checkFileNotExists, type as tFileNotExists, description as dFileNotExists } from './file_not_exists.mjs';
import { checkRegex, type as tRegex, description as dRegex } from './regex.mjs';
import { checkCommand, type as tCommand, description as dCommand } from './command.mjs';
import { checkJsonAssert, type as tJsonAssert, description as dJsonAssert } from './json_assert.mjs';
import { checkTraceMatrix, type as tTraceMatrix, description as dTraceMatrix } from './trace_matrix.mjs';
import { checkPolicy, type as tPolicy, description as dPolicy } from './policy.mjs';
import { internalError } from '../errors.mjs';

export const checkIds = Object.freeze([
  'file_exists',
  'file_not_exists',
  'regex',
  'command',
  'json_assert',
  'trace_matrix',
  'policy',
]);

export const executors = Object.freeze({
  file_exists: checkFileExists,
  file_not_exists: checkFileNotExists,
  regex: checkRegex,
  command: checkCommand,
  json_assert: checkJsonAssert,
  trace_matrix: checkTraceMatrix,
  policy: checkPolicy,
});

export const executorMeta = Object.freeze({
  file_exists: { type: tFileExists, description: dFileExists },
  file_not_exists: { type: tFileNotExists, description: dFileNotExists },
  regex: { type: tRegex, description: dRegex },
  command: { type: tCommand, description: dCommand },
  json_assert: { type: tJsonAssert, description: dJsonAssert },
  trace_matrix: { type: tTraceMatrix, description: dTraceMatrix },
  policy: { type: tPolicy, description: dPolicy },
});

/**
 * Execute one check. Returns `{ passed, evidence, message, detail }`.
 * An unregistered type is an internal error — never a silent pass.
 */
export function executeCheck(ctx, check) {
  const executor = executors[check.type];
  if (!executor) {
    throw internalError(`no executor registered for check.type "${check.type}"`, {
      details: [{ jsonPointer: '/type', expected: checkIds.join('|'), actual: String(check.type), message: 'unknown check type' }],
    });
  }
  const outcome = executor(ctx, check);
  return {
    passed: Boolean(outcome.passed),
    evidence: outcome.evidence,
    message: outcome.message ?? null,
    detail: outcome,
  };
}

export { normalizeRel, absOf, result } from './_shared.mjs';
