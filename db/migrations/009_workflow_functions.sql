-- 009: workflow functions. Each n8n workflow reads its input with one
-- lifeline_*_input() call, lets lifeline-core compute a plan, and writes that
-- plan with one lifeline_apply_*() call. Every write and its audit_log row
-- share a transaction, so nothing changes without an audit entry.
-- Plans are JSON with camelCase keys, ISO-8601 times and {lat, lon} points.

ALTER TABLE reports
    ADD COLUMN review_reason text,          -- no_location (retried) | low_confidence | extraction_failed
    ADD COLUMN content_hash  text;          -- extraction cache key
ALTER TABLE incidents
    ADD COLUMN extraction_confidence numeric(3, 2) CHECK (extraction_confidence BETWEEN 0 AND 1),
    ADD COLUMN closed_at timestamptz;       -- when it was resolved or dismissed; late duplicates attach to it
ALTER TABLE dispatches
    ADD COLUMN approval_url   text,         -- n8n Wait-node resume URL
    ADD COLUMN approval_token text,         -- must match on resume; stops forged approvals
    ADD COLUMN escalated_at   timestamptz;  -- watchdog escalates once per dispatch

-- LLM extractions by message hash, so demo replays don't re-call a free-tier API.
CREATE TABLE extraction_cache (
    hash        text PRIMARY KEY,
    model       text,
    extracted   jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ helpers

CREATE FUNCTION lifeline_point(p jsonb) RETURNS geography
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN jsonb_typeof(p) = 'object' AND jsonb_typeof(p -> 'lat') = 'number' AND jsonb_typeof(p -> 'lon') = 'number'
        THEN ST_SetSRID(ST_MakePoint((p ->> 'lon')::float8, (p ->> 'lat')::float8), 4326)::geography
    END
$$;

CREATE FUNCTION lifeline_latlon(g geography) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN g IS NOT NULL THEN jsonb_build_object('lat', ST_Y(g::geometry), 'lon', ST_X(g::geometry)) END
$$;

CREATE FUNCTION lifeline_text_array(j jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN jsonb_typeof(j) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(j)) ELSE '{}'::text[] END
$$;

CREATE FUNCTION lifeline_uuid_array(j jsonb) RETURNS uuid[]
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN jsonb_typeof(j) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(j)::uuid) ELSE '{}'::uuid[] END
$$;

CREATE FUNCTION lifeline_audit(
    p_actor actor_type, p_actor_id text, p_action text,
    p_entity_type text, p_entity_id text, p_payload jsonb, p_reason text
) RETURNS void
LANGUAGE sql AS $$
    INSERT INTO audit_log (actor, actor_id, action, entity_type, entity_id, payload, reason)
    VALUES (p_actor, p_actor_id, p_action, p_entity_type, p_entity_id, p_payload, p_reason)
$$;

-- Generic audit entry from n8n: {actor, actorId, action, entityType, entityId, payload, reason}.
CREATE FUNCTION lifeline_log(e jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM lifeline_audit(COALESCE(e ->> 'actor', 'system')::actor_type, e ->> 'actorId', e ->> 'action',
                           COALESCE(e ->> 'entityType', 'system'), e ->> 'entityId', e -> 'payload', e ->> 'reason');
    RETURN jsonb_build_object('logged', true);
END;
$$;

CREATE FUNCTION lifeline_report_json(r reports) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'id', r.id, 'senderId', r.sender_id, 'sentAt', r.sent_at,
        'lat', ST_Y(r.geom::geometry), 'lon', ST_X(r.geom::geometry),
        'needType', r.need_type, 'people', r.people, 'vulnerable', to_jsonb(r.vulnerable),
        'confidence', r.confidence, 'inWater', (r.extracted ->> 'inWater')::boolean, 'status', r.status)
$$;

-- What 04 needs to message a responder (and the gate needs to ask the coordinator).
CREATE FUNCTION lifeline_dispatch_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'dispatchId', d.id, 'incidentId', d.incident_id, 'status', d.status,
        'resourceId', r.id, 'resourceName', r.name, 'resourceType', r.type, 'contactChatId', r.contact_chat_id,
        'etaMinutes', d.eta_minutes, 'approvalReasons', to_jsonb(d.approval_reasons),
        'incident', jsonb_build_object('needType', i.need_type, 'people', i.people, 'vulnerable', to_jsonb(i.vulnerable),
                                       'location', lifeline_latlon(i.geom), 'score', i.score, 'evidenceStatus', i.evidence_status),
        'simulated', i.simulated AND r.simulated)
    FROM dispatches d
    JOIN resources r ON r.id = d.resource_id
    JOIN incidents i ON i.id = d.incident_id
    WHERE d.id = p_id
$$;

-- Apply a core dispatchPatch; only keys present in the patch change.
CREATE FUNCTION lifeline_patch_dispatch(p_id uuid, p jsonb) RETURNS void
LANGUAGE sql AS $$
    UPDATE dispatches SET
        status                 = COALESCE((p ->> 'status')::dispatch_status, status),
        last_heartbeat_at      = CASE WHEN p ? 'lastHeartbeatAt'      THEN (p ->> 'lastHeartbeatAt')::timestamptz      ELSE last_heartbeat_at END,
        responder_confirmed_at = CASE WHEN p ? 'responderConfirmedAt' THEN (p ->> 'responderConfirmedAt')::timestamptz ELSE responder_confirmed_at END,
        requester_confirmed_at = CASE WHEN p ? 'requesterConfirmedAt' THEN (p ->> 'requesterConfirmedAt')::timestamptz ELSE requester_confirmed_at END,
        closed_at              = CASE WHEN p ? 'closedAt'             THEN (p ->> 'closedAt')::timestamptz             ELSE closed_at END,
        close_reason           = CASE WHEN p ? 'closeReason'          THEN p ->> 'closeReason'                         ELSE close_reason END,
        approved_by            = CASE WHEN p ? 'approvedBy'           THEN p ->> 'approvedBy'                          ELSE approved_by END,
        approved_at            = CASE WHEN p ? 'approvedAt'           THEN (p ->> 'approvedAt')::timestamptz           ELSE approved_at END,
        sent_at                = CASE WHEN p ? 'sentAt'               THEN (p ->> 'sentAt')::timestamptz               ELSE sent_at END
    WHERE id = p_id
$$;

-- Free a resource. After a completed job it is where the incident was.
CREATE FUNCTION lifeline_release_resource(p_resource_id text, p_dispatch_id uuid) RETURNS void
LANGUAGE sql AS $$
    UPDATE resources r SET
        status = 'available',
        geom = CASE WHEN d.status = 'completed' THEN i.geom ELSE r.geom END
    FROM dispatches d JOIN incidents i ON i.id = d.incident_id
    WHERE r.id = p_resource_id AND d.id = p_dispatch_id AND r.status = 'assigned'
$$;

-- ------------------------------------------------------------------ 01-ingest

CREATE FUNCTION lifeline_ingest_report(r jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO reports (source, external_id, sender_id, sent_at, raw_text, media_url, extracted, extraction_model,
                         need_type, people, vulnerable, location_text, geom, confidence, status, review_reason,
                         content_hash, simulated)
    VALUES ((r ->> 'source')::report_source, r ->> 'externalId', r ->> 'senderId', (r ->> 'sentAt')::timestamptz,
            r ->> 'rawText', r ->> 'mediaUrl', NULLIF(r -> 'extracted', 'null'::jsonb), r ->> 'extractionModel',
            (r ->> 'needType')::need_type, (r ->> 'people')::int, lifeline_text_array(r -> 'vulnerable'),
            r ->> 'locationText', lifeline_point(r -> 'location'), (r ->> 'confidence')::numeric,
            COALESCE(r ->> 'status', 'extracted')::report_status, r ->> 'reviewReason', r ->> 'contentHash',
            COALESCE((r ->> 'simulated')::boolean, true))
    ON CONFLICT (source, external_id) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        PERFORM lifeline_audit('agent', '01-ingest', 'report.duplicate', 'report', r ->> 'externalId',
                               jsonb_build_object('source', r ->> 'source'), 'message already received; ignored');
        RETURN jsonb_build_object('duplicate', true, 'externalId', r ->> 'externalId');
    END IF;

    IF jsonb_typeof(r -> 'cache') = 'object' THEN
        INSERT INTO extraction_cache (hash, model, extracted)
        VALUES (r -> 'cache' ->> 'hash', r -> 'cache' ->> 'model', r -> 'cache' -> 'extracted')
        ON CONFLICT (hash) DO UPDATE SET model = EXCLUDED.model, extracted = EXCLUDED.extracted, created_at = now();
    END IF;

    PERFORM lifeline_audit('agent', '01-ingest', 'report.received', 'report', v_id::text,
        jsonb_build_object('source', r ->> 'source', 'externalId', r ->> 'externalId',
                           'extractionSource', r -> 'extracted' ->> 'source', 'model', r ->> 'extractionModel',
                           'needType', r ->> 'needType', 'people', r -> 'people', 'confidence', r -> 'confidence',
                           'location', r -> 'extracted' -> 'location', 'status', r ->> 'status', 'error', r ->> 'error'),
        CASE WHEN r ->> 'status' = 'needs_review'
             THEN 'extraction failed, sent to coordinator: ' || COALESCE(r ->> 'error', 'unknown error')
             ELSE format('extracted (%s); location %s', COALESCE(r -> 'extracted' ->> 'source', '?'),
                         COALESCE(r -> 'extracted' -> 'location' ->> 'source', 'unresolved')) END);

    RETURN jsonb_build_object('duplicate', false, 'id', v_id, 'status', COALESCE(r ->> 'status', 'extracted'));
END;
$$;

-- ------------------------------------------------------------------ 02-conditions

-- The feed returns each gauge's recent history, so a poll replaces what we hold.
-- (The SIMULATED feed re-stamps readings relative to "now" on every poll.)
CREATE FUNCTION lifeline_apply_conditions(c jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    g jsonb;
    a jsonb;
    n_gauges int := 0;
    n_areas int := 0;
BEGIN
    FOR g IN SELECT * FROM jsonb_array_elements(COALESCE(c -> 'gauges', '[]')) LOOP
        INSERT INTO gauges (id, name, geom, warning_level_m, danger_level_m, simulated)
        VALUES (g ->> 'id', g ->> 'name', lifeline_point(g), (g ->> 'warningLevelM')::numeric,
                (g ->> 'dangerLevelM')::numeric, COALESCE((g ->> 'simulated')::boolean, true))
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, geom = EXCLUDED.geom,
            warning_level_m = EXCLUDED.warning_level_m, danger_level_m = EXCLUDED.danger_level_m,
            simulated = EXCLUDED.simulated;
        DELETE FROM gauge_readings WHERE gauge_id = g ->> 'id';
        INSERT INTO gauge_readings (gauge_id, at, level_m)
        SELECT g ->> 'id', (x ->> 'at')::timestamptz, (x ->> 'levelM')::numeric
        FROM jsonb_array_elements(COALESCE(g -> 'readings', '[]')) x
        ON CONFLICT DO NOTHING;
        n_gauges := n_gauges + 1;
    END LOOP;

    FOR a IN SELECT * FROM jsonb_array_elements(COALESCE(c -> 'rainfall', '[]')) LOOP
        DELETE FROM rainfall_readings WHERE area_id = a ->> 'areaId';
        INSERT INTO rainfall_readings (area_id, geom, at, mm_last_3h, simulated)
        VALUES (a ->> 'areaId', lifeline_point(a), (a ->> 'at')::timestamptz, (a ->> 'mmLast3h')::numeric,
                COALESCE((a ->> 'simulated')::boolean, true));
        n_areas := n_areas + 1;
    END LOOP;

    PERFORM lifeline_audit('system', '02-conditions', 'conditions.updated', 'conditions', NULL,
        jsonb_build_object('gauges', n_gauges, 'rainfallAreas', n_areas,
            'latest', (SELECT jsonb_object_agg(x ->> 'id', x -> 'readings' -> -1 -> 'levelM')
                       FROM jsonb_array_elements(COALESCE(c -> 'gauges', '[]')) x)),
        format('%s gauges, %s rainfall areas (SIMULATED feed)', n_gauges, n_areas));
    RETURN jsonb_build_object('gauges', n_gauges, 'rainfallAreas', n_areas);
END;
$$;

-- ------------------------------------------------------------------ 03-triage

CREATE FUNCTION lifeline_triage_input(p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'now', p_now,
        -- New reports, plus those held back only for a missing location (retried while recent).
        'reports', COALESCE((
            SELECT jsonb_agg(lifeline_report_json(r) ORDER BY r.sent_at, r.id)
            FROM reports r
            WHERE r.incident_id IS NULL AND r.sent_at <= p_now
              AND (r.status = 'extracted'
                   OR (r.status = 'needs_review' AND r.review_reason = 'no_location' AND r.sent_at > p_now - interval '3 hours'))
        ), '[]'::jsonb),
        'incidents', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', i.id, 'status', i.status, 'score', i.score, 'evidenceStatus', i.evidence_status,
                'stale', i.stale, 'flooded', COALESCE((i.evidence ->> 'flooded')::boolean, false),
                'reports', (SELECT COALESCE(jsonb_agg(lifeline_report_json(r) ORDER BY r.sent_at, r.id), '[]'::jsonb)
                            FROM reports r WHERE r.incident_id = i.id))
                ORDER BY i.created_at, i.id)
            FROM incidents i
            WHERE i.status NOT IN ('resolved', 'dismissed')
        ), '[]'::jsonb),
        -- Recently closed incidents: a late duplicate goes to a human, not to a new dispatch.
        'closedIncidents', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', i.id, 'status', i.status, 'location', lifeline_latlon(i.geom),
                'lastReportedAt', i.last_reported_at, 'closedAt', i.closed_at,
                'senderIds', (SELECT COALESCE(jsonb_agg(DISTINCT r.sender_id), '[]'::jsonb) FROM reports r
                              WHERE r.incident_id = i.id AND r.sender_id IS NOT NULL))
                ORDER BY i.closed_at DESC)
            FROM incidents i
            WHERE i.status IN ('resolved', 'dismissed') AND i.closed_at > p_now - interval '2 hours'
        ), '[]'::jsonb),
        'gauges', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', g.id, 'lat', ST_Y(g.geom::geometry), 'lon', ST_X(g.geom::geometry),
                'warningLevelM', g.warning_level_m, 'dangerLevelM', g.danger_level_m,
                'readings', (SELECT COALESCE(jsonb_agg(jsonb_build_object('at', gr.at, 'levelM', gr.level_m) ORDER BY gr.at), '[]'::jsonb)
                             FROM gauge_readings gr
                             WHERE gr.gauge_id = g.id AND gr.at <= p_now AND gr.at > p_now - interval '12 hours')))
            FROM gauges g
        ), '[]'::jsonb),
        'rainfall', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('areaId', x.area_id, 'lat', ST_Y(x.geom::geometry), 'lon', ST_X(x.geom::geometry),
                                                'at', x.at, 'mmLast3h', x.mm_last_3h))
            FROM (SELECT DISTINCT ON (area_id) * FROM rainfall_readings
                  WHERE at <= p_now AND at > p_now - interval '6 hours'
                  ORDER BY area_id, at DESC) x
        ), '[]'::jsonb))
$$;

CREATE FUNCTION lifeline_apply_triage(plan jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    c jsonb;
    s jsonb;
    v_id uuid;
    v_changed int;
    n_created int := 0;
    n_updated int := 0;
    n_rescored int := 0;
    n_reviewed int := 0;
BEGIN
    FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(plan -> 'created', '[]')) LOOP
        s := c -> 'summary';
        INSERT INTO incidents (need_type, needs, geom, radius_m, people, vulnerable, report_count, unique_senders,
                               first_reported_at, last_reported_at, score, score_breakdown, evidence_status, evidence,
                               stale, extraction_confidence, status)
        VALUES ((s ->> 'needType')::need_type, lifeline_text_array(s -> 'needs')::need_type[], lifeline_point(s -> 'location'),
                (s ->> 'radiusM')::int, (s ->> 'people')::int, lifeline_text_array(s -> 'vulnerable'),
                (s ->> 'reportCount')::int, (s ->> 'uniqueSenders')::int,
                (s ->> 'firstReportedAt')::timestamptz, (s ->> 'lastReportedAt')::timestamptz,
                (c -> 'score' ->> 'score')::numeric, c -> 'score', (c -> 'evidence' ->> 'status')::evidence_status, c -> 'evidence',
                COALESCE((c -> 'evidence' ->> 'stale')::boolean, false), (c ->> 'extractionConfidence')::numeric,
                COALESCE(c ->> 'status', 'triaged')::incident_status)
        RETURNING id INTO v_id;

        UPDATE reports SET incident_id = v_id, status = 'clustered', review_reason = NULL
        WHERE id = ANY (lifeline_uuid_array(c -> 'reportIds'));

        PERFORM lifeline_audit('agent', '03-triage', 'incident.created', 'incident', v_id::text,
            jsonb_build_object('reportIds', c -> 'reportIds', 'summary', s, 'score', c -> 'score',
                               'evidence', c -> 'evidence', 'extractionConfidence', c -> 'extractionConfidence'),
            format('%s report(s) -> %s for %s people; score %s; evidence %s',
                   s ->> 'reportCount', s ->> 'needType', s ->> 'people', c -> 'score' ->> 'score', c -> 'evidence' ->> 'status'));
        n_created := n_created + 1;
    END LOOP;

    FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(plan -> 'updated', '[]')) LOOP
        s := c -> 'summary';
        UPDATE incidents SET
            need_type = (s ->> 'needType')::need_type, needs = lifeline_text_array(s -> 'needs')::need_type[],
            geom = COALESCE(lifeline_point(s -> 'location'), geom), radius_m = (s ->> 'radiusM')::int,
            people = (s ->> 'people')::int, vulnerable = lifeline_text_array(s -> 'vulnerable'),
            report_count = (s ->> 'reportCount')::int, unique_senders = (s ->> 'uniqueSenders')::int,
            first_reported_at = (s ->> 'firstReportedAt')::timestamptz, last_reported_at = (s ->> 'lastReportedAt')::timestamptz,
            score = (c -> 'score' ->> 'score')::numeric, score_breakdown = c -> 'score',
            evidence_status = (c -> 'evidence' ->> 'status')::evidence_status, evidence = c -> 'evidence',
            stale = COALESCE((c -> 'evidence' ->> 'stale')::boolean, false),
            extraction_confidence = (c ->> 'extractionConfidence')::numeric
        WHERE id = (c ->> 'incidentId')::uuid;

        UPDATE reports SET incident_id = (c ->> 'incidentId')::uuid, status = 'clustered', review_reason = NULL
        WHERE id = ANY (lifeline_uuid_array(c -> 'addedReportIds'));

        PERFORM lifeline_audit('agent', '03-triage', 'incident.updated', 'incident', c ->> 'incidentId',
            jsonb_build_object('addedReportIds', c -> 'addedReportIds', 'summary', s, 'score', c -> 'score', 'evidence', c -> 'evidence'),
            format('%s new report(s); now %s reports; score %s',
                   jsonb_array_length(c -> 'addedReportIds'), s ->> 'reportCount', c -> 'score' ->> 'score'));
        n_updated := n_updated + 1;
    END LOOP;

    FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(plan -> 'rescored', '[]')) LOOP
        UPDATE incidents SET
            score = (c -> 'score' ->> 'score')::numeric, score_breakdown = c -> 'score',
            evidence_status = (c -> 'evidence' ->> 'status')::evidence_status, evidence = c -> 'evidence',
            stale = COALESCE((c -> 'evidence' ->> 'stale')::boolean, false)
        WHERE id = (c ->> 'incidentId')::uuid AND status NOT IN ('resolved', 'dismissed');
        GET DIAGNOSTICS v_changed = ROW_COUNT;
        IF v_changed > 0 THEN
            PERFORM lifeline_audit('agent', '03-triage', 'incident.rescored', 'incident', c ->> 'incidentId',
                jsonb_build_object('score', c -> 'score', 'evidence', c -> 'evidence', 'changes', c -> 'changes'),
                array_to_string(lifeline_text_array(c -> 'changes'), '; '));
            n_rescored := n_rescored + 1;
        END IF;
    END LOOP;

    FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(plan -> 'late', '[]')) LOOP
        UPDATE reports SET incident_id = (c ->> 'incidentId')::uuid, status = 'needs_review', review_reason = c ->> 'reviewReason'
        WHERE id = (c ->> 'reportId')::uuid AND incident_id IS NULL;
        GET DIAGNOSTICS v_changed = ROW_COUNT;
        IF v_changed > 0 THEN
            PERFORM lifeline_audit('agent', '03-triage', 'report.after_close', 'report', c ->> 'reportId',
                jsonb_build_object('incidentId', c ->> 'incidentId', 'reviewReason', c ->> 'reviewReason'), c ->> 'reason');
            n_reviewed := n_reviewed + 1;
        END IF;
    END LOOP;

    FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(plan -> 'reviews', '[]')) LOOP
        UPDATE reports SET status = 'needs_review', review_reason = c ->> 'reviewReason'
        WHERE id = (c ->> 'reportId')::uuid AND incident_id IS NULL
          AND (status <> 'needs_review' OR review_reason IS DISTINCT FROM c ->> 'reviewReason');
        GET DIAGNOSTICS v_changed = ROW_COUNT;
        IF v_changed > 0 THEN
            PERFORM lifeline_audit('agent', '03-triage', 'report.needs_review', 'report', c ->> 'reportId',
                jsonb_build_object('reviewReason', c ->> 'reviewReason'), c ->> 'reason');
            n_reviewed := n_reviewed + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'created', n_created, 'updated', n_updated, 'rescored', n_rescored, 'reviewed', n_reviewed,
        'needsDispatch', (SELECT count(*) FROM incidents i
                          WHERE i.status = 'triaged'
                            AND NOT EXISTS (SELECT 1 FROM v_live_dispatch ld WHERE ld.incident_id = i.id)));
END;
$$;

-- ------------------------------------------------------------------ 04-dispatch

CREATE FUNCTION lifeline_dispatch_input(p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'now', p_now,
        'incidents', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', i.id, 'status', i.status, 'score', i.score, 'needType', i.need_type, 'needs', to_jsonb(i.needs),
                'people', i.people, 'vulnerable', to_jsonb(i.vulnerable), 'location', lifeline_latlon(i.geom),
                'evidence', i.evidence, 'flooded', COALESCE((i.evidence ->> 'flooded')::boolean, false),
                'extractionConfidence', i.extraction_confidence,
                -- Resources that already failed or were turned down for this incident.
                'excludeResourceIds', (SELECT COALESCE(jsonb_agg(DISTINCT d.resource_id), '[]'::jsonb) FROM dispatches d
                                       WHERE d.incident_id = i.id AND d.status IN ('failed', 'reassigned', 'rejected')),
                -- A failed or silent dispatch makes the next one a reassignment.
                'replacesDispatchId', (SELECT d.id FROM dispatches d
                                       WHERE d.incident_id = i.id AND d.status IN ('failed', 'reassigned')
                                       ORDER BY d.created_at DESC LIMIT 1))
                ORDER BY i.score DESC NULLS LAST, i.first_reported_at)
            FROM incidents i
            WHERE i.status = 'triaged'
              AND NOT EXISTS (SELECT 1 FROM v_live_dispatch ld WHERE ld.incident_id = i.id)
        ), '[]'::jsonb),
        'resources', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', r.id, 'name', r.name, 'type', r.type, 'terrain', r.terrain, 'capacity', r.capacity,
                'hasMedic', r.has_medic, 'speedKmh', r.speed_kmh, 'status', r.status, 'location', lifeline_latlon(r.geom))
                ORDER BY r.id)
            FROM resources r
        ), '[]'::jsonb),
        'blocks', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('id', b.id, 'location', lifeline_latlon(b.geom), 'radiusM', b.radius_m,
                                                'appliesTo', b.applies_to, 'reason', b.reason))
            FROM route_blocks b WHERE b.active
        ), '[]'::jsonb))
$$;

CREATE FUNCTION lifeline_apply_dispatch(plan jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    d jsonb;
    v_id uuid;
    v_now timestamptz := COALESCE((plan ->> 'now')::timestamptz, now());
    v_incident_status incident_status;
    v_resource_status resource_status;
    v_auto boolean;
    v_out jsonb := '[]'::jsonb;
    n_skipped int := 0;
BEGIN
    FOR d IN SELECT * FROM jsonb_array_elements(COALESCE(plan -> 'dispatches', '[]')) LOOP
        -- Re-check under lock: another run may have taken the incident or the resource.
        SELECT status INTO v_incident_status FROM incidents WHERE id = (d ->> 'incidentId')::uuid FOR UPDATE;
        SELECT status INTO v_resource_status FROM resources WHERE id = d ->> 'resourceId' FOR UPDATE;
        IF v_incident_status IS DISTINCT FROM (d ->> 'fromIncidentStatus')::incident_status
           OR v_resource_status IS DISTINCT FROM 'available'
           OR EXISTS (SELECT 1 FROM v_live_dispatch ld WHERE ld.incident_id = (d ->> 'incidentId')::uuid) THEN
            PERFORM lifeline_audit('agent', '04-dispatch', 'dispatch.skipped', 'incident', d ->> 'incidentId',
                jsonb_build_object('resourceId', d ->> 'resourceId', 'incidentStatus', v_incident_status, 'resourceStatus', v_resource_status),
                'incident or resource changed since planning; will re-plan');
            n_skipped := n_skipped + 1;
            CONTINUE;
        END IF;

        v_auto := d ->> 'decision' = 'auto';
        INSERT INTO dispatches (incident_id, resource_id, status, eta_minutes, distance_km, match,
                                approval_required, approval_reasons, sent_at, replaces_dispatch_id)
        VALUES ((d ->> 'incidentId')::uuid, d ->> 'resourceId', (d ->> 'status')::dispatch_status,
                (d ->> 'etaMinutes')::numeric, (d ->> 'distanceKm')::numeric,
                (d -> 'match') || jsonb_build_object('action', d ->> 'action',
                    'policy', jsonb_build_object('decision', d ->> 'decision', 'reasons', d -> 'policyReasons')),
                NOT v_auto, CASE WHEN v_auto THEN '{}'::text[] ELSE lifeline_text_array(d -> 'policyReasons') END,
                CASE WHEN v_auto THEN v_now END, (d ->> 'replacesDispatchId')::uuid)
        RETURNING id INTO v_id;

        UPDATE resources SET status = 'assigned' WHERE id = d ->> 'resourceId';
        UPDATE incidents SET status = (d ->> 'incidentStatus')::incident_status WHERE id = (d ->> 'incidentId')::uuid;

        PERFORM lifeline_audit('agent', '04-dispatch',
            CASE WHEN v_auto THEN 'dispatch.sent' ELSE 'dispatch.approval_requested' END, 'dispatch', v_id::text,
            jsonb_build_object('incidentId', d ->> 'incidentId', 'resourceId', d ->> 'resourceId', 'action', d ->> 'action',
                               'etaMinutes', d -> 'etaMinutes', 'decision', d ->> 'decision', 'policyReasons', d -> 'policyReasons',
                               'matchReasons', d -> 'match' -> 'reasons', 'alternatives', d -> 'match' -> 'alternatives',
                               'rejected', d -> 'match' -> 'rejected', 'replacesDispatchId', d ->> 'replacesDispatchId'),
            format('%s %s -> incident; %s: %s', d ->> 'action', d ->> 'resourceId',
                   CASE WHEN v_auto THEN 'auto' ELSE 'needs approval' END,
                   array_to_string(lifeline_text_array(d -> 'policyReasons'), '; ')));

        v_out := v_out || jsonb_build_array(lifeline_dispatch_json(v_id)
                 || jsonb_build_object('approvalTimeoutMinutes', d -> 'approvalTimeoutMinutes', 'action', d ->> 'action'));
    END LOOP;

    RETURN jsonb_build_object('dispatches', v_out, 'skipped', n_skipped);
END;
$$;

-- ------------------------------------------------------------------ 04-approval-gate

-- Store the Wait-node resume URL and the token the decision link must carry.
CREATE FUNCTION lifeline_set_approval(a jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    v_changed int;
BEGIN
    UPDATE dispatches SET approval_url = a ->> 'url', approval_token = a ->> 'token'
    WHERE id = (a ->> 'dispatchId')::uuid AND status = 'awaiting_approval';
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed > 0 THEN
        PERFORM lifeline_audit('agent', '04-approval-gate', 'approval.requested', 'dispatch', a ->> 'dispatchId',
            jsonb_build_object('channel', a ->> 'channel', 'timeoutMinutes', a -> 'timeoutMinutes'),
            'waiting for coordinator: ' || COALESCE(a ->> 'reasons', 'policy'));
    END IF;
    RETURN jsonb_build_object('stored', v_changed > 0);
END;
$$;

CREATE FUNCTION lifeline_apply_approval(plan jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    v_id uuid := (plan ->> 'dispatchId')::uuid;
    v_status dispatch_status;
    a jsonb;
BEGIN
    SELECT status INTO v_status FROM dispatches WHERE id = v_id FOR UPDATE;
    IF v_status IS DISTINCT FROM (plan ->> 'expectedDispatchStatus')::dispatch_status THEN
        PERFORM lifeline_audit('system', '04-approval-gate', 'approval.stale', 'dispatch', v_id::text,
            jsonb_build_object('decision', plan ->> 'decision', 'status', v_status), 'dispatch already decided; ignored');
        RETURN jsonb_build_object('applied', false, 'decision', plan ->> 'decision');
    END IF;

    PERFORM lifeline_patch_dispatch(v_id, plan -> 'dispatchPatch');
    UPDATE incidents SET status = (plan ->> 'incidentStatus')::incident_status,
                         closed_at = CASE WHEN plan ->> 'incidentStatus' = 'dismissed' THEN (plan ->> 'now')::timestamptz END
    WHERE id = (plan ->> 'incidentId')::uuid AND status = (plan ->> 'fromIncidentStatus')::incident_status;
    FOR a IN SELECT * FROM jsonb_array_elements(COALESCE(plan -> 'actions', '[]')) LOOP
        IF a ->> 'type' = 'release_resource' THEN
            PERFORM lifeline_release_resource(a ->> 'resourceId', v_id);
        END IF;
    END LOOP;

    PERFORM lifeline_audit((plan ->> 'actor')::actor_type, plan ->> 'actorId', plan ->> 'auditAction', 'dispatch', v_id::text,
        jsonb_build_object('decision', plan ->> 'decision', 'incidentId', plan ->> 'incidentId',
                           'incidentStatus', plan ->> 'incidentStatus', 'dispatchPatch', plan -> 'dispatchPatch'),
        format('coordinator decision: %s', plan ->> 'decision'));

    RETURN jsonb_build_object('applied', true, 'decision', plan ->> 'decision', 'rematch', COALESCE((plan ->> 'rematch')::boolean, false),
                              'notifyResponder', COALESCE((plan ->> 'notifyResponder')::boolean, false),
                              'dispatch', lifeline_dispatch_json(v_id));
END;
$$;

-- ------------------------------------------------------------------ 05-replies

CREATE FUNCTION lifeline_reply_context(reply jsonb) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'reply', reply,
        'dispatch', (SELECT jsonb_build_object(
                        'id', d.id, 'incidentId', d.incident_id, 'resourceId', d.resource_id, 'status', d.status,
                        'sentAt', d.sent_at, 'lastHeartbeatAt', d.last_heartbeat_at,
                        'responderConfirmedAt', d.responder_confirmed_at, 'requesterConfirmedAt', d.requester_confirmed_at)
                     FROM dispatches d WHERE d.id::text = reply ->> 'dispatchId'),
        'incident', (SELECT jsonb_build_object('id', i.id, 'status', i.status, 'location', lifeline_latlon(i.geom))
                     FROM dispatches d JOIN incidents i ON i.id = d.incident_id WHERE d.id::text = reply ->> 'dispatchId'),
        'resource', (SELECT jsonb_build_object('id', r.id, 'type', r.type, 'location', lifeline_latlon(r.geom))
                     FROM dispatches d JOIN resources r ON r.id = d.resource_id WHERE d.id::text = reply ->> 'dispatchId'))
$$;

CREATE FUNCTION lifeline_apply_reply(plan jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    v_id uuid;
    v_status dispatch_status;
    v_actor actor_type := CASE WHEN plan ->> 'role' = 'requester' THEN 'requester' ELSE 'responder' END;
    v_actor_id text := CASE WHEN plan ->> 'role' = 'requester' THEN 'requester' ELSE plan ->> 'resourceId' END;
    a jsonb;
BEGIN
    IF plan ->> 'dispatchId' IS NULL OR plan -> 'actions' -> 0 ->> 'type' = 'ignore' THEN
        PERFORM lifeline_audit(v_actor, v_actor_id, 'reply.ignored', 'dispatch', plan ->> 'dispatchId',
            jsonb_build_object('text', plan ->> 'text', 'intent', plan ->> 'intent'), plan -> 'actions' -> 0 ->> 'reason');
        RETURN jsonb_build_object('applied', false, 'rematch', false, 'notices', '[]'::jsonb);
    END IF;

    v_id := (plan ->> 'dispatchId')::uuid;
    SELECT status INTO v_status FROM dispatches WHERE id = v_id FOR UPDATE;
    IF v_status IS DISTINCT FROM (plan ->> 'expectedDispatchStatus')::dispatch_status THEN
        PERFORM lifeline_audit(v_actor, v_actor_id, 'reply.stale', 'dispatch', v_id::text,
            jsonb_build_object('text', plan ->> 'text', 'intent', plan ->> 'intent', 'status', v_status),
            'dispatch changed while the reply was processed; ignored');
        RETURN jsonb_build_object('applied', false, 'rematch', false, 'notices', '[]'::jsonb);
    END IF;

    PERFORM lifeline_patch_dispatch(v_id, plan -> 'dispatchPatch');
    IF plan ->> 'incidentStatus' IS NOT NULL THEN
        UPDATE incidents SET status = (plan ->> 'incidentStatus')::incident_status,
                             closed_at = CASE WHEN plan ->> 'incidentStatus' = 'resolved' THEN (plan ->> 'now')::timestamptz END
        WHERE id = (plan ->> 'incidentId')::uuid AND status = (plan ->> 'fromIncidentStatus')::incident_status;
    END IF;

    FOR a IN SELECT * FROM jsonb_array_elements(COALESCE(plan -> 'actions', '[]')) LOOP
        CASE a ->> 'type'
            WHEN 'add_route_block' THEN
                INSERT INTO route_blocks (geom, radius_m, applies_to, reason, reported_by, dispatch_id)
                VALUES (lifeline_point(a -> 'location'), COALESCE((a ->> 'radiusM')::int, 300),
                        COALESCE(a ->> 'appliesTo', 'road')::terrain_mode, a ->> 'reason', a ->> 'reportedBy', v_id);
                PERFORM lifeline_audit(v_actor, v_actor_id, 'route_block.added', 'dispatch', v_id::text, a,
                                       'road reported blocked; matcher will avoid it');
            WHEN 'release_resource' THEN
                PERFORM lifeline_release_resource(a ->> 'resourceId', v_id);
            ELSE
                NULL; -- rematch: the incident is back in 'triaged' and 04 picks it up; notices are sent by n8n
        END CASE;
    END LOOP;

    PERFORM lifeline_audit(v_actor, v_actor_id, 'reply.' || COALESCE(plan ->> 'intent', 'unclear'), 'dispatch', v_id::text,
        jsonb_build_object('text', plan ->> 'text', 'intent', plan ->> 'intent', 'intentSource', plan ->> 'intentSource',
                           'dispatchPatch', plan -> 'dispatchPatch', 'incidentStatus', plan ->> 'incidentStatus',
                           'actions', plan -> 'actions'),
        format('%s reply classified as %s', plan ->> 'role', plan ->> 'intent'));

    IF plan ->> 'incidentStatus' = 'resolved' THEN
        PERFORM lifeline_audit('system', '05-replies', 'incident.resolved', 'incident', plan ->> 'incidentId',
            jsonb_build_object('dispatchId', v_id), 'help confirmed by both the responder and the requester');
    END IF;

    RETURN jsonb_build_object('applied', true, 'rematch', COALESCE((plan ->> 'rematch')::boolean, false),
                              'incidentStatus', plan ->> 'incidentStatus', 'notices', COALESCE(plan -> 'notices', '[]'::jsonb));
END;
$$;

-- ------------------------------------------------------------------ 06-watchdog

CREATE FUNCTION lifeline_watchdog_input(p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'now', p_now,
        'dispatches', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', d.id, 'incidentId', d.incident_id, 'incidentStatus', i.status, 'resourceId', d.resource_id,
                'status', d.status, 'sentAt', d.sent_at, 'lastHeartbeatAt', d.last_heartbeat_at,
                'responderConfirmedAt', d.responder_confirmed_at, 'requesterConfirmedAt', d.requester_confirmed_at,
                'escalatedAt', d.escalated_at)
                ORDER BY d.sent_at)
            FROM dispatches d JOIN incidents i ON i.id = d.incident_id
            WHERE d.status IN ('sent', 'acknowledged', 'en_route', 'on_scene') AND d.sent_at IS NOT NULL
        ), '[]'::jsonb))
$$;

CREATE FUNCTION lifeline_apply_watchdog(plan jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    r jsonb;
    v_id uuid;
    v_status dispatch_status;
    v_changed int;
    n_reassigned int := 0;
    n_escalated int := 0;
BEGIN
    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(plan -> 'reassignments', '[]')) LOOP
        v_id := (r ->> 'dispatchId')::uuid;
        SELECT status INTO v_status FROM dispatches WHERE id = v_id FOR UPDATE;
        CONTINUE WHEN v_status IS DISTINCT FROM (r ->> 'expectedDispatchStatus')::dispatch_status;

        PERFORM lifeline_patch_dispatch(v_id, r -> 'dispatchPatch');
        UPDATE resources SET status = COALESCE((r -> 'resourcePatch' ->> 'status')::resource_status, status)
        WHERE id = r ->> 'resourceId';
        IF r ->> 'incidentStatus' IS NOT NULL THEN
            UPDATE incidents SET status = (r ->> 'incidentStatus')::incident_status
            WHERE id = (r ->> 'incidentId')::uuid AND status = (r ->> 'fromIncidentStatus')::incident_status;
        END IF;
        PERFORM lifeline_audit('system', '06-watchdog', 'dispatch.reassigned', 'dispatch', v_id::text,
            jsonb_build_object('incidentId', r ->> 'incidentId', 'resourceId', r ->> 'resourceId', 'reason', r ->> 'reason',
                               'minutes', r -> 'minutes', 'resourcePatch', r -> 'resourcePatch'),
            format('%s: no word from %s for %s min; marked offline, incident re-planned', r ->> 'reason', r ->> 'resourceId', r ->> 'minutes'));
        n_reassigned := n_reassigned + 1;
    END LOOP;

    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(plan -> 'escalations', '[]')) LOOP
        UPDATE dispatches SET escalated_at = (plan ->> 'now')::timestamptz
        WHERE id = (r ->> 'dispatchId')::uuid AND escalated_at IS NULL;
        GET DIAGNOSTICS v_changed = ROW_COUNT;
        IF v_changed > 0 THEN
            PERFORM lifeline_audit('system', '06-watchdog', 'dispatch.escalated', 'dispatch', r ->> 'dispatchId',
                jsonb_build_object('incidentId', r ->> 'incidentId', 'reason', r ->> 'reason', 'minutes', r -> 'minutes'),
                format('%s for %s min; coordinator alerted', r ->> 'reason', r ->> 'minutes'));
            n_escalated := n_escalated + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('reassigned', n_reassigned, 'escalated', n_escalated);
END;
$$;

-- ------------------------------------------------------------------ coordinator views

-- Pending approvals with ready-to-click links: the fallback when Telegram is not set up.
CREATE VIEW v_approval_queue AS
SELECT d.id AS dispatch_id, d.incident_id, d.resource_id, d.approval_reasons, d.eta_minutes,
       d.created_at AS requested_at, i.score, i.need_type, i.people, i.evidence_status,
       d.approval_url || '?decision=approve&token=' || d.approval_token AS approve_link,
       d.approval_url || '?decision=reject&token='  || d.approval_token AS reject_link,
       d.approval_url || '?decision=dismiss&token=' || d.approval_token AS dismiss_link,
       'SIMULATED'::text AS data_label
FROM dispatches d
JOIN incidents i ON i.id = d.incident_id
WHERE d.status = 'awaiting_approval'
ORDER BY i.score DESC NULLS LAST, d.created_at;

-- Reports a human must look at: low confidence, failed extraction, still no location,
-- or arriving after their incident was resolved or dismissed (incident_id shows which).
CREATE VIEW v_review_queue AS
SELECT r.id, r.received_at, r.source, r.review_reason, r.raw_text, r.need_type, r.people, r.confidence,
       r.location_text, r.incident_id, i.status AS incident_status, 'SIMULATED'::text AS data_label
FROM reports r
LEFT JOIN incidents i ON i.id = r.incident_id
WHERE r.status = 'needs_review'
ORDER BY r.received_at;
