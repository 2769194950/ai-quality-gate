// Environment boundary for the explicitly trusted live OCR runner.
// This file is intentionally separate from the offline runner: live jobs get
// only the provider variables they need, while qgate itself never sees them.

const BASE_ENV = Object.freeze([
  'PATH', 'Path', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP',
  // The CLI resolves its config directory through the process home. These
  // are directory hints, not credentials, and are required on both runners.
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
]);

const PROVIDER_ENV = Object.freeze([
  // OpenCodeReview's documented process-level CI contract.
  'OCR_LLM_URL',
  'OCR_LLM_TOKEN',
  'OCR_LLM_MODEL',
  'OCR_USE_ANTHROPIC',
]);

export const LIVE_ENV_ALLOWLIST = Object.freeze([...BASE_ENV, ...PROVIDER_ENV]);

export function buildLiveChildEnv(baseEnv = process.env) {
  const env = {};
  for (const key of LIVE_ENV_ALLOWLIST) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  env.OCR_PROVIDER = 'opencodereview';
  env.OCR_OFFLINE = '0';
  env.OCR_NO_API_KEY = '0';
  env.NO_COLOR = '1';
  return env;
}

export function validateLiveCredentials(env = process.env) {
  const baseUrl = String(env.OCR_LLM_URL ?? '').trim();
  const token = String(env.OCR_LLM_TOKEN ?? '').trim();
  const model = String(env.OCR_LLM_MODEL ?? '').trim();
  const useAnthropic = String(env.OCR_USE_ANTHROPIC ?? '').trim().toLowerCase();
  let endpoint;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new Error('OCR_LLM_URL must be a valid https URL');
  }
  if (endpoint.protocol !== 'https:') throw new Error('OCR_LLM_URL must use https');
  if (!token) throw new Error('OCR_LLM_TOKEN is required for live OCR');
  if (!model) throw new Error('OCR_LLM_MODEL is required for live OCR');
  if (!['true', '1', 'yes', 'false', '0', 'no'].includes(useAnthropic)) {
    throw new Error('OCR_USE_ANTHROPIC must be true or false for live OCR');
  }
  const expectedPath = ['true', '1', 'yes'].includes(useAnthropic) ? '/messages' : '/chat/completions';
  const actualPath = endpoint.pathname.replace(/\/+$/, '').toLowerCase();
  if (!actualPath.endsWith(expectedPath)) {
    throw new Error(`OCR_LLM_URL must point to an ${expectedPath.slice(1)} endpoint for the selected protocol`);
  }
  return { baseUrl, model };
}
