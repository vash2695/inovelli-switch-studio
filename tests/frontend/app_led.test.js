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

function loadLedModule(options) {
    const opts = options || {};
    const scriptPath = path.resolve(__dirname, '../../switch_studio/static/js/app_led.js');
    const source = fs.readFileSync(scriptPath, 'utf8');
    const document = new MockDocument();
    const context = { window: {}, document, console, Math, Number, Object, Array, Map, Set, String };
    context.global = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: scriptPath });

    const module = context.window.SwitchStudioLed;
    const container = document.createElement('div');
    const state = opts.state || createStateMock(opts.values);
    module.init({
        containerEl: container,
        stateApi: state,
        isDeviceSelected: typeof opts.isDeviceSelected === 'function'
            ? opts.isDeviceSelected
            : () => opts.deviceSelected !== false,
    });
    return { module, api: module.__test__, document, container, state };
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
    assert.deepEqual(state.queued.slice(-2), [
        { param: 'defaultLed3IntensityWhenOn', value: 0 },
        { param: 'defaultLed3IntensityWhenOn', value: 44 },
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

test('segment color and brightness can follow defaults independently', () => {
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
    const followColor = refs.presets.buttons.find(({ preset }) => preset.value === 255).button;

    let segment = api.getEffectiveSegmentState(1, 'on');
    assert.equal(segment.followsColor, true);
    assert.equal(segment.followsIntensity, false);
    assert.equal(followColor.getAttribute('aria-pressed'), 'true');
    assert.equal(refs.followIntensity.input.getAttribute('aria-checked'), 'false');
    assert.equal(refs.brightness.slider.disabled, false);

    api.setRawValuesForTest({ defaultLed1ColorWhenOn: 21, defaultLed1IntensityWhenOn: 101 });
    segment = api.getEffectiveSegmentState(1, 'on');
    assert.equal(segment.followsColor, false);
    assert.equal(segment.followsIntensity, true);
    assert.equal(followColor.getAttribute('aria-pressed'), 'false');
    assert.equal(refs.followIntensity.input.getAttribute('aria-checked'), 'true');
    assert.equal(refs.brightness.slider.disabled, true);

    api.setRawValuesForTest({ defaultLed1ColorWhenOn: 21, defaultLed1IntensityWhenOn: 50 });
    followColor.dispatch('click');
    refs.followIntensity.input.dispatch('click');
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
    assert.equal(refs.popover.customize.input.getAttribute('role'), 'switch');
    assert.equal(refs.popover.lit.input.getAttribute('role'), 'switch');
    assert.ok(refs.global.presets.buttons[0].button.style.getPropertyValue('--led-preset-color'));

    const svgPart = (className) => walk(refs.switchArt.svg).find((element) => element.classList.contains(className));
    const body = svgPart('led-switch-body');
    const paddle = svgPart('led-switch-paddle');
    const configButton = svgPart('led-switch-config-button');
    const luxLens = svgPart('led-switch-lux-lens');
    const diffuser = svgPart('led-switch-diffuser');
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
        [airGap.getAttribute('x'), airGap.getAttribute('y'), airGap.getAttribute('width'), airGap.getAttribute('height')],
        ['43', '450', '56', '24'],
    );

    for (let segment = 1; segment <= 7; segment += 1) {
        const button = refs.switchArt.segmentButtons[segment];
        assert.equal(button.tagName, 'BUTTON');
        assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
        assert.equal(button.getAttribute('aria-controls'), 'ledSegmentPopover');
        assert.ok(button.style.getPropertyValue('--led-color'));
        assert.ok(button.style.getPropertyValue('--led-opacity'));
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
    assert.equal(document.activeElement, refs.popover.customize.input);

    module.closeEditor();
    assert.equal(refs.popover.popover.hidden, true);
    assert.equal(document.activeElement, opener);
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
    refs.popover.customize.input.dispatch('click');
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
