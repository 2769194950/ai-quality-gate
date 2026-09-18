// Example `scripted` provider module (docs/01-architecture.md §5.1 provider table).
//
// A scripted provider is a local Node module that exports `run(context)` and
// returns an array of findings. The engine calls it only after the request has
// matched a recorded fingerprint in the provider fixture, so this module is
// replayed offline: no network access, no model call, no API key.
//
// The engine decides what a finding may do from its `severity` and `confidence`:
// only `severity in {high, blocker}` with `confidence >= confidenceThreshold` can
// become a blocker. Everything else is downgraded to a finding with a reason.

/**
 * @param {object} context normalised request plus the matched recording (`context.recorded`)
 * @returns {Array<{id: string, severity: string, confidence: number, file?: string, line?: number, message: string}>}
 */
export function run(context) {
  const recorded = context.recorded ?? null;
  if (recorded && Array.isArray(recorded.findings)) {
    return recorded.findings.map((finding) => ({ ...finding, source: 'scripted-recording' }));
  }
  // No recorded payload: replay a deterministic, low-confidence observation so the
  // caller still receives a well-formed finding array.
  return [
    {
      id: `scripted-${context.checkId ?? 'unknown'}`,
      severity: 'low',
      confidence: 0,
      source: 'scripted-module',
      message: `no recorded findings for ${context.checkId ?? 'this request'}`,
    },
  ];
}

export default run;
