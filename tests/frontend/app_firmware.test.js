const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFirmwareModule() {
    const scriptPath = path.resolve(__dirname, '../../switch_studio/static/js/app_firmware.js');
    const source = fs.readFileSync(scriptPath, 'utf8');
    const context = { window: {}, console };
    context.global = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: scriptPath });
    return context.window.SwitchStudioFirmware;
}

test('raw device load state is never normalized as firmware lifecycle state', () => {
    const firmware = loadFirmwareModule();
    const normalized = firmware.normalize(
        { state: 'OFF', brightness: 80, progress: 99, remaining: 10 },
        { devicePayload: true },
    );
    assert.equal(normalized, null);
});

test('raw device payload uses only nested update lifecycle fields', () => {
    const firmware = loadFirmwareModule();
    const normalized = firmware.normalize({
        state: 'OFF',
        update_available: true,
        update: {
            state: 'updating',
            progress: 13.37,
            remaining: 42.5,
            installed_version: 16974080,
            latest_version: 16973834,
        },
    }, { devicePayload: true });

    assert.deepEqual(JSON.parse(JSON.stringify(normalized)), {
        available: true,
        installed_version: 16974080,
        latest_version: 16973834,
        state: 'updating',
        progress: 13.37,
        remaining: 42.5,
    });
});

test('normalized backend firmware patches retain supported top-level lifecycle fields', () => {
    const firmware = loadFirmwareModule();
    const normalized = firmware.normalize({
        state: 'checked',
        progress: 100,
        remaining: null,
        bridge_status: 'ok',
        last_checked: 1234,
    });

    assert.deepEqual(JSON.parse(JSON.stringify(normalized)), {
        last_checked: 1234,
        bridge_status: 'ok',
        state: 'checked',
        progress: 100,
        remaining: null,
    });
});

test('firmware normalization accepts Zigbee2MQTT camelCase and status variants', () => {
    const firmware = loadFirmwareModule();
    const normalized = firmware.normalize({
        updateAvailable: true,
        update: {
            status: 'updating',
            error: 'specific failure',
            message: 'generic message',
        },
    }, { devicePayload: true });

    assert.deepEqual(JSON.parse(JSON.stringify(normalized)), {
        available: true,
        state: 'updating',
        last_error: 'specific failure',
    });
});

test('Zigbee2MQTT 2.x update lifecycle supplies catalog availability without legacy flags', () => {
    const firmware = loadFirmwareModule();
    const available = firmware.normalize({
        update: { state: 'available', installed_version: 10, latest_version: 11 },
    }, { devicePayload: true });
    const idle = firmware.normalize({ update: { state: 'idle' } }, { devicePayload: true });

    assert.equal(available.available, true);
    assert.equal(available.state, 'available');
    assert.equal(idle.available, false);
});

test('structured firmware state keeps live and reference provenance separate', () => {
    const firmware = loadFirmwareModule();
    const model = firmware.merge(firmware.createModel('zigbee2mqtt/office'), {
        schema_version: 1,
        topic: 'zigbee2mqtt/office',
        live: {
            revision: 4,
            observed_at: 400,
            observed_source: 'zigbee2mqtt',
            installed_version: 16974080,
            state: 'updating',
            progress: 28,
        },
        reference: {
            generation: 7,
            status: 'fresh',
            fetched_at: 350,
            official_versions: { Production: '1.00', Beta: '1.03' },
            installed_version_detail: { display_version: '1.00', exact_match: true },
        },
        management: { owner: 'zigbee2mqtt', local_actions: false },
    }, { topic: 'zigbee2mqtt/office' });

    assert.equal(model.schema_version, 1);
    assert.equal(model.live_revision, 4);
    assert.equal(model.reference_generation, 7);
    assert.equal(model.live.progress, 28);
    assert.equal(model.live.observed_source, 'zigbee2mqtt');
    assert.equal(model.reference.status, 'fresh');
    assert.equal(model.reference.official_versions.Beta, '1.03');
    assert.equal(model.management.owner, 'zigbee2mqtt');
    assert.equal(model.management.local_actions, false);
    assert.equal(firmware.getReferenceStatus(model.reference), 'ready');
});

test('same-topic reset snapshot cannot replace a newer live revision', () => {
    const firmware = loadFirmwareModule();
    const current = firmware.merge(firmware.createModel('zigbee2mqtt/office'), {
        topic: 'zigbee2mqtt/office',
        live: { revision: 4, state: 'updating', progress: 64, observed_at: 400 },
        reference: { generation: 8, status: 'fresh', official_versions: { Production: '1.00' } },
    }, { topic: 'zigbee2mqtt/office' });

    const delayedSnapshot = firmware.merge(current, {
        topic: 'zigbee2mqtt/office',
        live: { revision: 3, state: 'available', progress: 0, observed_at: 300 },
        reference: { generation: 7, status: 'stale', official_versions: { Production: '0.10' } },
    }, { topic: 'zigbee2mqtt/office', reset: true });

    assert.equal(delayedSnapshot.live_revision, 4);
    assert.equal(delayedSnapshot.live.state, 'updating');
    assert.equal(delayedSnapshot.live.progress, 64);
    assert.equal(delayedSnapshot.reference_generation, 8);
    assert.equal(delayedSnapshot.reference.status, 'fresh');
    assert.equal(delayedSnapshot.reference.official_versions.Production, '1.00');
});

test('older live revision cannot overwrite displayed version details at the same reference generation', () => {
    const firmware = loadFirmwareModule();
    const current = firmware.merge(firmware.createModel('zigbee2mqtt/office'), {
        topic: 'zigbee2mqtt/office',
        live: { revision: 2, installed_version: 200, latest_version: 200 },
        reference: {
            generation: 5,
            status: 'fresh',
            installed_version_detail: { display_version: '2.00' },
            latest_version_detail: { display_version: '2.00' },
        },
    }, { topic: 'zigbee2mqtt/office' });

    const delayed = firmware.merge(current, {
        topic: 'zigbee2mqtt/office',
        live: { revision: 1, installed_version: 100, latest_version: 100 },
        reference: {
            generation: 5,
            status: 'fresh',
            installed_version_detail: { display_version: '1.00' },
            latest_version_detail: { display_version: '1.00' },
        },
    }, { topic: 'zigbee2mqtt/office', reset: true });

    assert.equal(delayed.live_revision, 2);
    assert.equal(delayed.live.installed_version, 200);
    assert.equal(delayed.reference.installed_version_detail.display_version, '2.00');
    assert.equal(delayed.reference.latest_version_detail.display_version, '2.00');
});

test('version details converge after a newer reference arrives with stale live data', () => {
    const firmware = loadFirmwareModule();
    const current = firmware.merge(firmware.createModel('zigbee2mqtt/office'), {
        topic: 'zigbee2mqtt/office',
        live: { revision: 2, installed_version: 200, latest_version: 200 },
        reference: {
            generation: 5,
            status: 'fresh',
            installed_version_detail: { display_version: '2.00' },
            latest_version_detail: { display_version: '2.00' },
        },
    }, { topic: 'zigbee2mqtt/office' });

    const staleLiveNewReference = firmware.merge(current, {
        topic: 'zigbee2mqtt/office',
        live: { revision: 1, installed_version: 100, latest_version: 100 },
        reference: {
            generation: 6,
            status: 'fresh',
            installed_version_detail: { display_version: '1.00' },
            latest_version_detail: { display_version: '1.00' },
        },
    }, { topic: 'zigbee2mqtt/office' });

    assert.equal(staleLiveNewReference.live_revision, 2);
    assert.equal(staleLiveNewReference.reference_generation, 6);
    assert.equal(staleLiveNewReference.reference.installed_version_detail.display_version, '2.00');
    assert.equal(staleLiveNewReference.detail_live_revision, 2);
    assert.equal(staleLiveNewReference.detail_reference_generation, 5);

    const repaired = firmware.merge(staleLiveNewReference, {
        topic: 'zigbee2mqtt/office',
        live: { revision: 2, installed_version: 200, latest_version: 201 },
        reference: {
            generation: 6,
            status: 'fresh',
            installed_version_detail: { display_version: '2.00' },
            latest_version_detail: { display_version: '2.01' },
        },
    }, { topic: 'zigbee2mqtt/office' });

    assert.equal(repaired.live_revision, 2);
    assert.equal(repaired.reference_generation, 6);
    assert.equal(repaired.reference.installed_version_detail.display_version, '2.00');
    assert.equal(repaired.reference.latest_version_detail.display_version, '2.01');
    assert.equal(repaired.detail_live_revision, 2);
    assert.equal(repaired.detail_reference_generation, 6);

    const staleReferenceWithNewerLive = firmware.merge(repaired, {
        topic: 'zigbee2mqtt/office',
        live: { revision: 3, installed_version: 300, latest_version: 300 },
        reference: {
            generation: 5,
            status: 'fresh',
            installed_version_detail: { display_version: '3.00-from-old-reference' },
            latest_version_detail: { display_version: '3.00-from-old-reference' },
        },
    }, { topic: 'zigbee2mqtt/office' });

    assert.equal(staleReferenceWithNewerLive.live_revision, 3);
    assert.equal(staleReferenceWithNewerLive.reference_generation, 6);
    assert.equal(staleReferenceWithNewerLive.reference.installed_version_detail.display_version, '2.00');
    assert.equal(staleReferenceWithNewerLive.detail_live_revision, 2);
    assert.equal(staleReferenceWithNewerLive.detail_reference_generation, 6);
});

test('reference refresh lifecycle advances generations and rejects older or equal delayed states', () => {
    const firmware = loadFirmwareModule();
    const terminalN = firmware.merge(firmware.createModel('zigbee2mqtt/office'), {
        topic: 'zigbee2mqtt/office',
        live: { revision: 2, installed_version: 200 },
        reference: { generation: 5, status: 'fresh', refreshing: false, fetched_at: 500 },
    }, { topic: 'zigbee2mqtt/office' });

    const refreshingNext = firmware.merge(terminalN, {
        topic: 'zigbee2mqtt/office',
        live: { revision: 2, installed_version: 200 },
        reference: { generation: 6, status: 'refreshing', refreshing: true, fetched_at: 500 },
    }, { topic: 'zigbee2mqtt/office' });
    assert.equal(refreshingNext.reference_generation, 6);
    assert.equal(refreshingNext.reference.status, 'refreshing');
    assert.equal(refreshingNext.reference.refreshing, true);

    const terminalNext = firmware.merge(refreshingNext, {
        topic: 'zigbee2mqtt/office',
        live: { revision: 2, installed_version: 200 },
        reference: { generation: 7, status: 'fresh', refreshing: false, fetched_at: 700 },
    }, { topic: 'zigbee2mqtt/office' });
    assert.equal(terminalNext.reference_generation, 7);
    assert.equal(terminalNext.reference.status, 'fresh');
    assert.equal(terminalNext.reference.refreshing, false);
    assert.equal(terminalNext.reference.fetched_at, 700);

    const delayedOlder = firmware.merge(terminalNext, {
        topic: 'zigbee2mqtt/office',
        live: { revision: 2, installed_version: 200 },
        reference: { generation: 6, status: 'refreshing', refreshing: true, fetched_at: 500 },
    }, { topic: 'zigbee2mqtt/office' });
    const delayedEqual = firmware.merge(delayedOlder, {
        topic: 'zigbee2mqtt/office',
        live: { revision: 2, installed_version: 200 },
        reference: { generation: 7, status: 'loading', refreshing: true, fetched_at: null },
    }, { topic: 'zigbee2mqtt/office' });

    assert.equal(delayedEqual.reference_generation, 7);
    assert.equal(delayedEqual.reference.status, 'fresh');
    assert.equal(delayedEqual.reference.refreshing, false);
    assert.equal(delayedEqual.reference.fetched_at, 700);
});

test('a new backend epoch accepts reset counters after an add-on restart', () => {
    const firmware = loadFirmwareModule();
    const beforeRestart = firmware.merge(null, {
        epoch: 'boot-a',
        topic: 'zigbee2mqtt/office',
        live: { revision: 10, state: 'updating', progress: 88, installed_version: 200 },
        reference: {
            generation: 6,
            status: 'fresh',
            installed_version_detail: { display_version: '2.00' },
        },
    });
    assert.equal(beforeRestart.detail_live_revision, 10);
    assert.equal(beforeRestart.detail_reference_generation, 6);

    const afterRestart = firmware.merge(beforeRestart, {
        epoch: 'boot-b',
        topic: 'zigbee2mqtt/office',
        live: { revision: 0, state: 'idle', progress: null },
        reference: { generation: 1, status: 'loading' },
    });

    assert.equal(afterRestart.epoch, 'boot-b');
    assert.equal(afterRestart.live_revision, 0);
    assert.equal(afterRestart.live.state, 'idle');
    assert.equal(afterRestart.reference_generation, 1);
    assert.equal(afterRestart.detail_live_revision, null);
    assert.equal(afterRestart.detail_reference_generation, null);
    assert.equal(firmware.getReferenceStatus(afterRestart.reference), 'refreshing');
});

test('unversioned legacy patches cannot overwrite a versioned live model', () => {
    const firmware = loadFirmwareModule();
    const current = firmware.merge(firmware.createModel('zigbee2mqtt/office'), {
        topic: 'zigbee2mqtt/office',
        live: { revision: 4, state: 'updating', progress: 64 },
        reference: { generation: 8, status: 'fresh', official_versions: { Production: '1.00' } },
    }, { topic: 'zigbee2mqtt/office' });

    const legacy = firmware.merge(current, {
        topic: 'zigbee2mqtt/office',
        payload: {
            update: { state: 'available', progress: 0 },
            official_versions: { Production: '0.10' },
        },
        ts: 9999999999,
    }, { topic: 'zigbee2mqtt/office', devicePayload: true });

    assert.equal(legacy.live_revision, 4);
    assert.equal(legacy.live.state, 'updating');
    assert.equal(legacy.live.progress, 64);
    assert.equal(legacy.reference_generation, 8);
    assert.equal(legacy.reference.official_versions.Production, '1.00');
});

test('new reference generation merges without rolling back independent live state', () => {
    const firmware = loadFirmwareModule();
    const current = firmware.merge(firmware.createModel('zigbee2mqtt/office'), {
        topic: 'zigbee2mqtt/office',
        live: { revision: 9, state: 'updating', progress: 81 },
        reference: { generation: 2, status: 'refreshing', official_versions: { Production: '1.00' } },
    }, { topic: 'zigbee2mqtt/office' });

    const refreshed = firmware.merge(current, {
        topic: 'zigbee2mqtt/office',
        reference: {
            generation: 3,
            status: 'partial',
            official_versions: { Production: '1.00', Beta: '1.03' },
            next_retry_at: 900,
        },
    }, { topic: 'zigbee2mqtt/office' });

    assert.equal(refreshed.live_revision, 9);
    assert.equal(refreshed.live.progress, 81);
    assert.equal(refreshed.reference_generation, 3);
    assert.equal(refreshed.reference.official_versions.Beta, '1.03');
    assert.equal(refreshed.reference.next_retry_at, 900);
    assert.equal(firmware.getReferenceStatus(refreshed.reference), 'partial');
});

test('foreign-topic firmware events cannot leak into the active device', () => {
    const firmware = loadFirmwareModule();
    const current = firmware.merge(firmware.createModel('zigbee2mqtt/office'), {
        topic: 'zigbee2mqtt/office',
        live: { revision: 2, installed_version: 16974080 },
    }, { topic: 'zigbee2mqtt/office' });

    const result = firmware.merge(current, {
        topic: 'zigbee2mqtt/kitchen',
        live: { revision: 99, installed_version: 1 },
    }, { topic: 'zigbee2mqtt/office' });

    assert.equal(result.topic, 'zigbee2mqtt/office');
    assert.equal(result.live_revision, 2);
    assert.equal(result.live.installed_version, 16974080);
});

test('reference status normalizes loading and unavailable legacy shapes', () => {
    const firmware = loadFirmwareModule();
    assert.equal(firmware.getReferenceStatus({ status: 'loading' }), 'refreshing');
    assert.equal(firmware.getReferenceStatus({ refreshing: true }), 'refreshing');
    assert.equal(firmware.getReferenceStatus({ stale: true, official_versions: { Production: '1.00' } }), 'stale');
    assert.equal(firmware.getReferenceStatus({ error: 'offline' }), 'unavailable');
    assert.equal(
        firmware.getReferenceStatus({ status: 'fresh', refreshing: true, stale: true }),
        'refreshing',
        'an in-flight refresh takes precedence over a cached legacy fresh label',
    );
    assert.equal(
        firmware.getReferenceStatus({ status: 'fresh', stale: true }),
        'stale',
        'stale state takes precedence over a cached legacy fresh label',
    );
});
