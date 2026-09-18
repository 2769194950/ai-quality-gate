// Rule resolution for `--preview` (docs/01-architecture.md §4.1).
// Frozen precedence: --rule > project (.opencodereview/rule.json) > user
// (~/.opencodereview/rule.json) > built-in, and the FIRST matching rule wins.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { globMatch } from './util/glob.mjs';
import { configError } from './errors.mjs';

export const RULE_SOURCES = Object.freeze(['--rule', 'project', 'user', 'builtin']);
export const PROJECT_RULE_PATH = '.opencodereview/rule.json';
export const USER_RULE_PATH = path.join(os.homedir(), '.opencodereview', 'rule.json');
/**
 * Built-in rules are constants compiled into the engine, not a file on disk, so
 * they are reported under an explicitly non-filesystem pseudo-path. A value that
 * looks like a path but cannot be resolved would surface as a false failure during
 * an audit (the same class of defect as GAP-7 evidence fidelity).
 */
export const BUILTIN_RULE_PATH = 'builtin:qgate';

/** Built-in rules: used when no rule file on disk applies. First match wins. */
export const BUILTIN_RULES = Object.freeze([
  Object.freeze({ id: 'builtin-tests', match: '**/*.test.mjs', severity: 'medium', category: 'tests' }),
  Object.freeze({ id: 'builtin-config', match: '**/*.json', severity: 'low', category: 'config' }),
  Object.freeze({ id: 'builtin-docs', match: '**/*.md', severity: 'low', category: 'docs' }),
  Object.freeze({ id: 'builtin-source', match: '**/*.{mjs,js,cjs,ts}', severity: 'medium', category: 'source' }),
  Object.freeze({ id: 'builtin-other', match: '**/*', severity: 'low', category: 'other' }),
]);

export function builtinRuleFile() {
  return {
    schemaVersion: '1.0',
    source: 'builtin',
    path: BUILTIN_RULE_PATH,
    pathKind: 'pseudo', // not a filesystem path: the rules are engine constants
    rules: BUILTIN_RULES.map((rule) => ({ ...rule })),
  };
}

function loadRuleFile(absPath) {
  let text;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw configError(`rule file is not parseable JSON: ${absPath}`, {
      jsonPointer: '',
      details: [{ jsonPointer: '', expected: 'valid JSON', actual: error.message, message: `rule file parse error: ${error.message}` }],
    });
  }
  const rules = Array.isArray(parsed) ? parsed : parsed.rules;
  if (!Array.isArray(rules)) {
    throw configError(`rule file has no "rules" array: ${absPath}`, {
      jsonPointer: '/rules',
      details: [{ jsonPointer: '/rules', expected: 'array<object>', actual: typeof rules, message: 'rule file must expose a rules array' }],
    });
  }
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    if (rule === null || typeof rule !== 'object' || typeof rule.match !== 'string') {
      throw configError(`rule[${i}] must be an object with a string "match" pattern`, {
        jsonPointer: `/rules/${i}/match`,
        details: [{ jsonPointer: `/rules/${i}/match`, expected: 'string glob', actual: String(rule?.match), message: 'each rule needs a glob match pattern' }],
      });
    }
  }
  return { rules };
}

/**
 * Load the rule chain in precedence order. The returned list is ordered
 * highest-priority first; `matchRule` returns the first hit.
 *
 * Each layer carries `pathKind`: `"file"` for a layer backed by a real file on
 * disk and `"pseudo"` for the built-in constants, so a consumer never mistakes the
 * built-in layer's identifier for a resolvable path.
 */
export function loadRuleChain({ root, rulePath = null, ruleFile = null } = {}) {
  const chain = [];
  if (ruleFile) {
    const parsed = typeof ruleFile === 'string' ? loadRuleFile(ruleFile) : { rules: ruleFile.rules ?? ruleFile };
    if (!parsed) throw configError(`rule file not found: ${ruleFile}`, { jsonPointer: '' });
    // A configuration that points `selection.ruleFile` at the project rule path
    // keeps the project precedence label; anything else is a user-specified rule.
    const source = typeof ruleFile === 'string' && ruleFile.replace(/\\/g, '/') === PROJECT_RULE_PATH ? 'project' : '--rule';
    chain.push({ source, path: ruleFile, pathKind: 'file', rules: parsed.rules });
  }
  if (rulePath) {
    const abs = path.isAbsolute(rulePath) ? rulePath : path.resolve(root, rulePath);
    const parsed = loadRuleFile(abs);
    if (!parsed) throw configError(`rule file not found: ${rulePath}`, { jsonPointer: '' });
    const source = rulePath.replace(/\\/g, '/') === PROJECT_RULE_PATH ? 'project' : '--rule';
    chain.push({ source, path: rulePath, pathKind: 'file', rules: parsed.rules });
  }
  if (!chain.some((layer) => layer.source === 'project')) {
    const projectAbs = path.join(root, PROJECT_RULE_PATH.split('/').join(path.sep));
    const project = loadRuleFile(projectAbs);
    if (project) chain.push({ source: 'project', path: PROJECT_RULE_PATH, pathKind: 'file', rules: project.rules });
  }

  const user = loadRuleFile(USER_RULE_PATH);
  if (user) chain.push({ source: 'user', path: USER_RULE_PATH, pathKind: 'file', rules: user.rules });

  chain.push({ source: 'builtin', path: BUILTIN_RULE_PATH, pathKind: 'pseudo', rules: BUILTIN_RULES.map((rule) => ({ ...rule })) });
  return chain;
}

/** First matching rule across the chain, or null when nothing matches. */
export function matchRule(chain, file) {
  for (const layer of chain) {
    for (const rule of layer.rules) {
      if (globMatch(rule.match, file)) {
        return { file, ruleSource: layer.source, ruleId: rule.id ?? null, match: rule.match, severity: rule.severity ?? null, category: rule.category ?? null, priority: RULE_SOURCES.indexOf(layer.source) };
      }
    }
  }
  return null;
}

export const rulesVersion = '1.0';
