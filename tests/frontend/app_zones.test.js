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
    const events = { status: [], toast: [], pending: [] };
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
        onPendingCommandChange: (actionId) => events.pending.push(actionId),
        maintenanceCommandTimeoutMs: opts.maintenanceCommandTimeoutMs,
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

    const [topDownTargets, topDownTrails] = zones.buildTarget3DTraces(
        [withNegativeHeight, withoutHeight],
        { 2: [{ x: -22, y: 90, z: 0, hasZ: false }] },
        { missingZValue: 0 },
    );
    assert.deepEqual(plain(topDownTargets.z), [-16, 0], 'top-down mode should retain targets with unavailable height');
    assert.deepEqual(plain(topDownTrails.z), [0, null]);
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
    assert.ok(tableEl.innerHTML.includes('Target 1'));

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
    const [passiveVolume, passiveEdges] = zones.buildZoneCuboidTraces({
        x_min: -40, x_max: 120, y_min: 60, y_max: 260, z_min: -30, z_max: 110,
    }, { name: 'Passive area', hoverinfo: 'skip' });
    assert.equal(passiveVolume.hoverinfo, 'skip');
    assert.equal(passiveEdges.hoverinfo, 'skip');
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
    assert.equal(traces[3].visible, false);
    assert.deepEqual(
        plain(traces.map((trace) => trace.hoverinfo)),
        ['skip', 'skip', 'skip', 'skip'],
        'sensor range is a non-interactive visual reference',
    );
    const allVisible = zones.buildFov3DTraces({ ...common, visible: true });
    assert.deepEqual(
        plain(allVisible.map((trace) => trace.visible)),
        [true, false, true, false],
        'FOV edge traces retain stable indices without drawing a border',
    );
    assert.equal(traces[0].color, '#66768A');
    assert.equal(traces[0].opacity, 0.03);
    assert.equal(traces[1].line.color, 'rgba(135, 153, 175, 0.12)');
    assert.equal(traces[1].visible, false);
    assert.equal(traces[1].hoverinfo, 'skip');
    assert.equal(traces[2].color, '#8FA1B8');
    assert.equal(traces[2].opacity, 0.06);
    assert.equal(traces[3].line.color, 'rgba(165, 181, 201, 0.18)');
    assert.equal(traces[3].visible, false);
    assert.equal(traces[3].hoverinfo, 'skip');
    assert.deepEqual(plain(zones.getFovStyles()), {
        outer: {
            color: '#66768A',
            edgeColor: 'rgba(135, 153, 175, 0.12)',
            opacity3d: 0.03,
            fill2d: 'rgba(102, 118, 138, 0.02)',
            edgeWidth: 1,
            edgeDash: 'dot',
        },
        nominal: {
            color: '#8FA1B8',
            edgeColor: 'rgba(165, 181, 201, 0.18)',
            opacity3d: 0.06,
            fill2d: 'rgba(143, 161, 184, 0.04)',
            edgeWidth: 1.3,
            edgeDash: 'solid',
        },
    });

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

test('2D unsupported-range masks cover only the disjoint space outside the sensor limits', () => {
    const { zones } = loadZonesModule();
    const metadata = {
        type: 'rect',
        xref: 'x',
        yref: 'y',
        fillcolor: 'rgba(120, 132, 148, 0.09)',
        line: { color: 'rgba(0, 0, 0, 0)', width: 0 },
        editable: false,
        layer: 'below',
    };
    const shapes = plain(zones.buildUnsupportedRange2DShapes({
        xMin: -900,
        xMax: 900,
        yMin: -200,
        yMax: 1400,
    }));

    assert.deepEqual(shapes, [
        { ...metadata, x0: -900, x1: 900, y0: -200, y1: 0 },
        { ...metadata, x0: -900, x1: 900, y0: 600, y1: 1400 },
        { ...metadata, x0: -900, x1: -600, y0: 0, y1: 600 },
        { ...metadata, x0: 600, x1: 900, y0: 0, y1: 600 },
    ]);

    assert.deepEqual(
        plain(zones.buildUnsupportedRange2DShapes({
            xMin: -500,
            xMax: 500,
            yMin: 25,
            yMax: 575,
        })),
        [],
        'a viewport wholly inside the supported range needs no mask',
    );

    const clipped = plain(zones.buildUnsupportedRange2DShapes({
        xMin: -700,
        xMax: 500,
        yMin: -50,
        yMax: 650,
        fillcolor: 'rgba(1, 2, 3, 0.4)',
    }));
    const clippedMetadata = { ...metadata, fillcolor: 'rgba(1, 2, 3, 0.4)' };
    assert.deepEqual(clipped, [
        { ...clippedMetadata, x0: -700, x1: 500, y0: -50, y1: 0 },
        { ...clippedMetadata, x0: -700, x1: 500, y0: 600, y1: 650 },
        { ...clippedMetadata, x0: -700, x1: -600, y0: 0, y1: 600 },
    ]);
});

test('interference command lifecycle reports completion and clears pending command id', () => {
    const { zones, events } = loadZonesModule();

    assert.equal(zones.setPendingCommand(1), true);
    zones.handleInterferenceZones([{}, {}]);
    assert.equal(zones.getPendingCommandId(), null);
    assert.ok(events.status.some((entry) => entry.message === 'Auto-config complete. 2 interference zones now reported.'));

    assert.equal(zones.setPendingCommand(3), true);
    assert.equal(zones.setPendingCommand(5), false, 'a second command must not replace pending work');
    assert.equal(zones.getPendingCommandId(), 3);

    zones.handleInterferenceZones([]);

    assert.equal(zones.getPendingCommandId(), null);
    assert.ok(events.status.some((entry) => entry.message.includes('Interference cleared')));
    assert.ok(events.toast.some((entry) => entry.message.includes('Interference cleared')));
    assert.deepEqual(events.pending, [1, null, 3, null]);
});

test('maintenance command timeout and explicit disconnect cleanup release the duplicate lock', async () => {
    const { zones, events } = loadZonesModule({ maintenanceCommandTimeoutMs: 5 });

    assert.equal(zones.setPendingCommand(4), true);
    assert.equal(zones.setPendingCommand(5), false);
    await new Promise((resolve) => setTimeout(resolve, 15));

    assert.equal(zones.getPendingCommandId(), null);
    assert.ok(events.status.some((entry) => entry.message.includes('not confirmed in time')));
    assert.ok(events.toast.some((entry) => entry.message.includes('not confirmed in time')));

    assert.equal(zones.setPendingCommand(5), true);
    zones.clearPendingCommand();
    assert.equal(zones.getPendingCommandId(), null);
    assert.equal(zones.setPendingCommand(3), true, 'a disconnect-style clear must allow retry');
    zones.clearPendingCommand();
    assert.deepEqual(events.pending, [4, null, 5, null, 3, null]);
});

test('zone write tracker restores the immutable submitted draft after not-confirmed and clears it only after retry confirmation', () => {
    const { zones } = loadZonesModule();
    const tracker = zones.createZoneWriteTracker();
    const submitted = { x_min: -140, x_max: 80, y_min: 35, y_max: 275, z_min: -90, z_max: 160 };

    assert.ok(tracker.begin({
        requestId: 'zone-save-1',
        topic: 'zigbee2mqtt/office',
        target: 'mmwave_detection_areas:area2',
        draft: submitted,
    }));
    submitted.x_min = 999;

    const sent = tracker.transition({
        request_id: 'zone-save-1',
        topic: 'zigbee2mqtt/office',
        status: 'sent',
    });
    assert.equal(sent.handled, true);
    assert.equal(sent.record.state, 'awaiting_device');
    assert.deepEqual(plain(sent.record.draft), {
        x_min: -140, x_max: 80, y_min: 35, y_max: 275, z_min: -90, z_max: 160,
    });

    const failed = tracker.transition({
        request_id: 'zone-save-1',
        topic: 'zigbee2mqtt/office',
        status: 'not_confirmed',
    });
    assert.equal(failed.handled, true);
    assert.equal(failed.shouldRestore, true);
    assert.equal(failed.record.failureStatus, 'not_confirmed');
    const retryable = tracker.getRetryable('zigbee2mqtt/office', 'mmwave_detection_areas:area2');
    assert.deepEqual(plain(retryable.draft), {
        x_min: -140, x_max: 80, y_min: 35, y_max: 275, z_min: -90, z_max: 160,
    });

    assert.ok(tracker.begin({
        requestId: 'zone-save-2',
        topic: retryable.topic,
        target: retryable.target,
        draft: retryable.draft,
    }));
    assert.equal(
        tracker.transition({ request_id: 'zone-save-1', topic: retryable.topic, status: 'confirmed' }).handled,
        false,
        'a stale confirmation must not clear the newer retry',
    );
    assert.equal(tracker.transition({ request_id: 'zone-save-2', topic: retryable.topic, status: 'confirmed' }).confirmed, true);
    assert.equal(tracker.getRetryable(retryable.topic, retryable.target), null);
});

test('zone write tracker retains device-scoped retries across disconnect and never restores deletes', () => {
    const { zones } = loadZonesModule();
    const tracker = zones.createZoneWriteTracker();
    const officeDraft = { x_min: -100, x_max: 100, y_min: 20, y_max: 220, z_min: -100, z_max: 100 };
    const kitchenDraft = { x_min: -220, x_max: -20, y_min: 40, y_max: 340, z_min: -60, z_max: 180 };

    tracker.begin({ requestId: 'zone-save-office', topic: 'zigbee2mqtt/office', target: 'mmwave_stay_areas:area1', draft: officeDraft });
    tracker.begin({ requestId: 'zone-save-kitchen', topic: 'zigbee2mqtt/kitchen', target: 'mmwave_detection_areas:area3', draft: kitchenDraft });
    tracker.begin({ requestId: 'zone-delete-office', topic: 'zigbee2mqtt/office', target: 'mmwave_interference_areas:area4', isDelete: true });

    const interrupted = tracker.failPending('disconnected');
    assert.equal(interrupted.length, 3);
    assert.deepEqual(
        plain(tracker.getRetryable('zigbee2mqtt/office', 'mmwave_stay_areas:area1').draft),
        officeDraft,
    );
    assert.deepEqual(
        plain(tracker.getRetryable('zigbee2mqtt/kitchen', 'mmwave_detection_areas:area3').draft),
        kitchenDraft,
    );
    assert.equal(tracker.getRetryable('zigbee2mqtt/office', 'mmwave_interference_areas:area4'), null);
    assert.equal(tracker.getRetryable('zigbee2mqtt/bedroom'), null);
});

test('zone write tracker isolates mismatched topics and supports explicit retry discard', () => {
    const { zones } = loadZonesModule();
    const tracker = zones.createZoneWriteTracker();
    const draft = { x_min: -50, x_max: 50, y_min: 10, y_max: 110, z_min: -30, z_max: 70 };
    tracker.begin({ requestId: 'zone-save-topic', topic: 'zigbee2mqtt/office', target: 'mmwave_detection_areas:area1', draft });

    const wrongTopic = tracker.transition({ request_id: 'zone-save-topic', topic: 'zigbee2mqtt/kitchen', status: 'not_confirmed' });
    assert.deepEqual(plain(wrongTopic), { handled: false, reason: 'topic_mismatch' });
    assert.equal(tracker.getRetryable('zigbee2mqtt/office'), null);

    tracker.transition({ request_id: 'zone-save-topic', topic: 'zigbee2mqtt/office', status: 'error' });
    assert.ok(tracker.getRetryable('zigbee2mqtt/office', 'mmwave_detection_areas:area1'));
    assert.equal(tracker.discardRetryable('zigbee2mqtt/office', 'mmwave_detection_areas:area1'), true);
    assert.equal(tracker.getRetryable('zigbee2mqtt/office'), null);

    tracker.begin({ requestId: 'zone-save-discarded', topic: 'zigbee2mqtt/office', target: 'mmwave_detection_areas:area1', draft });
    assert.equal(tracker.discardRetryable('zigbee2mqtt/office', 'mmwave_detection_areas:area1'), true);
    const discardedFailure = tracker.transition({ request_id: 'zone-save-discarded', topic: 'zigbee2mqtt/office', status: 'error' });
    assert.equal(discardedFailure.shouldRestore, false, 'an explicit discard must suppress later recovery');
    assert.equal(tracker.getRetryable('zigbee2mqtt/office'), null);
});

test('destructive zone maintenance confirmation names the action and device and honors cancel or accept', () => {
    const { zones } = loadZonesModule();
    const prompts = [];

    assert.equal(zones.confirmZoneMaintenanceCommand(1, 'Office Switch', () => {
        throw new Error('auto-config must not ask for confirmation');
    }), true);
    assert.equal(zones.confirmZoneMaintenanceCommand(3, 'Office Switch', (prompt) => {
        prompts.push(prompt);
        return false;
    }), false);
    assert.equal(zones.confirmZoneMaintenanceCommand(4, 'Office Switch', (prompt) => {
        prompts.push(prompt);
        return true;
    }), true);
    assert.equal(zones.confirmZoneMaintenanceCommand(5, 'Office Switch', () => false), false);
    assert.match(prompts[0], /Clear Interference for Office Switch\?/);
    assert.match(prompts[1], /Reset Detection Zones for Office Switch\?/);
    assert.ok(prompts.every((prompt) => prompt.includes('cannot be undone')));
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
    assert.ok(tableEl.innerHTML.includes('Target 1'));
    assert.ok(tableEl.innerHTML.includes('Target 2'));
    assert.ok(tableEl.innerHTML.includes('aria-label="Unavailable"'));
    assert.ok(tableEl.innerHTML.includes('&mdash;'));
});
