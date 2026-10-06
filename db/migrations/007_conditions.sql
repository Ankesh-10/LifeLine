-- 007: environmental evidence: river gauges and rainfall (written by n8n 02-conditions).

CREATE TABLE gauges (
    id               text PRIMARY KEY,
    name             text NOT NULL,
    geom             geography(Point, 4326) NOT NULL,
    warning_level_m  numeric(6, 2) NOT NULL,
    danger_level_m   numeric(6, 2) NOT NULL,
    simulated        boolean NOT NULL DEFAULT true,
    CHECK (danger_level_m >= warning_level_m)
);

CREATE TABLE gauge_readings (
    gauge_id  text NOT NULL REFERENCES gauges (id) ON DELETE CASCADE,
    at        timestamptz NOT NULL,
    level_m   numeric(6, 2) NOT NULL,
    PRIMARY KEY (gauge_id, at)
);

-- Rainfall per area cell (the mock feed reports per locality centroid).
CREATE TABLE rainfall_readings (
    area_id      text NOT NULL,
    geom         geography(Point, 4326) NOT NULL,
    at           timestamptz NOT NULL,
    mm_last_3h   numeric(6, 1) NOT NULL CHECK (mm_last_3h >= 0),
    simulated    boolean NOT NULL DEFAULT true,
    PRIMARY KEY (area_id, at)
);

CREATE INDEX rainfall_geom_idx ON rainfall_readings USING gist (geom);
