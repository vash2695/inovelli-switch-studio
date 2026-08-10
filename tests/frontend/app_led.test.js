const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class MockClassList {
    constructor(element) {
        this.element = element;
    }

    values() {
        return String(this.element.className || '').split(/\s+/).filter(Boolean);
    }

    write(values) {
        this.element.className = Array.from(new Set(values)).join(' ');
    }

    add(...names) {
        this.write(this.values().concat(names));
    }

    remove(...names) {
        const removed = new Set(names);
        this.write(this.values().filter((name) => !removed.has(name)));
    }

    contains(name) {
        return this.values().includes(name);
    }

    toggle(name, force) {
        const present = this.contains(name);
        const next = force === undefined ? !present : !!force;
        if (next) this.add(name);
        else this.remove(name);
        return next;
    }
}

class MockStyle {
    setProperty(name, value) {
        this[name] = String(value);
    }

    getPropertyValue(name) {
        return this[name] || '';
    }
}

class MockElement {
    constructor(document, tagName, namespace) {
        this.ownerDocument = document;
        this.namespaceURI = namespace || null;
        this.tagName = String(tagName || '').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.eventListeners = new Map();
        this.style = new MockStyle();
        this.className = '';
        this.classList = new MockClassList(this);
        this.dataset = {};
        this.textContent = '';
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this.value = '';
        this.type = '';
        this.id = '';
        this.tabIndex = 0;
        this._innerHTML = '';
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parentNode = null;
        return child;
    }

    setAttribute(name, value) {
        const normalized = String(value);
        this.attributes.set(String(name), normalized);
        if (name === 'class') this.className = normalized;
        if (name === 'id') this.id = normalized;
        if (String(name).startsWith('data-')) {
            const key = String(name).slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            this.dataset[key] = normalized;
        }
    }

    getAttribute(name) {
        if (name === 'class') return this.className || null;
        if (name === 'id') return this.id || null;
        return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
    }

    removeAttribute(name) {
        this.attributes.delete(String(name));
    }

    addEventListener(type, callback) {
        if (!this.eventListeners.has(type)) this.eventListeners.set(type, []);
        this.eventListeners.get(type).push(callback);
    }

    dispatch(type, init) {
        const event = {
            type,
            target: this,
            currentTarget: this,
            key: '',
            clientX: 50,
            clientY: 0,
            pointerId: 1,
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
            ...init,
        };
        (this.eventListeners.get(type) || []).forEach((callback) => callback(event));
        return event;
    }

    contains(candidate) {
        if (candidate === this) return true;
        return this.children.some((child) => child.contains(candidate));
    }

    focus() {
        this.ownerDocument.activeElement = this;
    }

    getBoundingClientRect() {
        return { left: 0, top: 0, width: 100, height: 100 };
    }

    setPointerCapture() {}

    set innerHTML(value) {
        this._innerHTML = String(value || '');
        this.children.forEach((child) => { child.parentNode = null; });
        this.children = [];
    }

    get innerHTML() {
        return this._innerHTML;
    }
}

class MockDocument {
    constructor() {
        this.eventListeners = new Map();
        this.activeElement = null;
        this.body = new MockElement(this, 'body');
    }

    createElement(tagName) {
        return new MockElement(this, tagName);
    }

    createElementNS(namespace, tagName) {
        return new MockElement(this, tagName, namespace);
    }

    addEventListener(type, callback) {
        if (!this.eventListeners.has(type)) this.eventListeners.set(type, []);
        this.eventListeners.get(type).push(callback);
    }

    dispatch(type, init) {
        const event = {
            type,
            target: this.body,
            key: '',
            preventDefault() {},
            ...init,
        };
        (this.eventListeners.get(type) || []).forEach((callback) => callback(event));
        return event;
    }
}

function walk(root) {
    const result = [];
    const queue = [root];
    while (queue.length > 0) {
        const current = queue.shift();
        result.push(current);
        queue.push(...current.children);
    }
    return result;
}

function createStateMock(initialValues) {
    const values = { ...(initialValues || {}) };
    const currentValues = { ...values };
    const handlers = new Map();
    const queued = [];
    const pending = new Set();
    return {
        queued,
        statuses: [],
        registerSyncHandler(param, handler) {
            if (!handlers.has(param)) handlers.set(param, new Set());
            handlers.get(param).add(handler);
            return () => handlers.get(param).delete(handler);
        },
        getLatestValue(param) {
            return values[param];
        },
        getCurrentValue(param) {
            return currentValues[param];
        },
        queueChange(param, value) {
            queued.push({ param, value });
            pending.add(param);
            currentValues[param] = value;
            (handlers.get(param) || []).forEach((handler) => handler(currentValues[param]));
        },
        setPacketStatus(mode, message) {
            this.statuses.push({ mode, message });
        },
        isPending(param) {
            return pending.has(param);
        },
        emitSync(param, value) {
            values[param] = value;
            if (pending.has(param) && Number(currentValues[param]) === Number(value)) pending.delete(param);
            if (!pending.has(param)) currentValues[param] = value;
            (handlers.get(param) || []).forEach((handler) => handler(currentValues[param]));
        },
        handlerCount() {
            return Array.from(handlers.values()).reduce((sum, group) => sum + group.size, 0);
        },
    };
}

function createCompleteSchema(fieldNames) {
    return {
        model: 'VZM32-SN',
        fields: fieldNames.map((name) => ({
            name,
            type: 'numeric',
            can_write: true,
            value_min: 0,
            value_max: /^defaultLed[1-7]IntensityWhen(On|Off)$/.test(name)
                ? 101
                : (/^ledIntensityWhen(On|Off)$/.test(name) ? 100 : 255),
        })),
    };
}

function createEffectField(name, effectValues) {
    const individual = name === 'individual_led_effect';
    const features = [];
    if (individual) {
        features.push({
            name: 'led', type: 'enum', can_write: true,
            values: ['1', '2', '3', '4', '5', '6', '7'],
        });
    }
    features.push({
        name: 'effect', type: 'enum', can_write: true,
        values: effectValues || (individual
            ? ['off', 'solid', 'fast_blink', 'slow_blink', 'pulse', 'chase', 'falling', 'rising', 'aurora', 'clear_effect']
            : ['off', 'solid', 'fast_blink', 'slow_blink', 'pulse', 'chase', 'open_close', 'small_to_big', 'aurora', 'slow_falling', 'medium_falling', 'fast_falling', 'slow_rising', 'medium_rising', 'fast_rising', 'medium_blink', 'slow_chase', 'fast_chase', 'fast_siren', 'slow_siren', 'clear_effect']),
    });
    features.push(
        { name: 'color', type: 'numeric', can_write: true, value_min: 0, value_max: 255 },
        { name: 'level', type: 'numeric', can_write: true, value_min: 0, value_max: 100 },
        { name: 'duration', type: 'numeric', can_write: true, value_min: 0, value_max: 255 },
    );
    return { name, type: 'composite', can_write: true, features };
}

function createCompleteSchemaWithEffects(fieldNames) {
    const schema = createCompleteSchema(fieldNames);
    schema.fields.push(createEffectField('led_effect'), createEffectField('individual_led_effect'));
    return schema;
}

function loadLedModule(options) {
    const opts = options || {};
    const scriptPath = path.resolve(__dirname, '../../switch_studio/static/js/app_led.js');
    const source = fs.readFileSync(scriptPath, 'utf8');
    const document = new MockDocument();
    const context = { window: {}, document, console, Math, Number, Object, Array, Map, Set, String, Date };
    if (opts.reducedMotion !== undefined) {
        context.window.matchMedia = () => ({ matches: opts.reducedMotion === true });
    }
    context.global = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: scriptPath });

    const module = context.window.SwitchStudioLed;
    const container = document.createElement('div');
    const state = opts.state || createStateMock(opts.values);
    const sentEffects = [];
    const sendImmediateEffect = typeof opts.sendImmediateEffect === 'function'
        ? opts.sendImmediateEffect
        : (opts.effectsEnabled ? ((param, value) => { sentEffects.push({ param, value }); return true; }) : null);
    module.init({
        containerEl: container,
        stateApi: state,
        isDeviceSelected: typeof opts.isDeviceSelected === 'function'
            ? opts.isDeviceSelected
            : () => opts.deviceSelected !== false,
        isCommandReady: typeof opts.isCommandReady === 'function'
            ? opts.isCommandReady
            : () => opts.commandReady !== false,
        sendImmediateEffect,
        visible: opts.visible === true,
    });
    return { module, api: module.__test__, document, container, state, sentEffects };
}

test('LED editor owns the exact 32 persistent fields in stable schema order', () => {
    const { api } = loadLedModule();
    assert.equal(api.FIELD_NAMES.length, 32);
    assert.deepEqual(Array.from(api.FIELD_NAMES.slice(0, 4)), [
        'ledColorWhenOn',
        'ledColorWhenOff',
        'ledIntensityWhenOn',
        'ledIntensityWhenOff',
    ]);
    assert.deepEqual(Array.from(api.FIELD_NAMES.slice(4, 8)), [
        'defaultLed1ColorWhenOn',
        'defaultLed1ColorWhenOff',
        'defaultLed1IntensityWhenOn',
        'defaultLed1IntensityWhenOff',
    ]);
    assert.deepEqual(Array.from(api.FIELD_NAMES.slice(-4)), [
        'defaultLed7ColorWhenOn',
        'defaultLed7ColorWhenOff',
        'defaultLed7IntensityWhenOn',
        'defaultLed7IntensityWhenOff',
    ]);
});

test('schema activation is all-or-nothing so generic rendering remains a fallback', () => {
    const { module, api, container, state } = loadLedModule();
    const complete = createCompleteSchema(api.FIELD_NAMES);
    const incomplete = { ...complete, fields: complete.fields.slice(0, -1) };

    assert.equal(module.setSchemaModel(incomplete), false);
    assert.equal(module.handlesField('ledColorWhenOn'), false);
    assert.equal(container.children.length, 0);

    assert.equal(module.setSchemaModel(complete), true);
    assert.equal(api.isSchemaActive(), true);
    assert.equal(module.handlesField('ledColorWhenOn'), true);
    assert.equal(module.handlesField({ name: 'ledColorWhenOn' }), true);
    assert.equal(module.handlesField('defaultLed7IntensityWhenOff'), true);
    assert.equal(module.handlesField('led_effect'), false);
    assert.equal(state.handlerCount(), 32);

    const wrongRange = createCompleteSchema(api.FIELD_NAMES);
    wrongRange.fields.find((field) => field.name === 'defaultLed4IntensityWhenOn').value_max = 100;
    assert.equal(module.setSchemaModel(wrongRange), false);
    assert.equal(module.handlesField('defaultLed4IntensityWhenOn'), false);
});

test('effect composites are owned independently only when the integrated sender can render them', () => {
    const { module, api } = loadLedModule({ effectsEnabled: true });
    const schema = createCompleteSchemaWithEffects(api.FIELD_NAMES);
    assert.equal(module.setSchemaModel(schema), true);
    assert.equal(module.handlesField('led_effect'), true);
    assert.equal(module.handlesField({ name: 'individual_led_effect' }), true);
    assert.ok(api.getControlRefs().global.effect);
    assert.ok(api.getControlRefs().popover.effect);

    const malformed = createCompleteSchemaWithEffects(api.FIELD_NAMES);
    malformed.fields.find((field) => field.name === 'individual_led_effect')
        .features.find((feature) => feature.name === 'level').value_max = 99;
    module.setSchemaModel(malformed);
    assert.equal(module.handlesField('led_effect'), true);
    assert.equal(module.handlesField('individual_led_effect'), false);
    assert.ok(api.getControlRefs().global.effect);
    assert.equal(api.getControlRefs().popover.effect, null);

    const noSender = loadLedModule();
    noSender.module.setSchemaModel(createCompleteSchemaWithEffects(noSender.api.FIELD_NAMES));
    assert.equal(noSender.module.handlesField('led_effect'), false);
    assert.equal(noSender.module.handlesField('individual_led_effect'), false);
});

test('same-key effect schema changes rebuild dropdown options', () => {
    const { module, api } = loadLedModule({ effectsEnabled: true });
    const first = createCompleteSchema(api.FIELD_NAMES);
    first.fields.push(createEffectField('led_effect', ['solid', 'chase']));
    module.setSchemaModel(first);
    const originalRefs = api.getControlRefs();
    assert.deepEqual(originalRefs.global.effect.effectSelect.children.map((option) => option.value), ['solid', 'chase']);
    api.updateEffectDraft('all', null, { effect: 'chase', duration: 255 });
    api.startEffectPreview('all', null);

    const changed = createCompleteSchema(api.FIELD_NAMES);
    changed.fields.push(createEffectField('led_effect', ['solid', 'future_wave']));
    module.setSchemaModel(changed);
    const rebuiltRefs = api.getControlRefs();
    assert.notEqual(rebuiltRefs, originalRefs);
    assert.deepEqual(rebuiltRefs.global.effect.effectSelect.children.map((option) => option.value), ['solid', 'future_wave']);
    assert.equal(api.getEffectDraft('all', null).effect, 'solid');
    assert.equal(api.getEffectPreview('all', null), null);
});

test('global and segment color conversions preserve their distinct white and sync sentinels', () => {
    const { api } = loadLedModule();
    assert.equal(api.globalHueToRaw(0), 0);
    assert.equal(api.segmentHueToRaw(0), 1);
    assert.equal(api.globalHueToRaw(359), 254);
    assert.equal(api.segmentHueToRaw(359), 254);
    assert.equal(api.globalColorToSegmentRaw(255), 0);
    assert.equal(api.globalColorToSegmentRaw(0), 1);
    assert.equal(api.colorCssFromGlobalRaw(255), '#ffffff');
    assert.equal(api.colorCssFromSegmentRaw(0, 170), '#ffffff');
    assert.equal(api.colorCssFromSegmentRaw(255, 255), '#ffffff');
    assert.match(api.colorCssFromSegmentRaw(255, 0), /^hsl\(0\.0 /);
});

test('effective segment preview resolves color and intensity through staged globals', () => {
    const { module, api } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    api.setRawValuesForTest({
        ledColorWhenOn: 255,
        ledIntensityWhenOn: 40,
        defaultLed1ColorWhenOn: 255,
        defaultLed1IntensityWhenOn: 101,
    });

    let state = api.getEffectiveSegmentState(1, 'on');
    assert.equal(state.colorCss, '#ffffff');
    assert.equal(state.effectiveIntensity, 40);
    assert.equal(state.customized, false);

    api.setRawValuesForTest({ defaultLed1ColorWhenOn: 1, defaultLed1IntensityWhenOn: 0 });
    state = api.getEffectiveSegmentState(1, 'on');
    assert.match(state.colorCss, /^hsl\(0\.0 /);
    assert.equal(state.effectiveIntensity, 0);
    assert.equal(state.lit, false);
    assert.equal(state.customized, true);
});

test('customize and follow-default actions stage both context-specific values', () => {
    const { module, api, state } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    api.setRawValuesForTest({
        ledColorWhenOn: 255,
        ledIntensityWhenOn: 63,
        defaultLed2ColorWhenOn: 255,
        defaultLed2IntensityWhenOn: 101,
    });

    api.setSegmentCustomized(2, true);
    assert.deepEqual(state.queued.slice(-2), [
        { param: 'defaultLed2ColorWhenOn', value: 0 },
        { param: 'defaultLed2IntensityWhenOn', value: 63 },
    ]);

    api.setSegmentCustomized(2, false);
    assert.deepEqual(state.queued.slice(-2), [
        { param: 'defaultLed2ColorWhenOn', value: 255 },
        { param: 'defaultLed2IntensityWhenOn', value: 101 },
    ]);
});

test('bar and segment lit toggles map intensity zero while restoring prior raw levels', () => {
    const { module, api, state } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    api.setRawValuesForTest({
        ledIntensityWhenOn: 72,
        defaultLed3IntensityWhenOn: 44,
    });

    api.setGlobalLit(false);
    api.setGlobalLit(true);
    assert.deepEqual(state.queued.slice(0, 2), [
        { param: 'ledIntensityWhenOn', value: 0 },
        { param: 'ledIntensityWhenOn', value: 72 },
    ]);

    api.setSegmentLit(3, false);
    api.setSegmentLit(3, true);
    assert.deepEqual(state.queued.slice(-4), [
        { param: 'defaultLed3ColorWhenOn', value: 170 },
        { param: 'defaultLed3IntensityWhenOn', value: 0 },
        { param: 'defaultLed3ColorWhenOn', value: 170 },
        { param: 'defaultLed3IntensityWhenOn', value: 44 },
    ]);
});

test('turning a followed segment off and on restores its effective default brightness', () => {
    const { module, api, state } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    api.setRawValuesForTest({
        ledIntensityWhenOn: 35,
        defaultLed3ColorWhenOn: 255,
        defaultLed3IntensityWhenOn: 101,
    });

    api.setSegmentLit(3, false);
    api.setSegmentLit(3, true);

    assert.deepEqual(state.queued.slice(-4), [
        { param: 'defaultLed3ColorWhenOn', value: 170 },
        { param: 'defaultLed3IntensityWhenOn', value: 0 },
        { param: 'defaultLed3ColorWhenOn', value: 170 },
        { param: 'defaultLed3IntensityWhenOn', value: 35 },
    ]);
});

test('hue and brightness controls queue numeric values through staged state only', () => {
    const { module, api, state } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    api.commitHue('global', 0);
    api.commitBrightness('global', 38);
    api.openSegmentEditor(1);
    api.commitHue('segment', 0);
    api.commitBrightness('segment', 52);

    assert.deepEqual(state.queued, [
        { param: 'ledColorWhenOn', value: 0 },
        { param: 'ledIntensityWhenOn', value: 38 },
        { param: 'defaultLed1ColorWhenOn', value: 1 },
        { param: 'defaultLed1IntensityWhenOn', value: 38 },
        { param: 'defaultLed1ColorWhenOn', value: 1 },
        { param: 'defaultLed1IntensityWhenOn', value: 52 },
    ]);
    assert.ok(state.queued.every((entry) => typeof entry.value === 'number'));
});

test('interaction drafts do not stage until commit and clear on device reset', () => {
    const { module, api, state } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    api.setInteractionDraft('ledColorWhenOn', 42);
    assert.equal(api.getInteractionDraftCount(), 1);
    assert.equal(state.queued.length, 0);
    api.commitInteractionDraft('ledColorWhenOn');
    assert.deepEqual(state.queued, [{ param: 'ledColorWhenOn', value: 42 }]);

    api.setInteractionDraft('ledIntensityWhenOff', 25);
    module.resetForDeviceChange();
    assert.equal(api.getInteractionDraftCount(), 0);
    assert.deepEqual(JSON.parse(JSON.stringify(api.getRawValuesForTest())), {});
    assert.equal(api.getSelectedSegment(), null);
});

test('partial state synchronization updates controls without rebuilding the editor DOM', () => {
    const state = createStateMock({
        ledColorWhenOn: 170,
        ledIntensityWhenOn: 90,
        defaultLed1ColorWhenOn: 255,
        defaultLed1IntensityWhenOn: 101,
    });
    const { module, api } = loadLedModule({ state });
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    const refs = api.getControlRefs();

    state.emitSync('ledIntensityWhenOn', 22);
    assert.equal(api.getRawValuesForTest().ledColorWhenOn, 170);
    assert.equal(api.getRawValuesForTest().ledIntensityWhenOn, 22);
    assert.equal(api.getControlRefs(), refs);
    assert.equal(api.getEffectiveSegmentState(1, 'on').effectiveIntensity, 22);
});

test('schema refresh hydrates desired pending values instead of stale authoritative values', () => {
    const state = createStateMock({
        ledColorWhenOn: 170,
        ledIntensityWhenOn: 90,
    });
    const { module, api } = loadLedModule({ state });
    const schema = createCompleteSchema(api.FIELD_NAMES);
    module.setSchemaModel(schema);
    const refs = api.getControlRefs();

    api.selectPreset('global', 42);
    assert.equal(api.getRawValuesForTest().ledColorWhenOn, 42);
    assert.equal(state.getLatestValue('ledColorWhenOn'), 170);
    assert.equal(state.getCurrentValue('ledColorWhenOn'), 42);

    module.setSchemaModel(schema);
    assert.equal(api.getRawValuesForTest().ledColorWhenOn, 42);
    assert.equal(api.getControlRefs(), refs);
});

test('stale wheel and slider gestures cannot commit after changing active devices', () => {
    const { module, api, state } = loadLedModule({ values: {
        ledColorWhenOn: 170,
        ledIntensityWhenOn: 80,
    } });
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    module.setActiveDevice('zigbee2mqtt/device-a');
    const refs = api.getControlRefs();

    refs.global.wheel.wheel.dispatch('pointerdown', { clientX: 100, clientY: 50 });
    assert.equal(api.getInteractionDraftCount(), 1);
    module.setActiveDevice('zigbee2mqtt/device-b');
    refs.global.wheel.wheel.dispatch('pointerup', { clientX: 0, clientY: 50 });
    assert.equal(state.queued.length, 0);
    assert.equal(api.getInteractionDraftCount(), 0);

    refs.global.brightness.slider.dispatch('pointerdown');
    refs.global.brightness.slider.value = '36';
    refs.global.brightness.slider.dispatch('input');
    assert.equal(api.getInteractionDraftCount(), 1);
    module.setActiveDevice('zigbee2mqtt/device-c');
    refs.global.brightness.slider.dispatch('change');
    assert.equal(state.queued.length, 0);
    assert.equal(api.getInteractionDraftCount(), 0);
});

test('mixed legacy follow states stay editable and the header toggle follows both defaults', () => {
    const { module, api, state } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    api.setRawValuesForTest({
        ledColorWhenOn: 170,
        ledIntensityWhenOn: 65,
        defaultLed1ColorWhenOn: 255,
        defaultLed1IntensityWhenOn: 50,
    });
    api.openSegmentEditor(1);
    const refs = api.getControlRefs().popover;

    let segment = api.getEffectiveSegmentState(1, 'on');
    assert.equal(segment.followsColor, true);
    assert.equal(segment.followsIntensity, false);
    assert.equal(refs.follow.input.getAttribute('aria-checked'), 'false');
    assert.equal(refs.brightness.slider.disabled, false);
    assert.equal(refs.controls.hidden, false);

    api.setRawValuesForTest({ defaultLed1ColorWhenOn: 21, defaultLed1IntensityWhenOn: 101 });
    segment = api.getEffectiveSegmentState(1, 'on');
    assert.equal(segment.followsColor, false);
    assert.equal(segment.followsIntensity, true);
    assert.equal(refs.follow.input.getAttribute('aria-checked'), 'false');
    assert.equal(refs.brightness.slider.disabled, false);

    api.setRawValuesForTest({ defaultLed1ColorWhenOn: 21, defaultLed1IntensityWhenOn: 50 });
    refs.follow.input.dispatch('click');
    assert.deepEqual(state.queued.slice(-2), [
        { param: 'defaultLed1ColorWhenOn', value: 255 },
        { param: 'defaultLed1IntensityWhenOn', value: 101 },
    ]);
});

test('preview context uses pressed-button semantics and keyboard navigation', () => {
    const { module, api, document } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    const refs = api.getControlRefs().context;
    assert.equal(refs.controls.getAttribute('role'), 'group');
    assert.equal(refs.buttons.on.getAttribute('aria-pressed'), 'true');
    assert.equal(refs.buttons.off.getAttribute('aria-pressed'), 'false');

    refs.buttons.off.dispatch('click');
    assert.equal(refs.buttons.on.getAttribute('aria-pressed'), 'false');
    assert.equal(refs.buttons.off.getAttribute('aria-pressed'), 'true');

    refs.buttons.off.dispatch('keydown', { key: 'ArrowLeft' });
    assert.equal(refs.buttons.on.getAttribute('aria-pressed'), 'true');
    assert.equal(document.activeElement, refs.buttons.on);
    refs.buttons.on.dispatch('keydown', { key: 'End' });
    assert.equal(refs.buttons.off.getAttribute('aria-pressed'), 'true');
    assert.equal(document.activeElement, refs.buttons.off);
});

test('editor shell enables controls only while an active device is selected', () => {
    let selected = false;
    const { module, api } = loadLedModule({ isDeviceSelected: () => selected });
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    const refs = api.getControlRefs();
    assert.equal(refs.global.lit.input.disabled, true);
    assert.equal(refs.switchArt.segmentButtons[1].disabled, true);

    selected = true;
    module.setActiveDevice('zigbee2mqtt/device-a');
    assert.equal(refs.global.lit.input.disabled, false);
    assert.equal(refs.switchArt.segmentButtons[1].disabled, false);

    refs.switchArt.segmentButtons[1].dispatch('click');
    assert.equal(api.getSelectedSegment(), 1);
    selected = false;
    module.resetForDeviceChange();
    assert.equal(api.getSelectedSegment(), null);
    assert.equal(refs.global.lit.input.disabled, true);
    assert.equal(refs.switchArt.segmentButtons[1].disabled, true);
});

test('rendered editor exposes switch geometry, accessible segments, dialog, and hue sliders', () => {
    const { module, api, document, container } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    const refs = api.getControlRefs();

    assert.equal(container.classList.contains('led-editor-shell'), true);
    assert.equal(container.getAttribute('role'), 'region');
    assert.equal(refs.switchArt.svg.getAttribute('viewBox'), '0 0 240 480');
    assert.equal(refs.switchArt.svg.getAttribute('aria-hidden'), 'true');
    assert.match(refs.switchArt.stage.getAttribute('aria-label'), /LED 1 is the bottom segment.*LED 7 is the top segment/);
    assert.equal(refs.popover.popover.getAttribute('role'), 'dialog');
    assert.equal(refs.popover.popover.getAttribute('aria-modal'), 'false');
    assert.equal(refs.global.wheel.wheel.getAttribute('role'), 'slider');
    assert.equal(refs.popover.wheel.wheel.getAttribute('role'), 'slider');
    assert.equal(refs.global.lit.input.getAttribute('role'), 'switch');
    assert.equal(refs.popover.follow.input.getAttribute('role'), 'switch');
    assert.equal(refs.popover.lit.input.getAttribute('role'), 'switch');
    assert.ok(refs.global.colorSelect.swatch.style.getPropertyValue('--led-select-color'));

    const svgPart = (className) => walk(refs.switchArt.svg).find((element) => element.classList.contains(className));
    const body = svgPart('led-switch-body');
    const paddle = svgPart('led-switch-paddle');
    const configButton = svgPart('led-switch-config-button');
    const luxLens = svgPart('led-switch-lux-lens');
    const diffuser = svgPart('led-switch-diffuser');
    const railLight = svgPart('led-switch-rail-light');
    const airGap = svgPart('led-switch-air-gap');
    assert.deepEqual(
        [body.getAttribute('x'), body.getAttribute('y'), body.getAttribute('width'), body.getAttribute('height')],
        ['2', '4', '236', '470'],
    );
    assert.deepEqual(
        [paddle.getAttribute('x'), paddle.getAttribute('y'), paddle.getAttribute('width'), paddle.getAttribute('height')],
        ['17', '20', '185', '431'],
    );
    assert.deepEqual(
        [configButton.getAttribute('x'), configButton.getAttribute('y'), configButton.getAttribute('width'), configButton.getAttribute('height')],
        ['212', '19', '15', '60'],
    );
    assert.deepEqual(
        [luxLens.tagName, luxLens.getAttribute('cx'), luxLens.getAttribute('cy'), luxLens.getAttribute('r')],
        ['CIRCLE', '219', '105', '6'],
    );
    assert.deepEqual(
        [diffuser.getAttribute('x'), diffuser.getAttribute('y'), diffuser.getAttribute('width'), diffuser.getAttribute('height')],
        ['212', '132', '14', '321'],
    );
    assert.equal(diffuser.getAttribute('fill'), '#10161b');
    assert.deepEqual(
        [railLight.getAttribute('x'), railLight.getAttribute('y'), railLight.getAttribute('width'), railLight.getAttribute('height')],
        ['212', '132', '14', '321'],
    );
    assert.ok(refs.switchArt.railGradient.children.length >= 14);
    assert.deepEqual(
        [airGap.getAttribute('x'), airGap.getAttribute('y'), airGap.getAttribute('width'), airGap.getAttribute('height')],
        ['43', '450', '56', '24'],
    );

    for (let segment = 1; segment <= 7; segment += 1) {
        const button = refs.switchArt.segmentButtons[segment];
        assert.equal(button.tagName, 'BUTTON');
        assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
        assert.equal(button.getAttribute('aria-controls'), 'ledSegmentPopover');
    }
    assert.match(
        refs.switchArt.segmentButtons[1].getAttribute('aria-label'),
        /color Blue from the all-LED default/,
    );
    assert.ok(Number.parseFloat(refs.switchArt.segmentButtons[7].style.top) < Number.parseFloat(refs.switchArt.segmentButtons[1].style.top));

    assert.equal(
        walk(container).some((element) => element.getAttribute && element.getAttribute('data-param') !== null),
        false,
    );

    const opener = refs.switchArt.segmentButtons[1];
    opener.dispatch('click');
    assert.equal(refs.popover.popover.hidden, false);
    assert.equal(opener.getAttribute('aria-expanded'), 'true');
    assert.equal(document.activeElement, refs.popover.follow.input);

    module.closeEditor();
    assert.equal(refs.popover.popover.hidden, true);
    assert.equal(document.activeElement, opener);
});

test('segment popup uses compact follow header, always-visible controls, and native color selects', () => {
    const { module, api, container } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    api.setRawValuesForTest({
        ledColorWhenOn: 170,
        ledIntensityWhenOn: 64,
        defaultLed4ColorWhenOn: 255,
        defaultLed4IntensityWhenOn: 101,
    });
    api.openSegmentEditor(4);
    const refs = api.getControlRefs().popover;
    assert.deepEqual(refs.header.children, [refs.title, refs.follow.label, refs.close]);
    assert.equal(refs.title.textContent, 'LED 4');
    assert.equal(refs.follow.text.textContent, 'Follow default');
    assert.equal(refs.follow.input.getAttribute('aria-checked'), 'true');
    assert.equal(refs.controls.hidden, false);
    assert.equal(refs.colorSelect.select.tagName, 'SELECT');
    assert.equal(refs.colorSelect.presets.some((preset) => preset.value === 255), false);
    assert.equal(walk(container).some((element) => element.classList.contains('led-color-preset')), false);
    assert.equal(walk(container).some((element) => /Drag or use arrow keys/.test(element.textContent)), false);
});

test('editing any persistent segment control detaches both inherited defaults', () => {
    const { module, api, state } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    api.setRawValuesForTest({
        ledColorWhenOn: 170,
        ledIntensityWhenOn: 64,
        defaultLed2ColorWhenOn: 255,
        defaultLed2IntensityWhenOn: 101,
    });
    api.openSegmentEditor(2);
    const refs = api.getControlRefs().popover;

    refs.colorSelect.select.value = '21';
    refs.colorSelect.select.dispatch('change');
    assert.deepEqual(state.queued.slice(-2), [
        { param: 'defaultLed2ColorWhenOn', value: 21 },
        { param: 'defaultLed2IntensityWhenOn', value: 64 },
    ]);
    assert.equal(refs.follow.input.getAttribute('aria-checked'), 'false');

    api.setRawValuesForTest({ defaultLed2ColorWhenOn: 255, defaultLed2IntensityWhenOn: 101 });
    refs.brightness.slider.dispatch('pointerdown');
    refs.brightness.slider.value = '36';
    refs.brightness.slider.dispatch('input');
    assert.equal(state.queued.length, 2);
    refs.brightness.slider.dispatch('change');
    assert.deepEqual(state.queued.slice(-2), [
        { param: 'defaultLed2ColorWhenOn', value: 170 },
        { param: 'defaultLed2IntensityWhenOn', value: 36 },
    ]);
    assert.equal(refs.follow.input.getAttribute('aria-checked'), 'false');
});

test('rail gradient is continuous, ordered top-to-bottom, and centered on the diffuser', () => {
    const { module, api } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    api.setRawValuesForTest({
        defaultLed7ColorWhenOn: 0,
        defaultLed7IntensityWhenOn: 80,
        defaultLed1ColorWhenOn: 1,
        defaultLed1IntensityWhenOn: 20,
    });
    const refs = api.getControlRefs().switchArt;
    const stops = refs.railGradient.children;
    assert.equal(stops.length, 14);
    const offsets = stops.map((stop) => Number.parseFloat(stop.getAttribute('offset')));
    assert.deepEqual(offsets, offsets.slice().sort((a, b) => a - b));
    assert.equal(stops[0].getAttribute('stop-color'), '#ffffff');
    assert.match(stops.at(-1).getAttribute('stop-color'), /^hsl\(0\.0 /);
    assert.deepEqual(
        [refs.railLight.getAttribute('x'), refs.railLight.getAttribute('width')],
        ['212', '14'],
    );
});

test('effect frames, direction, and duration encoding match the published seven-LED contract', () => {
    const { api } = loadLedModule();
    assert.deepEqual(Array.from(api.effectFrame('fast_blink', 0, false)), [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(Array.from(api.effectFrame('fast_blink', 400, false)), [1, 1, 1, 1, 1, 1, 1]);
    assert.deepEqual(Array.from(api.effectFrame('fast_blink', 800, false)), [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(Array.from(api.effectFrame('open_close', 225 * 3, false)), [1, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(Array.from(api.effectFrame('small_to_big', 225 * 3, false)), [1, 1, 1, 1, 1, 1, 1]);
    assert.deepEqual(Array.from(api.effectFrame('medium_falling', 0, false)), [1, 0, 0, 0, 1, 0, 0]);
    assert.deepEqual(Array.from(api.effectFrame('medium_falling', 600, false)), [0, 1, 0, 0, 0, 1, 0]);
    assert.deepEqual(Array.from(api.effectFrame('medium_rising', 0, false)), [0, 0, 0, 1, 0, 0, 0]);
    assert.equal(api.encodeEffectDuration(60, 'seconds'), 60);
    assert.equal(api.encodeEffectDuration(1, 'minutes'), 61);
    assert.equal(api.encodeEffectDuration(60, 'minutes'), 120);
    assert.equal(api.encodeEffectDuration(1, 'hours'), 121);
    assert.equal(api.encodeEffectDuration(134, 'hours'), 254);
    assert.equal(api.encodeEffectDuration(1, 'indefinite'), 255);
    assert.equal(api.decodeEffectDuration(120).unit, 'minutes');
    assert.equal(api.decodeEffectDuration(121).unit, 'hours');
});

test('effect preview eases between published frames and never invents unknown motion', () => {
    const { api } = loadLedModule();
    assert.deepEqual(
        Array.from(api.interpolatedEffectFrame('fast_blink', 500, false)),
        [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    );
    assert.deepEqual(
        Array.from(api.interpolatedEffectFrame('future_wave', 500, false)),
        [0, 0, 0, 0, 0, 0, 0],
    );
});

test('effect dropdowns preview locally without sending or staging persistent settings', () => {
    const { module, api, state, sentEffects } = loadLedModule({ effectsEnabled: true });
    module.setSchemaModel(createCompleteSchemaWithEffects(api.FIELD_NAMES));

    const allEffect = api.getControlRefs().global.effect;
    allEffect.effectSelect.value = 'chase';
    allEffect.effectSelect.dispatch('change');
    assert.equal(api.getEffectDraft('all', null).effect, 'chase');
    assert.equal(api.getEffectPreview('all', null).payload.effect, 'chase');
    assert.equal(allEffect.preview.textContent, 'Stop preview');

    api.openSegmentEditor(7);
    const segmentEffect = api.getControlRefs().popover.effect;
    segmentEffect.effectSelect.value = 'rising';
    segmentEffect.effectSelect.dispatch('change');
    assert.equal(api.getEffectDraft('segment', 7).effect, 'rising');
    assert.equal(api.getEffectPreview('segment', 7).payload.effect, 'rising');
    assert.equal(segmentEffect.preview.textContent, 'Stop preview');

    assert.deepEqual(JSON.parse(JSON.stringify(sentEffects)), []);
    assert.equal(state.queued.length, 0);

    segmentEffect.preview.dispatch('click');
    assert.equal(api.getEffectPreview('segment', 7), null);
    assert.equal(segmentEffect.preview.textContent, 'Preview');
});

test('effect selection can preview locally while physical commands are unavailable', () => {
    const { module, api, state, sentEffects } = loadLedModule({ effectsEnabled: true, commandReady: false });
    module.setSchemaModel(createCompleteSchemaWithEffects(api.FIELD_NAMES));

    const effect = api.getControlRefs().global.effect;
    effect.effectSelect.value = 'pulse';
    effect.effectSelect.dispatch('change');

    assert.equal(api.getEffectPreview('all', null).payload.effect, 'pulse');
    assert.equal(effect.preview.textContent, 'Stop preview');
    assert.equal(effect.send.disabled, true);
    assert.deepEqual(JSON.parse(JSON.stringify(sentEffects)), []);
    assert.equal(state.queued.length, 0);
});

test('automatic dropdown preview preserves off, clear, unknown, and reduced-motion semantics', () => {
    const reduced = loadLedModule({ effectsEnabled: true, reducedMotion: true });
    const schema = createCompleteSchema(reduced.api.FIELD_NAMES);
    schema.fields.push(createEffectField('led_effect', ['solid', 'fast_blink', 'off', 'clear_effect', 'future_wave']));
    reduced.module.setSchemaModel(schema);
    reduced.api.setRawValuesForTest({
        ledColorWhenOn: 170,
        ledIntensityWhenOn: 50,
        defaultLed7ColorWhenOn: 255,
        defaultLed7IntensityWhenOn: 101,
    });

    const refs = reduced.api.getControlRefs().global.effect;
    const topBase = reduced.api.getEffectiveSegmentState(7, 'on');

    refs.effectSelect.value = 'fast_blink';
    refs.effectSelect.dispatch('change');
    assert.equal(reduced.api.getEffectPreview('all', null).payload.effect, 'fast_blink');
    assert.equal(reduced.api.getDisplayedSegmentState(7, topBase).displayOpacity, 1);

    refs.effectSelect.value = 'off';
    refs.effectSelect.dispatch('change');
    assert.equal(reduced.api.getEffectPreview('all', null).payload.effect, 'off');
    assert.equal(reduced.api.getDisplayedSegmentState(7, topBase).displayOpacity, 0);

    refs.effectSelect.value = 'clear_effect';
    refs.effectSelect.dispatch('change');
    assert.equal(reduced.api.getEffectPreview('all', null), null);
    assert.equal(reduced.api.getDisplayedSegmentState(7, topBase).displayOpacity, 0.5);

    refs.effectSelect.value = 'future_wave';
    refs.effectSelect.dispatch('change');
    assert.equal(reduced.api.getEffectPreview('all', null), null);
    assert.equal(refs.preview.disabled, true);
    assert.deepEqual(JSON.parse(JSON.stringify(reduced.sentEffects)), []);
    assert.equal(reduced.state.queued.length, 0);
});

test('unknown schema effects remain sendable but do not claim a local animation', () => {
    const { module, api, state, sentEffects } = loadLedModule({ effectsEnabled: true });
    const schema = createCompleteSchema(api.FIELD_NAMES);
    schema.fields.push(createEffectField('led_effect', ['solid', 'future_wave']));
    module.setSchemaModel(schema);
    api.updateEffectDraft('all', null, { effect: 'future_wave', duration: 0 });

    const refs = api.getControlRefs().global.effect;
    assert.equal(refs.preview.disabled, true);
    assert.equal(api.startEffectPreview('all', null), null);
    assert.equal(api.sendEffect('all', null), true);
    assert.deepEqual(JSON.parse(JSON.stringify(sentEffects)), [
        { param: 'led_effect', value: { effect: 'future_wave', color: 170, level: 100, duration: 1 } },
    ]);
    assert.equal(api.getEffectPreview('all', null), null);
    assert.equal(state.queued.length, 0);
});

test('all-LED and individual effects send exact immediate payloads without staging defaults', () => {
    const { module, api, state, sentEffects } = loadLedModule({ effectsEnabled: true });
    module.setSchemaModel(createCompleteSchemaWithEffects(api.FIELD_NAMES));
    api.updateEffectDraft('all', null, { effect: 'chase', color: 255, level: 47, duration: 61 });
    assert.equal(api.sendEffect('all', null), true);
    api.openSegmentEditor(7);
    api.updateEffectDraft('segment', 7, { effect: 'rising', color: 0, level: 32, duration: 255 });
    assert.equal(api.sendEffect('segment', 7), true);

    assert.deepEqual(JSON.parse(JSON.stringify(sentEffects)), [
        { param: 'led_effect', value: { effect: 'chase', color: 255, level: 47, duration: 61 } },
        { param: 'individual_led_effect', value: { effect: 'rising', color: 0, level: 32, duration: 255, led: '7' } },
    ]);
    assert.equal(state.queued.length, 0);
    assert.equal(api.getEffectPreview('all', null).payload.effect, 'chase');
    assert.equal(api.getEffectPreview('segment', 7).payload.effect, 'rising');
});

test('individual previews mask one physical segment while clear restores persistent defaults', () => {
    const { module, api } = loadLedModule({ effectsEnabled: true });
    module.setSchemaModel(createCompleteSchemaWithEffects(api.FIELD_NAMES));
    api.setRawValuesForTest({
        ledColorWhenOn: 170,
        ledIntensityWhenOn: 50,
        defaultLed1ColorWhenOn: 255,
        defaultLed1IntensityWhenOn: 101,
        defaultLed7ColorWhenOn: 255,
        defaultLed7IntensityWhenOn: 101,
    });
    api.updateEffectDraft('segment', 7, { effect: 'off', color: 0, level: 100, duration: 255 });
    api.startEffectPreview('segment', 7);
    const topBase = api.getEffectiveSegmentState(7, 'on');
    const bottomBase = api.getEffectiveSegmentState(1, 'on');
    assert.equal(api.getDisplayedSegmentState(7, topBase).displayOpacity, 0);
    assert.equal(api.getDisplayedSegmentState(1, bottomBase).displayOpacity, 0.5);

    api.updateEffectDraft('segment', 7, { effect: 'clear_effect' });
    api.startEffectPreview('segment', 7);
    assert.equal(api.getEffectPreview('segment', 7), null);
    assert.equal(api.getDisplayedSegmentState(7, topBase).displayOpacity, 0.5);
});

test('uncorrelated device completion cannot clear a newer local preview', () => {
    const { module, api } = loadLedModule({ effectsEnabled: true });
    module.setSchemaModel(createCompleteSchemaWithEffects(api.FIELD_NAMES));
    api.updateEffectDraft('all', null, { effect: 'solid', duration: 255 });
    api.startEffectPreview('all', null);

    module.syncConfig({ notificationComplete: 'ALL_LEDS' });

    assert.equal(api.getEffectPreview('all', null).payload.effect, 'solid');
    api.stopEffectPreview('all', null);
});

test('closeEditor can suppress focus restoration during navigation', () => {
    const { module, api, document } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    const refs = api.getControlRefs();
    const opener = refs.switchArt.segmentButtons[4];
    const outside = document.createElement('button');

    opener.dispatch('click');
    outside.focus();
    module.closeEditor({ restoreFocus: false });
    assert.equal(document.activeElement, outside);
    assert.equal(opener.getAttribute('aria-expanded'), 'false');
});

test('role-switch controls stage their visible state through DOM clicks', () => {
    const { module, api, state } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    api.setRawValuesForTest({
        ledIntensityWhenOn: 70,
        defaultLed1ColorWhenOn: 255,
        defaultLed1IntensityWhenOn: 101,
    });
    const refs = api.getControlRefs();

    refs.global.lit.input.dispatch('click');
    assert.deepEqual(state.queued.at(-1), { param: 'ledIntensityWhenOn', value: 0 });
    assert.equal(refs.global.lit.input.getAttribute('aria-checked'), 'false');

    refs.switchArt.segmentButtons[1].dispatch('click');
    refs.popover.follow.input.dispatch('click');
    assert.deepEqual(state.queued.slice(-2), [
        { param: 'defaultLed1ColorWhenOn', value: 170 },
        { param: 'defaultLed1IntensityWhenOn', value: 0 },
    ]);

    refs.popover.lit.input.dispatch('click');
    assert.equal(state.queued.at(-1).param, 'defaultLed1IntensityWhenOn');
    assert.equal(state.queued.at(-1).value > 0, true);
});

test('segment arrow navigation is bottom-up and Escape closes the popover', () => {
    const { module, api, document } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    const refs = api.getControlRefs();
    const segment1 = refs.switchArt.segmentButtons[1];
    const segment2 = refs.switchArt.segmentButtons[2];

    segment1.focus();
    segment1.dispatch('keydown', { key: 'ArrowUp' });
    assert.equal(document.activeElement, segment2);
    segment2.dispatch('keydown', { key: 'ArrowLeft' });
    assert.equal(document.activeElement, segment1);
    segment1.dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(document.activeElement, segment2);

    segment1.dispatch('click');
    assert.equal(api.getSelectedSegment(), 1);
    document.dispatch('keydown', { key: 'Escape', target: refs.popover.popover });
    assert.equal(api.getSelectedSegment(), null);
    assert.equal(document.activeElement, segment1);
});

test('circular hue wheel previews on pointerdown and commits only on pointerup', () => {
    const { module, api, state } = loadLedModule();
    module.setSchemaModel(createCompleteSchema(api.FIELD_NAMES));
    const wheel = api.getControlRefs().global.wheel.wheel;

    wheel.dispatch('pointerdown', { clientX: 100, clientY: 50 });
    assert.equal(api.getInteractionDraftCount(), 1);
    assert.equal(state.queued.length, 0);
    wheel.dispatch('pointermove', { clientX: 50, clientY: 100 });
    assert.equal(state.queued.length, 0);
    wheel.dispatch('pointerup', { clientX: 0, clientY: 50 });
    assert.equal(api.getInteractionDraftCount(), 0);
    assert.equal(state.queued.length, 1);
    assert.equal(state.queued[0].param, 'ledColorWhenOn');
    assert.equal(typeof state.queued[0].value, 'number');
});
