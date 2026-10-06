'use strict';

// SIMULATED responder behaviour: which messages a responder sends after a dispatch.
// Messages carry an intentHint so the demo works without an LLM; with an LLM
// configured, n8n 05-replies classifies the text itself.

const { haversineMeters } = require('../../core/src/geo');
const gazetteer = require('../../core/config/gazetteer.json');

const BEHAVIORS = Object.freeze(['normal', 'blocked', 'silent']);

/** Nearest gazetteer locality to a point (the bot only knows coordinates). */
function nearestPlace(location, places = gazetteer.places) {
  let best = null;
  for (const p of places) {
    const d = haversineMeters(location, p);
    if (!best || d < best.d) best = { name: p.name, d };
  }
  return best?.name ?? null;
}

/**
 * Pick the behaviour for a dispatch and record it. A place script misbehaves
 * only `times` times, so the replacement team sent next behaves normally.
 */
function chooseBehavior({ place, resourceType }, placeScripts, history) {
  const script = placeScripts[place];
  if (!script) return 'normal';
  if (script.roadOnly && resourceType === 'boat') return 'normal';
  const used = history.get(place) ?? 0;
  if (used >= (script.times ?? 1)) return 'normal';
  history.set(place, used + 1);
  return script.behavior;
}

/** Ordered replies for one dispatch: [{ afterSec, role, text, intentHint }]. */
function planScript(behavior, { resourceId, place }, timing) {
  if (!BEHAVIORS.includes(behavior)) throw new RangeError(`unknown behavior ${behavior}`);
  const ack = { afterSec: timing.ack, role: 'responder', text: `${resourceId} copy, moving to ${place}.`, intentHint: 'ack' };
  if (behavior === 'silent') return [ack]; // then nothing: the watchdog must notice
  if (behavior === 'blocked') {
    return [
      ack,
      {
        afterSec: timing.blocked,
        role: 'responder',
        text: `Road to ${place} is blocked, fallen tree and deep water near the bridge. Cannot pass, need another route.`,
        intentHint: 'blocked',
      },
    ];
  }
  return [
    ack,
    { afterSec: timing.enRoute, role: 'responder', text: `${resourceId} on the way, ETA soon.`, intentHint: 'en_route' },
    { afterSec: timing.onScene, role: 'responder', text: `Reached ${place}, starting evacuation.`, intentHint: 'on_scene' },
    { afterSec: timing.resolved, role: 'responder', text: `All people moved to safety. ${resourceId} done here.`, intentHint: 'resolved' },
    { afterSec: timing.requesterConfirm, role: 'requester', text: 'Yes, the team reached us, we are safe now. Thank you.', intentHint: 'confirmed' },
  ];
}

module.exports = { BEHAVIORS, nearestPlace, chooseBehavior, planScript };
