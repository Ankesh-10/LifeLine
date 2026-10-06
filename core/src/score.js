'use strict';

// Explainable priority score (0-100): a weighted sum of normalised factors,
// scaled by how trustworthy the evidence is. Every factor's contribution is
// returned so a coordinator can see exactly why an incident ranks where it does.

const defaultConfig = require('../config/weights.json');
const { toMillis, minutesBetween } = require('./time');

const SEVERITY = Object.freeze({ rescue: 1.0, medical: 0.8, supplies: 0.4 });
const VULNERABILITY = Object.freeze({ injured: 1.0, disabled: 0.8, pregnant: 0.8, elderly: 0.7, child: 0.7 });

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round = (x, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;
const logScale = (x, cap) => clamp01(Math.log1p(Math.max(0, x)) / Math.log1p(cap));

function validateConfig(config) {
  const total = Object.values(config.weights).reduce((s, w) => s + w, 0);
  if (Math.abs(total - 1) > 1e-6) throw new Error(`score weights must sum to 1, got ${total}`);
  return config;
}

function factorSeverity(incident) {
  const base = SEVERITY[incident.needType] ?? SEVERITY.rescue;
  const extra = Math.max(0, (incident.needs?.length ?? 1) - 1) * 0.1;
  return { value: clamp01(base + extra), detail: `need ${incident.needType}${extra ? ` + ${incident.needs.length - 1} other need(s)` : ''}` };
}

function factorVulnerability(incident) {
  const flags = (incident.vulnerable ?? []).filter((v) => v in VULNERABILITY);
  if (!flags.length) return { value: 0, detail: 'none reported' };
  const top = Math.max(...flags.map((v) => VULNERABILITY[v]));
  return { value: clamp01(top + 0.15 * (flags.length - 1)), detail: flags.join(', ') };
}

function factorWaterRisk(evidence, caps) {
  const g = evidence?.signals?.gauge;
  const rain = evidence?.signals?.rainfall;
  if (!g && !rain) return { value: 0.5, detail: 'no sensor data nearby (neutral)' };
  let fromGauge = 0;
  if (g) {
    const floor = g.warningLevelM - caps.waterBandM;
    const level = clamp01((g.levelM - floor) / (g.dangerLevelM - floor));
    const trend = clamp01(g.trendMPerHour / caps.trendMPerHour);
    fromGauge = 0.6 * level + 0.4 * trend;
  }
  const fromRain = rain ? clamp01(rain.mmLast3h / caps.rainMm3h) : 0;
  const parts = [];
  if (g) parts.push(`gauge ${g.levelM} m (warn ${g.warningLevelM}, danger ${g.dangerLevelM}), ${g.trendMPerHour} m/h`);
  if (rain) parts.push(`${rain.mmLast3h} mm rain/3h`);
  return { value: Math.max(fromGauge, fromRain), detail: parts.join('; ') };
}

/**
 * @param {object} incident  summary from cluster.summarize
 * @param {object} evidence  result of fusion.assessEvidence (optional)
 * @param {object} [opts]    { now, config }
 */
function scoreIncident(incident, evidence, { now = Date.now(), config = defaultConfig } = {}) {
  const { weights, evidenceMultiplier, caps } = validateConfig(config);
  const waitingMin = Math.max(0, minutesBetween(incident.firstReportedAt, toMillis(now)));

  const raw = {
    severity: factorSeverity(incident),
    vulnerability: factorVulnerability(incident),
    people: { value: logScale(incident.people ?? 0, caps.people), detail: `${incident.people ?? 0} people` },
    waterRisk: factorWaterRisk(evidence, caps),
    reports: { value: logScale(incident.reportCount ?? 1, caps.reports), detail: `${incident.reportCount ?? 1} reports` },
    waiting: { value: clamp01(waitingMin / caps.waitingMinutes), detail: `${Math.round(waitingMin)} min waiting` },
  };

  const factors = {};
  let base = 0;
  for (const [name, weight] of Object.entries(weights)) {
    const f = raw[name];
    const contribution = 100 * weight * f.value;
    base += contribution;
    factors[name] = { value: round(f.value, 3), weight, contribution: round(contribution), detail: f.detail };
  }

  const status = evidence?.status ?? 'unverified';
  let multiplier = evidenceMultiplier[status] ?? 1;
  const multiplierReasons = [`evidence ${status} x${evidenceMultiplier[status] ?? 1}`];
  if (evidence?.stale) {
    multiplier *= evidenceMultiplier.stale;
    multiplierReasons.push(`stale x${evidenceMultiplier.stale}`);
  }

  return {
    score: round(base * multiplier),
    base: round(base),
    multiplier: { value: round(multiplier, 3), reasons: multiplierReasons },
    factors,
  };
}

/** Highest score first; ties go to whoever has waited longest. */
function rankIncidents(incidents) {
  return [...incidents].sort(
    (a, b) => b.score - a.score || toMillis(a.firstReportedAt) - toMillis(b.firstReportedAt),
  );
}

module.exports = { SEVERITY, VULNERABILITY, scoreIncident, rankIncidents, validateConfig };
