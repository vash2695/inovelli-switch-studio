const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadLoadDimmingModule() {
    const scriptPath = path.resolve(__dirname, '../../switch_studio/static/js/app_load_dimming.js');
    const source = fs.readFileSync(scriptPath, 'utf8');

    const context = {
        window: {},
        document: {
            createElement: () => ({
                appendChild() {},
                addEventListener() {},
                className: '',
                textContent: '',
                children: [],
                style: {},
            }),
        },
        console,
    };
    context.global = context;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: scriptPath });
    return context.window.SwitchStudioLoadDimming.__test__;
}

test('load dimming timing helpers resolve sync-chain values', () => {
    const api = loadLoadDimmingModule();
    api.setRawValuesForTest({
        dimmingSpeedUpRemote: 25,
        dimmingSpeedUpLocal: 127,
        rampRateOffToOnRemote: 127,
        rampRateOffToOnLocal: 127,
        dimmingSpeedDownRemote: 127,
        dimmingSpeedDownLocal: 127,
        rampRateOnToOffRemote: 127,
        rampRateOnToOffLocal: 127,
    });

    assert.equal(api.getEffectiveTimingValue('dimmingSpeedUpLocal'), 25);
    assert.equal(api.getEffectiveTimingValue('rampRateOffToOnRemote'), 25);
    assert.equal(api.getEffectiveTimingValue('rampRateOffToOnLocal'), 25);
    assert.equal(api.getEffectiveTimingValue('dimmingSpeedDownRemote'), 25);
    assert.equal(api.getEffectiveTimingValue('dimmingSpeedDownLocal'), 25);
    assert.equal(api.getEffectiveTimingValue('rampRateOnToOffRemote'), 25);
    assert.equal(api.getEffectiveTimingValue('rampRateOnToOffLocal'), 25);
});

test('load dimming helpers convert default levels between raw and percent', () => {
    const api = loadLoadDimmingModule();
    assert.equal(api.rawDefaultLevelToPercent(254), 100);
    assert.equal(api.rawDefaultLevelToPercent(127), 50);
    assert.equal(api.percentToRawDefaultLevel(100), 254);
    assert.equal(api.percentToRawDefaultLevel(50), 127);
});

test('load dimming helpers parse and compose level indicator timeout values', () => {
    const api = loadLoadDimmingModule();

    const offState = api.parseIndicatorOption('Stay Off');
    assert.equal(offState.enabled, false);

    const timedState = api.parseIndicatorOption('3 Seconds');
    assert.equal(timedState.enabled, true);
    assert.equal(timedState.seconds, 3);

    const alwaysOnState = api.parseIndicatorOption('Stay On');
    assert.equal(alwaysOnState.enabled, true);
    assert.equal(alwaysOnState.alwaysOn, true);

    assert.equal(api.composeIndicatorValue(false, 4), 'Stay Off');
    assert.equal(api.composeIndicatorValue(true, 4), '4 Seconds');
});

test('linking a timing group immediately locks both values together', () => {
    const api = loadLoadDimmingModule();
    api.setRawValuesForTest({
        dimmingSpeedUpRemote: 25,
        dimmingSpeedUpLocal: 40,
    });

    const state = api.setTimingGroupLinked('dimUp', true, 40);

    assert.equal(state.remoteValue, 40);
    assert.equal(state.localValue, 40);
    assert.equal(state.linked, true);
    assert.equal(api.getEffectiveTimingValue('dimmingSpeedUpRemote'), 40);
    assert.equal(api.getEffectiveTimingValue('dimmingSpeedUpLocal'), 40);
});

test('explicit timing payload preserves other timing groups when one group changes', () => {
    const api = loadLoadDimmingModule();
    api.setRawValuesForTest({
        dimmingSpeedUpRemote: 25,
        dimmingSpeedUpLocal: 127,
        rampRateOffToOnRemote: 127,
        rampRateOffToOnLocal: 127,
        dimmingSpeedDownRemote: 127,
        dimmingSpeedDownLocal: 127,
        rampRateOnToOffRemote: 127,
        rampRateOnToOffLocal: 127,
    });

    const payload = api.getExplicitTimingPayload({
        dimmingSpeedUpRemote: 40,
        dimmingSpeedUpLocal: 40,
    });

    assert.equal(payload.dimmingSpeedUpRemote, 40);
    assert.equal(payload.dimmingSpeedUpLocal, 40);
    assert.equal(payload.dimmingSpeedDownRemote, 25);
    assert.equal(payload.dimmingSpeedDownLocal, 25);
    assert.equal(payload.rampRateOffToOnRemote, 25);
    assert.equal(payload.rampRateOffToOnLocal, 25);
    assert.equal(payload.rampRateOnToOffRemote, 25);
    assert.equal(payload.rampRateOnToOffLocal, 25);
});

test('linked state falls back to unlinked when underlying values diverge', () => {
    const api = loadLoadDimmingModule();
    api.setRawValuesForTest({
        dimmingSpeedUpRemote: 25,
        dimmingSpeedUpLocal: 40,
    });
    api.setLinkPreferenceForTest('dimUp', true);

    const state = api.getTimingGroupUiState('dimUp');

    assert.equal(state.remoteValue, 25);
    assert.equal(state.localValue, 40);
    assert.equal(state.linked, false);
});
