-- 002: domain enums. Scope is frozen: 3 need types, 3 resource types.

CREATE TYPE need_type       AS ENUM ('rescue', 'medical', 'supplies');
CREATE TYPE resource_type   AS ENUM ('boat', 'ambulance', 'volunteer_team');
CREATE TYPE terrain_mode    AS ENUM ('water', 'road');
CREATE TYPE resource_status AS ENUM ('available', 'assigned', 'offline');

CREATE TYPE report_source   AS ENUM ('telegram', 'whatsapp', 'replay', 'manual');
-- needs_review = low-confidence extraction or no location; goes to the coordinator queue.
CREATE TYPE report_status   AS ENUM ('received', 'extracted', 'clustered', 'needs_review', 'discarded');

CREATE TYPE incident_status AS ENUM (
    'new', 'triaged', 'awaiting_approval', 'dispatched',
    'en_route', 'on_scene', 'resolved', 'dismissed'
);
CREATE TYPE evidence_status AS ENUM ('corroborated', 'unverified', 'contradicted');

CREATE TYPE dispatch_status AS ENUM (
    'awaiting_approval', 'rejected', 'sent', 'acknowledged', 'en_route',
    'on_scene', 'completed', 'failed', 'reassigned', 'cancelled'
);

CREATE TYPE actor_type      AS ENUM ('agent', 'coordinator', 'system', 'responder', 'requester');
