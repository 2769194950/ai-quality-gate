// Approval (human gate) reading and evaluation (§3.2, §5.2, §9.1, REQ-008/REQ-016).
import path from 'node:path';
import { humanGates, humanGateRoles, approvalDecisions } from './contract.mjs';
import { readTextIfExists } from './util/fsx.mjs';
import { redact } from './util/text.mjs';

export const humanGateById = new Map(humanGates.map((gate) => [gate.gateId, gate]));

/** `verification/approvals/<gateId>/approval.json` — the frozen default record path. */
export function defaultApprovalRecord(gateId) {
  return `verification/approvals/${gateId}/approval.json`;
}

/**
 * Read one approval record. Returns
 * `{ state, approvedBy, approvedAt, detail, path }` where state is one of the
 * frozen approvalStates enum values.
 */
export function readApproval(root, approvalRecord, expected) {
  const rel = approvalRecord ?? defaultApprovalRecord(expected.gateId);
  const text = readTextIfExists(path.join(root, rel.split('/').join(path.sep)));
  if (text === null) {
    return { state: 'missing', approvedBy: null, approvedAt: null, detail: `approval record not found: ${rel}`, path: rel };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { state: 'missing', approvedBy: null, approvedAt: null, detail: `approval record is not parseable JSON (${error.message})`, path: rel };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'missing', approvedBy: null, approvedAt: null, detail: 'approval record is not an object', path: rel };
  }
  if (parsed.gateId !== expected.gateId) {
    return { state: 'missing', approvedBy: parsed.approvedBy ?? null, approvedAt: parsed.approvedAt ?? null, detail: `approval gateId "${parsed.gateId}" does not match gate "${expected.gateId}"`, path: rel };
  }
  if (!humanGateRoles.includes(parsed.role) || parsed.role !== expected.role) {
    return {
      state: 'role_mismatch',
      approvedBy: parsed.approvedBy ?? null,
      approvedAt: parsed.approvedAt ?? null,
      detail: `approval role "${parsed.role}" does not match required role "${expected.role}"`,
      path: rel,
    };
  }
  if (!approvalDecisions.includes(parsed.decision)) {
    return { state: 'missing', approvedBy: parsed.approvedBy ?? null, approvedAt: parsed.approvedAt ?? null, detail: `approval decision "${parsed.decision}" is not one of ${approvalDecisions.join('|')}`, path: rel };
  }
  if (parsed.decision !== 'approved') {
    return {
      state: 'rejected',
      approvedBy: parsed.approvedBy ?? null,
      approvedAt: parsed.approvedAt ?? null,
      detail: `approval decision is "${parsed.decision}"`,
      path: rel,
    };
  }
  if (typeof parsed.approvedBy !== 'string' || parsed.approvedBy.trim().length === 0) {
    return { state: 'missing', approvedBy: null, approvedAt: parsed.approvedAt ?? null, detail: 'approval record has no non-empty approvedBy', path: rel };
  }
  if (typeof parsed.approvedAt !== 'string' || parsed.approvedAt.trim().length === 0) {
    return { state: 'missing', approvedBy: parsed.approvedBy, approvedAt: null, detail: 'approval record has no approvedAt timestamp', path: rel };
  }
  if (!Array.isArray(parsed.claims) || parsed.claims.some((claim) => !claim || typeof claim !== 'object' || typeof claim.claimId !== 'string')) {
    return { state: 'missing', approvedBy: parsed.approvedBy, approvedAt: parsed.approvedAt, detail: 'approval record claims must be an array of {claimId, statement, testIds}', path: rel };
  }
  return {
    state: 'approved',
    approvedBy: parsed.approvedBy,
    approvedAt: parsed.approvedAt,
    detail: `approved by ${parsed.approvedBy} at ${parsed.approvedAt}`,
    path: rel,
    claims: parsed.claims,
  };
}

/** Evaluate the human gate of one configured gate. Never throws on bad input. */
export function evaluateHumanGate(root, gate) {
  // The handover identity (§3.2) is carried by `humanGate.gateId` when the
  // configuration declares it, otherwise the gate id doubles as the handover id.
  const handoverId = gate.humanGate?.gateId ?? gate.id;
  const spec = humanGateById.get(handoverId);
  const expected = { gateId: handoverId, role: gate.humanGate?.role ?? spec?.role ?? 'unknown' };
  const record = gate.humanGate?.approvalRecord ?? spec?.approvalRecord ?? defaultApprovalRecord(handoverId);
  const approval = readApproval(root, record, expected);
  return {
    gateId: handoverId,
    role: expected.role,
    approvalRecord: record,
    approvalState: approval.state,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    detail: redact(approval.detail),
  };
}

export function buildHumanGateBlocker(gate, evaluation) {
  return {
    checkId: gate.id,
    severity: 'blocker',
    message: `HUMAN_GATE_NOT_APPROVED: gate "${gate.id}" requires role "${evaluation.role}" to approve ${evaluation.approvalRecord} (state=${evaluation.approvalState}: ${evaluation.detail})`,
    evidence: [approvalEvidence(evaluation, gate.configPath)],
  };
}

/**
 * Evidence for a human-gate decision. When the approval record exists it is
 * referenced as `kind="file"` (resolvable, REQ-007); when it is absent the
 * deciding artefact is the configuration itself, so a `json_pointer` reference is
 * produced instead of a dangling file path.
 */
export function approvalEvidence(evaluation, configPath = 'qgate.config.json') {
  const summary = redact(
    `approvalState=${evaluation.approvalState}${evaluation.approvedBy ? ` approvedBy=${evaluation.approvedBy}` : ''}${evaluation.approvedAt ? ` approvedAt=${evaluation.approvedAt}` : ''} (${evaluation.detail})`,
  );
  if (evaluation.approvalState === 'missing') {
    return { path: configPath.replace(/\\/g, '/'), kind: 'json_pointer', excerpt: `${evaluation.role} ${summary}` };
  }
  return { path: evaluation.approvalRecord, kind: 'file', excerpt: summary };
}
