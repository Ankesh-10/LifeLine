'use strict';

// Resolve where a report is: a map pin wins; otherwise match the free-text
// location against the city gazetteer, tolerating one typo in long names
// ("Velacheri", "Pallikarnai"). Returns null when nothing matches, so the
// report goes to human review instead of being guessed.

const defaultGazetteer = require('../config/gazetteer.json');
const { isPoint } = require('./geo');

const MIN_FUZZY_LENGTH = 6;

// Pad with spaces so phrase matching respects word boundaries.
const normalize = (s) => ` ${String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** True when a and b differ by at most one insertion, deletion or substitution. */
function withinOneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * @returns {{ place, lat, lon, matched, fuzzy } | null}  exact matches beat fuzzy ones, longer names beat shorter
 */
function geocodeText(text, gazetteer = defaultGazetteer) {
  const haystack = normalize(text);
  if (!haystack.trim()) return null;
  const tokens = haystack.trim().split(' ');

  let best = null;
  for (const place of gazetteer.places) {
    for (const name of [place.name, ...(place.aliases ?? [])]) {
      const needle = normalize(name);
      const words = needle.trim().split(' ');
      const exact = haystack.includes(needle);
      const fuzzy =
        !exact &&
        words.length === 1 &&
        words[0].length >= MIN_FUZZY_LENGTH &&
        tokens.some((t) => t.length >= MIN_FUZZY_LENGTH - 1 && withinOneEdit(t, words[0]));
      if (!exact && !fuzzy) continue;
      const rank = [exact ? 1 : 0, needle.length];
      if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) {
        best = { rank, result: { place: place.name, lat: place.lat, lon: place.lon, matched: name, fuzzy } };
      }
    }
  }
  return best ? best.result : null;
}

/**
 * @param {object} input  { pin: {lat, lon}?, locationText?, text? }; text is the raw message, used as a last resort
 * @returns {{ lat, lon, source: 'pin'|'gazetteer', place?, fuzzy? } | null}
 */
function resolveLocation({ pin, locationText, text } = {}, gazetteer = defaultGazetteer) {
  if (isPoint(pin)) return { lat: pin.lat, lon: pin.lon, source: 'pin' };
  const hit = geocodeText(locationText, gazetteer) ?? geocodeText(text, gazetteer);
  return hit ? { lat: hit.lat, lon: hit.lon, source: 'gazetteer', place: hit.place, fuzzy: hit.fuzzy } : null;
}

module.exports = { geocodeText, resolveLocation, withinOneEdit, normalize };
