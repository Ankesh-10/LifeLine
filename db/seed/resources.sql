-- SIMULATED responders for the Chennai flood demo. Positions are approximate.
-- Re-running resets them to available at their home positions.

INSERT INTO resources (id, name, type, terrain, capacity, has_medic, speed_kmh, geom, contact_chat_id) VALUES
    ('B1', 'Boat 1 (Velachery)',       'boat',           'water', 10, false,  8, ST_MakePoint(80.2200, 12.9790)::geography, 'sim-B1'),
    ('B2', 'Boat 2 (Saidapet)',        'boat',           'water', 10, false,  8, ST_MakePoint(80.2230, 13.0230)::geography, 'sim-B2'),
    ('B3', 'Boat 3 (Tambaram)',        'boat',           'water', 10, false,  8, ST_MakePoint(80.1180, 12.9250)::geography, 'sim-B3'),
    ('B4', 'Boat 4 (Kotturpuram)',     'boat',           'water',  6, true,   8, ST_MakePoint(80.2420, 13.0180)::geography, 'sim-B4'),
    ('A1', 'Ambulance 1 (Guindy)',     'ambulance',      'road',   2, true,  30, ST_MakePoint(80.2206, 13.0067)::geography, 'sim-A1'),
    ('A2', 'Ambulance 2 (T. Nagar)',   'ambulance',      'road',   2, true,  30, ST_MakePoint(80.2341, 13.0418)::geography, 'sim-A2'),
    ('A3', 'Ambulance 3 (Adyar)',      'ambulance',      'road',   2, true,  30, ST_MakePoint(80.2565, 13.0012)::geography, 'sim-A3'),
    ('V1', 'Volunteers 1 (Madipakkam)', 'volunteer_team', 'road',  6, false, 20, ST_MakePoint(80.1961, 12.9647)::geography, 'sim-V1'),
    ('V2', 'Volunteers 2 (Perungudi)',  'volunteer_team', 'road',  6, false, 20, ST_MakePoint(80.2461, 12.9654)::geography, 'sim-V2'),
    ('V3', 'Volunteers 3 (Ashok Nagar)', 'volunteer_team', 'road', 6, false, 20, ST_MakePoint(80.2121, 13.0350)::geography, 'sim-V3')
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, type = EXCLUDED.type, terrain = EXCLUDED.terrain,
    capacity = EXCLUDED.capacity, has_medic = EXCLUDED.has_medic,
    speed_kmh = EXCLUDED.speed_kmh, geom = EXCLUDED.geom,
    contact_chat_id = EXCLUDED.contact_chat_id, status = 'available';
