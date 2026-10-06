'use strict';

// Multi-source evidence fusion: cross-check an incident against river gauges,
// rainfall and the crowd. Sensors can contradict a flood-rescue claim, but
// enough independent reporters override a sensor (flagged as a conflict for a human).

const { haversineMeters } = require('./geo');
const { toMillis, toIso, minutesBetween } = require('./time');

const DEFAULTS = Object.freeze({
  maxGaugeKm: 8,
  maxRainKm: 5,
  trendWindowHours: 3,
  risingTrendMPerHour: 0.1,
  normalMarginM: 0.5, // this far below warning level counts as normal
  heavyRainMm3h: 30,
  lightRainMm3h: 5,
  crowdCorroboration: 3, // independent senders that outweigh a sensor
  staleAfterMinutes: 180, // stale if older than this AND water is receding
  maxAgeMinutes: 360, // stale regardless
});

const round = (x, dp) => Math.round(x * 10 ** dp) / 10 ** dp;

function nearest(items, location, maxKm) {
  let best = null;
  for (const item of items) {
    const d = haversineMeters(location, item);
    if (d <= maxKm * 1000 && (!best || d < best.d)) best = { item, d };
  }
  return best;
}

/** Latest level and least-squares trend (m/h) over the trailing window. */
function gaugeState(readings, nowMs, windowHours) {
  const rs = (readings ?? [])
    .map((r) => ({ t: toMillis(r.at), level: Number(r.levelM) }))
    .filter((r) => r.t <= nowMs && Number.isFinite(r.level))
    .sort((a, b) => a.t - b.t);
  if (!rs.length) return null;

  const latest = rs[rs.length - 1];
  const w = rs.filter((r) => r.t >= latest.t - windowHours * 3600000);
  let trend = 0;
  if (w.length >= 2) {
    const xs = w.map((r) => (r.t - w[0].t) / 3600000);
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
    const my = w.reduce((s, r) => s + r.level, 0) / w.length;
    const num = xs.reduce((s, x, i) => s + (x - mx) * (w[i].level - my), 0);
    const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    trend = den === 0 ? 0 : num / den;
  }
  return { levelM: latest.level, at: toIso(latest.t), trendMPerHour: round(trend, 3) };
}

/**
 * @param {object} incident  summary from cluster.summarize (location, needs, uniqueSenders, lastReportedAt, waterReported)
 * @param {object} context   { gauges: [{id, lat, lon, warningLevelM, dangerLevelM, readings: [{at, levelM}]}],
 *                             rainfall: [{areaId, lat, lon, at, mmLast3h}], now }
 * @returns {{ status, conflict, stale, flooded, reasons: string[], signals: object }}
 */
function assessEvidence(incident, { gauges = [], rainfall = [], now = Date.now() } = {}, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const nowMs = toMillis(now);
  const reasons = [];
  const signals = {
    gauge: null,
    rainfall: null,
    waterSignal: 'none',
    minutesSinceLastReport: Math.round(minutesBetween(incident.lastReportedAt, nowMs)),
  };

  if (incident.location) {
    const g = nearest(gauges, incident.location, opts.maxGaugeKm);
    const state = g && gaugeState(g.item.readings, nowMs, opts.trendWindowHours);
    if (state) {
      signals.gauge = {
        id: g.item.id,
        distanceKm: round(g.d / 1000, 2),
        warningLevelM: g.item.warningLevelM,
        dangerLevelM: g.item.dangerLevelM,
        ...state,
      };
    }
    const rain = nearest(rainfall, incident.location, opts.maxRainKm);
    if (rain) {
      signals.rainfall = { areaId: rain.item.areaId, distanceKm: round(rain.d / 1000, 2), mmLast3h: rain.item.mmLast3h, at: rain.item.at };
    }
  }

  const g = signals.gauge;
  const rainMm = signals.rainfall?.mmLast3h;
  if (g || rainMm != null) {
    const high =
      (g && (g.levelM >= g.warningLevelM || g.trendMPerHour >= opts.risingTrendMPerHour)) ||
      (rainMm != null && rainMm >= opts.heavyRainMm3h);
    const low =
      (!g || (g.levelM <= g.warningLevelM - opts.normalMarginM && g.trendMPerHour <= 0)) &&
      (rainMm == null || rainMm < opts.lightRainMm3h);
    signals.waterSignal = high ? 'high' : low ? 'low' : 'neutral';
  }

  if (g) {
    const rel = g.levelM >= g.warningLevelM ? 'above' : 'below';
    reasons.push(`gauge ${g.id} (${g.distanceKm} km) at ${g.levelM} m, ${rel} warning ${g.warningLevelM} m, trend ${g.trendMPerHour} m/h`);
  }
  if (rainMm != null) reasons.push(`rainfall ${rainMm} mm in last 3h (${signals.rainfall.areaId})`);
  if (signals.waterSignal === 'none') reasons.push('no gauge or rainfall data nearby');

  const crowd = incident.uniqueSenders >= opts.crowdCorroboration;
  const floodDependent = incident.needs.includes('rescue');
  let status = 'unverified';
  let conflict = false;

  if (signals.waterSignal === 'high') {
    status = 'corroborated';
    reasons.push('sensor data supports flooding');
  } else if (signals.waterSignal === 'low' && floodDependent) {
    if (crowd) {
      status = 'corroborated';
      conflict = true;
      reasons.push(`sensors show normal water, but ${incident.uniqueSenders} independent reporters confirm; needs human review`);
    } else {
      status = 'contradicted';
      reasons.push('sensors show normal, non-rising water; flood rescue claim not supported');
    }
  } else if (crowd) {
    status = 'corroborated';
    reasons.push(`${incident.uniqueSenders} independent reporters`);
  }

  const age = signals.minutesSinceLastReport;
  const receding = signals.waterSignal === 'low' || (g != null && g.trendMPerHour < 0);
  const stale = age > opts.maxAgeMinutes || (age > opts.staleAfterMinutes && receding);
  if (stale) reasons.push(`last report ${age} min ago${receding ? ' and water receding' : ''}; may be outdated`);

  const flooded =
    signals.waterSignal === 'high' ||
    incident.waterReported === true ||
    (floodDependent && signals.waterSignal !== 'low');

  return { status, conflict, stale, flooded, reasons, signals };
}

module.exports = { DEFAULTS, assessEvidence, gaugeState };
