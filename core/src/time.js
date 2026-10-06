'use strict';

/** Accepts Date, epoch millis or an ISO-8601 string; returns epoch millis. */
function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new TypeError(`Invalid timestamp: ${value}`);
  return ms;
}

function toIso(value) {
  return new Date(toMillis(value)).toISOString();
}

function minutesBetween(from, to) {
  return (toMillis(to) - toMillis(from)) / 60000;
}

module.exports = { toMillis, toIso, minutesBetween };
