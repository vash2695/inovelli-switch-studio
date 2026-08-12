(function () {
    const DEFAULT_LIMITS = {
        xMin: -900,
        xMax: 900,
        yMin: -200,
        yMax: 1400,
        zMin: -600,
        zMax: 600,
        minSpan: 20
    };

    const FOV_STYLES = Object.freeze({
        outer: Object.freeze({
            color: '#66768A',
            edgeColor: 'rgba(135, 153, 175, 0.12)',
            opacity3d: 0.03,
            fill2d: 'rgba(102, 118, 138, 0.02)',
            edgeWidth: 1,
            edgeDash: 'dot'
        }),
        nominal: Object.freeze({
            color: '#8FA1B8',
            edgeColor: 'rgba(165, 181, 201, 0.18)',
            opacity3d: 0.06,
            fill2d: 'rgba(143, 161, 184, 0.04)',
            edgeWidth: 1.3,
            edgeDash: 'solid'
        })
    });

    const ZONE_DRAFT_FIELDS = Object.freeze([
        'x_min',
        'x_max',
        'y_min',
        'y_max',
        'z_min',
        'z_max'
    ]);

    const ZONE_MAINTENANCE_ACTIONS = Object.freeze({
        1: Object.freeze({ label: 'Auto-Config Interference', destructive: false }),
        3: Object.freeze({ label: 'Clear Interference', destructive: true }),
        4: Object.freeze({ label: 'Reset Detection Zones', destructive: true }),
        5: Object.freeze({ label: 'Clear Stay Zones', destructive: true })
    });

    let chartEl = null;
    let dataTableBodyEl = null;
    let zoneStatusEl = null;
    let commandLogEl = null;
    let stateApi = null;
    let updateTimestampFn = null;
    let getLayoutFn = null;
    let getIsEditingFn = null;
    let getIsInteractingFn = null;
    let shouldRenderTargetsFn = null;
    let shouldRender2dFn = null;
    let targetSnapshotListener = null;
    let limits = { ...DEFAULT_LIMITS };

    let targetHistory = {};
    let latestTargets = [];
    let historyLength = 15;
    let lastCommandId = null;
    let pendingCommandTimer = null;
    let pendingCommandTimeoutMs = 15000;
    let pendingCommandStateListener = null;
    let hideZoneStatusTimer = null;
    let targetsSuppressedByGate = false;

    function toRoundedInt(value, fallback) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.round(parsed);
    }

    function toFiniteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function enforceMinSpan(minVal, maxVal, boundMin, boundMax, minSpan) {
        if ((maxVal - minVal) >= minSpan) {
            return { minVal, maxVal };
        }

        let center = Math.round((minVal + maxVal) / 2);
        minVal = center - Math.floor(minSpan / 2);
        maxVal = minVal + minSpan;

        if (minVal < boundMin) {
            minVal = boundMin;
            maxVal = minVal + minSpan;
        }
        if (maxVal > boundMax) {
            maxVal = boundMax;
            minVal = maxVal - minSpan;
        }

        return { minVal, maxVal };
    }

    function sortPair(a, b) {
        const low = Math.min(a, b);
        const high = Math.max(a, b);
        return [low, high];
    }

    function normalizeZoneConfig(rawConfig, options) {
        const opts = options || {};
        const clampToBounds = opts.clampToBounds !== false;
        const allowZeroSpan = opts.allowZeroSpan === true;

        let xMin = toRoundedInt(rawConfig?.x_min, 0);
        let xMax = toRoundedInt(rawConfig?.x_max, 0);
        let yMin = toRoundedInt(rawConfig?.y_min, 0);
        let yMax = toRoundedInt(rawConfig?.y_max, 0);
        let zMin = toRoundedInt(rawConfig?.z_min, 0);
        let zMax = toRoundedInt(rawConfig?.z_max, 0);

        [xMin, xMax] = sortPair(xMin, xMax);
        [yMin, yMax] = sortPair(yMin, yMax);
        [zMin, zMax] = sortPair(zMin, zMax);

        if (clampToBounds) {
            xMin = clamp(xMin, limits.xMin, limits.xMax);
            xMax = clamp(xMax, limits.xMin, limits.xMax);
            yMin = clamp(yMin, limits.yMin, limits.yMax);
            yMax = clamp(yMax, limits.yMin, limits.yMax);
            zMin = clamp(zMin, limits.zMin, limits.zMax);
            zMax = clamp(zMax, limits.zMin, limits.zMax);
            [xMin, xMax] = sortPair(xMin, xMax);
            [yMin, yMax] = sortPair(yMin, yMax);
            [zMin, zMax] = sortPair(zMin, zMax);
        }

        if (!allowZeroSpan) {
            ({ minVal: xMin, maxVal: xMax } = enforceMinSpan(xMin, xMax, limits.xMin, limits.xMax, limits.minSpan));
            ({ minVal: yMin, maxVal: yMax } = enforceMinSpan(yMin, yMax, limits.yMin, limits.yMax, limits.minSpan));
            ({ minVal: zMin, maxVal: zMax } = enforceMinSpan(zMin, zMax, limits.zMin, limits.zMax, limits.minSpan));
        }

        return {
            x_min: xMin,
            x_max: xMax,
            y_min: yMin,
            y_max: yMax,
            z_min: zMin,
            z_max: zMax
        };
    }

    function validateZoneConfig(rawConfig, options) {
        const opts = options || {};
        const allowZeroSpan = opts.allowZeroSpan === true;
        const normalized = normalizeZoneConfig(rawConfig, {
            allowZeroSpan: allowZeroSpan,
            clampToBounds: true
        });
        const errors = [];

        const width = normalized.x_max - normalized.x_min;
        const depth = normalized.y_max - normalized.y_min;
        const height = normalized.z_max - normalized.z_min;

        if (!allowZeroSpan) {
            if (width < limits.minSpan) errors.push(`Width span must be at least ${limits.minSpan} cm.`);
            if (depth < limits.minSpan) errors.push(`Depth span must be at least ${limits.minSpan} cm.`);
            if (height < limits.minSpan) errors.push(`Height span must be at least ${limits.minSpan} cm.`);
        }

        if (normalized.x_min < limits.xMin || normalized.x_max > limits.xMax) {
            errors.push(`Width must stay within ${limits.xMin} to ${limits.xMax} cm.`);
        }
        if (normalized.y_min < limits.yMin || normalized.y_max > limits.yMax) {
            errors.push(`Depth must stay within ${limits.yMin} to ${limits.yMax} cm.`);
        }
        if (normalized.z_min < limits.zMin || normalized.z_max > limits.zMax) {
            errors.push(`Height must stay within ${limits.zMin} to ${limits.zMax} cm.`);
        }

        return {
            valid: errors.length === 0,
            errors: errors,
            normalized: normalized
        };
    }

    function buildAreaPayload(areaKey, zoneConfig) {
        const normalized = normalizeZoneConfig(zoneConfig, { allowZeroSpan: false, clampToBounds: true });
        const payload = {};
        payload[areaKey] = {
            width_min: normalized.x_min,
            width_max: normalized.x_max,
            depth_min: normalized.y_min,
            depth_max: normalized.y_max,
            height_min: normalized.z_min,
            height_max: normalized.z_max
        };
        return payload;
    }

    function cloneZoneDraft(draft) {
        if (!draft || typeof draft !== 'object') return null;
        const clone = {};
        ZONE_DRAFT_FIELDS.forEach((field) => {
            clone[field] = draft[field];
        });
        return Object.freeze(clone);
    }

    function createZoneWriteTracker() {
        const pendingByRequest = new Map();
        const latestRequestByKey = new Map();
        const retryableByKey = new Map();
        let sequence = 0;

        function makeKey(topic, target) {
            return `${String(topic || '').trim()}\u0000${String(target || '').trim()}`;
        }

        function copyRecord(record) {
            if (!record) return null;
            return {
                requestId: record.requestId,
                topic: record.topic,
                target: record.target,
                isDelete: record.isDelete,
                draft: record.draft ? { ...record.draft } : null,
                state: record.state,
                failureStatus: record.failureStatus || null,
                recoverable: record.recoverable === true
            };
        }

        function begin(options) {
            const opts = options || {};
            const requestId = String(opts.requestId || '').trim();
            const topic = String(opts.topic || '').trim();
            const target = String(opts.target || '').trim();
            const isDelete = opts.isDelete === true;
            const draft = isDelete ? null : cloneZoneDraft(opts.draft);
            if (!requestId || !topic || !target || (!isDelete && !draft)) return null;
            if (pendingByRequest.has(requestId)) return null;

            const key = makeKey(topic, target);
            const previousRequestId = latestRequestByKey.get(key);
            if (previousRequestId) pendingByRequest.delete(previousRequestId);

            const record = {
                requestId,
                topic,
                target,
                isDelete,
                draft,
                key,
                state: 'sending',
                failureStatus: null,
                recoverable: !isDelete,
                sequence: ++sequence
            };
            pendingByRequest.set(requestId, record);
            latestRequestByKey.set(key, requestId);
            retryableByKey.delete(key);
            return copyRecord(record);
        }

        function transition(result) {
            const update = result || {};
            const requestId = String(update.request_id || update.requestId || '').trim();
            const record = pendingByRequest.get(requestId);
            if (!record) return { handled: false, reason: 'unknown_request' };

            const resultTopic = String(update.topic || '').trim();
            if (resultTopic && resultTopic !== record.topic) {
                return { handled: false, reason: 'topic_mismatch' };
            }
            if (latestRequestByKey.get(record.key) !== requestId) {
                pendingByRequest.delete(requestId);
                return { handled: false, reason: 'stale_request' };
            }

            const status = String(update.status || '').trim().toLowerCase();
            if (status === 'sending' || status === 'sent') {
                record.state = status === 'sent' ? 'awaiting_device' : 'sending';
                return { handled: true, terminal: false, record: copyRecord(record) };
            }

            if (status === 'confirmed') {
                pendingByRequest.delete(requestId);
                latestRequestByKey.delete(record.key);
                retryableByKey.delete(record.key);
                record.state = 'confirmed';
                return { handled: true, terminal: true, confirmed: true, record: copyRecord(record) };
            }

            if (status === 'not_confirmed' || status === 'error' || status === 'disconnected') {
                pendingByRequest.delete(requestId);
                latestRequestByKey.delete(record.key);
                record.state = record.isDelete ? status : 'retryable';
                record.failureStatus = status;
                if (!record.isDelete && record.recoverable) retryableByKey.set(record.key, record);
                return {
                    handled: true,
                    terminal: true,
                    confirmed: false,
                    shouldRestore: !record.isDelete && record.recoverable,
                    record: copyRecord(record)
                };
            }

            return { handled: false, reason: 'unsupported_status' };
        }

        function failPending(status) {
            const failureStatus = status === 'error' ? 'error' : 'disconnected';
            return Array.from(pendingByRequest.keys())
                .map((requestId) => transition({ request_id: requestId, status: failureStatus }))
                .filter((result) => result.handled);
        }

        function getRetryable(topic, target) {
            const normalizedTopic = String(topic || '').trim();
            const normalizedTarget = String(target || '').trim();
            if (!normalizedTopic) return null;
            if (normalizedTarget) return copyRecord(retryableByKey.get(makeKey(normalizedTopic, normalizedTarget)));

            const matches = Array.from(retryableByKey.values())
                .filter((record) => record.topic === normalizedTopic)
                .sort((left, right) => right.sequence - left.sequence);
            return copyRecord(matches[0]);
        }

        function discardRetryable(topic, target) {
            const key = makeKey(topic, target);
            const removedRetry = retryableByKey.delete(key);
            const pendingRequestId = latestRequestByKey.get(key);
            const pendingRecord = pendingRequestId ? pendingByRequest.get(pendingRequestId) : null;
            if (pendingRecord && !pendingRecord.isDelete) pendingRecord.recoverable = false;
            return removedRetry || !!pendingRecord;
        }

        function hasPending(topic, target) {
            const key = makeKey(topic, target);
            const requestId = latestRequestByKey.get(key);
            return !!(requestId && pendingByRequest.has(requestId));
        }

        return Object.freeze({
            begin,
            transition,
            failPending,
            getRetryable,
            discardRetryable,
            hasPending
        });
    }

    function confirmZoneMaintenanceCommand(actionId, deviceName, confirmFn) {
        const definition = ZONE_MAINTENANCE_ACTIONS[Number(actionId)];
        if (!definition) return false;
        if (!definition.destructive) return true;
        if (typeof confirmFn !== 'function') return false;
        const safeDeviceName = String(deviceName || 'selected device').trim() || 'selected device';
        return confirmFn(`${definition.label} for ${safeDeviceName}? This changes saved sensor zones and cannot be undone from Switch Studio.`) === true;
    }

    function appendCommandLog(message, type) {
        if (!commandLogEl || !message) return;

        const empty = commandLogEl.querySelector('.command-log-empty');
        if (empty) empty.remove();

        const entry = document.createElement('div');
        const normalizedType = type || 'info';
        const now = new Date().toLocaleTimeString([], { hour12: false });
        entry.className = `command-log-entry log-${normalizedType}`;
        entry.innerText = `[${now}] ${message}`;
        commandLogEl.appendChild(entry);

        while (commandLogEl.children.length > 40) {
            commandLogEl.removeChild(commandLogEl.firstChild);
        }
        commandLogEl.scrollTop = commandLogEl.scrollHeight;
    }

    function setPacketStatus(mode, message) {
        if (stateApi && typeof stateApi.setPacketStatus === 'function') {
            stateApi.setPacketStatus(mode, message);
        }
    }

    function showToast(mode, message, timeoutMs) {
        if (stateApi && typeof stateApi.showToast === 'function') {
            stateApi.showToast(mode, message, timeoutMs);
        }
    }

    function showZoneStatus(message, type) {
        if (!zoneStatusEl) return;

        const backgroundMap = {
            saved: 'rgba(76, 175, 80, 0.9)',
            syncing: 'rgba(0, 188, 212, 0.92)',
            info: 'rgba(255, 152, 0, 0.95)',
            error: 'rgba(255, 82, 82, 0.95)'
        };
        zoneStatusEl.style.background = backgroundMap[type] || backgroundMap.info;
        zoneStatusEl.innerText = message;
        zoneStatusEl.style.display = 'block';

        if (hideZoneStatusTimer) clearTimeout(hideZoneStatusTimer);
        hideZoneStatusTimer = setTimeout(() => {
            zoneStatusEl.style.display = 'none';
        }, 5000);
    }

    function notifyPendingCommandState() {
        if (typeof pendingCommandStateListener === 'function') {
            pendingCommandStateListener(lastCommandId);
        }
    }

    function clearPendingCommand() {
        if (pendingCommandTimer) {
            clearTimeout(pendingCommandTimer);
            pendingCommandTimer = null;
        }
        const changed = lastCommandId !== null;
        lastCommandId = null;
        if (changed) notifyPendingCommandState();
    }

    function expirePendingCommand(actionId, label) {
        if (lastCommandId !== actionId) return;
        clearPendingCommand();
        const message = `${label} was not confirmed in time. Check the device state before retrying.`;
        appendCommandLog(message, 'error');
        setPacketStatus('error', message);
        showToast('error', message, 3200);
    }

    function setPendingCommand(actionId) {
        const parsedId = Number(actionId);
        if (!Number.isFinite(parsedId) || lastCommandId !== null) return false;
        lastCommandId = parsedId;

        const labelMap = {
            1: 'Auto-Config Interference',
            3: 'Clear Interference',
            4: 'Reset Detection Zones',
            5: 'Clear Stay Zones'
        };
        const statusMap = {
            1: 'Scanning for interference...',
            3: 'Clearing interference zones...',
            4: 'Resetting detection zones...',
            5: 'Clearing stay zones...'
        };
        const label = labelMap[parsedId] || `Command ${parsedId}`;
        const status = statusMap[parsedId] || `Sending ${label}...`;

        setPacketStatus('syncing', status);
        appendCommandLog(`Sent ${label}`, 'syncing');
        pendingCommandTimer = setTimeout(
            () => expirePendingCommand(parsedId, label),
            pendingCommandTimeoutMs
        );
        notifyPendingCommandState();
        return true;
    }

    function handleCommandResult(result) {
        if (!result || !result.action) return;
        if (result.action !== 'send_command') return;

        const payload = result.payload || {};
        const controlID = payload.controlID || 'unknown_command';
        const actionId = payload.action_id;

        if (result.status === 'sent') {
            appendCommandLog(`Accepted ${controlID} (${actionId})`, 'saved');
            showToast('saved', `Command queued: ${controlID}`, 1600);
            return;
        }

        if (result.status === 'error') {
            const message = result.message || 'Command failed';
            appendCommandLog(`Failed ${controlID}: ${message}`, 'error');
            setPacketStatus('error', `Error: ${message}`);
            showToast('error', message, 3000);
            clearPendingCommand();
        }
    }

    function handleInterferenceZones(zones) {
        if (lastCommandId === null) return;

        const zoneCount = Array.isArray(zones) ? zones.length : 0;
        let message = '';
        let type = 'info';

        if (lastCommandId === 1) {
            if (zoneCount === 0) {
                message = 'Scan complete: no active interference found.';
                type = 'saved';
            } else {
                message = `Auto-config complete. ${zoneCount} interference zone${zoneCount === 1 ? '' : 's'} now reported.`;
                type = 'info';
            }
        } else if (lastCommandId === 3) {
            if (zoneCount === 0) {
                message = 'Interference cleared: zones reset.';
                type = 'saved';
            } else {
                message = `Clear command finished but ${zoneCount} zone${zoneCount === 1 ? '' : 's'} still reported.`;
                type = 'error';
            }
        } else if (lastCommandId === 4) {
            message = 'Detection zone reset command completed.';
            type = 'saved';
        } else if (lastCommandId === 5) {
            message = 'Stay zone clear command completed.';
            type = 'saved';
        } else {
            message = 'Command completed.';
            type = 'info';
        }

        showZoneStatus(message, type);
        appendCommandLog(message, type);

        const packetMode = type === 'error' ? 'error' : (type === 'saved' ? 'saved' : 'info');
        setPacketStatus(packetMode, message);
        showToast(type === 'error' ? 'error' : packetMode, message, 2200);

        clearPendingCommand();
    }

    function getPendingCommandId() {
        return lastCommandId;
    }

    function getTargetTraceIndices() {
        const traceCount = chartEl && Array.isArray(chartEl.data) ? chartEl.data.length : 0;
        if (traceCount >= 2) return [traceCount - 2, traceCount - 1];
        return [0, 1];
    }

    function cloneTargetHistory() {
        const cloned = {};
        Object.entries(targetHistory).forEach(([id, points]) => {
            cloned[id] = Array.isArray(points)
                ? points.map((point) => ({ ...point }))
                : [];
        });
        return cloned;
    }

    function getTargetSnapshot(reason) {
        return {
            reason: reason || 'snapshot',
            targets: latestTargets.map((target) => ({ ...target })),
            history: cloneTargetHistory(),
        };
    }

    function emitTargetSnapshot(reason) {
        if (typeof targetSnapshotListener !== 'function') return;
        try {
            targetSnapshotListener(getTargetSnapshot(reason));
        } catch (err) {
            // A secondary visualization must never interrupt canonical 2D updates.
            if (typeof console !== 'undefined' && typeof console.warn === 'function') {
                console.warn('Target snapshot listener failed', err);
            }
        }
    }

    function setTargetSnapshotListener(listener, options) {
        targetSnapshotListener = typeof listener === 'function' ? listener : null;
        if (targetSnapshotListener && (!options || options.emitCurrent !== false)) {
            emitTargetSnapshot('subscribe');
        }
        const subscribed = targetSnapshotListener;
        return () => {
            if (targetSnapshotListener === subscribed) targetSnapshotListener = null;
        };
    }

    function resetHistory() {
        targetHistory = {};
        latestTargets = [];
        targetsSuppressedByGate = false;
        if (dataTableBodyEl) {
            dataTableBodyEl.innerHTML = '<tr><td colspan="5" class="no-data">No targets detected</td></tr>';
        }
        emitTargetSnapshot('reset');
    }

    function canRender2d() {
        if (!chartEl || !window.Plotly) return false;
        return typeof shouldRender2dFn !== 'function' || !!shouldRender2dFn();
    }

    function ignoreTransientRenderFailure(result) {
        if (result && typeof result.catch === 'function') result.catch(() => {});
    }

    function clearTargetVisualization(message) {
        targetHistory = {};
        latestTargets = [];
        const notice = message || 'No targets detected';

        if (canRender2d()) {
            try {
                const [targetTraceIndex, historyTraceIndex] = getTargetTraceIndices();
                ignoreTransientRenderFailure(
                    window.Plotly.restyle(chartEl, { x: [[]], y: [[]], text: [[]] }, [targetTraceIndex]),
                );
                ignoreTransientRenderFailure(
                    window.Plotly.restyle(chartEl, { x: [[]], y: [[]] }, [historyTraceIndex]),
                );
            } catch (err) {
                // Ignore render failures during transient chart states.
            }
        }

        if (dataTableBodyEl) {
            dataTableBodyEl.innerHTML = `<tr><td colspan="5" class="no-data">${notice}</td></tr>`;
        }
        emitTargetSnapshot('clear');
    }

    function normalizeTarget(target) {
        const parsedZ = toFiniteNumber(target?.z);
        const hasZ = typeof target?.hasZ === 'boolean'
            ? target.hasZ && parsedZ !== null
            : parsedZ !== null;
        return {
            id: toRoundedInt(target?.id, 0),
            x: toRoundedInt(target?.x, 0),
            y: toRoundedInt(target?.y, 0),
            z: hasZ ? Math.round(parsedZ) : 0,
            hasZ: hasZ,
            dop: toRoundedInt(target?.dop, 0)
        };
    }

    function getMotionLabelFromDoppler(doppler) {
        const dop = Number(doppler) || 0;
        if (dop > 10 || dop < -10) return 'Moving';
        return 'Stationary';
    }

    function getFriendlyTargetLabel(idValue) {
        const id = Number(idValue) || 0;
        return `Target ${id}`;
    }

    function normalizeHistoryPoint(point) {
        const parsedZ = toFiniteNumber(point?.z);
        const hasZ = typeof point?.hasZ === 'boolean'
            ? point.hasZ && parsedZ !== null
            : parsedZ !== null;
        return {
            x: toRoundedInt(point?.x, 0),
            y: toRoundedInt(point?.y, 0),
            z: hasZ ? Math.round(parsedZ) : 0,
            hasZ: hasZ,
        };
    }

    function mapRawZonesByAreaId(rawZones) {
        const mapped = { area1: null, area2: null, area3: null, area4: null };
        const zones = Array.isArray(rawZones) ? rawZones : [];
        zones.forEach((zone, compactIndex) => {
            if (!zone || typeof zone !== 'object') return;
            const declaredId = /^area[1-4]$/.test(String(zone.area_id || ''))
                ? String(zone.area_id)
                : null;
            const declaredIndex = Number(zone.area_index);
            const areaKey = declaredId || (
                Number.isInteger(declaredIndex) && declaredIndex >= 1 && declaredIndex <= 4
                    ? `area${declaredIndex}`
                    : `area${compactIndex + 1}`
            );
            if (Object.prototype.hasOwnProperty.call(mapped, areaKey)) mapped[areaKey] = zone;
        });
        return mapped;
    }

    function orderedHistoryEntries(history) {
        return Object.entries(history && typeof history === 'object' ? history : {})
            .sort(([left], [right]) => {
                const numericDifference = Number(left) - Number(right);
                if (Number.isFinite(numericDifference) && numericDifference !== 0) return numericDifference;
                return String(left).localeCompare(String(right));
            });
    }

    function buildTarget3DTraces(targets, history, options) {
        const opts = options || {};
        const normalizedTargets = Array.isArray(targets) ? targets.map(normalizeTarget) : [];
        const visible = opts.visible !== false;
        const showLabels = opts.showLabels !== false;
        const targetColor = opts.targetColor || '#1bd2dc';
        const trailColor = opts.trailColor || '#2e93bc';
        const missingZValue = toFiniteNumber(opts.missingZValue);

        const targetTrace = {
            type: 'scatter3d',
            mode: showLabels ? 'markers+text' : 'markers',
            x: normalizedTargets.map((target) => target.x),
            y: normalizedTargets.map((target) => target.y),
            z: normalizedTargets.map((target) => target.hasZ ? target.z : missingZValue),
            text: normalizedTargets.map((target) => getFriendlyTargetLabel(target.id)),
            textposition: 'top center',
            textfont: { color: '#bde8ef', size: 10, family: 'DM Sans, sans-serif' },
            customdata: normalizedTargets.map((target) => [
                getFriendlyTargetLabel(target.id),
                target.x,
                target.y,
                target.hasZ ? target.z : 'Unavailable',
                getMotionLabelFromDoppler(target.dop),
            ]),
            hovertemplate: '<b>%{customdata[0]}</b><br>X: %{customdata[1]} cm<br>Y: %{customdata[2]} cm<br>Z: %{customdata[3]} cm<br>%{customdata[4]}<extra></extra>',
            marker: {
                size: Number.isFinite(Number(opts.markerSize)) ? Number(opts.markerSize) : 5,
                color: targetColor,
                line: { color: opts.targetOutlineColor || '#dcfaff', width: 1.2 },
            },
            name: opts.targetName || 'Live targets',
            showlegend: false,
            visible: visible,
        };

        const trailX = [];
        const trailY = [];
        const trailZ = [];
        orderedHistoryEntries(history).forEach(([, rawPoints]) => {
            const points = Array.isArray(rawPoints) ? rawPoints.map(normalizeHistoryPoint) : [];
            points.forEach((point) => {
                trailX.push(point.x);
                trailY.push(point.y);
                trailZ.push(point.hasZ ? point.z : missingZValue);
            });
            if (points.length > 0) {
                trailX.push(null);
                trailY.push(null);
                trailZ.push(null);
            }
        });

        const trailTrace = {
            type: 'scatter3d',
            mode: 'lines',
            x: trailX,
            y: trailY,
            z: trailZ,
            line: {
                color: trailColor,
                width: Number.isFinite(Number(opts.trailWidth)) ? Number(opts.trailWidth) : 3,
            },
            opacity: Number.isFinite(Number(opts.trailOpacity)) ? Number(opts.trailOpacity) : 0.28,
            connectgaps: false,
            hoverinfo: 'skip',
            name: opts.trailName || 'Target trails',
            showlegend: false,
            visible: visible && opts.showTrails !== false,
        };

        return [targetTrace, trailTrace];
    }

    function readCoordinate(source, names) {
        for (const name of names) {
            const value = toFiniteNumber(source?.[name]);
            if (value !== null) return value;
        }
        return null;
    }

    function buildPrismGeometry(polygon, zMin, zMax) {
        if (!Array.isArray(polygon) || polygon.length < 3) return null;
        const sortedZ = sortPair(zMin, zMax);
        if (!Number.isFinite(sortedZ[0]) || !Number.isFinite(sortedZ[1]) || sortedZ[0] === sortedZ[1]) return null;

        const vertices = [];
        polygon.forEach((point) => vertices.push({ x: point.x, y: point.y, z: sortedZ[0] }));
        polygon.forEach((point) => vertices.push({ x: point.x, y: point.y, z: sortedZ[1] }));

        const count = polygon.length;
        const triangles = [];
        for (let index = 1; index < count - 1; index += 1) {
            triangles.push([0, index + 1, index]);
            triangles.push([count, count + index, count + index + 1]);
        }
        for (let index = 0; index < count; index += 1) {
            const next = (index + 1) % count;
            triangles.push([index, next, count + next]);
            triangles.push([index, count + next, count + index]);
        }

        const edges = [];
        for (let index = 0; index < count; index += 1) {
            const next = (index + 1) % count;
            edges.push([index, next]);
            edges.push([count + index, count + next]);
            edges.push([index, count + index]);
        }

        return {
            polygon: polygon.map((point) => ({ ...point })),
            vertices: vertices,
            triangles: triangles,
            edges: edges,
            x: vertices.map((vertex) => vertex.x),
            y: vertices.map((vertex) => vertex.y),
            z: vertices.map((vertex) => vertex.z),
            i: triangles.map((triangle) => triangle[0]),
            j: triangles.map((triangle) => triangle[1]),
            k: triangles.map((triangle) => triangle[2]),
            zMin: sortedZ[0],
            zMax: sortedZ[1],
        };
    }

    function buildEdgeCoordinates(geometry) {
        const x = [];
        const y = [];
        const z = [];
        geometry.edges.forEach(([startIndex, endIndex]) => {
            const start = geometry.vertices[startIndex];
            const end = geometry.vertices[endIndex];
            x.push(start.x, end.x, null);
            y.push(start.y, end.y, null);
            z.push(start.z, end.z, null);
        });
        return { x, y, z };
    }

    function buildVolumeEdgeTraces(geometry, options) {
        if (!geometry) return [];
        const opts = options || {};
        const visible = opts.visible !== false;
        const name = opts.name || 'Volume';
        const color = opts.color || '#0dd4c0';
        const edgeColor = opts.edgeColor || color;
        const edgeCoordinates = buildEdgeCoordinates(geometry);
        return [
            {
                type: 'mesh3d',
                x: geometry.x.slice(),
                y: geometry.y.slice(),
                z: geometry.z.slice(),
                i: geometry.i.slice(),
                j: geometry.j.slice(),
                k: geometry.k.slice(),
                color: color,
                opacity: Number.isFinite(Number(opts.opacity)) ? Number(opts.opacity) : 0.16,
                flatshading: true,
                hoverinfo: opts.hoverinfo || 'name',
                name: name,
                legendgroup: opts.legendgroup || name,
                showlegend: false,
                visible: visible,
            },
            {
                type: 'scatter3d',
                mode: 'lines',
                x: edgeCoordinates.x,
                y: edgeCoordinates.y,
                z: edgeCoordinates.z,
                line: {
                    color: edgeColor,
                    width: Number.isFinite(Number(opts.edgeWidth)) ? Number(opts.edgeWidth) : 2,
                    dash: opts.edgeDash || 'solid',
                },
                hoverinfo: 'skip',
                name: `${name} edges`,
                legendgroup: opts.legendgroup || name,
                showlegend: false,
                visible: visible && opts.showEdges !== false,
            },
        ];
    }

    function buildZoneCuboidGeometry(zone) {
        if (!zone || typeof zone !== 'object') return null;
        const rawXMin = readCoordinate(zone, ['x_min', 'width_min']);
        const rawXMax = readCoordinate(zone, ['x_max', 'width_max']);
        const rawYMin = readCoordinate(zone, ['y_min', 'depth_min']);
        const rawYMax = readCoordinate(zone, ['y_max', 'depth_max']);
        const rawZMin = readCoordinate(zone, ['z_min', 'height_min']);
        const rawZMax = readCoordinate(zone, ['z_max', 'height_max']);
        if ([rawXMin, rawXMax, rawYMin, rawYMax, rawZMin, rawZMax].some((value) => value === null)) return null;

        const [xMin, xMax] = sortPair(rawXMin, rawXMax);
        const [yMin, yMax] = sortPair(rawYMin, rawYMax);
        const [zMin, zMax] = sortPair(rawZMin, rawZMax);
        if (xMin === xMax || yMin === yMax || zMin === zMax) return null;

        const geometry = buildPrismGeometry([
            { x: xMin, y: yMin },
            { x: xMax, y: yMin },
            { x: xMax, y: yMax },
            { x: xMin, y: yMax },
        ], zMin, zMax);
        if (!geometry) return null;
        geometry.bounds = { xMin, xMax, yMin, yMax, zMin, zMax };
        return geometry;
    }

    function buildZoneCuboidTraces(zone, options) {
        return buildVolumeEdgeTraces(buildZoneCuboidGeometry(zone), options);
    }

    function appendDistinctPoint(points, point) {
        const prior = points[points.length - 1];
        if (prior && Math.abs(prior.x - point.x) < 1e-9 && Math.abs(prior.y - point.y) < 1e-9) return;
        points.push(point);
    }

    function getFovBoundaryPoint(options, direction) {
        const halfAngleDegrees = Number(options.halfAngleDegrees);
        const halfAngleRadians = (Math.PI / 180) * halfAngleDegrees;
        const tangent = Math.tan(halfAngleRadians);
        if (!Number.isFinite(tangent) || tangent <= 0) return { x: 0, y: 0 };

        const yCeiling = Math.max(0, Number(options.yMax));
        const isRight = direction >= 0;
        const xLimit = isRight ? Math.max(0, Number(options.xMax)) : Math.min(0, Number(options.xMin));
        const xAtTop = (isRight ? 1 : -1) * yCeiling * tangent;
        if ((isRight && xAtTop <= xLimit) || (!isRight && xAtTop >= xLimit)) {
            return { x: xAtTop, y: yCeiling };
        }
        return { x: xLimit, y: Math.min(yCeiling, Math.abs(xLimit) / tangent) };
    }

    function buildFovVolumeGeometry(options) {
        const opts = options || {};
        const halfAngleDegrees = toFiniteNumber(opts.halfAngleDegrees) ?? 60;
        if (halfAngleDegrees <= 0 || halfAngleDegrees >= 90) return null;
        const rawXMin = toFiniteNumber(opts.xMin) ?? -650;
        const rawXMax = toFiniteNumber(opts.xMax) ?? 650;
        const xMin = Math.min(rawXMin, rawXMax);
        const xMax = Math.max(rawXMin, rawXMax);
        const yMax = Math.min(600, Math.max(0, toFiniteNumber(opts.yMax) ?? 600));
        const rawZMin = toFiniteNumber(opts.zMin) ?? -300;
        const rawZMax = toFiniteNumber(opts.zMax) ?? 300;
        const [zMin, zMax] = sortPair(rawZMin, rawZMax);
        if (yMax <= 0 || zMin === zMax) return null;

        const boundaryOptions = { halfAngleDegrees, xMin, xMax, yMax };
        const right = getFovBoundaryPoint(boundaryOptions, 1);
        const left = getFovBoundaryPoint(boundaryOptions, -1);
        const rightTouchesTop = Math.abs(right.y - yMax) < 0.5;
        const leftTouchesTop = Math.abs(left.y - yMax) < 0.5;
        const polygon = [];
        appendDistinctPoint(polygon, { x: 0, y: 0 });
        appendDistinctPoint(polygon, right);
        if (!rightTouchesTop) appendDistinctPoint(polygon, { x: Math.max(0, xMax), y: yMax });
        if (!leftTouchesTop) appendDistinctPoint(polygon, { x: Math.min(0, xMin), y: yMax });
        appendDistinctPoint(polygon, left);
        if (polygon.length < 3) return null;

        const geometry = buildPrismGeometry(polygon, zMin, zMax);
        if (!geometry) return null;
        geometry.bounds = { xMin, xMax, yMin: 0, yMax, zMin, zMax };
        geometry.halfAngleDegrees = halfAngleDegrees;
        geometry.fullAngleDegrees = halfAngleDegrees * 2;
        return geometry;
    }

    function buildFov3DTraces(options) {
        const opts = options || {};
        const common = {
            xMin: opts.xMin,
            xMax: opts.xMax,
            yMax: opts.yMax,
            zMin: opts.zMin,
            zMax: opts.zMax,
        };
        const outerGeometry = buildFovVolumeGeometry({
            ...common,
            halfAngleDegrees: toFiniteNumber(opts.outerHalfAngleDegrees) ?? 75,
        });
        const innerGeometry = buildFovVolumeGeometry({
            ...common,
            halfAngleDegrees: toFiniteNumber(opts.innerHalfAngleDegrees) ?? 60,
        });
        const visible = opts.visible !== false;
        const outerTraces = buildVolumeEdgeTraces(outerGeometry, {
            name: opts.outerName || '150 degree field of view',
            color: opts.outerColor || FOV_STYLES.outer.color,
            edgeColor: opts.outerEdgeColor || FOV_STYLES.outer.edgeColor,
            opacity: toFiniteNumber(opts.outerOpacity) ?? FOV_STYLES.outer.opacity3d,
            edgeWidth: toFiniteNumber(opts.outerEdgeWidth) ?? FOV_STYLES.outer.edgeWidth,
            edgeDash: FOV_STYLES.outer.edgeDash,
            hoverinfo: 'skip',
            showEdges: false,
            visible: visible && opts.showOuter !== false,
        });
        const innerTraces = buildVolumeEdgeTraces(innerGeometry, {
            name: opts.innerName || '120 degree field of view',
            color: opts.innerColor || FOV_STYLES.nominal.color,
            edgeColor: opts.innerEdgeColor || FOV_STYLES.nominal.edgeColor,
            opacity: toFiniteNumber(opts.innerOpacity) ?? FOV_STYLES.nominal.opacity3d,
            edgeWidth: toFiniteNumber(opts.innerEdgeWidth) ?? FOV_STYLES.nominal.edgeWidth,
            hoverinfo: 'skip',
            showEdges: false,
            visible: visible && opts.showInner !== false,
        });
        return [...outerTraces, ...innerTraces];
    }

    function buildUnsupportedRange2DShapes(options) {
        const opts = options || {};
        const [xMin, xMax] = sortPair(
            toFiniteNumber(opts.xMin) ?? DEFAULT_LIMITS.xMin,
            toFiniteNumber(opts.xMax) ?? DEFAULT_LIMITS.xMax,
        );
        const [yMin, yMax] = sortPair(
            toFiniteNumber(opts.yMin) ?? DEFAULT_LIMITS.yMin,
            toFiniteNumber(opts.yMax) ?? DEFAULT_LIMITS.yMax,
        );
        const [supportedXMin, supportedXMax] = sortPair(
            toFiniteNumber(opts.supportedXMin) ?? -600,
            toFiniteNumber(opts.supportedXMax) ?? 600,
        );
        const [supportedYMin, supportedYMax] = sortPair(
            toFiniteNumber(opts.supportedYMin) ?? 0,
            toFiniteNumber(opts.supportedYMax) ?? 600,
        );
        const fillcolor = opts.fillcolor || 'rgba(120, 132, 148, 0.09)';
        const shapes = [];
        const pushRect = (x0, x1, y0, y1) => {
            if (!(x1 > x0 && y1 > y0)) return;
            shapes.push({
                type: 'rect',
                xref: 'x',
                yref: 'y',
                x0,
                x1,
                y0,
                y1,
                fillcolor,
                line: { color: 'rgba(0, 0, 0, 0)', width: 0 },
                editable: false,
                layer: 'below',
            });
        };

        // Keep the four masks disjoint so corners never become darker from
        // stacked transparency. Rear and far spans own the full chart width;
        // the lateral masks fill only the supported forward-depth interval.
        pushRect(xMin, xMax, yMin, Math.min(yMax, supportedYMin));
        pushRect(xMin, xMax, Math.max(yMin, supportedYMax), yMax);
        const forwardMin = Math.max(yMin, supportedYMin);
        const forwardMax = Math.min(yMax, supportedYMax);
        pushRect(xMin, Math.min(xMax, supportedXMin), forwardMin, forwardMax);
        pushRect(Math.max(xMin, supportedXMax), xMax, forwardMin, forwardMax);
        return shapes;
    }

    function getFovStyles() {
        return {
            outer: { ...FOV_STYLES.outer },
            nominal: { ...FOV_STYLES.nominal }
        };
    }

    function buildHistory2dCoordinates() {
        const x = [];
        const y = [];
        Object.values(targetHistory).forEach((points) => {
            points.forEach((point) => {
                x.push(point.x);
                y.push(point.y);
            });
            x.push(null);
            y.push(null);
        });
        return { x, y };
    }

    function renderTargetVisualization2d() {
        if (!canRender2d()) return false;

        const data = { targets: latestTargets.map((target) => ({ ...target })) };
        const history = buildHistory2dCoordinates();
        const sizes = data.targets.map((target) => Math.max(8, Math.min(40, 10 + (target.z / 5))));
        const isEditing = typeof getIsEditingFn === 'function' ? !!getIsEditingFn() : false;
        const isInteracting = typeof getIsInteractingFn === 'function' ? !!getIsInteractingFn() : false;

        if (isEditing) {
            if (isInteracting) return false;
            const [targetTraceIndex, historyTraceIndex] = getTargetTraceIndices();
            ignoreTransientRenderFailure(window.Plotly.restyle(chartEl, {
                x: [data.targets.map((target) => target.x), history.x],
                y: [data.targets.map((target) => target.y), history.y],
                text: [data.targets.map((target) => `${getFriendlyTargetLabel(target.id)}<br>${getMotionLabelFromDoppler(target.dop)}`), null],
                'marker.size': [sizes, null]
            }, [targetTraceIndex, historyTraceIndex]));
            return true;
        }

        const layout = typeof getLayoutFn === 'function' ? getLayoutFn() : undefined;
        ignoreTransientRenderFailure(window.Plotly.react(chartEl, [
            {
                x: data.targets.map((target) => target.x),
                y: data.targets.map((target) => target.y),
                text: data.targets.map((target) => `${getFriendlyTargetLabel(target.id)}<br>${getMotionLabelFromDoppler(target.dop)}`),
                mode: 'markers+text',
                textposition: 'top center',
                marker: { size: sizes, color: '#1bd2dc', line: { color: '#dcfaff', width: 1.2 } },
                textfont: { color: '#bde8ef', size: 10, family: 'DM Sans, sans-serif' },
                type: 'scatter'
            },
            { x: history.x, y: history.y, mode: 'lines', line: { color: '#2e93bc', width: 1.6 }, opacity: 0.2, type: 'scatter' }
        ], layout));
        return true;
    }

    function handleNewData(msg, currentTopic) {
        if (!msg || !msg.topic || !msg.payload) return false;
        if (!currentTopic || msg.topic !== currentTopic) return false;

        const shouldRenderTargets = typeof shouldRenderTargetsFn === 'function'
            ? !!shouldRenderTargetsFn()
            : true;
        if (!shouldRenderTargets) {
            if (!targetsSuppressedByGate) {
                clearTargetVisualization('No targets detected');
                setPacketStatus('info', 'No active occupancy');
            }
            targetsSuppressedByGate = true;
            return true;
        }
        targetsSuppressedByGate = false;

        const payload = msg.payload;
        const targets = Array.isArray(payload.targets) ? payload.targets.map(normalizeTarget) : [];
        const data = { targets: targets };
        latestTargets = data.targets.map((target) => ({ ...target }));

        if (typeof updateTimestampFn === 'function') {
            updateTimestampFn();
        }
        setPacketStatus('info', `Targets Visible: ${data.targets.length}`);

        const currentIds = new Set(data.targets.map((t) => t.id));
        Object.keys(targetHistory).forEach((id) => {
            if (!currentIds.has(Number(id))) delete targetHistory[id];
        });

        data.targets.forEach((target) => {
            if (!targetHistory[target.id]) targetHistory[target.id] = [];
            targetHistory[target.id].push({
                x: target.x,
                y: target.y,
                z: target.z,
                hasZ: target.hasZ,
            });
            if (targetHistory[target.id].length > historyLength) targetHistory[target.id].shift();
        });

        emitTargetSnapshot('live');

        renderTargetVisualization2d();

        if (!dataTableBodyEl) return true;
        if (data.targets.length === 0) {
            dataTableBodyEl.innerHTML = '<tr><td colspan="5" class="no-data">Scanning for motion...</td></tr>';
            return true;
        }

        dataTableBodyEl.innerHTML = '';
        data.targets.forEach((target) => {
            let dopStatus = 'Stationary';
            let dopClass = 'doppler-stationary';
            if (target.dop > 10) {
                dopStatus = 'Moving';
                dopClass = 'doppler-moving';
            } else if (target.dop < -10) {
                dopStatus = 'Approaching';
                dopClass = 'doppler-approaching';
            }
            const targetLabel = getFriendlyTargetLabel(target.id);
            const targetClass = Number(target.id) === 1 ? 'target-primary' : 'target-secondary';
            const heightDisplay = target.hasZ ? target.z : '<span aria-label="Unavailable">&mdash;</span>';
            dataTableBodyEl.innerHTML += `<tr><td class="target-id-cell"><span class="target-id-tag ${targetClass}"><span class="target-id-dot"></span>${targetLabel}</span></td><td class="target-num">${target.x}</td><td class="target-num">${target.y}</td><td class="target-num">${heightDisplay}</td><td class="doppler-cell"><span class="doppler-badge ${dopClass}">${dopStatus}</span></td></tr>`;
        });

        return true;
    }

    function init(options) {
        const opts = options || {};
        targetHistory = {};
        latestTargets = [];
        targetsSuppressedByGate = false;
        targetSnapshotListener = typeof opts.onTargetSnapshot === 'function' ? opts.onTargetSnapshot : null;
        chartEl = opts.chartEl || document.getElementById(opts.chartId || 'chart');
        dataTableBodyEl = opts.dataTableBodyEl || document.getElementById(opts.dataTableBodyId || 'dataTableBody');
        zoneStatusEl = opts.zoneStatusEl || document.getElementById(opts.zoneStatusId || 'zoneStatus');
        commandLogEl = opts.commandLogEl || document.getElementById(opts.commandLogId || 'commandLog');
        stateApi = opts.stateApi || null;
        updateTimestampFn = opts.updateTimestamp || null;
        getLayoutFn = opts.getLayout || null;
        getIsEditingFn = opts.getIsEditing || null;
        getIsInteractingFn = opts.getIsInteracting || null;
        shouldRenderTargetsFn = opts.shouldRenderTargets || null;
        shouldRender2dFn = opts.shouldRender2d || null;
        pendingCommandStateListener = typeof opts.onPendingCommandChange === 'function'
            ? opts.onPendingCommandChange
            : null;
        pendingCommandTimeoutMs = Number.isFinite(opts.maintenanceCommandTimeoutMs) && opts.maintenanceCommandTimeoutMs > 0
            ? opts.maintenanceCommandTimeoutMs
            : 15000;
        historyLength = Number.isFinite(opts.historyLength) ? opts.historyLength : 15;
        limits = {
            xMin: Number.isFinite(opts.limits?.xMin) ? opts.limits.xMin : DEFAULT_LIMITS.xMin,
            xMax: Number.isFinite(opts.limits?.xMax) ? opts.limits.xMax : DEFAULT_LIMITS.xMax,
            yMin: Number.isFinite(opts.limits?.yMin) ? opts.limits.yMin : DEFAULT_LIMITS.yMin,
            yMax: Number.isFinite(opts.limits?.yMax) ? opts.limits.yMax : DEFAULT_LIMITS.yMax,
            zMin: Number.isFinite(opts.limits?.zMin) ? opts.limits.zMin : DEFAULT_LIMITS.zMin,
            zMax: Number.isFinite(opts.limits?.zMax) ? opts.limits.zMax : DEFAULT_LIMITS.zMax,
            minSpan: Number.isFinite(opts.limits?.minSpan) ? opts.limits.minSpan : DEFAULT_LIMITS.minSpan
        };
        emitTargetSnapshot('init');
        return window.SwitchStudioZones;
    }

    window.SwitchStudioZones = {
        init,
        normalizeZoneConfig,
        validateZoneConfig,
        buildAreaPayload,
        createZoneWriteTracker,
        confirmZoneMaintenanceCommand,
        setPendingCommand,
        handleCommandResult,
        handleInterferenceZones,
        clearPendingCommand,
        getPendingCommandId,
        resetHistory,
        clearTargetVisualization,
        normalizeTarget,
        mapRawZonesByAreaId,
        getTargetSnapshot,
        setTargetSnapshotListener,
        buildTarget3DTraces,
        buildZoneCuboidGeometry,
        buildZoneCuboidTraces,
        buildFovVolumeGeometry,
        buildFov3DTraces,
        buildUnsupportedRange2DShapes,
        getFovStyles,
        refreshTargetVisualization: renderTargetVisualization2d,
        handleNewData,
        appendCommandLog
    };
})();
