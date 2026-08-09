const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class MockElement {
    constructor(tagName) {
        this.tagName = String(tagName || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.attributes = {};
        this.listeners = {};
        this.className = '';
        this.textContent = '';
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this.value = '';
        this.type = '';
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    insertBefore(child, reference) {
        if (child.parentNode) child.parentNode.removeChild(child);
        const index = reference ? this.children.indexOf(reference) : -1;
        child.parentNode = this;
        if (index < 0) this.children.push(child);
        else this.children.splice(index, 0, child);
        return child;
    }

    removeChild(child) {
        this.children = this.children.filter((item) => item !== child);
        child.parentNode = null;
    }

    get firstChild() {
        return this.children[0] || null;
    }

    addEventListener(type, handler) {
        this.listeners[type] = handler;
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    matches(selector) {
        return selector.split(',').map((item) => item.trim().toUpperCase()).includes(this.tagName);
    }

    contains(element) {
        if (this === element) return true;
        return this.children.some((child) => child.contains(element));
    }
}

class MockDocument {
    constructor() {
        this.activeElement = null;
    }

    createElement(tagName) {
        return new MockElement(tagName);
    }
}

function findByClass(root, className) {
    if (String(root.className || '').split(/\s+/).includes(className)) return root;
    for (const child of root.children || []) {
        const match = findByClass(child, className);
        if (match) return match;
    }
    return null;
}

function loadDevicesModule(options) {
    const opts = options || {};
    const scriptPath = path.resolve(__dirname, '../../switch_studio/static/js/app_devices.js');
    const source = fs.readFileSync(scriptPath, 'utf8');
    const context = {
        window: {},
        console,
        Date,
        setTimeout,
        clearTimeout,
        document: opts.document,
    };
    context.global = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: scriptPath });

    const emitted = [];
    const timers = new Map();
    let timerId = 0;
    const socket = opts.socket || { emit: (event, payload) => emitted.push({ event, payload }) };
    const devices = context.window.SwitchStudioDevices;
    devices.init({
        socket,
        gridEl: opts.gridEl,
        emptyEl: opts.emptyEl,
        summaryEl: opts.summaryEl,
        onOpenDevice: opts.onOpenDevice,
        onStatus: opts.onStatus,
        setTimeoutFn: (callback) => {
            const id = ++timerId;
            timers.set(id, () => {
                timers.delete(id);
                callback();
            });
            return id;
        },
        clearTimeoutFn: (id) => timers.delete(id),
    });
    devices.setTransportState(true, true);
    return { devices, emitted, timers };
}

function seedDevice(devices, overrides) {
    const topic = 'zigbee2mqtt/Kitchen Switch';
    devices.setDevices([{
        topic,
        friendly_name: 'Kitchen Switch',
        model: 'VZM32-SN',
        last_seen: Date.now() / 1000,
        capabilities: { state: true, brightness: true },
        last_config: { state: 'ON', brightness: 127, occupancy: true },
        ...(overrides || {}),
    }]);
    return topic;
}

test('dashboard device model merges sparse reports and remembers brightness while off', () => {
    const { devices } = loadDevicesModule();
    const topic = seedDevice(devices);

    devices.mergeConfig(topic, { state: 'OFF', occupancy: false }, Date.now() / 1000);
    const device = devices.getDevice(topic);
    assert.equal(device.last_config.state, 'OFF');
    assert.equal(device.last_config.brightness, 127);
    assert.equal(device.last_config.occupancy, false);
    assert.equal(devices.brightnessToPercent(device.last_config.brightness), 50);
    assert.equal(devices.percentToBrightness(50), 127);
});

test('dashboard quick controls include an explicit topic and roll back publish errors', () => {
    const statuses = [];
    const { devices, emitted, timers } = loadDevicesModule({
        onStatus: (status, message) => statuses.push({ status, message }),
    });
    const topic = seedDevice(devices, { last_config: { state: 'OFF', brightness: 127 } });

    const requestId = devices.sendControl(topic, { state: 'ON' });
    assert.match(requestId, /^dashboard-control-/);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'set_basic_control');
    assert.deepEqual(JSON.parse(JSON.stringify(emitted[0].payload)), {
        state: 'ON',
        topic,
        request_id: requestId,
    });
    assert.equal(devices.getDevice(topic).last_config.state, 'ON');
    assert.equal(devices.getDevice(topic).controlStatus, 'sending');

    const handled = devices.handleControlResult({
        action: 'set_basic_control',
        status: 'error',
        topic,
        request_id: requestId,
        message: 'Broker unavailable',
    });
    assert.equal(handled, true);
    assert.equal(devices.getDevice(topic).last_config.state, 'OFF');
    assert.equal(devices.getDevice(topic).controlStatus, 'error');
    assert.equal(timers.size, 0);
    assert.equal(statuses.at(-1).status, 'error');
});

test('dashboard quick controls remain pending until a matching confirmation', () => {
    const { devices, timers } = loadDevicesModule();
    const topic = seedDevice(devices, { last_config: { state: 'OFF', brightness: 127 } });
    const requestId = devices.sendControl(topic, { state: 'ON', brightness: 200 });

    devices.mergeConfig(topic, { state: 'ON' }, Date.now() / 1000);
    assert.equal(devices.getDevice(topic).controlStatus, 'sending');
    assert.equal(timers.size, 1);

    devices.handleControlResult({
        action: 'set_basic_control',
        status: 'confirmed',
        topic,
        request_id: requestId,
        payload: { state: 'ON', brightness: 200 },
    });
    assert.equal(devices.getDevice(topic).controlStatus, 'confirmed');
    assert.equal(devices.getDevice(topic).last_config.brightness, 200);
    assert.equal(timers.size, 0);
});

test('authoritative inventory snapshots reconcile dashboard controls after reconnect', () => {
    const { devices, timers } = loadDevicesModule();
    const topic = seedDevice(devices, { last_config: { state: 'OFF', brightness: 127 } });
    devices.sendControl(topic, { state: 'ON', brightness: 200 });

    assert.equal(timers.size, 1);
    devices.setDevices([{
        topic,
        friendly_name: 'Kitchen Switch',
        model: 'VZM32-SN',
        capabilities: { state: true, brightness: true },
        last_config: { state: 'ON', brightness: 200 },
    }]);

    assert.equal(devices.getDevice(topic).controlStatus, 'confirmed');
    assert.equal(devices.getDevice(topic).last_config.state, 'ON');
    assert.equal(devices.getDevice(topic).last_config.brightness, 200);
    assert.equal(timers.size, 0);
});

test('partial authoritative snapshots preserve confirmed fields and restore current unresolved values', () => {
    const statuses = [];
    const { devices, timers } = loadDevicesModule({
        onStatus: (status, message) => statuses.push({ status, message }),
    });
    const topic = seedDevice(devices, { last_config: { state: 'OFF', brightness: 127 } });
    devices.sendControl(topic, { state: 'ON', brightness: 200 });

    devices.setDevices([{
        topic,
        friendly_name: 'Kitchen Switch',
        model: 'VZM32-SN',
        capabilities: { state: true, brightness: true },
        last_config: { state: 'ON', brightness: 150 },
    }]);
    assert.equal(devices.getDevice(topic).controlStatus, 'sending');
    assert.equal(timers.size, 1);

    Array.from(timers.values())[0]();
    assert.equal(devices.getDevice(topic).last_config.state, 'ON');
    assert.equal(devices.getDevice(topic).last_config.brightness, 150);
    assert.equal(devices.getDevice(topic).controlStatus, 'not-confirmed');
    assert.equal(statuses.at(-1).status, 'unconfirmed');
});

test('dashboard only opens known devices through its navigation callback', () => {
    const opened = [];
    const { devices } = loadDevicesModule({ onOpenDevice: (topic) => opened.push(topic) });
    const topic = seedDevice(devices);

    assert.equal(devices.requestOpenDevice('zigbee2mqtt/missing'), false);
    assert.equal(devices.requestOpenDevice(topic), true);
    assert.deepEqual(opened, [topic]);
});

test('dashboard controls are blocked while either local transport is disconnected', () => {
    const document = new MockDocument();
    const gridEl = new MockElement('div');
    const { devices, emitted, timers } = loadDevicesModule({ document, gridEl });
    const topic = seedDevice(devices);
    devices.setTransportState(true, false);
    Array.from(timers.values()).forEach((callback) => callback());

    const status = findByClass(gridEl, 'device-card-status');
    const powerToggle = findByClass(gridEl, 'device-card-power-toggle');
    const brightnessSlider = findByClass(gridEl, 'device-card-brightness-slider');
    assert.equal(status.hidden, true);
    assert.equal(status.textContent, '');
    assert.equal(powerToggle.disabled, true);
    assert.equal(brightnessSlider.disabled, true);

    assert.equal(devices.sendControl(topic, { state: 'OFF' }), null);
    assert.equal(emitted.length, 0);
    assert.equal(devices.getDevice(topic).last_config.state, 'ON');

    devices.setTransportState(true, true);
    Array.from(timers.values()).forEach((callback) => callback());
    assert.equal(status.hidden, false);
    assert.equal(status.textContent, 'Ready');
});

test('dashboard timeout restores the last confirmed value', () => {
    const statuses = [];
    const { devices, timers } = loadDevicesModule({
        onStatus: (status, message) => statuses.push({ status, message }),
    });
    const topic = seedDevice(devices, { last_config: { state: 'OFF', brightness: 127 } });
    devices.sendControl(topic, { state: 'ON' });
    assert.equal(devices.getDevice(topic).last_config.state, 'ON');

    const timeout = Array.from(timers.values())[0];
    timeout();
    assert.equal(devices.getDevice(topic).last_config.state, 'OFF');
    assert.equal(devices.getDevice(topic).controlStatus, 'not-confirmed');
    assert.equal(statuses.at(-1).status, 'unconfirmed');
});

test('superseded dashboard commands cannot overwrite a newer command result', () => {
    const { devices, timers } = loadDevicesModule();
    const topic = seedDevice(devices, { last_config: { state: 'OFF', brightness: 127 } });
    const firstRequest = devices.sendControl(topic, { state: 'ON' });
    const secondRequest = devices.sendControl(topic, { state: 'OFF' });

    assert.equal(timers.size, 1);
    assert.equal(devices.getDevice(topic).last_config.state, 'OFF');
    assert.equal(devices.handleControlResult({
        action: 'set_basic_control',
        status: 'not_confirmed',
        topic,
        request_id: firstRequest,
    }), true);
    assert.equal(devices.getDevice(topic).controlStatus, 'sending');

    devices.handleControlResult({
        action: 'set_basic_control',
        status: 'not_confirmed',
        topic,
        request_id: secondRequest,
    });
    assert.equal(devices.getDevice(topic).last_config.state, 'OFF');
    assert.equal(devices.getDevice(topic).controlStatus, 'not-confirmed');
});

test('dashboard renders card controls and opens a device from its accessible name', () => {
    const document = new MockDocument();
    const gridEl = new MockElement('div');
    const emptyEl = new MockElement('div');
    const summaryEl = new MockElement('span');
    const opened = [];
    const { devices, emitted, timers } = loadDevicesModule({
        document,
        gridEl,
        emptyEl,
        summaryEl,
        onOpenDevice: (topic) => opened.push(topic),
    });
    const topic = seedDevice(devices);
    Array.from(timers.values()).forEach((callback) => callback());

    assert.equal(gridEl.children.length, 1);
    assert.equal(emptyEl.hidden, true);
    assert.match(summaryEl.textContent, /1 device · 1 ready/);
    assert.equal(findByClass(gridEl, 'device-card-status').textContent, 'Ready');

    const powerToggle = findByClass(gridEl, 'device-card-power-toggle');
    powerToggle.checked = false;
    powerToggle.listeners.change();
    assert.equal(emitted.at(-1).event, 'set_basic_control');
    assert.equal(emitted.at(-1).payload.topic, topic);
    assert.equal(emitted.at(-1).payload.state, 'OFF');
    assert.deepEqual(opened, []);

    const nameButton = findByClass(gridEl, 'device-card-name-button');
    assert.equal(nameButton.tagName, 'BUTTON');
    assert.equal(nameButton.attributes['aria-label'], 'Open Kitchen Switch');
    assert.equal(findByClass(gridEl, 'device-card-open'), null);
    nameButton.listeners.click();
    assert.deepEqual(opened, [topic]);
});

test('dashboard telemetry updates visible values while a card control retains focus', () => {
    const document = new MockDocument();
    const gridEl = new MockElement('div');
    const { devices, timers } = loadDevicesModule({ document, gridEl });
    const topic = seedDevice(devices, {
        last_config: { state: 'ON', brightness: 127, occupancy: true, power: 1, illuminance: 2 },
    });
    Array.from(timers.values()).forEach((callback) => callback());

    const originalCard = gridEl.children[0];
    const powerToggle = findByClass(originalCard, 'device-card-power-toggle');
    document.activeElement = powerToggle;
    devices.mergeConfig(topic, {
        state: 'OFF',
        brightness: 50,
        occupancy: false,
        power: 3.5,
        illuminance: 9,
    }, Date.now() / 1000);
    Array.from(timers.values()).forEach((callback) => callback());

    assert.equal(gridEl.children[0], originalCard);
    assert.equal(findByClass(originalCard, 'device-card-power-toggle'), powerToggle);
    assert.equal(powerToggle.checked, false);
    assert.deepEqual(
        findByClass(originalCard, 'device-card-metrics').children.map((metric) => metric.children[1].textContent),
        ['Clear', '3.5 W', '9 lx'],
    );
    assert.equal(findByClass(originalCard, 'device-card-brightness-value').textContent, '20%');
});

test('dashboard inserts newly discovered devices in friendly-name order without replacing existing cards', () => {
    const document = new MockDocument();
    const gridEl = new MockElement('div');
    const { devices, timers } = loadDevicesModule({ document, gridEl });
    const now = Date.now() / 1000;
    const makeDevice = (name) => ({
        topic: `zigbee2mqtt/${name}`,
        friendly_name: name,
        model: 'VZM32-SN',
        last_seen: now,
        capabilities: { state: true, brightness: true },
        last_config: { state: 'ON', brightness: 127 },
    });

    devices.setDevices([makeDevice('Bedroom'), makeDevice('Den')]);
    Array.from(timers.values()).forEach((callback) => callback());
    const bedroomCard = gridEl.children[0];
    const bedroomToggle = findByClass(bedroomCard, 'device-card-power-toggle');
    document.activeElement = bedroomToggle;

    devices.setDevices([makeDevice('Bedroom'), makeDevice('Den'), makeDevice('Attic')]);
    Array.from(timers.values()).forEach((callback) => callback());

    assert.deepEqual(
        gridEl.children.map((card) => findByClass(card, 'device-card-name-button').textContent),
        ['Attic', 'Bedroom', 'Den'],
    );
    assert.equal(gridEl.children[1], bedroomCard);
    assert.equal(document.activeElement, bedroomToggle);
});

test('dashboard preserves an actively adjusted slider while other telemetry keeps updating', () => {
    const document = new MockDocument();
    const gridEl = new MockElement('div');
    const { devices, timers } = loadDevicesModule({ document, gridEl });
    const topic = seedDevice(devices, {
        last_config: { state: 'ON', brightness: 127, occupancy: true, power: 1, illuminance: 2 },
    });
    Array.from(timers.values()).forEach((callback) => callback());

    const card = gridEl.children[0];
    const slider = findByClass(card, 'device-card-brightness-slider');
    slider.value = '80';
    slider.listeners.pointerdown();
    slider.listeners.input();
    document.activeElement = slider;

    devices.mergeConfig(topic, { brightness: 40, power: 5 }, Date.now() / 1000);
    Array.from(timers.values()).forEach((callback) => callback());
    assert.equal(slider.value, '80');
    assert.equal(findByClass(card, 'device-card-brightness-value').textContent, '80%');
    assert.equal(findByClass(card, 'device-card-metrics').children[1].children[1].textContent, '5 W');

    slider.listeners.pointerup();
    Array.from(timers.values()).forEach((callback) => callback());
    assert.equal(slider.value, '16');
    assert.equal(findByClass(card, 'device-card-brightness-value').textContent, '16%');
});

test('confirmed dashboard controls clear without rendering success feedback', () => {
    const document = new MockDocument();
    const gridEl = new MockElement('div');
    const statuses = [];
    const { devices, timers } = loadDevicesModule({
        document,
        gridEl,
        onStatus: (status, message) => statuses.push({ status, message }),
    });
    const topic = seedDevice(devices, { last_config: { state: 'OFF', brightness: 127 } });
    Array.from(timers.values()).forEach((callback) => callback());

    const requestId = devices.sendControl(topic, { state: 'ON' });
    devices.handleControlResult({
        action: 'set_basic_control',
        status: 'confirmed',
        topic,
        request_id: requestId,
        payload: { state: 'ON' },
    });
    Array.from(timers.values()).forEach((callback) => callback());

    assert.equal(findByClass(gridEl, 'device-card-footer').hidden, true);
    assert.equal(findByClass(gridEl, 'device-card-feedback').textContent, '');
    assert.equal(statuses.some((entry) => entry.status === 'confirmed'), false);
});

test('quick-control-only devices render a non-interactive name', () => {
    const document = new MockDocument();
    const gridEl = new MockElement('div');
    const opened = [];
    const { devices, timers } = loadDevicesModule({
        document,
        gridEl,
        onOpenDevice: (topic) => opened.push(topic),
    });
    seedDevice(devices, { capabilities: { state: true, brightness: true, full_editor: false } });
    Array.from(timers.values()).forEach((callback) => callback());

    const nameButton = findByClass(gridEl, 'device-card-name-button');
    const nameText = findByClass(gridEl, 'device-card-name-text');
    assert.equal(nameButton.hidden, true);
    assert.equal(nameText.hidden, false);
    assert.equal(nameText.textContent, 'Kitchen Switch');
    assert.deepEqual(opened, []);
});

test('dashboard renders null telemetry as unavailable instead of zero', () => {
    const document = new MockDocument();
    const gridEl = new MockElement('div');
    const { devices, timers } = loadDevicesModule({ document, gridEl });
    seedDevice(devices, {
        last_config: {
            state: null,
            brightness: null,
            occupancy: null,
            power: null,
            illuminance: null,
        },
    });
    Array.from(timers.values()).forEach((callback) => callback());

    assert.equal(devices.brightnessToPercent(null), null);
    assert.equal(devices.brightnessToPercent(''), null);
    const metrics = findByClass(gridEl, 'device-card-metrics');
    assert.deepEqual(metrics.children.map((metric) => metric.children[1].textContent), ['—', '—', '—']);
    assert.equal(findByClass(gridEl, 'device-card-brightness-value').textContent, '—');
});

test('known per-device availability overrides global transport readiness', () => {
    const statuses = [];
    const { devices, emitted } = loadDevicesModule({
        onStatus: (status, message) => statuses.push({ status, message }),
    });
    const topic = seedDevice(devices, { availability: 'offline' });
    const readiness = devices.getDeviceReadiness(devices.getDevice(topic));
    assert.equal(readiness.ready, false);
    assert.equal(readiness.label, 'Offline');
    assert.equal(devices.sendControl(topic, { state: 'OFF' }), null);
    assert.equal(emitted.length, 0);
    assert.match(statuses.at(-1).message, /offline or reconnecting/);
});

test('authoritative unsupported controls stay disabled after state reports', () => {
    const statuses = [];
    const { devices, emitted } = loadDevicesModule({
        onStatus: (status, message) => statuses.push({ status, message }),
    });
    const topic = seedDevice(devices, {
        capabilities: {
            state: false,
            brightness: false,
            quick_controls_ambiguous: true,
        },
    });

    devices.mergeConfig(topic, { state: 'ON', brightness: 120 }, Date.now() / 1000);
    assert.equal(devices.getDevice(topic).capabilities.state, false);
    assert.equal(devices.getDevice(topic).capabilities.brightness, false);
    assert.equal(devices.sendControl(topic, { state: 'OFF' }), null);
    assert.equal(emitted.length, 0);
    assert.match(statuses.at(-1).message, /not supported/);
});
