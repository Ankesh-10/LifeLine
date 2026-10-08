'use strict';

// lifeline-core public API. n8n Code nodes: const core = require('lifeline-core');

const geo = require('./geo');
const time = require('./time');
const geocode = require('./geocode');
const cluster = require('./cluster');
const fusion = require('./fusion');
const score = require('./score');
const match = require('./match');
const lifecycle = require('./lifecycle');
const policy = require('./policy');
const llm = require('./llm');
const ingest = require('./ingest');
const messages = require('./messages');
const pipeline = require('./pipeline');

module.exports = {
  geo,
  time,
  // Pipeline entry points, in order of use.
  resolveLocation: geocode.resolveLocation,
  assignReports: cluster.assignReports,
  summarize: cluster.summarize,
  assessEvidence: fusion.assessEvidence,
  scoreIncident: score.scoreIncident,
  rankIncidents: score.rankIncidents,
  matchResources: match.matchResources,
  decide: policy.decide,
  transitionIncident: lifecycle.transitionIncident,
  planReply: lifecycle.planReply,
  planRequesterConfirmation: lifecycle.planRequesterConfirmation,
  checkTimeouts: lifecycle.checkTimeouts,
  planReassignment: lifecycle.planReassignment,
  // Full modules for constants and helpers.
  geocode,
  cluster,
  fusion,
  score,
  match,
  lifecycle,
  policy,
  // n8n workflow steps: one function per Code node (see pipeline.js).
  llm,
  ingest,
  messages,
  pipeline,
};
