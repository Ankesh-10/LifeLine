'use strict';

// One function per n8n Code node. Each takes the JSON that a SQL
// lifeline_*_input() function returns and gives back a plan that the matching
// lifeline_apply_*() function writes, audit rows included (db/migrations/009).
// Pure: `now` always comes in with the input.

const { assignReports, summarize, spaceTimeDistance, DEFAULTS: clusterDefaults } = require('./cluster');
const { assessEvidence } = require('./fusion');
const { scoreIncident } = require('./score');
const { matchResources } = require('./match');
const { decide } = require('./policy');
const lc = require('./lifecycle');
const { toIso } = require('./time');
const { isPoint } = require('./geo');
const llm = require('./llm');
const { truthy } = require('./ingest');
const defaultPolicy = require('../config/policy.json');

const LIVE_DISPATCH = new Set(['sent', 'acknowledged', 'en_route', 'on_scene']);
const RESCORE_DELTA = 1; // re-audit an incident only when its score moves at least this much
const POLICY_MODES = new Set(['manual', 'assisted', 'autonomous']);

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * A safely quoted SQL string literal holding the value as JSON, for
 * `SELECT lifeline_apply_x({{ $json.sqlArg }}::jsonb)` in a Postgres node.
 * Assumes standard_conforming_strings (the Postgres default), so only ' needs doubling.
 * '$' is written as the JSON escape $ because n8n's Postgres node formats
 * queries with pg-promise, which would read "$100" in a message as a parameter.
 * NUL characters are dropped because jsonb cannot store them.
 */
function sqlJson(value) {
  const json = JSON.stringify(value ?? null, (_k, v) => (typeof v === 'string' ? v.replaceAll(String.fromCharCode(0), '') : v));
  return `'${json.replace(/'/g, "''").replace(/\$/g, '\\u0024')}'`;
}

function meanConfidence(reports) {
  const cs = reports.map((r) => r?.confidence).filter(Number.isFinite);
  return cs.length ? round2(cs.reduce((s, c) => s + c, 0) / cs.length) : null;
}

// ---------------------------------------------------------------- 02-conditions

/** Feed snapshot (sim/mock-feeds.js /conditions, or a real API mapped to the same shape) -> rows. */
function planConditions(feed, now) {
  const gauges = (feed?.gauges ?? [])
    .filter((g) => g?.id && isPoint(g) && Number.isFinite(g.warningLevelM) && Number.isFinite(g.dangerLevelM))
    .map((g) => ({
      id: String(g.id),
      name: g.name ?? String(g.id),
      lat: g.lat,
      lon: g.lon,
      warningLevelM: g.warningLevelM,
      dangerLevelM: Math.max(g.dangerLevelM, g.warningLevelM),
      readings: (g.readings ?? []).filter((r) => Number.isFinite(r?.levelM) && !Number.isNaN(Date.parse(r.at))).map((r) => ({ at: toIso(r.at), levelM: r.levelM })),
      simulated: g.simulated !== false,
    }));
  const rainfall = (feed?.rainfall ?? [])
    .filter((a) => a?.areaId && isPoint(a) && Number.isFinite(a.mmLast3h) && a.mmLast3h >= 0 && !Number.isNaN(Date.parse(a.at)))
    .map((a) => ({ areaId: String(a.areaId), lat: a.lat, lon: a.lon, at: toIso(a.at), mmLast3h: a.mmLast3h, simulated: a.simulated !== false }));
  return { now: toIso(now), gauges, rainfall, hasChanges: gauges.length + rainfall.length > 0 };
}

// ---------------------------------------------------------------- 03-triage

/**
 * cluster -> fuse -> score. New clusters become triaged incidents; every open
 * incident is re-assessed, but only material changes are written and audited.
 * @param {object} input  { now, reports, incidents: [{id, status, score, evidenceStatus, stale, flooded, reports}],
 *                          closedIncidents: [{id, status, location, lastReportedAt, closedAt, senderIds}], gauges, rainfall }
 */
function triage({ now, reports: incoming = [], incidents = [], closedIncidents = [], gauges = [], rainfall = [] }, options = {}) {
  const nowIso = toIso(now);
  const assess = (summary) => {
    const evidence = assessEvidence(summary, { gauges, rainfall, now: nowIso }, options.fusion);
    const score = scoreIncident(summary, evidence, options.weights ? { now: nowIso, config: options.weights } : { now: nowIso });
    return { evidence, score };
  };

  const late = lateReports(incoming, closedIncidents, options.cluster);
  const lateIds = new Set(late.map((l) => l.reportId));
  const reports = incoming.filter((r) => !lateIds.has(r.id));
  const result = assignReports({ incidents: incidents.map((i) => ({ id: i.id, reports: i.reports ?? [] })), reports }, options.cluster);
  const reportById = new Map(reports.map((r) => [r.id, r]));
  const incidentById = new Map(incidents.map((i) => [i.id, i]));

  const created = result.created.map((c) => ({
    key: c.key,
    reportIds: c.reportIds,
    summary: c.summary,
    ...assess(c.summary),
    extractionConfidence: meanConfidence(c.reportIds.map((id) => reportById.get(id))),
    status: lc.transitionIncident('new', 'triage'),
  }));

  const updated = result.updated.map((u) => {
    const all = (incidentById.get(u.incidentId).reports ?? []).concat(u.addedReportIds.map((id) => reportById.get(id)));
    return { incidentId: u.incidentId, addedReportIds: u.addedReportIds, summary: u.summary, ...assess(u.summary), extractionConfidence: meanConfidence(all) };
  });

  const touched = new Set(updated.map((u) => u.incidentId));
  const rescored = [];
  for (const inc of incidents) {
    if (touched.has(inc.id) || !inc.reports?.length) continue;
    const { evidence, score } = assess(summarize(inc.reports));
    const changes = [];
    if (inc.score == null || Math.abs(score.score - inc.score) >= RESCORE_DELTA) changes.push(`score ${inc.score ?? 'none'} -> ${score.score}`);
    if (inc.evidenceStatus !== evidence.status) changes.push(`evidence ${inc.evidenceStatus ?? 'none'} -> ${evidence.status}`);
    if (Boolean(inc.stale) !== evidence.stale) changes.push(evidence.stale ? 'became stale' : 'no longer stale');
    if (Boolean(inc.flooded) !== evidence.flooded) changes.push(evidence.flooded ? 'area now flooded' : 'area no longer flooded');
    if (changes.length) rescored.push({ incidentId: inc.id, evidence, score, changes });
  }

  // Reports held back only for a missing location are retried every run (their sender may report again).
  const reviews = result.needsReview.map((r) => ({
    reportId: r.reportId,
    reason: r.reason,
    reviewReason: /no location/.test(r.reason) ? 'no_location' : 'low_confidence',
    alreadyQueued: reportById.get(r.reportId)?.status === 'needs_review',
  }));

  const hasChanges = created.length + updated.length + rescored.length + late.length + reviews.filter((r) => !r.alreadyQueued).length > 0;
  return { now: nowIso, created, updated, rescored, late, reviews, hasChanges };
}

/**
 * Reports that land on an incident already resolved or dismissed: same place and
 * time window as the closed incident, or from one of its senders. They are most
 * likely late duplicates, but could be a new emergency, so a human decides:
 * they attach to the closed incident and go to the review queue, never to a new dispatch.
 */
function lateReports(reports, closedIncidents, clusterOptions = {}) {
  if (!closedIncidents.length) return [];
  const opts = { ...clusterDefaults, ...clusterOptions };
  const out = [];
  for (const r of reports) {
    const t = Date.parse(r.sentAt);
    let best = null;
    for (const inc of closedIncidents) {
      const sameSender = r.senderId != null && (inc.senderIds ?? []).includes(r.senderId);
      const near = isPoint(r) && isPoint(inc.location)
        && spaceTimeDistance({ ...r, t }, { ...inc.location, t: Date.parse(inc.lastReportedAt) }, opts) <= 1;
      if (!(near || (sameSender && !isPoint(r)))) continue;
      const closedAt = Date.parse(inc.closedAt);
      if (!best || closedAt > best.closedAt) best = { inc, closedAt };
    }
    if (best) {
      const what = best.inc.status === 'dismissed' ? 'dismissed' : 'resolved';
      out.push({ reportId: r.id, incidentId: best.inc.id, reviewReason: `after_${what === 'dismissed' ? 'dismissal' : 'resolution'}`, reason: `arrived after its incident was ${what}; a human decides if it is new` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 04-dispatch

/** Policy config with an optional POLICY_MODE override from env. */
function policyFromEnv(env = {}, base = defaultPolicy) {
  const mode = String(env.POLICY_MODE ?? '').trim().toLowerCase();
  return POLICY_MODES.has(mode) ? { ...base, mode } : base;
}

/**
 * match -> policy for every triaged incident without a live dispatch.
 * availableByType counts down in priority order, so committing the last boat
 * of a batch is caught even when several dispatches go out at once.
 * @param {object} input  { now, incidents: [{id, status, score, needType, needs, people, vulnerable, location, evidence, extractionConfidence, excludeResourceIds, replacesDispatchId}], resources, blocks }
 */
function planDispatch({ now, incidents = [], resources = [], blocks = [] }, { policyConfig, matchOptions } = {}) {
  const nowIso = toIso(now);
  const candidates = incidents
    .filter((i) => i.status === 'triaged' && isPoint(i.location))
    .map((i) => ({ ...i, flooded: i.flooded ?? i.evidence?.flooded ?? false }));
  if (!candidates.length) return { now: nowIso, dispatches: [], unassigned: [], hasDispatches: false };

  const result = matchResources({ incidents: candidates, resources, blocks }, matchOptions);
  const incidentById = new Map(candidates.map((i) => [i.id, i]));
  const resourceById = new Map(resources.map((r) => [r.id, r]));
  const available = {};
  for (const r of resources) if ((r.status ?? 'available') === 'available') available[r.type] = (available[r.type] ?? 0) + 1;

  const dispatches = result.assignments.map((a) => {
    const inc = incidentById.get(a.incidentId);
    const res = resourceById.get(a.resourceId);
    const action = inc.replacesDispatchId ? 'reassign' : 'dispatch';
    const policy = decide(
      { action, evidence: inc.evidence, extractionConfidence: inc.extractionConfidence ?? undefined, resourceType: res.type, availableByType: { ...available } },
      policyConfig,
    );
    available[res.type] -= 1;
    const auto = policy.decision === 'auto';
    return {
      incidentId: inc.id,
      resourceId: res.id,
      resourceType: res.type,
      action,
      decision: policy.decision,
      policyReasons: policy.reasons,
      approvalTimeoutMinutes: policy.timeoutMinutes ?? null,
      status: auto ? 'sent' : 'awaiting_approval',
      fromIncidentStatus: inc.status,
      incidentStatus: lc.transitionIncident(inc.status, auto ? 'dispatch' : 'request_approval'),
      etaMinutes: a.etaMinutes,
      distanceKm: a.distanceKm,
      match: a,
      replacesDispatchId: inc.replacesDispatchId ?? null,
    };
  });
  return { now: nowIso, dispatches, unassigned: result.unassigned, objective: result.objective, hasDispatches: dispatches.length > 0 };
}

// ---------------------------------------------------------------- 04-approval-gate

const APPROVAL_OUTCOMES = Object.freeze({
  approve: { status: 'sent', event: 'approve', closeReason: null, release: false, rematch: false, audit: 'dispatch.approved' },
  reject: { status: 'rejected', event: 'reject', closeReason: 'rejected_by_coordinator', release: true, rematch: true, audit: 'dispatch.rejected' },
  dismiss: { status: 'rejected', event: 'dismiss', closeReason: 'incident_dismissed', release: true, rematch: false, audit: 'incident.dismissed' },
  timeout: { status: 'cancelled', event: 'reject', closeReason: 'approval_timeout', release: true, rematch: true, audit: 'approval.escalated' },
  invalid: { status: 'cancelled', event: 'reject', closeReason: 'approval_link_invalid', release: true, rematch: true, audit: 'approval.invalid' },
});

/**
 * Turn the Wait-node result into a plan. A timeout or a bad token cancels the
 * request and re-plans, so the coordinator gets a fresh request (escalation).
 * @param {object} p  { dispatch: {dispatchId, incidentId, resourceId}, query: {decision, token, by}?, expectedToken, timedOut, now }
 */
function planApproval({ dispatch, query, expectedToken, timedOut = false, now }) {
  const at = toIso(now);
  let decision = timedOut ? 'timeout' : String(query?.decision ?? '').trim().toLowerCase();
  if (!timedOut && (!expectedToken || query?.token !== expectedToken || !APPROVAL_OUTCOMES[decision])) decision = 'invalid';
  const o = APPROVAL_OUTCOMES[decision];
  const coordinator = typeof query?.by === 'string' && query.by.trim() ? query.by.trim().slice(0, 64) : 'coordinator';

  const dispatchPatch = { status: o.status };
  if (decision === 'approve') Object.assign(dispatchPatch, { approvedBy: coordinator, approvedAt: at, sentAt: at });
  else Object.assign(dispatchPatch, { closedAt: at, closeReason: o.closeReason });
  if (decision === 'reject' || decision === 'dismiss') dispatchPatch.approvedBy = coordinator;

  return {
    now: at,
    decision,
    auditAction: o.audit,
    actor: decision === 'timeout' || decision === 'invalid' ? 'system' : 'coordinator',
    actorId: decision === 'timeout' || decision === 'invalid' ? '04-approval-gate' : coordinator,
    dispatchId: dispatch.dispatchId,
    expectedDispatchStatus: 'awaiting_approval',
    dispatchPatch,
    incidentId: dispatch.incidentId,
    fromIncidentStatus: 'awaiting_approval',
    incidentStatus: lc.transitionIncident('awaiting_approval', o.event),
    actions: o.release ? [{ type: 'release_resource', resourceId: dispatch.resourceId }] : [],
    rematch: o.rematch,
    notifyResponder: decision === 'approve',
  };
}

// ---------------------------------------------------------------- 05-replies

/** Replies webhook body (contract fixed by sim/responder-bot.js). Throws on a broken payload. */
function fromReplyWebhook(body) {
  const problems = [];
  if (!body || typeof body !== 'object') throw new Error('reply payload must be a JSON object');
  if (!['responder', 'requester'].includes(body.role)) problems.push('role must be responder or requester');
  if (typeof body.dispatchId !== 'string' || !body.dispatchId) problems.push('dispatchId is required');
  if (typeof body.text !== 'string') problems.push('text is required');
  if (problems.length) throw new Error(`invalid reply payload: ${problems.join('; ')}`);
  return {
    role: body.role,
    dispatchId: body.dispatchId,
    resourceId: body.resourceId ?? null,
    incidentId: body.incidentId ?? null,
    text: body.text,
    intentHint: typeof body.intentHint === 'string' ? body.intentHint : null,
    location: isPoint(body.location) ? { lat: body.location.lat, lon: body.location.lon } : null,
    sentAt: Number.isNaN(Date.parse(body.sentAt)) ? null : toIso(body.sentAt),
    simulated: body.simulated !== false,
  };
}

/** LLM if configured, else the SIMULATED intentHint (SIM_MODE), else "unclear" (asks for clarification). */
function planClassification({ reply, env = {} }) {
  const config = llm.llmConfig(env);
  const simMode = truthy(env.SIM_MODE);
  const hint = reply.intentHint ? llm.validateIntent({ intent: reply.intentHint }, reply.role) : null;
  const base = { reply, simMode, hint: hint?.ok ? hint.value : null };
  if (config.configured) return { ...base, route: 'llm', llm: llm.buildReplyRequest(config, { role: reply.role, text: reply.text }) };
  if (simMode && base.hint) return { ...base, route: 'hint', intent: base.hint, intentSource: 'sim_hint' };
  return { ...base, route: 'unclear', intent: 'unclear', intentSource: 'none' };
}

/** Validate the classifier answer; a bad answer never guesses. */
function acceptIntent({ plan, response }) {
  const parsed = llm.parseJsonContent(response);
  const checked = parsed.ok ? llm.validateIntent(parsed.value, plan.reply.role) : { ok: false, errors: [parsed.error] };
  if (checked.ok) return { ...plan, intent: checked.value, intentSource: `llm ${plan.llm.model} (${plan.llm.promptVersion})` };
  const error = checked.errors.join('; ');
  if (plan.simMode && plan.hint) return { ...plan, intent: plan.hint, intentSource: 'sim_hint_fallback', error };
  return { ...plan, intent: 'unclear', intentSource: 'llm_failed', error };
}

const NOTICE_TEXT = Object.freeze({
  ask_requester_confirmation: 'responder reports done; waiting for the requester to confirm',
  ask_responder_confirmation: 'requester confirms help arrived; waiting for the responder to confirm',
  request_backup: 'responder asks for backup',
  ask_clarification: 'responder reply was unclear',
  notify_coordinator: 'requester reply needs attention',
});

/**
 * Effects of a classified reply. Responder replies go through lifecycle.planReply;
 * a requester "confirmed" is one half of the two-sided resolution.
 * @param {object} p  { role, intent, dispatch, incident: {id, status, location}, resource: {id, location}, replyLocation?, now }
 */
function planReplyEffects({ role, intent, dispatch, incident, resource, replyLocation, text = null, intentSource = null, now }) {
  const at = toIso(now);
  const base = {
    now: at, role, intent, intentSource, text,
    dispatchId: dispatch?.id ?? null, incidentId: dispatch?.incidentId ?? null, resourceId: dispatch?.resourceId ?? null,
    expectedDispatchStatus: dispatch?.status ?? null, fromIncidentStatus: incident?.status ?? null,
  };
  const ignore = (reason) => ({ ...base, dispatchPatch: {}, incidentStatus: null, incidentEvent: null, actions: [{ type: 'ignore', reason }], rematch: false, notices: [] });
  if (!dispatch) return ignore('unknown dispatch');
  if (!LIVE_DISPATCH.has(dispatch.status)) return ignore(`dispatch is ${dispatch.status}`);

  let plan;
  if (role === 'requester') {
    plan = intent === 'confirmed'
      ? lc.planRequesterConfirmation(dispatch, now)
      : { dispatchPatch: {}, incidentEvent: null, actions: [{ type: 'notify_coordinator', reason: intent === 'not_confirmed' ? 'requester says help has not arrived' : 'unclear requester reply' }] };
  } else {
    plan = lc.planReply({ dispatch, intent, incident, resource, replyLocation, now });
  }

  const event = plan.incidentEvent;
  const incidentStatus = event && lc.canTransition(incident.status, event) ? lc.transitionIncident(incident.status, event) : null;
  const notices = plan.actions
    .filter((a) => NOTICE_TEXT[a.type])
    .map((a) => `SIMULATED - ${dispatch.resourceId} / incident ${dispatch.incidentId}: ${a.reason ?? NOTICE_TEXT[a.type]}`);
  return {
    ...base,
    dispatchPatch: plan.dispatchPatch,
    incidentEvent: event,
    incidentStatus: incidentStatus === incident.status ? null : incidentStatus,
    actions: plan.actions,
    rematch: plan.actions.some((a) => a.type === 'rematch'),
    notices,
  };
}

// ---------------------------------------------------------------- 06-watchdog

/** Watchdog timeouts from env, so the demo can use ~1 minute instead of 15. */
function watchdogOptions(env = {}) {
  const pick = (name) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const opts = {
    ackTimeoutMinutes: pick('WATCHDOG_ACK_MINUTES'),
    heartbeatTimeoutMinutes: pick('WATCHDOG_HEARTBEAT_MINUTES'),
    confirmTimeoutMinutes: pick('WATCHDOG_CONFIRM_MINUTES'),
  };
  return Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
}

/**
 * Silent teams are reassigned automatically (the resource goes offline);
 * stuck confirmations escalate to the coordinator once per dispatch.
 * @param {object} input  { now, dispatches: [{id, incidentId, incidentStatus, resourceId, status, sentAt, lastHeartbeatAt, responderConfirmedAt, requesterConfirmedAt, escalatedAt}] }
 */
function planWatchdog({ now, dispatches = [] }, options = {}) {
  const nowIso = toIso(now);
  const byId = new Map(dispatches.map((d) => [d.id, d]));
  const findings = lc.checkTimeouts(dispatches, nowIso, options);

  const reassignments = findings
    .filter((f) => f.action === 'reassign')
    .map((f) => {
      const d = byId.get(f.dispatchId);
      const p = lc.planReassignment(f, nowIso);
      return {
        ...f,
        expectedDispatchStatus: d.status,
        dispatchPatch: p.dispatchPatch,
        resourcePatch: p.resourcePatch,
        fromIncidentStatus: d.incidentStatus,
        incidentStatus: lc.canTransition(d.incidentStatus, p.incidentEvent) ? lc.transitionIncident(d.incidentStatus, p.incidentEvent) : null,
        actions: p.actions,
      };
    });
  const escalations = findings.filter((f) => f.action === 'escalate' && !byId.get(f.dispatchId).escalatedAt);
  const notices = [
    ...reassignments.map((r) => `SIMULATED - ${r.resourceId} silent for ${r.minutes} min (${r.reason}); reassigning incident ${r.incidentId}`),
    ...escalations.map((e) => `SIMULATED - incident ${e.incidentId}: ${e.reason} for ${e.minutes} min; please check`),
  ];
  return { now: nowIso, reassignments, escalations, notices, hasChanges: reassignments.length + escalations.length > 0 };
}

// ---------------------------------------------------------------- audit helpers

/** Audit entry for a responder delivery attempt (HTTP node output, possibly an error item). */
function deliveryEvent(dispatch, delivery, response) {
  const failed = delivery.channel !== 'none' && (response?.error != null || response?.ok === false);
  return {
    actor: 'agent',
    actorId: '04-dispatch',
    action: delivery.channel === 'none' ? 'dispatch.delivery_skipped' : failed ? 'dispatch.delivery_failed' : 'dispatch.delivered',
    entityType: 'dispatch',
    entityId: dispatch.dispatchId,
    payload: { channel: delivery.channel, resourceId: dispatch.resourceId, reason: delivery.reason ?? null, error: failed ? String(response?.error?.message ?? response?.error ?? response?.description ?? 'failed') : null },
    reason: delivery.channel === 'none' ? delivery.reason : `sent to ${dispatch.resourceId} via ${delivery.channel}`,
  };
}

/** Audit entry from n8n's Error Trigger output. */
function errorEvent(trigger) {
  const exec = trigger?.execution ?? {};
  const message = exec.error?.message ?? 'unknown error';
  return {
    actor: 'system',
    actorId: trigger?.workflow?.name ?? 'unknown workflow',
    action: 'workflow.error',
    entityType: 'workflow',
    entityId: trigger?.workflow?.id ?? null,
    payload: { executionId: exec.id ?? null, url: exec.url ?? null, lastNodeExecuted: exec.lastNodeExecuted ?? null, mode: exec.mode ?? null, message, stack: exec.error?.stack?.slice(0, 2000) ?? null },
    reason: message,
  };
}

module.exports = {
  sqlJson,
  planConditions,
  triage,
  policyFromEnv,
  planDispatch,
  planApproval,
  fromReplyWebhook,
  planClassification,
  acceptIntent,
  planReplyEffects,
  watchdogOptions,
  planWatchdog,
  deliveryEvent,
  errorEvent,
};
