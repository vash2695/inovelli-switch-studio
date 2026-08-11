const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class MockElement {
    constructor(tagName, value) {
        this.tagName = String(tagName || 'div').toUpperCase();
        this.value = value || '';
        this.dataset = {};
        this.attributes = {};
        this.listeners = new Map();
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this.textContent = '';
    }

    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(listener);
    }

    removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener);
    }

    dispatch(type, event) {
        const payload = event || { type, target: this };
        for (const listener of this.listeners.get(type) || []) listener(payload);
    }

    click() {
        this.dispatch('click');
    }

    change() {
        this.dispatch('change');
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name)
            ? this.attributes[name]
            : null;
    }
}

function createClock() {
    let now = 0;
    let nextId = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout(callback, delay) {
            const id = ++nextId;
            timers.set(id, { callback, due: now + Number(delay || 0) });
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        advance(milliseconds) {
            const target = now + milliseconds;
            while (true) {
                const dueTimers = Array.from(timers.entries())
                    .filter(([, timer]) => timer.due <= target)
                    .sort((left, right) => left[1].due - right[1].due || left[0] - right[0]);
                if (!dueTimers.length) break;
                const [id, timer] = dueTimers[0];
                timers.delete(id);
                now = timer.due;
                timer.callback();
            }
            now = target;
        },
        pendingCount: () => timers.size,
    };
}

function createStorage(initial) {
    const values = new Map(Object.entries(initial || {}));
    return {
        getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
        value: (key) => values.get(key),
    };
}

function createPlotly() {
    const calls = [];
    return {
        calls,
        newPlot(element, traces, layout, config) {
            calls.push({ kind: 'newPlot', element, traces, layout, config });
            return element;
        },
        react(element, traces, layout, config) {
            calls.push({ kind: 'react', element, traces, layout, config });
            return element;
        },
        restyle(element, update, indices) {
            calls.push({ kind: 'restyle', element, update, indices });
            return element;
        },
        relayout(element, update) {
            calls.push({ kind: 'relayout', element, update });
            return element;
        },
        purge(element) {
            calls.push({ kind: 'purge', element });
        },
        Plots: {
            resize(element) {
                calls.push({ kind: 'resize', element });
            },
        },
    };
}

function createZonesApi() {
    const calls = { fov: [], zones: [], targets: [] };
    let snapshotListener = null;
    const api = {
        calls,
        setTargetSnapshotListener(listener) {
            snapshotListener = listener;
            listener({ reason: 'subscribe', targets: [], history: {} });
            return () => {
                if (snapshotListener === listener) snapshotListener = null;
            };
        },
        emitSnapshot(snapshot) {
            snapshotListener?.(snapshot);
        },
        hasSnapshotListener: () => !!snapshotListener,
        buildFov3DTraces(options) {
            calls.fov.push(options);
            return [0, 1, 2, 3].map((index) => ({
                type: index % 2 ? 'scatter3d' : 'mesh3d',
                name: `FOV ${index}`,
            }));
        },
        buildZoneCuboidTraces(zone, options) {
            calls.zones.push({ zone, options });
            return [
                { type: 'mesh3d', name: options.name },
                { type: 'scatter3d', name: `${options.name} edges` },
            ];
        },
        buildTarget3DTraces(targets, history, options) {
            calls.targets.push({ targets, history, options });
            return [
                { type: 'scatter3d', name: 'Live targets', x: targets.map((target) => target.x) },
                { type: 'scatter3d', name: 'Target trails' },
            ];
        },
    };
    return api;
}

function loadController(options) {
    const opts = options || {};
    const scriptPath = path.resolve(__dirname, '../../switch_studio/static/js/app_radar3d.js');
    const source = fs.readFileSync(scriptPath, 'utf8');
    const clock = opts.clock || createClock();
    const plotly = Object.prototype.hasOwnProperty.call(opts, 'plotly') ? opts.plotly : createPlotly();
    const zonesApi = opts.zonesApi || createZonesApi();
    const storage = opts.storage || createStorage();
    const resizeObservers = [];
    class MockResizeObserver {
        constructor(callback) {
            this.callback = callback;
            this.observed = [];
            this.disconnected = false;
            resizeObservers.push(this);
        }

        observe(element) {
            this.observed.push(element);
        }

        disconnect() {
            this.disconnected = true;
        }
    }

    const windowObject = {
        Plotly: plotly,
        SwitchStudioZones: zonesApi,
        localStorage: storage,
        ResizeObserver: MockResizeObserver,
        matchMedia: () => ({ matches: false }),
        console,
    };
    const context = {
        window: windowObject,
        console,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        Date,
    };
    context.global = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: scriptPath });

    const elements = {
        chart2d: new MockElement('div'),
        chart3d: new MockElement('div'),
        mode2d: new MockElement(opts.radioModes ? 'input' : 'button', '2d'),
        mode3d: new MockElement(opts.radioModes ? 'input' : 'button', '3d'),
        reset: new MockElement('button'),
        status: new MockElement('p'),
        legend: new MockElement('div'),
        description: new MockElement('p'),
        interaction: new MockElement('button'),
    };
    const modeEvents = [];
    const statusEvents = [];
    const controller = context.window.SwitchStudioRadar3D;
    controller.init({
        chart2dEl: elements.chart2d,
        chart3dEl: elements.chart3d,
        modeInputs: [elements.mode2d, elements.mode3d],
        resetButton: elements.reset,
        statusEl: elements.status,
        legendEl: elements.legend,
        descriptionEl: elements.description,
        interactionButton: elements.interaction,
        plotly,
        zonesApi,
        storage,
        visible: opts.visible,
        activeDevice: opts.activeDevice,
        sceneModel: opts.sceneModel,
        initialMode: opts.initialMode,
        now: clock.now,
        setTimeoutFn: clock.setTimeout,
        clearTimeoutFn: clock.clearTimeout,
        isMobile: typeof opts.isMobile === 'function' ? opts.isMobile : () => !!opts.mobile,
        onModeChange: (mode, metadata) => modeEvents.push({ mode, metadata }),
        onStatus: (message, metadata) => statusEvents.push({ message, metadata }),
    });
    return {
        controller,
        elements,
        clock,
        plotly,
        zonesApi,
        storage,
        modeEvents,
        statusEvents,
        resizeObservers,
    };
}

function zone(areaId, offset) {
    const start = Number(offset || 0);
    return {
        area_id: areaId,
        x_min: start,
        x_max: start + 100,
        y_min: 20,
        y_max: 200,
        z_min: -40,
        z_max: 180,
    };
}

function scene(overrides) {
    return {
        zones: {
            global: zone('area1', 0),
            mmwave_detection_areas: {
                area1: zone('area1', 0),
                area2: zone('area2', 120),
                area3: zone('area3', 240),
            },
            mmwave_stay_areas: { area1: zone('area1', -200) },
            mmwave_interference_areas: [zone('area3', -320)],
        },
        visibility: {
            detection: true,
            detectionAreas: [true, false, true, true],
            stay: true,
            interference: true,
            fov: true,
            grid: true,
            labels: true,
        },
        bounds: { xMin: -500, xMax: 500, yMin: 0, yMax: 600, zMin: -250, zMax: 250 },
        ...(overrides || {}),
    };
}

test('defaults to 2D and creates Plotly lazily only after a visible 3D view is requested', () => {
    const setup = loadController({ visible: false, initialMode: '3d' });
    assert.equal(setup.controller.getMode(), '3d');
    assert.equal(setup.plotly.calls.some((call) => call.kind === 'newPlot'), false);
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart3d.hidden, true);

    setup.controller.setVisible(true);
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'newPlot').length, 1);
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.legend.hidden, false);
    assert.equal(setup.elements.reset.hidden, false);
});

test('mode controls persist the user preference and keep ARIA state synchronized', () => {
    const setup = loadController();
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(setup.elements.mode2d.getAttribute('aria-pressed'), 'true');
    assert.equal(setup.elements.legend.hidden, true);

    setup.elements.mode3d.click();
    assert.equal(setup.controller.getMode(), '3d');
    assert.equal(setup.storage.value('switchStudio.radarViewMode'), '3d');
    assert.equal(setup.elements.mode3d.getAttribute('aria-pressed'), 'true');
    assert.equal(setup.elements.description.dataset.radarMode, '3d');

    setup.elements.mode2d.click();
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(setup.storage.value('switchStudio.radarViewMode'), '2d');
    assert.equal(setup.elements.reset.hidden, true);
});

test('native radio controls use checked and disabled without redundant ARIA roles', () => {
    const setup = loadController({ radioModes: true });
    assert.equal(setup.elements.mode2d.checked, true);
    assert.equal(setup.elements.mode2d.getAttribute('aria-pressed'), null);
    assert.equal(setup.elements.mode2d.getAttribute('aria-checked'), null);
    setup.elements.mode3d.change();
    assert.equal(setup.elements.mode3d.checked, true);
    assert.equal(setup.elements.mode3d.getAttribute('aria-pressed'), null);
});

test('zone editing forces 2D without replacing the preference, then restores 3D', () => {
    const storage = createStorage({ 'switchStudio.radarViewMode': '3d' });
    const setup = loadController({ storage });
    assert.equal(setup.controller.getMode(), '3d');

    setup.controller.setEditing(true);
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(setup.elements.mode3d.disabled, true);
    assert.equal(storage.value('switchStudio.radarViewMode'), '3d');
    assert.match(setup.elements.status.textContent, /Zone editing uses the 2D radar/);

    setup.controller.setEditing(false);
    assert.equal(setup.controller.getMode(), '3d');
    assert.equal(setup.elements.mode3d.disabled, false);
    assert.equal(setup.modeEvents.at(-1).metadata.forced, false);
});

test('scene assembly uses exact XYZ bounds, one primary cuboid, slot visibility, and separate zone colors', () => {
    const setup = loadController({ sceneModel: scene(), initialMode: '3d' });
    const newPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');
    assert.ok(newPlot);
    assert.deepEqual(Array.from(newPlot.layout.scene.xaxis.range), [-500, 500]);
    assert.deepEqual(Array.from(newPlot.layout.scene.yaxis.range), [0, 600]);
    assert.deepEqual(Array.from(newPlot.layout.scene.zaxis.range), [-250, 250]);
    assert.equal(newPlot.layout.scene.aspectmode, 'data');
    assert.equal(newPlot.config.scrollZoom, true);

    assert.equal(setup.zonesApi.calls.fov.length, 1);
    assert.equal(setup.zonesApi.calls.fov[0].innerHalfAngleDegrees, 60);
    assert.equal(setup.zonesApi.calls.fov[0].outerHalfAngleDegrees, 75);
    assert.equal(setup.zonesApi.calls.fov[0].zMin, -250);
    assert.equal(setup.zonesApi.calls.fov[0].zMax, 250);

    const labels = setup.zonesApi.calls.zones.map((call) => call.options.name);
    assert.deepEqual(labels, [
        'Primary detection area',
        'Detection area 3',
        'Stay area 1',
        'Interference area 3',
    ]);
    assert.equal(labels.filter((label) => label === 'Primary detection area').length, 1);
    assert.notEqual(setup.zonesApi.calls.zones[0].options.color, setup.zonesApi.calls.zones[1].options.color);
    assert.equal(newPlot.traces.some((trace) => trace.name === 'Sensor' && trace.marker.color === '#ff6f7d'), true);
});

test('FOV remains capped at the supported six metre depth while axes can extend farther', () => {
    const model = scene();
    model.bounds.yMax = 900;
    const setup = loadController({ sceneModel: model, initialMode: '3d' });
    const newPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');

    assert.deepEqual(Array.from(newPlot.layout.scene.yaxis.range), [0, 900]);
    assert.equal(setup.zonesApi.calls.fov[0].yMax, 600);
});

test('FOV height stays authoritative while the scene axis can include other volumes', () => {
    const model = scene();
    model.bounds.zMin = -420;
    model.bounds.zMax = 510;
    model.fovBounds = { zMin: -120, zMax: 180 };
    const setup = loadController({ sceneModel: model, initialMode: '3d' });
    const newPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');

    assert.deepEqual(Array.from(newPlot.layout.scene.zaxis.range), [-420, 510]);
    assert.equal(setup.zonesApi.calls.fov[0].zMin, -120);
    assert.equal(setup.zonesApi.calls.fov[0].zMax, 180);
});

test('global detection bounds are used only when area1 is absent', () => {
    const model = scene();
    delete model.zones.mmwave_detection_areas.area1;
    const setup = loadController({ sceneModel: model, initialMode: '3d' });
    const primaryCalls = setup.zonesApi.calls.zones.filter((call) => call.options.name === 'Primary detection area');
    assert.equal(primaryCalls.length, 1);
    assert.equal(primaryCalls[0].zone.area_id, 'area1');
});

test('equivalent scene models do not rebuild FOV or zone geometry', () => {
    const setup = loadController({ sceneModel: scene(), initialMode: '3d' });
    const initialFovBuilds = setup.zonesApi.calls.fov.length;
    const initialZoneBuilds = setup.zonesApi.calls.zones.length;
    const initialReactCalls = setup.plotly.calls.filter((call) => call.kind === 'react').length;
    setup.controller.setSceneModel(scene());
    assert.equal(setup.zonesApi.calls.fov.length, initialFovBuilds);
    assert.equal(setup.zonesApi.calls.zones.length, initialZoneBuilds);
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'react').length, initialReactCalls);
});

test('target packets coalesce to at most 8Hz and do not rebuild static geometry', () => {
    const setup = loadController({ sceneModel: scene(), initialMode: '3d' });
    const initialZoneBuilds = setup.zonesApi.calls.zones.length;
    const initialFovBuilds = setup.zonesApi.calls.fov.length;
    const initialReactCalls = setup.plotly.calls.filter((call) => call.kind === 'react').length;
    const initialRestyleCalls = setup.plotly.calls.filter((call) => call.kind === 'restyle').length;

    setup.zonesApi.emitSnapshot({ reason: 'live', targets: [{ id: 1, x: 10, y: 20, z: 30 }], history: {} });
    setup.zonesApi.emitSnapshot({ reason: 'live', targets: [{ id: 1, x: 11, y: 21, z: 31 }], history: {} });
    setup.zonesApi.emitSnapshot({ reason: 'live', targets: [{ id: 1, x: 12, y: 22, z: 32 }], history: {} });
    assert.equal(setup.clock.pendingCount(), 1);
    setup.clock.advance(124);
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'restyle').length, initialRestyleCalls);
    setup.clock.advance(1);

    const restyles = setup.plotly.calls.filter((call) => call.kind === 'restyle');
    assert.equal(restyles.length, initialRestyleCalls + 1);
    assert.equal(restyles.at(-1).update.x[0][0], 12);
    assert.equal(restyles.at(-1).indices[0], setup.plotly.calls.find((call) => call.kind === 'newPlot').traces.length - 2);
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'react').length, initialReactCalls);
    assert.equal(setup.zonesApi.calls.zones.length, initialZoneBuilds);
    assert.equal(setup.zonesApi.calls.fov.length, initialFovBuilds);
});

test('async chart creation reconciles the latest device and target state before display', async () => {
    const plotly = createPlotly();
    let resolveCreation;
    plotly.newPlot = (element, traces, layout, config) => {
        plotly.calls.push({ kind: 'newPlot', element, traces, layout, config });
        return new Promise((resolve) => { resolveCreation = resolve; });
    };
    const setup = loadController({
        plotly,
        sceneModel: scene(),
        initialMode: '3d',
        activeDevice: 'device-a',
    });

    setup.controller.setVisible(false);
    setup.controller.setActiveDevice('device-b');
    const updatedScene = scene();
    updatedScene.bounds.zMin = -500;
    updatedScene.bounds.zMax = 500;
    setup.controller.setSceneModel(updatedScene);
    setup.zonesApi.emitSnapshot({
        reason: 'live',
        targets: [{ id: 1, x: 88, y: 144, z: 22 }],
        history: {},
    });
    resolveCreation(setup.elements.chart3d);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(plotly.calls.some((call) => call.kind === 'react'), false, 'hidden chart should defer reconciliation');
    setup.controller.setVisible(true);

    const reconciliation = plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.ok(reconciliation, 'the resolved chart should reconcile state that changed during creation');
    assert.match(reconciliation.layout.uirevision, /device-b/);
    assert.deepEqual(Array.from(reconciliation.layout.scene.zaxis.range), [-500, 500]);
    assert.deepEqual(Array.from(reconciliation.traces.at(-2).x), [88]);
});

test('mobile target rendering uses the lower 5Hz ceiling', () => {
    const setup = loadController({ initialMode: '3d', mobile: true });
    const initialRestyleCalls = setup.plotly.calls.filter((call) => call.kind === 'restyle').length;
    setup.zonesApi.emitSnapshot({ reason: 'live', targets: [{ id: 1, x: 1 }], history: {} });
    setup.clock.advance(199);
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'restyle').length, initialRestyleCalls);
    setup.clock.advance(1);
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'restyle').length, initialRestyleCalls + 1);
});

test('mobile 3D interaction is opt-in so the surrounding page remains scrollable', () => {
    const setup = loadController({ initialMode: '3d', mobile: true });
    const newPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');

    assert.equal(newPlot.config.scrollZoom, false);
    assert.equal(setup.elements.chart3d.dataset.interactionLocked, 'true');
    assert.equal(setup.elements.interaction.hidden, false);
    assert.equal(setup.elements.interaction.textContent, 'Explore 3D');
    assert.equal(setup.elements.interaction.getAttribute('aria-pressed'), 'false');

    setup.elements.interaction.click();
    assert.equal(setup.elements.chart3d.dataset.interactionLocked, 'false');
    assert.equal(setup.elements.interaction.textContent, 'Done');
    assert.equal(setup.elements.interaction.getAttribute('aria-pressed'), 'true');

    setup.elements.mode2d.click();
    assert.equal(setup.elements.interaction.hidden, true);
});

test('crossing the phone breakpoint reapplies layout and input configuration', () => {
    let mobile = false;
    const setup = loadController({ initialMode: '3d', isMobile: () => mobile });
    const initialPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');
    const userCamera = {
        eye: { x: 2.2, y: -0.8, z: 1.7 },
        center: { x: 0.1, y: 0.2, z: -0.1 },
        up: { x: 0, y: 0, z: 1 },
        projection: { type: 'perspective' },
    };
    setup.elements.chart3d._fullLayout = {
        scene: { camera: userCamera, uirevision: initialPlot.layout.uirevision },
    };

    assert.equal(initialPlot.config.scrollZoom, true);
    assert.deepEqual({ ...initialPlot.layout.margin }, { l: 14, r: 18, t: 8, b: 14 });

    mobile = true;
    setup.resizeObservers[0].callback();
    const mobileReact = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.equal(mobileReact.config.scrollZoom, false);
    assert.deepEqual({ ...mobileReact.layout.margin }, { l: 30, r: 24, t: 10, b: 32 });
    assert.deepEqual(JSON.parse(JSON.stringify(mobileReact.layout.scene.camera)), userCamera);
    assert.equal(setup.elements.chart3d.dataset.interactionLocked, 'true');
    assert.equal(setup.elements.interaction.hidden, false);

    mobile = false;
    setup.resizeObservers[0].callback();
    const desktopReact = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.equal(desktopReact.config.scrollZoom, true);
    assert.deepEqual({ ...desktopReact.layout.margin }, { l: 14, r: 18, t: 8, b: 14 });
    assert.deepEqual(JSON.parse(JSON.stringify(desktopReact.layout.scene.camera)), userCamera);
    assert.equal(setup.elements.chart3d.dataset.interactionLocked, 'false');
    assert.equal(setup.elements.interaction.hidden, true);
});

test('target rendering safely falls back to react when Plotly restyle is unavailable', () => {
    const plotly = createPlotly();
    delete plotly.restyle;
    const setup = loadController({ initialMode: '3d', plotly });
    const initialReactCalls = plotly.calls.filter((call) => call.kind === 'react').length;
    setup.zonesApi.emitSnapshot({ reason: 'live', targets: [{ id: 1, x: 5 }], history: {} });
    setup.clock.advance(125);
    assert.equal(plotly.calls.filter((call) => call.kind === 'react').length, initialReactCalls + 1);
});

test('uirevision is stable for one device and changes to reset the camera for another', () => {
    const setup = loadController({ sceneModel: scene(), initialMode: '3d', activeDevice: 'device-a' });
    const firstRevision = setup.plotly.calls.find((call) => call.kind === 'newPlot').layout.uirevision;
    const userCamera = {
        eye: { x: 1.9, y: -0.6, z: 1.5 },
        center: { x: 0.2, y: 0.1, z: 0 },
        up: { x: 0, y: 0, z: 1 },
    };
    setup.elements.chart3d._fullLayout = {
        scene: { camera: userCamera, uirevision: firstRevision },
    };
    setup.controller.setSceneModel(scene({ bounds: { xMin: -600, xMax: 600, yMin: 0, yMax: 700, zMin: -300, zMax: 300 } }));
    const sameDeviceRender = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    const sameDeviceRevision = sameDeviceRender.layout.uirevision;
    assert.equal(sameDeviceRevision, firstRevision);
    assert.deepEqual(JSON.parse(JSON.stringify(sameDeviceRender.layout.scene.camera)), userCamera);

    setup.controller.setActiveDevice('device-b');
    const changedDeviceRender = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    const changedRevision = changedDeviceRender.layout.uirevision;
    assert.notEqual(changedRevision, firstRevision);
    assert.match(changedRevision, /device-b/);
    assert.equal(changedDeviceRender.layout.scene.camera.eye.x, 1.55);

    const newDeviceScene = scene();
    newDeviceScene.bounds.zMax = 420;
    setup.controller.setSceneModel(newDeviceScene);
    const immediateNewDeviceRefresh = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.equal(immediateNewDeviceRefresh.layout.scene.camera.eye.x, 1.55);
});

test('reset view restores the default camera and device reset clears live targets', () => {
    const setup = loadController({ initialMode: '3d', activeDevice: 'device-a' });
    setup.elements.reset.click();
    const relayout = setup.plotly.calls.find((call) => call.kind === 'relayout');
    assert.ok(relayout.update['scene.camera'].eye);

    setup.zonesApi.emitSnapshot({ reason: 'live', targets: [{ id: 1, x: 44 }], history: {} });
    setup.controller.resetForDeviceChange('device-b');
    const lastReact = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.match(lastReact.layout.uirevision, /device-b/);
    assert.deepEqual(Array.from(lastReact.traces.at(-2).x), []);
});

test('missing Plotly falls back to 2D with a useful error status', () => {
    const setup = loadController({ plotly: null });
    setup.elements.mode3d.click();
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.mode3d.disabled, true);
    assert.match(setup.elements.status.textContent, /3D radar is unavailable/);
    assert.equal(setup.statusEvents.at(-1).metadata.kind, 'error');
});

test('WebGL loss prevents the browser default, falls back to 2D, and restores the preference', () => {
    const setup = loadController({ initialMode: '3d' });
    let prevented = false;
    setup.elements.chart3d.dispatch('webglcontextlost', {
        preventDefault: () => { prevented = true; },
    });
    assert.equal(prevented, true);
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(setup.elements.mode3d.disabled, true);
    assert.match(setup.elements.status.textContent, /lost its graphics context/);

    setup.elements.chart3d.dispatch('webglcontextrestored', {});
    assert.equal(setup.controller.getMode(), '3d');
    assert.equal(setup.elements.mode3d.disabled, false);
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'newPlot').length, 2);
});

test('a stale pre-loss chart creation cannot tear down the restored 3D view', async () => {
    const plotly = createPlotly();
    const creations = [];
    plotly.newPlot = (element, traces, layout, config) => {
        plotly.calls.push({ kind: 'newPlot', element, traces, layout, config });
        return new Promise((resolve, reject) => creations.push({ resolve, reject }));
    };
    const setup = loadController({ initialMode: '3d', plotly });

    setup.elements.chart3d.dispatch('webglcontextlost', { preventDefault() {} });
    setup.elements.chart3d.dispatch('webglcontextrestored', {});
    assert.equal(creations.length, 2);

    creations[1].resolve(setup.elements.chart3d);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(setup.controller.getMode(), '3d');

    creations[0].reject(new Error('stale WebGL initialization failure'));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(setup.controller.getMode(), '3d');
    assert.doesNotMatch(setup.elements.status.textContent, /unavailable|failed/i);
});

test('a stale pre-loss scene render rejection cannot tear down the restored 3D view', async () => {
    const plotly = createPlotly();
    let rejectSceneRender;
    plotly.react = (element, traces, layout, config) => {
        plotly.calls.push({ kind: 'react', element, traces, layout, config });
        return new Promise((resolve, reject) => { rejectSceneRender = reject; });
    };
    const setup = loadController({ initialMode: '3d', plotly, sceneModel: scene() });
    const updated = scene();
    updated.bounds.zMax = 480;
    setup.controller.setSceneModel(updated);

    setup.elements.chart3d.dispatch('webglcontextlost', { preventDefault() {} });
    setup.elements.chart3d.dispatch('webglcontextrestored', {});
    assert.equal(setup.controller.getMode(), '3d');

    rejectSceneRender(new Error('stale scene render failure'));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(setup.controller.getMode(), '3d');
    assert.doesNotMatch(setup.elements.status.textContent, /unavailable|failed/i);
});

test('an older same-device scene rejection cannot override a newer render', async () => {
    const plotly = createPlotly();
    const sceneRenders = [];
    plotly.react = (element, traces, layout, config) => {
        plotly.calls.push({ kind: 'react', element, traces, layout, config });
        return new Promise((resolve, reject) => sceneRenders.push({ resolve, reject }));
    };
    const setup = loadController({ initialMode: '3d', plotly, sceneModel: scene() });
    const baselineRenders = sceneRenders.length;
    const firstUpdate = scene();
    firstUpdate.bounds.zMax = 450;
    setup.controller.setSceneModel(firstUpdate);
    const secondUpdate = scene();
    secondUpdate.bounds.zMax = 500;
    setup.controller.setSceneModel(secondUpdate);
    assert.equal(sceneRenders.length, baselineRenders + 2);

    sceneRenders.at(-1).resolve(setup.elements.chart3d);
    sceneRenders.at(-2).reject(new Error('superseded scene render failure'));
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(setup.controller.getMode(), '3d');
    assert.doesNotMatch(setup.elements.status.textContent, /unavailable|failed/i);
});

test('ResizeObserver resizes only the active 3D surface and destroy detaches resources', () => {
    const setup = loadController({ initialMode: '3d' });
    assert.equal(setup.resizeObservers.length, 1);
    setup.resizeObservers[0].callback();
    assert.ok(setup.plotly.calls.some((call) => call.kind === 'resize'));
    assert.equal(setup.zonesApi.hasSnapshotListener(), true);

    setup.controller.destroy();
    assert.equal(setup.resizeObservers[0].disconnected, true);
    assert.equal(setup.zonesApi.hasSnapshotListener(), false);
    assert.ok(setup.plotly.calls.some((call) => call.kind === 'purge'));
});
