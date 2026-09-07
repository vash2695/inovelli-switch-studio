(function () {
    const TIMING_DEFAULTS = {
        dimmingSpeedUpRemote: 25,
        dimmingSpeedUpLocal: 127,
        rampRateOffToOnRemote: 127,
        rampRateOffToOnLocal: 127,
        dimmingSpeedDownRemote: 127,
        dimmingSpeedDownLocal: 127,
        rampRateOnToOffRemote: 127,
        rampRateOnToOffLocal: 127,
    };

    const DEFAULT_LEVEL_DEFAULTS = {
        defaultLevelRemote: 255,
        defaultLevelLocal: 255,
    };

    const INDICATOR_DEFAULT = 'Stay On';

    const TIMING_GROUPS = [
        {
            id: 'dimUp',
            section: 'Dim Speed',
            title: 'Dim up',
            remoteParam: 'dimmingSpeedUpRemote',
            localParam: 'dimmingSpeedUpLocal',
        },
        {
            id: 'dimDown',
            section: 'Dim Speed',
            title: 'Dim down',
            remoteParam: 'dimmingSpeedDownRemote',
            localParam: 'dimmingSpeedDownLocal',
        },
        {
            id: 'rampOn',
            section: 'Ramp Speed (On / Off)',
            title: 'Ramp on',
            remoteParam: 'rampRateOffToOnRemote',
            localParam: 'rampRateOffToOnLocal',
        },
        {
            id: 'rampOff',
            section: 'Ramp Speed (On / Off)',
            title: 'Ramp off',
            remoteParam: 'rampRateOnToOffRemote',
            localParam: 'rampRateOnToOffLocal',
        },
    ];

    const DEFAULT_LEVEL_ROWS = [
        { id: 'defaultRemote', label: 'Hub', param: 'defaultLevelRemote' },
        { id: 'defaultLocal', label: 'Paddle', param: 'defaultLevelLocal' },
    ];

    const CONTROLLED_PARAMS = new Set([
        'dimmingSpeedUpRemote',
        'dimmingSpeedUpLocal',
        'rampRateOffToOnRemote',
        'rampRateOffToOnLocal',
        'dimmingSpeedDownRemote',
        'dimmingSpeedDownLocal',
        'rampRateOnToOffRemote',
        'rampRateOnToOffLocal',
        'defaultLevelRemote',
        'defaultLevelLocal',
        'loadLevelIndicatorTimeout',
        'dimmingMode',
    ]);

    let containerEl = null;
    let stateApi = null;
    let isDeviceSelectedFn = null;
    let schemaFieldMap = {};
    let rawValues = {};
    let lastManualDefaultLevels = {
        defaultLevelRemote: 254,
        defaultLevelLocal: 254,
    };
    let linkPreferences = {};
    let timingInteractionDrafts = {};
    let syncUnsubscribers = [];
    let controlRefs = null;

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function toInt(value, fallback) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function hasValue(param) {
        return Object.prototype.hasOwnProperty.call(rawValues, param);
    }

    function getField(param) {
        return schemaFieldMap[param] || null;
    }

    function getIsDeviceSelected() {
        return typeof isDeviceSelectedFn === 'function' ? !!isDeviceSelectedFn() : true;
    }

    function getRawValue(param) {
        if (hasValue(param)) return rawValues[param];
        if (Object.prototype.hasOwnProperty.call(TIMING_DEFAULTS, param)) return TIMING_DEFAULTS[param];
        if (Object.prototype.hasOwnProperty.call(DEFAULT_LEVEL_DEFAULTS, param)) return DEFAULT_LEVEL_DEFAULTS[param];
        if (param === 'loadLevelIndicatorTimeout') return INDICATOR_DEFAULT;
        return null;
    }

    function hasFriendlyLoadSchema() {
        return [
            'dimmingSpeedUpRemote',
            'dimmingSpeedUpLocal',
            'dimmingSpeedDownRemote',
            'dimmingSpeedDownLocal',
            'rampRateOffToOnRemote',
            'rampRateOffToOnLocal',
            'rampRateOnToOffRemote',
            'rampRateOnToOffLocal',
            'defaultLevelRemote',
            'defaultLevelLocal',
            'loadLevelIndicatorTimeout',
            'dimmingMode',
        ].some((param) => !!getField(param));
    }

    function setRawValue(param, value) {
        rawValues[param] = value;
        if ((param === 'defaultLevelRemote' || param === 'defaultLevelLocal') && Number(value) >= 0 && Number(value) <= 254) {
            lastManualDefaultLevels[param] = Number(value);
        }
    }

    function clearSyncHandlers() {
        syncUnsubscribers.forEach((unsubscribe) => {
            if (typeof unsubscribe === 'function') unsubscribe();
        });
        syncUnsubscribers = [];
    }

    function timingUnitsToSeconds(units) {
        const numeric = clamp(toInt(units, 0), 0, 126);
        return numeric / 10;
    }

    function formatTimingValue(units) {
        const seconds = timingUnitsToSeconds(units);
        if (seconds <= 0) return 'Instant';
        const fixed = Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1);
        return `${fixed}s`;
    }

    function getTimingParentParam(param) {
        switch (param) {
            case 'dimmingSpeedUpLocal':
                return 'dimmingSpeedUpRemote';
            case 'rampRateOffToOnRemote':
                return 'dimmingSpeedUpRemote';
            case 'rampRateOffToOnLocal':
                return 'rampRateOffToOnRemote';
            case 'dimmingSpeedDownRemote':
                return 'dimmingSpeedUpRemote';
            case 'dimmingSpeedDownLocal':
                return 'dimmingSpeedUpLocal';
            case 'rampRateOnToOffRemote':
                return 'rampRateOffToOnRemote';
            case 'rampRateOnToOffLocal':
                return 'rampRateOffToOnLocal';
            default:
                return null;
        }
    }

    function getEffectiveTimingValue(param, visited) {
        const cycleGuard = visited || new Set();
        if (cycleGuard.has(param)) {
            return clamp(toInt(getRawValue(param), 25), 0, 126);
        }
        cycleGuard.add(param);

        const rawValue = clamp(toInt(getRawValue(param), TIMING_DEFAULTS[param] ?? 25), 0, 127);
        if (rawValue !== 127) return clamp(rawValue, 0, 126);

        const parentParam = getTimingParentParam(param);
        if (!parentParam) return 25;
        return getEffectiveTimingValue(parentParam, cycleGuard);
    }

    function deriveLinkedState(group) {
        const remoteValue = getEffectiveTimingValue(group.remoteParam);
        const localValue = getEffectiveTimingValue(group.localParam);
        return remoteValue === localValue;
    }

    function hasPendingTimingChanges(group) {
        if (!stateApi || typeof stateApi.isPending !== 'function') return false;
        return !!(stateApi.isPending(group.remoteParam) || stateApi.isPending(group.localParam));
    }

    function getLinkedState(group) {
        if (Object.prototype.hasOwnProperty.call(linkPreferences, group.id)) {
            if (linkPreferences[group.id] && !hasPendingTimingChanges(group) && !deriveLinkedState(group)) {
                delete linkPreferences[group.id];
                return false;
            }
            return !!linkPreferences[group.id];
        }
        linkPreferences[group.id] = deriveLinkedState(group);
        return !!linkPreferences[group.id];
    }

    function getTimingGroup(groupOrId) {
        if (!groupOrId) return null;
        if (typeof groupOrId === 'object' && groupOrId.id) return groupOrId;
        return TIMING_GROUPS.find((group) => group.id === groupOrId) || null;
    }

    function getTimingGroupUiState(groupOrId) {
        const group = getTimingGroup(groupOrId);
        if (!group) return null;
        return {
            remoteValue: getEffectiveTimingValue(group.remoteParam),
            localValue: getEffectiveTimingValue(group.localParam),
            linked: getLinkedState(group),
        };
    }

    function setTimingInteractionDraft(groupOrId, roleKey, value) {
        const group = getTimingGroup(groupOrId);
        if (!group) return null;
        timingInteractionDrafts[group.id] = {
            roleKey: roleKey === 'local' ? 'local' : 'remote',
            value: clamp(toInt(value, 0), 0, 126),
            linked: getLinkedState(group),
        };
        return timingInteractionDrafts[group.id];
    }

    function clearTimingInteractionDraft(groupOrId) {
        const group = getTimingGroup(groupOrId);
        if (!group) return;
        delete timingInteractionDrafts[group.id];
    }

    function getTimingCardDisplayState(groupOrId) {
        const group = getTimingGroup(groupOrId);
        const state = getTimingGroupUiState(group);
        if (!group || !state) return null;

        const draft = timingInteractionDrafts[group.id];
        if (!draft) return state;

        if (draft.linked) {
            return {
                remoteValue: draft.value,
                localValue: draft.value,
                linked: true,
            };
        }

        return {
            remoteValue: draft.roleKey === 'remote' ? draft.value : state.remoteValue,
            localValue: draft.roleKey === 'local' ? draft.value : state.localValue,
            linked: false,
        };
    }

    function getExplicitTimingPayload(overrides) {
        const payload = {};
        const nextValues = overrides || {};
        TIMING_GROUPS.forEach((group) => {
            payload[group.remoteParam] = clamp(
                toInt(
                    Object.prototype.hasOwnProperty.call(nextValues, group.remoteParam)
                        ? nextValues[group.remoteParam]
                        : getEffectiveTimingValue(group.remoteParam),
                    0
                ),
                0,
                126
            );
            payload[group.localParam] = clamp(
                toInt(
                    Object.prototype.hasOwnProperty.call(nextValues, group.localParam)
                        ? nextValues[group.localParam]
                        : getEffectiveTimingValue(group.localParam),
                    0
                ),
                0,
                126
            );
        });
        return payload;
    }

    function applyTimingPayload(payload, visibleParams) {
        const entries = Object.entries(payload || {});
        const visibleSet = visibleParams instanceof Set ? visibleParams : new Set(Array.isArray(visibleParams) ? visibleParams : []);
        entries.forEach(([param, value]) => {
            setRawValue(param, value);
        });
        entries.forEach(([param, value]) => {
            stageChange(param, value, {
                hiddenFromCount: visibleSet.size > 0 && !visibleSet.has(param),
            });
        });
    }

    function setTimingGroupLinked(groupOrId, isLinked, preferredValue) {
        const group = getTimingGroup(groupOrId);
        if (!group) return null;

        const nextLinked = !!isLinked;
        linkPreferences[group.id] = nextLinked;
        if (!nextLinked) {
            applyTimingPayload(
                getExplicitTimingPayload(),
                new Set([group.remoteParam, group.localParam])
            );
            return getTimingGroupUiState(group);
        }

        const normalizedValue = clamp(
            toInt(
                preferredValue,
                getTimingGroupUiState(group)?.remoteValue ?? getEffectiveTimingValue(group.remoteParam)
            ),
            0,
            126
        );

        applyTimingPayload(
            getExplicitTimingPayload({
                [group.remoteParam]: normalizedValue,
                [group.localParam]: normalizedValue,
            }),
            new Set([group.remoteParam, group.localParam])
        );
        return getTimingGroupUiState(group);
    }

    function rawDefaultLevelToPercent(value) {
        const numeric = clamp(toInt(value, 0), 0, 254);
        return Math.round((numeric / 254) * 100);
    }

    function percentToRawDefaultLevel(value) {
        const numeric = clamp(toInt(value, 100), 0, 100);
        return clamp(Math.round((numeric / 100) * 254), 0, 254);
    }

    function getDefaultLevelState(param) {
        const rawValue = toInt(getRawValue(param), DEFAULT_LEVEL_DEFAULTS[param] ?? 255);
        if (rawValue >= 0 && rawValue <= 254) {
            lastManualDefaultLevels[param] = rawValue;
        }

        const isLastState = rawValue === 255;
        const manualRaw = lastManualDefaultLevels[param] ?? 254;
        return {
            rawValue: rawValue,
            isLastState: isLastState,
            manualRaw: manualRaw,
            percent: rawDefaultLevelToPercent(isLastState ? manualRaw : rawValue),
        };
    }

    function parseIndicatorOption(rawValue) {
        const value = String(rawValue == null ? INDICATOR_DEFAULT : rawValue).trim();
        const normalized = value.toLowerCase();
        if (!normalized || normalized === 'stay on') {
            return { enabled: true, seconds: 10, alwaysOn: true, label: 'Always on' };
        }
        if (normalized === 'stay off') {
            return { enabled: false, seconds: 3, alwaysOn: false, label: 'Off' };
        }
        const match = normalized.match(/(\d+)/);
        if (match) {
            const seconds = clamp(toInt(match[1], 3), 1, 10);
            return { enabled: true, seconds: seconds, alwaysOn: false, label: `${seconds}s` };
        }
        return { enabled: true, seconds: 3, alwaysOn: false, label: '3s' };
    }

    function getIndicatorFieldValues() {
        const field = getField('loadLevelIndicatorTimeout');
        return Array.isArray(field && field.values) ? field.values.slice() : [
            'Stay Off',
            '1 Second',
            '2 Seconds',
            '3 Seconds',
            '4 Seconds',
            '5 Seconds',
            '6 Seconds',
            '7 Seconds',
            '8 Seconds',
            '9 Seconds',
            '10 Seconds',
            'Stay On',
        ];
    }

    function composeIndicatorValue(enabled, seconds) {
        const options = getIndicatorFieldValues();
        if (!enabled) {
            return options.find((option) => String(option).toLowerCase().includes('stay off')) || 'Stay Off';
        }
        const numeric = clamp(toInt(seconds, 3), 1, 10);
        return options.find((option) => String(option).toLowerCase().includes(`${numeric}`)) || `${numeric} Seconds`;
    }

    function createElement(tagName, className, text) {
        const element = document.createElement(tagName);
        if (className) element.className = className;
        if (text !== undefined && text !== null) element.textContent = text;
        return element;
    }

    function createToggle(className, labelText) {
        const label = createElement('label', className);
        const input = document.createElement('input');
        input.type = 'checkbox';
        const slider = createElement('span', 'load-dimming-switch-track');
        label.appendChild(input);
        label.appendChild(slider);
        if (labelText) {
            label.appendChild(createElement('span', 'load-dimming-switch-text', labelText));
        }
        return { label, input };
    }

    function createTimingRow(group, roleKey, param, rowLabel) {
        const row = createElement('div', 'load-dimming-row');
        const label = createElement('div', 'load-dimming-row-label', rowLabel);
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '126';
        slider.step = '1';
        slider.className = 'load-dimming-slider';

        const value = createElement('div', 'load-dimming-row-value', '--');

        slider.addEventListener('input', () => {
            controlRefs.timing[group.id].lastEditedRole = roleKey;
            setTimingInteractionDraft(group, roleKey, slider.value);
            value.textContent = formatTimingValue(slider.value);
            if (getLinkedState(group)) {
                const peerRef = roleKey === 'remote' ? controlRefs.timing[group.id].local : controlRefs.timing[group.id].remote;
                peerRef.slider.value = slider.value;
                peerRef.value.textContent = formatTimingValue(slider.value);
            }
        });

        slider.addEventListener('change', () => {
            controlRefs.timing[group.id].lastEditedRole = roleKey;
            const selected = clamp(toInt(slider.value, 0), 0, 126);
            if (getLinkedState(group)) {
                applyTimingPayload(getExplicitTimingPayload({
                    [group.remoteParam]: selected,
                    [group.localParam]: selected,
                }), new Set([group.remoteParam, group.localParam]));
            } else {
                applyTimingPayload(getExplicitTimingPayload({
                    [param]: selected,
                }), new Set([param]));
            }
            clearTimingInteractionDraft(group);
            syncTimingCard(group);
        });

        row.appendChild(label);
        row.appendChild(slider);
        row.appendChild(value);
        return { row, slider, value };
    }

    function createTimingCard(group) {
        const card = createElement('section', 'load-dimming-card');
        const header = createElement('div', 'load-dimming-card-header');
        const title = createElement('div', 'load-dimming-card-title', group.title);
        const linkToggle = createToggle('load-dimming-inline-toggle', 'Linked');

        linkToggle.input.addEventListener('change', () => {
            const refs = controlRefs.timing[group.id];
            const sourceRole = refs.lastEditedRole === 'local' ? 'local' : 'remote';
            const sourceValue = refs[sourceRole] ? refs[sourceRole].slider.value : refs.remote.slider.value;
            setTimingGroupLinked(group, linkToggle.input.checked, sourceValue);
            syncTimingCard(group);
        });

        header.appendChild(title);
        header.appendChild(linkToggle.label);
        card.appendChild(header);

        const remote = createTimingRow(group, 'remote', group.remoteParam, 'Hub');
        const local = createTimingRow(group, 'local', group.localParam, 'Paddle');
        card.appendChild(remote.row);
        card.appendChild(local.row);

        controlRefs.timing[group.id] = {
            card,
            linkToggle: linkToggle.input,
            remote,
            local,
            lastEditedRole: 'remote',
        };

        return card;
    }

    function createDefaultLevelRow(definition) {
        const row = createElement('div', 'load-dimming-default-row');
        const top = createElement('div', 'load-dimming-default-top');
        const label = createElement('div', 'load-dimming-row-label', definition.label);
        const toggle = createToggle('load-dimming-inline-toggle load-dimming-inline-toggle-compact', 'Last state');
        top.appendChild(label);
        top.appendChild(toggle.label);

        const controls = createElement('div', 'load-dimming-default-controls');
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '100';
        slider.step = '1';
        slider.className = 'load-dimming-slider';

        const value = createElement('div', 'load-dimming-row-value', '--');

        slider.addEventListener('input', () => {
            value.textContent = `${clamp(toInt(slider.value, 0), 0, 100)}%`;
        });

        slider.addEventListener('change', () => {
            const rawValue = percentToRawDefaultLevel(slider.value);
            setRawValue(definition.param, rawValue);
            stageChange(definition.param, rawValue);
            syncDefaultLevelRow(definition.param);
        });

        toggle.input.addEventListener('change', () => {
            if (toggle.input.checked) {
                setRawValue(definition.param, 255);
                stageChange(definition.param, 255);
            } else {
                const restored = lastManualDefaultLevels[definition.param] ?? 254;
                setRawValue(definition.param, restored);
                stageChange(definition.param, restored);
            }
            syncDefaultLevelRow(definition.param);
        });

        controls.appendChild(slider);
        controls.appendChild(value);
        row.appendChild(top);
        row.appendChild(controls);

        controlRefs.defaultLevels[definition.param] = {
            row,
            slider,
            value,
            toggle: toggle.input,
        };

        return row;
    }

    function createIndicatorCard() {
        const card = createElement('section', 'load-dimming-card');
        const title = createElement('div', 'load-dimming-card-title', 'Level indicator timeout');
        const description = createElement('div', 'load-dimming-card-note', 'Show the LED bar after brightness changes.');
        const top = createElement('div', 'load-dimming-default-top');
        const toggle = createToggle('load-dimming-inline-toggle', null);
        top.appendChild(title);
        top.appendChild(toggle.label);

        const row = createElement('div', 'load-dimming-row');
        const label = createElement('div', 'load-dimming-row-label', 'Duration');
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '1';
        slider.max = '10';
        slider.step = '1';
        slider.className = 'load-dimming-slider';
        const value = createElement('div', 'load-dimming-row-value', '--');

        slider.addEventListener('input', () => {
            value.textContent = `${clamp(toInt(slider.value, 1), 1, 10)}s`;
        });

        slider.addEventListener('change', () => {
            const parsed = parseIndicatorOption(getRawValue('loadLevelIndicatorTimeout'));
            const nextValue = composeIndicatorValue(true, slider.value);
            setRawValue('loadLevelIndicatorTimeout', nextValue);
            stageChange('loadLevelIndicatorTimeout', nextValue);
            if (!parsed.enabled || parsed.alwaysOn) {
                toggle.input.checked = true;
            }
            syncIndicatorCard();
        });

        toggle.input.addEventListener('change', () => {
            const parsed = parseIndicatorOption(getRawValue('loadLevelIndicatorTimeout'));
            const nextValue = toggle.input.checked
                ? composeIndicatorValue(true, parsed.seconds || slider.value)
                : composeIndicatorValue(false, slider.value);
            setRawValue('loadLevelIndicatorTimeout', nextValue);
            stageChange('loadLevelIndicatorTimeout', nextValue);
            syncIndicatorCard();
        });

        row.appendChild(label);
        row.appendChild(slider);
        row.appendChild(value);

        card.appendChild(top);
        card.appendChild(description);
        card.appendChild(row);

        controlRefs.indicator = {
            card,
            toggle: toggle.input,
            slider,
            value,
            description,
        };

        return card;
    }

    function createDimmingMethodCard() {
        const card = createElement('section', 'load-dimming-card');
        const title = createElement('div', 'load-dimming-card-title', 'Dimming method');
        const description = createElement('div', 'load-dimming-card-note', 'This can only be changed at the switch.');
        const top = createElement('div', 'load-dimming-default-top');
        const methodPill = createElement('div', 'load-dimming-static-pill', '--');
        top.appendChild(title);
        top.appendChild(methodPill);
        card.appendChild(top);
        card.appendChild(description);

        controlRefs.dimmingMethod = {
            card,
            value: methodPill,
        };

        return card;
    }

    function createSection(titleText) {
        const section = createElement('section', 'load-dimming-section');
        section.appendChild(createElement('div', 'load-dimming-section-title', titleText));
        return section;
    }

    function hydrateFromStateApi() {
        if (!stateApi) return;
        const valueReader = typeof stateApi.getCurrentValue === 'function'
            ? stateApi.getCurrentValue.bind(stateApi)
            : (typeof stateApi.getLatestValue === 'function' ? stateApi.getLatestValue.bind(stateApi) : null);
        if (!valueReader) return;
        CONTROLLED_PARAMS.forEach((param) => {
            const currentValue = valueReader(param);
            if (currentValue !== undefined) {
                setRawValue(param, currentValue);
            }
        });
    }

    function stageChange(param, value, options) {
        if (!stateApi || typeof stateApi.queueChange !== 'function') return;
        stateApi.queueChange(param, value, null, options || null);
        if (typeof stateApi.setPacketStatus === 'function') {
            stateApi.setPacketStatus('info', 'Pending changes');
        }
    }

    function syncTimingCard(group) {
        const refs = controlRefs && controlRefs.timing ? controlRefs.timing[group.id] : null;
        if (!refs) return;
        const state = getTimingCardDisplayState(group);
        refs.linkToggle.checked = !!(state && state.linked);
        refs.remote.slider.value = String(state ? state.remoteValue : 0);
        refs.remote.value.textContent = formatTimingValue(state ? state.remoteValue : 0);
        refs.local.slider.value = String(state ? state.localValue : 0);
        refs.local.value.textContent = formatTimingValue(state ? state.localValue : 0);
    }

    function syncDefaultLevelRow(param) {
        const refs = controlRefs && controlRefs.defaultLevels ? controlRefs.defaultLevels[param] : null;
        if (!refs) return;
        const state = getDefaultLevelState(param);
        refs.toggle.checked = state.isLastState;
        refs.slider.disabled = state.isLastState;
        refs.slider.value = String(state.percent);
        refs.value.textContent = state.isLastState ? 'Last state' : `${state.percent}%`;
    }

    function syncIndicatorCard() {
        if (!controlRefs || !controlRefs.indicator) return;
        const parsed = parseIndicatorOption(getRawValue('loadLevelIndicatorTimeout'));
        controlRefs.indicator.toggle.checked = parsed.enabled;
        controlRefs.indicator.slider.disabled = !parsed.enabled;
        controlRefs.indicator.slider.value = String(parsed.seconds);
        controlRefs.indicator.value.textContent = parsed.alwaysOn ? 'Always on' : `${parsed.seconds}s`;
        controlRefs.indicator.description.textContent = parsed.alwaysOn
            ? 'Always show the LED bar. Advanced raw values remain available in the Advanced tab.'
            : 'Show the LED bar after brightness changes.';
    }

    function syncDimmingMethodCard() {
        if (!controlRefs || !controlRefs.dimmingMethod) return;
        const rawValue = getRawValue('dimmingMode');
        controlRefs.dimmingMethod.value.textContent = rawValue ? String(rawValue) : '--';
    }

    function syncAllCards() {
        TIMING_GROUPS.forEach(syncTimingCard);
        DEFAULT_LEVEL_ROWS.forEach((definition) => syncDefaultLevelRow(definition.param));
        syncIndicatorCard();
        syncDimmingMethodCard();
    }

    function registerSyncBindings() {
        clearSyncHandlers();
        if (!stateApi || typeof stateApi.registerSyncHandler !== 'function') return;
        CONTROLLED_PARAMS.forEach((param) => {
            const unsubscribe = stateApi.registerSyncHandler(param, (value) => {
                setRawValue(param, value);
                syncAllCards();
            });
            syncUnsubscribers.push(unsubscribe);
        });
    }

    function buildFriendlyLoadPage() {
        if (!containerEl) return;
        containerEl.innerHTML = '';
        containerEl.className = 'load-dimming-shell';

        const intro = createElement('div', 'load-dimming-intro');
        intro.textContent = 'Friendly controls for dimming behavior. Raw parameter values remain available in Advanced.';
        containerEl.appendChild(intro);

        const availabilityNote = createElement('div', 'schema-empty-note');
        availabilityNote.textContent = getIsDeviceSelected()
            ? 'Awaiting switch data...'
            : 'Select a device to configure load and dimming.';

        if (!getIsDeviceSelected()) {
            containerEl.appendChild(availabilityNote);
            controlRefs = null;
            return;
        }

        if (!hasFriendlyLoadSchema()) {
            availabilityNote.textContent = 'No load or dimming controls are available for this device.';
            containerEl.appendChild(availabilityNote);
            controlRefs = null;
            return;
        }

        const sections = new Map();
        ['Dim Speed', 'Ramp Speed (On / Off)', 'Default Level', 'Other Settings'].forEach((title) => {
            const section = createSection(title);
            sections.set(title, section);
            containerEl.appendChild(section);
        });

        controlRefs = {
            timing: {},
            defaultLevels: {},
            indicator: null,
            dimmingMethod: null,
        };

        TIMING_GROUPS.forEach((group) => {
            sections.get(group.section).appendChild(createTimingCard(group));
        });

        const defaultCard = createElement('section', 'load-dimming-card');
        DEFAULT_LEVEL_ROWS.forEach((definition) => {
            defaultCard.appendChild(createDefaultLevelRow(definition));
        });
        sections.get('Default Level').appendChild(defaultCard);

        sections.get('Other Settings').appendChild(createIndicatorCard());
        sections.get('Other Settings').appendChild(createDimmingMethodCard());

        syncAllCards();
    }

    function setSchemaModel(schemaModel) {
        const nextMap = {};
        const fields = schemaModel && Array.isArray(schemaModel.fields) ? schemaModel.fields : [];
        fields.forEach((field) => {
            if (field && field.name) nextMap[field.name] = field;
        });
        schemaFieldMap = nextMap;
        hydrateFromStateApi();
        buildFriendlyLoadPage();
        registerSyncBindings();
    }

    function resetForDeviceChange() {
        rawValues = {};
        linkPreferences = {};
        timingInteractionDrafts = {};
        lastManualDefaultLevels = {
            defaultLevelRemote: 254,
            defaultLevelLocal: 254,
        };
        controlRefs = null;
        if (containerEl) containerEl.innerHTML = '';
    }

    function activateDevice() {
        hydrateFromStateApi();
        buildFriendlyLoadPage();
    }

    function init(options) {
        const opts = options || {};
        containerEl = opts.containerEl || null;
        stateApi = opts.stateApi || null;
        isDeviceSelectedFn = typeof opts.isDeviceSelected === 'function' ? opts.isDeviceSelected : null;
        if (opts.schemaModel) {
            setSchemaModel(opts.schemaModel);
        } else if (containerEl) {
            buildFriendlyLoadPage();
        }
    }

    window.SwitchStudioLoadDimming = {
        init,
        setSchemaModel,
        resetForDeviceChange,
        activateDevice,
        __test__: {
            setRawValuesForTest: (values) => {
                rawValues = { ...(values || {}) };
            },
            getEffectiveTimingValue,
            parseIndicatorOption,
            composeIndicatorValue,
            rawDefaultLevelToPercent,
            percentToRawDefaultLevel,
            deriveLinkedState,
            getTimingGroupUiState,
            getTimingCardDisplayState,
            setTimingGroupLinked,
            getExplicitTimingPayload,
            setLinkPreferenceForTest: (groupId, linked) => {
                linkPreferences[groupId] = !!linked;
            },
            setTimingInteractionDraftForTest: (groupId, roleKey, value) => {
                setTimingInteractionDraft(groupId, roleKey, value);
            },
            clearTimingInteractionDraftForTest: (groupId) => {
                clearTimingInteractionDraft(groupId);
            },
            hydrateFromStateApiForTest: (api) => {
                stateApi = api || null;
                hydrateFromStateApi();
            },
            getRawValueForTest: (param) => rawValues[param],
        },
    };
})();
