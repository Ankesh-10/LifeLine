'use strict';

// Outgoing messages: plain templates, no LLM. Every text says SIMULATED.
// Delivery specs tell n8n where to send; secrets (the Telegram bot token) are
// added by the HTTP node from $env, never put into item data.

const crypto = require('node:crypto');
const gazetteer = require('../config/gazetteer.json');
const { haversineMeters, isPoint } = require('./geo');

const DEFAULT_BOT_URL = 'http://host.docker.internal:4020';
const RESOURCE_LABEL = Object.freeze({ boat: 'Boat', ambulance: 'Ambulance', volunteer_team: 'Volunteer team' });

/** Nearest gazetteer locality, for human-readable texts. */
function nearestPlace(location, places = gazetteer.places) {
  if (!isPoint(location)) return null;
  let best = null;
  for (const p of places) {
    const d = haversineMeters(location, p);
    if (!best || d < best.d) best = { name: p.name, d };
  }
  return best?.name ?? null;
}

const fmtPoint = (p) => (isPoint(p) ? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` : 'unknown');

function describeIncident(inc = {}) {
  const who = [`${inc.people ?? '?'} people`];
  if (inc.vulnerable?.length) who.push(inc.vulnerable.join(', '));
  return `${inc.needType ?? 'rescue'} - ${who.join(', ')}`;
}

/** Task message for a responder. */
function dispatchText(d) {
  const place = nearestPlace(d.incident?.location) ?? 'the pinned location';
  return [
    'SIMULATED DISPATCH (demo, not a real emergency)',
    `${RESOURCE_LABEL[d.resourceType] ?? d.resourceType} ${d.resourceId}: go to ${place} (${fmtPoint(d.incident?.location)}).`,
    `Need: ${describeIncident(d.incident)}.`,
    d.etaMinutes != null ? `Estimated arrival: ${Math.round(d.etaMinutes)} min.` : null,
    'Reply with: ok / on the way / reached / blocked / need backup / done.',
  ].filter(Boolean).join('\n');
}

/** Where a dispatch goes: the SIMULATED responder bot, Telegram, or nowhere (audited only). */
function deliveryFor(d, env = {}) {
  const chat = d.contactChatId ?? '';
  if (chat.startsWith('sim-')) {
    return {
      channel: 'sim',
      url: `${(env.SIM_BOT_URL || DEFAULT_BOT_URL).replace(/\/+$/, '')}/dispatch`,
      body: { dispatchId: d.dispatchId, incidentId: d.incidentId, resourceId: d.resourceId, resourceType: d.resourceType, location: d.incident?.location },
    };
  }
  if (chat && env.TELEGRAM_BOT_TOKEN) {
    return { channel: 'telegram', body: { chat_id: chat, text: dispatchText(d) } };
  }
  return { channel: 'none', reason: chat ? 'TELEGRAM_BOT_TOKEN not set' : 'resource has no contact chat' };
}

/** Approval request for the coordinator, with one link per decision. */
function approvalText(d, links) {
  const lines = [
    'SIMULATED - approval needed',
    `${RESOURCE_LABEL[d.resourceType] ?? d.resourceType} ${d.resourceId} -> ${nearestPlace(d.incident?.location) ?? 'incident'} (${describeIncident(d.incident)}), ETA ${d.etaMinutes ?? '?'} min.`,
    `Why approval: ${(d.approvalReasons ?? []).join('; ') || 'policy'}.`,
  ];
  if (d.incident?.score != null) lines.push(`Priority score ${d.incident.score}.`);
  lines.push('', `Approve: ${links.approve}`, `Try another resource: ${links.reject}`, `Dismiss incident: ${links.dismiss}`);
  return lines.join('\n');
}

/** Unguessable token the decision link must carry (n8n resume URLs contain only the execution id). */
function newApprovalToken() {
  return crypto.randomBytes(16).toString('hex');
}

function approvalLinks(resumeUrl, token) {
  const link = (decision) => `${resumeUrl}?decision=${decision}&token=${encodeURIComponent(token)}`;
  return { approve: link('approve'), reject: link('reject'), dismiss: link('dismiss') };
}

/** Coordinator notification via Telegram, or none when not configured (the audit log still has it). */
function coordinatorNotice(text, env = {}) {
  if (env.TELEGRAM_BOT_TOKEN && env.COORDINATOR_CHAT_ID) {
    return { channel: 'telegram', body: { chat_id: env.COORDINATOR_CHAT_ID, text, disable_web_page_preview: true } };
  }
  return { channel: 'none', reason: 'TELEGRAM_BOT_TOKEN or COORDINATOR_CHAT_ID not set' };
}

module.exports = { nearestPlace, dispatchText, deliveryFor, approvalText, newApprovalToken, approvalLinks, coordinatorNotice };
