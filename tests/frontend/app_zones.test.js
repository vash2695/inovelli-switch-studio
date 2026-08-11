const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertNear(actual, expected, tolerance = 0.001) {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);
}

function loadZonesModule(options) {
    const opts = options || {};
    const scriptPath = path.resolve(__dirname, '../../switch_studio/static/js/app_zones.js');
    const source = fs.readFileSync(scriptPath, 'utf8');
    const events = { status: [], toast: [] };
    const plotlyCalls = [];
    const snapshots = [];
    const chartEl = {};
    const tableEl = { innerHTML: '' };

    const context = {
        window: {
            Plotly: {
                restyle: (...args) => plotlyCalls.push({ kind: 'restyle', args }),
                react: (...args) => plotlyCalls.push({ kind: 'react', args }),
            },
        },
        document: {
        getElementById: () => null,
        },
        console,
        setTimeout,
        clearTimeout,
    };
    context.global = context;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: scriptPath });

    const zones = context.window.SwitchStudioZones;
    zones.init({
        chartEl,
        dataTableBodyEl: tableEl,
        stateApi: {
            setPacketStatus: (mode, message) => events.status.push({ mode, message }),
            showToast: (mode, message) => events.toast.push({ mode, message }),
        },
        shouldRenderTargets: opts.shouldRenderTargets || null,
        shouldRender2d: opts.shouldRender2d || null,
        onTargetSnapshot: (snapshot) => snapshots.push(JSON.parse(JSON.stringify(snapshot))),
        limits: opts.useDefaultLimits ? undefined : {
            xMin: -200,
            xMax: 200,
            yMin: 0,
            yMax: 300,
            zMin: -50,
            zMax: 200,
            minSpan: 20,
        },
    });

    return { zones, events, plotlyCalls, snapshots, tableEl };
}

test('zone payload builder sorts and maps coordinate fields', () => {
    const { zones } = loadZonesModule();
    const payload = zones.buildAreaPayload('area2', {
        x_min: 120,
        x_max: 40,
        y_min: 250,
        y_max: 50,
        z_min: 100,
        z_max: 0,
    });

    const plainPayload = JSON.parse(JSON.stringify(payload));

    assert.deepEqual(plainPayload, {
        area2: {
            width_min: 40,
            width_max: 120,
            depth_min: 50,
            depth_max: 250,
            height_min: 0,
            height_max: 100,
        },
    });
});

test('zone validation normalizes spans and supports allowZeroSpan mode', () => {
    const { zones } = loadZonesModule();

    const normalized = zones.validateZoneConfig(
        { x_min: 1000, x_max: -900, y_min: -80, y_max: 8, z_min: 11, z_max: 12 },
        { allowZeroSpan: false },
    );
    assert.equal(normalized.valid, true);
    assert.equal(normalized.errors.length, 0);
    assert.ok(normalized.normalized.x_min >= -200);
    assert.ok(normalized.normalized.x_max <= 200);
    assert.ok((normalized.normalized.x_max - normalized.normalized.x_min) >= 20);
    assert.ok((normalized.normalized.y_max - normalized.normalized.y_min) >= 20);
    assert.ok((normalized.normalized.z_max - normalized.normalized.z_min) >= 20);

    const zeroSpan = zones.validateZoneConfig(
        { x_min: 10, x_max: 10, y_min: 20, y_max: 20, z_min: 30, z_max: 30 },
        { allowZeroSpan: true },
    );
    assert.equal(zeroSpan.valid, true);
    assert.equal(zeroSpan.normalized.x_min, 10);
    assert.equal(zeroSpan.normalized.x_max, 10);
    assert.equal(zeroSpan.normalized.y_min, 20);
    assert.equal(zeroSpan.normalized.y_max, 20);
    assert.equal(zeroSpan.normalized.z_min, 30);
    assert.equal(zeroSpan.normalized.z_max, 30);
});

test('default zone height limits match the published plus or minus 600 cm range', () => {
    const { zones } = loadZonesModule({ useDefaultLimits: true });
    const result = zones.validateZoneConfig({
        x_min: -20, x_max: 20,
        y_min: 0, y_max: 40,
        z_min: -900, z_max: 900,
    });

    assert.equal(result.valid, true);
    assert.equal(result.normalized.z_min, -600);
    assert.equal(result.normalized.z_max, 600);
});

test('raw compact zone snapshots preserve declared physical area slots', () => {
    const { zones } = loadZonesModule();
    const area1 = { area_id: 'area1', area_index: 1, x_min: -20, x_max: 20 };
    const area3 = { area_id: 'area3', area_index: 3, x_min: 80, x_max: 120 };
    const mapped = plain(zones.mapRawZonesByAreaId([area1, area3]));

    assert.deepEqual(mapped, {
        area1,
        area2: null,
        area3,
        area4: null,
    });

    const legacy = [{ x_min: 1 }, { x_min: 2 }];
    assert.deepEqual(plain(zones.mapRawZonesByAreaId(legacy)), {
        area1: legacy[0],
        area2: legacy[1],
        area3: null,
        area4: null,
    });
});

test('3D target traces preserve negative height and leave missing height unplotted', () => {
    const { zones } = loadZonesModule();
    const withNegativeHeight = plain(zones.normalizeTarget({ id: 1, x: 12.4, y: 80.6, z: -16.2, dop: -18 }));
    const withoutHeight = plain(zones.normalizeTarget({ id: 2, x: -22, y: 90, dop: 0 }));

    assert.deepEqual(withNegativeHeight, { id: 1, x: 12, y: 81, z: -16, hasZ: true, dop: -18 });
    assert.deepEqual(withoutHeight, { id: 2, x: -22, y: 90, z: 0, hasZ: false, dop: 0 });

    const [targets, trails] = zones.buildTarget3DTraces(
        [withNegativeHeight, withoutHeight],
        {
            1: [{ x: 10, y: 75, z: -20, hasZ: true }, { x: 12, y: 81, z: -16, hasZ: true }],
            2: [{ x: -22, y: 90, z: 0, hasZ: false }],
        },
    );

    assert.equal(targets.type, 'scatter3d');
    assert.deepEqual(plain(targets.x), [12, -22]);
    assert.deepEqual(plain(targets.y), [81, 90]);
    assert.deepEqual(plain(targets.z), [-16, null]);
    assert.equal(targets.customdata[1][3], 'Unavailable');
    assert.equal(trails.type, 'scatter3d');
    assert.deepEqual(plain(trails.z), [-20, -16, null, null, null]);
    assert.equal(trails.connectgaps, false);
});

test('canonical live history snapshots retain xyz and clear cleanly on reset', () => {
    const { zones, snapshots } = loadZonesModule();
    const topic = 'zigbee2mqtt/bedroom_switch';

    zones.handleNewData({
        topic,
        payload: { targets: [{ id: 1, x: 10, y: 40, z: -12, dop: 0 }] },
    }, topic);
    zones.handleNewData({
        topic,
        payload: { targets: [{ id: 1, x: 14, y: 44, dop: 13 }] },
    }, topic);

    const ignored = zones.handleNewData({
        topic: 'zigbee2mqtt/other_switch',
        payload: { targets: [{ id: 9, x: 999, y: 999, z: 999, dop: 0 }] },
    }, topic);
    assert.equal(ignored, false);

    const live = snapshots.at(-1);
    assert.equal(live.reason, 'live');
    assert.deepEqual(live.targets, [{ id: 1, x: 14, y: 44, z: 0, hasZ: false, dop: 13 }]);
    assert.deepEqual(live.history['1'], [
        { x: 10, y: 40, z: -12, hasZ: true },
        { x: 14, y: 44, z: 0, hasZ: false },
    ]);

    live.history['1'][0].z = 999;
    assert.equal(zones.getTargetSnapshot().history['1'][0].z, -12, 'snapshots should not expose mutable history');

    zones.resetHistory();
    const reset = snapshots.at(-1);
    assert.equal(reset.reason, 'reset');
    assert.deepEqual(reset.targets, []);
    assert.deepEqual(reset.history, {});
});

test('hidden 2D radar keeps canonical data current and catches up when shown', () => {
    let render2d = false;
    let renderTargets = true;
    const { zones, plotlyCalls, snapshots, tableEl } = loadZonesModule({
        shouldRender2d: () => render2d,
        shouldRenderTargets: () => renderTargets,
    });

    zones.handleNewData({
        topic: 'zigbee2mqtt/bedroom_switch',
        payload: { targets: [{ id: 1, x: 42, y: 210, z: 18, dop: 0 }] },
    }, 'zigbee2mqtt/bedroom_switch');

    assert.equal(plotlyCalls.some((entry) => entry.kind === 'react'), false);
    assert.equal(snapshots.at(-1).targets[0].z, 18);
    assert.ok(tableEl.innerHTML.includes('D1 (Primary)'));

    renderTargets = false;
    zones.handleNewData({
        topic: 'zigbee2mqtt/bedroom_switch',
        payload: { targets: [{ id: 1, x: 99, y: 99, z: 99, dop: 0 }] },
    }, 'zigbee2mqtt/bedroom_switch');
    assert.equal(plotlyCalls.some((entry) => entry.kind === 'restyle'), false, 'hidden clears should not render either');
    renderTargets = true;
    zones.handleNewData({
        topic: 'zigbee2mqtt/bedroom_switch',
        payload: { targets: [{ id: 1, x: 42, y: 210, z: 18, dop: 0 }] },
    }, 'zigbee2mqtt/bedroom_switch');

    render2d = true;
    assert.equal(zones.refreshTargetVisualization(), true);
    const render = plotlyCalls.findLast((entry) => entry.kind === 'react');
    assert.deepEqual(plain(render.args[1][0].x), [42]);
    assert.deepEqual(plain(render.args[1][0].y), [210]);
});

test('zone cuboid helpers build exact vertices, faces, edges, and visibility', () => {
    const { zones } = loadZonesModule();
    const geometry = zones.buildZoneCuboidGeometry({
        width_min: 120,
        width_max: -40,
        depth_min: 260,
        depth_max: 60,
        height_min: 110,
        height_max: -30,
    });

    assert.deepEqual(plain(geometry.bounds), {
        xMin: -40,
        xMax: 120,
        yMin: 60,
        yMax: 260,
        zMin: -30,
        zMax: 110,
    });
    assert.deepEqual(plain(geometry.vertices), [
        { x: -40, y: 60, z: -30 },
        { x: 120, y: 60, z: -30 },
        { x: 120, y: 260, z: -30 },
        { x: -40, y: 260, z: -30 },
        { x: -40, y: 60, z: 110 },
        { x: 120, y: 60, z: 110 },
        { x: 120, y: 260, z: 110 },
        { x: -40, y: 260, z: 110 },
    ]);
    assert.equal(geometry.triangles.length, 12);
    assert.equal(geometry.edges.length, 12);

    const [volume, edges] = zones.buildZoneCuboidTraces({
        x_min: -40, x_max: 120, y_min: 60, y_max: 260, z_min: -30, z_max: 110,
    }, { name: 'Detection Area 1', visible: false });
    assert.equal(volume.type, 'mesh3d');
    assert.equal(edges.type, 'scatter3d');
    assert.equal(volume.visible, false);
    assert.equal(edges.visible, false);
    assert.equal(edges.x.length, 36);
    assert.equal(zones.buildZoneCuboidGeometry({ x_min: 0, x_max: 0, y_min: 0, y_max: 20, z_min: 0, z_max: 20 }), null);
    assert.deepEqual(plain(zones.buildZoneCuboidTraces({ x_min: 0, x_max: 20 })), []);
});

test('3D FOV volumes match the clipped forward-facing 120 and 150 degree sectors', () => {
    const { zones } = loadZonesModule();
    const common = { xMin: -650, xMax: 650, yMax: 650, zMin: -120, zMax: 240 };
    const inner = zones.buildFovVolumeGeometry({ ...common, halfAngleDegrees: 60 });
    const outer = zones.buildFovVolumeGeometry({ ...common, halfAngleDegrees: 75 });

    assert.equal(inner.fullAngleDegrees, 120);
    assert.equal(outer.fullAngleDegrees, 150);
    assert.deepEqual(plain(inner.bounds), {
        xMin: -650,
        xMax: 650,
        yMin: 0,
        yMax: 600,
        zMin: -120,
        zMax: 240,
    });
    assert.deepEqual(plain(inner.polygon[0]), { x: 0, y: 0 });
    assertNear(inner.polygon[1].x, 650);
    assertNear(inner.polygon[1].y, 650 / Math.tan(Math.PI / 3));
    assert.deepEqual(plain(inner.polygon[2]), { x: 650, y: 600 });
    assert.deepEqual(plain(inner.polygon[3]), { x: -650, y: 600 });
    assertNear(inner.polygon[4].x, -650);
    assertNear(inner.polygon[4].y, 650 / Math.tan(Math.PI / 3));
    assert.ok(outer.polygon[1].y < inner.polygon[1].y, '150 degree envelope should be wider than 120 degrees');
    assert.equal(Math.min(...inner.z), -120);
    assert.equal(Math.max(...inner.z), 240);
    assert.ok(inner.polygon.every((point) => point.y >= 0), 'FOV must face forward along positive depth');

    const traces = zones.buildFov3DTraces({ ...common, visible: true, showOuter: false });
    assert.deepEqual(plain(traces.map((trace) => trace.type)), ['mesh3d', 'scatter3d', 'mesh3d', 'scatter3d']);
    assert.equal(traces[0].visible, false);
    assert.equal(traces[1].visible, false);
    assert.equal(traces[2].visible, true);
    assert.equal(traces[3].visible, true);

    const asymmetric = zones.buildFovVolumeGeometry({
        xMin: -200,
        xMax: 500,
        yMax: 600,
        zMin: 600,
        zMax: -600,
        halfAngleDegrees: 60,
    });
    assert.equal(asymmetric.bounds.zMin, -600);
    assert.equal(asymmetric.bounds.zMax, 600);
    assert.ok(asymmetric.polygon.every((point) => point.x >= -200 && point.x <= 500));
    assert.ok(asymmetric.polygon.every((point) => point.y >= 0 && point.y <= 600));
});

test('interference command lifecycle reports completion and clears pending command id', () => {
    const { zones, events } = loadZonesModule();

    zones.setPendingCommand(3);
    assert.equal(zones.getPendingCommandId(), 3);

    zones.handleInterferenceZones([]);

    assert.equal(zones.getPendingCommandId(), null);
    assert.ok(events.status.some((entry) => entry.message.includes('Interference cleared')));
    assert.ok(events.toast.some((entry) => entry.message.includes('Interference cleared')));
});

test('target rendering is suppressed when occupancy gate is clear', () => {
    const { zones, events, plotlyCalls, snapshots, tableEl } = loadZonesModule({
        shouldRenderTargets: () => false,
    });

    const handled = zones.handleNewData(
        {
            topic: 'zigbee2mqtt/bedroom_switch',
            payload: {
                targets: [{ id: 1, x: 77, y: 44, z: -16, dop: 0 }],
            },
        },
        'zigbee2mqtt/bedroom_switch',
    );

    assert.equal(handled, true);
    assert.ok(plotlyCalls.some((entry) => entry.kind === 'restyle'));
    assert.ok(tableEl.innerHTML.includes('No targets detected'));
    assert.ok(events.status.some((entry) => entry.message.includes('No active occupancy')));
    assert.equal(snapshots.at(-1).reason, 'clear');
    assert.deepEqual(snapshots.at(-1).targets, []);
    assert.deepEqual(snapshots.at(-1).history, {});
});

test('2D rendering remains scatter-based while canonical height state feeds 3D', () => {
    const { zones, plotlyCalls, tableEl } = loadZonesModule();
    const handled = zones.handleNewData({
        topic: 'zigbee2mqtt/bedroom_switch',
        payload: {
            targets: [
                { id: 1, x: 77, y: 44, z: -16, dop: 0 },
                { id: 2, x: -20, y: 90, dop: 12 },
            ],
        },
    }, 'zigbee2mqtt/bedroom_switch');

    assert.equal(handled, true);
    const render = plotlyCalls.findLast((entry) => entry.kind === 'react');
    assert.ok(render);
    const [targets, trails] = render.args[1];
    assert.equal(targets.type, 'scatter');
    assert.equal(trails.type, 'scatter');
    assert.deepEqual(plain(targets.x), [77, -20]);
    assert.deepEqual(plain(targets.y), [44, 90]);
    assert.equal(Object.hasOwn(targets, 'z'), false);
    assert.deepEqual(plain(targets.marker.size), [8, 10]);
    assert.ok(tableEl.innerHTML.includes('D1 (Primary)'));
    assert.ok(tableEl.innerHTML.includes('D2 (Secondary)'));
    assert.ok(tableEl.innerHTML.includes('aria-label="Unavailable"'));
    assert.ok(tableEl.innerHTML.includes('&mdash;'));
});
