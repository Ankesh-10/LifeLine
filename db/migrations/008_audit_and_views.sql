-- 008: append-only audit trail + read views for the coordinator queue and the map.

CREATE TABLE audit_log (
    id           bigserial PRIMARY KEY,
    at           timestamptz NOT NULL DEFAULT now(),
    actor        actor_type NOT NULL,
    actor_id     text,                 -- workflow name, coordinator handle, resource id...
    action       text NOT NULL,        -- e.g. report.extracted, incident.scored, dispatch.approved
    entity_type  text NOT NULL,
    entity_id    text,
    payload      jsonb,                -- inputs and outputs of the decision
    reason       text                  -- human-readable why
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, at);
CREATE INDEX audit_log_at_idx     ON audit_log (at);

CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();

-- Live dispatch per incident (at most one is expected; newest wins).
CREATE VIEW v_live_dispatch AS
SELECT DISTINCT ON (d.incident_id)
       d.incident_id, d.id AS dispatch_id, d.resource_id, d.status AS dispatch_status,
       d.eta_minutes, d.sent_at, d.last_heartbeat_at
FROM dispatches d
WHERE d.status IN ('awaiting_approval', 'sent', 'acknowledged', 'en_route', 'on_scene')
ORDER BY d.incident_id, d.created_at DESC;

-- Coordinator work queue: open incidents, most urgent first.
CREATE VIEW v_incident_queue AS
SELECT i.id, i.status, i.need_type, i.needs, i.people, i.vulnerable,
       i.report_count, i.score, i.score_breakdown, i.evidence_status, i.stale,
       round(extract(epoch FROM now() - i.first_reported_at) / 60)::int AS waiting_minutes,
       ld.resource_id, ld.dispatch_status, ld.eta_minutes,
       i.simulated
FROM incidents i
LEFT JOIN v_live_dispatch ld ON ld.incident_id = i.id
WHERE i.status NOT IN ('resolved', 'dismissed')
ORDER BY i.score DESC NULLS LAST, i.first_reported_at;

-- Flat rows for a map client (Leaflet/Supabase). Includes resolved incidents for the story.
CREATE VIEW v_incident_map AS
SELECT i.id,
       ST_Y(i.geom::geometry) AS lat,
       ST_X(i.geom::geometry) AS lon,
       i.radius_m, i.status, i.need_type, i.people, i.score, i.evidence_status,
       i.report_count, ld.resource_id, r.type AS resource_type,
       ST_Y(r.geom::geometry) AS resource_lat,
       ST_X(r.geom::geometry) AS resource_lon,
       'SIMULATED'::text AS data_label
FROM incidents i
LEFT JOIN v_live_dispatch ld ON ld.incident_id = i.id
LEFT JOIN resources r ON r.id = ld.resource_id
WHERE i.status <> 'dismissed';
