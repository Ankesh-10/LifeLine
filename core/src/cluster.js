'use strict';

// Spatio-temporal clustering: many messy reports -> few incidents.
//
// Two reports are neighbours when their combined distance
//   sqrt((metres / epsMeters)^2 + (minutes / windowMinutes)^2) <= 1
// so reports must be close in space AND time. New reports first try to join an
// open incident; the rest are clustered with DBSCAN. A chaining guard
// (maxRadiusMeters from the cluster seed) stops a street of reports from
// merging into one city-wide blob.

const { haversineMeters, centroid, isPoint } = require('./geo');
const { toMillis, toIso } = require('./time');

const DEFAULTS = Object.freeze({
  epsMeters: 400,
  windowMinutes: 120,
  minPts: 2,
  maxRadiusMeters: 800,
  minConfidence: 0.5,
});

const NEED_SEVERITY = Object.freeze({ rescue: 3, medical: 2, supplies: 1 });
const NOISE = -1;

const withTime = (report) => ({ ...report, t: toMillis(report.sentAt) });
const byTimeThenId = (a, b) => a.t - b.t || String(a.id).localeCompare(String(b.id));

function spaceTimeDistance(a, b, opts) {
  const space = haversineMeters(a, b) / opts.epsMeters;
  const time = Math.abs(a.t - b.t) / (opts.windowMinutes * 60000);
  return Math.hypot(space, time);
}

/** DBSCAN over located reports. Noise points become single-report clusters. */
function dbscan(points, opts) {
  const n = points.length;
  const labels = new Array(n).fill(undefined);
  const neighbours = (i) => {
    const out = [];
    for (let j = 0; j < n; j++) if (spaceTimeDistance(points[i], points[j], opts) <= 1) out.push(j);
    return out;
  };

  let next = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== undefined) continue;
    const seedNeighbours = neighbours(i);
    if (seedNeighbours.length < opts.minPts) {
      labels[i] = NOISE;
      continue;
    }
    const c = next++;
    labels[i] = c;
    const queue = seedNeighbours.filter((j) => j !== i);
    while (queue.length) {
      const j = queue.shift();
      if (haversineMeters(points[i], points[j]) > opts.maxRadiusMeters) continue; // chaining guard
      if (labels[j] === NOISE) {
        labels[j] = c; // border point
        continue;
      }
      if (labels[j] !== undefined) continue;
      labels[j] = c;
      const nj = neighbours(j);
      if (nj.length >= opts.minPts) queue.push(...nj);
    }
  }
  for (let i = 0; i < n; i++) if (labels[i] === NOISE) labels[i] = next++;

  const clusters = Array.from({ length: next }, () => []);
  labels.forEach((c, i) => clusters[c].push(points[i]));
  return clusters.filter((c) => c.length);
}

/**
 * Aggregate a set of reports into an incident summary.
 * people = max across reports: duplicates describe the same household, so summing would inflate it.
 */
function summarize(reports) {
  if (!reports.length) throw new Error('summarize needs at least one report');
  const located = reports.filter(isPoint);
  const location = located.length
    ? centroid(located, located.map((r) => r.confidence ?? 1))
    : null;
  const needs = [...new Set(reports.map((r) => r.needType).filter((n) => n in NEED_SEVERITY))]
    .sort((a, b) => NEED_SEVERITY[b] - NEED_SEVERITY[a]);
  const times = reports.map((r) => toMillis(r.sentAt));
  const senderIds = [...new Set(reports.map((r) => r.senderId).filter(Boolean))];
  const anonymous = reports.filter((r) => !r.senderId).length;

  return {
    location,
    radiusM: location ? Math.round(Math.max(0, ...located.map((r) => haversineMeters(location, r)))) : 0,
    needType: needs[0] ?? 'rescue', // unknown need: assume life-safety
    needs: needs.length ? needs : ['rescue'],
    people: Math.max(0, ...reports.map((r) => (Number.isFinite(r.people) ? r.people : 0))),
    vulnerable: [...new Set(reports.flatMap((r) => r.vulnerable ?? []))].sort(),
    waterReported: reports.some((r) => r.inWater === true),
    reportCount: reports.length,
    uniqueSenders: senderIds.length + anonymous,
    senderIds,
    firstReportedAt: toIso(Math.min(...times)),
    lastReportedAt: toIso(Math.max(...times)),
    reportIds: reports.map((r) => r.id),
  };
}

function anchorOf(reports) {
  const s = summarize(reports);
  return s.location ? { ...s.location, t: toMillis(s.lastReportedAt) } : null;
}

/**
 * Assign new reports to open incidents or new clusters.
 *
 * @param {object} input
 * @param {Array<{id: string, reports: object[]}>} input.incidents  open incidents with their reports
 * @param {object[]} input.reports  new reports: { id, senderId, sentAt, lat, lon, needType, people, vulnerable, confidence, inWater }
 * @returns {{ updated: object[], created: object[], needsReview: object[] }}
 */
function assignReports({ incidents = [], reports = [] } = {}, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const groups = incidents.map((inc) => ({ id: inc.id, existing: inc.reports.map(withTime), added: [] }));
  const members = (g) => g.existing.concat(g.added);

  const needsReview = [];
  const located = [];
  const unlocated = [];
  for (const r of reports.map(withTime).sort(byTimeThenId)) {
    if (Number.isFinite(r.confidence) && r.confidence < opts.minConfidence) {
      needsReview.push({ reportId: r.id, reason: `low extraction confidence (${r.confidence})` });
    } else {
      (isPoint(r) ? located : unlocated).push(r);
    }
  }

  // 1. Join the nearest open incident in space-time.
  const fresh = [];
  for (const r of located) {
    let best = null;
    for (const g of groups) {
      const anchor = anchorOf(members(g));
      if (!anchor) continue;
      const d = spaceTimeDistance(r, anchor, opts);
      if (d <= 1 && (!best || d < best.d)) best = { g, d };
    }
    if (best) best.g.added.push(r);
    else fresh.push(r);
  }

  // 2. Cluster whatever is left into new incidents.
  const created = dbscan(fresh, opts).map((rs) => ({ id: null, existing: [], added: rs }));

  // 3. Unlocated reports inherit the location of the sender's latest cluster.
  const all = groups.concat(created);
  for (const r of unlocated) {
    const home = r.senderId
      ? all
          .filter((g) => members(g).some((m) => m.senderId === r.senderId))
          .sort((a, b) => Math.max(...members(b).map((m) => m.t)) - Math.max(...members(a).map((m) => m.t)))[0]
      : null;
    if (home) home.added.push(r);
    else needsReview.push({ reportId: r.id, reason: 'no location and no earlier report from this sender' });
  }

  const strip = (rs) => rs.map(({ t: _t, ...rest }) => rest);
  return {
    updated: groups
      .filter((g) => g.added.length)
      .map((g) => ({
        incidentId: g.id,
        addedReportIds: g.added.map((r) => r.id),
        summary: summarize(strip(members(g))),
      })),
    created: created.map((g, k) => ({
      key: `new-${k + 1}`,
      reportIds: g.added.map((r) => r.id),
      summary: summarize(strip(g.added)),
    })),
    needsReview,
  };
}

module.exports = { DEFAULTS, NEED_SEVERITY, assignReports, summarize, dbscan, spaceTimeDistance };
