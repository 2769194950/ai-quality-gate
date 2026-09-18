// Provider facade module (docs/01-architecture.md §7 lists `src/providers/`).
// The implementation lives in one place — `src/provider.mjs` — and this module
// re-exports it so both the layout contract and single-source-of-truth hold.
export {
  createProvider,
  classifyFindings,
  providerDescriptor,
  normalizeRequest,
  requestFingerprint,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_FIXTURE_PATH,
  fixtureVersion,
} from '../provider.mjs';
