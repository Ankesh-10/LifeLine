'use strict';

// Autonomy policy: decides whether an action runs automatically or waits for
// the coordinator. Approval is triggered by the risk of being WRONG (doubtful
// evidence, scarce resources, mass alerts), not by urgency, so the most urgent,
// well-corroborated incidents are never slowed down by the gate.
//
// Modes: manual (everything needs approval), assisted (rules below),
// autonomous (only alwaysRequireApproval actions wait).

const defaultConfig = require('../config/policy.json');

const ACTIONS = Object.freeze(['dispatch', 'reassign', 'broadcast']);

/**
 * @param {object} p
 * @param {'dispatch'|'reassign'|'broadcast'} p.action
 * @param {object} [p.evidence]               fusion.assessEvidence result
 * @param {number} [p.extractionConfidence]   mean LLM extraction confidence for the incident
 * @param {string} [p.resourceType]           type being committed
 * @param {Object<string, number>} [p.availableByType]  available resources per type, before this commit
 * @returns {{ decision: 'auto'|'needs_approval', reasons: string[], timeoutMinutes?: number, onTimeout?: string }}
 */
function decide({ action, evidence, extractionConfidence, resourceType, availableByType = {} }, config = defaultConfig) {
  if (!ACTIONS.includes(action)) throw new RangeError(`unknown action: ${action}`);
  const rules = config.approvalRequiredWhen;
  const reasons = [];

  if (config.mode === 'manual') reasons.push('manual mode: every action needs approval');
  if (config.alwaysRequireApproval.includes(action)) reasons.push(`${action} always needs approval`);

  if (config.mode === 'assisted' && action !== 'broadcast') {
    if (evidence && rules.evidenceStatus.includes(evidence.status)) reasons.push(`evidence is ${evidence.status}`);
    if (rules.evidenceConflict && evidence?.conflict) reasons.push('sensors and reporters disagree');
    if (rules.staleEvidence && evidence?.stale) reasons.push('reports may be outdated');
    if (rules.lowExtractionConfidence && Number.isFinite(extractionConfidence) && extractionConfidence < config.minExtractionConfidence) {
      reasons.push(`low extraction confidence (${extractionConfidence})`);
    }
    if (rules.lastAvailableOfType && resourceType && (availableByType[resourceType] ?? 0) <= 1) {
      reasons.push(`commits the last available ${resourceType}`);
    }
  }

  if (reasons.length) {
    return {
      decision: 'needs_approval',
      reasons,
      timeoutMinutes: config.approvalTimeoutMinutes,
      onTimeout: config.onApprovalTimeout,
    };
  }
  const why = config.mode === 'autonomous' ? ['autonomous mode'] : ['evidence and resources pass all checks'];
  if (action === 'reassign') why.push('original dispatch already cleared; reassignment is time-critical');
  return { decision: 'auto', reasons: why };
}

module.exports = { ACTIONS, decide };
