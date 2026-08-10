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
    const EFFECT_FIELD_NAMES = Object.freeze(['led_effect', 'individual_led_effect']);

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

    // Inovelli's published seven-LED simulator defines each frame from the
    // physical top of the bar to the bottom. VZM32 public numbering is the
    // inverse: LED 7 is top and LED 1 is bottom.
    const EFFECT_FRAMES = Object.freeze({
        off: Object.freeze([[0, 0, 0, 0, 0, 0, 0]]),
        clear_effect: Object.freeze([[0, 0, 0, 0, 0, 0, 0]]),
        solid: Object.freeze([[1, 1, 1, 1, 1, 1, 1]]),
        blink: Object.freeze([
            [0, 0, 0, 0, 0, 0, 0],
            [1, 1, 1, 1, 1, 1, 1],
        ]),
        pulse: Object.freeze([
            [0, 0, 0, 0, 0, 0, 0],
            [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
            [1, 1, 1, 1, 1, 1, 1],
            [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
        ]),
        chase: Object.freeze([
            [0, 0, 0.5, 1, 0.5, 0, 0],
            [0, 0.5, 1, 0.5, 0, 0, 0],
            [0.5, 1, 0.5, 0, 0, 0, 0],
            [0, 0.5, 1, 0.5, 0, 0, 0],
            [0, 0, 0.5, 1, 0.5, 0, 0],
            [0, 0, 0, 0.5, 1, 0.5, 0],
            [0, 0, 0, 0, 0.5, 1, 0.5],
            [0, 0, 0, 0.5, 1, 0.5, 0],
        ]),
        open_close: Object.freeze([
            [0, 0, 0, 1, 0, 0, 0],
            [0, 0, 1, 0, 1, 0, 0],
            [0, 1, 0, 0, 0, 1, 0],
            [1, 0, 0, 0, 0, 0, 1],
            [0, 1, 0, 0, 0, 1, 0],
            [0, 0, 1, 0, 1, 0, 0],
            [0, 0, 0, 1, 0, 0, 0],
        ]),
        small_to_big: Object.freeze([
            [0, 0, 0, 1, 0, 0, 0],
            [0, 0, 1, 1, 1, 0, 0],
            [0, 1, 1, 1, 1, 1, 0],
            [1, 1, 1, 1, 1, 1, 1],
            [0, 1, 1, 1, 1, 1, 0],
            [0, 0, 1, 1, 1, 0, 0],
            [0, 0, 0, 1, 0, 0, 0],
        ]),
        aurora: Object.freeze([
            [0, 0.25, 0.25, 0.5, 1, 0.5, 0.25],
            [0.25, 0, 0.25, 0.25, 0.5, 1, 0.5],
            [0.25, 0.25, 0, 0.25, 0.25, 0.5, 1],
            [0.5, 0.25, 0.25, 0, 0.25, 0.25, 0.5],
            [1, 0.5, 0.25, 0.25, 0, 0.25, 0.25],
            [0.5, 1, 0.5, 0.25, 0.25, 0, 0.25],
            [0.25, 0.5, 1, 0.5, 0.25, 0.25, 0],
            [0.25, 0.25, 0.5, 1, 0.5, 0.25, 0.25],
        ]),
        falling: Object.freeze([
            [1, 0, 0, 0, 1, 0, 0],
            [0, 1, 0, 0, 0, 1, 0],
            [0, 0, 1, 0, 0, 0, 1],
            [0, 0, 0, 1, 0, 0, 0],
        ]),
        rising: Object.freeze([
            [0, 0, 0, 1, 0, 0, 0],
            [0, 0, 1, 0, 0, 0, 1],
            [0, 1, 0, 0, 0, 1, 0],
            [1, 0, 0, 0, 1, 0, 0],
        ]),
        siren: Object.freeze([
            [1, 1, 1, 1, 1, 1, 1],
            [0, 1, 1, 1, 1, 1, 0],
        ]),
    });

    const EFFECT_ANIMATIONS = Object.freeze({
        off: Object.freeze({ pattern: 'off', frameMs: 0 }),
        clear_effect: Object.freeze({ pattern: 'clear_effect', frameMs: 0 }),
        solid: Object.freeze({ pattern: 'solid', frameMs: 0 }),
        fast_blink: Object.freeze({ pattern: 'blink', frameMs: 400 }),
        medium_blink: Object.freeze({ pattern: 'blink', frameMs: 600 }),
        slow_blink: Object.freeze({ pattern: 'blink', frameMs: 800 }),
        pulse: Object.freeze({ pattern: 'pulse', frameMs: 400 }),
        chase: Object.freeze({ pattern: 'chase', frameMs: 225 }),
        slow_chase: Object.freeze({ pattern: 'chase', frameMs: 800 }),
        fast_chase: Object.freeze({ pattern: 'chase', frameMs: 150 }),
        open_close: Object.freeze({ pattern: 'open_close', frameMs: 225 }),
        small_to_big: Object.freeze({ pattern: 'small_to_big', frameMs: 225 }),
        aurora: Object.freeze({ pattern: 'aurora', frameMs: 400 }),
        slow_falling: Object.freeze({ pattern: 'falling', frameMs: 800 }),
        medium_falling: Object.freeze({ pattern: 'falling', frameMs: 600 }),
        fast_falling: Object.freeze({ pattern: 'falling', frameMs: 400 }),
        falling: Object.freeze({ pattern: 'falling', frameMs: 600 }),
        slow_rising: Object.freeze({ pattern: 'rising', frameMs: 800 }),
        medium_rising: Object.freeze({ pattern: 'rising', frameMs: 600 }),
        fast_rising: Object.freeze({ pattern: 'rising', frameMs: 400 }),
        rising: Object.freeze({ pattern: 'rising', frameMs: 600 }),
        // The public VZM32 contract exposes siren speed names, but Inovelli's
        // published simulator does not define VZM32-specific timing. Matching
        // the established fast/slow cadence keeps the preview honest and the
        // timing isolated for later hardware calibration.
        fast_siren: Object.freeze({ pattern: 'siren', frameMs: 400, timingApproximate: true }),
        slow_siren: Object.freeze({ pattern: 'siren', frameMs: 800, timingApproximate: true }),
    });
    // Inovelli's published simulator eases each pixel toward its next frame
    // over 200 ms. Keep that temporal blend separate from the per-effect
    // cadence so the preview can later be calibrated against VZM32 hardware.
    const EFFECT_TRANSITION_MS = 200;

    let containerEl = null;
    let stateApi = null;
    let isDeviceSelectedFn = null;
    let isCommandReadyFn = null;
    let sendImmediateEffectFn = null;
    let activeTopic = null;
    let schemaActive = false;
    let effectSchemas = {};
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
    let editorVisible = false;
    let effectDrafts = { all: null, segments: new Map() };
    let effectPreviews = { all: null, segments: new Map() };
    let animationFrameHandle = null;
    let animationNow = 0;
    let previewTimerHandles = new Set();

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

    function featureMap(field) {
        const result = {};
        const features = field && Array.isArray(field.features) ? field.features : [];
        features.forEach((feature) => {
            if (feature && feature.name) result[feature.name] = feature;
        });
        return result;
    }

    function isNumericFeature(feature, min, max) {
        return !!(
            feature &&
            feature.type === 'numeric' &&
            feature.can_write === true &&
            Number(feature.value_min) === min &&
            Number(feature.value_max) === max
        );
    }

    function hasEffectSchemaCapability(field, fieldName) {
        if (!field || field.name !== fieldName || field.type !== 'composite' || field.can_write !== true) return false;
        const features = featureMap(field);
        if (!features.effect || features.effect.type !== 'enum' || features.effect.can_write !== true) return false;
        if (!Array.isArray(features.effect.values) || features.effect.values.length === 0) return false;
        if (!isNumericFeature(features.color, 0, 255)) return false;
        if (!isNumericFeature(features.level, 0, 100)) return false;
        if (!isNumericFeature(features.duration, 0, 255)) return false;
        if (fieldName === 'individual_led_effect') {
            return !!(
                features.led &&
                features.led.type === 'enum' &&
                features.led.can_write === true &&
                SEGMENTS.every((segment) => (features.led.values || []).map(String).includes(String(segment)))
            );
        }
        return true;
    }

    function getEffectSchemas(schema) {
        if (!sendImmediateEffectFn || !schema || !Array.isArray(schema.fields)) return {};
        const next = {};
        schema.fields.forEach((field) => {
            if (EFFECT_FIELD_NAMES.includes(field && field.name) && hasEffectSchemaCapability(field, field.name)) {
                next[field.name] = field;
            }
        });
        return next;
    }

    function effectSchemaSignature(schemas) {
        return JSON.stringify(EFFECT_FIELD_NAMES.map((name) => {
            const field = schemas && schemas[name];
            if (!field) return [name, null];
            const features = featureMap(field);
            return [name, {
                effects: Array.isArray(features.effect && features.effect.values)
                    ? features.effect.values.map(String)
                    : [],
                leds: Array.isArray(features.led && features.led.values)
                    ? features.led.values.map(String)
                    : [],
                color: [features.color && features.color.value_min, features.color && features.color.value_max],
                level: [features.level && features.level.value_min, features.level && features.level.value_max],
                duration: [features.duration && features.duration.value_min, features.duration && features.duration.value_max],
            }];
        }));
    }

    function getIsDeviceSelected() {
        return typeof isDeviceSelectedFn === 'function' ? !!isDeviceSelectedFn() : true;
    }

    function getIsCommandReady() {
        if (!getIsDeviceSelected()) return false;
        return typeof isCommandReadyFn === 'function' ? !!isCommandReadyFn() : true;
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

    function effectColorDescription(rawValue) {
        return globalColorDescription(rawValue);
    }

    function effectDefinition(effectName) {
        return EFFECT_ANIMATIONS[String(effectName || '')] || null;
    }

    function effectFrame(effectName, elapsedMs, reducedMotion) {
        const definition = effectDefinition(effectName);
        if (!definition) return EFFECT_FRAMES.off[0].slice();
        const frames = EFFECT_FRAMES[definition.pattern] || EFFECT_FRAMES.solid;
        if (frames.length === 1 || !definition.frameMs) return frames[0].slice();
        if (reducedMotion) {
            const representativeIndex = Math.min(frames.length - 1, Math.floor(frames.length / 2));
            return frames[representativeIndex].slice();
        }
        const frameIndex = Math.floor(Math.max(0, Number(elapsedMs) || 0) / definition.frameMs) % frames.length;
        return frames[frameIndex].slice();
    }

    function interpolatedEffectFrame(effectName, elapsedMs, reducedMotion) {
        const definition = effectDefinition(effectName);
        if (!definition) return EFFECT_FRAMES.off[0].slice();
        const frames = EFFECT_FRAMES[definition.pattern] || EFFECT_FRAMES.off;
        if (frames.length === 1 || !definition.frameMs || reducedMotion) {
            return effectFrame(effectName, elapsedMs, reducedMotion);
        }

        const elapsed = Math.max(0, Number(elapsedMs) || 0);
        const absoluteFrame = Math.floor(elapsed / definition.frameMs);
        const currentIndex = absoluteFrame % frames.length;
        if (absoluteFrame === 0) return frames[currentIndex].slice();
        const previousIndex = (currentIndex - 1 + frames.length) % frames.length;
        // Fast chase advances before the simulator's full 200 ms easing window.
        // Clipping the blend to one cadence avoids a discontinuity while retaining
        // the intended continuous motion in this device-agnostic preview.
        const transitionMs = Math.min(EFFECT_TRANSITION_MS, definition.frameMs);
        const progress = clamp((elapsed % definition.frameMs) / transitionMs, 0, 1);
        return frames[currentIndex].map((value, index) => {
            const previous = Number(frames[previousIndex][index]) || 0;
            return previous + ((Number(value) - previous) * progress);
        });
    }

    function encodeEffectDuration(value, unit) {
        const normalizedUnit = String(unit || 'seconds');
        if (normalizedUnit === 'indefinite') return 255;
        if (normalizedUnit === 'minutes') return 60 + clamp(toInt(value, 1), 1, 60);
        if (normalizedUnit === 'hours') return 120 + clamp(toInt(value, 1), 1, 134);
        return clamp(toInt(value, 1), 1, 60);
    }

    function decodeEffectDuration(rawValue) {
        const raw = clamp(toInt(rawValue, 10), 0, 255);
        if (raw === 255) return { value: null, unit: 'indefinite', milliseconds: null, label: 'Indefinitely' };
        if (raw >= 121) {
            const value = raw - 120;
            return { value, unit: 'hours', milliseconds: value * 60 * 60 * 1000, label: `${value} ${value === 1 ? 'hour' : 'hours'}` };
        }
        if (raw >= 61) {
            const value = raw - 60;
            return { value, unit: 'minutes', milliseconds: value * 60 * 1000, label: `${value} ${value === 1 ? 'minute' : 'minutes'}` };
        }
        const value = Math.max(1, raw);
        return { value, unit: 'seconds', milliseconds: value * 1000, label: `${value} ${value === 1 ? 'second' : 'seconds'}` };
    }

    function effectDefaultDraft(scope) {
        const fieldName = scope === 'segment' ? 'individual_led_effect' : 'led_effect';
        const field = effectSchemas[fieldName];
        const effects = field ? (featureMap(field).effect.values || []) : [];
        const defaultEffect = effects.includes('solid') ? 'solid' : (effects[0] || 'solid');
        return { effect: defaultEffect, color: 170, level: 100, duration: 10 };
    }

    function getEffectDraft(scope, segment) {
        if (scope === 'all') {
            if (!effectDrafts.all) effectDrafts.all = effectDefaultDraft('all');
            return effectDrafts.all;
        }
        const normalizedSegment = clamp(toInt(segment, 1), 1, 7);
        if (!effectDrafts.segments.has(normalizedSegment)) {
            effectDrafts.segments.set(normalizedSegment, effectDefaultDraft('segment'));
        }
        return effectDrafts.segments.get(normalizedSegment);
    }

    function resetEffectState() {
        stopAllEffectPreviews();
        effectDrafts = { all: null, segments: new Map() };
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

    function stageExplicitSegmentChanges(segment, overrides) {
        const state = getEffectiveSegmentState(segment, activeContext);
        const changes = {
            [state.colorParam]: state.followsColor
                ? globalColorToSegmentRaw(state.globalColorRaw)
                : state.colorRaw,
            [state.intensityParam]: state.followsIntensity
                ? clamp(state.globalIntensityRaw, 0, 100)
                : clamp(state.intensityRaw, 0, 100),
            ...(overrides || {}),
        };
        stageChanges(changes);
    }

    function commitInteractionDraft(param, generation) {
        if (
            !param ||
            (generation !== undefined && generation !== interactionGeneration) ||
            !interactionDrafts.has(param)
        ) return false;
        const value = interactionDrafts.get(param);
        interactionDrafts.delete(param);
        if (selectedSegment && (isSegmentColorParam(param) || /^defaultLed[1-7]IntensityWhen(On|Off)$/.test(param))) {
            stageExplicitSegmentChanges(selectedSegment, { [param]: value });
        } else {
            stageChanges({ [param]: value });
        }
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

    function createColorSelect(scope) {
        const row = createElement('label', 'led-color-select-row');
        row.appendChild(createElement('span', 'led-editor-section-label', 'Color'));
        const control = createElement('span', 'led-color-select-control');
        const swatch = createElement('span', 'led-color-select-swatch');
        swatch.setAttribute('aria-hidden', 'true');
        const select = document.createElement('select');
        select.className = 'led-color-select';
        select.setAttribute('aria-label', scope === 'global' ? 'All LEDs color' : 'Segment color');
        const presets = (scope === 'global' ? GLOBAL_PRESETS : SEGMENT_PRESETS)
            .filter((preset) => !(scope === 'segment' && preset.value === 255));
        presets.forEach((preset) => {
            const option = document.createElement('option');
            option.value = String(preset.value);
            option.textContent = preset.name;
            select.appendChild(option);
        });
        select.addEventListener('change', () => {
            selectPreset(scope, toInt(select.value, 0));
        });
        control.appendChild(swatch);
        control.appendChild(select);
        row.appendChild(control);
        return { row, select, swatch, presets, customOption: null, scope };
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
        const colorSelect = createColorSelect(scope);
        controls.appendChild(colorSelect.row);
        const hueRow = createElement('div', 'led-hue-row');
        const wheel = createHueWheel(scope);
        hueRow.appendChild(wheel.wheel);
        controls.appendChild(hueRow);
        const brightness = createBrightnessControl(scope);
        controls.appendChild(brightness.row);
        return { controls, colorSelect, wheel, brightness };
    }

    function effectLabel(value) {
        const labels = {
            off: 'Off',
            solid: 'Solid',
            fast_blink: 'Fast blink',
            medium_blink: 'Medium blink',
            slow_blink: 'Slow blink',
            pulse: 'Pulse',
            chase: 'Chase',
            slow_chase: 'Slow chase',
            fast_chase: 'Fast chase',
            open_close: 'Open / close',
            small_to_big: 'Small to big',
            aurora: 'Aurora',
            slow_falling: 'Slow falling',
            medium_falling: 'Medium falling',
            fast_falling: 'Fast falling',
            falling: 'Falling',
            slow_rising: 'Slow rising',
            medium_rising: 'Medium rising',
            fast_rising: 'Fast rising',
            rising: 'Rising',
            fast_siren: 'Fast siren',
            slow_siren: 'Slow siren',
            clear_effect: 'Clear effect',
        };
        return labels[value] || String(value || '').replace(/_/g, ' ');
    }

    function updateEffectDraft(scope, segment, changes) {
        const draft = getEffectDraft(scope, segment);
        Object.assign(draft, changes || {});
        const preview = scope === 'all'
            ? effectPreviews.all
            : effectPreviews.segments.get(clamp(toInt(segment, 1), 1, 7));
        if (preview) startEffectPreview(scope, segment, draft);
        renderAll();
    }

    function createEffectHueWheel(scope) {
        const wheel = createElement('div', 'led-hue-wheel led-effect-hue-wheel');
        wheel.tabIndex = 0;
        wheel.setAttribute('role', 'slider');
        wheel.setAttribute('aria-valuemin', '0');
        wheel.setAttribute('aria-valuemax', '359');
        wheel.setAttribute('aria-label', scope === 'all' ? 'All-LED effect hue' : 'Individual effect hue');
        const marker = createElement('span', 'led-hue-marker');
        wheel.appendChild(marker);
        let pointerActive = false;

        function currentSegment() {
            return scope === 'segment' ? selectedSegment : null;
        }

        function setHue(hue) {
            const normalized = normalizeHue(hue);
            updateEffectDraft(scope, currentSegment(), { color: globalHueToRaw(normalized) });
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
            pointerActive = true;
            if (typeof wheel.setPointerCapture === 'function' && event.pointerId !== undefined) {
                wheel.setPointerCapture(event.pointerId);
            }
            if (typeof event.preventDefault === 'function') event.preventDefault();
            setHue(hueFromPointer(event));
        });
        wheel.addEventListener('pointermove', (event) => {
            if (pointerActive) setHue(hueFromPointer(event));
        });
        wheel.addEventListener('pointerup', (event) => {
            if (!pointerActive) return;
            pointerActive = false;
            setHue(hueFromPointer(event));
        });
        wheel.addEventListener('pointercancel', () => { pointerActive = false; });
        wheel.addEventListener('keydown', (event) => {
            if (wheel.getAttribute('aria-disabled') === 'true') return;
            const supported = ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'];
            if (!supported.includes(event.key)) return;
            if (typeof event.preventDefault === 'function') event.preventDefault();
            const draft = getEffectDraft(scope, currentSegment());
            let hue = draft.color === 255 ? 0 : globalRawToHue(draft.color);
            if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') hue -= 1;
            if (event.key === 'ArrowRight' || event.key === 'ArrowUp') hue += 1;
            if (event.key === 'PageDown') hue -= 15;
            if (event.key === 'PageUp') hue += 15;
            if (event.key === 'Home') hue = 0;
            if (event.key === 'End') hue = 359;
            setHue(hue);
        });
        return { wheel, marker };
    }

    function createEffectColorSelect(scope) {
        const row = createElement('label', 'led-color-select-row');
        row.appendChild(createElement('span', 'led-editor-section-label', 'Color'));
        const control = createElement('span', 'led-color-select-control');
        const swatch = createElement('span', 'led-color-select-swatch');
        swatch.setAttribute('aria-hidden', 'true');
        const select = document.createElement('select');
        select.className = 'led-color-select';
        select.setAttribute('aria-label', scope === 'all' ? 'All-LED effect color' : 'Individual effect color');
        GLOBAL_PRESETS.forEach((preset) => {
            const option = document.createElement('option');
            option.value = String(preset.value);
            option.textContent = preset.name;
            select.appendChild(option);
        });
        select.addEventListener('change', () => {
            updateEffectDraft(scope, scope === 'segment' ? selectedSegment : null, {
                color: clamp(toInt(select.value, 0), 0, 255),
            });
        });
        control.appendChild(swatch);
        control.appendChild(select);
        row.appendChild(control);
        return { row, select, swatch, customOption: null, scope, presets: GLOBAL_PRESETS };
    }

    function createEffectPanel(scope) {
        const fieldName = scope === 'segment' ? 'individual_led_effect' : 'led_effect';
        const field = effectSchemas[fieldName];
        const features = featureMap(field);
        const panel = createElement('section', 'led-effect-panel');
        const header = createElement('div', 'led-effect-header');
        header.appendChild(createElement('h4', 'led-effect-title', scope === 'all' ? 'All-LED effect' : 'LED effect'));
        const previewNote = createElement('span', 'led-effect-preview-note', 'Local preview');
        previewNote.title = 'Pattern preview based on Inovelli\'s published seven-LED simulator; device timing can vary by firmware.';
        header.appendChild(previewNote);
        panel.appendChild(header);

        const effectLabelEl = createElement('label', 'led-effect-field');
        effectLabelEl.appendChild(createElement('span', 'led-editor-section-label', 'Effect'));
        const effectSelect = document.createElement('select');
        effectSelect.className = 'led-effect-select';
        effectSelect.setAttribute('aria-label', scope === 'all' ? 'All-LED notification effect' : 'Individual LED notification effect');
        (features.effect.values || []).forEach((value) => {
            const option = document.createElement('option');
            option.value = String(value);
            option.textContent = effectLabel(value);
            effectSelect.appendChild(option);
        });
        effectSelect.addEventListener('change', () => {
            const segment = scope === 'segment' ? selectedSegment : null;
            const wasPreviewing = !!previewFor(scope, segment);
            updateEffectDraft(scope, segment, { effect: effectSelect.value });
            // Changing the selected pattern is itself a preview action. Existing
            // previews are restarted by updateEffectDraft; otherwise start one
            // now. startEffectPreview remains the single source of truth for
            // clear, unknown, static, and reduced-motion behavior.
            if (!wasPreviewing) startEffectPreview(scope, segment, getEffectDraft(scope, segment));
        });
        effectLabelEl.appendChild(effectSelect);
        panel.appendChild(effectLabelEl);

        const colorSelect = createEffectColorSelect(scope);
        panel.appendChild(colorSelect.row);
        const hueWheel = createEffectHueWheel(scope);
        const hueRow = createElement('div', 'led-hue-row led-effect-hue-row');
        hueRow.appendChild(hueWheel.wheel);
        panel.appendChild(hueRow);

        const levelRow = createElement('div', 'led-brightness-row');
        const levelLabel = createElement('label', 'led-editor-section-label');
        levelLabel.style.display = 'grid';
        levelLabel.style.gap = '6px';
        levelLabel.appendChild(createElement('span', null, 'Brightness'));
        const level = document.createElement('input');
        level.type = 'range';
        level.min = '0';
        level.max = '100';
        level.step = '1';
        level.className = 'led-brightness-slider';
        level.setAttribute('aria-label', scope === 'all' ? 'All-LED effect brightness' : 'Individual effect brightness');
        level.addEventListener('input', () => {
            updateEffectDraft(scope, scope === 'segment' ? selectedSegment : null, {
                level: clamp(toInt(level.value, 100), 0, 100),
            });
        });
        levelLabel.appendChild(level);
        const levelValue = createElement('span', 'led-value', '100%');
        levelRow.appendChild(levelLabel);
        levelRow.appendChild(levelValue);
        panel.appendChild(levelRow);

        const duration = createElement('div', 'led-effect-duration');
        const durationValueLabel = createElement('label', 'led-effect-field');
        durationValueLabel.appendChild(createElement('span', 'led-editor-section-label', 'Duration'));
        const durationValue = document.createElement('input');
        durationValue.type = 'number';
        durationValue.min = '1';
        durationValue.max = '60';
        durationValue.step = '1';
        durationValue.value = '10';
        durationValue.className = 'led-effect-duration-value';
        durationValue.setAttribute('aria-label', 'Effect duration value');
        durationValueLabel.appendChild(durationValue);
        const durationUnitLabel = createElement('label', 'led-effect-field');
        durationUnitLabel.appendChild(createElement('span', 'led-editor-section-label', 'Unit'));
        const durationUnit = document.createElement('select');
        durationUnit.className = 'led-effect-duration-unit';
        durationUnit.setAttribute('aria-label', 'Effect duration unit');
        [['seconds', 'Seconds'], ['minutes', 'Minutes'], ['hours', 'Hours'], ['indefinite', 'Indefinite']].forEach(([value, label]) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            durationUnit.appendChild(option);
        });
        durationUnitLabel.appendChild(durationUnit);
        function commitDuration() {
            const unit = durationUnit.value || 'seconds';
            const max = unit === 'hours' ? 134 : 60;
            durationValue.max = String(max);
            durationValue.disabled = unit === 'indefinite';
            const raw = encodeEffectDuration(durationValue.value, unit);
            updateEffectDraft(scope, scope === 'segment' ? selectedSegment : null, { duration: raw });
        }
        durationValue.addEventListener('change', commitDuration);
        durationUnit.addEventListener('change', commitDuration);
        duration.appendChild(durationValueLabel);
        duration.appendChild(durationUnitLabel);
        panel.appendChild(duration);

        const actions = createElement('div', 'led-effect-actions');
        const preview = createElement('button', 'led-effect-preview-button', 'Preview');
        preview.type = 'button';
        preview.setAttribute('aria-pressed', 'false');
        preview.addEventListener('click', () => toggleEffectPreview(scope, scope === 'segment' ? selectedSegment : null));
        const send = createElement('button', 'led-effect-send-button', 'Send effect');
        send.type = 'button';
        send.addEventListener('click', () => sendEffect(scope, scope === 'segment' ? selectedSegment : null));
        actions.appendChild(preview);
        actions.appendChild(send);
        panel.appendChild(actions);

        return {
            panel, scope, fieldName, effectSelect, colorSelect, hueWheel, level, levelValue,
            durationValue, durationUnit, preview, send,
        };
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

        const defs = createSvgElement('defs');
        const railGradient = createSvgElement('linearGradient', {
            id: 'ledRailGradient', x1: '0%', y1: '0%', x2: '0%', y2: '100%',
        });
        const glowFilter = createSvgElement('filter', {
            id: 'ledRailGlow', x: '-160%', y: '-12%', width: '420%', height: '124%',
        });
        glowFilter.appendChild(createSvgElement('feGaussianBlur', { stdDeviation: 3.2 }));
        const glossGradient = createSvgElement('linearGradient', {
            id: 'ledRailGloss', x1: '0%', y1: '0%', x2: '100%', y2: '0%',
        });
        [
            ['0%', '#ffffff', 0.08],
            ['42%', '#ffffff', 0.28],
            ['68%', '#ffffff', 0.04],
            ['100%', '#000000', 0.22],
        ].forEach(([offset, color, opacity]) => glossGradient.appendChild(createSvgElement('stop', {
            offset, 'stop-color': color, 'stop-opacity': opacity,
        })));
        defs.appendChild(railGradient);
        defs.appendChild(glowFilter);
        defs.appendChild(glossGradient);
        svg.appendChild(defs);

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
        const railGlow = createSvgElement('rect', {
            class: 'led-switch-rail-glow', x: 212, y: 132, width: 14, height: 321, rx: 2,
            fill: 'url(#ledRailGradient)', filter: 'url(#ledRailGlow)', opacity: 0.72,
        });
        const railLight = createSvgElement('rect', {
            class: 'led-switch-rail-light', x: 212, y: 132, width: 14, height: 321, rx: 2,
            fill: 'url(#ledRailGradient)',
        });
        const railGloss = createSvgElement('rect', {
            class: 'led-switch-rail-gloss', x: 212, y: 132, width: 14, height: 321, rx: 2,
            fill: 'url(#ledRailGloss)', opacity: 0.52,
        });
        svg.appendChild(railGlow);
        svg.appendChild(railLight);
        svg.appendChild(railGloss);
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
        return { stage, art, svg, segmentButtons, railGradient, railGlow, railLight, railGloss };
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
        const effect = effectSchemas.led_effect ? createEffectPanel('all') : null;
        if (effect) panel.appendChild(effect.panel);
        return { panel, context, lit, effect, ...controls };
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
        const follow = createToggle('led-toggle led-follow-default', 'Follow default');
        follow.input.addEventListener('click', () => {
            follow.input.checked = !follow.input.checked;
            if (selectedSegment) setSegmentCustomized(selectedSegment, !follow.input.checked);
        });
        const close = createElement('button', 'led-popover-close', '\u00d7');
        close.type = 'button';
        close.setAttribute('aria-label', 'Close segment editor');
        close.addEventListener('click', () => closeEditor());
        header.appendChild(title);
        header.appendChild(follow.label);
        header.appendChild(close);
        popover.appendChild(header);

        const lit = createToggle('led-toggle', 'Segment lit');
        lit.input.addEventListener('click', () => {
            lit.input.checked = !lit.input.checked;
            if (selectedSegment) setSegmentLit(selectedSegment, lit.input.checked);
        });
        popover.appendChild(lit.label);

        const controls = createColorControls('segment');
        popover.appendChild(controls.controls);
        const effect = effectSchemas.individual_led_effect ? createEffectPanel('segment') : null;
        if (effect) popover.appendChild(effect.panel);
        return { popover, header, title, follow, close, lit, effect, ...controls };
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
        layout.appendChild(switchArt.stage);
        layout.appendChild(globalPanel.panel);
        layout.appendChild(popover.popover);
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
            if (state.effectiveIntensity > 0) lastNonZeroIntensity[param] = state.effectiveIntensity;
            stageExplicitSegmentChanges(segment, { [param]: 0 });
            return;
        }

        let restored = lastNonZeroIntensity[param];
        if (!Number.isFinite(Number(restored)) || Number(restored) <= 0) {
            restored = state.globalIntensityRaw > 0 ? state.globalIntensityRaw : 100;
        }
        stageExplicitSegmentChanges(segment, { [param]: clamp(toInt(restored, 100), 1, 100) });
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
        const value = hueToRawForScope(scope, normalizedHue);
        if (scope === 'segment' && selectedSegment) stageExplicitSegmentChanges(selectedSegment, { [param]: value });
        else stageChanges({ [param]: value });
    }

    function commitBrightness(scope, value) {
        const param = getIntensityParam(scope);
        if (!param) return;
        const normalized = clamp(toInt(value, 1), 1, 100);
        if (scope === 'segment' && selectedSegment) stageExplicitSegmentChanges(selectedSegment, { [param]: normalized });
        else stageChanges({ [param]: normalized });
    }

    function selectPreset(scope, value) {
        const param = getColorParam(scope);
        if (!param) return;
        const normalized = clamp(toInt(value, 0), 0, 255);
        if (scope === 'segment' && selectedSegment) stageExplicitSegmentChanges(selectedSegment, { [param]: normalized });
        else stageChanges({ [param]: normalized });
    }

    function openSegmentEditor(segment, opener) {
        if (!schemaActive || !getIsDeviceSelected()) return;
        selectedSegment = clamp(toInt(segment, 1), 1, 7);
        popoverOpener = opener || (controlRefs && controlRefs.switchArt.segmentButtons[selectedSegment]);
        renderAll();
        if (controlRefs && controlRefs.popover && controlRefs.popover.follow.input) {
            controlRefs.popover.follow.input.focus();
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

    function updateColorSelect(ref, rawValue, disabled, colorCss) {
        if (!ref) return;
        const raw = Number(rawValue);
        const exactPreset = ref.presets.find((preset) => Number(preset.value) === raw);
        if (ref.customOption && ref.customOption.parentNode) {
            ref.customOption.parentNode.removeChild(ref.customOption);
        }
        ref.customOption = null;
        if (!exactPreset) {
            const option = document.createElement('option');
            option.value = String(raw);
            const hue = ref.scope === 'segment' ? segmentRawToHue(raw) : globalRawToHue(raw);
            option.textContent = `Custom (${Math.round(hue)}\u00b0)`;
            ref.select.appendChild(option);
            ref.customOption = option;
        }
        ref.select.value = String(raw);
        setDisabled(ref.select, disabled);
        setStyleProperty(ref.swatch, '--led-select-color', colorCss || '#ffffff');
    }

    function isReducedMotion() {
        return !!(
            typeof window !== 'undefined' &&
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches
        );
    }

    function previewFor(scope, segment) {
        if (scope === 'all') return effectPreviews.all;
        return effectPreviews.segments.get(clamp(toInt(segment, 1), 1, 7)) || null;
    }

    function clearPreviewTimer(preview) {
        if (!preview || preview.timerHandle === null || preview.timerHandle === undefined) return;
        if (typeof window !== 'undefined' && typeof window.clearTimeout === 'function') {
            window.clearTimeout(preview.timerHandle);
        } else if (typeof clearTimeout === 'function') {
            clearTimeout(preview.timerHandle);
        }
        previewTimerHandles.delete(preview.timerHandle);
        preview.timerHandle = null;
    }

    function stopEffectPreview(scope, segment) {
        const existing = previewFor(scope, segment);
        clearPreviewTimer(existing);
        if (scope === 'all') effectPreviews.all = null;
        else effectPreviews.segments.delete(clamp(toInt(segment, 1), 1, 7));
        animationNow = Date.now();
        syncAnimationLoop();
        renderAll();
    }

    function stopAllEffectPreviews() {
        clearPreviewTimer(effectPreviews.all);
        effectPreviews.segments.forEach((preview) => clearPreviewTimer(preview));
        effectPreviews = { all: null, segments: new Map() };
        previewTimerHandles.clear();
        if (animationFrameHandle !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
            window.cancelAnimationFrame(animationFrameHandle);
        }
        animationFrameHandle = null;
        animationNow = Date.now();
        renderAll();
    }

    function previewNeedsAnimation(preview) {
        if (!preview) return false;
        const definition = effectDefinition(preview.payload.effect);
        const frames = definition ? EFFECT_FRAMES[definition.pattern] : null;
        return !!(definition && definition.frameMs && frames && frames.length > 1);
    }

    function hasMovingPreview() {
        if (previewNeedsAnimation(effectPreviews.all)) return true;
        return Array.from(effectPreviews.segments.values()).some(previewNeedsAnimation);
    }

    function animationTick() {
        animationFrameHandle = null;
        animationNow = Date.now();
        renderSegments();
        syncAnimationLoop();
    }

    function syncAnimationLoop() {
        const shouldRun = editorVisible && !isReducedMotion() && hasMovingPreview();
        if (!shouldRun) {
            if (animationFrameHandle !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
                window.cancelAnimationFrame(animationFrameHandle);
            }
            animationFrameHandle = null;
            return;
        }
        if (animationFrameHandle === null && typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            animationFrameHandle = window.requestAnimationFrame(animationTick);
        }
    }

    function startEffectPreview(scope, segment, draft) {
        const payload = { ...(draft || getEffectDraft(scope, segment)) };
        if (payload.effect === 'clear_effect' || !effectDefinition(payload.effect)) {
            stopEffectPreview(scope, segment);
            return null;
        }
        const normalizedSegment = scope === 'segment' ? clamp(toInt(segment, 1), 1, 7) : null;
        const prior = previewFor(scope, normalizedSegment);
        clearPreviewTimer(prior);
        const preview = {
            payload,
            segment: normalizedSegment,
            startedAt: Date.now(),
            timerHandle: null,
        };
        if (scope === 'all') effectPreviews.all = preview;
        else effectPreviews.segments.set(normalizedSegment, preview);
        const decoded = decodeEffectDuration(payload.duration);
        if (decoded.milliseconds !== null) {
            const timerFn = () => {
                if (previewFor(scope, normalizedSegment) === preview) stopEffectPreview(scope, normalizedSegment);
            };
            if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
                preview.timerHandle = window.setTimeout(timerFn, decoded.milliseconds);
            } else if (typeof setTimeout === 'function') {
                preview.timerHandle = setTimeout(timerFn, decoded.milliseconds);
            }
            if (preview.timerHandle !== null) previewTimerHandles.add(preview.timerHandle);
        }
        animationNow = preview.startedAt;
        syncAnimationLoop();
        renderAll();
        return preview;
    }

    function toggleEffectPreview(scope, segment) {
        if (previewFor(scope, segment)) stopEffectPreview(scope, segment);
        else startEffectPreview(scope, segment, getEffectDraft(scope, segment));
    }

    function sendEffect(scope, segment) {
        if (!getIsCommandReady() || typeof sendImmediateEffectFn !== 'function') return false;
        const fieldName = scope === 'segment' ? 'individual_led_effect' : 'led_effect';
        if (!effectSchemas[fieldName]) return false;
        const draft = getEffectDraft(scope, segment);
        const payload = {
            effect: String(draft.effect),
            color: clamp(toInt(draft.color, 170), 0, 255),
            level: clamp(toInt(draft.level, 100), 0, 100),
            // Raw duration 0 is exposed upstream but has no documented meaning.
            // The editor intentionally authors only 1..254 or 255 (indefinite).
            duration: clamp(toInt(draft.duration, 10), 1, 255),
        };
        if (scope === 'segment') payload.led = String(clamp(toInt(segment, 1), 1, 7));
        const sent = sendImmediateEffectFn(fieldName, payload);
        if (sent === false) return false;
        if (payload.effect === 'clear_effect' || !effectDefinition(payload.effect)) stopEffectPreview(scope, segment);
        else startEffectPreview(scope, segment, payload);
        return true;
    }

    function getDisplayedSegmentState(segment, baseState) {
        const normalizedSegment = clamp(toInt(segment, 1), 1, 7);
        const segmentPreview = effectPreviews.segments.get(normalizedSegment) || null;
        const allPreview = effectPreviews.all;
        const preview = segmentPreview && (!allPreview || segmentPreview.startedAt >= allPreview.startedAt)
            ? segmentPreview
            : allPreview;
        if (!preview) {
            return {
                colorCss: baseState.colorCss,
                displayOpacity: baseState.lit ? clamp(baseState.effectiveIntensity / 100, 0, 1) : 0,
            };
        }
        const visualIndex = 7 - normalizedSegment;
        const frame = interpolatedEffectFrame(
            preview.payload.effect,
            Math.max(0, (animationNow || Date.now()) - preview.startedAt),
            isReducedMotion()
        );
        const weight = clamp(Number(frame[visualIndex]) || 0, 0, 1);
        return {
            colorCss: colorCssFromGlobalRaw(preview.payload.color),
            displayOpacity: clamp((clamp(toInt(preview.payload.level, 100), 0, 100) / 100) * weight, 0, 1),
        };
    }

    function updateEffectColorSelect(ref, rawValue, disabled) {
        updateColorSelect(ref, rawValue, disabled, colorCssFromGlobalRaw(rawValue));
    }

    function renderEffectPanel(refs, scope, segment) {
        if (!refs) return;
        const draft = getEffectDraft(scope, segment);
        const disabled = !getIsDeviceSelected();
        refs.effectSelect.value = String(draft.effect);
        setDisabled(refs.effectSelect, disabled);
        updateEffectColorSelect(refs.colorSelect, draft.color, disabled);
        updateHueWheel(
            { ...refs.hueWheel, scope: 'global' },
            draft.color,
            null,
            disabled
        );
        refs.level.value = String(clamp(toInt(draft.level, 100), 0, 100));
        refs.levelValue.textContent = `${clamp(toInt(draft.level, 100), 0, 100)}%`;
        setDisabled(refs.level, disabled);
        const decoded = decodeEffectDuration(draft.duration);
        refs.durationUnit.value = decoded.unit;
        refs.durationValue.value = String(decoded.value === null ? 1 : decoded.value);
        refs.durationValue.max = decoded.unit === 'hours' ? '134' : '60';
        refs.durationValue.disabled = disabled || decoded.unit === 'indefinite';
        setDisabled(refs.durationUnit, disabled);
        const previewActive = !!previewFor(scope, segment);
        const previewAvailable = draft.effect !== 'clear_effect' && !!effectDefinition(draft.effect);
        refs.preview.textContent = previewActive ? 'Stop preview' : 'Preview';
        refs.preview.setAttribute('aria-pressed', String(previewActive));
        setDisabled(refs.preview, disabled || (!previewActive && !previewAvailable));
        refs.preview.title = previewAvailable
            ? 'Preview this effect locally'
            : 'A local animation is not available for this effect';
        setDisabled(refs.send, !getIsCommandReady());
        refs.send.textContent = draft.effect === 'clear_effect' ? 'Clear effect' : 'Send effect';
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
        refs.controls.hidden = false;
        updateColorSelect(refs.colorSelect, colorRaw, disabled, colorCssFromGlobalRaw(colorRaw));
        updateHueWheel(refs.wheel, colorRaw, fields.color, disabled);
        refs.brightness.slider.value = String(Math.max(1, intensityRaw));
        refs.brightness.value.textContent = `${intensityRaw}%`;
        setDisabled(refs.brightness.slider, disabled);
        if (refs.effect) renderEffectPanel(refs.effect, 'all', null);
    }

    function segmentPending(segment) {
        if (!stateApi || typeof stateApi.isPending !== 'function') return false;
        return ['on', 'off'].some((context) => {
            const fields = segmentFields(segment, context);
            return stateApi.isPending(fields.color, activeTopic) || stateApi.isPending(fields.intensity, activeTopic);
        });
    }

    function replaceRailGradient(statesTopToBottom) {
        if (!controlRefs || !controlRefs.switchArt || !controlRefs.switchArt.railGradient) return;
        const gradient = controlRefs.switchArt.railGradient;
        const states = Array.isArray(statesTopToBottom) ? statesTopToBottom : [];
        const blend = 0.012;
        const points = states.length > 0 ? [{ offset: 0, state: states[0] }] : [];
        for (let index = 1; index < states.length; index += 1) {
            const boundary = index / 7;
            points.push({ offset: boundary - blend, state: states[index - 1] });
            points.push({ offset: boundary + blend, state: states[index] });
        }
        if (states.length > 0) points.push({ offset: 1, state: states[states.length - 1] });
        while (gradient.children.length < points.length) {
            gradient.appendChild(createSvgElement('stop'));
        }
        while (gradient.children.length > points.length) {
            gradient.removeChild(gradient.children[gradient.children.length - 1]);
        }
        points.forEach(({ offset, state }, index) => {
            const stop = gradient.children[index];
            stop.setAttribute('offset', `${(offset * 100).toFixed(3)}%`);
            stop.setAttribute('stop-color', state.colorCss);
            stop.setAttribute('stop-opacity', clamp(Number(state.displayOpacity) || 0, 0, 1).toFixed(3));
        });
    }

    function renderSegments() {
        if (!controlRefs) return;
        const renderedStates = {};
        SEGMENTS.forEach((segment) => {
            const button = controlRefs.switchArt.segmentButtons[segment];
            const state = getEffectiveSegmentState(segment, activeContext);
            const displayed = getDisplayedSegmentState(segment, state);
            renderedStates[segment] = displayed;
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
        replaceRailGradient([7, 6, 5, 4, 3, 2, 1].map((segment) => renderedStates[segment]));
    }

    function renderPopover() {
        if (!controlRefs) return;
        const refs = controlRefs.popover;
        if (!selectedSegment) {
            refs.popover.hidden = true;
            controlRefs.layout.classList.remove('has-segment-editor');
            return;
        }

        const state = getEffectiveSegmentState(selectedSegment, activeContext);
        const disabled = !getIsDeviceSelected();
        refs.popover.hidden = false;
        controlRefs.layout.classList.add('has-segment-editor');
        refs.title.textContent = `LED ${selectedSegment}`;
        refs.title.setAttribute('aria-label', `LED ${selectedSegment}, ${segmentPositionLabel(selectedSegment)} segment`);
        const followsDefault = state.followsColor && state.followsIntensity;
        refs.follow.input.checked = followsDefault;
        refs.follow.label.setAttribute('aria-checked', String(followsDefault));
        setDisabled(refs.follow.input, disabled);
        refs.lit.input.checked = state.lit;
        refs.lit.label.setAttribute('aria-checked', String(state.lit));
        setDisabled(refs.lit.input, disabled);
        refs.controls.hidden = false;

        const displayColorRaw = state.followsColor
            ? globalColorToSegmentRaw(state.globalColorRaw)
            : state.colorRaw;
        updateColorSelect(refs.colorSelect, displayColorRaw, disabled, state.colorCss);
        updateHueWheel(refs.wheel, displayColorRaw, state.colorParam, disabled);
        refs.brightness.slider.value = String(Math.max(1, state.effectiveIntensity));
        refs.brightness.value.textContent = `${state.effectiveIntensity}%`;
        setDisabled(refs.brightness.slider, disabled);
        if (refs.effect) renderEffectPanel(refs.effect, 'segment', selectedSegment);
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
        const nextEffectSchemas = nextActive ? getEffectSchemas(schema) : {};
        const priorEffectSignature = effectSchemaSignature(effectSchemas);
        const nextEffectSignature = effectSchemaSignature(nextEffectSchemas);

        if (!nextActive) {
            schemaActive = false;
            effectSchemas = {};
            clearSyncHandlers();
            resetEffectState();
            removeEditorDom();
            return false;
        }

        if (priorEffectSignature !== nextEffectSignature) {
            if (controlRefs) removeEditorDom();
            resetEffectState();
        }
        schemaActive = true;
        effectSchemas = nextEffectSchemas;
        hydrateFromState();
        buildEditor();
        registerSyncHandlers();
        renderAll();
        return true;
    }

    function handlesField(name) {
        const fieldName = name && typeof name === 'object' ? name.name : name;
        const normalized = String(fieldName || '');
        return schemaActive && (OWNED_FIELDS.has(normalized) || !!effectSchemas[normalized]);
    }

    function setActiveDevice(topic) {
        const nextTopic = topic ? String(topic) : null;
        if (nextTopic !== activeTopic) {
            closeEditor({ restoreFocus: false });
            rawValues = {};
            cancelInteractionDrafts();
            resetEffectState();
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
        resetEffectState();
        lastNonZeroIntensity = {};
        lastHueByParam = {};
        activeContext = 'on';
        renderAll();
    }

    function setVisible(visible) {
        editorVisible = !!visible;
        if (!editorVisible) {
            closeEditor({ restoreFocus: false });
            stopAllEffectPreviews();
        } else {
            animationNow = Date.now();
            syncAnimationLoop();
            renderAll();
        }
    }

    function refreshReadiness() {
        renderAll();
    }

    function syncConfig(config) {
        if (!config || typeof config !== 'object') return;
        // notificationComplete identifies a target, but carries no command or
        // generation id. It may describe an interrupted, older notification.
        // The explicitly local preview therefore follows its own duration/manual
        // stop lifecycle instead of letting an uncorrelated event clear newer UI.
    }

    function init(options) {
        const opts = options || {};
        containerEl = opts.containerEl || null;
        stateApi = opts.stateApi || null;
        isDeviceSelectedFn = typeof opts.isDeviceSelected === 'function' ? opts.isDeviceSelected : null;
        isCommandReadyFn = typeof opts.isCommandReady === 'function' ? opts.isCommandReady : null;
        sendImmediateEffectFn = typeof opts.sendImmediateEffect === 'function' ? opts.sendImmediateEffect : null;
        editorVisible = opts.visible === true;
        if (opts.schemaModel) setSchemaModel(opts.schemaModel);
    }

    window.SwitchStudioLed = {
        init,
        setSchemaModel,
        handlesField,
        setActiveDevice,
        resetForDeviceChange,
        closeEditor,
        setVisible,
        refreshReadiness,
        syncConfig,
        __test__: {
            FIELD_NAMES: FIELD_NAMES.slice(),
            GLOBAL_PRESETS: GLOBAL_PRESETS.map((preset) => ({ ...preset })),
            SEGMENT_PRESETS: SEGMENT_PRESETS.map((preset) => ({ ...preset })),
            EFFECT_FIELD_NAMES: EFFECT_FIELD_NAMES.slice(),
            EFFECT_FRAMES,
            EFFECT_ANIMATIONS,
            segmentFields,
            hasFullSchemaCapability,
            hasEffectSchemaCapability,
            globalHueToRaw,
            segmentHueToRaw,
            globalRawToHue,
            segmentRawToHue,
            globalColorToSegmentRaw,
            colorCssFromGlobalRaw,
            colorCssFromSegmentRaw,
            effectFrame,
            interpolatedEffectFrame,
            effectSchemaSignature,
            encodeEffectDuration,
            decodeEffectDuration,
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
            stageExplicitSegmentChanges,
            commitHue,
            commitBrightness,
            selectPreset,
            openSegmentEditor,
            setInteractionDraft,
            commitInteractionDraft,
            getInteractionDraftCount: () => interactionDrafts.size,
            getSelectedSegment: () => selectedSegment,
            getEffectDraft: (scope, segment) => ({ ...getEffectDraft(scope, segment) }),
            updateEffectDraft,
            startEffectPreview,
            stopEffectPreview,
            sendEffect,
            getEffectPreview: (scope, segment) => {
                const preview = previewFor(scope, segment);
                return preview ? { ...preview, payload: { ...preview.payload } } : null;
            },
            getDisplayedSegmentState,
            getControlRefs: () => controlRefs,
            isSchemaActive: () => schemaActive,
        },
    };
})();
