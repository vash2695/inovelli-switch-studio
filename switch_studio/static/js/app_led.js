(function () {
    const GLOBAL_FIELDS = Object.freeze({
        on: Object.freeze({ color: 'ledColorWhenOn', intensity: 'ledIntensityWhenOn' }),
        off: Object.freeze({ color: 'ledColorWhenOff', intensity: 'ledIntensityWhenOff' }),
    });

    const GLOBAL_FIELD_NAMES = Object.freeze([
        'ledColorWhenOn',
        'ledColorWhenOff',
        'ledIntensityWhenOn',
        'ledIntensityWhenOff',
    ]);

    const SEGMENT_FIELD_NAMES = Object.freeze(
        Array.from({ length: 7 }, (_, index) => index + 1).flatMap((segment) => [
            `defaultLed${segment}ColorWhenOn`,
            `defaultLed${segment}ColorWhenOff`,
            `defaultLed${segment}IntensityWhenOn`,
            `defaultLed${segment}IntensityWhenOff`,
        ])
    );

    const FIELD_NAMES = Object.freeze(GLOBAL_FIELD_NAMES.concat(SEGMENT_FIELD_NAMES));
    const OWNED_FIELDS = new Set(FIELD_NAMES);
    const SEGMENTS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);

    const GLOBAL_PRESETS = Object.freeze([
        Object.freeze({ name: 'White', value: 255 }),
        Object.freeze({ name: 'Red', value: 0 }),
        Object.freeze({ name: 'Orange', value: 21 }),
        Object.freeze({ name: 'Yellow', value: 42 }),
        Object.freeze({ name: 'Green', value: 85 }),
        Object.freeze({ name: 'Cyan', value: 127 }),
        Object.freeze({ name: 'Blue', value: 170 }),
        Object.freeze({ name: 'Violet', value: 212 }),
        Object.freeze({ name: 'Pink', value: 234 }),
    ]);

    // Per-segment firmware values differ from the all-LED color parameter:
    // 0 is white, 1 is the red end of the hue range, and 255 follows the default.
    const SEGMENT_PRESETS = Object.freeze([
        Object.freeze({ name: 'White', value: 0 }),
        Object.freeze({ name: 'Red', value: 1 }),
        Object.freeze({ name: 'Orange', value: 21 }),
        Object.freeze({ name: 'Yellow', value: 42 }),
        Object.freeze({ name: 'Green', value: 85 }),
        Object.freeze({ name: 'Cyan', value: 127 }),
        Object.freeze({ name: 'Blue', value: 170 }),
        Object.freeze({ name: 'Violet', value: 212 }),
        Object.freeze({ name: 'Pink', value: 234 }),
        Object.freeze({ name: 'Follow', value: 255 }),
    ]);

    let containerEl = null;
    let stateApi = null;
    let isDeviceSelectedFn = null;
    let activeTopic = null;
    let schemaActive = false;
    let rawValues = {};
    let interactionDrafts = new Map();
    let syncUnsubscribers = [];
    let lastNonZeroIntensity = {};
    let lastHueByParam = {};
    let activeContext = 'on';
    let selectedSegment = null;
    let popoverOpener = null;
    let controlRefs = null;
    let documentListenersBound = false;
    let interactionGeneration = 0;

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function toInt(value, fallback) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function normalizeHue(hue) {
        const numeric = Number(hue);
        if (!Number.isFinite(numeric)) return 0;
        return ((numeric % 360) + 360) % 360;
    }

    function globalHueToRaw(hue) {
        return clamp(Math.round((normalizeHue(hue) / 360) * 255), 0, 254);
    }

    function segmentHueToRaw(hue) {
        return clamp(Math.round((normalizeHue(hue) / 360) * 255), 1, 254);
    }

    function globalRawToHue(rawValue) {
        const raw = clamp(toInt(rawValue, 0), 0, 254);
        return normalizeHue((raw / 255) * 360);
    }

    function segmentRawToHue(rawValue) {
        const raw = clamp(toInt(rawValue, 1), 1, 254);
        if (raw === 1) return 0;
        return normalizeHue((raw / 255) * 360);
    }

    function globalColorToSegmentRaw(globalRaw) {
        const raw = clamp(toInt(globalRaw, 0), 0, 255);
        if (raw === 255) return 0;
        if (raw === 0) return 1;
        return clamp(raw, 1, 254);
    }

    function segmentFields(segment, context) {
        const normalizedSegment = clamp(toInt(segment, 1), 1, 7);
        const suffix = context === 'off' ? 'Off' : 'On';
        return {
            color: `defaultLed${normalizedSegment}ColorWhen${suffix}`,
            intensity: `defaultLed${normalizedSegment}IntensityWhen${suffix}`,
        };
    }

    function segmentPositionLabel(segment) {
        const positions = {
            1: 'bottom',
            2: 'second from bottom',
            3: 'third from bottom',
            4: 'middle',
            5: 'third from top',
            6: 'second from top',
            7: 'top',
        };
        return positions[clamp(toInt(segment, 1), 1, 7)];
    }

    function expectedMaxForField(name) {
        if (GLOBAL_FIELDS.on.intensity === name || GLOBAL_FIELDS.off.intensity === name) return 100;
        if (/^defaultLed[1-7]IntensityWhen(On|Off)$/.test(name)) return 101;
        return 255;
    }

    function hasFullSchemaCapability(schema) {
        const fields = schema && Array.isArray(schema.fields) ? schema.fields : [];
        const byName = {};
        fields.forEach((field) => {
            if (field && field.name) byName[field.name] = field;
        });

        return FIELD_NAMES.every((name) => {
            const field = byName[name];
            if (!field || field.type !== 'numeric' || field.can_write !== true) return false;
            return Number(field.value_min) === 0 && Number(field.value_max) === expectedMaxForField(name);
        });
    }

    function getIsDeviceSelected() {
        return typeof isDeviceSelectedFn === 'function' ? !!isDeviceSelectedFn() : true;
    }

    function isGlobalColorParam(param) {
        return param === GLOBAL_FIELDS.on.color || param === GLOBAL_FIELDS.off.color;
    }

    function isSegmentColorParam(param) {
        return /^defaultLed[1-7]ColorWhen(On|Off)$/.test(String(param || ''));
    }

    function isIntensityParam(param) {
        return /IntensityWhen(On|Off)$/.test(String(param || ''));
    }

    function defaultRawValue(param) {
        if (param === GLOBAL_FIELDS.on.color || param === GLOBAL_FIELDS.off.color) return 170;
        if (param === GLOBAL_FIELDS.on.intensity || param === GLOBAL_FIELDS.off.intensity) return 100;
        if (isSegmentColorParam(param)) return 255;
        if (isIntensityParam(param)) return 101;
        return 0;
    }

    function normalizeRawValue(param, value) {
        const fallback = defaultRawValue(param);
        const numeric = toInt(value, fallback);
        return clamp(numeric, 0, expectedMaxForField(param));
    }

    function rememberRawValue(param, value) {
        const normalized = normalizeRawValue(param, value);
        rawValues[param] = normalized;

        if (isIntensityParam(param) && normalized > 0) {
            lastNonZeroIntensity[param] = normalized;
        }
        if (isGlobalColorParam(param) && normalized >= 0 && normalized <= 254) {
            lastHueByParam[param] = globalRawToHue(normalized);
        }
        if (isSegmentColorParam(param) && normalized >= 1 && normalized <= 254) {
            lastHueByParam[param] = segmentRawToHue(normalized);
        }
        return normalized;
    }

    function getRawValue(param) {
        if (interactionDrafts.has(param)) return interactionDrafts.get(param);
        if (Object.prototype.hasOwnProperty.call(rawValues, param)) return rawValues[param];
        return defaultRawValue(param);
    }

    function cancelInteractionDrafts() {
        interactionGeneration += 1;
        interactionDrafts.clear();
    }

    function colorCssFromGlobalRaw(rawValue) {
        const raw = clamp(toInt(rawValue, 0), 0, 255);
        if (raw === 255) return '#ffffff';
        return `hsl(${globalRawToHue(raw).toFixed(1)} 100% 50%)`;
    }

    function colorCssFromSegmentRaw(rawValue, globalRaw) {
        const raw = clamp(toInt(rawValue, 255), 0, 255);
        if (raw === 255) return colorCssFromGlobalRaw(globalRaw);
        if (raw === 0) return '#ffffff';
        return `hsl(${segmentRawToHue(raw).toFixed(1)} 100% 50%)`;
    }

    function globalColorDescription(rawValue) {
        const raw = clamp(toInt(rawValue, 0), 0, 255);
        const preset = GLOBAL_PRESETS.find((entry) => entry.value === raw);
        if (preset) return preset.name;
        return `custom hue ${Math.round(globalRawToHue(raw))} degrees`;
    }

    function segmentColorDescription(rawValue, globalRaw) {
        const raw = clamp(toInt(rawValue, 255), 0, 255);
        if (raw === 255) return `${globalColorDescription(globalRaw)} from the all-LED default`;
        const preset = SEGMENT_PRESETS.find((entry) => entry.value === raw);
        if (preset) return preset.name;
        return `custom hue ${Math.round(segmentRawToHue(raw))} degrees`;
    }

    function getEffectiveSegmentState(segment, context) {
        const normalizedContext = context === 'off' ? 'off' : 'on';
        const globalFields = GLOBAL_FIELDS[normalizedContext];
        const fields = segmentFields(segment, normalizedContext);
        const globalColorRaw = getRawValue(globalFields.color);
        const globalIntensityRaw = clamp(getRawValue(globalFields.intensity), 0, 100);
        const colorRaw = getRawValue(fields.color);
        const intensityRaw = getRawValue(fields.intensity);
        const effectiveIntensity = intensityRaw === 101 ? globalIntensityRaw : clamp(intensityRaw, 0, 100);

        return {
            segment: clamp(toInt(segment, 1), 1, 7),
            context: normalizedContext,
            colorParam: fields.color,
            intensityParam: fields.intensity,
            colorRaw,
            intensityRaw,
            globalColorRaw,
            globalIntensityRaw,
            effectiveColorRaw: colorRaw === 255 ? globalColorRaw : colorRaw,
            effectiveIntensity,
            colorCss: colorCssFromSegmentRaw(colorRaw, globalColorRaw),
            followsColor: colorRaw === 255,
            followsIntensity: intensityRaw === 101,
            customized: colorRaw !== 255 || intensityRaw !== 101,
            lit: effectiveIntensity > 0,
        };
    }

    function createElement(tagName, className, text) {
        const element = document.createElement(tagName);
        if (className) element.className = className;
        if (text !== undefined && text !== null) element.textContent = text;
        return element;
    }

    function setStyleProperty(element, property, value) {
        if (!element || !element.style) return;
        if (typeof element.style.setProperty === 'function') element.style.setProperty(property, value);
        else element.style[property] = value;
    }

    function createSvgElement(tagName, attributes) {
        const element = typeof document.createElementNS === 'function'
            ? document.createElementNS('http://www.w3.org/2000/svg', tagName)
            : document.createElement(tagName);
        Object.entries(attributes || {}).forEach(([name, value]) => element.setAttribute(name, String(value)));
        return element;
    }

    function createToggle(className, labelText) {
        const input = createElement('button', className || 'led-toggle');
        input.type = 'button';
        input.setAttribute('role', 'switch');
        input.setAttribute('aria-checked', 'false');
        input.checked = false;
        const track = createElement('span', 'led-toggle-track');
        const text = createElement('span', 'led-toggle-text', labelText);
        input.appendChild(text);
        input.appendChild(track);
        return { label: input, input, text };
    }

    function getColorParam(scope) {
        if (scope === 'global') return GLOBAL_FIELDS[activeContext].color;
        if (!selectedSegment) return null;
        return segmentFields(selectedSegment, activeContext).color;
    }

    function getIntensityParam(scope) {
        if (scope === 'global') return GLOBAL_FIELDS[activeContext].intensity;
        if (!selectedSegment) return null;
        return segmentFields(selectedSegment, activeContext).intensity;
    }

    function rawColorToHueForScope(scope, rawValue, param) {
        const raw = toInt(rawValue, scope === 'global' ? 0 : 1);
        if (scope === 'global' && raw >= 0 && raw <= 254) return globalRawToHue(raw);
        if (scope === 'segment' && raw >= 1 && raw <= 254) return segmentRawToHue(raw);
        return Object.prototype.hasOwnProperty.call(lastHueByParam, param) ? lastHueByParam[param] : 0;
    }

    function hueToRawForScope(scope, hue) {
        return scope === 'global' ? globalHueToRaw(hue) : segmentHueToRaw(hue);
    }

    function setInteractionDraft(param, value, generation) {
        if (!param || (generation !== undefined && generation !== interactionGeneration)) return false;
        interactionDrafts.set(param, normalizeRawValue(param, value));
        renderAll();
        return true;
    }

    function clearInteractionDraft(param, generation) {
        if (generation !== undefined && generation !== interactionGeneration) return false;
        if (param) interactionDrafts.delete(param);
        renderAll();
        return true;
    }

    function stageChanges(changes) {
        const entries = Object.entries(changes || {}).filter(([param]) => OWNED_FIELDS.has(param));
        if (entries.length === 0) return;

        entries.forEach(([param, value]) => {
            const normalized = rememberRawValue(param, value);
            interactionDrafts.delete(param);
            if (stateApi && typeof stateApi.queueChange === 'function') {
                stateApi.queueChange(param, normalized, null);
            }
        });

        if (stateApi && typeof stateApi.setPacketStatus === 'function') {
            stateApi.setPacketStatus('info', 'Pending changes');
        }
        renderAll();
    }

    function commitInteractionDraft(param, generation) {
        if (
            !param ||
            (generation !== undefined && generation !== interactionGeneration) ||
            !interactionDrafts.has(param)
        ) return false;
        const value = interactionDrafts.get(param);
        interactionDrafts.delete(param);
        stageChanges({ [param]: value });
        return true;
    }

    function createHueWheel(scope) {
        const wheel = createElement('div', 'led-hue-wheel');
        wheel.tabIndex = 0;
        wheel.setAttribute('role', 'slider');
        wheel.setAttribute('aria-valuemin', '0');
        wheel.setAttribute('aria-valuemax', '359');
        wheel.setAttribute('aria-label', scope === 'global' ? 'All LEDs hue' : 'Segment hue');
        wheel.style.background = 'conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)';
        const marker = createElement('span', 'led-hue-marker');
        wheel.appendChild(marker);

        let pointerActive = false;
        let pointerParam = null;
        let pointerGeneration = null;
        let keyboardActive = false;
        let keyboardParam = null;
        let keyboardGeneration = null;

        function setDraftHue(hue, param, generation) {
            if (!param || generation !== interactionGeneration) return false;
            const normalizedHue = normalizeHue(hue);
            lastHueByParam[param] = normalizedHue;
            return setInteractionDraft(param, hueToRawForScope(scope, normalizedHue), generation);
        }

        function hueFromPointer(event) {
            const rect = typeof wheel.getBoundingClientRect === 'function'
                ? wheel.getBoundingClientRect()
                : { left: 0, top: 0, width: 100, height: 100 };
            const centerX = rect.left + (rect.width / 2);
            const centerY = rect.top + (rect.height / 2);
            const radians = Math.atan2(Number(event.clientY || 0) - centerY, Number(event.clientX || 0) - centerX);
            return normalizeHue((radians * 180 / Math.PI) + 90);
        }

        wheel.addEventListener('pointerdown', (event) => {
            if (wheel.getAttribute('aria-disabled') === 'true') return;
            pointerParam = getColorParam(scope);
            if (!pointerParam) return;
            pointerGeneration = interactionGeneration;
            pointerActive = true;
            if (typeof wheel.setPointerCapture === 'function' && event.pointerId !== undefined) {
                wheel.setPointerCapture(event.pointerId);
            }
            if (typeof event.preventDefault === 'function') event.preventDefault();
            setDraftHue(hueFromPointer(event), pointerParam, pointerGeneration);
        });
        wheel.addEventListener('pointermove', (event) => {
            if (!pointerActive) return;
            if (pointerGeneration !== interactionGeneration) {
                pointerActive = false;
                return;
            }
            setDraftHue(hueFromPointer(event), pointerParam, pointerGeneration);
        });
        wheel.addEventListener('pointerup', (event) => {
            if (!pointerActive) return;
            pointerActive = false;
            if (pointerGeneration !== interactionGeneration) return;
            setDraftHue(hueFromPointer(event), pointerParam, pointerGeneration);
            commitInteractionDraft(pointerParam, pointerGeneration);
            pointerParam = null;
            pointerGeneration = null;
        });
        wheel.addEventListener('pointercancel', () => {
            pointerActive = false;
            clearInteractionDraft(pointerParam, pointerGeneration);
            pointerParam = null;
            pointerGeneration = null;
        });

        wheel.addEventListener('keydown', (event) => {
            const key = event.key;
            const supported = ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'];
            if (!supported.includes(key) || wheel.getAttribute('aria-disabled') === 'true') return;
            if (typeof event.preventDefault === 'function') event.preventDefault();
            if (!keyboardActive) {
                keyboardParam = getColorParam(scope);
                keyboardGeneration = interactionGeneration;
            }
            if (!keyboardParam || keyboardGeneration !== interactionGeneration) {
                keyboardActive = false;
                return;
            }
            const current = rawColorToHueForScope(scope, getRawValue(keyboardParam), keyboardParam);
            let next = current;
            if (key === 'ArrowLeft' || key === 'ArrowDown') next -= 1;
            if (key === 'ArrowRight' || key === 'ArrowUp') next += 1;
            if (key === 'PageDown') next -= 15;
            if (key === 'PageUp') next += 15;
            if (key === 'Home') next = 0;
            if (key === 'End') next = 359;
            keyboardActive = true;
            setDraftHue(next, keyboardParam, keyboardGeneration);
        });
        wheel.addEventListener('keyup', (event) => {
            if (!keyboardActive || !String(event.key || '').match(/^(Arrow|Page|Home|End)/)) return;
            keyboardActive = false;
            commitInteractionDraft(keyboardParam, keyboardGeneration);
            keyboardParam = null;
            keyboardGeneration = null;
        });
        wheel.addEventListener('blur', () => {
            if (!keyboardActive) return;
            keyboardActive = false;
            commitInteractionDraft(keyboardParam, keyboardGeneration);
            keyboardParam = null;
            keyboardGeneration = null;
        });

        return { wheel, marker, scope };
    }

    function createPresetGrid(scope) {
        const group = createElement('div', 'led-preset-grid');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', scope === 'global' ? 'All LEDs color presets' : 'Segment color presets');
        const presets = scope === 'global' ? GLOBAL_PRESETS : SEGMENT_PRESETS;
        const buttons = [];
        presets.forEach((preset) => {
            const button = createElement('button', 'led-color-preset', preset.name);
            button.type = 'button';
            button.setAttribute('aria-label', preset.name);
            button.title = preset.name;
            button.classList.toggle('is-follow-default', scope === 'segment' && preset.value === 255);
            const css = scope === 'global'
                ? colorCssFromGlobalRaw(preset.value)
                : colorCssFromSegmentRaw(preset.value, 0);
            setStyleProperty(button, '--led-preset-color', css);
            button.addEventListener('click', () => {
                const param = getColorParam(scope);
                if (param) stageChanges({ [param]: preset.value });
            });
            group.appendChild(button);
            buttons.push({ button, preset });
        });
        return { group, buttons, scope };
    }

    function createBrightnessControl(scope) {
        const row = createElement('div', 'led-brightness-row');
        const label = createElement('label', 'led-editor-section-label');
        label.style.display = 'grid';
        label.style.gap = '6px';
        label.appendChild(createElement('span', null, 'Brightness'));
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '1';
        slider.max = '100';
        slider.step = '1';
        slider.className = 'led-brightness-slider';
        slider.setAttribute('aria-label', scope === 'global' ? 'All LEDs brightness' : 'Segment brightness');
        const value = createElement('span', 'led-value', '--');
        let gestureParam = null;
        let gestureGeneration = null;

        function beginGesture() {
            gestureParam = getIntensityParam(scope);
            gestureGeneration = interactionGeneration;
        }

        slider.addEventListener('pointerdown', beginGesture);
        slider.addEventListener('keydown', () => {
            if (!gestureParam) beginGesture();
        });

        slider.addEventListener('input', () => {
            if (!gestureParam) beginGesture();
            if (gestureGeneration !== interactionGeneration) return;
            setInteractionDraft(gestureParam, clamp(toInt(slider.value, 1), 1, 100), gestureGeneration);
        });
        slider.addEventListener('change', () => {
            if (!gestureParam || gestureGeneration !== interactionGeneration) {
                gestureParam = null;
                gestureGeneration = null;
                return;
            }
            setInteractionDraft(gestureParam, clamp(toInt(slider.value, 1), 1, 100), gestureGeneration);
            commitInteractionDraft(gestureParam, gestureGeneration);
            gestureParam = null;
            gestureGeneration = null;
        });
        slider.addEventListener('pointercancel', () => {
            clearInteractionDraft(gestureParam, gestureGeneration);
            gestureParam = null;
            gestureGeneration = null;
        });

        label.appendChild(slider);
        row.appendChild(label);
        row.appendChild(value);
        return { row, slider, value, scope };
    }

    function createColorControls(scope) {
        const controls = createElement('div', 'led-conditional-controls');
        controls.appendChild(createElement('div', 'led-editor-section-label', 'Color'));
        const presets = createPresetGrid(scope);
        controls.appendChild(presets.group);
        const hueRow = createElement('div', 'led-hue-row');
        const wheel = createHueWheel(scope);
        hueRow.appendChild(wheel.wheel);
        hueRow.appendChild(createElement('span', 'led-editor-note', 'Drag or use arrow keys for a custom hue.'));
        controls.appendChild(hueRow);
        const brightness = createBrightnessControl(scope);
        controls.appendChild(brightness.row);
        return { controls, presets, wheel, brightness };
    }

    function createSwitchArt() {
        const stage = createElement('div', 'led-switch-stage');
        stage.setAttribute('role', 'group');
        stage.setAttribute('aria-label', 'VZM32-SN LED bar preview. LED 1 is the bottom segment and LED 7 is the top segment.');
        const art = createElement('div', 'led-switch-art');
        const svg = createSvgElement('svg', {
            class: 'led-switch-svg',
            viewBox: '0 0 240 480',
            'aria-hidden': 'true',
            focusable: 'false',
        });

        svg.appendChild(createSvgElement('rect', {
            class: 'led-switch-body', x: 2, y: 4, width: 236, height: 470, rx: 16,
            fill: '#f2f1ed', stroke: '#cbc9c2', 'stroke-width': 2,
        }));
        svg.appendChild(createSvgElement('rect', {
            class: 'led-switch-paddle', x: 17, y: 20, width: 185, height: 431, rx: 3,
            fill: '#f7f6f2', stroke: '#d8d6cf', 'stroke-width': 1.5,
        }));
        svg.appendChild(createSvgElement('rect', {
            class: 'led-switch-config-button', x: 212, y: 19, width: 15, height: 60, rx: 3,
            fill: '#ecebe6', stroke: '#c7c5be', 'stroke-width': 1.5,
        }));
        svg.appendChild(createSvgElement('circle', {
            class: 'led-switch-lux-lens', cx: 219, cy: 105, r: 6,
            fill: '#3a4650', stroke: '#202930', 'stroke-width': 1,
        }));
        svg.appendChild(createSvgElement('rect', {
            class: 'led-switch-diffuser', x: 212, y: 132, width: 14, height: 321, rx: 2,
            fill: '#10161b', stroke: '#070a0d', 'stroke-width': 1,
        }));
        svg.appendChild(createSvgElement('rect', {
            class: 'led-switch-air-gap', x: 43, y: 450, width: 56, height: 24, rx: 2,
            fill: '#c9c8c2', stroke: '#a9a7a0', 'stroke-width': 1.5,
        }));

        art.appendChild(svg);
        const segmentButtons = {};
        // DOM and visual order are top-to-bottom, while firmware numbering is bottom-up.
        [7, 6, 5, 4, 3, 2, 1].forEach((segment, visualIndex) => {
            const button = createElement('button', 'led-segment-hit', String(segment));
            button.type = 'button';
            button.setAttribute('aria-label', `LED segment ${segment}`);
            button.setAttribute('aria-haspopup', 'dialog');
            button.setAttribute('aria-expanded', 'false');
            button.setAttribute('aria-controls', 'ledSegmentPopover');
            button.setAttribute('data-led-segment', String(segment));
            button.style.position = 'absolute';
            button.style.top = `${((132 + (visualIndex * (321 / 7))) / 480) * 100}%`;
            button.style.height = `${((321 / 7) / 480) * 100}%`;
            button.addEventListener('click', () => openSegmentEditor(segment, button));
            button.addEventListener('keydown', (event) => handleSegmentArrowKey(event, segment));
            art.appendChild(button);
            segmentButtons[segment] = button;
        });

        stage.appendChild(art);
        return { stage, art, svg, segmentButtons };
    }

    function createContextSelector() {
        const selector = createElement('div', 'led-editor-context');
        selector.appendChild(createElement('span', 'led-editor-section-label', 'Preview state'));
        const controls = createElement('div', 'led-editor-context-controls');
        controls.setAttribute('role', 'group');
        controls.setAttribute('aria-label', 'LED preview state');
        const buttons = {};
        [['on', 'On'], ['off', 'Off']].forEach(([context, label]) => {
            const button = createElement('button', 'led-editor-context-btn', label);
            button.type = 'button';
            button.setAttribute('aria-pressed', 'false');
            button.addEventListener('click', () => setPreviewContext(context));
            button.addEventListener('keydown', (event) => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                if (typeof event.preventDefault === 'function') event.preventDefault();
                const nextContext = event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'Home'
                    ? 'on'
                    : 'off';
                setPreviewContext(nextContext);
                if (buttons[nextContext] && typeof buttons[nextContext].focus === 'function') buttons[nextContext].focus();
            });
            controls.appendChild(button);
            buttons[context] = button;
        });
        selector.appendChild(controls);
        return { selector, controls, buttons };
    }

    function createGlobalPanel() {
        const panel = createElement('section', 'led-global-panel');
        const header = createElement('div', 'led-control-header');
        const headingGroup = createElement('div');
        headingGroup.appendChild(createElement('h3', 'led-control-title', 'All-LED defaults'));
        const context = createElement('div', 'led-control-context', 'On state');
        headingGroup.appendChild(context);
        const lit = createToggle('led-toggle', 'Bar lit');
        lit.input.addEventListener('click', () => {
            lit.input.checked = !lit.input.checked;
            setGlobalLit(lit.input.checked);
        });
        header.appendChild(headingGroup);
        header.appendChild(lit.label);
        panel.appendChild(header);
        panel.appendChild(createElement('p', 'led-editor-note', 'Segments can follow these defaults or use their own settings.'));
        const controls = createColorControls('global');
        panel.appendChild(controls.controls);
        return { panel, context, lit, ...controls };
    }

    function createSegmentPopover() {
        const popover = createElement('div', 'led-segment-popover');
        popover.id = 'ledSegmentPopover';
        popover.hidden = true;
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-modal', 'false');
        popover.setAttribute('aria-labelledby', 'ledSegmentPopoverTitle');

        const header = createElement('div', 'led-popover-header');
        const title = createElement('h3', 'led-popover-title', 'LED segment');
        title.id = 'ledSegmentPopoverTitle';
        const close = createElement('button', 'led-popover-close', '\u00d7');
        close.type = 'button';
        close.setAttribute('aria-label', 'Close segment editor');
        close.addEventListener('click', () => closeEditor());
        header.appendChild(title);
        header.appendChild(close);
        popover.appendChild(header);

        const note = createElement('p', 'led-popover-note');
        popover.appendChild(note);

        const customize = createToggle('led-toggle led-customize-row', 'Customize for this state');
        customize.input.addEventListener('click', () => {
            customize.input.checked = !customize.input.checked;
            if (selectedSegment) setSegmentCustomized(selectedSegment, customize.input.checked);
        });
        popover.appendChild(customize.label);

        const lit = createToggle('led-toggle', 'Segment lit');
        lit.input.addEventListener('click', () => {
            lit.input.checked = !lit.input.checked;
            if (selectedSegment) setSegmentLit(selectedSegment, lit.input.checked);
        });
        popover.appendChild(lit.label);

        const followIntensity = createToggle('led-toggle led-follow-intensity', 'Follow all-LED brightness');
        followIntensity.input.addEventListener('click', () => {
            followIntensity.input.checked = !followIntensity.input.checked;
            if (selectedSegment) setSegmentIntensityFollow(selectedSegment, followIntensity.input.checked);
        });
        popover.appendChild(followIntensity.label);

        const controls = createColorControls('segment');
        popover.appendChild(controls.controls);
        return { popover, header, title, close, note, customize, lit, followIntensity, ...controls };
    }

    function buildEditor() {
        if (!containerEl || !schemaActive || controlRefs) return;
        containerEl.innerHTML = '';
        containerEl.classList.add('led-editor-shell');
        containerEl.setAttribute('role', 'region');
        containerEl.setAttribute('aria-label', 'VZM32-SN LED bar editor');

        const context = createContextSelector();
        containerEl.appendChild(context.selector);

        const layout = createElement('div', 'led-editor-layout');
        const switchArt = createSwitchArt();
        const globalPanel = createGlobalPanel();
        const popover = createSegmentPopover();
        switchArt.stage.appendChild(popover.popover);
        layout.appendChild(switchArt.stage);
        layout.appendChild(globalPanel.panel);
        containerEl.appendChild(layout);

        controlRefs = {
            context,
            layout,
            switchArt,
            global: globalPanel,
            popover,
        };
        bindDocumentListeners();
        renderAll();
    }

    function removeEditorDom() {
        closeEditor({ restoreFocus: false });
        controlRefs = null;
        if (containerEl) {
            containerEl.innerHTML = '';
            if (containerEl.classList && typeof containerEl.classList.remove === 'function') {
                containerEl.classList.remove('led-editor-shell');
            }
        }
    }

    function setPreviewContext(context) {
        cancelInteractionDrafts();
        activeContext = context === 'off' ? 'off' : 'on';
        renderAll();
    }

    function setGlobalLit(lit) {
        const param = GLOBAL_FIELDS[activeContext].intensity;
        const current = getRawValue(param);
        if (!lit) {
            if (current > 0) lastNonZeroIntensity[param] = current;
            stageChanges({ [param]: 0 });
            return;
        }
        let restored = lastNonZeroIntensity[param];
        if (!Number.isFinite(Number(restored)) || Number(restored) <= 0) restored = 100;
        stageChanges({ [param]: clamp(toInt(restored, 100), 1, 100) });
    }

    function setSegmentCustomized(segment, customized) {
        const fields = segmentFields(segment, activeContext);
        const current = getEffectiveSegmentState(segment, activeContext);
        if (!customized) {
            stageChanges({ [fields.color]: 255, [fields.intensity]: 101 });
            return;
        }
        if (current.customized) {
            renderAll();
            return;
        }
        stageChanges({
            [fields.color]: globalColorToSegmentRaw(current.globalColorRaw),
            [fields.intensity]: clamp(current.globalIntensityRaw, 0, 100),
        });
    }

    function setSegmentLit(segment, lit) {
        const state = getEffectiveSegmentState(segment, activeContext);
        const param = state.intensityParam;
        if (!lit) {
            if (state.effectiveIntensity > 0) lastNonZeroIntensity[param] = state.intensityRaw;
            stageChanges({ [param]: 0 });
            return;
        }

        let restored = lastNonZeroIntensity[param];
        if (!Number.isFinite(Number(restored)) || Number(restored) <= 0) {
            restored = state.globalIntensityRaw > 0 ? 101 : 100;
        }
        if (Number(restored) === 101 && state.globalIntensityRaw <= 0) restored = 100;
        stageChanges({ [param]: clamp(toInt(restored, 100), 1, 101) });
    }

    function setSegmentIntensityFollow(segment, followsDefault) {
        const state = getEffectiveSegmentState(segment, activeContext);
        if (followsDefault) {
            stageChanges({ [state.intensityParam]: 101 });
            return;
        }
        const restored = state.globalIntensityRaw > 0 ? state.globalIntensityRaw : 100;
        stageChanges({ [state.intensityParam]: clamp(toInt(restored, 100), 1, 100) });
    }

    function commitHue(scope, hue) {
        const param = getColorParam(scope);
        if (!param) return;
        const normalizedHue = normalizeHue(hue);
        lastHueByParam[param] = normalizedHue;
        stageChanges({ [param]: hueToRawForScope(scope, normalizedHue) });
    }

    function commitBrightness(scope, value) {
        const param = getIntensityParam(scope);
        if (!param) return;
        stageChanges({ [param]: clamp(toInt(value, 1), 1, 100) });
    }

    function selectPreset(scope, value) {
        const param = getColorParam(scope);
        if (!param) return;
        stageChanges({ [param]: clamp(toInt(value, 0), 0, 255) });
    }

    function openSegmentEditor(segment, opener) {
        if (!schemaActive || !getIsDeviceSelected()) return;
        selectedSegment = clamp(toInt(segment, 1), 1, 7);
        popoverOpener = opener || (controlRefs && controlRefs.switchArt.segmentButtons[selectedSegment]);
        renderAll();
        if (controlRefs && controlRefs.popover && controlRefs.popover.customize.input) {
            controlRefs.popover.customize.input.focus();
        }
    }

    function closeEditor(options) {
        const opts = options || {};
        cancelInteractionDrafts();
        const opener = popoverOpener;
        selectedSegment = null;
        popoverOpener = null;
        if (controlRefs && controlRefs.popover) controlRefs.popover.popover.hidden = true;
        if (controlRefs && controlRefs.switchArt) {
            SEGMENTS.forEach((segment) => {
                const button = controlRefs.switchArt.segmentButtons[segment];
                if (button) button.setAttribute('aria-expanded', 'false');
            });
        }
        if (opts.restoreFocus !== false && opener && typeof opener.focus === 'function') opener.focus();
        renderAll();
    }

    function focusSegment(segment) {
        if (!controlRefs || !controlRefs.switchArt) return;
        const button = controlRefs.switchArt.segmentButtons[clamp(segment, 1, 7)];
        if (button && typeof button.focus === 'function') button.focus();
    }

    function handleSegmentArrowKey(event, segment) {
        if (!event) return;
        if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            focusSegment(segment === 7 ? 1 : segment + 1);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            focusSegment(segment === 1 ? 7 : segment - 1);
        } else if (event.key === 'Home') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            focusSegment(7);
        } else if (event.key === 'End') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            focusSegment(1);
        }
    }

    function elementContains(parent, child) {
        return !!(parent && child && typeof parent.contains === 'function' && parent.contains(child));
    }

    function bindDocumentListeners() {
        if (documentListenersBound || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
        documentListenersBound = true;
        document.addEventListener('keydown', (event) => {
            if (event && event.key === 'Escape' && selectedSegment) closeEditor();
        });
        document.addEventListener('pointerdown', (event) => {
            if (!selectedSegment || !controlRefs) return;
            const target = event ? event.target : null;
            if (elementContains(controlRefs.popover.popover, target)) return;
            if (SEGMENTS.some((segment) => elementContains(controlRefs.switchArt.segmentButtons[segment], target))) return;
            closeEditor({ restoreFocus: false });
        });
    }

    function setDisabled(element, disabled) {
        if (!element) return;
        if ('disabled' in element) element.disabled = !!disabled;
        element.setAttribute('aria-disabled', String(!!disabled));
    }

    function updateHueWheel(ref, rawValue, param, disabled) {
        if (!ref) return;
        const hue = rawColorToHueForScope(ref.scope, rawValue, param);
        ref.wheel.setAttribute('aria-valuenow', String(Math.round(hue)));
        ref.wheel.setAttribute('aria-valuetext', `${Math.round(hue)} degrees`);
        ref.wheel.setAttribute('aria-disabled', String(!!disabled));
        ref.wheel.tabIndex = disabled ? -1 : 0;
        const radians = (hue - 90) * Math.PI / 180;
        ref.marker.style.left = `${50 + (Math.cos(radians) * 42)}%`;
        ref.marker.style.top = `${50 + (Math.sin(radians) * 42)}%`;
        ref.marker.style.transform = 'translate(-50%, -50%)';
        setStyleProperty(ref.marker, '--led-marker-color', `hsl(${hue.toFixed(1)} 100% 50%)`);
    }

    function updatePresetGrid(ref, rawValue, disabled) {
        if (!ref) return;
        ref.buttons.forEach(({ button, preset }) => {
            button.setAttribute('aria-pressed', String(Number(rawValue) === Number(preset.value)));
            setDisabled(button, disabled);
        });
    }

    function renderGlobalPanel() {
        if (!controlRefs) return;
        const refs = controlRefs.global;
        const fields = GLOBAL_FIELDS[activeContext];
        const colorRaw = getRawValue(fields.color);
        const intensityRaw = clamp(getRawValue(fields.intensity), 0, 100);
        const lit = intensityRaw > 0;
        const disabled = !getIsDeviceSelected();
        refs.context.textContent = activeContext === 'on' ? 'On state' : 'Off state';
        refs.lit.input.checked = lit;
        refs.lit.label.setAttribute('aria-checked', String(lit));
        setDisabled(refs.lit.input, disabled);
        refs.controls.hidden = !lit;
        updatePresetGrid(refs.presets, colorRaw, disabled || !lit);
        updateHueWheel(refs.wheel, colorRaw, fields.color, disabled || !lit);
        refs.brightness.slider.value = String(Math.max(1, intensityRaw));
        refs.brightness.value.textContent = `${intensityRaw}%`;
        setDisabled(refs.brightness.slider, disabled || !lit);
    }

    function segmentPending(segment) {
        if (!stateApi || typeof stateApi.isPending !== 'function') return false;
        return ['on', 'off'].some((context) => {
            const fields = segmentFields(segment, context);
            return stateApi.isPending(fields.color, activeTopic) || stateApi.isPending(fields.intensity, activeTopic);
        });
    }

    function renderSegments() {
        if (!controlRefs) return;
        SEGMENTS.forEach((segment) => {
            const button = controlRefs.switchArt.segmentButtons[segment];
            const state = getEffectiveSegmentState(segment, activeContext);
            const opacity = state.lit ? clamp(state.effectiveIntensity / 100, 0.08, 1) : 0.08;
            setStyleProperty(button, '--led-color', state.colorCss);
            setStyleProperty(button, '--led-opacity', String(opacity));
            setStyleProperty(button, '--led-glow', state.lit ? `${4 + Math.round(state.effectiveIntensity / 10)}px` : '0px');
            button.classList.toggle('is-dim', !state.lit);
            button.classList.toggle('is-selected', segment === selectedSegment);
            button.classList.toggle('is-pending', segmentPending(segment));
            button.setAttribute('aria-expanded', String(segment === selectedSegment));
            button.setAttribute(
                'aria-label',
                `LED ${segment}, ${segmentPositionLabel(segment)} segment, ${activeContext === 'on' ? 'on' : 'off'} state, ` +
                `${state.customized ? 'customized' : 'following all-LED defaults'}, ` +
                `color ${segmentColorDescription(state.colorRaw, state.globalColorRaw)}, ${state.effectiveIntensity}% brightness`
            );
            setDisabled(button, !getIsDeviceSelected());
        });
    }

    function renderPopover() {
        if (!controlRefs) return;
        const refs = controlRefs.popover;
        if (!selectedSegment) {
            refs.popover.hidden = true;
            return;
        }

        const state = getEffectiveSegmentState(selectedSegment, activeContext);
        const disabled = !getIsDeviceSelected();
        refs.popover.hidden = false;
        refs.title.textContent = `LED ${selectedSegment} - ${segmentPositionLabel(selectedSegment)}`;
        refs.note.textContent = `${activeContext === 'on' ? 'On' : 'Off'} state - ` +
            (state.customized ? 'Custom settings' : 'Following all-LED defaults');
        refs.customize.input.checked = state.customized;
        refs.customize.label.setAttribute('aria-checked', String(state.customized));
        setDisabled(refs.customize.input, disabled);
        refs.lit.input.checked = state.lit;
        refs.lit.label.setAttribute('aria-checked', String(state.lit));
        setDisabled(refs.lit.input, disabled);
        refs.followIntensity.input.checked = state.followsIntensity;
        refs.followIntensity.label.setAttribute('aria-checked', String(state.followsIntensity));
        setDisabled(refs.followIntensity.input, disabled || !state.customized);
        refs.followIntensity.label.hidden = !state.customized;
        refs.controls.hidden = !state.customized || !state.lit;

        const controlsDisabled = disabled || !state.customized || !state.lit;
        updatePresetGrid(refs.presets, state.colorRaw, controlsDisabled);
        updateHueWheel(refs.wheel, state.colorRaw, state.colorParam, controlsDisabled);
        refs.brightness.slider.value = String(Math.max(1, state.effectiveIntensity));
        refs.brightness.value.textContent = state.followsIntensity
            ? `Default: ${state.effectiveIntensity}%`
            : `${state.effectiveIntensity}%`;
        setDisabled(refs.brightness.slider, controlsDisabled || state.followsIntensity);
    }

    function renderContext() {
        if (!controlRefs) return;
        ['on', 'off'].forEach((context) => {
            const button = controlRefs.context.buttons[context];
            const active = activeContext === context;
            button.setAttribute('aria-pressed', String(active));
            button.tabIndex = active ? 0 : -1;
            button.classList.toggle('is-active', active);
        });
    }

    function renderAll() {
        if (!schemaActive || !controlRefs) return;
        renderContext();
        renderGlobalPanel();
        renderSegments();
        renderPopover();
    }

    function clearSyncHandlers() {
        syncUnsubscribers.forEach((unsubscribe) => {
            if (typeof unsubscribe === 'function') unsubscribe();
        });
        syncUnsubscribers = [];
    }

    function registerSyncHandlers() {
        clearSyncHandlers();
        if (!schemaActive || !stateApi || typeof stateApi.registerSyncHandler !== 'function') return;
        FIELD_NAMES.forEach((param) => {
            const unsubscribe = stateApi.registerSyncHandler(param, (value) => {
                rememberRawValue(param, value);
                renderAll();
            });
            if (typeof unsubscribe === 'function') syncUnsubscribers.push(unsubscribe);
        });
    }

    function hydrateFromState() {
        if (!schemaActive || !stateApi) return;
        const hasCurrentValue = typeof stateApi.getCurrentValue === 'function';
        const hasLatestValue = typeof stateApi.getLatestValue === 'function';
        if (!hasCurrentValue && !hasLatestValue) return;
        const currentValueGetter = typeof stateApi.getCurrentValue === 'function'
            ? stateApi.getCurrentValue.bind(stateApi)
            : null;
        FIELD_NAMES.forEach((param) => {
            if (!currentValueGetter && Object.prototype.hasOwnProperty.call(rawValues, param)) return;
            const latest = currentValueGetter
                ? currentValueGetter(param, activeTopic)
                : stateApi.getLatestValue(param, activeTopic);
            if (latest !== undefined && latest !== null && latest !== '') rememberRawValue(param, latest);
        });
    }

    function setSchemaModel(schema) {
        const nextActive = hasFullSchemaCapability(schema);

        if (!nextActive) {
            schemaActive = false;
            clearSyncHandlers();
            removeEditorDom();
            return false;
        }

        schemaActive = true;
        hydrateFromState();
        buildEditor();
        registerSyncHandlers();
        renderAll();
        return true;
    }

    function handlesField(name) {
        const fieldName = name && typeof name === 'object' ? name.name : name;
        return schemaActive && OWNED_FIELDS.has(String(fieldName || ''));
    }

    function setActiveDevice(topic) {
        const nextTopic = topic ? String(topic) : null;
        if (nextTopic !== activeTopic) {
            closeEditor({ restoreFocus: false });
            rawValues = {};
            cancelInteractionDrafts();
            lastNonZeroIntensity = {};
            lastHueByParam = {};
            activeContext = 'on';
        }
        activeTopic = nextTopic;
        hydrateFromState();
        renderAll();
    }

    function resetForDeviceChange() {
        closeEditor({ restoreFocus: false });
        activeTopic = null;
        rawValues = {};
        cancelInteractionDrafts();
        lastNonZeroIntensity = {};
        lastHueByParam = {};
        activeContext = 'on';
        renderAll();
    }

    function init(options) {
        const opts = options || {};
        containerEl = opts.containerEl || null;
        stateApi = opts.stateApi || null;
        isDeviceSelectedFn = typeof opts.isDeviceSelected === 'function' ? opts.isDeviceSelected : null;
        if (opts.schemaModel) setSchemaModel(opts.schemaModel);
    }

    window.SwitchStudioLed = {
        init,
        setSchemaModel,
        handlesField,
        setActiveDevice,
        resetForDeviceChange,
        closeEditor,
        __test__: {
            FIELD_NAMES: FIELD_NAMES.slice(),
            GLOBAL_PRESETS: GLOBAL_PRESETS.map((preset) => ({ ...preset })),
            SEGMENT_PRESETS: SEGMENT_PRESETS.map((preset) => ({ ...preset })),
            segmentFields,
            hasFullSchemaCapability,
            globalHueToRaw,
            segmentHueToRaw,
            globalRawToHue,
            segmentRawToHue,
            globalColorToSegmentRaw,
            colorCssFromGlobalRaw,
            colorCssFromSegmentRaw,
            getEffectiveSegmentState,
            setRawValuesForTest: (values) => {
                Object.entries(values || {}).forEach(([param, value]) => {
                    if (OWNED_FIELDS.has(param)) rememberRawValue(param, value);
                });
                renderAll();
            },
            getRawValuesForTest: () => ({ ...rawValues }),
            setPreviewContext,
            setSegmentCustomized,
            setGlobalLit,
            setSegmentLit,
            commitHue,
            commitBrightness,
            selectPreset,
            openSegmentEditor,
            setInteractionDraft,
            commitInteractionDraft,
            getInteractionDraftCount: () => interactionDrafts.size,
            getSelectedSegment: () => selectedSegment,
            getControlRefs: () => controlRefs,
            isSchemaActive: () => schemaActive,
        },
    };
})();
