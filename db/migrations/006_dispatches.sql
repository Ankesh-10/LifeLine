-- 006: dispatches (incident <-> resource assignments) and reported route blocks.

CREATE TABLE dispatches (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id             uuid NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
    resource_id             text NOT NULL REFERENCES resources (id),
    status                  dispatch_status NOT NULL,
    eta_minutes             numeric(6, 1),
    distance_km             numeric(7, 2),
    match                   jsonb,          -- reasons, alternatives, rejected options (core/src/match.js)
    approval_required       boolean NOT NULL DEFAULT false,
    approval_reasons        text[] NOT NULL DEFAULT '{}',
    approved_by             text,
    approved_at             timestamptz,
    sent_at                 timestamptz,
    last_heartbeat_at       timestamptz,    -- any responder message counts
    responder_confirmed_at  timestamptz,
    requester_confirmed_at  timestamptz,
    closed_at               timestamptz,
    close_reason            text,
    replaces_dispatch_id    uuid REFERENCES dispatches (id),
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

-- A resource can hold at most one live dispatch.
CREATE UNIQUE INDEX dispatches_one_live_per_resource ON dispatches (resource_id)
    WHERE status IN ('awaiting_approval', 'sent', 'acknowledged', 'en_route', 'on_scene');
CREATE INDEX dispatches_incident_idx ON dispatches (incident_id);
CREATE INDEX dispatches_live_idx ON dispatches (status, last_heartbeat_at)
    WHERE status IN ('sent', 'acknowledged', 'en_route', 'on_scene');

CREATE TRIGGER dispatches_updated_at BEFORE UPDATE ON dispatches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Blocked roads reported by responders; the matcher avoids routes through them.
CREATE TABLE route_blocks (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    geom         geography(Point, 4326) NOT NULL,
    radius_m     integer NOT NULL DEFAULT 300 CHECK (radius_m > 0),
    applies_to   terrain_mode NOT NULL DEFAULT 'road',
    reason       text,
    reported_by  text REFERENCES resources (id),
    dispatch_id  uuid REFERENCES dispatches (id),
    active       boolean NOT NULL DEFAULT true,
    reported_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX route_blocks_active_idx ON route_blocks USING gist (geom) WHERE active;
