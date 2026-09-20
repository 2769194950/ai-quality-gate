// Environment boundary for the explicitly trusted live OCR runner.
// This file is intentionally separate from the offline runner: live jobs get
// only the provider variables they need, while qgate itself never sees them.

const BASE_ENV = Object.freeze([
  'PATH', 'Path', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP',
]);

const PROVIDER_ENV = Object.freeze([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'OCR_MODEL',
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
  const baseUrl = String(env.ANTHROPIC_BASE_URL ?? '').trim();
  const token = String(env.ANTHROPIC_AUTH_TOKEN ?? '').trim();
  const model = String(env.OCR_MODEL ?? '').trim();
  if (!/^https:\/\//i.test(baseUrl)) throw new Error('ANTHROPIC_BASE_URL must use https');
  if (!token) throw new Error('ANTHROPIC_AUTH_TOKEN is required for live OCR');
  if (!model) throw new Error('OCR_MODEL is required for live OCR');
  return { baseUrl, model };
}
