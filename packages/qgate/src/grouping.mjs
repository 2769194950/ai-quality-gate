// Deterministic FileGroup construction (docs/01-architecture.md §4.1).
// Invariants: maxFilesPerGroup = 10 by default; a group whose estimated token
// cost exceeds the budget is downgraded to one-file buckets. No LLM grouping,
// therefore no fallback path is needed — the result is always complete.
import path from 'node:path';
import { fileSize } from './util/fsx.mjs';

export const MAX_FILES_PER_GROUP = 10;
export const DEFAULT_TOKEN_BUDGET_PER_GROUP = 12000;
export const DEFAULT_TOKENS_PER_FILE = 4;

/** Coarse, deterministic token estimate: ceil(bytes / tokensPerFile). */
export function estimateTokens(bytes, tokensPerFile = DEFAULT_TOKENS_PER_FILE) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / tokensPerFile);
}

export function normalizeGroupingOptions(options = {}) {
  return {
    maxFilesPerGroup: options.maxFilesPerGroup ?? MAX_FILES_PER_GROUP,
    tokenBudgetPerGroup: options.tokenBudgetPerGroup ?? DEFAULT_TOKEN_BUDGET_PER_GROUP,
    tokensPerFile: options.tokensPerFile ?? DEFAULT_TOKENS_PER_FILE,
  };
}

/**
 * Group selected files. Input order is irrelevant: files are sorted first, so
 * the same selection always yields byte-identical groups.
 * Returns `[{ id, files, downgraded, tokens }]` with ids `g1..gN`.
 */
export function groupFiles(root, files, options = {}) {
  const opts = normalizeGroupingOptions(options);
  const ordered = files.map((f) => String(f)).slice().sort();
  const buckets = [];
  for (let i = 0; i < ordered.length; i += opts.maxFilesPerGroup) {
    buckets.push(ordered.slice(i, i + opts.maxFilesPerGroup));
  }
  const groups = [];
  for (const bucket of buckets) {
    const sizes = bucket.map((rel) => {
      const abs = path.join(root, rel.split('/').join(path.sep));
      const size = fileSize(abs);
      return size < 0 ? 0 : size;
    });
    const tokens = bucket.reduce((sum, _rel, index) => sum + estimateTokens(sizes[index], opts.tokensPerFile), 0);
    if (tokens > opts.tokenBudgetPerGroup) {
      // Over budget => degrade to single-file groups (deterministic, no partial result).
      for (const rel of bucket) {
        const index = bucket.indexOf(rel);
        groups.push({ id: null, files: [rel], downgraded: true, tokens: estimateTokens(sizes[index], opts.tokensPerFile) });
      }
    } else {
      groups.push({ id: null, files: bucket, downgraded: false, tokens });
    }
  }
  return groups.map((group, index) => ({ ...group, id: `g${index + 1}` }));
}

export const groupingVersion = '1.0';
