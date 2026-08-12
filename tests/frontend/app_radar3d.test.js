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
        if (!payload.type) payload.type = type;
        if (!payload.target) payload.target = this;
        for (const listener of this.listeners.get(type) || []) listener(payload);
    }

    on(type, listener) {
        this.addEventListener(type, listener);
        return this;
    }

    removeListener(type, listener) {
        this.removeEventListener(type, listener);
        return this;
    }

    emit(type, event) {
        this.dispatch(type, event);
        return this;
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

function createStorage(initial, options) {
    const opts = options || {};
    const values = new Map(Object.entries(initial || {}));
    const writes = [];
    return {
        getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem(key, value) {
            writes.push({ key, value: String(value) });
            if (typeof opts.failSet === 'function' && opts.failSet(key, value)) {
                throw new Error(`Storage write rejected for ${key}`);
            }
            values.set(key, String(value));
        },
        value: (key) => values.get(key),
        writes,
    };
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function flushPromises(count = 4) {
    for (let index = 0; index < count; index += 1) await Promise.resolve();
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
        buildZoneCuboidGeometry(zone) {
            const read = (primary, alternate) => {
                const value = Number(zone?.[primary] ?? zone?.[alternate]);
                return Number.isFinite(value) ? value : null;
            };
            const raw = {
                xMin: read('x_min', 'width_min'),
                xMax: read('x_max', 'width_max'),
                yMin: read('y_min', 'depth_min'),
                yMax: read('y_max', 'depth_max'),
                zMin: read('z_min', 'height_min'),
                zMax: read('z_max', 'height_max'),
            };
            if (Object.values(raw).some((value) => value === null)) return null;
            return {
                bounds: {
                    xMin: Math.min(raw.xMin, raw.xMax),
                    xMax: Math.max(raw.xMin, raw.xMax),
                    yMin: Math.min(raw.yMin, raw.yMax),
                    yMax: Math.max(raw.yMin, raw.yMax),
                    zMin: Math.min(raw.zMin, raw.zMax),
                    zMax: Math.max(raw.zMin, raw.zMax),
                },
            };
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

    const windowObject = Object.assign(new MockElement('window'), {
        Plotly: plotly,
        SwitchStudioZones: zonesApi,
        localStorage: storage,
        ResizeObserver: MockResizeObserver,
        matchMedia: () => ({ matches: false }),
        console,
    });
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
        prefersReducedMotion: typeof opts.prefersReducedMotion === 'function'
            ? opts.prefersReducedMotion
            : () => !!opts.reducedMotion,
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
        windowObject,
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

const TOP_DOWN_CAMERA = {
    eye: { x: 0, y: -0.12, z: 1.68 },
    center: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    projection: { type: 'perspective' },
};

const DEFAULT_PERSPECTIVE_CAMERA = {
    eye: { x: 1.55, y: -1.72, z: 1.2 },
    center: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    projection: { type: 'perspective' },
};

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertVectorClose(actual, expected, tolerance = 1e-9) {
    ['x', 'y', 'z'].forEach((key) => {
        assert.ok(
            Math.abs(Number(actual[key]) - Number(expected[key])) <= tolerance,
            `${key} expected ${expected[key]}, received ${actual[key]}`,
        );
    });
}

function assertCameraClose(actual, expected, tolerance = 1e-9) {
    assertVectorClose(actual.eye, expected.eye, tolerance);
    assertVectorClose(actual.center, expected.center, tolerance);
    assertVectorClose(actual.up, expected.up, tolerance);
    if (actual.projection) assert.equal(actual.projection.type, expected.projection.type);
}

function cameraRelayouts(setup) {
    return setup.plotly.calls.filter((call) => call.kind === 'relayout'
        && (call.update['scene.camera'] || call.update['scene.camera.eye']));
}

function projectionRelayouts(setup) {
    return setup.plotly.calls.filter((call) => call.kind === 'relayout' && (
        !!call.update['scene.camera']?.projection
        || Object.keys(call.update).some((key) => key.startsWith('scene.camera.projection'))
    ));
}

function cameraFromRelayout(call) {
    if (call.update['scene.camera']) return call.update['scene.camera'];
    return {
        eye: call.update['scene.camera.eye'],
        center: call.update['scene.camera.center'],
        up: call.update['scene.camera.up'],
    };
}

function finishCameraTransition(setup, targetMode) {
    // Forward mode changes prepare for 48 ms, crossfade for 170 ms, and then
    // run the 560 ms orbit, which resolves on the following 24 ms frame.
    // Returning to native 2D keeps the 560 ms orbit followed by its 170 ms
    // surface retirement.
    setup.clock.advance(targetMode === '2d' ? 760 : 800);
}

function traceLineSegments(trace) {
    assert.equal(trace.x.length, trace.y.length);
    assert.equal(trace.x.length, trace.z.length);
    assert.equal(trace.x.length % 3, 0, 'each grid line should use two endpoints and one separator');
    const segments = [];
    for (let index = 0; index < trace.x.length; index += 3) {
        assert.equal(trace.x[index + 2], null);
        assert.equal(trace.y[index + 2], null);
        assert.equal(trace.z[index + 2], null);
        segments.push({
            x1: trace.x[index],
            y1: trace.y[index],
            z1: trace.z[index],
            x2: trace.x[index + 1],
            y2: trace.y[index + 1],
            z2: trace.z[index + 1],
        });
    }
    return segments;
}

function createGestureEvent(overrides) {
    const state = {
        defaultPrevented: false,
        immediatePropagationStopped: false,
        propagationStopped: false,
    };
    return {
        state,
        preventDefault() { state.defaultPrevented = true; },
        stopImmediatePropagation() { state.immediatePropagationStopped = true; },
        stopPropagation() { state.propagationStopped = true; },
        ...(overrides || {}),
    };
}

test('native Cartesian 2D stays active without creating WebGL until 3D is requested', () => {
    const setup = loadController({ visible: false });
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(setup.plotly.calls.some((call) => call.kind === 'newPlot'), false);
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart3d.hidden, true);

    setup.controller.setVisible(true);
    assert.equal(setup.plotly.calls.some((call) => call.kind === 'newPlot'), false);
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart2d.getAttribute('aria-hidden'), 'false');
    assert.equal(setup.elements.chart3d.hidden, true);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.legend.hidden, true);
    assert.equal(setup.elements.reset.hidden, true);

    setup.elements.mode3d.click();
    const plots = setup.plotly.calls.filter((call) => call.kind === 'newPlot');
    assert.equal(plots.length, 1);
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'outgoing');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'incoming');
    assert.equal(plots[0].layout.scene.dragmode, 'turntable');
    assert.equal(plots[0].layout.scene.aspectmode, 'manual');
    assertVectorClose(plots[0].layout.scene.aspectratio, { x: 1, y: 0.5, z: 1 });
    assert.notEqual(plots[0].layout.scene.zaxis.visible, false);
    assert.equal(plots[0].config.scrollZoom, false);
    assertCameraClose(plain(plots[0].layout.scene.camera), TOP_DOWN_CAMERA);
    assert.equal(setup.elements.chart3d.dataset.interactionLocked, 'true');
    assert.match(setup.elements.chart3d.getAttribute('aria-label'), /Three-dimensional live presence radar/);
});

test('a stored 3D preference creates a measurable scene that remains orbitable across hidden navigation', () => {
    const storage = createStorage({ 'switchStudio.radarViewMode': '3d' });
    const plotly = createPlotly();
    const originalNewPlot = plotly.newPlot;
    let surfaceAtCreation = null;
    plotly.newPlot = (element, traces, layout, config) => {
        surfaceAtCreation = {
            hidden: element.hidden,
            state: element.dataset.radarSurfaceState,
        };
        return originalNewPlot(element, traces, layout, config);
    };
    const setup = loadController({
        storage,
        plotly,
        visible: false,
        activeDevice: 'unselected',
        sceneModel: scene(),
    });
    const firstCamera = {
        eye: { x: -1.55, y: -1.3, z: 1.1 },
        center: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 0, z: 1 },
        projection: { type: 'perspective' },
    };
    const secondCamera = {
        eye: { x: 1.25, y: -1.85, z: 0.75 },
        center: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 0, z: 1 },
        projection: { type: 'perspective' },
    };

    assert.equal(setup.controller.getMode(), '3d');
    assert.equal(plotly.calls.some((call) => call.kind === 'newPlot'), false);
    setup.controller.setActiveDevice('device-a');
    setup.controller.setSceneModel(scene({
        bounds: { xMin: -620, xMax: 620, yMin: 0, yMax: 720, zMin: -300, zMax: 420 },
    }));
    setup.controller.setVisible(true);

    const created = plotly.calls.find((call) => call.kind === 'newPlot');
    assert.ok(created);
    assert.deepEqual(surfaceAtCreation, { hidden: false, state: 'incoming' });
    assert.equal(created.layout.scene.dragmode, 'turntable');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(setup.elements.chart3d.dataset.interactionLocked, 'false');

    const relayoutCount = cameraRelayouts(setup).length;
    setup.elements.chart3d.dispatch('pointerdown', createGestureEvent({ button: 0 }));
    setup.elements.chart3d.emit('plotly_relayouting', { 'scene.camera': firstCamera });
    setup.elements.chart3d.emit('plotly_relayout', { 'scene.camera': firstCamera });
    setup.elements.chart3d._fullLayout = {
        scene: {
            camera: firstCamera,
            uirevision: created.layout.scene.uirevision,
        },
    };
    setup.clock.advance(250);
    assert.equal(setup.elements.chart3d.dataset.cameraGesture, 'active', 'Plotly relayout must not impersonate a physical release');
    setup.elements.chart3d.dispatch('pointerup', createGestureEvent());
    setup.clock.advance(0);
    assert.equal(setup.elements.chart3d.dataset.cameraGesture, 'idle');
    assert.equal(cameraRelayouts(setup).length, relayoutCount + 1, 'the safe live camera is persisted before future scene writes');
    assertCameraClose(cameraFromRelayout(cameraRelayouts(setup).at(-1)), firstCamera);

    setup.controller.setVisible(false);
    assert.equal(setup.elements.chart3d.hidden, true);
    setup.controller.setVisible(true);
    assert.equal(plotly.calls.filter((call) => call.kind === 'newPlot').length, 1);
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.dataset.interactionLocked, 'false');

    setup.elements.chart3d.dispatch('pointerdown', createGestureEvent({ button: 0 }));
    setup.elements.chart3d.emit('plotly_relayouting', { 'scene.camera': secondCamera });
    setup.elements.chart3d._fullLayout = {
        scene: {
            camera: secondCamera,
            uirevision: created.layout.scene.uirevision,
        },
    };
    setup.windowObject.dispatch('pointerup', createGestureEvent());
    setup.clock.advance(0);
    assert.equal(setup.elements.chart3d.dataset.cameraGesture, 'idle');
    assert.equal(cameraRelayouts(setup).length, relayoutCount + 2);
    assertCameraClose(cameraFromRelayout(cameraRelayouts(setup).at(-1)), secondCamera);
});

test('a stored 3D scene stays prepared but noninteractive until async post-create state is reconciled', async () => {
    const storage = createStorage({ 'switchStudio.radarViewMode': '3d' });
    const plotly = createPlotly();
    const creation = createDeferred();
    const reconciliation = createDeferred();
    plotly.newPlot = (element, traces, layout, config) => {
        plotly.calls.push({ kind: 'newPlot', element, traces, layout, config });
        return creation.promise;
    };
    plotly.react = (element, traces, layout, config) => {
        plotly.calls.push({ kind: 'react', element, traces, layout, config });
        return reconciliation.promise;
    };
    const setup = loadController({
        storage,
        plotly,
        visible: false,
        activeDevice: 'device-a',
        sceneModel: scene(),
    });

    setup.controller.setVisible(true);
    assert.equal(setup.elements.chart3d.hidden, false, 'newPlot receives a measurable prepared surface');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'incoming');
    assert.equal(setup.elements.chart3d.getAttribute('aria-hidden'), 'true');

    setup.zonesApi.emitSnapshot({
        reason: 'creation-dirty',
        targets: [{ id: 1, x: 44, y: 128, z: 26 }],
        history: {},
    });
    creation.resolve(setup.elements.chart3d);
    await flushPromises();

    const postCreate = plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.ok(postCreate, 'the latest target state must reconcile after WebGL creation');
    assert.deepEqual(Array.from(postCreate.traces.at(-2).x), [44]);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'incoming');
    assert.equal(setup.elements.chart3d.getAttribute('aria-hidden'), 'true');
    assert.equal(
        plotly.calls.filter((call) => call.kind === 'resize').length,
        0,
        'the prepared surface must not resize before it is display-active',
    );

    reconciliation.resolve(setup.elements.chart3d);
    await flushPromises();
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.getAttribute('aria-hidden'), 'false');
    assert.equal(setup.elements.chart3d.dataset.interactionLocked, 'false');
    assert.equal(plotly.calls.filter((call) => call.kind === 'resize').length, 1);

    setup.elements.chart3d.dispatch('pointerdown', createGestureEvent({ button: 0 }));
    assert.equal(setup.elements.chart3d.dataset.cameraGesture, 'active', 'the first orbit is accepted immediately after reveal');
});

test('mode controls crossfade native 2D with one perspective scene and a fixed world frame', () => {
    const setup = loadController();
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(setup.elements.mode2d.getAttribute('aria-pressed'), 'true');
    assert.equal(setup.elements.legend.hidden, true);
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'newPlot').length, 0);

    setup.elements.mode3d.click();
    assert.equal(setup.controller.getMode(), '3d');
    assert.equal(setup.storage.value('switchStudio.radarViewMode'), '3d');
    assert.equal(setup.elements.mode3d.getAttribute('aria-pressed'), 'true');
    assert.equal(setup.elements.description.dataset.radarMode, '3d');
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'outgoing');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'incoming');
    assert.equal(setup.elements.reset.hidden, true);
    assert.equal(setup.controller.resetView(), false);
    const preparedPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');
    assertCameraClose(plain(preparedPlot.layout.scene.camera), TOP_DOWN_CAMERA);
    assert.equal(cameraRelayouts(setup).length, 0);

    setup.clock.advance(47);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'outgoing');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'incoming');
    assert.equal(cameraRelayouts(setup).length, 0, 'the prepared top-down scene must not orbit before its fade begins');
    setup.clock.advance(1);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'retiring');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(cameraRelayouts(setup).length, 0);

    setup.clock.advance(169);
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'retiring');
    assert.equal(cameraRelayouts(setup).length, 0);
    setup.clock.advance(1);
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(cameraRelayouts(setup).length, 0, 'the orbit must wait until the surface crossfade has settled');

    setup.clock.advance(23);
    assert.equal(cameraRelayouts(setup).length, 0);
    setup.clock.advance(1);
    const firstOrbitCamera = cameraFromRelayout(cameraRelayouts(setup).at(-1));
    const firstOrbitDelta = Math.hypot(
        firstOrbitCamera.eye.x - TOP_DOWN_CAMERA.eye.x,
        firstOrbitCamera.eye.y - TOP_DOWN_CAMERA.eye.y,
        firstOrbitCamera.eye.z - TOP_DOWN_CAMERA.eye.z,
    );
    assert.ok(firstOrbitDelta < 0.25, `first forward orbit frame jumped ${firstOrbitDelta}`);

    setup.clock.advance(551);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');
    setup.clock.advance(1);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.reset.hidden, false);
    const forwardRelayouts = cameraRelayouts(setup);
    const perspectiveRelayout = cameraRelayouts(setup).at(-1);
    const perspective = cameraFromRelayout(perspectiveRelayout);
    assertCameraClose(plain(perspective), DEFAULT_PERSPECTIVE_CAMERA);
    assert.deepEqual(Array.from(perspectiveRelayout.update['scene.xaxis.range']), [-650, 650]);
    assert.equal(perspectiveRelayout.update['scene.aspectmode'], 'manual');
    assertVectorClose(
        perspectiveRelayout.update['scene.aspectratio'],
        { x: 1, y: 0.5, z: 1 },
    );
    assert.equal(perspectiveRelayout.update['scene.dragmode'], 'turntable');
    assert.ok(forwardRelayouts.length >= 20, 'the 560 ms orbit should emit a smooth sequence of frames');
    let previousEye = TOP_DOWN_CAMERA.eye;
    forwardRelayouts.forEach((call, index) => {
        const camera = cameraFromRelayout(call);
        const frameDelta = Math.hypot(
            camera.eye.x - previousEye.x,
            camera.eye.y - previousEye.y,
            camera.eye.z - previousEye.z,
        );
        assert.ok(frameDelta < 0.25, `forward orbit frame ${index + 1} jumped ${frameDelta}`);
        assert.ok(camera.eye.x >= -1e-9, `forward orbit frame ${index + 1} inverted world X`);
        assert.ok(camera.eye.y < 0, `forward orbit frame ${index + 1} crossed the camera behind the map`);
        assert.ok(-camera.eye.y > 0, `forward orbit frame ${index + 1} must keep world +X screen-right`);
        assert.deepEqual(plain(camera.center), { x: 0, y: 0, z: 0 });
        assert.deepEqual(plain(camera.up), { x: 0, y: 0, z: 1 });
        assert.equal(call.update['scene.camera']?.projection, undefined);
        previousEye = camera.eye;
    });

    const reverseStart = cameraRelayouts(setup).length;
    setup.elements.mode2d.click();
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(setup.storage.value('switchStudio.radarViewMode'), '2d');
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'incoming');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'outgoing');

    setup.clock.advance(559);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');
    setup.clock.advance(17);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'retiring');
    const reverseRelayouts = cameraRelayouts(setup).slice(reverseStart);
    assertCameraClose(plain(cameraFromRelayout(reverseRelayouts.at(-1))), TOP_DOWN_CAMERA);
    reverseRelayouts.forEach((call) => {
        const camera = cameraFromRelayout(call);
        assert.deepEqual(plain(camera.center), { x: 0, y: 0, z: 0 });
        assert.deepEqual(plain(camera.up), { x: 0, y: 0, z: 1 });
        assert.equal(call.update['scene.camera']?.projection, undefined);
    });
    setup.clock.advance(169);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');
    setup.clock.advance(1);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.hidden, true);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.legend.hidden, true);
    assert.equal(setup.elements.reset.hidden, true);
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'newPlot').length, 1);
    assert.equal(setup.plotly.calls.some((call) => call.kind === 'purge'), false);
    assert.equal(projectionRelayouts(setup).length, 0);
});

test('perspective-only mode transitions do not rebuild or discard scene canvases', () => {
    const setup = loadController();
    let removed = false;
    let contextLost = false;
    const staleCanvas = {
        remove() { removed = true; },
        getContext() {
            return {
                getExtension() {
                    return { loseContext() { contextLost = true; } };
                },
            };
        },
    };
    const activeCanvas = {};
    setup.elements.chart3d._fullLayout = {
        scene: { _scene: { glplot: { canvas: activeCanvas } } },
    };
    setup.elements.chart3d.querySelectorAll = () => [staleCanvas, activeCanvas];

    setup.elements.mode3d.click();
    finishCameraTransition(setup, '3d');
    setup.elements.mode2d.click();
    finishCameraTransition(setup, '2d');

    assert.equal(removed, false);
    assert.equal(contextLost, false);
    assert.equal(projectionRelayouts(setup).length, 0);
});

test('reduced motion applies the requested camera immediately without scheduling a handoff', () => {
    const setup = loadController({ reducedMotion: true });
    const pendingBefore = setup.clock.pendingCount();

    setup.elements.mode3d.click();

    assert.equal(setup.controller.getMode(), '3d');
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(setup.clock.pendingCount(), pendingBefore);
    const relayout = cameraRelayouts(setup).at(-1);
    assertCameraClose(plain(cameraFromRelayout(relayout)), DEFAULT_PERSPECTIVE_CAMERA);
    assert.equal(relayout.update['scene.camera'], undefined);
    assert.equal(projectionRelayouts(setup).length, 0);
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart3d.hidden, false);
});

test('rapid mode reversal continues from the in-flight camera path and latest mode wins', () => {
    const setup = loadController();

    setup.elements.mode3d.click();
    setup.clock.advance(498);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');
    const forwardCalls = cameraRelayouts(setup);
    const forwardCamera = cameraFromRelayout(forwardCalls.at(-1));
    assert.deepEqual(plain(forwardCamera.center), { x: 0, y: 0, z: 0 });
    assert.deepEqual(plain(forwardCamera.up), { x: 0, y: 0, z: 1 });

    setup.elements.mode2d.click();
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(cameraRelayouts(setup).length, forwardCalls.length);
    setup.clock.advance(24);
    const reverseCalls = cameraRelayouts(setup);
    assert.equal(reverseCalls.length, forwardCalls.length + 1);
    const reverseCamera = cameraFromRelayout(reverseCalls.at(-1));
    const reversalDelta = Math.hypot(
        reverseCamera.eye.x - forwardCamera.eye.x,
        reverseCamera.eye.y - forwardCamera.eye.y,
        reverseCamera.eye.z - forwardCamera.eye.z,
    );
    assert.ok(reversalDelta < 0.25, `reversal camera jump was ${reversalDelta}`);
    assert.deepEqual(plain(reverseCamera.center), { x: 0, y: 0, z: 0 });
    assert.deepEqual(plain(reverseCamera.up), { x: 0, y: 0, z: 1 });

    // Only the unfinished canonical path is reversed. This must settle well
    // before a fresh 560 ms reverse orbit plus 170 ms fade would complete.
    setup.clock.advance(450);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    const completedCount = cameraRelayouts(setup).length;
    assertCameraClose(
        plain(cameraFromRelayout(cameraRelayouts(setup).at(-1))),
        TOP_DOWN_CAMERA,
    );

    setup.clock.advance(1000);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(cameraRelayouts(setup).length, completedCount);
    assert.equal(setup.storage.value('switchStudio.radarViewMode'), '2d');
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.hidden, true);
    cameraRelayouts(setup).forEach((call) => {
        const camera = cameraFromRelayout(call);
        assert.deepEqual(plain(camera.center), { x: 0, y: 0, z: 0 });
        assert.deepEqual(plain(camera.up), { x: 0, y: 0, z: 1 });
        assert.equal(call.update['scene.camera']?.projection, undefined);
    });
    assert.equal(projectionRelayouts(setup).length, 0);
});

test('reversing during the forward surface prelude restores native 2D immediately', () => {
    const setup = loadController();

    setup.elements.mode3d.click();
    setup.clock.advance(100);
    assert.equal(setup.controller.getMode(), '3d');
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'retiring');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(cameraRelayouts(setup).length, 0, 'the 560 ms orbit must not have begun during the crossfade');

    setup.elements.mode2d.click();
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(setup.storage.value('switchStudio.radarViewMode'), '2d');
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart2d.getAttribute('aria-hidden'), 'false');
    assert.equal(setup.elements.chart3d.hidden, true);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'inactive');
    assert.equal(cameraRelayouts(setup).length, 0);

    setup.clock.advance(1000);
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.hidden, true);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'inactive');
    assert.equal(cameraRelayouts(setup).length, 0, 'the canceled forward timers must not restart a stale orbit');
    assert.equal(projectionRelayouts(setup).length, 0);
});

test('a hidden canceled reverse handoff restarts 3D continuously from the top-down bridge', () => {
    const setup = loadController({ initialMode: '3d' });

    setup.elements.mode2d.click();
    setup.clock.advance(280);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');
    const interruptedCamera = cameraFromRelayout(cameraRelayouts(setup).at(-1));
    const interruptedDistanceFromBridge = Math.hypot(
        interruptedCamera.eye.x - TOP_DOWN_CAMERA.eye.x,
        interruptedCamera.eye.y - TOP_DOWN_CAMERA.eye.y,
        interruptedCamera.eye.z - TOP_DOWN_CAMERA.eye.z,
    );
    assert.ok(interruptedDistanceFromBridge > 0.25, 'the sampled reverse frame should be meaningfully mid-path');

    setup.controller.setVisible(false);
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart3d.hidden, true);
    setup.controller.setVisible(true);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.hidden, true);

    const callsBeforeForward = cameraRelayouts(setup).length;
    setup.elements.mode3d.click();
    assert.equal(cameraRelayouts(setup).length, callsBeforeForward);
    setup.clock.advance(241);
    assert.equal(cameraRelayouts(setup).length, callsBeforeForward);
    setup.clock.advance(1);
    assert.equal(cameraRelayouts(setup).length, callsBeforeForward + 1);
    const firstForwardCamera = cameraFromRelayout(cameraRelayouts(setup).at(-1));
    const bridgeDelta = Math.hypot(
        firstForwardCamera.eye.x - TOP_DOWN_CAMERA.eye.x,
        firstForwardCamera.eye.y - TOP_DOWN_CAMERA.eye.y,
        firstForwardCamera.eye.z - TOP_DOWN_CAMERA.eye.z,
    );
    assert.ok(bridgeDelta < 0.25, `prepared bridge camera jump was ${bridgeDelta}`);
    assert.deepEqual(plain(firstForwardCamera.center), { x: 0, y: 0, z: 0 });
    assert.deepEqual(plain(firstForwardCamera.up), { x: 0, y: 0, z: 1 });

    finishCameraTransition(setup, '3d');
    assert.equal(setup.controller.getMode(), '3d');
    assertCameraClose(
        plain(cameraFromRelayout(cameraRelayouts(setup).at(-1))),
        DEFAULT_PERSPECTIVE_CAMERA,
    );
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(projectionRelayouts(setup).length, 0);
});

test('target packets received during a camera transition reconcile once with the latest snapshot', () => {
    const setup = loadController();
    const restylesBefore = setup.plotly.calls.filter((call) => call.kind === 'restyle').length;
    const reactsBefore = setup.plotly.calls.filter((call) => call.kind === 'react').length;

    setup.elements.mode3d.click();
    setup.zonesApi.emitSnapshot({ reason: 'live', targets: [{ id: 1, x: 10, y: 20, z: 30 }], history: {} });
    setup.zonesApi.emitSnapshot({ reason: 'live', targets: [{ id: 1, x: 44, y: 55, z: 66 }], history: {} });
    setup.clock.advance(793);

    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'restyle').length, restylesBefore);
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'react').length, reactsBefore);

    setup.clock.advance(1);
    const reconciliation = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'restyle').length, restylesBefore);
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'react').length, reactsBefore + 1);
    assert.deepEqual(Array.from(reconciliation.traces.at(-2).x), [44]);
    assert.equal(reconciliation.layout.scene.camera.projection.type, 'perspective');
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
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart3d.hidden, true);
    assert.equal(setup.elements.legend.hidden, true);
    assert.equal(storage.value('switchStudio.radarViewMode'), '3d');
    assert.match(setup.elements.status.textContent, /Zone editing uses the 2D radar/);
    assert.equal(setup.modeEvents.at(-1).metadata.surface, 'editor2d');

    setup.controller.setEditing(false);
    assert.equal(setup.controller.getMode(), '3d');
    assert.equal(setup.elements.mode3d.disabled, false);
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'retiring');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');

    setup.clock.advance(169);
    assert.equal(setup.elements.chart2d.hidden, false);
    setup.clock.advance(1);
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(setup.elements.chart3d.dataset.radarMode, '3d');
    assert.equal(setup.modeEvents.at(-1).metadata.forced, false);
});

test('display height bounds validate and persist atomically for each device', () => {
    const storage = createStorage({ 'switchStudio.radarViewMode': '3d' });
    const setup = loadController({ storage, activeDevice: 'device-a' });
    const api = setup.controller;
    const keyA = 'switchStudio.radarDisplayHeight:zigbee2mqtt%2Foffice%20switch';
    const keyB = 'switchStudio.radarDisplayHeight:zigbee2mqtt%2Fbedroom%20switch';

    assert.deepEqual(plain(api.normalizeDisplayHeightBounds(420, -180)), { zMin: -180, zMax: 420 });
    assert.deepEqual(plain(api.normalizeDisplayHeightBounds('-100', '-80')), { zMin: -100, zMax: -80 });
    [
        [null, 100],
        [-100, undefined],
        ['', 100],
        ['   ', 100],
        ['not-a-number', 100],
        [-100, Infinity],
        [-100, -100],
        [-100, -81],
        [-601, 100],
        [-100, 601],
    ].forEach(([zMin, zMax]) => {
        assert.equal(api.normalizeDisplayHeightBounds(zMin, zMax), null);
    });

    assert.deepEqual(plain(api.loadDisplayHeightBounds('zigbee2mqtt/office switch')), { zMin: -600, zMax: 600 });
    assert.deepEqual(
        plain(api.saveDisplayHeightBounds('zigbee2mqtt/office switch', 420, -180)),
        { zMin: -180, zMax: 420 },
    );
    assert.equal(storage.value(keyA), '{"zMin":-180,"zMax":420}');
    assert.deepEqual(
        plain(api.saveDisplayHeightBounds('zigbee2mqtt/bedroom switch', -360, 140)),
        { zMin: -360, zMax: 140 },
    );
    assert.equal(storage.value(keyB), '{"zMin":-360,"zMax":140}');

    assert.deepEqual(plain(api.loadDisplayHeightBounds('zigbee2mqtt/office switch')), { zMin: -180, zMax: 420 });
    assert.deepEqual(plain(api.loadDisplayHeightBounds('zigbee2mqtt/bedroom switch')), { zMin: -360, zMax: 140 });
    assert.deepEqual(plain(api.loadDisplayHeightBounds('zigbee2mqtt/office switch')), { zMin: -180, zMax: 420 });
    assert.equal(api.saveDisplayHeightBounds('', -100, 100), null, 'unselected state must not create a shared height preference');

    const priorA = storage.value(keyA);
    assert.equal(api.saveDisplayHeightBounds('zigbee2mqtt/office switch', '', 100), null);
    assert.equal(api.saveDisplayHeightBounds('zigbee2mqtt/office switch', 0, 10), null);
    assert.equal(storage.value(keyA), priorA, 'invalid saves must retain the complete prior pair');

    storage.setItem(keyA, '{"zMin":-120}');
    assert.deepEqual(
        plain(api.loadDisplayHeightBounds('zigbee2mqtt/office switch')),
        { zMin: -600, zMax: 600 },
        'a partial pair must fall back atomically',
    );
    storage.setItem(keyA, '{broken json');
    assert.deepEqual(plain(api.loadDisplayHeightBounds('zigbee2mqtt/office switch')), { zMin: -600, zMax: 600 });
    storage.setItem(keyA, '{"zMin":-601,"zMax":200}');
    assert.deepEqual(plain(api.loadDisplayHeightBounds('zigbee2mqtt/office switch')), { zMin: -600, zMax: 600 });

    assert.equal(setup.controller.getMode(), '3d');
    assert.equal(storage.value('switchStudio.radarViewMode'), '3d', 'height persistence must not overwrite the global view mode');
    const reloaded = loadController({ storage, activeDevice: 'zigbee2mqtt/bedroom switch' });
    assert.equal(reloaded.controller.getMode(), '3d');
    assert.deepEqual(
        plain(reloaded.controller.loadDisplayHeightBounds('zigbee2mqtt/bedroom switch')),
        { zMin: -360, zMax: 140 },
    );
});

test('bulk display height persistence normalizes reversed bounds, dedupes topics, and does not become a future-device default', () => {
    const offlineKey = 'switchStudio.radarDisplayHeight:zigbee2mqtt%2Foffline%20switch';
    const storage = createStorage({
        'switchStudio.radarViewMode': '3d',
        [offlineKey]: '{"zMin":-90,"zMax":210}',
    });
    const setup = loadController({ storage, activeDevice: 'zigbee2mqtt/office switch' });
    const api = setup.controller;
    const officeKey = 'switchStudio.radarDisplayHeight:zigbee2mqtt%2Foffice%20switch';
    const bedroomKey = 'switchStudio.radarDisplayHeight:zigbee2mqtt%2Fbedroom%20switch';
    const writesBefore = storage.writes.length;

    const result = api.saveDisplayHeightBoundsForDevices([
        ' zigbee2mqtt/office switch ',
        'zigbee2mqtt/bedroom switch',
        'zigbee2mqtt/office switch',
        '',
        null,
    ], 420, -180);

    assert.deepEqual(plain(result), {
        bounds: { zMin: -180, zMax: 420 },
        deviceKeys: ['zigbee2mqtt/office switch', 'zigbee2mqtt/bedroom switch'],
        failedDeviceKeys: [],
    });
    assert.deepEqual(storage.writes.slice(writesBefore), [
        { key: officeKey, value: '{"zMin":-180,"zMax":420}' },
        { key: bedroomKey, value: '{"zMin":-180,"zMax":420}' },
    ]);
    assert.equal(storage.value(officeKey), '{"zMin":-180,"zMax":420}');
    assert.equal(storage.value(bedroomKey), '{"zMin":-180,"zMax":420}');
    assert.equal(storage.value(offlineKey), '{"zMin":-90,"zMax":210}', 'topics outside the supplied inventory snapshot stay untouched');

    const writesAfterValidSave = storage.writes.length;
    assert.equal(api.saveDisplayHeightBoundsForDevices(['zigbee2mqtt/office switch'], 0, 10), null);
    assert.equal(api.saveDisplayHeightBoundsForDevices(['', null], -180, 420), null);
    assert.equal(storage.writes.length, writesAfterValidSave, 'invalid bounds or an empty topic set must not partially write');
    assert.equal(storage.value(officeKey), '{"zMin":-180,"zMax":420}');

    assert.deepEqual(
        plain(api.loadDisplayHeightBounds('zigbee2mqtt/future switch')),
        { zMin: -600, zMax: 600 },
        'a switch discovered after the one-shot bulk action keeps the normal per-device fallback',
    );
    assert.equal(storage.value('switchStudio.radarDisplayHeight:'), undefined, 'bulk persistence must not create a shared default key');
    assert.equal(storage.value('switchStudio.radarViewMode'), '3d', 'bulk height persistence must not disturb the global view mode');
    assert.equal(setup.controller.getMode(), '3d');
});

test('bulk display height persistence reports partial and total local-storage failures without counting rejected topics', () => {
    const topics = [
        'zigbee2mqtt/office switch',
        'zigbee2mqtt/bedroom switch',
        'zigbee2mqtt/den switch',
    ];
    const keys = topics.map((topic) => `switchStudio.radarDisplayHeight:${encodeURIComponent(topic)}`);
    const partialStorage = createStorage(
        { 'switchStudio.radarViewMode': '2d' },
        { failSet: (key) => key === keys[1] },
    );
    const partialSetup = loadController({ storage: partialStorage });

    const partialResult = partialSetup.controller.saveDisplayHeightBoundsForDevices(topics, -240, 360);
    assert.deepEqual(plain(partialResult), {
        bounds: { zMin: -240, zMax: 360 },
        deviceKeys: [topics[0], topics[2]],
        failedDeviceKeys: [topics[1]],
    });
    assert.equal(partialStorage.value(keys[0]), '{"zMin":-240,"zMax":360}');
    assert.equal(partialStorage.value(keys[1]), undefined);
    assert.equal(partialStorage.value(keys[2]), '{"zMin":-240,"zMax":360}');
    assert.deepEqual(partialStorage.writes.map((write) => write.key), keys, 'every deduped topic should receive one write attempt');
    assert.equal(partialStorage.value('switchStudio.radarViewMode'), '2d');

    const allFailedStorage = createStorage(
        { 'switchStudio.radarViewMode': '3d' },
        { failSet: (key) => key.startsWith('switchStudio.radarDisplayHeight:') },
    );
    const allFailedSetup = loadController({ storage: allFailedStorage });
    const allFailedResult = allFailedSetup.controller.saveDisplayHeightBoundsForDevices(topics.slice(0, 2), -240, 360);
    assert.deepEqual(plain(allFailedResult), {
        bounds: { zMin: -240, zMax: 360 },
        deviceKeys: [],
        failedDeviceKeys: topics.slice(0, 2),
    });
    assert.equal(allFailedStorage.value(keys[0]), undefined);
    assert.equal(allFailedStorage.value(keys[1]), undefined);
    assert.equal(allFailedStorage.value('switchStudio.radarViewMode'), '3d');
    assert.equal(allFailedSetup.controller.getMode(), '3d');
});

test('display-only height changes stay dormant in native 2D while rebuilding full-height FOV geometry', () => {
    const storage = createStorage({ 'switchStudio.radarViewMode': '2d' });
    const initial = scene({
        bounds: { xMin: -500, xMax: 500, yMin: 0, yMax: 600, zMin: -600, zMax: 600 },
    });
    const setup = loadController({ storage, sceneModel: initial, activeDevice: 'device-a' });
    const plotCount = setup.plotly.calls.filter((call) => call.kind === 'newPlot').length;

    setup.controller.setSceneModel(scene({
        bounds: { xMin: -500, xMax: 500, yMin: 0, yMax: 600, zMin: -180, zMax: 420 },
    }));

    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(storage.value('switchStudio.radarViewMode'), '2d');
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'newPlot').length, plotCount);
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.hidden, true);
    assert.equal(setup.zonesApi.calls.fov.at(-1).zMin, -180);
    assert.equal(setup.zonesApi.calls.fov.at(-1).zMax, 420);
});

test('zone cuboids expand render bounds, FOV, and deterministic floor coverage without rewriting authored data', () => {
    const deviceKey = 'zigbee2mqtt/office switch';
    const displayStorageKey = `switchStudio.radarDisplayHeight:${encodeURIComponent(deviceKey)}`;
    const storage = createStorage({
        'switchStudio.radarViewMode': '3d',
        [displayStorageKey]: '{"zMin":-120,"zMax":160}',
    });
    const displayBounds = {
        xMin: -300,
        xMax: 300,
        yMin: 0,
        yMax: 600,
        zMin: -120,
        zMax: 160,
    };
    const zones = {
        global: null,
        mmwave_detection_areas: {
            area1: {
                area_id: 'area1',
                x_min: -720,
                x_max: -640,
                y_min: 20,
                y_max: 700,
                z_min: -540,
                z_max: -300,
            },
        },
        mmwave_stay_areas: {
            area1: {
                area_id: 'area1',
                x_min: 120,
                x_max: 680,
                y_min: -90,
                y_max: 500,
                z_min: 100,
                z_max: 570,
            },
        },
        mmwave_interference_areas: [{
            area_id: 'area1',
            x_min: -100,
            x_max: 100,
            y_min: 50,
            y_max: 200,
            z_min: -40,
            z_max: 80,
        }],
    };
    const setup = loadController({
        storage,
        sceneModel: scene({
            zones,
            bounds: displayBounds,
        }),
        initialMode: '3d',
        activeDevice: deviceKey,
    });
    const initialPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');

    assert.deepEqual(
        Array.from(initialPlot.layout.scene.xaxis.range),
        [-762, 722],
        'the 1,400 cm zone union receives a 42 cm fit margin on both overflowing sides',
    );
    assert.deepEqual(
        Array.from(initialPlot.layout.scene.yaxis.range),
        [-114, 724],
        'the 790 cm zone union receives a 24 cm fit margin on both overflowing sides',
    );
    assert.deepEqual(
        Array.from(initialPlot.layout.scene.zaxis.range),
        [-574, 604],
        'the 1,110 cm zone union receives a 34 cm fit margin on both overflowing sides',
    );
    assert.equal(initialPlot.layout.scene.aspectmode, 'manual');
    assertVectorClose(
        initialPlot.layout.scene.aspectratio,
        { x: 1, y: 838 / 1484, z: 1 },
        1e-12,
    );
    const floorGrid = initialPlot.traces.find((trace) => trace.name === 'Floor grid');
    const finiteFloorX = Array.from(floorGrid.x).filter(Number.isFinite);
    const finiteFloorY = Array.from(floorGrid.y).filter(Number.isFinite);
    const finiteFloorZ = Array.from(floorGrid.z).filter(Number.isFinite);
    assert.deepEqual([Math.min(...finiteFloorX), Math.max(...finiteFloorX)], [-762, 722]);
    assert.deepEqual([Math.min(...finiteFloorY), Math.max(...finiteFloorY)], [-114, 724]);
    const expandedFloorZ = -120 + ((604 - (-574)) * 0.0005);
    assert.equal(
        finiteFloorZ.every((value) => Math.abs(value - expandedFloorZ) < 1e-12),
        true,
        'the complete render-bound lattice stays just above the configured floor',
    );
    const expandedSegments = traceLineSegments(floorGrid);
    const verticalSegments = expandedSegments.filter((segment) => segment.x1 === segment.x2);
    const horizontalSegments = expandedSegments.filter((segment) => segment.y1 === segment.y2);
    assert.deepEqual(
        verticalSegments.map((segment) => segment.x1),
        [-762, -600, -400, -200, 0, 200, 400, 600, 722],
        'X grid lines should use stable nice-number ticks plus both render boundaries',
    );
    assert.equal(
        verticalSegments.every((segment) => segment.y1 === -114 && segment.y2 === 724),
        true,
    );
    assert.deepEqual(
        horizontalSegments.map((segment) => segment.y1),
        [-114, -100, 0, 100, 200, 300, 400, 500, 600, 700, 724],
        'Y grid lines should use stable nice-number ticks plus both render boundaries',
    );
    assert.equal(
        horizontalSegments.every((segment) => segment.x1 === -762 && segment.x2 === 722),
        true,
    );
    assert.equal(setup.zonesApi.calls.fov.at(-1).zMin, -574);
    assert.equal(setup.zonesApi.calls.fov.at(-1).zMax, 604);
    const authoredZoneBounds = setup.zonesApi.calls.zones.map((call) => ({
        name: call.options.name,
        zMin: call.zone.z_min,
        zMax: call.zone.z_max,
    }));
    assert.deepEqual(plain(authoredZoneBounds), [
        { name: 'Primary detection area', zMin: -540, zMax: -300 },
        { name: 'Stay area 1', zMin: 100, zMax: 570 },
        { name: 'Interference area 1', zMin: -40, zMax: 80 },
    ], 'semantic cuboids must retain exact device-authored heights while the FOV fills the scene');
    assert.deepEqual(plain(setup.controller.loadDisplayHeightBounds(deviceKey)), { zMin: -120, zMax: 160 });
    assert.equal(storage.value(displayStorageKey), '{"zMin":-120,"zMax":160}');
    assert.equal(storage.writes.length, 0, 'expanding render axes must not rewrite the saved per-device display range');

    setup.controller.setSceneModel(scene({
        zones: {
            global: null,
            mmwave_detection_areas: {},
            mmwave_stay_areas: {},
            mmwave_interference_areas: [],
        },
        bounds: displayBounds,
    }));
    const withoutOutliers = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.deepEqual(Array.from(withoutOutliers.layout.scene.xaxis.range), [-300, 300]);
    assert.deepEqual(Array.from(withoutOutliers.layout.scene.yaxis.range), [0, 600]);
    assert.deepEqual(Array.from(withoutOutliers.layout.scene.zaxis.range), [-120, 160]);
    assert.equal(withoutOutliers.layout.scene.aspectmode, 'manual');
    assertVectorClose(withoutOutliers.layout.scene.aspectratio, { x: 1, y: 1, z: 1 });
    const restoredFloorGrid = withoutOutliers.traces.find((trace) => trace.name === 'Floor grid');
    assert.equal(
        Array.from(restoredFloorGrid.z).filter(Number.isFinite).every((value) => value === -119.75),
        true,
    );
    const restoredFloorX = Array.from(restoredFloorGrid.x).filter(Number.isFinite);
    const restoredFloorY = Array.from(restoredFloorGrid.y).filter(Number.isFinite);
    assert.deepEqual([Math.min(...restoredFloorX), Math.max(...restoredFloorX)], [-300, 300]);
    assert.deepEqual([Math.min(...restoredFloorY), Math.max(...restoredFloorY)], [0, 600]);
    assert.equal(setup.zonesApi.calls.fov.at(-1).zMin, -120);
    assert.equal(setup.zonesApi.calls.fov.at(-1).zMax, 160);
    assert.deepEqual(plain(setup.controller.loadDisplayHeightBounds(deviceKey)), { zMin: -120, zMax: 160 });
    assert.equal(storage.value(displayStorageKey), '{"zMin":-120,"zMax":160}');
    assert.equal(storage.writes.length, 0);
});

test('a sensor origin outside the display envelope expands render axes to zero without zone padding', () => {
    const displayBounds = {
        xMin: 50,
        xMax: 300,
        yMin: 100,
        yMax: 600,
        zMin: 20,
        zMax: 160,
    };
    const setup = loadController({
        sceneModel: scene({
            zones: {
                global: null,
                mmwave_detection_areas: {},
                mmwave_stay_areas: {},
                mmwave_interference_areas: [],
            },
            bounds: displayBounds,
        }),
        initialMode: '3d',
    });
    const newPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');

    assert.deepEqual(Array.from(newPlot.layout.scene.xaxis.range), [0, 300]);
    assert.deepEqual(Array.from(newPlot.layout.scene.yaxis.range), [0, 600]);
    assert.deepEqual(Array.from(newPlot.layout.scene.zaxis.range), [0, 160]);
    const floorGrid = newPlot.traces.find((trace) => trace.name === 'Floor grid');
    const finiteFloorX = Array.from(floorGrid.x).filter(Number.isFinite);
    const finiteFloorY = Array.from(floorGrid.y).filter(Number.isFinite);
    const finiteFloorZ = Array.from(floorGrid.z).filter(Number.isFinite);
    assert.deepEqual([Math.min(...finiteFloorX), Math.max(...finiteFloorX)], [0, 300]);
    assert.deepEqual([Math.min(...finiteFloorY), Math.max(...finiteFloorY)], [0, 600]);
    assert.equal(finiteFloorZ.every((value) => value === 20.25), true);
});

test('scene assembly uses exact XYZ bounds, one primary cuboid, slot visibility, and separate zone colors', () => {
    const setup = loadController({ sceneModel: scene(), initialMode: '3d' });
    const newPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');
    assert.ok(newPlot);
    assert.deepEqual(Array.from(newPlot.layout.scene.xaxis.range), [-500, 500]);
    assert.deepEqual(Array.from(newPlot.layout.scene.yaxis.range), [0, 600]);
    assert.deepEqual(Array.from(newPlot.layout.scene.zaxis.range), [-250, 250]);
    assert.equal(newPlot.layout.scene.aspectmode, 'manual');
    assertVectorClose(newPlot.layout.scene.aspectratio, { x: 1, y: 0.6, z: 1 });
    assert.equal(newPlot.layout.scene.dragmode, 'turntable');
    assert.equal(newPlot.config.scrollZoom, false);
    assertCameraClose(plain(newPlot.layout.scene.camera), DEFAULT_PERSPECTIVE_CAMERA);

    ['xaxis', 'yaxis', 'zaxis'].forEach((axisName) => {
        const axis = newPlot.layout.scene[axisName];
        assert.equal(axis.showgrid, false, 'native camera-dependent grid planes must stay disabled');
        assert.equal(axis.zeroline, false);
        assert.equal(axis.showbackground, false, 'native wall and ceiling backgrounds must stay disabled');
        assert.equal(axis.showspikes, false);
        assert.equal(axis.spikesides, false);
        assert.equal(axis.gridcolor, 'rgb(45, 64, 76)');
        assert.equal(axis.zerolinecolor, 'rgb(61, 82, 94)');
        assert.equal(axis.linecolor, 'rgb(52, 72, 84)');
        assert.equal(axis.backgroundcolor, 'rgb(12, 20, 28)');
    });
    const floorGrids = newPlot.traces.filter((trace) => trace.name === 'Floor grid');
    assert.equal(floorGrids.length, 1, 'grid visibility should add one explicit floor-only trace');
    const floorGrid = floorGrids[0];
    assert.equal(floorGrid.type, 'scatter3d');
    assert.equal(floorGrid.mode, 'lines');
    assert.equal(floorGrid.line.color, 'rgb(42, 61, 72)');
    assert.equal(floorGrid.line.width, 1);
    assert.equal(floorGrid.opacity, 0.72);
    assert.equal(floorGrid.hoverinfo, 'skip');
    assert.equal(floorGrid.showlegend, false);
    assert.equal(floorGrid.connectgaps, false);
    assert.ok(Array.from(floorGrid.z).some((value) => value === null), 'floor segments should be null-separated');
    Array.from(floorGrid.z).forEach((value, index) => {
        if (value === null) {
            assert.equal(floorGrid.x[index], null);
            assert.equal(floorGrid.y[index], null);
            return;
        }
        assert.equal(value, -249.75, 'every finite floor-grid point must sit just above bounds.zMin');
        assert.notEqual(value, 250, 'the floor grid must never mirror onto bounds.zMax');
    });
    const floorSegments = traceLineSegments(floorGrid);
    assert.equal(
        floorSegments.every((segment) => segment.z1 === -249.75 && segment.z2 === -249.75),
        true,
    );

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
    assert.equal(
        setup.zonesApi.calls.zones.every((call) => call.options.hoverinfo === 'skip'),
        true,
        'passive zone volumes must not create hover labels over the scene',
    );

    const sensorHeightTraces = newPlot.traces.filter((trace) => trace.name === 'Sensor height reference');
    const sensorOrigins = newPlot.traces.filter((trace) => trace.name === 'Sensor');
    const sensorOrigin = newPlot.traces.find((trace) => trace.name === 'Sensor');
    assert.equal(sensorHeightTraces.length, 0, 'the sensor must not draw a misleading full-height line');
    assert.equal(sensorOrigins.length, 1, 'the switch should have one distinct origin marker');
    assert.ok(sensorOrigin);
    assert.equal(sensorOrigin.mode, 'markers+text');
    assert.deepEqual(Array.from(sensorOrigin.x), [0]);
    assert.deepEqual(Array.from(sensorOrigin.y), [0]);
    assert.deepEqual(Array.from(sensorOrigin.z), [0]);
    assert.equal(sensorOrigin.marker.symbol, 'diamond');
    assert.equal(sensorOrigin.marker.color, '#ff6f7d');
    assert.deepEqual(
        Array.from(newPlot.traces.slice(-2), (trace) => trace.name),
        ['Live targets', 'Target trails'],
        'static sensor traces must not disturb the stable live-target indices',
    );
});

test('turning grid visibility off omits the custom floor trace while native Z planes stay disabled', () => {
    const model = scene();
    model.visibility.grid = false;
    const setup = loadController({ sceneModel: model, initialMode: '3d' });
    const newPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');

    assert.equal(newPlot.traces.some((trace) => trace.name === 'Floor grid'), false);
    assert.equal(newPlot.layout.scene.xaxis.showgrid, false);
    assert.equal(newPlot.layout.scene.yaxis.showgrid, false);
    assert.equal(newPlot.layout.scene.zaxis.showgrid, false);
    assert.equal(newPlot.layout.scene.zaxis.zeroline, false);
    assert.equal(newPlot.layout.scene.zaxis.showbackground, false);
    assert.deepEqual(
        Array.from(newPlot.traces.slice(-2), (trace) => trace.name),
        ['Live targets', 'Target trails'],
        'removing the floor grid must leave live-target traces at the stable final indices',
    );
});

test('FOV remains capped at the supported six metre depth while axes can extend farther', () => {
    const model = scene();
    model.bounds.yMax = 900;
    const setup = loadController({ sceneModel: model, initialMode: '3d' });
    const newPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');

    assert.deepEqual(Array.from(newPlot.layout.scene.yaxis.range), [0, 900]);
    assert.equal(setup.zonesApi.calls.fov[0].yMax, 600);
});

test('FOV spans the complete visible Z axis while the sensor remains only at the origin', () => {
    const model = scene();
    model.bounds.zMin = -420;
    model.bounds.zMax = 510;
    // Legacy physical-height metadata must not create a second, partial Z
    // scale for the informational reference volume.
    model.fovBounds = { zMin: -120, zMax: 180 };
    const setup = loadController({ sceneModel: model, initialMode: '3d' });
    const newPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');

    assert.deepEqual(Array.from(newPlot.layout.scene.zaxis.range), [-420, 510]);
    assert.equal(setup.zonesApi.calls.fov[0].zMin, -420);
    assert.equal(setup.zonesApi.calls.fov[0].zMax, 510);
    const sensorOrigin = newPlot.traces.find((trace) => trace.name === 'Sensor');
    assert.equal(newPlot.traces.some((trace) => trace.name === 'Sensor height reference'), false);
    assert.deepEqual(Array.from(sensorOrigin.z), [0]);
});

test('per-device display height updates the 3D axis and full-height FOV without changing zones, mode, or camera', () => {
    const storage = createStorage({ 'switchStudio.radarViewMode': '3d' });
    const initialModel = scene({
        bounds: { xMin: -500, xMax: 500, yMin: 0, yMax: 600, zMin: -600, zMax: 600 },
    });
    const setup = loadController({
        storage,
        sceneModel: initialModel,
        initialMode: '3d',
        activeDevice: 'device-a',
    });
    const initialPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');
    const userCamera = {
        eye: { x: 1.9, y: -0.75, z: 1.45 },
        center: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 0, z: 1 },
        projection: { type: 'perspective' },
    };
    setup.elements.chart3d._fullLayout = {
        scene: {
            camera: userCamera,
            uirevision: initialPlot.layout.scene.uirevision,
        },
    };
    assert.deepEqual(
        plain(setup.controller.saveDisplayHeightBounds('device-a', -180, 420)),
        { zMin: -180, zMax: 420 },
    );

    setup.controller.setSceneModel(scene({
        bounds: { xMin: -500, xMax: 500, yMin: 0, yMax: 600, zMin: -180, zMax: 420 },
    }));

    const render = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.ok(render);
    assert.equal(setup.controller.getMode(), '3d');
    assert.equal(storage.value('switchStudio.radarViewMode'), '3d');
    assert.deepEqual(Array.from(render.layout.scene.zaxis.range), [-180, 420]);
    assertVectorClose(render.layout.scene.camera.eye, userCamera.eye);
    assert.deepEqual(plain(render.layout.scene.camera.center), { x: 0, y: 0, z: 0 });
    assert.deepEqual(plain(render.layout.scene.camera.up), { x: 0, y: 0, z: 1 });
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart3d.hidden, false);

    const sensorOrigin = render.traces.find((trace) => trace.name === 'Sensor');
    assert.equal(render.traces.some((trace) => trace.name === 'Sensor height reference'), false);
    assert.deepEqual(Array.from(sensorOrigin.z), [0]);
    assert.equal(setup.zonesApi.calls.fov.at(-1).zMin, -180);
    assert.equal(setup.zonesApi.calls.fov.at(-1).zMax, 420);
    assert.equal(
        setup.zonesApi.calls.zones.every((call) => call.zone.z_min === -40 && call.zone.z_max === 180),
        true,
        'changing the display envelope must not stretch authored semantic zones',
    );
    assert.deepEqual(Array.from(render.traces.slice(-2), (trace) => trace.name), ['Live targets', 'Target trails']);
});

test('a hidden global detection fallback cannot expand area1 bounds but becomes authoritative when area1 is absent', () => {
    const displayBounds = { xMin: -300, xMax: 300, yMin: 0, yMax: 600, zMin: -120, zMax: 160 };
    const hiddenGlobal = {
        area_id: 'area1',
        x_min: -900,
        x_max: -800,
        y_min: -150,
        y_max: 750,
        z_min: -500,
        z_max: 550,
    };
    const visibleArea1 = {
        area_id: 'area1',
        x_min: -100,
        x_max: 100,
        y_min: 20,
        y_max: 200,
        z_min: -40,
        z_max: 80,
    };
    const zones = {
        global: hiddenGlobal,
        mmwave_detection_areas: { area1: visibleArea1 },
        mmwave_stay_areas: {},
        mmwave_interference_areas: [],
    };
    const setup = loadController({
        sceneModel: scene({ zones, bounds: displayBounds }),
        initialMode: '3d',
    });
    const initialPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');

    assert.deepEqual(Array.from(initialPlot.layout.scene.xaxis.range), [-300, 300]);
    assert.deepEqual(Array.from(initialPlot.layout.scene.yaxis.range), [0, 600]);
    assert.deepEqual(Array.from(initialPlot.layout.scene.zaxis.range), [-120, 160]);
    const visiblePrimary = setup.zonesApi.calls.zones
        .filter((call) => call.options.name === 'Primary detection area')
        .at(-1);
    assert.deepEqual(
        plain({
            xMin: visiblePrimary.zone.x_min,
            xMax: visiblePrimary.zone.x_max,
            yMin: visiblePrimary.zone.y_min,
            yMax: visiblePrimary.zone.y_max,
            zMin: visiblePrimary.zone.z_min,
            zMax: visiblePrimary.zone.z_max,
        }),
        { xMin: -100, xMax: 100, yMin: 20, yMax: 200, zMin: -40, zMax: 80 },
        'the semantic primary cuboid must keep area1\'s authored XYZ limits',
    );
    assert.deepEqual(
        plain({ zMin: setup.zonesApi.calls.fov.at(-1).zMin, zMax: setup.zonesApi.calls.fov.at(-1).zMax }),
        { zMin: -120, zMax: 160 },
        'only the informational FOV should span the final render height',
    );

    setup.controller.setSceneModel(scene({
        zones: {
            ...zones,
            mmwave_detection_areas: {},
        },
        bounds: displayBounds,
    }));
    const fallbackRender = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.deepEqual(Array.from(fallbackRender.layout.scene.xaxis.range), [-936, 300]);
    assert.deepEqual(Array.from(fallbackRender.layout.scene.yaxis.range), [-177, 777]);
    assert.deepEqual(Array.from(fallbackRender.layout.scene.zaxis.range), [-532, 582]);
    const fallbackPrimary = setup.zonesApi.calls.zones
        .filter((call) => call.options.name === 'Primary detection area')
        .at(-1);
    assert.deepEqual(
        plain({
            xMin: fallbackPrimary.zone.x_min,
            xMax: fallbackPrimary.zone.x_max,
            yMin: fallbackPrimary.zone.y_min,
            yMax: fallbackPrimary.zone.y_max,
            zMin: fallbackPrimary.zone.z_min,
            zMax: fallbackPrimary.zone.z_max,
        }),
        { xMin: -900, xMax: -800, yMin: -150, yMax: 750, zMin: -500, zMax: 550 },
        'global should retain its authored cuboid only when it is the rendered fallback',
    );
    assert.deepEqual(
        plain({ zMin: setup.zonesApi.calls.fov.at(-1).zMin, zMax: setup.zonesApi.calls.fov.at(-1).zMax }),
        { zMin: -532, zMax: 582 },
    );
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
    const initialTraceCount = setup.plotly.calls.find((call) => call.kind === 'newPlot').traces.length;
    assert.deepEqual(Array.from(restyles.at(-1).indices), [initialTraceCount - 2, initialTraceCount - 1]);
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

test('an unresolved initial 3D creation cannot reveal WebGL after the user returns to 2D', async () => {
    const plotly = createPlotly();
    const creation = createDeferred();
    plotly.newPlot = (element, traces, layout, config) => {
        plotly.calls.push({ kind: 'newPlot', element, traces, layout, config });
        return creation.promise;
    };
    const setup = loadController({ plotly });

    setup.elements.mode3d.click();
    assert.equal(setup.controller.getMode(), '3d');
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'outgoing');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'incoming');

    setup.elements.mode2d.click();
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart2d.getAttribute('aria-hidden'), 'false');
    assert.equal(setup.elements.chart3d.hidden, true);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(cameraRelayouts(setup).length, 0);
    creation.resolve(setup.elements.chart3d);
    await flushPromises();

    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart2d.getAttribute('aria-hidden'), 'false');
    assert.equal(setup.elements.chart3d.hidden, true);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(cameraRelayouts(setup).length, 0);
    assert.equal(plotly.calls.filter((call) => call.kind === 'react').length, 0);
});

test('pending creation and preflight renders reconcile the latest generation before orbiting', async () => {
    const plotly = createPlotly();
    const creation = createDeferred();
    const sceneRenders = [];
    plotly.newPlot = (element, traces, layout, config) => {
        plotly.calls.push({ kind: 'newPlot', element, traces, layout, config });
        return creation.promise;
    };
    plotly.react = (element, traces, layout, config) => {
        const deferred = createDeferred();
        const call = { kind: 'react', element, traces, layout, config, deferred };
        plotly.calls.push(call);
        sceneRenders.push(call);
        return deferred.promise;
    };
    const setup = loadController({ plotly, sceneModel: scene() });

    setup.elements.mode3d.click();
    const updatedScene = scene();
    updatedScene.bounds.zMax = 480;
    setup.controller.setSceneModel(updatedScene);
    setup.zonesApi.emitSnapshot({
        reason: 'live',
        targets: [{ id: 1, x: 22, y: 80, z: 16 }],
        history: {},
    });
    creation.resolve(setup.elements.chart3d);
    await flushPromises();

    assert.equal(sceneRenders.length, 1);
    assert.deepEqual(Array.from(sceneRenders[0].layout.scene.zaxis.range), [-250, 480]);
    assert.deepEqual(Array.from(sceneRenders[0].traces.at(-2).x), [22]);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'outgoing');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'incoming');
    assert.equal(cameraRelayouts(setup).length, 0);

    setup.zonesApi.emitSnapshot({
        reason: 'live',
        targets: [{ id: 1, x: 44, y: 96, z: 20 }],
        history: {},
    });
    sceneRenders[0].deferred.resolve(setup.elements.chart3d);
    await flushPromises();

    assert.equal(sceneRenders.length, 2, 'a newer generation should receive a second preparation render');
    assert.deepEqual(Array.from(sceneRenders[1].traces.at(-2).x), [44]);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'outgoing');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'incoming');
    assert.equal(cameraRelayouts(setup).length, 0);

    sceneRenders[1].deferred.resolve(setup.elements.chart3d);
    await flushPromises();
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'outgoing');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'incoming');
    setup.clock.advance(47);
    assert.equal(cameraRelayouts(setup).length, 0, 'preparation must not start the orbit before the surface fade');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'incoming');
    setup.clock.advance(1);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'retiring');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(cameraRelayouts(setup).length, 0);
    setup.clock.advance(170);
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(cameraRelayouts(setup).length, 0);
    setup.clock.advance(23);
    assert.equal(cameraRelayouts(setup).length, 0);
    setup.clock.advance(1);
    assert.ok(cameraRelayouts(setup).length > 0, 'the orbit should begin only after the current preparation and crossfade resolve');
});

test('a hidden 2D breakpoint change is reconciled before the next 3D reveal', async () => {
    let mobile = false;
    const plotly = createPlotly();
    const setup = loadController({ plotly, initialMode: '3d', isMobile: () => mobile });
    setup.elements.mode2d.click();
    finishCameraTransition(setup, '2d');
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart3d.hidden, true);

    const rendersBeforeBreakpoint = plotly.calls.filter((call) => call.kind === 'react').length;
    mobile = true;
    setup.resizeObservers[0].callback();
    assert.equal(
        plotly.calls.filter((call) => call.kind === 'react').length,
        rendersBeforeBreakpoint,
        'stable native 2D should defer the hidden WebGL layout rebuild',
    );

    const preparation = createDeferred();
    plotly.react = (element, traces, layout, config) => {
        plotly.calls.push({ kind: 'react', element, traces, layout, config });
        return preparation.promise;
    };
    const camerasBeforeReveal = cameraRelayouts(setup).length;
    setup.elements.mode3d.click();

    const prepared = plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.ok(prepared);
    assert.deepEqual({ ...prepared.layout.margin }, { l: 30, r: 24, t: 10, b: 32 });
    assert.equal(prepared.layout.scene.xaxis.nticks, 5);
    assert.equal(prepared.config.scrollZoom, false);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'outgoing');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'incoming');
    assert.equal(cameraRelayouts(setup).length, camerasBeforeReveal);
    assert.equal(setup.elements.reset.hidden, true);
    assert.equal(setup.controller.resetView(), false);

    preparation.resolve(setup.elements.chart3d);
    await flushPromises();
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');
    assert.equal(setup.elements.chart3d.dataset.interactionLocked, 'true');
    assert.equal(setup.controller.resetView(), false);
});

test('showing a dirty active 3D view waits for preparation before fading WebGL back in', async () => {
    const plotly = createPlotly();
    const setup = loadController({ plotly, initialMode: '3d', sceneModel: scene() });
    const preparation = createDeferred();
    plotly.react = (element, traces, layout, config) => {
        plotly.calls.push({ kind: 'react', element, traces, layout, config });
        return preparation.promise;
    };
    const rendersBeforeHide = plotly.calls.filter((call) => call.kind === 'react').length;

    setup.controller.setVisible(false);
    const updatedScene = scene();
    updatedScene.bounds.zMin = -410;
    updatedScene.bounds.zMax = 470;
    setup.controller.setSceneModel(updatedScene);
    setup.zonesApi.emitSnapshot({
        reason: 'live',
        targets: [{ id: 1, x: 77, y: 122, z: 18 }],
        history: {},
    });
    assert.equal(plotly.calls.filter((call) => call.kind === 'react').length, rendersBeforeHide);

    setup.controller.setVisible(true);
    const prepared = plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.ok(prepared);
    assert.equal(plotly.calls.filter((call) => call.kind === 'react').length, rendersBeforeHide + 1);
    assert.deepEqual(Array.from(prepared.layout.scene.zaxis.range), [-410, 470]);
    assert.deepEqual(Array.from(prepared.traces.at(-2).x), [77]);
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'outgoing');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'incoming');
    assert.equal(cameraRelayouts(setup).length, 0);

    preparation.resolve(setup.elements.chart3d);
    await flushPromises();
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'retiring');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    setup.clock.advance(169);
    assert.equal(setup.elements.chart2d.hidden, false);
    setup.clock.advance(1);
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
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

    const lockedWheel = createGestureEvent({ deltaX: 0, deltaY: 100 });
    setup.elements.chart3d.dispatch('wheel', lockedWheel);
    assert.equal(lockedWheel.state.defaultPrevented, false);
    assert.equal(cameraRelayouts(setup).length, 0);

    setup.elements.interaction.click();
    assert.equal(setup.elements.chart3d.dataset.interactionLocked, 'false');
    assert.equal(setup.elements.interaction.textContent, 'Done');
    assert.equal(setup.elements.interaction.getAttribute('aria-pressed'), 'true');

    const enabledWheel = createGestureEvent({ deltaX: 0, deltaY: 100 });
    setup.elements.chart3d.dispatch('wheel', enabledWheel);
    assert.equal(enabledWheel.state.defaultPrevented, true);
    assert.equal(cameraRelayouts(setup).length, 1);

    setup.elements.mode2d.click();
    assert.equal(setup.elements.interaction.hidden, true);
    assert.equal(setup.elements.chart3d.dataset.interactionLocked, 'true');
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

    assert.equal(initialPlot.config.scrollZoom, false);
    assert.deepEqual({ ...initialPlot.layout.margin }, { l: 14, r: 18, t: 8, b: 14 });

    mobile = true;
    setup.resizeObservers[0].callback();
    const mobileReact = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.equal(mobileReact.config.scrollZoom, false);
    assert.deepEqual({ ...mobileReact.layout.margin }, { l: 30, r: 24, t: 10, b: 32 });
    assertVectorClose(mobileReact.layout.scene.camera.eye, userCamera.eye);
    assert.deepEqual(plain(mobileReact.layout.scene.camera.center), { x: 0, y: 0, z: 0 });
    assert.deepEqual(plain(mobileReact.layout.scene.camera.up), { x: 0, y: 0, z: 1 });
    assert.equal(mobileReact.layout.scene.camera.projection.type, 'perspective');
    assert.equal(setup.elements.chart3d.dataset.interactionLocked, 'true');
    assert.equal(setup.elements.interaction.hidden, false);

    mobile = false;
    setup.resizeObservers[0].callback();
    const desktopReact = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.equal(desktopReact.config.scrollZoom, false);
    assert.deepEqual({ ...desktopReact.layout.margin }, { l: 14, r: 18, t: 8, b: 14 });
    assertVectorClose(desktopReact.layout.scene.camera.eye, userCamera.eye);
    assert.deepEqual(plain(desktopReact.layout.scene.camera.center), { x: 0, y: 0, z: 0 });
    assert.deepEqual(plain(desktopReact.layout.scene.camera.up), { x: 0, y: 0, z: 1 });
    assert.equal(setup.elements.chart3d.dataset.interactionLocked, 'false');
    assert.equal(setup.elements.interaction.hidden, true);
});

test('perspective gesture guards block pan and roll while vertical wheel zoom keeps a fixed room frame', () => {
    const setup = loadController({ initialMode: '3d' });
    const initialPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');
    setup.elements.chart3d._fullLayout = {
        scene: {
            camera: plain(initialPlot.layout.scene.camera),
            uirevision: initialPlot.layout.uirevision,
        },
    };

    const rightMouse = createGestureEvent({ button: 2 });
    setup.elements.chart3d.dispatch('mousedown', rightMouse);
    assert.equal(rightMouse.state.defaultPrevented, true);
    assert.equal(rightMouse.state.immediatePropagationStopped, true);

    const controlMouse = createGestureEvent({ button: 0, ctrlKey: true });
    setup.elements.chart3d.dispatch('mousedown', controlMouse);
    assert.equal(controlMouse.state.defaultPrevented, true);

    const horizontalWheel = createGestureEvent({ deltaX: 120, deltaY: 10 });
    setup.elements.chart3d.dispatch('wheel', horizontalWheel);
    assert.equal(horizontalWheel.state.defaultPrevented, true);
    assert.equal(cameraRelayouts(setup).length, 0);

    const contextMenu = createGestureEvent();
    setup.elements.chart3d.dispatch('contextmenu', contextMenu);
    assert.equal(contextMenu.state.defaultPrevented, true);

    const verticalWheel = createGestureEvent({ deltaX: 0, deltaY: 100 });
    setup.elements.chart3d.dispatch('wheel', verticalWheel);
    assert.equal(verticalWheel.state.defaultPrevented, true);
    const zoomCamera = cameraFromRelayout(cameraRelayouts(setup).at(-1));
    assert.deepEqual(plain(zoomCamera.center), { x: 0, y: 0, z: 0 });
    assert.deepEqual(plain(zoomCamera.up), { x: 0, y: 0, z: 1 });
    assert.equal(zoomCamera.projection, undefined);
    assert.ok(Math.hypot(zoomCamera.eye.x, zoomCamera.eye.y, zoomCamera.eye.z)
        > Math.hypot(
            initialPlot.layout.scene.camera.eye.x,
            initialPlot.layout.scene.camera.eye.y,
            initialPlot.layout.scene.camera.eye.z,
        ));
});

test('an in-flight full React blocks pointerdown before a later drag reconciles deferred scene work once', async () => {
    const plotly = createPlotly();
    const setup = loadController({
        initialMode: '3d',
        activeDevice: 'device-a',
        sceneModel: scene(),
        plotly,
    });
    const pendingRenders = [];
    plotly.react = (element, traces, layout, config) => {
        const deferred = createDeferred();
        const call = { kind: 'react', element, traces, layout, config, deferred };
        plotly.calls.push(call);
        pendingRenders.push(call);
        return deferred.promise;
    };
    const cameraB = {
        eye: { x: 1.75, y: -1.05, z: 1.15 },
        center: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 0, z: 1 },
        projection: { type: 'perspective' },
    };
    const cameraC = {
        eye: { x: -1.35, y: -1.7, z: 0.9 },
        center: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 0, z: 1 },
        projection: { type: 'perspective' },
    };

    setup.controller.setSceneModel(scene({
        bounds: { xMin: -540, xMax: 620, yMin: -20, yMax: 710, zMin: -300, zMax: 440 },
    }));
    assert.equal(pendingRenders.length, 1);
    const blockedPointerDown = createGestureEvent({ button: 0 });
    setup.elements.chart3d.dispatch('pointerdown', blockedPointerDown);
    assert.equal(blockedPointerDown.state.defaultPrevented, true);
    assert.equal(blockedPointerDown.state.immediatePropagationStopped, true);
    assert.equal(blockedPointerDown.state.propagationStopped, true);
    assert.equal(setup.elements.chart3d.dataset.cameraGesture, 'idle');
    assert.equal(cameraRelayouts(setup).length, 0, 'the pending React must settle before a native orbit can begin');
    const blockedWheel = createGestureEvent({ deltaX: 0, deltaY: 100 });
    setup.elements.chart3d.dispatch('wheel', blockedWheel);
    assert.equal(blockedWheel.state.defaultPrevented, true);
    assert.equal(cameraRelayouts(setup).length, 0, 'wheel relayout must not race the pending React');

    pendingRenders[0].deferred.resolve(setup.elements.chart3d);
    await flushPromises();
    setup.elements.chart3d._fullLayout = {
        scene: {
            camera: plain(pendingRenders[0].layout.scene.camera),
            uirevision: pendingRenders[0].layout.scene.uirevision,
        },
    };
    const restylesBeforeDrag = plotly.calls.filter((call) => call.kind === 'restyle').length;
    const resizesBeforeDrag = plotly.calls.filter((call) => call.kind === 'resize').length;
    const relayoutsBeforeDrag = cameraRelayouts(setup).length;

    setup.elements.chart3d.dispatch('pointerdown', createGestureEvent({ button: 0 }));
    assert.equal(setup.elements.chart3d.dataset.cameraGesture, 'active');
    setup.elements.chart3d.emit('plotly_relayouting', { 'scene.camera': cameraB });
    setup.elements.chart3d.emit('plotly_relayouting', { 'scene.camera': cameraC });
    setup.elements.chart3d.emit('plotly_relayout', { 'scene.camera': cameraC });
    setup.clock.advance(0);
    assert.equal(
        setup.elements.chart3d.dataset.cameraGesture,
        'active',
        'Plotly relayout is camera telemetry, not evidence that the pointer was physically released',
    );
    assert.equal(cameraRelayouts(setup).length, relayoutsBeforeDrag, 'live native orbit events must not fight the drag');

    setup.controller.setSceneModel(scene({
        bounds: { xMin: -600, xMax: 680, yMin: -40, yMax: 760, zMin: -360, zMax: 500 },
    }));
    setup.zonesApi.emitSnapshot({
        reason: 'drag-live',
        targets: [{ id: 1, x: 83, y: 146, z: 27 }],
        history: {},
    });
    setup.clock.advance(125);
    setup.resizeObservers[0].callback();
    assert.equal(pendingRenders.length, 1, 'full scene work should wait instead of starting another React mid-drag');
    assert.equal(plotly.calls.filter((call) => call.kind === 'restyle').length, restylesBeforeDrag);
    assert.equal(plotly.calls.filter((call) => call.kind === 'resize').length, resizesBeforeDrag);

    setup.windowObject.dispatch('pointerup', createGestureEvent());
    assert.equal(setup.elements.chart3d.dataset.cameraGesture, 'active', 'global release settles after Plotly finishes the event turn');
    setup.clock.advance(0);
    assert.equal(setup.elements.chart3d.dataset.cameraGesture, 'idle');
    assert.equal(pendingRenders.length, 2, 'release should reconcile all deferred full-render work exactly once');
    const reconciled = pendingRenders[1];
    assertCameraClose(plain(reconciled.layout.scene.camera), cameraC);
    assert.deepEqual(Array.from(reconciled.layout.scene.zaxis.range), [-360, 500]);
    assert.deepEqual(Array.from(reconciled.traces.at(-2).x), [83]);
    assert.equal(
        plotly.calls.filter((call) => call.kind === 'resize').length,
        resizesBeforeDrag,
        'resize should wait for the reconciled scene promise',
    );
    assert.equal(cameraRelayouts(setup).length, relayoutsBeforeDrag);

    pendingRenders[1].deferred.resolve(setup.elements.chart3d);
    await flushPromises();
    assert.equal(cameraRelayouts(setup).length, relayoutsBeforeDrag);
    assert.equal(plotly.calls.filter((call) => call.kind === 'resize').length, resizesBeforeDrag + 1);

    setup.controller.setSceneModel(scene({
        bounds: { xMin: -640, xMax: 700, yMin: -60, yMax: 800, zMin: -400, zMax: 540 },
    }));
    assert.equal(pendingRenders.length, 3);
    assertCameraClose(plain(pendingRenders[2].layout.scene.camera), cameraC);
    pendingRenders[2].deferred.resolve(setup.elements.chart3d);
    await flushPromises();
    assert.equal(projectionRelayouts(setup).length, 0);
});

test('a global touch cancellation captures the live GL camera, persists it, then reconciles only the latest held target', async () => {
    const plotly = createPlotly();
    const setup = loadController({ initialMode: '3d', sceneModel: scene(), plotly });
    const liveCamera = {
        eye: { x: -1.6, y: -1.25, z: 1.05 },
        center: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 0, z: 1 },
        projection: { type: 'perspective' },
    };
    const initialPlot = plotly.calls.find((call) => call.kind === 'newPlot');
    setup.elements.chart3d._fullLayout = {
        scene: {
            camera: plain(initialPlot.layout.scene.camera),
            uirevision: initialPlot.layout.scene.uirevision,
            _scene: { getCamera: () => liveCamera },
        },
    };
    const persistence = createDeferred();
    plotly.relayout = (element, update) => {
        const call = { kind: 'relayout', element, update, deferred: persistence };
        plotly.calls.push(call);
        return persistence.promise;
    };
    const reactCount = setup.plotly.calls.filter((call) => call.kind === 'react').length;
    const restyleCount = setup.plotly.calls.filter((call) => call.kind === 'restyle').length;
    const relayoutCount = cameraRelayouts(setup).length;

    setup.elements.chart3d.dispatch('touchstart', createGestureEvent());
    assert.equal(setup.elements.chart3d.dataset.cameraGesture, 'active');
    setup.zonesApi.emitSnapshot({
        reason: 'drag-target-only',
        targets: [{ id: 1, x: 31, y: 72, z: 14 }],
        history: {},
    });
    setup.zonesApi.emitSnapshot({
        reason: 'drag-target-latest',
        targets: [{ id: 1, x: 47, y: 91, z: 19 }],
        history: {},
    });
    setup.clock.advance(500);
    assert.equal(setup.elements.chart3d.dataset.cameraGesture, 'active');
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'react').length, reactCount);
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'restyle').length, restyleCount);
    assert.equal(cameraRelayouts(setup).length, relayoutCount);

    setup.windowObject.dispatch('touchcancel', createGestureEvent());
    assert.equal(setup.elements.chart3d.dataset.cameraGesture, 'active');
    setup.clock.advance(0);
    assert.equal(setup.elements.chart3d.dataset.cameraGesture, 'idle');
    assert.equal(setup.plotly.calls.filter((call) => call.kind === 'react').length, reactCount);
    const persistenceCalls = cameraRelayouts(setup).slice(relayoutCount);
    assert.equal(persistenceCalls.length, 1, 'stale layout state must be brought up to the live GL camera once');
    assertCameraClose(plain(cameraFromRelayout(persistenceCalls[0])), liveCamera);
    assert.equal(
        setup.plotly.calls.filter((call) => call.kind === 'restyle').length,
        restyleCount,
        'target reconciliation must await camera persistence',
    );

    persistence.resolve(setup.elements.chart3d);
    await flushPromises();
    const restyles = setup.plotly.calls.filter((call) => call.kind === 'restyle');
    assert.equal(restyles.length, restyleCount + 1, 'release should reconcile target state exactly once');
    assert.deepEqual(plain(restyles.at(-1).update.x[0]), [47], 'only the latest held target snapshot should render');
    assert.ok(
        setup.plotly.calls.indexOf(persistenceCalls[0]) < setup.plotly.calls.indexOf(restyles.at(-1)),
        'camera persistence must complete before the deferred target restyle is issued',
    );
    assert.equal(projectionRelayouts(setup).length, 0);
});

test('an unsafe gesture camera is corrected once, and only after physical release', () => {
    const setup = loadController({ initialMode: '3d', sceneModel: scene() });
    const unsafeCamera = {
        eye: { x: 1.2, y: -1.6, z: -1.1 },
        center: { x: 4, y: -3, z: 2 },
        up: { x: 1, y: 0, z: 0 },
        projection: { type: 'orthographic' },
    };
    const before = cameraRelayouts(setup).length;

    setup.elements.chart3d.dispatch('pointerdown', createGestureEvent({ button: 0 }));
    setup.elements.chart3d.emit('plotly_relayouting', { 'scene.camera': unsafeCamera });
    setup.elements.chart3d.emit('plotly_relayout', { 'scene.camera': unsafeCamera });
    setup.clock.advance(1000);
    assert.equal(setup.elements.chart3d.dataset.cameraGesture, 'active');
    assert.equal(cameraRelayouts(setup).length, before, 'camera telemetry alone must neither finish nor correct an active drag');

    setup.windowObject.dispatch('pointerup', createGestureEvent());
    assert.equal(setup.elements.chart3d.dataset.cameraGesture, 'active');
    setup.clock.advance(0);
    assert.equal(setup.elements.chart3d.dataset.cameraGesture, 'idle');
    const corrections = cameraRelayouts(setup).slice(before);
    assert.equal(corrections.length, 1);
    const correction = corrections[0];
    const corrected = cameraFromRelayout(correction);
    assertVectorClose(corrected.eye, unsafeCamera.eye);
    assert.deepEqual(plain(corrected.center), { x: 0, y: 0, z: 0 });
    assert.deepEqual(plain(corrected.up), { x: 0, y: 0, z: 1 });
    assert.equal(correction.update['scene.camera'], undefined);
    assert.equal(correction.update['scene.camera.projection.type'], undefined);
    assert.equal(projectionRelayouts(setup).length, 0);
});

test('plotly accepts safe negative cameras and clamps near-pole views without an azimuth snap', () => {
    const setup = loadController({ initialMode: '3d' });
    const before = cameraRelayouts(setup).length;
    const safeNegativeEye = { x: 1.2, y: -1.6, z: -1.1 };

    setup.elements.chart3d.emit('plotly_relayout', {
        'scene.camera': {
            eye: safeNegativeEye,
            center: { x: 0, y: 0, z: 0 },
            up: { x: 0, y: 0, z: 1 },
            projection: { type: 'perspective' },
        },
    });
    assert.equal(
        cameraRelayouts(setup).length,
        before,
        'an in-range below-plane view with the fixed room frame should not receive a correction relayout',
    );

    setup.elements.chart3d.emit('plotly_relayout', {
        'scene.camera': {
            eye: safeNegativeEye,
            center: { x: 4, y: -3, z: 2 },
            up: { x: 1, y: 0, z: 0 },
            projection: { type: 'orthographic' },
        },
    });

    assert.equal(cameraRelayouts(setup).length, before + 1);
    const correction = cameraRelayouts(setup).at(-1);
    const corrected = cameraFromRelayout(correction);
    assert.deepEqual(plain(corrected.center), { x: 0, y: 0, z: 0 });
    assert.deepEqual(plain(corrected.up), { x: 0, y: 0, z: 1 });
    assert.equal(corrected.projection, undefined);
    assert.equal(correction.update['scene.camera'], undefined);
    assert.equal(correction.update['scene.camera.projection.type'], undefined);
    assert.equal(projectionRelayouts(setup).length, 0);
    assertVectorClose(corrected.eye, safeNegativeEye, 1e-9);
    assert.ok(corrected.eye.z < 0, 'sanitizing center/up must not snap a safe camera above the floor');

    setup.clock.advance(0);
    setup.elements.chart3d.emit('plotly_relayout', {
        'scene.camera': {
            eye: { x: -1e-8, y: 1e-8, z: -2 },
            center: { x: 0, y: 0, z: 0 },
            up: { x: 0, y: 0, z: 1 },
            projection: { type: 'perspective' },
        },
    });

    assert.equal(cameraRelayouts(setup).length, before + 2);
    const poleCorrection = cameraFromRelayout(cameraRelayouts(setup).at(-1));
    const poleRadius = Math.hypot(poleCorrection.eye.x, poleCorrection.eye.y, poleCorrection.eye.z);
    const poleElevation = Math.asin(poleCorrection.eye.z / poleRadius);
    const safeAzimuth = Math.atan2(safeNegativeEye.y, safeNegativeEye.x);
    const poleAzimuth = Math.atan2(poleCorrection.eye.y, poleCorrection.eye.x);
    const azimuthDelta = Math.abs(Math.atan2(
        Math.sin(poleAzimuth - safeAzimuth),
        Math.cos(poleAzimuth - safeAzimuth),
    ));
    assert.ok(Math.abs(poleElevation - ((-Math.PI / 2) + 0.015)) < 1e-9);
    assert.ok(azimuthDelta < 1e-9, `near-pole correction changed azimuth by ${azimuthDelta}`);
    assert.deepEqual(plain(poleCorrection.center), { x: 0, y: 0, z: 0 });
    assert.deepEqual(plain(poleCorrection.up), { x: 0, y: 0, z: 1 });
    assert.equal(poleCorrection.projection, undefined);
    assert.equal(projectionRelayouts(setup).length, 0);
});

test('back-to-back unsafe Plotly cameras do not drop the latest rendered-state correction in one tick', () => {
    const setup = loadController({ initialMode: '3d' });
    const before = cameraRelayouts(setup).length;
    const unsafeCameras = [
        {
            eye: { x: 1.2, y: -1.6, z: -1.1 },
            center: { x: 4, y: -3, z: 2 },
            up: { x: 1, y: 0, z: 0 },
            projection: { type: 'orthographic' },
        },
        {
            eye: { x: -1.5, y: -0.5, z: 1.3 },
            center: { x: -2, y: 5, z: 1 },
            up: { x: 0, y: 1, z: 0 },
            projection: { type: 'orthographic' },
        },
    ];

    setup.elements.chart3d.emit('plotly_relayout', { 'scene.camera': unsafeCameras[0] });
    assert.equal(cameraRelayouts(setup).length, before + 1, 'the first unsafe camera should be corrected immediately');
    setup.elements.chart3d.emit('plotly_relayout', { 'scene.camera': unsafeCameras[1] });
    setup.clock.advance(0);

    const corrections = cameraRelayouts(setup).slice(before);
    assert.equal(corrections.length, 2, 'the second unsafe rendered camera must not be dropped while the correction guard is active');
    corrections.forEach((call, index) => {
        const corrected = cameraFromRelayout(call);
        const radius = Math.hypot(corrected.eye.x, corrected.eye.y, corrected.eye.z);
        const elevation = Math.asin(corrected.eye.z / radius);
        assertVectorClose(corrected.eye, unsafeCameras[index].eye, 1e-9);
        assert.deepEqual(plain(corrected.center), { x: 0, y: 0, z: 0 });
        assert.deepEqual(plain(corrected.up), { x: 0, y: 0, z: 1 });
        assert.equal(corrected.projection, undefined);
        assert.ok(radius >= 0.82 - 1e-9 && radius <= 4.6 + 1e-9);
        assert.ok(elevation >= ((-Math.PI / 2) + 0.015) - 1e-9);
        assert.ok(elevation <= ((Math.PI / 2) - 0.015) + 1e-9);
    });
    assert.notDeepEqual(
        plain(cameraFromRelayout(corrections[0]).eye),
        plain(cameraFromRelayout(corrections[1]).eye),
        'the queued correction must target the latest observed eye rather than replaying the first one',
    );
    assert.equal(projectionRelayouts(setup).length, 0);
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

test('delayed target and scene reacts preserve the latest user camera indefinitely despite stale Plotly layout state', async () => {
    const plotly = createPlotly();
    const renders = [];
    delete plotly.restyle;
    plotly.react = (element, traces, layout, config) => {
        const deferred = createDeferred();
        const call = { kind: 'react', element, traces, layout, config, deferred };
        plotly.calls.push(call);
        renders.push(call);
        return deferred.promise;
    };
    const setup = loadController({
        initialMode: '3d',
        activeDevice: 'device-a',
        sceneModel: scene(),
        plotly,
    });
    renders.forEach((render) => render.deferred.resolve(setup.elements.chart3d));
    await flushPromises();
    const baselineRenders = renders.length;
    const initialPlot = plotly.calls.find((call) => call.kind === 'newPlot');
    setup.elements.chart3d._fullLayout = {
        scene: {
            camera: plain(initialPlot.layout.scene.camera),
            uirevision: initialPlot.layout.scene.uirevision,
        },
    };
    const userCamera = {
        eye: { x: -1.7, y: -1.1, z: 0.85 },
        center: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 0, z: 1 },
        projection: { type: 'perspective' },
    };
    const relayoutsBeforeUserCamera = cameraRelayouts(setup).length;
    setup.elements.chart3d.emit('plotly_relayout', { 'scene.camera': userCamera });
    assert.equal(cameraRelayouts(setup).length, relayoutsBeforeUserCamera, 'a safe user camera should not be corrected');

    setup.zonesApi.emitSnapshot({
        reason: 'live',
        targets: [{ id: 1, x: 12, y: 34, z: 56 }],
        history: {},
    });
    setup.clock.advance(125);
    assert.equal(renders.length, baselineRenders + 1);
    assertCameraClose(plain(renders.at(-1).layout.scene.camera), userCamera);

    const updatedScene = scene({
        bounds: { xMin: -560, xMax: 640, yMin: -40, yMax: 720, zMin: -320, zMax: 460 },
    });
    setup.controller.setSceneModel(updatedScene);
    assert.equal(renders.length, baselineRenders + 2);
    assertCameraClose(plain(renders.at(-1).layout.scene.camera), userCamera);

    renders.at(-1).deferred.resolve(setup.elements.chart3d);
    await flushPromises();
    renders[baselineRenders].deferred.resolve(setup.elements.chart3d);
    await flushPromises();

    setup.clock.advance(86_400_000);
    setup.zonesApi.emitSnapshot({
        reason: 'live',
        targets: [{ id: 1, x: 98, y: 76, z: 54 }],
        history: {},
    });
    assert.equal(renders.length, baselineRenders + 3, 'a target arriving a day later should still render immediately');
    assertCameraClose(plain(renders.at(-1).layout.scene.camera), userCamera);
    renders.at(-1).deferred.resolve(setup.elements.chart3d);
    await flushPromises();

    setup.controller.setSceneModel(scene({
        bounds: { xMin: -600, xMax: 600, yMin: 0, yMax: 800, zMin: -420, zMax: 520 },
    }));
    assert.equal(renders.length, baselineRenders + 4);
    renders.slice(baselineRenders).forEach((render) => {
        assertCameraClose(plain(render.layout.scene.camera), userCamera);
    });
    renders.at(-1).deferred.resolve(setup.elements.chart3d);
    await flushPromises();

    assert.equal(setup.controller.getMode(), '3d');
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(projectionRelayouts(setup).length, 0);
});

test('a user camera change during a pending steady react is restored after finalize and stays authoritative', async () => {
    const plotly = createPlotly();
    const setup = loadController({
        initialMode: '3d',
        activeDevice: 'device-a',
        sceneModel: scene(),
        plotly,
    });
    const initialPlot = plotly.calls.find((call) => call.kind === 'newPlot');
    const cameraA = {
        eye: { x: 1.9, y: -0.8, z: 1.25 },
        center: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 0, z: 1 },
        projection: { type: 'perspective' },
    };
    const cameraB = {
        eye: { x: -1.4, y: -1.6, z: 0.95 },
        center: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 0, z: 1 },
        projection: { type: 'perspective' },
    };
    setup.elements.chart3d._fullLayout = {
        scene: {
            camera: cameraA,
            uirevision: initialPlot.layout.scene.uirevision,
        },
    };

    const pendingRenders = [];
    plotly.react = (element, traces, layout, config) => {
        const deferred = createDeferred();
        const call = { kind: 'react', element, traces, layout, config, deferred };
        plotly.calls.push(call);
        pendingRenders.push(call);
        return deferred.promise;
    };
    setup.controller.setSceneModel(scene({
        bounds: { xMin: -560, xMax: 640, yMin: -20, yMax: 720, zMin: -320, zMax: 460 },
    }));
    assert.equal(pendingRenders.length, 1);
    assertCameraClose(plain(pendingRenders[0].layout.scene.camera), cameraA);

    const relayoutCountBeforeB = cameraRelayouts(setup).length;
    const projectionCountBeforeB = projectionRelayouts(setup).length;
    setup.elements.chart3d.emit('plotly_relayout', { 'scene.camera': cameraB });
    assert.equal(
        cameraRelayouts(setup).length,
        relayoutCountBeforeB,
        'the safe user camera itself must not need a correction',
    );

    pendingRenders[0].deferred.resolve(setup.elements.chart3d);
    await flushPromises();
    const restoreCalls = cameraRelayouts(setup).slice(relayoutCountBeforeB);
    assert.equal(restoreCalls.length, 1, 'finalizing stale camera A should restore newer camera B exactly once');
    assertCameraClose(plain(cameraFromRelayout(restoreCalls[0])), cameraB);
    assert.equal(restoreCalls[0].update['scene.camera'], undefined, 'camera restoration should use flattened camera vectors');
    assert.equal(restoreCalls[0].update['scene.camera.projection.type'], undefined);
    assert.equal(projectionRelayouts(setup).length, projectionCountBeforeB);

    setup.controller.setSceneModel(scene({
        bounds: { xMin: -600, xMax: 680, yMin: -40, yMax: 760, zMin: -360, zMax: 500 },
    }));
    assert.equal(pendingRenders.length, 2);
    assertCameraClose(
        plain(pendingRenders[1].layout.scene.camera),
        cameraB,
        1e-9,
    );
    pendingRenders[1].deferred.resolve(setup.elements.chart3d);
    await flushPromises();
    assert.equal(
        cameraRelayouts(setup).length,
        relayoutCountBeforeB + 1,
        'later steady renders using camera B must not schedule another restoration',
    );
    assert.equal(projectionRelayouts(setup).length, projectionCountBeforeB);
});

test('uirevision is stable for one device and changes to reset the camera for another', () => {
    const setup = loadController({ sceneModel: scene(), initialMode: '3d', activeDevice: 'device-a' });
    const initialLayout = setup.plotly.calls.find((call) => call.kind === 'newPlot').layout;
    const firstRevision = initialLayout.uirevision;
    const firstSceneRevision = initialLayout.scene.uirevision;
    const userCamera = {
        eye: { x: 1.9, y: -0.6, z: 1.5 },
        center: { x: 0.2, y: 0.1, z: 0 },
        up: { x: 0, y: 0, z: 1 },
    };
    setup.elements.chart3d._fullLayout = {
        scene: { camera: userCamera, uirevision: firstSceneRevision },
    };
    setup.controller.setSceneModel(scene({ bounds: { xMin: -600, xMax: 600, yMin: 0, yMax: 700, zMin: -300, zMax: 300 } }));
    const sameDeviceRender = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    const sameDeviceRevision = sameDeviceRender.layout.uirevision;
    assert.equal(sameDeviceRevision, firstRevision);
    assert.notEqual(sameDeviceRender.layout.scene.uirevision, firstSceneRevision);
    assert.match(sameDeviceRender.layout.scene.uirevision, /:scene:-600,600,0,700,-300,300$/);
    assertVectorClose(sameDeviceRender.layout.scene.camera.eye, userCamera.eye);
    assert.deepEqual(plain(sameDeviceRender.layout.scene.camera.center), { x: 0, y: 0, z: 0 });
    assert.deepEqual(plain(sameDeviceRender.layout.scene.camera.up), { x: 0, y: 0, z: 1 });
    assert.equal(sameDeviceRender.layout.scene.camera.projection.type, 'perspective');

    setup.controller.setActiveDevice('device-b');
    const changedDeviceRender = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    const changedRevision = changedDeviceRender.layout.uirevision;
    assert.notEqual(changedRevision, firstRevision);
    assert.match(changedRevision, /device-b/);
    assertVectorClose(changedDeviceRender.layout.scene.camera.eye, DEFAULT_PERSPECTIVE_CAMERA.eye);

    const newDeviceScene = scene();
    newDeviceScene.bounds.zMax = 420;
    setup.controller.setSceneModel(newDeviceScene);
    const immediateNewDeviceRefresh = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assertVectorClose(immediateNewDeviceRefresh.layout.scene.camera.eye, DEFAULT_PERSPECTIVE_CAMERA.eye);
});

test('reset view transitions to the fixed default camera and device reset clears live targets', () => {
    const setup = loadController({ initialMode: '3d', activeDevice: 'device-a' });
    const initialPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');
    setup.elements.chart3d._fullLayout = {
        scene: {
            camera: {
                eye: { x: -2.1, y: -0.7, z: 1.8 },
                center: { x: 0, y: 0, z: 0 },
                up: { x: 0, y: 0, z: 1 },
                projection: { type: 'perspective' },
            },
            uirevision: initialPlot.layout.uirevision,
        },
    };

    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    setup.elements.reset.click();
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    setup.clock.advance(280);
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    setup.clock.advance(295);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');
    setup.clock.advance(1);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    const relayout = cameraRelayouts(setup).at(-1);
    assertCameraClose(plain(cameraFromRelayout(relayout)), DEFAULT_PERSPECTIVE_CAMERA);
    assert.notEqual(relayout.update.uirevision, initialPlot.layout.uirevision);
    assert.equal(relayout.update['scene.camera'], undefined);
    assert.equal(projectionRelayouts(setup).length, 0);

    setup.zonesApi.emitSnapshot({ reason: 'live', targets: [{ id: 1, x: 44 }], history: {} });
    setup.controller.resetForDeviceChange('device-b');
    const lastReact = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.match(lastReact.layout.uirevision, /device-b/);
    assert.deepEqual(Array.from(lastReact.traces.at(-2).x), []);
});

test('a hidden in-flight Reset resumes to the default camera without exposing native 2D', () => {
    const setup = loadController({ initialMode: '3d', activeDevice: 'device-a' });
    const initialPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');
    const customCamera = {
        eye: { x: -2.1, y: -0.7, z: 1.8 },
        center: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 0, z: 1 },
        projection: { type: 'perspective' },
    };
    setup.elements.chart3d._fullLayout = {
        scene: {
            camera: customCamera,
            uirevision: initialPlot.layout.uirevision,
        },
    };

    setup.elements.reset.click();
    setup.clock.advance(240);
    const relayoutsAtHide = cameraRelayouts(setup).length;
    assert.ok(relayoutsAtHide > 0);
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');

    setup.controller.setVisible(false);
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart3d.hidden, true);
    setup.zonesApi.emitSnapshot({
        reason: 'hidden-reset',
        targets: [{ id: 1, x: 63, y: 140, z: 24 }],
        history: {},
    });
    setup.controller.setVisible(true);

    assert.equal(setup.controller.getMode(), '3d');
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    const preparation = setup.plotly.calls.filter((call) => call.kind === 'react').at(-1);
    assert.deepEqual(Array.from(preparation.traces.at(-2).x), [63]);

    setup.clock.advance(280);
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    setup.clock.advance(1000);

    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.ok(cameraRelayouts(setup).length > relayoutsAtHide);
    assertCameraClose(
        plain(cameraFromRelayout(cameraRelayouts(setup).at(-1))),
        DEFAULT_PERSPECTIVE_CAMERA,
    );
    assert.equal(projectionRelayouts(setup).length, 0);
});

test('an in-flight Reset reverses continuously through 2D and retains its default 3D target', () => {
    const setup = loadController({ initialMode: '3d' });
    const initialPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');
    setup.elements.chart3d._fullLayout = {
        scene: {
            camera: {
                eye: { x: -2.1, y: -0.7, z: 1.8 },
                center: { x: 0, y: 0, z: 0 },
                up: { x: 0, y: 0, z: 1 },
                projection: { type: 'perspective' },
            },
            uirevision: initialPlot.layout.uirevision,
        },
    };

    setup.elements.reset.click();
    setup.clock.advance(280);
    const resetCamera = cameraFromRelayout(cameraRelayouts(setup).at(-1));
    const callsBeforeReverse = cameraRelayouts(setup).length;

    setup.elements.mode2d.click();
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(cameraRelayouts(setup).length, callsBeforeReverse);
    setup.clock.advance(24);
    const reverseCamera = cameraFromRelayout(cameraRelayouts(setup).at(-1));
    const reversalDelta = Math.hypot(
        reverseCamera.eye.x - resetCamera.eye.x,
        reverseCamera.eye.y - resetCamera.eye.y,
        reverseCamera.eye.z - resetCamera.eye.z,
    );
    assert.ok(reversalDelta < 0.25, `Reset-to-2D camera jump was ${reversalDelta}`);
    assert.deepEqual(plain(reverseCamera.center), { x: 0, y: 0, z: 0 });
    assert.deepEqual(plain(reverseCamera.up), { x: 0, y: 0, z: 1 });

    finishCameraTransition(setup, '2d');
    assertCameraClose(
        plain(cameraFromRelayout(cameraRelayouts(setup).at(-1))),
        TOP_DOWN_CAMERA,
    );
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.hidden, true);

    setup.elements.mode3d.click();
    finishCameraTransition(setup, '3d');
    assert.equal(setup.controller.getMode(), '3d');
    assertCameraClose(
        plain(cameraFromRelayout(cameraRelayouts(setup).at(-1))),
        DEFAULT_PERSPECTIVE_CAMERA,
    );
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(projectionRelayouts(setup).length, 0);
});

test('a dirty rapid Reset detour through 2D reconciles before finishing at the default 3D camera', () => {
    const setup = loadController({ initialMode: '3d' });
    const initialPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');
    setup.elements.chart3d._fullLayout = {
        scene: {
            camera: {
                eye: { x: -2.1, y: -0.7, z: 1.8 },
                center: { x: 0, y: 0, z: 0 },
                up: { x: 0, y: 0, z: 1 },
                projection: { type: 'perspective' },
            },
            uirevision: initialPlot.layout.uirevision,
        },
    };

    setup.elements.reset.click();
    setup.clock.advance(240);
    setup.elements.mode2d.click();
    assert.equal(setup.controller.getMode(), '2d');
    setup.zonesApi.emitSnapshot({
        reason: 'rapid-reset-detour',
        targets: [{ id: 1, x: 91, y: 154, z: 28 }],
        history: {},
    });
    setup.clock.advance(96);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');

    const reconciliationsBeforeReturn = setup.plotly.calls.filter((call) => call.kind === 'react').length;
    setup.elements.mode3d.click();
    assert.equal(setup.controller.getMode(), '3d');
    const reconciliations = setup.plotly.calls.filter((call) => call.kind === 'react');
    assert.equal(reconciliations.length, reconciliationsBeforeReturn + 1);
    assert.deepEqual(Array.from(reconciliations.at(-1).traces.at(-2).x), [91]);

    finishCameraTransition(setup, '3d');
    const finalCamera = cameraFromRelayout(cameraRelayouts(setup).at(-1));
    assertCameraClose(plain(finalCamera), DEFAULT_PERSPECTIVE_CAMERA);
    assert.notDeepEqual(plain(finalCamera.eye), TOP_DOWN_CAMERA.eye);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(
        [setup.elements.chart2d, setup.elements.chart3d]
            .filter((element) => element.dataset.radarSurfaceState === 'active').length,
        1,
    );
    assert.equal(projectionRelayouts(setup).length, 0);
});

test('zone editing interrupted during Reset restores the preferred 3D default camera', () => {
    const setup = loadController({ initialMode: '3d' });
    const initialPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');
    setup.elements.chart3d._fullLayout = {
        scene: {
            camera: {
                eye: { x: -2.1, y: -0.7, z: 1.8 },
                center: { x: 0, y: 0, z: 0 },
                up: { x: 0, y: 0, z: 1 },
                projection: { type: 'perspective' },
            },
            uirevision: initialPlot.layout.uirevision,
        },
    };

    setup.elements.reset.click();
    setup.clock.advance(280);
    const interruptedCamera = cameraFromRelayout(cameraRelayouts(setup).at(-1));
    setup.controller.setEditing(true);
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.hidden, true);

    setup.controller.setEditing(false);
    assert.equal(setup.controller.getMode(), '3d');
    finishCameraTransition(setup, '3d');
    const restoredCamera = cameraFromRelayout(cameraRelayouts(setup).at(-1));
    assertCameraClose(plain(restoredCamera), DEFAULT_PERSPECTIVE_CAMERA);
    assert.ok(
        Math.hypot(
            restoredCamera.eye.x - interruptedCamera.eye.x,
            restoredCamera.eye.y - interruptedCamera.eye.y,
            restoredCamera.eye.z - interruptedCamera.eye.z,
        ) > 0.05,
        'editing restore must finish at the Reset target rather than the interrupted eye',
    );
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(projectionRelayouts(setup).length, 0);
});

test('missing Plotly falls back to 2D with a useful error status', () => {
    const setup = loadController({ plotly: null });
    setup.elements.mode3d.click();
    assert.equal(setup.controller.getMode(), '2d');
    assert.equal(setup.elements.chart2d.hidden, false);
    assert.equal(setup.elements.mode3d.disabled, true);
    assert.equal(setup.elements.chart3d.hidden, true);
    assert.equal(setup.elements.legend.hidden, true);
    assert.match(setup.elements.status.textContent, /enhanced radar is unavailable/i);
    assert.match(setup.elements.status.textContent, /Cartesian 2D radar/);
    assert.equal(setup.statusEvents.at(-1).metadata.kind, 'error');
});

test('WebGL loss restores 3D and rebinds camera sanitation after Plotly purges listeners', () => {
    const plotly = createPlotly();
    const createPlot = plotly.newPlot.bind(plotly);
    plotly.newPlot = (element, traces, layout, config) => {
        // Plotly.newPlot purges emitter listeners attached to graphDiv while
        // rebuilding the scene. DOM listeners remain separate in browsers.
        element.listeners.delete('plotly_relayouting');
        element.listeners.delete('plotly_relayout');
        return createPlot(element, traces, layout, config);
    };
    const setup = loadController({ initialMode: '3d', plotly });
    assert.equal(setup.elements.chart3d.listeners.get('plotly_relayouting')?.size, 1);
    assert.equal(setup.elements.chart3d.listeners.get('plotly_relayout')?.size, 1);
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
    assert.equal(setup.elements.chart3d.listeners.get('plotly_relayouting')?.size, 1);
    assert.equal(setup.elements.chart3d.listeners.get('plotly_relayout')?.size, 1);
    setup.clock.advance(2000);
    assert.equal(setup.controller.getMode(), '3d');
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'inactive');
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');

    const cameraUpdatesBefore = cameraRelayouts(setup).length;
    setup.elements.chart3d.emit('plotly_relayout', {
        'scene.camera': {
            eye: { x: 9, y: 0, z: -4 },
            center: { x: 4, y: -3, z: 2 },
            up: { x: 1, y: 0, z: 0 },
            projection: { type: 'orthographic' },
        },
    });
    assert.equal(cameraRelayouts(setup).length, cameraUpdatesBefore + 1);
    const corrected = cameraFromRelayout(cameraRelayouts(setup).at(-1));
    assert.deepEqual(plain(corrected.center), { x: 0, y: 0, z: 0 });
    assert.deepEqual(plain(corrected.up), { x: 0, y: 0, z: 1 });
    assert.equal(corrected.projection, undefined);
    const radius = Math.hypot(corrected.eye.x, corrected.eye.y, corrected.eye.z);
    const elevation = Math.asin(corrected.eye.z / radius);
    assert.ok(radius <= 4.6 + 1e-9);
    assert.ok(radius >= 0.82 - 1e-9);
    assert.ok(elevation >= ((-Math.PI / 2) + 0.015) - 1e-9);
    assert.ok(elevation <= ((Math.PI / 2) - 0.015) + 1e-9);
    assert.ok(elevation < 0, 'restored sanitation should preserve a safe below-plane camera');
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
    assert.equal(setup.elements.chart3d.listeners.get('plotly_relayouting')?.size, 1);
    assert.equal(setup.elements.chart3d.listeners.get('plotly_relayout')?.size, 1);
    assert.equal(setup.elements.chart3d.listeners.get('pointerdown')?.size, 1);
    assert.equal(setup.windowObject.listeners.get('pointerup')?.size, 1);
    assert.equal(setup.windowObject.listeners.get('pointercancel')?.size, 1);
    assert.equal(setup.windowObject.listeners.get('mouseup')?.size, 1);
    assert.equal(setup.windowObject.listeners.get('touchend')?.size, 1);
    assert.equal(setup.windowObject.listeners.get('touchcancel')?.size, 1);
    setup.resizeObservers[0].callback();
    assert.ok(setup.plotly.calls.some((call) => call.kind === 'resize'));
    assert.equal(setup.zonesApi.hasSnapshotListener(), true);

    setup.controller.destroy();
    assert.equal(setup.resizeObservers[0].disconnected, true);
    assert.equal(setup.zonesApi.hasSnapshotListener(), false);
    assert.equal(setup.elements.chart3d.listeners.get('plotly_relayouting')?.size, 0);
    assert.equal(setup.elements.chart3d.listeners.get('plotly_relayout')?.size, 0);
    assert.equal(setup.elements.chart3d.listeners.get('pointerdown')?.size, 0);
    assert.equal(setup.elements.chart3d.listeners.get('wheel')?.size, 0);
    assert.equal(setup.windowObject.listeners.get('pointerup')?.size, 0);
    assert.equal(setup.windowObject.listeners.get('pointercancel')?.size, 0);
    assert.equal(setup.windowObject.listeners.get('mouseup')?.size, 0);
    assert.equal(setup.windowObject.listeners.get('touchend')?.size, 0);
    assert.equal(setup.windowObject.listeners.get('touchcancel')?.size, 0);
    assert.ok(setup.plotly.calls.some((call) => call.kind === 'purge'));
});
