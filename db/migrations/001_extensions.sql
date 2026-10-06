-- 001: extensions and shared helpers.

CREATE EXTENSION IF NOT EXISTS postgis;

-- Keeps updated_at current on any table that attaches this trigger.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
