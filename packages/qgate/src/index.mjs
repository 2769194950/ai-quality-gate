// Package entry point: the public, importable surface of the engine.
export { loadConfig, validateConfig, inferRootFromConfig, defaultPolicy, defaultSelection } from './config.mjs';
export { runPipeline, stripRuntimeFields, runtimeFields } from './core.mjs';
export { executeCheck, checkIds } from './checks/index.mjs';
export { createProvider, classifyFindings, providerDescriptor, requestFingerprint } from './provider.mjs';
export { selectFiles, filterFile, assertNoSecretPathsSelected, SECRET_PATH_RULES, FILTER_ORDER } from './selection.mjs';
export { groupFiles, MAX_FILES_PER_GROUP, estimateTokens } from './grouping.mjs';
export { loadRuleChain, matchRule, BUILTIN_RULES, RULE_SOURCES } from './rules.mjs';
export { buildTraceMatrix, judgeTraceMatrix } from './trace.mjs';
export { loadLedgerIndex, appendLedger, updateLedgerIndex } from './ledger.mjs';
export { resolveEvidence, auditEvidence } from './evidence.mjs';
export { renderLedgerReport } from './report.mjs';
export {
  STAGE_EVIDENCE_SCHEMA_VERSION,
  STAGE_EVIDENCE_DIR,
  assertStage,
  buildStageManifest,
  normalizeOcrResult,
  makeOfflineEvidence,
  makeInvalidEvidence,
  writeStageEvidence,
} from './stage-review.mjs';
export { describeContract, stageOrder, checkTypes, humanGates, exitCodes as exitCodeMap } from './contract.mjs';
export { QgateError, errorCodes } from './errors.mjs';
