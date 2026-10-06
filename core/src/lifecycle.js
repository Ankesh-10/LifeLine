'use strict';

// Incident state machine, responder-reply handling and the silence watchdog.
// Functions are pure: they return patches and actions; n8n applies them.

const { midpoint } = require('./geo');
const { toIso, minutesBetween } = require('./time');

const INCIDENT_TRANSITIONS = Object.freeze({
  new: { triage: 'triaged', dismiss: 'dismissed' },
  triaged: { triage: 'triaged', request_approval: 'awaiting_approval', dispatch: 'dispatched', dismiss: 'dismissed' },
  awaiting_approval: { approve: 'dispatched', reject: 'triaged', dismiss: 'dismissed' },
  dispatched: { ack: 'dispatched', en_route: 'en_route', on_scene: 'on_scene', reassign: 'triaged', resolve: 'resolved' },
  en_route: { en_route: 'en_route', on_scene: 'on_scene', reassign: 'triaged', resolve: 'resolved' },
  on_scene: { on_scene: 'on_scene', reassign: 'triaged', resolve: 'resolved' },
  resolved: {},
  dismissed: {},
});

const LIVE_DISPATCH = new Set(['sent', 'acknowledged', 'en_route', 'on_scene']);
const REPLY_INTENTS = Object.freeze(['ack', 'en_route', 'on_scene', 'blocked', 'need_backup', 'resolved', 'unclear']);

const WATCHDOG_DEFAULTS = Object.freeze({
  ackTimeoutMinutes: 5,
  heartbeatTimeoutMinutes: 15,
  confirmTimeoutMinutes: 30,
  blockRadiusM: 300,
});

class InvalidTransitionError extends Error {
  constructor(from, event) {
    super(`invalid incident transition: '${event}' from '${from}'`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.event = event;
  }
}

function transitionIncident(status, event) {
  const next = INCIDENT_TRANSITIONS[status]?.[event];
  if (!next) throw new InvalidTransitionError(status, event);
  return next;
}

function canTransition(status, event) {
  return Boolean(INCIDENT_TRANSITIONS[status]?.[event]);
}

/** Close a dispatch only when both the responder and the requester confirmed. */
function completion(dispatch, now) {
  if (dispatch.responderConfirmedAt && dispatch.requesterConfirmedAt) {
    return {
      dispatchPatch: { status: 'completed', closedAt: toIso(now), closeReason: 'confirmed_by_both' },
      incidentEvent: 'resolve',
      actions: [{ type: 'release_resource', resourceId: dispatch.resourceId }],
    };
  }
  const waitingOn = dispatch.responderConfirmedAt ? 'requester' : 'responder';
  return {
    dispatchPatch: {},
    incidentEvent: null,
    actions: [{ type: waitingOn === 'requester' ? 'ask_requester_confirmation' : 'ask_responder_confirmation', incidentId: dispatch.incidentId }],
  };
}

/**
 * Plan the effect of a classified responder reply.
 * @param {object} p  { dispatch, intent, incident: {location}, resource: {location}, replyLocation?, now }
 * @returns {{ dispatchPatch, incidentEvent, actions }}
 */
function planReply({ dispatch, intent, incident, resource, replyLocation, now = Date.now() }, options = {}) {
  const opts = { ...WATCHDOG_DEFAULTS, ...options };
  if (!REPLY_INTENTS.includes(intent)) throw new RangeError(`unknown reply intent: ${intent}`);
  if (!LIVE_DISPATCH.has(dispatch.status)) {
    return { dispatchPatch: {}, incidentEvent: null, actions: [{ type: 'ignore', reason: `dispatch is ${dispatch.status}` }] };
  }

  const at = toIso(now);
  const base = { lastHeartbeatAt: at };
  switch (intent) {
    case 'ack':
      return { dispatchPatch: { ...base, status: dispatch.status === 'sent' ? 'acknowledged' : dispatch.status }, incidentEvent: 'ack', actions: [] };
    case 'en_route':
      return { dispatchPatch: { ...base, status: 'en_route' }, incidentEvent: 'en_route', actions: [] };
    case 'on_scene':
      return { dispatchPatch: { ...base, status: 'on_scene' }, incidentEvent: 'on_scene', actions: [] };
    case 'resolved': {
      const confirmed = { ...dispatch, responderConfirmedAt: dispatch.responderConfirmedAt ?? at };
      const done = completion(confirmed, now);
      return {
        dispatchPatch: { ...base, status: 'on_scene', responderConfirmedAt: confirmed.responderConfirmedAt, ...done.dispatchPatch },
        incidentEvent: done.incidentEvent ?? (dispatch.status === 'on_scene' ? null : 'on_scene'),
        actions: done.actions,
      };
    }
    case 'blocked': {
      const where = replyLocation ?? midpoint(resource.location, incident.location);
      return {
        dispatchPatch: { ...base, status: 'failed', closedAt: at, closeReason: 'route_blocked' },
        incidentEvent: 'reassign',
        actions: [
          { type: 'add_route_block', location: where, radiusM: opts.blockRadiusM, appliesTo: 'road', reportedBy: dispatch.resourceId, reason: 'reported by responder' },
          { type: 'release_resource', resourceId: dispatch.resourceId },
          { type: 'rematch', incidentId: dispatch.incidentId, excludeResourceIds: [dispatch.resourceId] },
        ],
      };
    }
    case 'need_backup':
      return { dispatchPatch: base, incidentEvent: null, actions: [{ type: 'request_backup', incidentId: dispatch.incidentId }] };
    default:
      return { dispatchPatch: base, incidentEvent: null, actions: [{ type: 'ask_clarification', resourceId: dispatch.resourceId }] };
  }
}

/** Requester confirmed that help arrived. */
function planRequesterConfirmation(dispatch, now = Date.now()) {
  const confirmed = { ...dispatch, requesterConfirmedAt: dispatch.requesterConfirmedAt ?? toIso(now) };
  const done = completion(confirmed, now);
  return { ...done, dispatchPatch: { requesterConfirmedAt: confirmed.requesterConfirmedAt, ...done.dispatchPatch } };
}

/**
 * Watchdog: find live dispatches that need intervention.
 * Silent teams are reassigned automatically; stuck confirmations escalate to the coordinator.
 */
function checkTimeouts(dispatches, now = Date.now(), options = {}) {
  const opts = { ...WATCHDOG_DEFAULTS, ...options };
  const findings = [];
  for (const d of dispatches) {
    if (!LIVE_DISPATCH.has(d.status)) continue;
    const sinceSent = minutesBetween(d.sentAt, now);
    const sinceBeat = minutesBetween(d.lastHeartbeatAt ?? d.sentAt, now);
    const finding = (reason, action, minutes) =>
      findings.push({ dispatchId: d.id, incidentId: d.incidentId, resourceId: d.resourceId, reason, action, minutes: Math.round(minutes) });

    if (d.status === 'sent' && sinceSent > opts.ackTimeoutMinutes) {
      finding('no_ack', 'reassign', sinceSent);
    } else if ((d.status === 'acknowledged' || d.status === 'en_route') && sinceBeat > opts.heartbeatTimeoutMinutes) {
      finding('silent', 'reassign', sinceBeat);
    } else if (d.status === 'on_scene') {
      if (d.responderConfirmedAt && !d.requesterConfirmedAt && minutesBetween(d.responderConfirmedAt, now) > opts.confirmTimeoutMinutes) {
        finding('requester_unconfirmed', 'escalate', minutesBetween(d.responderConfirmedAt, now));
      } else if (sinceBeat > opts.heartbeatTimeoutMinutes * 2) {
        finding('silent_on_scene', 'escalate', sinceBeat);
      }
    }
  }
  return findings;
}

/** Patches for reassigning a dispatch the watchdog flagged. The silent resource goes offline. */
function planReassignment(finding, now = Date.now()) {
  return {
    dispatchPatch: { status: 'reassigned', closedAt: toIso(now), closeReason: finding.reason },
    resourcePatch: { id: finding.resourceId, status: 'offline' },
    incidentEvent: 'reassign',
    actions: [{ type: 'rematch', incidentId: finding.incidentId, excludeResourceIds: [finding.resourceId] }],
  };
}

module.exports = {
  INCIDENT_TRANSITIONS,
  REPLY_INTENTS,
  WATCHDOG_DEFAULTS,
  InvalidTransitionError,
  transitionIncident,
  canTransition,
  planReply,
  planRequesterConfirmation,
  checkTimeouts,
  planReassignment,
};
