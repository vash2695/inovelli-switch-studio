(function () {
    const OFFICIAL_OTA_GUIDE_URL = 'https://www.zigbee2mqtt.io/information/ota_updates.html';

    const LIVE_FIELDS = [
        'available',
        'downgrade',
        'installed_version',
        'latest_version',
        'state',
        'progress',
        'remaining',
        'last_checked',
        'last_error',
        'bridge_status',
        'observed_at',
        'observed_source',
        'updated_at',
    ];

    const REFERENCE_FIELDS = [
        'installed_version_detail',
        'latest_version_detail',
        'official_versions',
        'fetched_at',
        'last_attempt_at',
        'retry_at',
        'next_retry_at',
        'sources',
        'refreshing',
        'partial',
    ];

    function hasOwn(source, key) {
        return !!source && Object.prototype.hasOwnProperty.call(source, key);
    }

    function copyIfPresent(target, source, sourceKey, targetKey) {
        if (!hasOwn(source, sourceKey)) return;
        target[targetKey || sourceKey] = source[sourceKey];
    }

    function copyFields(target, source, fields) {
        fields.forEach((key) => copyIfPresent(target, source, key));
    }

    function cloneObject(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        return { ...value };
    }

    function unwrapEnvelope(payload) {
        if (!payload || typeof payload !== 'object') return null;
        if (
            payload.payload &&
            typeof payload.payload === 'object' &&
            !Array.isArray(payload.payload) &&
            !hasOwn(payload, 'live') &&
            !hasOwn(payload, 'reference') &&
            !hasOwn(payload, 'management')
        ) {
            return {
                outer: payload,
                body: payload.payload,
                topic: payload.topic || payload.payload.topic || null,
            };
        }
        return { outer: payload, body: payload, topic: payload.topic || null };
    }

    function normalizeLive(payload, options) {
        if (!payload || typeof payload !== 'object') return null;
        const opts = options || {};
        const devicePayload = opts.devicePayload === true;
        const next = {};

        copyFields(next, payload, LIVE_FIELDS.filter((key) => !['state', 'progress', 'remaining'].includes(key)));
        copyIfPresent(next, payload, 'update_available', 'available');
        copyIfPresent(next, payload, 'updateAvailable', 'available');

        // A raw device payload's top-level state is load power, not OTA state.
        if (!devicePayload) {
            copyIfPresent(next, payload, 'state');
            copyIfPresent(next, payload, 'progress');
            copyIfPresent(next, payload, 'remaining');
        }

        if (payload.update && typeof payload.update === 'object' && !Array.isArray(payload.update)) {
            const update = payload.update;
            copyIfPresent(next, update, 'available');
            copyIfPresent(next, update, 'update_available', 'available');
            copyIfPresent(next, update, 'updateAvailable', 'available');
            copyIfPresent(next, update, 'downgrade');
            copyIfPresent(next, update, 'installed_version');
            copyIfPresent(next, update, 'installedVersion', 'installed_version');
            copyIfPresent(next, update, 'latest_version');
            copyIfPresent(next, update, 'latestVersion', 'latest_version');
            if (hasOwn(update, 'state')) copyIfPresent(next, update, 'state');
            else copyIfPresent(next, update, 'status', 'state');
            if (!hasOwn(next, 'available') && hasOwn(next, 'state')) {
                const lifecycle = String(next.state || '').trim().toLowerCase();
                if (lifecycle === 'available') next.available = true;
                else if (lifecycle === 'idle' || lifecycle === 'up_to_date') next.available = false;
            }
            copyIfPresent(next, update, 'progress');
            copyIfPresent(next, update, 'remaining');
            copyIfPresent(next, update, 'last_checked');
            copyIfPresent(next, update, 'observed_at');
            if (hasOwn(update, 'error')) copyIfPresent(next, update, 'error', 'last_error');
            else copyIfPresent(next, update, 'message', 'last_error');
        }

        return Object.keys(next).length > 0 ? next : null;
    }

    function normalizeReference(payload) {
        if (!payload || typeof payload !== 'object') return null;
        const next = {};
        copyFields(next, payload, REFERENCE_FIELDS);
        copyIfPresent(next, payload, 'current_versions', 'official_versions');
        copyIfPresent(next, payload, 'reference_status', 'status');
        copyIfPresent(next, payload, 'status');
        copyIfPresent(next, payload, 'reference_stale', 'stale');
        copyIfPresent(next, payload, 'stale');
        copyIfPresent(next, payload, 'reference_error', 'error');
        copyIfPresent(next, payload, 'error');
        return Object.keys(next).length > 0 ? next : null;
    }

    function normalizeManagement(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
        const next = {};
        ['owner', 'mode', 'read_only', 'local_actions', 'message'].forEach((key) => copyIfPresent(next, payload, key));
        return Object.keys(next).length > 0 ? next : null;
    }

    function normalizeRevision(value) {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return null;
            if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
                const numeric = Number(trimmed);
                if (Number.isFinite(numeric)) return numeric;
            }
            return trimmed;
        }
        return null;
    }

    function getRevision(section, body, outer, kind, options) {
        const opts = options || {};
        const sectionKey = kind === 'live' ? 'revision' : 'generation';
        const namedKey = kind === 'live' ? 'live_revision' : 'reference_generation';
        const candidates = [
            section && section[sectionKey],
            section && section[namedKey],
            body && body[namedKey],
            outer && outer[namedKey],
            opts[namedKey],
        ];
        for (const candidate of candidates) {
            const normalized = normalizeRevision(candidate);
            if (normalized !== null) return normalized;
        }
        return null;
    }

    function isOlder(incoming, current) {
        if (incoming === null || current === null) return false;
        if (typeof incoming === 'number' && typeof current === 'number') return incoming < current;
        // ISO timestamps and other lexically ordered generation tokens remain
        // comparable, while opaque unequal tokens are treated as new data.
        if (
            typeof incoming === 'string' &&
            typeof current === 'string' &&
            /^\d{4}-\d{2}-\d{2}T/.test(incoming) &&
            /^\d{4}-\d{2}-\d{2}T/.test(current)
        ) {
            return incoming < current;
        }
        return false;
    }

    function isSameRevision(incoming, current) {
        return incoming !== null && current !== null && incoming === current;
    }

    function isStrictlyNewer(incoming, current) {
        if (incoming === null) return false;
        if (current === null) return true;
        return !isOlder(incoming, current) && !isSameRevision(incoming, current);
    }

    function isCurrentOrNewer(incoming, current) {
        if (current === null) return true;
        return incoming !== null && !isOlder(incoming, current);
    }

    function createModel(topic) {
        return {
            schema_version: null,
            epoch: null,
            topic: topic || null,
            live_revision: null,
            reference_generation: null,
            detail_live_revision: null,
            detail_reference_generation: null,
            live: {},
            reference: {},
            management: {
                owner: 'zigbee2mqtt',
                mode: 'read_only',
                read_only: true,
                local_actions: false,
            },
        };
    }

    function merge(current, payload, options) {
        const envelope = unwrapEnvelope(payload);
        if (!envelope) return current || createModel();
        const opts = options || {};
        const body = envelope.body;
        const incomingTopic = envelope.topic || body.topic || null;
        const expectedTopic = opts.topic || null;
        const previous = current || createModel();
        const requestedTopic = expectedTopic || incomingTopic || null;
        const topicChanged = !!(previous.topic && requestedTopic && previous.topic !== requestedTopic);
        const incomingEpoch = hasOwn(body, 'epoch') ? String(body.epoch || '') : null;
        const epochChanged = !!(previous.epoch && incomingEpoch && previous.epoch !== incomingEpoch);
        // A same-topic snapshot can arrive after a newer live event. `reset`
        // therefore means snapshot semantics, not permission to discard the
        // revision counters used to reject stale work.
        const base = opts.clear === true || topicChanged || epochChanged
            ? createModel(requestedTopic)
            : previous;

        if (expectedTopic && incomingTopic && expectedTopic !== incomingTopic) return base;
        if (base.topic && incomingTopic && base.topic !== incomingTopic) return base;

        const next = {
            ...base,
            detail_live_revision: normalizeRevision(base.detail_live_revision),
            detail_reference_generation: normalizeRevision(base.detail_reference_generation),
            live: cloneObject(base.live),
            reference: cloneObject(base.reference),
            management: { ...createModel().management, ...cloneObject(base.management) },
        };
        if (incomingTopic) next.topic = incomingTopic;
        if (incomingEpoch) next.epoch = incomingEpoch;
        if (hasOwn(body, 'schema_version')) next.schema_version = body.schema_version;

        const structured = !!(
            body.live && typeof body.live === 'object' ||
            body.reference && typeof body.reference === 'object' ||
            body.management && typeof body.management === 'object'
        );
        const liveSource = structured ? body.live : body;
        const referenceSource = structured ? body.reference : body;
        const managementSource = structured ? body.management : null;
        const livePatch = normalizeLive(liveSource, opts);
        const referencePatch = normalizeReference(referenceSource);
        const liveRevision = getRevision(liveSource, body, envelope.outer, 'live', opts);
        const referenceGeneration = getRevision(referenceSource, body, envelope.outer, 'reference', opts);

        const acceptLive = liveRevision !== null
            ? isStrictlyNewer(liveRevision, next.live_revision)
            : next.live_revision === null;
        const acceptReference = referenceGeneration !== null
            ? isStrictlyNewer(referenceGeneration, next.reference_generation)
            : next.reference_generation === null;
        const hasVersionDetails = !!referencePatch && (
            hasOwn(referencePatch, 'installed_version_detail') ||
            hasOwn(referencePatch, 'latest_version_detail')
        );
        const acceptVersionDetails = hasVersionDetails
            && isCurrentOrNewer(liveRevision, next.live_revision)
            && isCurrentOrNewer(referenceGeneration, next.reference_generation)
            && isCurrentOrNewer(liveRevision, next.detail_live_revision)
            && isCurrentOrNewer(referenceGeneration, next.detail_reference_generation)
            && (
                isStrictlyNewer(liveRevision, next.detail_live_revision) ||
                isStrictlyNewer(referenceGeneration, next.detail_reference_generation)
            );
        if (livePatch && acceptLive) {
            next.live = { ...next.live, ...livePatch };
            if (liveRevision !== null) next.live_revision = liveRevision;
        }
        if (referencePatch) {
            const acceptedReferencePatch = acceptReference ? { ...referencePatch } : {};
            // These two fields are computed from a (live revision, reference
            // generation) pair. Keep their own accepted pair so a reference
            // event carrying stale live data cannot prevent a later equal-global
            // repair from converging, while older or equal/equal detail replays
            // remain rejected.
            delete acceptedReferencePatch.installed_version_detail;
            delete acceptedReferencePatch.latest_version_detail;
            if (acceptVersionDetails && hasOwn(referencePatch, 'installed_version_detail')) {
                acceptedReferencePatch.installed_version_detail = referencePatch.installed_version_detail;
            }
            if (acceptVersionDetails && hasOwn(referencePatch, 'latest_version_detail')) {
                acceptedReferencePatch.latest_version_detail = referencePatch.latest_version_detail;
            }
            if (Object.keys(acceptedReferencePatch).length > 0) {
                next.reference = { ...next.reference, ...acceptedReferencePatch };
            }
            if (acceptVersionDetails) {
                next.detail_live_revision = liveRevision;
                next.detail_reference_generation = referenceGeneration;
            }
            if (acceptReference && referenceGeneration !== null) next.reference_generation = referenceGeneration;
        }
        const managementPatch = normalizeManagement(managementSource);
        if (managementPatch) next.management = { ...next.management, ...managementPatch };
        return next;
    }

    // Compatibility helper for raw Zigbee2MQTT payloads and older backend
    // envelopes. New consumers should retain the structured model via merge().
    function normalize(payload, options) {
        const envelope = unwrapEnvelope(payload);
        if (!envelope) return null;
        const body = envelope.body;
        const structured = !!(
            body.live && typeof body.live === 'object' ||
            body.reference && typeof body.reference === 'object'
        );
        const live = normalizeLive(structured ? body.live : body, options) || {};
        const reference = normalizeReference(structured ? body.reference : body) || {};
        const next = { ...live, ...reference };
        return Object.keys(next).length > 0 ? next : null;
    }

    function getReferenceStatus(reference) {
        const source = reference && typeof reference === 'object' ? reference : {};
        const raw = String(source.status || '').trim().toLowerCase();
        if (source.refreshing === true) return 'refreshing';
        if (source.stale === true) return 'stale';
        if (source.partial === true) return 'partial';
        if (raw === 'fresh') return 'ready';
        if (raw === 'loading') return 'refreshing';
        if (['ready', 'refreshing', 'partial', 'stale', 'unavailable'].includes(raw)) return raw;
        if (source.error) return Object.keys(source.official_versions || {}).length ? 'partial' : 'unavailable';
        return Object.keys(source.official_versions || {}).length ? 'ready' : 'unavailable';
    }

    window.SwitchStudioFirmware = {
        OFFICIAL_OTA_GUIDE_URL,
        createModel,
        merge,
        normalize,
        getReferenceStatus,
    };
})();
