-- SIMULATED relief shelters for the Chennai flood demo. Positions are approximate.

INSERT INTO shelters (id, name, geom, capacity, occupancy, has_medical) VALUES
    ('S1', 'Velachery Corporation School',   ST_MakePoint(80.2170, 12.9760)::geography, 300, 0, true),
    ('S2', 'Saidapet Govt Higher Sec School', ST_MakePoint(80.2250, 13.0200)::geography, 250, 0, false),
    ('S3', 'Tambaram Community Hall',         ST_MakePoint(80.1200, 12.9230)::geography, 200, 0, true),
    ('S4', 'Adyar Marriage Hall',             ST_MakePoint(80.2550, 13.0050)::geography, 150, 0, false)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, geom = EXCLUDED.geom, capacity = EXCLUDED.capacity,
    has_medical = EXCLUDED.has_medical, occupancy = 0;
