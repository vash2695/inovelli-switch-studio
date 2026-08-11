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

function createStorage(initial) {
    const values = new Map(Object.entries(initial || {}));
    return {
        getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
        value: (key) => values.get(key),
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
    // The 560 ms camera path resolves on the following 24 ms frame. Returning
    // to native 2D then lets the 170 ms surface crossfade retire WebGL.
    setup.clock.advance(targetMode === '2d' ? 760 : 584);
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
    assert.equal(plots[0].layout.scene.aspectmode, 'data');
    assert.notEqual(plots[0].layout.scene.zaxis.visible, false);
    assert.equal(plots[0].config.scrollZoom, false);
    assertCameraClose(plain(plots[0].layout.scene.camera), TOP_DOWN_CAMERA);
    assert.equal(setup.elements.chart3d.dataset.interactionLocked, 'true');
    assert.match(setup.elements.chart3d.getAttribute('aria-label'), /Three-dimensional live presence radar/);
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

    setup.clock.advance(47);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'outgoing');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'incoming');
    setup.clock.advance(1);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'retiring');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');

    setup.clock.advance(511);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'true');
    setup.clock.advance(17);
    assert.equal(setup.elements.chart3d.dataset.transitioning, 'false');
    assert.equal(setup.elements.chart2d.hidden, true);
    assert.equal(setup.elements.chart3d.hidden, false);
    assert.equal(setup.elements.reset.hidden, false);
    const forwardRelayouts = cameraRelayouts(setup);
    const perspectiveRelayout = cameraRelayouts(setup).at(-1);
    const perspective = cameraFromRelayout(perspectiveRelayout);
    assertCameraClose(plain(perspective), DEFAULT_PERSPECTIVE_CAMERA);
    assert.deepEqual(Array.from(perspectiveRelayout.update['scene.xaxis.range']), [-650, 650]);
    assert.equal(perspectiveRelayout.update['scene.aspectmode'], 'data');
    assert.equal(perspectiveRelayout.update['scene.dragmode'], 'turntable');
    assert.ok(forwardRelayouts.length >= 20, 'the 560 ms orbit should emit a smooth sequence of frames');
    forwardRelayouts.forEach((call) => {
        const camera = cameraFromRelayout(call);
        assert.deepEqual(plain(camera.center), { x: 0, y: 0, z: 0 });
        assert.deepEqual(plain(camera.up), { x: 0, y: 0, z: 1 });
        assert.equal(call.update['scene.camera']?.projection, undefined);
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
    setup.clock.advance(280);
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

    finishCameraTransition(setup, '2d');
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
    setup.clock.advance(24);
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
    setup.clock.advance(575);

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

test('scene assembly uses exact XYZ bounds, one primary cuboid, slot visibility, and separate zone colors', () => {
    const setup = loadController({ sceneModel: scene(), initialMode: '3d' });
    const newPlot = setup.plotly.calls.find((call) => call.kind === 'newPlot');
    assert.ok(newPlot);
    assert.deepEqual(Array.from(newPlot.layout.scene.xaxis.range), [-500, 500]);
    assert.deepEqual(Array.from(newPlot.layout.scene.yaxis.range), [0, 600]);
    assert.deepEqual(Array.from(newPlot.layout.scene.zaxis.range), [-250, 250]);
    assert.equal(newPlot.layout.scene.aspectmode, 'data');
    assert.equal(newPlot.layout.scene.dragmode, 'turntable');
    assert.equal(newPlot.config.scrollZoom, false);
    assertCameraClose(plain(newPlot.layout.scene.camera), DEFAULT_PERSPECTIVE_CAMERA);

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
    assert.ok(cameraRelayouts(setup).length > 0, 'the orbit should begin only after the current preparation resolves');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'incoming');
    setup.clock.advance(1);
    assert.equal(setup.elements.chart2d.dataset.radarSurfaceState, 'retiring');
    assert.equal(setup.elements.chart3d.dataset.radarSurfaceState, 'active');
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

test('plotly camera relayouts are sanitized to fixed center, z-up, perspective, and safe elevation', () => {
    const setup = loadController({ initialMode: '3d' });
    const before = cameraRelayouts(setup).length;

    setup.elements.chart3d.emit('plotly_relayout', {
        'scene.camera': {
            eye: { x: 9, y: 0, z: -4 },
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
    const radius = Math.hypot(corrected.eye.x, corrected.eye.y, corrected.eye.z);
    const elevation = Math.asin(corrected.eye.z / radius);
    assert.ok(radius <= 4.6 + 1e-9);
    assert.ok(elevation >= 0.18 - 1e-9);
    assert.ok(elevation <= 1.34 + 1e-9);
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
        element.listeners.delete('plotly_relayout');
        return createPlot(element, traces, layout, config);
    };
    const setup = loadController({ initialMode: '3d', plotly });
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
    assert.ok(elevation >= 0.18 - 1e-9);
    assert.ok(elevation <= 1.34 + 1e-9);
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
    assert.equal(setup.elements.chart3d.listeners.get('plotly_relayout')?.size, 1);
    setup.resizeObservers[0].callback();
    assert.ok(setup.plotly.calls.some((call) => call.kind === 'resize'));
    assert.equal(setup.zonesApi.hasSnapshotListener(), true);

    setup.controller.destroy();
    assert.equal(setup.resizeObservers[0].disconnected, true);
    assert.equal(setup.zonesApi.hasSnapshotListener(), false);
    assert.equal(setup.elements.chart3d.listeners.get('plotly_relayout')?.size, 0);
    assert.equal(setup.elements.chart3d.listeners.get('wheel')?.size, 0);
    assert.ok(setup.plotly.calls.some((call) => call.kind === 'purge'));
});
