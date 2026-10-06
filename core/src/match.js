'use strict';

// Constraint-based resource matching, not "pick the nearest".
//
// 1. Hard constraints per (incident, resource): availability, vehicle type for
//    the need and terrain, capacity, blocked routes, maximum ETA.
// 2. Greedy pass in priority order: each incident takes its cheapest feasible resource.
// 3. Local search: swaps, moves to free resources and refills, minimising
//    sum(score x cost), where cost = ETA + soft penalties (e.g. no medic on board).
//    A swap never delays the higher-priority incident by more than maxDelayMinutes.

const { haversineMeters, pointToSegmentMeters, travelMinutes } = require('./geo');

const DEFAULTS = Object.freeze({
  detourFactor: { road: 1.4, water: 1.2 },
  mobilizationMinutes: { boat: 10, ambulance: 3, volunteer_team: 5 },
  medicPenaltyMinutes: 15,
  maxEtaMinutes: 180,
  maxDelayMinutes: 10,
  maxIterations: 200,
});

const round = (x, dp = 1) => Math.round(x * 10 ** dp) / 10 ** dp;
const terrainOf = (r) => r.terrain ?? (r.type === 'boat' ? 'water' : 'road');
const requiresMedic = (inc) => (inc.needs ?? [inc.needType]).includes('medical') || (inc.vulnerable ?? []).includes('injured');

/** Vehicle types allowed for an incident. Flooded areas need boats. */
function allowedTypes(incident) {
  if (incident.flooded) return ['boat'];
  if (incident.needType === 'medical') return ['ambulance'];
  return ['volunteer_team']; // dry-land rescue or supplies
}

function evaluate(incident, resource, blocks, opts) {
  const reject = (reason) => ({ feasible: false, reason });
  if (resource.status && resource.status !== 'available') return reject(`unavailable (${resource.status})`);

  const allowed = allowedTypes(incident);
  if (!allowed.includes(resource.type)) {
    return reject(incident.flooded ? `${resource.type} cannot reach a flooded area` : `${incident.needType} needs ${allowed.join(' or ')}`);
  }
  if (incident.needType === 'rescue' && resource.capacity < (incident.people ?? 0)) {
    return reject(`capacity ${resource.capacity} < ${incident.people} people`);
  }

  const terrain = terrainOf(resource);
  const block = blocks.find(
    (b) => (b.appliesTo ?? 'road') === terrain && pointToSegmentMeters(b.location, resource.location, incident.location) <= b.radiusM,
  );
  if (block) return reject(`route blocked${block.reason ? ` (${block.reason})` : ''}`);

  const distanceM = haversineMeters(resource.location, incident.location);
  const etaMinutes =
    (opts.mobilizationMinutes[resource.type] ?? 0) +
    travelMinutes(distanceM, resource.speedKmh, opts.detourFactor[terrain] ?? 1);
  if (etaMinutes > opts.maxEtaMinutes) return reject(`ETA ${round(etaMinutes)} min exceeds ${opts.maxEtaMinutes}`);

  const medicPenalty = requiresMedic(incident) && !resource.hasMedic ? opts.medicPenaltyMinutes : 0;
  return { feasible: true, distanceM, etaMinutes, cost: etaMinutes + medicPenalty, medicPenalty };
}

/**
 * @param {object} input
 * @param {object[]} input.incidents  { id, score, needType, needs, people, vulnerable, flooded, location: {lat, lon} }
 * @param {object[]} input.resources  { id, type, terrain, capacity, hasMedic, speedKmh, status, location: {lat, lon} }
 * @param {object[]} input.blocks     { location: {lat, lon}, radiusM, appliesTo: 'road'|'water', reason }
 */
function matchResources({ incidents = [], resources = [], blocks = [] } = {}, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const ordered = [...incidents].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || String(a.id).localeCompare(String(b.id)));
  const resourceById = new Map(resources.map((r) => [r.id, r]));
  const incidentById = new Map(ordered.map((i) => [i.id, i]));

  const evals = new Map(
    ordered.map((inc) => [inc.id, new Map(resources.map((r) => [r.id, evaluate(inc, r, blocks, opts)]))]),
  );
  const ev = (incId, resId) => evals.get(incId).get(resId);
  const weight = (inc) => Math.max(inc.score ?? 0, 1);

  const assignment = new Map(); // incidentId -> resourceId
  const taken = new Set();
  const cheapestFree = (inc) => {
    let best = null;
    for (const [rid, e] of evals.get(inc.id)) {
      if (!e.feasible || taken.has(rid)) continue;
      if (!best || e.cost < best.e.cost || (e.cost === best.e.cost && rid < best.rid)) best = { rid, e };
    }
    return best;
  };

  // Greedy pass, highest priority first.
  for (const inc of ordered) {
    const best = cheapestFree(inc);
    if (best) {
      assignment.set(inc.id, best.rid);
      taken.add(best.rid);
    }
  }

  // Local search.
  const trySwap = () => {
    const assigned = ordered.filter((i) => assignment.has(i.id));
    for (let a = 0; a < assigned.length; a++) {
      for (let b = a + 1; b < assigned.length; b++) {
        const A = assigned[a]; // higher priority
        const B = assigned[b];
        const ra = assignment.get(A.id);
        const rb = assignment.get(B.id);
        const eaNew = ev(A.id, rb);
        const ebNew = ev(B.id, ra);
        if (!eaNew.feasible || !ebNew.feasible) continue;
        if (eaNew.cost - ev(A.id, ra).cost > opts.maxDelayMinutes) continue;
        const before = weight(A) * ev(A.id, ra).cost + weight(B) * ev(B.id, rb).cost;
        const after = weight(A) * eaNew.cost + weight(B) * ebNew.cost;
        if (after < before - 1e-9) {
          assignment.set(A.id, rb);
          assignment.set(B.id, ra);
          return true;
        }
      }
    }
    return false;
  };
  const tryMove = () => {
    for (const inc of ordered) {
      const current = assignment.get(inc.id);
      if (!current) continue;
      const best = cheapestFree(inc);
      if (best && best.e.cost < ev(inc.id, current).cost - 1e-9) {
        taken.delete(current);
        taken.add(best.rid);
        assignment.set(inc.id, best.rid);
        return true;
      }
    }
    return false;
  };
  const tryFill = () => {
    for (const inc of ordered) {
      if (assignment.has(inc.id)) continue;
      const best = cheapestFree(inc);
      if (best) {
        assignment.set(inc.id, best.rid);
        taken.add(best.rid);
        return true;
      }
    }
    return false;
  };
  let iterations = 0;
  while (iterations++ < opts.maxIterations && (trySwap() || tryMove() || tryFill()));

  // Explain the result.
  const holderOf = new Map([...assignment].map(([incId, resId]) => [resId, incId]));
  const assignments = [];
  const unassigned = [];
  let objective = 0;

  for (const inc of ordered) {
    const options_ = [...evals.get(inc.id)];
    const feasible = options_
      .filter(([, e]) => e.feasible)
      .sort(([ra, a], [rb, b]) => a.cost - b.cost || ra.localeCompare(rb));
    const rejected = options_.filter(([, e]) => !e.feasible).map(([resourceId, e]) => ({ resourceId, reason: e.reason }));
    const rid = assignment.get(inc.id);

    if (!rid) {
      unassigned.push({
        incidentId: inc.id,
        reasons: feasible.length
          ? ['all suitable resources are committed to higher-priority incidents']
          : [...new Set(rejected.map((r) => r.reason))],
        rejected,
      });
      continue;
    }

    const e = ev(inc.id, rid);
    const res = resourceById.get(rid);
    objective += weight(inc) * e.cost;
    const reasons = [
      inc.flooded ? `${res.type}: area is flooded` : `${res.type} suits ${inc.needType}`,
      `ETA ${round(e.etaMinutes)} min (${round(e.distanceM / 1000, 2)} km)`,
    ];
    if (requiresMedic(inc)) reasons.push(res.hasMedic ? 'medic on board' : `no medic on board (+${e.medicPenalty} min penalty)`);
    const [bestRid, bestE] = feasible[0];
    if (bestRid !== rid) {
      const holder = incidentById.get(holderOf.get(bestRid));
      const why = (holder.score ?? 0) > (inc.score ?? 0)
        ? `higher-priority incident ${holder.id} (score ${holder.score})`
        : `incident ${holder.id} (score ${holder.score}) to lower total priority-weighted response time`;
      reasons.push(`best option ${bestRid} (ETA ${round(bestE.etaMinutes)} min) went to ${why}`);
    }
    assignments.push({
      incidentId: inc.id,
      resourceId: rid,
      etaMinutes: round(e.etaMinutes),
      distanceKm: round(e.distanceM / 1000, 2),
      reasons,
      alternatives: feasible
        .filter(([r]) => r !== rid)
        .slice(0, 3)
        .map(([resourceId, a]) => ({ resourceId, etaMinutes: round(a.etaMinutes), heldBy: holderOf.get(resourceId) ?? null })),
      rejected,
    });
  }

  return { assignments, unassigned, objective: round(objective, 2), iterations: iterations - 1 };
}

module.exports = { DEFAULTS, matchResources, allowedTypes, requiresMedic };
