(function () {
    const devicesByTopic = new Map();
    const pendingControls = new Map();
    let socket = null;
    let gridEl = null;
    let emptyEl = null;
    let summaryEl = null;
    let onOpenDevice = null;
    let onStatus = null;
    let selectedTopic = null;
    let socketConnected = false;
    let mqttConnected = false;
    let requestCounter = 0;
    let renderTimer = null;
    let deferredRenderControl = null;
    let scheduleTimeout = (callback, delay) => setTimeout(callback, delay);
    let cancelTimeout = (timer) => clearTimeout(timer);
    const finishedControlRequests = new Map();

    function rememberFinishedRequest(requestId) {
        if (!requestId) return;
        finishedControlRequests.set(requestId, Date.now());
        while (finishedControlRequests.size > 100) {
            finishedControlRequests.delete(finishedControlRequests.keys().next().value);
        }
    }

    function normalizeState(value) {
        if (value === true) return true;
        if (value === false) return false;
        if (typeof value === 'number') return value !== 0;
        const normalized = String(value || '').trim().toUpperCase();
        if (['ON', 'TRUE', 'YES', '1'].includes(normalized)) return true;
        if (['OFF', 'FALSE', 'NO', '0'].includes(normalized)) return false;
        return null;
    }

    function finiteNumber(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === 'string' && value.trim() === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function clampBrightness(value) {
        const parsed = finiteNumber(value);
        if (parsed === null) return null;
        return Math.min(254, Math.max(0, Math.round(parsed)));
    }

    function brightnessToPercent(value) {
        const raw = clampBrightness(value);
        if (raw === null) return null;
        return Math.min(100, Math.max(0, Math.round((raw / 254) * 100)));
    }

    function percentToBrightness(value) {
        const parsed = finiteNumber(value);
        if (parsed === null) return null;
        return Math.min(254, Math.max(0, Math.round((Math.min(100, Math.max(0, parsed)) / 100) * 254)));
    }

    function valuesEqual(a, b) {
        if (typeof a === 'number' || typeof b === 'number') {
            const an = finiteNumber(a);
            const bn = finiteNumber(b);
            if (an !== null && bn !== null) return an === bn;
        }
        if (typeof a === 'boolean' || typeof b === 'boolean') {
            const an = normalizeState(a);
            const bn = normalizeState(b);
            if (an !== null && bn !== null) return an === bn;
        }
        return String(a) === String(b);
    }

    function normalizeDevice(device) {
        const source = device && typeof device === 'object' ? device : {};
        const topic = String(source.topic || '').trim();
        if (!topic) return null;
        const existing = devicesByTopic.get(topic) || {};
        return {
            ...existing,
            ...source,
            topic,
            friendly_name: String(source.friendly_name || existing.friendly_name || topic.split('/').pop() || 'Unnamed device'),
            manufacturer: source.manufacturer || existing.manufacturer || 'Inovelli',
            model: source.model || existing.model || 'VZM32-SN',
            last_config: {
                ...(existing.last_config || {}),
                ...(source.last_config && typeof source.last_config === 'object' ? source.last_config : {}),
            },
            capabilities: {
                ...(existing.capabilities || {}),
                ...(source.capabilities && typeof source.capabilities === 'object' ? source.capabilities : {}),
            },
            controlStatus: existing.controlStatus || null,
        };
    }

    function requestRender() {
        if (!gridEl || renderTimer !== null || deferredRenderControl) return;
        renderTimer = scheduleTimeout(() => {
            renderTimer = null;
            render();
        }, 20);
        if (renderTimer && typeof renderTimer.unref === 'function') renderTimer.unref();
    }

    function setDevices(devices) {
        const incomingTopics = new Set();
        (Array.isArray(devices) ? devices : []).forEach((device) => {
            const authoritativeConfig = device && device.last_config && typeof device.last_config === 'object'
                ? device.last_config
                : null;
            const normalized = normalizeDevice(device);
            if (!normalized) return;
            incomingTopics.add(normalized.topic);
            devicesByTopic.set(normalized.topic, normalized);
            if (authoritativeConfig) reconcilePendingControls(normalized.topic, authoritativeConfig);
        });
        Array.from(devicesByTopic.keys()).forEach((topic) => {
            if (incomingTopics.has(topic)) return;
            devicesByTopic.delete(topic);
            pendingControls.forEach((entry, requestId) => {
                if (entry.topic === topic) clearPendingControl(requestId);
            });
        });
        requestRender();
    }

    function mergeConfig(topic, payload, timestamp) {
        const normalizedTopic = String(topic || '').trim();
        if (!normalizedTopic || !payload || typeof payload !== 'object') return;
        const existing = devicesByTopic.get(normalizedTopic) || normalizeDevice({
            topic: normalizedTopic,
            friendly_name: normalizedTopic.split('/').pop(),
        });
        if (!existing) return;
        existing.last_config = { ...(existing.last_config || {}), ...payload };
        existing.last_seen = Number(timestamp) || (Date.now() / 1000);
        if (
            Object.prototype.hasOwnProperty.call(payload, 'state') &&
            !Object.prototype.hasOwnProperty.call(existing.capabilities, 'state')
        ) {
            existing.capabilities.state = true;
        }
        if (
            Object.prototype.hasOwnProperty.call(payload, 'brightness') &&
            !Object.prototype.hasOwnProperty.call(existing.capabilities, 'brightness')
        ) {
            existing.capabilities.brightness = true;
        }
        devicesByTopic.set(normalizedTopic, existing);

        reconcilePendingControls(normalizedTopic, payload);
        requestRender();
    }

    function mergeSnapshot(message) {
        if (!message || !message.topic || !message.payload) return;
        const existing = devicesByTopic.get(message.topic) || normalizeDevice({
            topic: message.topic,
            friendly_name: message.payload.friendly_name,
        });
        if (!existing) return;
        existing.friendly_name = message.payload.friendly_name || existing.friendly_name;
        existing.last_seen = message.payload.last_seen || existing.last_seen;
        devicesByTopic.set(message.topic, existing);
        mergeConfig(message.topic, message.payload.last_config || {}, message.payload.last_seen);
    }

    function clearPendingControl(requestId) {
        const entry = pendingControls.get(requestId);
        if (!entry) return null;
        if (entry.timer !== null && entry.timer !== undefined) cancelTimeout(entry.timer);
        pendingControls.delete(requestId);
        rememberFinishedRequest(requestId);
        return entry;
    }

    function reconcilePendingControls(topic, authoritativeConfig) {
        if (!authoritativeConfig || typeof authoritativeConfig !== 'object') return;
        const device = devicesByTopic.get(topic);
        if (!device) return;

        pendingControls.forEach((entry, requestId) => {
            if (entry.topic !== topic) return;
            if (!(entry.confirmedFields instanceof Set)) entry.confirmedFields = new Set();
            const expectedKeys = Object.keys(entry.expected || {});

            expectedKeys.forEach((key) => {
                if (!Object.prototype.hasOwnProperty.call(authoritativeConfig, key)) return;
                if (valuesEqual(entry.expected[key], authoritativeConfig[key])) {
                    entry.confirmedFields.add(key);
                } else {
                    entry.confirmedFields.delete(key);
                    entry.previous[key] = authoritativeConfig[key];
                }
            });

            if (expectedKeys.length === 0 || !expectedKeys.every((key) => entry.confirmedFields.has(key))) return;
            clearPendingControl(requestId);
            device.controlStatus = 'confirmed';
        });
    }

    function restoreControl(entry, status, confirmedFields) {
        if (!entry) return;
        const device = devicesByTopic.get(entry.topic);
        if (!device) return;
        const confirmed = new Set(Array.isArray(confirmedFields) ? confirmedFields : []);
        const restoreValues = {};
        Object.entries(entry.previous || {}).forEach(([key, value]) => {
            if (!confirmed.has(key)) restoreValues[key] = value;
        });
        device.last_config = { ...(device.last_config || {}), ...restoreValues };
        device.controlStatus = status || 'error';
        requestRender();
    }

    function sendControl(topic, payload) {
        const device = devicesByTopic.get(topic);
        const payloadIsObject = !!payload && typeof payload === 'object';
        const capabilities = device && device.capabilities && typeof device.capabilities === 'object'
            ? device.capabilities
            : {};
        const unsupportedControl = payloadIsObject && (
            (Object.prototype.hasOwnProperty.call(payload, 'state') && capabilities.state === false) ||
            (Object.prototype.hasOwnProperty.call(payload, 'brightness') && capabilities.brightness === false)
        );
        if (unsupportedControl) {
            if (typeof onStatus === 'function') {
                onStatus('error', 'This quick control is not supported for this device.');
            }
            return null;
        }
        if (
            !socket ||
            !socketConnected ||
            !mqttConnected ||
            !device ||
            !isDeviceOnline(device) ||
            !payloadIsObject
        ) {
            if (typeof onStatus === 'function') {
                onStatus('error', 'Controls are unavailable while this device is offline or reconnecting.');
            }
            return null;
        }

        const nextKeys = new Set(Object.keys(payload));
        const inheritedPrevious = {};
        pendingControls.forEach((entry, pendingRequestId) => {
            if (entry.topic !== topic) return;
            const overlappingKeys = Object.keys(entry.expected || {}).filter((key) => nextKeys.has(key));
            const overlaps = overlappingKeys.length > 0;
            overlappingKeys.forEach((key) => {
                if (entry.previous && Object.prototype.hasOwnProperty.call(entry.previous, key)) {
                    inheritedPrevious[key] = entry.previous[key];
                }
            });
            if (overlaps) clearPendingControl(pendingRequestId);
        });

        const requestId = `dashboard-control-${Date.now()}-${requestCounter++}`;
        const previous = {};
        Object.keys(payload).forEach((key) => {
            previous[key] = Object.prototype.hasOwnProperty.call(inheritedPrevious, key)
                ? inheritedPrevious[key]
                : (device.last_config ? device.last_config[key] : undefined);
        });
        device.last_config = { ...(device.last_config || {}), ...payload };
        device.controlStatus = 'sending';
        const entry = {
            requestId,
            topic,
            expected: { ...payload },
            previous,
            confirmedFields: new Set(),
            timer: null,
        };
        entry.timer = scheduleTimeout(() => {
            if (!pendingControls.has(requestId)) return;
            const timedOut = clearPendingControl(requestId);
            restoreControl(timedOut, 'not-confirmed', Array.from(timedOut.confirmedFields || []));
            if (typeof onStatus === 'function') onStatus('unconfirmed', 'Device did not confirm the quick control.');
        }, 12000);
        if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
        pendingControls.set(requestId, entry);
        socket.emit('set_basic_control', { ...payload, topic, request_id: requestId });
        requestRender();
        return requestId;
    }

    function handleControlResult(result) {
        if (!result || result.action !== 'set_basic_control' || !result.request_id) return false;
        const entry = pendingControls.get(result.request_id);
        if (!entry) return finishedControlRequests.has(result.request_id);
        if (result.topic && result.topic !== entry.topic) return false;
        const device = devicesByTopic.get(entry.topic);

        if (result.status === 'error') {
            clearPendingControl(result.request_id);
            restoreControl(entry, 'error');
            if (typeof onStatus === 'function') onStatus('error', result.message || 'Quick control failed.');
        } else if (result.status === 'not_confirmed') {
            clearPendingControl(result.request_id);
            const confirmedFields = result.payload && Array.isArray(result.payload.confirmed_fields)
                ? result.payload.confirmed_fields
                : [];
            restoreControl(entry, 'not-confirmed', confirmedFields);
            if (typeof onStatus === 'function') onStatus('unconfirmed', result.message || 'Quick control was not confirmed.');
        } else if (result.status === 'confirmed') {
            clearPendingControl(result.request_id);
            if (device) {
                device.last_config = { ...(device.last_config || {}), ...(result.payload || entry.expected) };
                device.controlStatus = 'confirmed';
            }
            if (typeof onStatus === 'function') onStatus('confirmed', 'Quick control confirmed.');
            requestRender();
        } else if (device && (result.status === 'sent' || result.status === 'sending')) {
            device.controlStatus = 'sending';
            requestRender();
        }
        return true;
    }

    function getDeviceReadiness(device) {
        if (!socketConnected || !mqttConnected) {
            return { ready: false, label: 'Reconnecting', state: 'unavailable' };
        }
        const availability = String(device && device.availability || '').trim().toLowerCase();
        if (availability === 'offline') {
            return { ready: false, label: 'Offline', state: 'offline' };
        }
        if (availability === 'online') {
            return { ready: true, label: 'Online', state: 'online' };
        }
        return { ready: true, label: 'Ready', state: 'ready' };
    }

    function isDeviceOnline(device) {
        return getDeviceReadiness(device).ready;
    }

    function createElement(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined && text !== null) element.textContent = String(text);
        return element;
    }

    function createMetric(label, value) {
        const metric = createElement('div', 'device-card-metric');
        metric.appendChild(createElement('span', 'device-card-metric-label', label));
        metric.appendChild(createElement('strong', 'device-card-metric-value', value));
        return metric;
    }

    function renderCard(device) {
        const readiness = getDeviceReadiness(device);
        const online = readiness.ready;
        const canOpenEditor = device.capabilities.full_editor !== false;
        const config = device.last_config || {};
        const isOn = normalizeState(config.state) === true;
        const brightness = brightnessToPercent(config.brightness);
        const occupancy = normalizeState(config.occupancy);
        const power = finiteNumber(config.power);
        const illuminance = finiteNumber(config.illuminance);

        const card = createElement('article', `device-card${isOn ? ' is-on' : ''}${online ? '' : ' is-offline'}`);
        card.dataset.topic = device.topic;

        const header = createElement('div', 'device-card-header');
        const identity = createElement('div', 'device-card-identity');
        identity.appendChild(createElement('div', 'device-card-model', device.model || 'VZM32-SN'));
        identity.appendChild(createElement('h2', 'device-card-name', device.friendly_name));
        header.appendChild(identity);
        const status = createElement('span', `device-card-status ${online ? 'is-online' : 'is-offline'}`, readiness.label);
        header.appendChild(status);
        card.appendChild(header);

        const metrics = createElement('div', 'device-card-metrics');
        metrics.appendChild(createMetric('Presence', occupancy === true ? 'Occupied' : occupancy === false ? 'Clear' : '—'));
        metrics.appendChild(createMetric('Power', power !== null ? `${power.toFixed(power % 1 ? 1 : 0)} W` : '—'));
        metrics.appendChild(createMetric('Light', illuminance !== null ? `${illuminance} lx` : '—'));
        card.appendChild(metrics);

        const controls = createElement('div', 'device-card-controls');
        const powerWrap = createElement('label', 'device-card-power');
        powerWrap.appendChild(createElement('span', 'device-card-control-label', 'Power'));
        const powerToggle = createElement('input', 'device-card-power-toggle');
        powerToggle.type = 'checkbox';
        powerToggle.checked = isOn;
        powerToggle.disabled = !online || device.capabilities.state === false;
        powerToggle.setAttribute('aria-label', `Toggle ${device.friendly_name} power`);
        powerToggle.addEventListener('change', () => {
            sendControl(device.topic, { state: powerToggle.checked ? 'ON' : 'OFF' });
        });
        powerWrap.appendChild(powerToggle);
        controls.appendChild(powerWrap);

        const brightnessWrap = createElement('label', 'device-card-brightness');
        const brightnessHeader = createElement('span', 'device-card-brightness-header');
        brightnessHeader.appendChild(createElement('span', 'device-card-control-label', isOn ? 'Brightness' : 'Last level'));
        const brightnessValue = createElement('strong', 'device-card-brightness-value', brightness === null ? '—' : `${brightness}%`);
        brightnessHeader.appendChild(brightnessValue);
        brightnessWrap.appendChild(brightnessHeader);
        const slider = createElement('input', 'device-card-brightness-slider');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '100';
        slider.step = '1';
        slider.value = String(brightness === null ? 0 : brightness);
        slider.disabled = !online || device.capabilities.brightness === false;
        slider.setAttribute('aria-label', `Set ${device.friendly_name} brightness`);
        slider.addEventListener('input', () => {
            brightnessValue.textContent = `${slider.value}%`;
        });
        slider.addEventListener('change', () => {
            const raw = percentToBrightness(slider.value);
            if (raw === null) return;
            const payload = { brightness: raw };
            if (!isOn) payload.state = 'ON';
            sendControl(device.topic, payload);
        });
        brightnessWrap.appendChild(slider);
        controls.appendChild(brightnessWrap);
        card.appendChild(controls);

        const footer = createElement('div', 'device-card-footer');
        const controlState = device.controlStatus === 'sending'
            ? 'Waiting for confirmation…'
            : device.controlStatus === 'not-confirmed'
                ? 'Last control not confirmed'
                : device.controlStatus === 'confirmed'
                    ? 'Control confirmed'
                    : '';
        footer.appendChild(createElement('span', `device-card-feedback ${device.controlStatus || ''}`, controlState));
        const openButton = createElement('button', 'device-card-open', 'Open device');
        openButton.type = 'button';
        openButton.disabled = !canOpenEditor;
        if (!canOpenEditor) {
            openButton.textContent = 'Quick controls only';
            openButton.setAttribute('aria-label', `${device.friendly_name} full configuration is not supported yet`);
        }
        openButton.addEventListener('click', () => requestOpenDevice(device.topic));
        footer.appendChild(openButton);
        card.appendChild(footer);
        return card;
    }

    function render() {
        if (!gridEl || typeof document === 'undefined') return;
        const activeElement = document.activeElement;
        if (
            activeElement &&
            typeof activeElement.matches === 'function' &&
            activeElement.matches('input, button, select') &&
            typeof gridEl.contains === 'function' &&
            gridEl.contains(activeElement)
        ) {
            if (deferredRenderControl !== activeElement) {
                deferredRenderControl = activeElement;
                activeElement.addEventListener('blur', () => {
                    deferredRenderControl = null;
                    requestRender();
                }, { once: true });
            }
            return;
        }
        deferredRenderControl = null;
        while (gridEl.firstChild) gridEl.removeChild(gridEl.firstChild);
        const devices = Array.from(devicesByTopic.values()).sort((a, b) => a.friendly_name.localeCompare(b.friendly_name));
        devices.forEach((device) => gridEl.appendChild(renderCard(device)));
        if (emptyEl) emptyEl.hidden = devices.length > 0;
        if (summaryEl) {
            const readyCount = devices.filter((device) => isDeviceOnline(device)).length;
            summaryEl.textContent = devices.length === 0
                ? 'Waiting for Zigbee2MQTT devices…'
                : `${devices.length} device${devices.length === 1 ? '' : 's'} · ${readyCount} ready`;
        }
    }

    function requestOpenDevice(topic) {
        const device = devicesByTopic.get(topic);
        if (!device || device.capabilities.full_editor === false) return false;
        if (typeof onOpenDevice === 'function') onOpenDevice(topic);
        return true;
    }

    function setSelectedTopic(topic) {
        selectedTopic = topic ? String(topic) : null;
        requestRender();
    }

    function setTransportState(nextSocketConnected, nextMqttConnected) {
        socketConnected = !!nextSocketConnected;
        if (nextMqttConnected !== undefined && nextMqttConnected !== null) mqttConnected = !!nextMqttConnected;
        requestRender();
    }

    function init(options) {
        const opts = options || {};
        socket = opts.socket || null;
        gridEl = opts.gridEl || null;
        emptyEl = opts.emptyEl || null;
        summaryEl = opts.summaryEl || null;
        onOpenDevice = typeof opts.onOpenDevice === 'function' ? opts.onOpenDevice : null;
        onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
        scheduleTimeout = opts.setTimeoutFn || scheduleTimeout;
        cancelTimeout = opts.clearTimeoutFn || cancelTimeout;
        render();
    }

    window.SwitchStudioDevices = {
        init,
        setDevices,
        mergeConfig,
        mergeSnapshot,
        handleControlResult,
        requestOpenDevice,
        setSelectedTopic,
        setTransportState,
        sendControl,
        render,
        getDevice: (topic) => devicesByTopic.get(topic) || null,
        getDevices: () => Array.from(devicesByTopic.values()),
        getSelectedTopic: () => selectedTopic,
        brightnessToPercent,
        percentToBrightness,
        normalizeState,
        getDeviceReadiness,
    };
})();
