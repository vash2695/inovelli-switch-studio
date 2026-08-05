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
