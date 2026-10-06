-- 005: responders (boats, ambulances, volunteer teams) and shelters.

CREATE TABLE resources (
    id               text PRIMARY KEY,               -- short call sign, e.g. B2, A1, V3
    name             text NOT NULL,
    type             resource_type NOT NULL,
    terrain          terrain_mode NOT NULL,          -- boats: water; ambulances/volunteers: road
    capacity         integer NOT NULL CHECK (capacity > 0),
    has_medic        boolean NOT NULL DEFAULT false,
    speed_kmh        numeric(5, 1) NOT NULL CHECK (speed_kmh > 0),
    geom             geography(Point, 4326) NOT NULL, -- last known position
    status           resource_status NOT NULL DEFAULT 'available',
    contact_chat_id  text,                           -- Telegram chat (simulated bot in demo)
    simulated        boolean NOT NULL DEFAULT true,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CHECK ((type = 'boat') = (terrain = 'water'))
);

CREATE INDEX resources_geom_idx ON resources USING gist (geom);

CREATE TRIGGER resources_updated_at BEFORE UPDATE ON resources
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE shelters (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    geom        geography(Point, 4326) NOT NULL,
    capacity    integer NOT NULL CHECK (capacity > 0),
    occupancy   integer NOT NULL DEFAULT 0 CHECK (occupancy >= 0),
    has_medical boolean NOT NULL DEFAULT false,
    simulated   boolean NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (occupancy <= capacity)
);

CREATE TRIGGER shelters_updated_at BEFORE UPDATE ON shelters
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
