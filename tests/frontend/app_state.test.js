const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class MockClassList {
    constructor() {
        this.values = new Set();
    }

    toggle(name, force) {
        if (typeof force === 'undefined') {
            if (this.values.has(name)) this.values.delete(name);
            else this.values.add(name);
            return;
        }
        if (force) this.values.add(name);
        else this.values.delete(name);
    }

    contains(name) {
        return this.values.has(name);
    }
}

class MockElement {
    constructor(tagName, id) {
        this.tagName = String(tagName || 'div').toUpperCase();
        this.id = id || '';
        this.dataset = {};
        this.attributes = {};
        this.style = {};
        this.listeners = {};
        this.classList = new MockClassList();
        this.children = [];
        this.options = [];
        this.parentNode = null;
        this.disabled = false;
        this.hidden = false;
        this.innerText = '';
        this.textContent = '';
        this.value = '';
        this.type = '';
        this.selectedIndex = 0;
    }

    addEventListener(type, callback) {
        this.listeners[type] = callback;
    }

    click() {
        if (this.listeners.click) this.listeners.click();
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        if (this.tagName === 'SELECT' && child.tagName === 'OPTION') {
            this.options.push(child);
        }
        return child;
    }

    removeChild(child) {
        this.children = this.children.filter((item) => item !== child);
        if (this.tagName === 'SELECT' && child.tagName === 'OPTION') {
            this.options = this.options.filter((item) => item !== child);
        }
        child.parentNode = null;
    }

    remove() {
        if (this.parentNode) {
            this.parentNode.removeChild(this);
        }
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    getAttribute(name) {
        if (Object.prototype.hasOwnProperty.call(this.attributes, name)) {
            return this.attributes[name];
        }
        return null;
    }
}

class MockDocument {
    constructor() {
        this.registry = new Map();
    }

    createElement(tagName) {
        return new MockElement(tagName);
    }

    getElementById(id) {
        return this.registry.get(id) || null;
    }

    register(element) {
        if (element && element.id) this.registry.set(element.id, element);
        return element;
    }
}

function createElement(document, tagName, id, props) {
    const element = new MockElement(tagName, id);
    Object.assign(element, props || {});
    document.register(element);
    return element;
}

function appendOption(document, select, value, label) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = label || String(value);
    select.appendChild(option);
    return option;
}

function loadStateModule(document) {
    const scriptPath = path.resolve(__dirname, '../../switch_studio/static/js/app_state.js');
    const source = fs.readFileSync(scriptPath, 'utf8');

    const context = {
        window: {},
        document,
        console,
        setTimeout,
        clearTimeout,
    };
    context.global = context;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: scriptPath });
    return context.window.SwitchStudioState;
}

function initState(document, options) {
    const opts = options || {};
    const state = loadStateModule(document);
    state.init({
        socket: opts.socket || { emit: () => {} },
        packetInfoEl: createElement(document, 'span', 'packetInfo'),
        dirtyBarEl: createElement(document, 'div', 'dirtyBar'),
        dirtyTextEl: createElement(document, 'span', 'dirtyText'),
        applyBtnEl: createElement(document, 'button', 'applyBtn'),
        discardBtnEl: createElement(document, 'button', 'discardBtn'),
        toastContainerEl: null,
        setTimeoutFn: opts.setTimeoutFn,
        clearTimeoutFn: opts.clearTimeoutFn,
    });
    if (opts.topic) state.setActiveDevice(opts.topic);
    return state;
}

test('state sync keeps LED color preset select aligned and supports non-preset values', () => {
    const document = new MockDocument();
    const ledColorSelect = createElement(document, 'select', 'ledColorWhenOn');
    ledColorSelect.dataset.ledColorSelect = '1';
    appendOption(document, ledColorSelect, 0, 'Red');
    appendOption(document, ledColorSelect, 21, 'Orange');
    appendOption(document, ledColorSelect, 170, 'Blue');

    const state = initState(document);
    state.syncConfig({ ledColorWhenOn: 99 });
    assert.equal(ledColorSelect.value, '99');
    assert.equal(ledColorSelect.options.some((option) => option.dataset.customColorValue === '1'), true);

    state.syncConfig({ ledColorWhenOn: 21 });
    assert.equal(ledColorSelect.value, '21');
    assert.equal(ledColorSelect.options.some((option) => option.dataset.customColorValue === '1'), false);
});

test('discard restores LED brightness slider and refreshes Sync label', () => {
    const document = new MockDocument();
    const slider = createElement(document, 'input', 'ledIntensityWhenOn', { type: 'range', max: '101' });
    slider.dataset.ledBrightnessSlider = '1';
    slider.dataset.sliderValueTarget = 'ledIntensityWhenOn__value';
    const sliderLabel = createElement(document, 'span', 'ledIntensityWhenOn__value');

    const state = initState(document);
    state.syncConfig({ ledIntensityWhenOn: 101 });
    assert.equal(slider.value, 101);
    assert.equal(sliderLabel.innerText, 'Sync');

    slider.value = 12;
    state.queueChange('ledIntensityWhenOn', 12, slider);
    assert.equal(state.getPendingCount(), 1);

    state.discardPendingChanges();
    assert.equal(state.getPendingCount(), 0);
    assert.equal(slider.value, 101);
    assert.equal(sliderLabel.innerText, 'Sync');
});

test('dirty bar is only visible while pending changes exist', () => {
    const document = new MockDocument();
    const slider = createElement(document, 'input', 'ledIntensityWhenOn', { type: 'range' });
    const dirtyBar = createElement(document, 'div', 'dirtyBar');

    const state = loadStateModule(document);
    state.init({
        socket: { emit: () => {} },
        packetInfoEl: createElement(document, 'span', 'packetInfo'),
        dirtyBarEl: dirtyBar,
        dirtyTextEl: createElement(document, 'span', 'dirtyText'),
        applyBtnEl: createElement(document, 'button', 'applyBtn'),
        discardBtnEl: createElement(document, 'button', 'discardBtn'),
        toastContainerEl: null,
    });

    assert.equal(dirtyBar.hidden, true);
    assert.equal(dirtyBar.classList.contains('dirty-active'), false);

    state.syncConfig({ ledIntensityWhenOn: 90 });
    state.queueChange('ledIntensityWhenOn', 50, slider);
    assert.equal(dirtyBar.hidden, false);
    assert.equal(dirtyBar.classList.contains('dirty-active'), true);

    state.discardPendingChanges();
    assert.equal(dirtyBar.hidden, true);
    assert.equal(dirtyBar.classList.contains('dirty-active'), false);
});

test('state sync updates registered input bindings and custom sync handlers', () => {
    const document = new MockDocument();
    const primary = createElement(document, 'input', 'primaryField', { type: 'range' });
    const mirrored = createElement(document, 'input', 'mirroredField', { type: 'range' });
    const observedValues = [];

    const state = initState(document);
    state.registerInputBinding('dimmingSpeedUpRemote', primary);
    state.registerInputBinding('dimmingSpeedUpRemote', mirrored);
    state.registerSyncHandler('dimmingSpeedUpRemote', (value) => observedValues.push(value));

    state.syncConfig({ dimmingSpeedUpRemote: 25 });
    assert.equal(primary.value, 25);
    assert.equal(mirrored.value, 25);
    assert.deepEqual(observedValues, [25]);

    primary.value = 10;
    state.queueChange('dimmingSpeedUpRemote', 10, primary);
    assert.equal(state.getPendingCount(), 1);
    assert.equal(primary.value, 10);
    assert.equal(mirrored.value, 10);
    assert.deepEqual(observedValues, [25, 10]);

    state.discardPendingChanges();
    assert.equal(primary.value, 25);
    assert.equal(mirrored.value, 25);
    assert.deepEqual(observedValues, [25, 10, 25]);
});

test('hidden derived changes do not inflate the visible pending count', () => {
    const document = new MockDocument();
    const primary = createElement(document, 'input', 'primaryField', { type: 'range' });

    const state = initState(document);
    state.syncConfig({
        dimmingSpeedUpRemote: 0,
        dimmingSpeedUpLocal: 0,
        dimmingSpeedDownRemote: 127,
    });

    state.queueChange('dimmingSpeedUpRemote', 25, primary);
    state.queueChange('dimmingSpeedUpLocal', 25, null);
    state.queueChange('dimmingSpeedDownRemote', 0, null, { hiddenFromCount: true });

    assert.equal(state.getPendingCount(), 2);
});

test('configuration state is isolated by device topic while background updates continue', () => {
    const document = new MockDocument();
    const input = createElement(document, 'input', 'mmWaveHoldTime', { type: 'range' });
    const state = initState(document, { topic: 'zigbee2mqtt/device-a' });

    state.syncConfig('zigbee2mqtt/device-a', { mmWaveHoldTime: 10 });
    state.queueChange('mmWaveHoldTime', 20, input);
    assert.equal(input.value, 20);

    state.setActiveDevice('zigbee2mqtt/device-b');
    state.syncConfig('zigbee2mqtt/device-b', { mmWaveHoldTime: 45 });
    assert.equal(input.value, 45);

    state.syncConfig('zigbee2mqtt/device-a', { mmWaveHoldTime: 12 });
    assert.equal(input.value, 45);
    assert.equal(state.getDeviceStatus('zigbee2mqtt/device-a').pending, 1);
    assert.equal(state.getDeviceStatus('zigbee2mqtt/device-b').authoritative.mmWaveHoldTime, 45);

    state.setActiveDevice('zigbee2mqtt/device-a');
    assert.equal(input.value, 20);
    assert.equal(state.getLatestValue('mmWaveHoldTime', 'zigbee2mqtt/device-a'), 12);
});

test('apply sends one batch and leaves authoritative state unchanged until the device echo', () => {
    const document = new MockDocument();
    const emitted = [];
    const timers = new Map();
    let timerId = 0;
    const socket = { emit: (event, payload) => emitted.push({ event, payload }) };
    const state = initState(document, {
        topic: 'zigbee2mqtt/device-a',
        socket,
        setTimeoutFn: (callback) => {
            const id = ++timerId;
            timers.set(id, callback);
            return id;
        },
        clearTimeoutFn: (id) => timers.delete(id),
    });

    state.syncConfig('zigbee2mqtt/device-a', {
        mmWaveHoldTime: 10,
        mmWaveDetectSensitivity: 'Medium',
    });
    state.queueChange('mmWaveHoldTime', 30, null);
    state.queueChange('mmWaveDetectSensitivity', 'High (default)', null);
    const requestId = state.applyPendingChanges();

    assert.match(requestId, /^apply-/);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'apply_parameters');
    assert.equal(emitted[0].payload.request_id, requestId);
    assert.equal(emitted[0].payload.topic, 'zigbee2mqtt/device-a');
    assert.deepEqual(
        JSON.parse(JSON.stringify(emitted[0].payload.changes)),
        { mmWaveHoldTime: 30, mmWaveDetectSensitivity: 'High (default)' },
    );
    let status = state.getDeviceStatus('zigbee2mqtt/device-a');
    assert.equal(status.pending, 0);
    assert.equal(status.sending, 2);
    assert.equal(status.authoritative.mmWaveHoldTime, 10);

    state.handleCommandResult({
        action: 'apply_parameters',
        status: 'sent',
        topic: 'zigbee2mqtt/device-a',
        request_id: requestId,
    });
    assert.equal(state.getDeviceStatus('zigbee2mqtt/device-a').sending, 2);

    state.syncConfig('zigbee2mqtt/device-a', { mmWaveHoldTime: 30 });
    assert.equal(state.getDeviceStatus('zigbee2mqtt/device-a').sending, 2);
    state.syncConfig('zigbee2mqtt/device-a', { mmWaveDetectSensitivity: 'High (default)' });
    assert.equal(state.getDeviceStatus('zigbee2mqtt/device-a').sending, 2);
    state.handleCommandResult({
        action: 'apply_parameters',
        status: 'confirmed',
        topic: 'zigbee2mqtt/device-a',
        request_id: requestId,
        payload: { mmWaveHoldTime: 30, mmWaveDetectSensitivity: 'High (default)' },
    });

    status = state.getDeviceStatus('zigbee2mqtt/device-a');
    assert.equal(status.sending, 0);
    assert.equal(status.authoritative.mmWaveHoldTime, 30);
    assert.equal(status.authoritative.mmWaveDetectSensitivity, 'High (default)');
    assert.equal(timers.size, 0);
});

test('failed or unconfirmed batches return their values to staged changes for retry', () => {
    const document = new MockDocument();
    const emitted = [];
    const state = initState(document, {
        topic: 'zigbee2mqtt/device-a',
        socket: { emit: (event, payload) => emitted.push({ event, payload }) },
        setTimeoutFn: () => 1,
        clearTimeoutFn: () => {},
    });

    state.syncConfig('zigbee2mqtt/device-a', { mmWaveHoldTime: 10 });
    state.queueChange('mmWaveHoldTime', 25, null);
    const requestId = state.applyPendingChanges();
    state.handleCommandResult({
        action: 'apply_parameters',
        status: 'not_confirmed',
        topic: 'zigbee2mqtt/device-a',
        request_id: requestId,
        message: 'No echo received',
    });

    const status = state.getDeviceStatus('zigbee2mqtt/device-a');
    assert.equal(status.pending, 1);
    assert.equal(status.sending, 0);
    assert.equal(status.hasUnconfirmed, true);
    assert.equal(status.authoritative.mmWaveHoldTime, 10);
    assert.equal(state.hasUncommitted('zigbee2mqtt/device-a'), true);
});

test('matching then diverging echoes cannot confirm a batch without backend confirmation', () => {
    const document = new MockDocument();
    const state = initState(document, {
        topic: 'zigbee2mqtt/device-a',
        socket: { emit: () => {} },
        setTimeoutFn: () => 1,
        clearTimeoutFn: () => {},
    });
    state.syncConfig('zigbee2mqtt/device-a', { fieldA: 1, fieldB: 1 });
    state.queueChange('fieldA', 2, null);
    state.queueChange('fieldB', 2, null);
    const requestId = state.applyPendingChanges();

    state.syncConfig('zigbee2mqtt/device-a', { fieldA: 2 });
    state.syncConfig('zigbee2mqtt/device-a', { fieldA: 3 });
    state.syncConfig('zigbee2mqtt/device-a', { fieldB: 2 });
    assert.equal(state.getDeviceStatus('zigbee2mqtt/device-a').sending, 2);

    state.handleCommandResult({
        action: 'apply_parameters',
        status: 'not_confirmed',
        topic: 'zigbee2mqtt/device-a',
        request_id: requestId,
        payload: { confirmed_fields: ['fieldB'], unresolved_fields: ['fieldA'] },
    });
    const status = state.getDeviceStatus('zigbee2mqtt/device-a');
    assert.equal(status.sending, 0);
    assert.equal(status.pending, 1);
    assert.equal(status.hasUnconfirmed, true);
});

test('staged configuration stays local while the socket is disconnected', () => {
    const document = new MockDocument();
    const emitted = [];
    const state = initState(document, {
        topic: 'zigbee2mqtt/device-a',
        socket: { connected: false, emit: (event, payload) => emitted.push({ event, payload }) },
    });
    state.syncConfig('zigbee2mqtt/device-a', { mmWaveHoldTime: 10 });
    state.queueChange('mmWaveHoldTime', 20, null);

    assert.equal(state.applyPendingChanges(), undefined);
    assert.equal(emitted.length, 0);
    assert.equal(state.getDeviceStatus('zigbee2mqtt/device-a').pending, 1);
    assert.equal(state.getDeviceStatus('zigbee2mqtt/device-a').sending, 0);
});

test('reconnect snapshot resolves an in-flight value before its confirmation timeout', () => {
    const document = new MockDocument();
    const timers = new Map();
    let timerId = 0;
    const state = initState(document, {
        topic: 'zigbee2mqtt/device-a',
        socket: { connected: true, emit: () => {} },
        setTimeoutFn: (callback) => {
            const id = ++timerId;
            timers.set(id, callback);
            return id;
        },
        clearTimeoutFn: (id) => timers.delete(id),
    });

    state.syncConfig('zigbee2mqtt/device-a', { mmWaveHoldTime: 10 });
    state.queueChange('mmWaveHoldTime', 30, null);
    state.applyPendingChanges();
    state.setTransportReady(false);

    // The restored inventory snapshot is authoritative even when the original
    // command-result event was lost with the Socket.IO connection.
    state.syncConfig('zigbee2mqtt/device-a', { mmWaveHoldTime: 30 });
    Array.from(timers.values()).forEach((callback) => callback());

    const status = state.getDeviceStatus('zigbee2mqtt/device-a');
    assert.equal(status.pending, 0);
    assert.equal(status.sending, 0);
    assert.equal(status.hasUnconfirmed, false);
    assert.equal(status.authoritative.mmWaveHoldTime, 30);
});

test('zone drafts participate in main apply, discard, and unload protection', () => {
    const document = new MockDocument();
    const calls = [];
    const state = initState(document, {
        topic: 'zigbee2mqtt/device-a',
        socket: { emit: () => {} },
    });

    state.setExternalPending('zone-draft', true, {
        apply: () => {
            calls.push('apply');
            state.setExternalPending('zone-draft', false);
        },
        discard: () => calls.push('discard'),
    });
    assert.equal(state.hasUncommitted('zigbee2mqtt/device-a'), true);
    state.applyPendingChanges();
    assert.deepEqual(calls, ['apply']);
    assert.equal(state.hasUncommitted('zigbee2mqtt/device-a'), false);

    state.setExternalPending('zone-draft', true, { discard: () => calls.push('discard') });
    state.discardPendingChanges();
    assert.deepEqual(calls, ['apply', 'discard']);
    assert.equal(state.hasUncommitted('zigbee2mqtt/device-a'), false);
});
