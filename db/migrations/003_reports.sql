-- 003: raw citizen reports plus what the LLM extracted from them.

CREATE TABLE reports (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source           report_source NOT NULL,
    external_id      text NOT NULL,               -- platform message id; blocks exact re-delivery
    sender_id        text,                        -- hashed/opaque sender handle
    sent_at          timestamptz NOT NULL,
    received_at      timestamptz NOT NULL DEFAULT now(),
    raw_text         text,
    media_url        text,
    extracted        jsonb,                       -- full validated LLM output
    extraction_model text,
    need_type        need_type,
    people           integer CHECK (people >= 0),
    vulnerable       text[] NOT NULL DEFAULT '{}', -- elderly | child | disabled | pregnant | injured
    location_text    text,
    geom             geography(Point, 4326),
    confidence       numeric(3, 2) CHECK (confidence BETWEEN 0 AND 1),
    status           report_status NOT NULL DEFAULT 'received',
    incident_id      uuid,                        -- FK added in 004
    simulated        boolean NOT NULL DEFAULT true,
    UNIQUE (source, external_id)
);

CREATE INDEX reports_geom_idx     ON reports USING gist (geom);
CREATE INDEX reports_sent_at_idx  ON reports (sent_at);
CREATE INDEX reports_status_idx   ON reports (status);
CREATE INDEX reports_sender_idx   ON reports (sender_id);
