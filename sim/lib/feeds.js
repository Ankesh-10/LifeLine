'use strict';

// SIMULATED sensor feed snapshots. Readings are stamped relative to "now" so
// trends stay in true metres per hour even when the replay is sped up:
// a reading at scenario offset o, seen at scenario minute s, is stamped now - (s - o) minutes.

const iso = (ms) => new Date(ms).toISOString();

/** Scenario minutes elapsed since startMs at the given speed. */
function simMinutesAt(nowMs, { startMs, speed = 20 }) {
  return ((nowMs - startMs) / 60000) * speed;
}

function snapshot(conditions, { simMinutes, nowMs }) {
  const stamp = (offsetMin) => iso(nowMs - (simMinutes - offsetMin) * 60000);
  const gauges = conditions.gauges.map((g) => ({
    id: g.id,
    name: g.name,
    lat: g.lat,
    lon: g.lon,
    warningLevelM: g.warningLevelM,
    dangerLevelM: g.dangerLevelM,
    simulated: true,
    readings: g.series.filter((p) => p.offsetMin <= simMinutes).map((p) => ({ at: stamp(p.offsetMin), levelM: p.levelM })),
  }));
  const rainfall = conditions.rainfall
    .map((a) => {
      const seen = a.series.filter((p) => p.offsetMin <= simMinutes);
      const latest = seen[seen.length - 1];
      return latest && { areaId: a.areaId, name: a.name, lat: a.lat, lon: a.lon, at: stamp(latest.offsetMin), mmLast3h: latest.mmLast3h, simulated: true };
    })
    .filter(Boolean);
  return { gauges, rainfall };
}

module.exports = { simMinutesAt, snapshot };
