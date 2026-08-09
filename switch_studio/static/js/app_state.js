(function () {
    const DEFAULT_TOPIC = '__default__';
    const deviceStates = new Map();
    const inputElements = new Map();
    const syncHandlers = new Map();
    const externalPending = new Map();

    let activeTopic = null;
    let socket = null;
    let packetInfoEl = null;
    let dirtyBarEl = null;
    let dirtyTextEl = null;
    let applyBtnEl = null;
    let discardBtnEl = null;
    let toastContainerEl = null;
    let requestCounter = 0;
    let transportReady = true;
    let scheduleTimeout = (callback, delay) => setTimeout(callback, delay);
    let cancelTimeout = (timer) => clearTimeout(timer);
    const confirmationTimeoutMs = 12000;

    function normalizeForCompare(value) {
        if (Array.isArray(value)) return value.map((item) => normalizeForCompare(item));
        if (value && typeof value === 'object') {
            const normalized = {};
            Object.keys(value).sort().forEach((key) => {
                normalized[key] = normalizeForCompare(value[key]);
            });
            return normalized;
        }
        return value;
    }

    function valuesEqual(a, b) {
        if ((a && typeof a === 'object') || (b && typeof b === 'object')) {
            try {
                return JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));
            } catch (err) {
                return false;
            }
        }
        if (typeof a === 'number' || typeof b === 'number') {
            const an = Number(a);
            const bn = Number(b);
            if (Number.isFinite(an) && Number.isFinite(bn)) return an === bn;
        }
        return String(a) === String(b);
    }

    function topicKey(topic) {
        return String(topic || activeTopic || DEFAULT_TOPIC);
    }

    function createDeviceState() {
        return {
            authoritative: {},
            pending: new Map(),
            inFlight: new Map(),
            batches: new Map(),
            lastSyncAt: null,
        };
    }

    function ensureDeviceState(topic) {
        const key = topicKey(topic);
        if (!deviceStates.has(key)) deviceStates.set(key, createDeviceState());
        return deviceStates.get(key);
    }

    function getActiveState() {
        return ensureDeviceState(activeTopic);
    }

    function syncLedColorSelect(element, value) {
        if (!element || element.tagName !== 'SELECT') return;
        const normalizedValue = value === undefined || value === null ? '' : String(value);
        Array.from(element.options)
            .filter((option) => option.dataset.customColorValue === '1')
            .forEach((option) => option.remove());
        if (!normalizedValue) {
            element.selectedIndex = -1;
            return;
        }
        const existingOption = Array.from(element.options).find((option) => option.value === normalizedValue);
        if (existingOption) {
            element.value = normalizedValue;
            return;
        }
        const customOption = document.createElement('option');
        customOption.value = normalizedValue;
        customOption.textContent = `Current (${normalizedValue})`;
        customOption.dataset.customColorValue = '1';
        element.appendChild(customOption);
        element.value = normalizedValue;
    }

    function refreshLedSliderDisplay(element) {
        if (!element || element.type !== 'range') return;
        const targetId = element.dataset.sliderValueTarget;
        if (!targetId) return;
        const valueElement = document.getElementById(targetId);
        if (!valueElement) return;
        const rawValue = element.value === '' ? '--' : String(element.value);
        const maxValue = Number(element.max);
        if (rawValue !== '--' && maxValue === 101 && Number(rawValue) === 101) {
            valueElement.innerText = 'Sync';
            return;
        }
        valueElement.innerText = rawValue === '--' ? '--' : `${rawValue}%`;
    }

    function ensureParamElementSet(param) {
        if (!inputElements.has(param)) inputElements.set(param, new Set());
        return inputElements.get(param);
    }

    function ensureParamHandlerSet(param) {
        if (!syncHandlers.has(param)) syncHandlers.set(param, new Set());
        return syncHandlers.get(param);
    }

    function registerInputBinding(param, element) {
        if (!param || !element) return () => {};
        const bucket = ensureParamElementSet(param);
        bucket.add(element);
        return () => {
            const current = inputElements.get(param);
            if (!current) return;
            current.delete(element);
            if (current.size === 0) inputElements.delete(param);
        };
    }

    function registerSyncHandler(param, handler) {
        if (!param || typeof handler !== 'function') return () => {};
        const bucket = ensureParamHandlerSet(param);
        bucket.add(handler);
        return () => {
            const current = syncHandlers.get(param);
            if (!current) return;
            current.delete(handler);
            if (current.size === 0) syncHandlers.delete(param);
        };
    }

    function setInputValue(element, value) {
        if (!element) return;
        if (element.tagName === 'SPAN') {
            element.innerText = value === undefined || value === null ? '--' : String(value);
            return;
        }
        if (element.tagName === 'SELECT' && element.dataset.ledColorSelect === '1') {
            syncLedColorSelect(element, value);
            return;
        }
        if (element.type === 'checkbox') {
            element.checked = value === true || value === 'ON' || value === 'true';
            return;
        }
        if (Array.isArray(value)) {
            element.value = value.join(', ');
            return;
        }
        if (value && typeof value === 'object') {
            element.value = JSON.stringify(value);
            return;
        }
        element.value = value === undefined || value === null ? '' : value;
        if (element.type === 'range' && element.dataset.ledBrightnessSlider === '1') {
            refreshLedSliderDisplay(element);
        }
    }

    function syncParamUi(param, value) {
        const seen = new Set();
        const registeredInputs = inputElements.get(param);
        if (registeredInputs) {
            registeredInputs.forEach((element) => {
                if (!element) return;
                setInputValue(element, value);
                seen.add(element);
            });
        }
        if (typeof document !== 'undefined' && document) {
            const fallbackElement = document.getElementById(param);
            if (fallbackElement && !seen.has(fallbackElement)) setInputValue(fallbackElement, value);
        }
        const handlers = syncHandlers.get(param);
        if (handlers) {
            handlers.forEach((handler) => {
                try {
                    handler(value);
                } catch (err) {
                    // One custom control must not prevent the rest of the device from syncing.
                }
            });
        }
    }

    function visibleCount(map) {
        return Array.from(map.values()).filter((entry) => !entry.hiddenFromCount).length;
    }

    function updateDirtyUi() {
        const state = getActiveState();
        const pendingCount = visibleCount(state.pending);
        const pendingTotal = state.pending.size;
        const sendingCount = visibleCount(state.inFlight);
        const externalCount = externalPending.size;
        const hasWork = state.pending.size > 0 || state.inFlight.size > 0 || externalCount > 0;
        const hasUnconfirmed = Array.from(state.pending.values()).some((entry) => entry.status === 'unconfirmed');

        if (dirtyBarEl) {
            dirtyBarEl.classList.toggle('dirty-active', hasWork);
            dirtyBarEl.classList.toggle('dirty-sending', sendingCount > 0);
            dirtyBarEl.classList.toggle('dirty-unconfirmed', hasUnconfirmed);
            dirtyBarEl.hidden = !hasWork;
            dirtyBarEl.setAttribute('aria-hidden', String(!hasWork));
        }
        if (typeof document !== 'undefined' && document && document.body && document.body.classList) {
            document.body.classList.toggle('dirty-bar-visible', hasWork);
        }
        if (dirtyTextEl) {
            const parts = [];
            if (pendingCount > 0) parts.push(`${pendingCount} pending change${pendingCount === 1 ? '' : 's'}`);
            const linkedPendingCount = pendingTotal - pendingCount;
            if (linkedPendingCount > 0) parts.push(`${linkedPendingCount} linked change${linkedPendingCount === 1 ? '' : 's'}`);
            if (externalCount > 0) parts.push(`${externalCount} zone draft${externalCount === 1 ? '' : 's'}`);
            if (sendingCount > 0) parts.push(`${sendingCount} awaiting confirmation`);
            if (hasUnconfirmed) parts.push('not confirmed');
            dirtyTextEl.innerText = parts.length ? parts.join(' · ') : 'No pending changes';
        }
        if (applyBtnEl) applyBtnEl.disabled = !transportReady || (pendingTotal === 0 && externalCount === 0) || state.inFlight.size > 0;
        if (discardBtnEl) discardBtnEl.disabled = pendingTotal === 0 && externalCount === 0;
    }

    function showToast(type, message, durationMs) {
        if (!toastContainerEl) return;
        const toast = document.createElement('div');
        toast.className = `studio-toast studio-toast-${type || 'info'}`;
        toast.innerText = message || '';
        toastContainerEl.appendChild(toast);
        const timeout = Number.isFinite(durationMs) ? durationMs : 2800;
        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 220);
        }, timeout);
    }

    function setPacketStatus(mode, message) {
        if (!packetInfoEl) return;
        if (message) packetInfoEl.innerText = message;
        const colorMap = {
            saved: '#4caf50',
            confirmed: '#4caf50',
            syncing: '#00bcd4',
            sending: '#00bcd4',
            error: '#ff5252',
            unconfirmed: '#fbbf24',
            info: '#00bcd4'
        };
        packetInfoEl.style.color = colorMap[mode] || '#00bcd4';
    }

    function desiredValueFor(state, param) {
        if (state.pending.has(param)) return state.pending.get(param).value;
        if (state.inFlight.has(param)) return state.inFlight.get(param).value;
        return state.authoritative[param];
    }

    function hydrateActiveUi() {
        const state = getActiveState();
        const keys = new Set([
            ...Object.keys(state.authoritative),
            ...state.pending.keys(),
            ...state.inFlight.keys(),
            ...inputElements.keys(),
            ...syncHandlers.keys(),
        ]);
        keys.forEach((param) => syncParamUi(param, desiredValueFor(state, param)));
        updateDirtyUi();
    }

    function setActiveDevice(topic, options) {
        const opts = options || {};
        const previousTopic = activeTopic;
        if (opts.discardPrevious && previousTopic) discardDevice(previousTopic, { silent: true });
        activeTopic = topic ? String(topic) : null;
        hydrateActiveUi();
    }

    function queueChange(param, value, inputElement, options) {
        if (!param) return;
        const opts = options || {};
        const state = getActiveState();
        if (inputElement) registerInputBinding(param, inputElement);

        const baseline = state.authoritative[param];
        const inFlight = state.inFlight.get(param);
        if ((baseline !== undefined && valuesEqual(baseline, value) && !inFlight) || (inFlight && valuesEqual(inFlight.value, value))) {
            state.pending.delete(param);
        } else {
            state.pending.set(param, {
                value,
                hiddenFromCount: !!opts.hiddenFromCount,
                status: 'pending',
            });
        }
        syncParamUi(param, value);
        updateDirtyUi();
    }

    function clearBatchTimer(batch) {
        if (!batch || batch.timer === null || batch.timer === undefined) return;
        cancelTimeout(batch.timer);
        batch.timer = null;
    }

    function restoreBatchAsUnconfirmed(state, requestId, message, confirmedFields) {
        const batch = state.batches.get(requestId);
        if (!batch) return;
        const confirmed = new Set(Array.isArray(confirmedFields) ? confirmedFields : []);
        let processedCount = 0;
        let restoredCount = 0;
        clearBatchTimer(batch);
        batch.params.forEach((param) => {
            const entry = state.inFlight.get(param);
            if (!entry || entry.requestId !== requestId) return;
            processedCount += 1;
            state.inFlight.delete(param);
            const authoritativeMatches = (
                Object.prototype.hasOwnProperty.call(state.authoritative, param) &&
                valuesEqual(state.authoritative[param], entry.value)
            );
            if (confirmed.has(param) || authoritativeMatches) return;
            if (!state.pending.has(param)) {
                state.pending.set(param, {
                    value: entry.value,
                    hiddenFromCount: !!entry.hiddenFromCount,
                    status: 'unconfirmed',
                });
                restoredCount += 1;
            }
        });
        state.batches.delete(requestId);
        if (state === getActiveState()) {
            hydrateActiveUi();
            if (processedCount > 0 && restoredCount === 0) {
                setPacketStatus('confirmed', 'Changes match the latest device state');
                showToast('saved', 'The latest device state matches your changes.', 2200);
            } else {
                setPacketStatus('unconfirmed', message || 'Changes were not confirmed');
                showToast('error', message || 'Device did not confirm the changes. They are ready to retry.', 3200);
            }
        }
    }

    function applyPendingChanges() {
        const state = getActiveState();
        const hasExternalChanges = externalPending.size > 0;
        if (!socket || !transportReady || socket.connected === false || (state.pending.size === 0 && !hasExternalChanges) || state.inFlight.size > 0) {
            if ((!transportReady || (socket && socket.connected === false)) && (state.pending.size > 0 || hasExternalChanges)) {
                setPacketStatus('error', 'Reconnect before applying changes');
                showToast('error', 'Changes remain staged until the connection returns.', 2600);
            }
            return;
        }

        let requestId = null;
        if (state.pending.size > 0) {
            requestId = `apply-${Date.now()}-${requestCounter++}`;
            const changes = {};
            const params = new Set();
            state.pending.forEach((entry, param) => {
                changes[param] = entry.value;
                params.add(param);
                state.inFlight.set(param, {
                    value: entry.value,
                    hiddenFromCount: !!entry.hiddenFromCount,
                    requestId,
                    status: 'sending',
                });
            });
            state.pending.clear();

            const batch = { requestId, params, timer: null };
            batch.timer = scheduleTimeout(() => {
                restoreBatchAsUnconfirmed(state, requestId, 'Device confirmation timed out');
            }, confirmationTimeoutMs);
            if (batch.timer && typeof batch.timer.unref === 'function') batch.timer.unref();
            state.batches.set(requestId, batch);

            const message = { changes, request_id: requestId };
            if (activeTopic && activeTopic !== DEFAULT_TOPIC) message.topic = activeTopic;
            socket.emit('apply_parameters', message);
            setPacketStatus('sending', 'Sending changes…');
            showToast('syncing', `Sending ${params.size} change${params.size === 1 ? '' : 's'}…`, 1600);
        }

        Array.from(externalPending.values()).forEach((entry) => {
            if (entry && typeof entry.apply === 'function') entry.apply();
        });
        updateDirtyUi();
        return requestId;
    }

    function setExternalPending(key, pending, handlers) {
        if (!key) return;
        if (!pending) externalPending.delete(key);
        else externalPending.set(key, handlers && typeof handlers === 'object' ? handlers : {});
        updateDirtyUi();
    }

    function discardDevice(topic, options) {
        const opts = options || {};
        const state = ensureDeviceState(topic);
        if (state.pending.size === 0) return;
        state.pending.clear();
        if (topicKey(topic) === topicKey(activeTopic)) {
            hydrateActiveUi();
            setPacketStatus('info', 'Pending changes discarded');
            if (!opts.silent) showToast('info', 'Discarded pending changes.', 1800);
        }
    }

    function discardPendingChanges() {
        discardDevice(activeTopic);
        const entries = Array.from(externalPending.values());
        externalPending.clear();
        entries.forEach((entry) => {
            if (entry && typeof entry.discard === 'function') entry.discard();
        });
        updateDirtyUi();
    }

    function finishConfirmedBatch(state, requestId, payload) {
        const batch = state.batches.get(requestId);
        if (!batch) return;
        clearBatchTimer(batch);
        batch.params.forEach((param) => {
            const entry = state.inFlight.get(param);
            if (!entry || entry.requestId !== requestId) return;
            const confirmedValue = payload && Object.prototype.hasOwnProperty.call(payload, param)
                ? payload[param]
                : entry.value;
            state.authoritative[param] = confirmedValue;
            state.inFlight.delete(param);
        });
        state.batches.delete(requestId);
        if (state === getActiveState()) {
            hydrateActiveUi();
            setPacketStatus('confirmed', 'Changes confirmed');
            showToast('saved', 'Device confirmed the changes.', 1800);
        }
    }

    function parseSyncArgs(topicOrPayload, maybePayload) {
        if (typeof topicOrPayload === 'string') {
            return { topic: topicOrPayload, payload: maybePayload };
        }
        return { topic: typeof maybePayload === 'string' ? maybePayload : activeTopic, payload: topicOrPayload };
    }

    function syncConfig(topicOrPayload, maybePayload) {
        const parsed = parseSyncArgs(topicOrPayload, maybePayload);
        if (!parsed.payload || typeof parsed.payload !== 'object') return;
        const state = ensureDeviceState(parsed.topic);

        Object.entries(parsed.payload).forEach(([param, value]) => {
            state.authoritative[param] = value;
            const pending = state.pending.get(param);
            if (pending && valuesEqual(pending.value, value)) state.pending.delete(param);

            if (topicKey(parsed.topic) === topicKey(activeTopic)) {
                syncParamUi(param, desiredValueFor(state, param));
            }
        });
        state.lastSyncAt = Date.now();
        if (topicKey(parsed.topic) === topicKey(activeTopic)) updateDirtyUi();
    }

    function findStateForResult(result) {
        if (result && result.topic && deviceStates.has(topicKey(result.topic))) {
            return deviceStates.get(topicKey(result.topic));
        }
        if (result && result.request_id) {
            for (const state of deviceStates.values()) {
                if (state.batches.has(result.request_id)) return state;
            }
        }
        return getActiveState();
    }

    function handleCommandResult(result) {
        if (!result || !result.status) return;

        if (result.action === 'apply_parameters') {
            const state = findStateForResult(result);
            if (result.status === 'error') {
                restoreBatchAsUnconfirmed(state, result.request_id, result.message || 'Could not send changes');
                return;
            }
            if (result.status === 'not_confirmed') {
                const confirmedFields = result.payload && Array.isArray(result.payload.confirmed_fields)
                    ? result.payload.confirmed_fields
                    : [];
                restoreBatchAsUnconfirmed(
                    state,
                    result.request_id,
                    result.message || 'Device did not confirm the changes',
                    confirmedFields
                );
                return;
            }
            if (result.status === 'confirmed') {
                finishConfirmedBatch(state, result.request_id, result.payload || {});
                return;
            }
            if (
                (result.status === 'sent' || result.status === 'sending') &&
                state.batches.has(result.request_id) &&
                state === getActiveState()
            ) {
                setPacketStatus('sending', 'Waiting for device confirmation…');
                updateDirtyUi();
            }
            return;
        }

        if (result.status === 'error') {
            setPacketStatus('error', result.message ? `Error: ${result.message}` : 'Command failed');
            showToast('error', result.message || 'Command failed', 3200);
            return;
        }
        if (result.action === 'force_sync_get' || result.action === 'force_sync_query_areas') {
            setPacketStatus('syncing', 'Sync requested');
            showToast('syncing', 'Sync request sent.', 1400);
        }
    }

    function init(options) {
        const opts = options || {};
        socket = opts.socket || null;
        packetInfoEl = opts.packetInfoEl || null;
        dirtyBarEl = opts.dirtyBarEl || null;
        dirtyTextEl = opts.dirtyTextEl || null;
        applyBtnEl = opts.applyBtnEl || null;
        discardBtnEl = opts.discardBtnEl || null;
        toastContainerEl = opts.toastContainerEl || null;
        transportReady = opts.transportReady !== false;
        scheduleTimeout = opts.setTimeoutFn || scheduleTimeout;
        cancelTimeout = opts.clearTimeoutFn || cancelTimeout;
        if (applyBtnEl) applyBtnEl.addEventListener('click', applyPendingChanges);
        if (discardBtnEl) discardBtnEl.addEventListener('click', discardPendingChanges);
        updateDirtyUi();
    }

    function resetForDeviceChange(topic) {
        setActiveDevice(topic || null, { discardPrevious: true });
    }

    function getDeviceStatus(topic) {
        const state = ensureDeviceState(topic);
        return {
            pending: state.pending.size,
            sending: state.inFlight.size,
            hasUnconfirmed: Array.from(state.pending.values()).some((entry) => entry.status === 'unconfirmed'),
            authoritative: { ...state.authoritative },
        };
    }

    window.SwitchStudioState = {
        init,
        queueChange,
        applyPendingChanges,
        discardPendingChanges,
        discardDevice,
        syncConfig,
        setActiveDevice,
        activateDevice: setActiveDevice,
        resetForDeviceChange,
        showToast,
        setPacketStatus,
        handleCommandResult,
        registerInputBinding,
        registerSyncHandler,
        setExternalPending,
        setTransportReady: (ready) => {
            transportReady = !!ready;
            updateDirtyUi();
        },
        getLatestValue: (param, topic) => ensureDeviceState(topic).authoritative[param],
        getCurrentValue: (param, topic) => desiredValueFor(ensureDeviceState(topic), param),
        isPending: (param, topic) => {
            const state = ensureDeviceState(topic);
            return state.pending.has(param) || state.inFlight.has(param);
        },
        getPendingCount: (topic) => visibleCount(ensureDeviceState(topic).pending),
        getSendingCount: (topic) => visibleCount(ensureDeviceState(topic).inFlight),
        hasUncommitted: (topic) => {
            const state = ensureDeviceState(topic);
            const includesExternal = topicKey(topic) === topicKey(activeTopic) && externalPending.size > 0;
            return state.pending.size > 0 || state.inFlight.size > 0 || includesExternal;
        },
        getActiveTopic: () => activeTopic,
        getDeviceStatus,
        valuesEqual,
    };
})();
