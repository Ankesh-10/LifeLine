-- 004: incidents = deduplicated clusters of reports (see core/src/cluster.js).

CREATE TABLE incidents (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    need_type          need_type NOT NULL,           -- most severe need in the cluster
    needs              need_type[] NOT NULL,
    geom               geography(Point, 4326) NOT NULL, -- confidence-weighted centroid
    radius_m           integer NOT NULL DEFAULT 0,
    people             integer NOT NULL DEFAULT 0,
    vulnerable         text[] NOT NULL DEFAULT '{}',
    report_count       integer NOT NULL DEFAULT 0,
    unique_senders     integer NOT NULL DEFAULT 0,
    first_reported_at  timestamptz NOT NULL,
    last_reported_at   timestamptz NOT NULL,
    score              numeric(5, 2),
    score_breakdown    jsonb,                        -- per-factor contributions (core/src/score.js)
    evidence_status    evidence_status NOT NULL DEFAULT 'unverified',
    evidence           jsonb,                        -- reasons + sensor signals (core/src/fusion.js)
    stale              boolean NOT NULL DEFAULT false,
    status             incident_status NOT NULL DEFAULT 'new',
    simulated          boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX incidents_geom_idx   ON incidents USING gist (geom);
CREATE INDEX incidents_open_idx   ON incidents (status, score DESC)
    WHERE status NOT IN ('resolved', 'dismissed');

CREATE TRIGGER incidents_updated_at BEFORE UPDATE ON incidents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE reports
    ADD CONSTRAINT reports_incident_fk FOREIGN KEY (incident_id)
    REFERENCES incidents (id) ON DELETE SET NULL;
CREATE INDEX reports_incident_idx ON reports (incident_id);
