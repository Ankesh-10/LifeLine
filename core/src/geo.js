'use strict';

// Points are plain { lat, lon } objects in WGS84 degrees.

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

function isPoint(p) {
  return p != null && Number.isFinite(p.lat) && Number.isFinite(p.lon);
}

/** Great-circle distance in metres. */
function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Equirectangular projection to metres around an origin; accurate at city scale.
function project(p, origin) {
  return {
    x: toRad(p.lon - origin.lon) * Math.cos(toRad(origin.lat)) * EARTH_RADIUS_M,
    y: toRad(p.lat - origin.lat) * EARTH_RADIUS_M,
  };
}

/** Shortest distance in metres from point p to the straight segment a→b. */
function pointToSegmentMeters(p, a, b) {
  const P = project(p, a);
  const B = project(b, a);
  const len2 = B.x * B.x + B.y * B.y;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (P.x * B.x + P.y * B.y) / len2));
  return Math.hypot(P.x - t * B.x, P.y - t * B.y);
}

/** Weighted mean position. Falls back to equal weights if all weights are zero. */
function centroid(points, weights) {
  if (!points.length) throw new Error('centroid needs at least one point');
  let w = points.map((_, i) => (weights && Number.isFinite(weights[i]) ? Math.max(0, weights[i]) : 1));
  let total = w.reduce((s, x) => s + x, 0);
  if (total === 0) {
    w = points.map(() => 1);
    total = points.length;
  }
  return {
    lat: points.reduce((s, p, i) => s + p.lat * w[i], 0) / total,
    lon: points.reduce((s, p, i) => s + p.lon * w[i], 0) / total,
  };
}

function midpoint(a, b) {
  return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
}

/** Travel time in minutes for a straight-line distance, inflated by a detour factor. */
function travelMinutes(distanceMeters, speedKmh, detourFactor = 1) {
  if (!(speedKmh > 0)) throw new RangeError(`speedKmh must be > 0, got ${speedKmh}`);
  return ((distanceMeters * detourFactor) / 1000 / speedKmh) * 60;
}

module.exports = {
  EARTH_RADIUS_M,
  isPoint,
  haversineMeters,
  pointToSegmentMeters,
  centroid,
  midpoint,
  travelMinutes,
};
