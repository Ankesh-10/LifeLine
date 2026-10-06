'use strict';

// Shared test helpers: replay the scenario the way n8n will see it
// (geocode -> incremental clustering on a fixed tick), without a database.

const core = require('../../core/src');
const { loadScenario } = require('../lib/scenario');

const scenario = loadScenario();
const START_MS = Date.parse(scenario.referenceStart);
const iso = (ms) => new Date(ms).toISOString();

function toReport(m) {
  const loc = core.resolveLocation({ pin: m.pin, locationText: m.extraction.locationText, text: m.text });
  return {
    id: m.id,
    senderId: m.senderId,
    sentAt: iso(START_MS + m.offsetMin * 60000),
    lat: loc?.lat,
    lon: loc?.lon,
    needType: m.extraction.needType,
    people: m.extraction.people,
    vulnerable: m.extraction.vulnerable,
    confidence: m.extraction.confidence,
    inWater: m.extraction.inWater,
  };
}

/**
 * Triage on a tick, like n8n 03-triage. Reports held back only for missing
 * location are retried on later ticks (their sender may report again).
 */
function streamTriage(messages = scenario.messages, tickMin = 1) {
  const incidents = [];
  let pending = [];
  let n = 0;
  const end = Math.max(...messages.map((m) => m.offsetMin));
  for (let t = 0; t <= end + tickMin; t += tickMin) {
    const arrived = messages.filter((m) => m.offsetMin > t - tickMin && m.offsetMin <= t).map(toReport);
    const batch = pending.concat(arrived);
    if (!batch.length) continue;
    const res = core.assignReports({ incidents, reports: batch });
    const byId = new Map(batch.map((r) => [r.id, r]));
    for (const u of res.updated) incidents.find((i) => i.id === u.incidentId).reports.push(...u.addedReportIds.map((id) => byId.get(id)));
    for (const c of res.created) incidents.push({ id: `inc-${++n}`, reports: c.reportIds.map((id) => byId.get(id)) });
    pending = res.needsReview.filter((r) => /no location/.test(r.reason)).map((r) => byId.get(r.reportId));
  }
  return { incidents, pending };
}

const truthOf = new Map(scenario.messages.map((m) => [m.id, m.truthIncident]));

// Mirrors db/seed/resources.sql.
const R = (id, type, capacity, hasMedic, speedKmh, lat, lon) => ({
  id, type, terrain: type === 'boat' ? 'water' : 'road', capacity, hasMedic, speedKmh, status: 'available', location: { lat, lon },
});
const seedResources = () => [
  R('B1', 'boat', 10, false, 8, 12.979, 80.22),
  R('B2', 'boat', 10, false, 8, 13.023, 80.223),
  R('B3', 'boat', 10, false, 8, 12.925, 80.118),
  R('B4', 'boat', 6, true, 8, 13.018, 80.242),
  R('A1', 'ambulance', 2, true, 30, 13.0067, 80.2206),
  R('A2', 'ambulance', 2, true, 30, 13.0418, 80.2341),
  R('A3', 'ambulance', 2, true, 30, 13.0012, 80.2565),
  R('V1', 'volunteer_team', 6, false, 20, 12.9647, 80.1961),
  R('V2', 'volunteer_team', 6, false, 20, 12.9654, 80.2461),
  R('V3', 'volunteer_team', 6, false, 20, 13.035, 80.2121),
];

module.exports = { scenario, START_MS, iso, toReport, streamTriage, truthOf, seedResources };
