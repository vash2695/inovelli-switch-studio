const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const templatePath = path.resolve(__dirname, '../../switch_studio/templates/index.html');
const template = fs.readFileSync(templatePath, 'utf8');

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function extractNamedFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} should be present`);
    const signatureEnd = source.indexOf(') {', start);
    assert.ok(signatureEnd >= 0, `${name} should have a function body`);
    const bodyStart = signatureEnd + 2;
    let depth = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = bodyStart; index < source.length; index += 1) {
        const character = source[index];
        const next = source[index + 1];
        if (lineComment) {
            if (character === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (character === '*' && next === '/') {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '/' && next === '/') {
            lineComment = true;
            index += 1;
            continue;
        }
        if (character === '/' && next === '*') {
            blockComment = true;
            index += 1;
            continue;
        }
        if (character === "'" || character === '"' || character === '`') {
            quote = character;
            continue;
        }
        if (character === '{') depth += 1;
        if (character === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    assert.fail(`${name} should have a complete body`);
}

test('header rollback preserves unrelated reports and uses the latest authoritative requested value', () => {
    const context = {
        window: { SwitchStudioState: { getLatestValue: (field) => ({ state: 'ON', brightness: 200 })[field] } },
        basicControlLastKnown: { state: 'OFF', brightness: 200 },
        parseBasicStateValue: (value) => value,
        clampBrightnessRaw: (value) => value,
    };
    vm.createContext(context);
    vm.runInContext(extractNamedFunction(template, 'restoreFailedBasicControl'), context);
    context.restoreFailedBasicControl({ topic: 'a', expected: { state: 'OFF' }, state: 'ON', brightness: 100 }, new Set());
    assert.deepEqual(context.basicControlLastKnown, { state: 'ON', brightness: 200 });
    context.basicControlLastKnown.brightness = 50;
    context.restoreFailedBasicControl({ topic: 'a', expected: { brightness: 50 }, brightness: 100 }, new Set());
    assert.equal(context.basicControlLastKnown.brightness, 200);
    context.basicControlLastKnown.state = 'OFF';
    context.restoreFailedBasicControl({ topic: 'a', expected: { state: 'OFF' }, state: 'ON' }, new Set(['state']));
    assert.equal(context.basicControlLastKnown.state, 'OFF');
});

function createDeviceHydrationHarness() {
    const elements = new Map();
    const authoritative = {};
    const context = {
        window: {
            SwitchStudioState: { syncConfig: (topic, config) => { authoritative[topic] = { ...authoritative[topic], ...config }; } },
            SwitchStudioDevices: { mergeSnapshot() {}, mergeConfig() {} },
        },
        activeDeviceTopic: 'a', dashboardView: { hidden: true }, zoneModule: null, lastCommandId: null,
        occupancyState: { global: null, area1: null, area2: null, area3: null, area4: null },
        deviceZones: { global: null, mmwave_detection_areas: {}, mmwave_interference_areas: {}, mmwave_stay_areas: {} },
        stripIlluminanceVal: {}, nonMmwaveWarning: { style: {} }, configSidebar: { style: {} },
        document: { getElementById: (id) => {
            if (!elements.has(id)) elements.set(id, { classList: { toggle() {} } });
            return elements.get(id);
        } },
        syncBasicControlsFromConfig() {}, applyFirmwareStateUpdate() {}, updateTimestamp() {},
        refreshRadar2dZoneLayoutIfVisible() {}, refreshRadar3dScene() {}, syncCompositeSchemaInputs() {},
        setMapStandbyState() {}, clearTargetsForOccupancyGate() {}, setTargetReportingState() {},
    };
    vm.createContext(context);
    ['parseOccupancyValue', 'setAreaStatusIndicators', 'hasActiveOccupancy', 'parseZ2MArea',
        'applyRawZoneSnapshot', 'hydrateDeviceConfig', 'handleDeviceSnapshot'].forEach((name) => {
        vm.runInContext(extractNamedFunction(template, name), context);
    });
    return { context, elements, authoritative };
}

test('selection snapshots hydrate cached presence and zones through the live configuration path', () => {
    const { context, elements, authoritative } = createDeviceHydrationHarness();
    const area = { width_min: 100, width_max: 200, depth_min: 20, depth_max: 250, height_min: -150, height_max: 400 };
    const config = { occupancy: true, mmwave_area1_occupancy: true, mmwave_detection_areas: { area2: area } };
    context.handleDeviceSnapshot({ topic: 'a', payload: { last_config: config, detection_zones: null } });
    assert.equal(context.occupancyState.global, true);
    assert.equal(context.occupancyState.area1, true);
    assert.equal(elements.get('area1Val').innerText, 'DETECTED');
    assert.equal(context.deviceZones.mmwave_detection_areas.area2.x_min, 100);
    assert.deepEqual(authoritative.a, config);

    context.handleDeviceSnapshot({ topic: 'b', payload: { last_config: { occupancy: false }, detection_zones: [] } });
    assert.equal(context.occupancyState.global, true, 'a background device cannot replace the workspace');
    assert.equal(context.deviceZones.mmwave_detection_areas.area2.x_min, 100);
    context.hydrateDeviceConfig({ topic: 'a', payload: { occupancy: false, mmwave_area1_occupancy: false } });
    assert.equal(context.occupancyState.global, false);
    assert.equal(elements.get('area1Val').innerText, 'CLEAR');
    context.handleDeviceSnapshot({ topic: 'a', payload: { last_config: {}, detection_zones: [] } });
    assert.equal(context.deviceZones.mmwave_detection_areas.area2, null, 'an authoritative empty raw report clears old zones');
    context.setAreaStatusIndicators(2, null);
    assert.equal(elements.get('area2Val').innerText, 'UNKNOWN');
});

test('cached zone events redraw the workspace without confirming a pending maintenance command', () => {
    const { context } = createDeviceHydrationHarness();
    let completions = 0;
    let commandId = 3;
    context.deviceSelect = { value: 'a' };
    context.updateZoneMaintenanceCommandState = () => {};
    context.zoneModule = { getPendingCommandId: () => commandId, handleInterferenceZones: () => { completions += 1; } };
    for (const [eventName, actionId] of [['interference_zones', 3], ['detection_zones', 4], ['stay_zones', 5]]) {
        commandId = actionId;
        const start = template.indexOf(`socket.on('${eventName}', function(msg)`);
        assert.ok(start >= 0);
        const source = template.slice(start).replace('function(msg)', 'function receiveZones(msg)');
        vm.runInContext(extractNamedFunction(source, 'receiveZones'), context);
        const previous = completions;
        context.receiveZones({ topic: 'a', payload: [], snapshot: true });
        assert.equal(completions, previous, 'cached values cannot acknowledge a newly sent command');
        context.receiveZones({ topic: 'b', payload: [] });
        assert.equal(completions, previous, 'another device cannot acknowledge the command');
        context.receiveZones({ topic: 'a', payload: [] });
        assert.equal(completions, previous + 1);
    }
});

test('maintenance emission captures device and request identity for result correlation', () => {
    const emitted = [];
    const context = {
        window: { confirm: () => true }, activeDeviceTopic: 'a', basicControlRequestCounter: 0,
        isActiveDeviceCommandReady: () => true, getDeviceDisplayName: (topic) => `Device ${topic}`,
        updateZoneMaintenanceCommandState() {},
        zoneModule: { getPendingCommandId: () => null, confirmZoneMaintenanceCommand: () => true,
            setPendingCommand: (action, command) => emitted.push({ pending: command }) },
        socket: { emit: (event, command) => emitted.push({ event, command }) },
    };
    vm.createContext(context);
    vm.runInContext(extractNamedFunction(template, 'sendCommand'), context);
    context.sendCommand(3);
    context.activeDeviceTopic = 'b';
    assert.equal(emitted[1].event, 'send_command');
    assert.equal(emitted[1].command.topic, 'a');
    assert.equal(emitted[1].command.action_id, 3);
    assert.ok(emitted[1].command.request_id);
    assert.equal(emitted[0].pending, emitted[1].command);
});

function createRadarDisplayHeightHarness(options) {
    const opts = options || {};
    const functionNames = [
        'normalizeRadarDisplayHeightSnapshot',
        'clearActiveLegacyRadarDisplayHeight',
        'acceptRadarDisplayHeightSnapshot',
        'createRadarDisplayHeightRequestId',
        'emitRadarDisplayHeightSave',
        'maybeOfferLegacyRadarDisplayHeight',
        'handleRadarDisplayHeightResult',
    ];
    const functions = functionNames.map((name) => extractNamedFunction(template, name)).join('\n');
    const context = {
        window: {
            SwitchStudioState: {
                showToast() {},
            },
        },
        console,
    };
    vm.createContext(context);
    vm.runInContext(`
        function field(value) {
            return {
                value: String(value),
                attributes: {},
                setAttribute(name, next) { this.attributes[name] = String(next); },
                removeAttribute(name) { delete this.attributes[name]; },
                focus() {},
            };
        }
        let chartZMin = -600;
        let chartZMax = 600;
        let radarDisplayHeightState = {
            epoch: null,
            revision: -1,
            configured: false,
            readOnly: false,
            hydrated: false,
            connectionGeneration: 1,
            acceptedConnectionGeneration: -1,
        };
        let radarDisplayHeightPending = null;
        let radarDisplayHeightDraftDirty = false;
        const radarDisplayHeightLegacyOffers = new Set();
        let activeDeviceTopic = ${JSON.stringify(opts.activeDeviceTopic || null)};
        let controllerInitialized = false;
        const emitted = [];
        const cleared = [];
        const statuses = [];
        const vizZMin = field(-600);
        const vizZMax = field(600);
        const socket = {
            connected: true,
            emit(name, payload) { emitted.push({ name, payload }); },
        };
        const radar3dModule = {
            loadLegacyDisplayHeightBounds(topic) {
                const seeds = ${JSON.stringify(opts.legacySeeds || {})};
                return Object.prototype.hasOwnProperty.call(seeds, topic) ? seeds[topic] : null;
            },
            clearLegacyDisplayHeightBounds(topic) {
                cleared.push(topic);
                return true;
            },
        };
        function setRadarDisplayHeightInputs(bounds = null) {
            const next = bounds || { zMin: chartZMin, zMax: chartZMax };
            vizZMin.value = String(next.zMin);
            vizZMax.value = String(next.zMax);
        }
        function setRadarSharedHeightStatus(message) { statuses.push(String(message || '')); }
        function updateRadarSharedHeightControlState() {}
        function refreshRadar3dScene() {}
        ${functions}
        window.radarHeightTest = {
            acceptRadarDisplayHeightSnapshot,
            emitRadarDisplayHeightSave,
            handleRadarDisplayHeightResult,
            maybeOfferLegacyRadarDisplayHeight,
            beginConnection() {
                radarDisplayHeightState.connectionGeneration += 1;
                radarDisplayHeightState.acceptedConnectionGeneration = -1;
                radarDisplayHeightState.hydrated = false;
                radarDisplayHeightPending = null;
            },
            setDraft(zMin, zMax) {
                vizZMin.value = String(zMin);
                vizZMax.value = String(zMax);
                radarDisplayHeightDraftDirty = true;
            },
            state: () => JSON.parse(JSON.stringify(radarDisplayHeightState)),
            pending: () => radarDisplayHeightPending && JSON.parse(JSON.stringify(radarDisplayHeightPending)),
            chart: () => ({ zMin: chartZMin, zMax: chartZMax }),
            inputs: () => ({ zMin: vizZMin.value, zMax: vizZMax.value }),
            emitted,
            cleared,
            statuses,
        };
    `, context);
    return context.window.radarHeightTest;
}

test('header keeps an Inovelli anchor while adapting its navigation and product branding', () => {
    assert.match(
        template,
        /<div class="header-brand">\s*<button class="header-back" id="headerBackButton" type="button" aria-label="Back to all devices">[\s\S]*?<img class="header-logo"[\s\S]*?<img class="header-wordmark"[^>]*alt="Inovelli">[\s\S]*?<h1 class="studio-title">Switch Studio<\/h1>/
    );
    assert.match(template, /\.header-brand\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex:\s*0 0 auto;[\s\S]*?\}/);
    assert.match(template, /body\.dashboard-active \.header-back\s*\{\s*display:\s*none;\s*\}/);
    assert.match(template, /body:not\(\.dashboard-active\) \.header-logo,\s*body:not\(\.dashboard-active\) \.studio-title\s*\{\s*display:\s*none;\s*\}/);
    assert.match(template, /<h1 class="device-page-title" id="devicePageTitle">Device<\/h1>/);
    assert.match(template, /body\.dashboard-active \.device-page-title\s*\{\s*display:\s*none;\s*\}/);
    assert.match(template, /devicePageTitle\.textContent = getDeviceDisplayName\(topic\);/);
    assert.match(template, /body\.dashboard-active \.header-controls\s*\{\s*display:\s*none;\s*\}/);
    assert.doesNotMatch(template, /@media \(max-width:\s*900px\)[\s\S]*?\.header-brand\s*\{\s*display:\s*none;/);
    assert.match(template, /class="dashboard-summary-row"/);
    assert.doesNotMatch(template, /Your switches, at a glance/);
    assert.doesNotMatch(template, /class="dashboard-description"/);
});

test('back button and All Devices route through the same guarded device selection flow', () => {
    assert.match(template, /const headerBackButton = document\.getElementById\('headerBackButton'\);/);
    assert.match(template, /headerBackButton\.addEventListener\('click', \(\) => requestDeviceSelection\(''\)\);/);
    assert.match(template, /deviceSelect\.addEventListener\('change', function\(\)\s*\{\s*requestDeviceSelection\(this\.value\);\s*\}\);/);
    assert.doesNotMatch(template, /headerBackButton\.addEventListener\([^\n]*showDashboardView/);

    const selectionStart = template.indexOf('function requestDeviceSelection(nextTopic, options)');
    const selectionEnd = template.indexOf('function applyLegacyLayout()', selectionStart);
    assert.ok(selectionStart >= 0 && selectionEnd > selectionStart, 'device selection function should be present');
    const selectionSource = template.slice(selectionStart, selectionEnd);
    const guardIndex = selectionSource.indexOf('const guard = shouldConfirmDeviceChange(currentTopic);');
    const dashboardIndex = selectionSource.indexOf('if (!normalizedNext)');
    assert.ok(guardIndex >= 0, 'navigation should inspect unsaved work');
    assert.ok(dashboardIndex > guardIndex, 'dashboard navigation should happen after the unsaved-work guard');
    assert.match(selectionSource, /: 'Return to all devices\?';/);
    assert.match(selectionSource, /discardDevice\(currentTopic, \{ silent: true \}\)/);
    assert.match(selectionSource, /if \(isEditingZone\) \{[\s\S]*?zoneWriteTracker\.discardRetryable\(currentTopic, editingTarget\);[\s\S]*?endZoneEdit\(\);/);
});

test('zone writes preserve exact retryable drafts through device confirmation lifecycle', () => {
    assert.match(template, /const zoneWriteTracker = window\.SwitchStudioZones[\s\S]*?createZoneWriteTracker\(\)/);

    const applyStart = template.indexOf('function applyZoneEdit()');
    const deleteStart = template.indexOf('function deleteZone()', applyStart);
    const cancelStart = template.indexOf('function cancelZoneEdit()', deleteStart);
    assert.ok(applyStart >= 0 && deleteStart > applyStart && cancelStart > deleteStart);
    const applySource = template.slice(applyStart, deleteStart);
    const deleteSource = template.slice(deleteStart, cancelStart);
    assert.match(applySource, /const submittedDraft = JSON\.parse\(JSON\.stringify\(draftZoneConfig\)\);/);
    assert.match(applySource, /zoneWriteTracker\.begin\(\{[\s\S]*?requestId: zoneRequestId,[\s\S]*?topic: activeDeviceTopic,[\s\S]*?target: editingTarget,[\s\S]*?draft: submittedDraft,[\s\S]*?isDelete: false/);
    assert.match(applySource, /zoneUpdatePending\.set\(zoneRequestId,[\s\S]*?draft: submittedDraft[\s\S]*?socket\.emit\('update_parameter'/);
    assert.match(deleteSource, /window\.confirm\(`Delete \$\{zoneLabel\} from \$\{deviceName\}\?/);
    assert.match(deleteSource, /zoneWriteTracker\.begin\(\{[\s\S]*?target: selectedTarget,[\s\S]*?isDelete: true/);

    const resultStart = template.indexOf("result.action === 'update_parameter'");
    const resultEnd = template.indexOf("if (window.SwitchStudioState && typeof window.SwitchStudioState.handleCommandResult", resultStart);
    const resultSource = template.slice(resultStart, resultEnd);
    assert.match(resultSource, /zoneWriteTracker\.transition\(result\)/);
    assert.match(resultSource, /result\.status === 'sent'[\s\S]*?endZoneEdit\(\);[\s\S]*?awaiting device confirmation/);
    assert.match(resultSource, /result\.status === 'confirmed'[\s\S]*?zoneUpdatePending\.delete\(result\.request_id\)/);
    assert.match(resultSource, /result\.status === 'not_confirmed' \|\| result\.status === 'error'[\s\S]*?restoreRetryableZoneDraft\(requestTopic, zoneRequest\.target\)/);
    assert.match(resultSource, /Zone update not confirmed; exact draft restored for retry/);
    assert.match(resultSource, /Zone deletion not confirmed; no draft was restored/);

    const disconnectStart = template.indexOf("socket.on('disconnect'");
    const disconnectEnd = template.indexOf("socket.on('connect_error'", disconnectStart);
    const disconnectSource = template.slice(disconnectStart, disconnectEnd);
    const failIndex = disconnectSource.indexOf("zoneWriteTracker.failPending('disconnected')");
    const clearIndex = disconnectSource.indexOf('zoneUpdatePending.clear()');
    assert.ok(failIndex >= 0 && clearIndex > failIndex, 'disconnect must recover immutable drafts before clearing request UI state');
    assert.match(disconnectSource, /restoreRetryableZoneDraft\(activeInterruptedWrite\.topic, activeInterruptedWrite\.target\)/);

    const restoreStart = template.indexOf('function restoreRetryableZoneDraft(topic, target)');
    const startEdit = template.indexOf('function startZoneEdit()', restoreStart);
    const restoreSource = template.slice(restoreStart, startEdit);
    assert.match(restoreSource, /zoneWriteTracker\.getRetryable\(topic, target\)/);
    assert.match(restoreSource, /openZoneDraft\(retryable\.target, retryable\.draft\)/);
    assert.match(template, /showWorkspaceView\(normalizedNext\);[\s\S]*?restoreRetryableZoneDraft\(normalizedNext\);/);
    assert.match(template.slice(cancelStart), /zoneWriteTracker\.discardRetryable\(activeDeviceTopic, editingTarget\);[\s\S]*?endZoneEdit\(\);/);
});

test('destructive zone maintenance commands require named confirmation and block duplicates', () => {
    assert.match(template, /id="btnZoneCommandAutoConfig" data-zone-maintenance-command="1"/);
    assert.match(template, /id="btnZoneCommandClearInterference" data-zone-maintenance-command="3"/);
    assert.match(template, /id="btnZoneCommandResetDetection" data-zone-maintenance-command="4"/);
    assert.match(template, /id="btnZoneCommandClearStay" data-zone-maintenance-command="5"/);

    const sendStart = template.indexOf('function sendCommand(actionId)');
    const sendEnd = template.indexOf("configSidebar.addEventListener('change'", sendStart);
    const sendSource = template.slice(sendStart, sendEnd);
    const pendingGuard = sendSource.indexOf('if (pendingCommandId !== null)');
    const confirmation = sendSource.indexOf('confirmZoneMaintenanceCommand(actionId, deviceName, window.confirm.bind(window))');
    const emit = sendSource.indexOf("socket.emit('send_command', command)");
    assert.ok(pendingGuard >= 0 && confirmation > pendingGuard && emit > confirmation);
    assert.match(sendSource, /if \(!approved\) \{[\s\S]*?Canceled \$\{actionLabel\} for \$\{deviceName\}[\s\S]*?return;/);
    assert.match(sendSource, /setPendingCommand\(actionId, command\)[\s\S]*?updateZoneMaintenanceCommandState\(\);[\s\S]*?socket\.emit\('send_command'/);
    assert.match(template, /socket\.on\('disconnect',[\s\S]*?clearPendingCommand\(\)[\s\S]*?updateZoneMaintenanceCommandState\(\)/);
    assert.match(template, /onPendingCommandChange:\s*\(\)\s*=>\s*updateZoneMaintenanceCommandState\(\)/);
    assert.match(template, /function updateZoneMaintenanceCommandState\(\)[\s\S]*?pendingCommandId !== null[\s\S]*?button\.disabled = disabled/);
});

test('zone editor presents compact family guidance without a write path', () => {
    assert.match(template, /<script src="\{\{ ingress_path \}\}\/static\/js\/app_zone_guidance\.js"><\/script>[\s\S]*?<script src="\{\{ ingress_path \}\}\/static\/js\/app_zones\.js"><\/script>/);
    assert.match(template, /<div class="panel-lede" id="zoneEditorLede">Choose a zone to draw or edit\. Selection alone does not write to the switch\. Use \? for zone-type guidance\.<\/div>/);
    assert.match(template, /<div class="zone-target-label-row">\s*<label for="zoneEditorSelect">Zone to edit:<\/label>\s*<button[^>]*id="zoneTypeGuidanceToggle"/);
    assert.match(template, /id="zoneEditorSelect" aria-describedby="zoneCoordinateHint"/);
    assert.match(template, /<button[^>]*class="zone-guidance-toggle"[^>]*id="zoneTypeGuidanceToggle"[^>]*type="button"[^>]*aria-expanded="false"[^>]*aria-controls="zoneTypeGuidance"[^>]*>\?<\/button>/);
    assert.match(template, /<optgroup label="Detection areas — active presence">/);
    assert.match(template, /Detection Area 1 \(Default \/ Basic Range\)/);
    assert.match(template, /<optgroup label="Stay areas — stationary presence">/);
    assert.match(template, /<optgroup label="Interference areas — ignored regions">/);
    const guidanceTag = template.match(/<aside\b[^>]*id="zoneTypeGuidance"[^>]*>/);
    assert.ok(guidanceTag, 'zone guidance should use an aside landmark');
    assert.match(guidanceTag[0], /aria-labelledby="zoneTypeGuidanceTitle"/);
    assert.match(guidanceTag[0], /\shidden(?:\s|>)/);
    assert.doesNotMatch(guidanceTag[0], /\srole=|aria-live=|aria-atomic=/);
    assert.match(template, /id="zoneTypeGuidanceTitle">Detection Areas<\/h3>/);
    assert.match(template, /Basic Range X\/Y\/Z controls configure Detection Area 1/);
    assert.match(template, /href="https:\/\/help\.inovelli\.com\/en\/articles\/12773613-blue-series-mmwave-presence-dimmer-switch-advanced-mmwave-configuration" target="_blank" rel="noopener noreferrer"/);
    assert.match(template, /id="zoneTypeGuidanceCommunityLink" href="https:\/\/community\.inovelli\.com\/t\/presence-area-configuration-best-practice\/20933" target="_blank" rel="noopener noreferrer"[\s\S]*?id="zoneTypeGuidanceCommunityLinkLabel">Community area setup<\/span>/);
    assert.match(template, /window\.SwitchStudioZoneGuidance\.init\(\{ selectEl: zoneEditorSelect \}\)/);
    assert.match(template, /Target dots show raw radar coordinates and may appear outside configured Detection Areas[\s\S]*?inside an active Detection Area and outside every Interference Area/);
    assert.match(template, /<label[^>]*for="vizToggleDetection1"[^>]*>Area 1 \(Default \/ Basic Range\)<\/label>/);

    for (const id of ['editXMin', 'editXMax', 'editYMin', 'editYMax', 'editZMin', 'editZMax']) {
        assert.match(template, new RegExp(`<label for="${id}">[^<]+<\\/label><input type="number" id="${id}" aria-describedby="zoneEditHint"`));
    }
    assert.match(template, /Apply Changes sends this zone immediately/);
    assert.match(template, /These commands run immediately on the sensor; they are not staged with other settings/);
    assert.match(template, /id="btnZoneCommandAutoConfig"[^>]*aria-describedby="zoneAutoConfigHelp"/);
    assert.match(template, /id="btnZoneCommandClearInterference"[^>]*aria-describedby="zoneClearInterferenceHelp"/);
    assert.match(template, /id="btnZoneCommandResetDetection"[^>]*aria-describedby="zoneResetDetectionHelp"/);
    assert.match(template, /id="btnZoneCommandClearStay"[^>]*aria-describedby="zoneClearStayHelp"/);
    assert.match(template, /write Interference Area 1 \(the first interference slot\)[\s\S]*?may replace that slot's existing coordinates/);
    assert.match(template, /mmWaveRoomSizePreset:\s*'Sets predefined dimensions for Detection Area 1/);
    assert.match(template, /mmWaveTargetInfoReport:\s*'Streams live target coordinates up to once per second[\s\S]*?increases Zigbee traffic/);
    assert.match(template, /\.zones-pane #zoneEditorSelect,[\s\S]*?min-height:\s*44px/);
    assert.match(template, /\.zone-guidance-toggle\s*\{[\s\S]*?width:\s*30px;[\s\S]*?height:\s*30px;/);
    const labelRowRule = template.match(/\.zone-target-label-row\s*\{([^}]*)\}/);
    assert.ok(labelRowRule, 'zone label and help button need a compact grouping rule');
    assert.match(labelRowRule[1], /display:\s*flex/);
    assert.match(labelRowRule[1], /align-items:\s*center/);
    assert.match(labelRowRule[1], /gap:\s*8px/);
    assert.doesNotMatch(labelRowRule[1], /justify-content:\s*space-between/);
    assert.match(template, /\.input-row\.zone-target-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)[\s\S]*?\.zone-target-row #zoneEditorSelect\s*\{[\s\S]*?width:\s*100%[\s\S]*?max-width:\s*none/);
    assert.match(template, /\.zone-status-inline \.panel-lede\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1/);
    assert.match(template, /const helpId = button\.dataset\.zoneHelpId \|\| button\.getAttribute\('aria-describedby'\)[\s\S]*?pendingCommandId !== null \? 'commandLog'[\s\S]*?button\.setAttribute\('aria-describedby', describedBy\)/);

    const selectionGuard = template.indexOf("input.id.startsWith('zoneEditor')");
    const delegatedEmit = template.indexOf("socket.emit('update_parameter'", selectionGuard);
    assert.ok(selectionGuard >= 0 && delegatedEmit > selectionGuard, 'zone guidance selection must remain ahead of the generic write path');
});

test('firmware workspace is informative and delegates every OTA action to Zigbee2MQTT', () => {
    assert.match(template, /id="firmwareSectionTitle">Firmware Information</);
    assert.match(template, /Installed switch firmware/);
    assert.match(template, /Inovelli Production/);
    assert.match(template, /Inovelli Beta/);
    assert.match(template, /Zigbee2MQTT catalog/);
    assert.match(template, /Switch Studio does not check, schedule, install, or downgrade firmware/);
    assert.match(template, /href="https:\/\/www\.zigbee2mqtt\.io\/information\/ota_updates\.html" target="_blank" rel="noopener noreferrer"/);
    assert.match(template, /id="firmwareProgressBar" role="progressbar"[^>]*aria-valuemin="0"[^>]*aria-valuemax="100"/);
    assert.match(template, /id="firmwareStatusMessage" role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(template, /id="firmwareReferenceStatus" role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(template, /mmWave Firmware Version[\s\S]*sensor module/);
    assert.doesNotMatch(template, /id="btnFirmware(?:Check|Install)"/);
    assert.doesNotMatch(template, /socket\.emit\(['"](?:check_firmware_update|start_firmware_update)['"]/);
    assert.doesNotMatch(template, /result\.action === ['"](?:check_firmware_update|start_firmware_update)['"]/);
    assert.doesNotMatch(template, /firmwareResponseTimer|FIRMWARE_RESPONSE_TIMEOUT_MS|handleFirmwareCheckClick|handleFirmwareInstallClick/);
});

test('firmware listeners merge topic-scoped passive state and reference generations', () => {
    assert.match(template, /socket\.on\('firmware_status',[\s\S]*?if \(msg\.topic !== deviceSelect\.value\) return;[\s\S]*?applyFirmwareStateUpdate\(msg, \{ topic: msg\.topic \}\)/);
    assert.match(template, /socket\.on\('firmware_reference_status',[\s\S]*?if \(msg\.topic && msg\.topic !== activeDeviceTopic\) return;[\s\S]*?applyFirmwareStateUpdate\(msg, \{ topic: activeDeviceTopic \}\)/);
    assert.match(template, /applyFirmwareStateUpdate\([\s\S]*?\{ topic: msg\.topic, payload: snapshotFirmware, ts: msg\.ts \},[\s\S]*?\{ reset: true, topic: msg\.topic \}/);
    assert.match(template, /window\.SwitchStudioFirmware\.merge\(firmwareStateModel, payload,[\s\S]*?topic/);
});

test('device-only header controls stay available without redundant status actions', () => {
    assert.match(template, /<select id="deviceSelect"/);
    assert.equal((template.match(/id="deviceSelect"/g) || []).length, 1, 'device selector should not be duplicated');
    assert.match(template, /grid-template-areas:\s*"brand device"\s*"quick quick";/);
    assert.match(template, /@media \(max-width: 900px\)[\s\S]*?\.header-controls\s*\{\s*display:\s*contents;/);
    assert.match(template, /@media \(max-width: 900px\)[\s\S]*?\.header-quick-controls\s*\{[\s\S]*?grid-area:\s*quick;/);
    assert.doesNotMatch(template, /id="connectionChip"/);
    assert.doesNotMatch(template, /id="connectionText"/);
    assert.doesNotMatch(template, /id="btnForceSync"/);
    assert.doesNotMatch(template, /Quick control confirmed/);
});

test('mobile workspace navigation uses one accessible tab disclosure instead of duplicate chips', () => {
    assert.match(
        template,
        /<nav class="workspace-nav" id="workspaceNav" aria-label="Device configuration sections" hidden>[\s\S]*?<h2 class="mobile-tab-title" id="mobileTabTitle">Presence & Zones<\/h2>[\s\S]*?<button class="mobile-tab-menu-button" id="mobileTabMenuButton" type="button" aria-label="Open section menu" aria-controls="tabBar" aria-expanded="false">/
    );
    assert.equal((template.match(/data-tab-target=/g) || []).length, 6, 'top-level tabs should have one button each');
    assert.match(template, /\.mobile-tab-menu-button\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/);
    assert.match(template, /@media \(max-width: 900px\)[\s\S]*?\.tab-bar\s*\{[\s\S]*?display:\s*none;[\s\S]*?position:\s*absolute;/);
    assert.match(template, /\.workspace-nav\.mobile-menu-open \.tab-bar\s*\{\s*display:\s*grid;/);
    assert.match(template, /mobileNav:\s*workspaceNav,[\s\S]*?mobileTitle:\s*mobileTabTitle,[\s\S]*?mobileToggle:\s*mobileTabMenuButton/);
    assert.match(template, /window\.SwitchStudioTabs\.closeMobileMenu\(\{ restoreFocus: false \}\);/);
    assert.match(template, /if \(workspaceNav\) workspaceNav\.hidden = true;/);
    assert.match(template, /if \(workspaceNav\) workspaceNav\.hidden = !SWITCH_STUDIO_UI_ENABLED;/);
});

test('device header percentage input is locked to a three-digit control width', () => {
    const rule = template.match(/input\.quick-brightness-input\s*\{([\s\S]*?)\}/);
    assert.ok(rule, 'quick brightness input rule should exist');
    assert.match(rule[1], /width:\s*50px;/);
    assert.match(rule[1], /min-width:\s*50px;/);
    assert.match(rule[1], /max-width:\s*50px;/);
    assert.match(rule[1], /flex:\s*0 0 50px;/);
    assert.match(rule[1], /font-variant-numeric:\s*tabular-nums;/);
});

test('LED visual editor integrates effects while preserving schema-driven fallback', () => {
    assert.match(template, /<div id="ledEditorRoot" class="led-editor-mount"><\/div>/);
    assert.match(template, /<div id="schemaLedFields" class="schema-fields-shell">/);

    const stateScriptIndex = template.indexOf('/static/js/app_state.js');
    const ledScriptIndex = template.indexOf('/static/js/app_led.js');
    const inlineBootstrapIndex = template.indexOf('const INGRESS_PATH =');
    assert.ok(stateScriptIndex >= 0, 'state module should be loaded');
    assert.ok(ledScriptIndex > stateScriptIndex, 'LED editor should load after state');
    assert.ok(ledScriptIndex < inlineBootstrapIndex, 'LED editor should load before bootstrap');

    assert.match(template, /window\.SwitchStudioLed\.init\(\{[\s\S]*?containerEl:\s*ledEditorRoot,[\s\S]*?stateApi:\s*window\.SwitchStudioState[\s\S]*?isCommandReady:[\s\S]*?sendImmediateEffect:/);
    assert.match(template, /window\.SwitchStudioLed\.setSchemaModel\(schemaModel\);/);
    assert.match(template, /window\.SwitchStudioLed\.handlesField\(field\)/);
    assert.match(template, /window\.SwitchStudioLed\.resetForDeviceChange\(\);/);
    assert.match(template, /window\.SwitchStudioLed\.setActiveDevice\(normalizedNext\);/);
    assert.match(template, /window\.SwitchStudioLed\.setVisible\(/);
    assert.match(template, /window\.SwitchStudioLed\.syncConfig\(config\);/);
    assert.match(template, /function sendLedEffectImmediate\(param, payload\)/);
    assert.match(template, /function validateLedEffectPayload\(param, payload\)/);

    assert.match(template, /const ledFields = buckets\.led\.filter/);
    assert.match(template, /renderSchemaFieldCollection\(schemaLedFields, ledFields/);
    assert.match(template, /led_effect:\s*'LED Effect \(All LEDs\)'/);
    assert.match(template, /individual_led_effect:\s*'LED Effect \(Single LED\)'/);
});

test('LED switch stays centered in its pane while tablet editors stack instead of overlaying it', () => {
    const stageRule = template.match(/\.led-switch-stage\s*\{([\s\S]*?)\}/);
    const baseArtRule = template.match(/\.led-switch-art\s*\{([\s\S]*?)\}/);
    assert.ok(stageRule, 'base LED switch stage rule should exist');
    assert.ok(baseArtRule, 'base LED switch art rule should exist');
    assert.match(stageRule[1], /display:\s*flex;/);
    assert.match(stageRule[1], /justify-content:\s*center;/);
    assert.match(baseArtRule[1], /margin:\s*0;/);

    const artRules = Array.from(template.matchAll(/\.led-switch-art\s*\{([\s\S]*?)\}/g));
    assert.ok(artRules.length >= 2, 'base and phone LED art rules should be present');
    artRules.forEach((match) => {
        assert.doesNotMatch(match[1], /margin-left\s*:/, 'no breakpoint may offset the switch toward one side');
    });
    assert.doesNotMatch(
        template,
        /\.led-editor-layout\.has-segment-editor \.led-switch-(?:stage|art)\s*\{[\s\S]*?(?:justify-content:\s*flex-start|margin-left\s*:)/,
        'opening a segment editor must not displace the switch from the stage center',
    );

    const responsiveStart = template.indexOf('@media (max-width: 1180px)');
    const tabletStart = template.indexOf('@media (min-width: 721px) and (max-width: 1180px)');
    const phoneStart = template.indexOf('@media (max-width: 720px)', tabletStart);
    const reducedMotionStart = template.indexOf('@media (prefers-reduced-motion: reduce)', phoneStart);
    assert.ok(responsiveStart >= 0 && tabletStart > responsiveStart && phoneStart > tabletStart);
    const responsiveCss = template.slice(responsiveStart, tabletStart);
    const tabletCss = template.slice(tabletStart, phoneStart);
    const phoneCss = template.slice(phoneStart, reducedMotionStart);

    assert.match(responsiveCss, /\.led-switch-stage\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*650px;[\s\S]*?margin:\s*0 auto;/);
    assert.match(tabletCss, /\.led-editor-layout\.has-segment-editor \.led-global-panel\s*\{\s*display:\s*none;/);
    assert.match(
        tabletCss,
        /\.led-segment-popover\s*\{[\s\S]*?position:\s*relative;[\s\S]*?grid-column:\s*1;[\s\S]*?grid-row:\s*2;[\s\S]*?top:\s*auto;[\s\S]*?right:\s*auto;[\s\S]*?justify-self:\s*center;[\s\S]*?width:\s*min\(650px, 100%\);/,
    );
    assert.doesNotMatch(tabletCss, /\.led-segment-popover\s*\{[\s\S]*?position:\s*absolute;/);
    assert.match(phoneCss, /\.led-switch-art\s*\{[\s\S]*?margin:\s*0 auto;/);
    assert.match(phoneCss, /\.led-segment-popover\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*auto 10px/);

    const basePopoverRule = template.slice(0, responsiveStart).match(/\.led-segment-popover\s*\{([\s\S]*?)\}/);
    assert.ok(basePopoverRule);
    assert.match(basePopoverRule[1], /position:\s*relative;/);
    assert.match(basePopoverRule[1], /grid-column:\s*2;/);
    assert.match(basePopoverRule[1], /grid-row:\s*1;/);
});

test('radar shell keeps the full Cartesian 2D surface beside one accessible 3D scene', () => {
    assert.match(
        template,
        /<h2>Live Radar<\/h2>[\s\S]*?<fieldset class="radar-view-switch" aria-label="Radar view" aria-describedby="radarViewDescription">[\s\S]*?id="radarView2d"[\s\S]*?id="radarView3d"/
    );
    assert.equal((template.match(/id="chart"/g) || []).length, 1, 'the canonical 2D editor surface should remain singular');
    assert.equal((template.match(/id="chart3d"/g) || []).length, 1, 'the 3D visualization surface should be singular');
    assert.match(template, /id="chart3d"[^>]*aria-label="Top-down live presence radar map with targets, zones, and sensor field of view/);
    assert.match(template, /id="radarResetView" type="button" hidden>Reset view<\/button>/);
    assert.match(template, /id="radar3dLegend" aria-label="Live radar legend" hidden/);
    assert.match(template, /FOV 120° \/ 150°/);
    assert.match(template, /Axes: X width · Y depth · Z height \(cm\)/);
    assert.match(template, /id="radar3dInteractionToggle" type="button" aria-controls="chart3d" aria-pressed="false" hidden>Explore 3D<\/button>/);
    assert.match(template, /@media \(max-width: 700px\), \(hover: none\) and \(pointer: coarse\)[\s\S]*?\.radar-interaction-toggle:not\(\[hidden\]\)/);
    assert.match(template, /full-size top-down Cartesian map in 2D and a fixed-center perspective camera in 3D\.[\s\S]*?Zone drawing and editing stay in the Cartesian 2D view\.[\s\S]*?informational sensor field-of-view envelopes span the visible scene height; configured detection, stay, and interference zones retain their exact heights\./);
    assert.match(template, /3D fixed-center view · Reference FOV spans the visible height/);

    const zonesScriptIndex = template.indexOf('/static/js/app_zones.js');
    const radarScriptIndex = template.indexOf('/static/js/app_radar3d.js');
    const inlineBootstrapIndex = template.indexOf('const INGRESS_PATH =');
    assert.ok(zonesScriptIndex >= 0, 'zone model should be loaded');
    assert.ok(radarScriptIndex > zonesScriptIndex, '3D controller should load after the shared zone model');
    assert.ok(radarScriptIndex < inlineBootstrapIndex, '3D controller should load before bootstrap');

    assert.match(template, /window\.SwitchStudioRadar3D\.init\(\{[\s\S]*?chart2dEl:\s*chartElement,[\s\S]*?chart3dEl:\s*chart3dElement,[\s\S]*?zonesApi:\s*zoneModule/);
    assert.match(template, /radar3dModule\.setActiveDevice\(normalizedNext\);/);
    assert.match(template, /radar3dModule\.resetForDeviceChange\(\);/);
    assert.match(template, /radar3dModule\.setEditing\(true\);/);
    assert.match(template, /radar3dModule\.setEditing\(false\);/);
    assert.match(template, /radar3dModule\.setSceneModel\(buildRadar3dSceneModel\(\)\);/);
    assert.match(template, /mmWaveHeightMin:\s*'z_min',[\s\S]*?mmWaveHeightMax:\s*'z_max'/);
    assert.doesNotMatch(template, /function getConfiguredRadarHeightBounds\(/);
    assert.doesNotMatch(template, /getTargetSnapshot\('height-bounds'\)/);
    assert.doesNotMatch(template, /getRadar3dAxisHeightBounds/);
    assert.match(template, /bounds:\s*\{[\s\S]*?zMin:\s*chartZMin,[\s\S]*?zMax:\s*chartZMax/);
    assert.doesNotMatch(template, /fovBounds:\s*fovHeightBounds/);
    assert.match(template, /zoneModule\.mapRawZonesByAreaId\(zones\)/);
    assert.match(template, /function isRadar2dSurfaceVisible\(\)[\s\S]*?!chartElement\.hidden[\s\S]*?getClientRects\(\)\.length/);
    assert.match(template, /shouldRender2d:\s*\(\)\s*=>\s*isRadar2dSurfaceVisible\(\)/);
    assert.match(template, /if \(!usesSceneSurface && !is3d && isRadar2dSurfaceVisible\(\)\)[\s\S]*?renderChartForCurrentMode\(\);[\s\S]*?zoneModule\.refreshTargetVisualization\(\)/);
    assert.match(template, /layout\.xaxis\.showgrid = showGrid;[\s\S]*?layout\.yaxis\.showgrid = showGrid;[\s\S]*?if \(chartDiv && chartDiv\.layout && isRadar2dSurfaceVisible\(\)\)/);
    assert.match(template, /layout\.xaxis\.range = \[chartXMin, chartXMax\];[\s\S]*?layout\.yaxis\.range = \[chartYMin, chartYMax\];[\s\S]*?if \(chartDiv && chartDiv\.layout && isRadar2dSurfaceVisible\(\)\)/);
    assert.match(template, /zoneModule\.refreshTargetVisualization\(\)/);
    assert.match(template, /const globalZoneUpdates = Object\.entries\(globalZoneFieldMap\)\.reduce[\s\S]*?rawValue === null \|\| rawValue === undefined[\s\S]*?if \(Object\.keys\(globalZoneUpdates\)\.length > 0\)/);
    assert.match(template, /function getFiniteRadarValue\(value\)[\s\S]*?value === null \|\| value === undefined[\s\S]*?!value\.trim\(\)/);
    assert.match(template, /function buildVerticalBandShapes\(\)[\s\S]*?buildUnsupportedRange2DShapes\(\{[\s\S]*?xMin: chartXMin,[\s\S]*?yMax: chartYMax/);
    assert.match(template, /function getEditModePassiveTraces\(\)[\s\S]*?buildVerticalBandShapes\(\)\.forEach[\s\S]*?shape\.fillcolor/);
    assert.match(template, /function getRadarRings\(\)[\s\S]*?const rings = buildVerticalBandShapes\(\);/);
    assert.match(template, /@media \(max-width: 700px\)[\s\S]*?\.chart-canvas-wrap\s*\{[\s\S]*?height:\s*clamp\(280px, 54dvh, 370px\);[\s\S]*?aspect-ratio:\s*auto;/);
    assert.match(template, /@media \(max-width: 640px\)[\s\S]*?\.radar-panel-heading\s*\{[\s\S]*?min-height:\s*47px;/);
    assert.doesNotMatch(template, /\.chart-canvas-wrap\.radar-view-3d\s*\{/);
});

test('3D display height is an accessible add-on-wide setting with no device-write path', () => {
    assert.match(template, /Radar Display Range \(cm\)/);
    assert.match(
        template,
        /Display only; does not change switch zones\. Width and depth affect both views and are saved in this browser\. Height affects 3D and is one shared setting for this Switch Studio add-on\./,
    );
    assert.match(template, /<label for="vizZMin">Height min \(Z\)<\/label><input type="number" id="vizZMin" min="-600" max="600" step="1" value="-600"/);
    assert.match(template, /<label for="vizZMax">Height max \(Z\)<\/label><input type="number" id="vizZMax" min="-600" max="600" step="1" value="600"/);
    assert.match(
        template,
        /<fieldset class="radar-range-group" id="radarSharedHeightFieldset" aria-busy="true" disabled>[\s\S]*?<legend>3D height[^<]*shared<\/legend>/,
    );
    assert.match(
        template,
        /id="btnSaveRadarSharedHeight" type="button" aria-describedby="radarSharedHeightHelp radarSharedHeightStatus" onclick="saveSharedRadarHeight\(\)">Save Shared Height<\/button>/,
    );
    assert.match(template, /id="radarSharedHeightHelp">[\s\S]*?every switch and browser using this add-on[\s\S]*?No switch or MQTT setting is changed\.<\/div>/);
    assert.match(template, /id="radarSharedHeightStatus" role="status" aria-live="polite"/);
    assert.match(template, /id="btnApplyRadarWidthDepth" type="button" onclick="updateRadarWidthDepth\(\)"/);
    assert.doesNotMatch(template, /btnApplyRadarHeightToAll|radarHeightApplyAllHelp|applyRadarHeightToAllDevices|loadRadarDisplayHeightBounds/);
    assert.match(template, /id="toastContainer" role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(template, /\.radar-display-range-grid\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
    assert.match(template, /\.radar-display-range-actions\s*\{\s*display:\s*grid;/);
    assert.match(template, /@media \(max-width: 640px\)[\s\S]*?\.radar-display-range-grid \.zone-input-group input\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?font-size:\s*16px;[\s\S]*?\.radar-display-range-actions \.cmd-btn\s*\{[\s\S]*?min-height:\s*44px;/);
    assert.match(template, /@media \(hover: none\) and \(pointer: coarse\)[\s\S]*?\.radar-display-range-grid \.zone-input-group input\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?font-size:\s*16px;[\s\S]*?\.radar-display-range-actions \.cmd-btn\s*\{[\s\S]*?min-height:\s*44px;/);
    assert.equal((template.match(/id="vizZMin"/g) || []).length, 1);
    assert.equal((template.match(/id="vizZMax"/g) || []).length, 1);
    assert.equal((template.match(/id="btnSaveRadarSharedHeight"/g) || []).length, 1);

    assert.match(template, /let chartZMin = -600;[\s\S]*?let chartZMax = 600;/);
    assert.match(template, /let radarDisplayHeightState = \{[\s\S]*?epoch: null,[\s\S]*?revision: -1,[\s\S]*?configured: false,[\s\S]*?hydrated: false,[\s\S]*?connectionGeneration: 0/);

    const selectionStart = template.indexOf('function requestDeviceSelection(nextTopic, options)');
    const selectionEnd = template.indexOf('function applyLegacyLayout()', selectionStart);
    assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
    const selectionSource = template.slice(selectionStart, selectionEnd);
    assert.doesNotMatch(selectionSource, /loadLegacyDisplayHeightBounds|loadDisplayHeightBounds|chartZMin\s*=|chartZMax\s*=/);
    assert.match(selectionSource, /radar3dModule\.setActiveDevice\(normalizedNext\);[\s\S]*?refreshRadar3dScene\(\);/);

    const sceneStart = template.indexOf('function buildRadar3dSceneModel()');
    const sceneEnd = template.indexOf('function refreshRadar3dScene()', sceneStart);
    const sceneSource = template.slice(sceneStart, sceneEnd);
    assert.match(sceneSource, /bounds:\s*\{[\s\S]*?zMin:\s*chartZMin,[\s\S]*?zMax:\s*chartZMax/);
    assert.doesNotMatch(sceneSource, /fovBounds|getConfiguredRadarHeightBounds/);

    const widthDepthSource = extractNamedFunction(template, 'updateRadarWidthDepth');
    assert.match(widthDepthSource, /localStorage\.setItem\('vizXMin',[\s\S]*?localStorage\.setItem\('vizYMax'/);
    assert.doesNotMatch(widthDepthSource, /vizZ|chartZ|socket\.emit|update_parameter|send_command/);

    const saveSource = extractNamedFunction(template, 'saveSharedRadarHeight');
    assert.match(saveSource, /getRequestedRadarDisplayHeightBounds\(\)/);
    assert.match(saveSource, /radarDisplayHeightState\.hydrated[\s\S]*?socket\.connected/);
    assert.match(saveSource, /radarDisplayHeightState\.readOnly/);
    assert.match(saveSource, /emitRadarDisplayHeightSave\(nextHeightBounds\)/);
    assert.doesNotMatch(saveSource, /activeDeviceTopic|localStorage|update_parameter|send_command|sendCommand/);

    const emitSource = extractNamedFunction(template, 'emitRadarDisplayHeightSave');
    const wireStart = emitSource.indexOf("socket.emit('set_radar_display_height'");
    const wireEnd = emitSource.indexOf('});', wireStart);
    const wirePayload = emitSource.slice(wireStart, wireEnd + 3);
    assert.match(wirePayload, /request_id:[\s\S]*?expected_epoch:[\s\S]*?expected_revision:[\s\S]*?if_unset:[\s\S]*?z_min:[\s\S]*?z_max:/);
    assert.doesNotMatch(wirePayload, /\btopic\s*:/);

    const connectSource = template.slice(template.indexOf("socket.on('connect'"), template.indexOf("socket.on('disconnect'"));
    assert.match(connectSource, /connectionGeneration \+= 1;[\s\S]*?acceptedConnectionGeneration = -1;[\s\S]*?hydrated = false;/);
    assert.match(connectSource, /socket\.emit\('request_radar_display_height'\)/);
    assert.match(template, /socket\.on\('radar_display_height', \(snapshot\) => \{\s*acceptRadarDisplayHeightSnapshot\(snapshot\);\s*\}\);/);
    assert.match(template, /socket\.on\('radar_display_height_result', \(result\) => \{\s*handleRadarDisplayHeightResult\(result\);\s*\}\);/);
});

test('shared 3D height snapshots reject stale or wrong-epoch data and accept a reset epoch after reconnect', () => {
    const harness = createRadarDisplayHeightHarness();
    const snapshot = (epoch, revision, zMin, zMax, configured = true) => ({
        schema_version: 1,
        epoch,
        revision,
        configured,
        z_min: zMin,
        z_max: zMax,
    });

    assert.equal(harness.acceptRadarDisplayHeightSnapshot(snapshot('boot-a', 5, -180, 420)), true);
    assert.deepEqual(plain(harness.state()), {
        epoch: 'boot-a',
        revision: 5,
        configured: true,
        readOnly: false,
        hydrated: true,
        connectionGeneration: 1,
        acceptedConnectionGeneration: 1,
    });
    assert.deepEqual(plain(harness.chart()), { zMin: -180, zMax: 420 });

    assert.equal(harness.acceptRadarDisplayHeightSnapshot(snapshot('boot-a', 4, -300, 300)), false);
    assert.deepEqual(plain(harness.chart()), { zMin: -180, zMax: 420 });
    assert.equal(harness.acceptRadarDisplayHeightSnapshot(snapshot('boot-a', 5, -200, 400)), false);
    assert.deepEqual(plain(harness.chart()), { zMin: -180, zMax: 420 });

    harness.setDraft(-50, 250);
    assert.equal(harness.acceptRadarDisplayHeightSnapshot(snapshot('boot-a', 6, -240, 360)), true);
    assert.deepEqual(plain(harness.chart()), { zMin: -240, zMax: 360 });
    assert.deepEqual(plain(harness.inputs()), { zMin: '-50', zMax: '250' }, 'a newer broadcast must not erase an unsaved draft');

    assert.equal(harness.acceptRadarDisplayHeightSnapshot(snapshot('boot-b', 0, -600, 600, false)), false);
    assert.equal(harness.emitted.at(-1).name, 'request_radar_display_height');
    assert.equal(harness.state().epoch, 'boot-a');

    harness.beginConnection();
    assert.equal(harness.acceptRadarDisplayHeightSnapshot(snapshot('boot-b', 0, -600, 600, false)), true);
    assert.equal(harness.state().epoch, 'boot-b');
    assert.equal(harness.state().revision, 0);
    assert.match(harness.statuses.at(-1), /unsaved values are preserved/i, 'reconnect must not leave a dirty draft stuck at Loading');
    assert.equal(harness.acceptRadarDisplayHeightSnapshot(snapshot('boot-a', 7, -100, 500)), false);
    assert.equal(harness.emitted.at(-1).name, 'request_radar_display_height');
    assert.equal(harness.acceptRadarDisplayHeightSnapshot({ epoch: 'boot-b', revision: 2 }), false);
    assert.equal(harness.acceptRadarDisplayHeightSnapshot({
        schema_version: 1,
        epoch: 'boot-b',
        revision: 2,
        configured: true,
        z_min: '-200',
        z_max: '400',
    }), false);
    assert.deepEqual(plain(harness.chart()), { zMin: -600, zMax: 600 });
});

test('legacy per-device height is offered as an explicit unsaved draft and never wins globally by timing', () => {
    const topic = 'zigbee2mqtt/office switch';
    const harness = createRadarDisplayHeightHarness({
        activeDeviceTopic: topic,
        legacySeeds: { [topic]: { zMin: -180, zMax: 420 } },
    });
    const defaultSnapshot = {
        schema_version: 1,
        epoch: 'boot-a',
        revision: 0,
        configured: false,
        z_min: -600,
        z_max: 600,
    };

    assert.equal(harness.acceptRadarDisplayHeightSnapshot(defaultSnapshot), true);
    assert.deepEqual(plain(harness.chart()), { zMin: -600, zMax: 600 }, 'legacy data must not change the authoritative scene');
    assert.deepEqual(plain(harness.inputs()), { zMin: '-180', zMax: '420' }, 'the legacy value is only a reviewable draft');
    assert.equal(harness.pending(), null);
    assert.equal(harness.emitted.some((event) => event.name === 'set_radar_display_height'), false);
    assert.match(harness.statuses.at(-1), /previous browser-only height.*Review it.*Save Shared Height/i);
    assert.equal(harness.maybeOfferLegacyRadarDisplayHeight(topic), false, 'the same legacy draft is offered only once per page');
    assert.deepEqual(plain(harness.cleared), [], 'legacy storage is retained until an authoritative save is confirmed');
});

test('a stale shared-height save adopts server authority while preserving the user draft for review', () => {
    const harness = createRadarDisplayHeightHarness();
    const initial = {
        schema_version: 1,
        epoch: 'boot-a',
        revision: 3,
        configured: true,
        z_min: -180,
        z_max: 420,
    };
    assert.equal(harness.acceptRadarDisplayHeightSnapshot(initial), true);
    harness.setDraft(-80, 260);
    assert.equal(harness.emitRadarDisplayHeightSave({ zMin: -80, zMax: 260 }), true);
    const pending = harness.pending();
    const wire = harness.emitted.find((event) => event.name === 'set_radar_display_height');
    assert.equal(wire.payload.if_unset, false);
    assert.equal(wire.payload.expected_revision, 3);
    assert.equal(Object.prototype.hasOwnProperty.call(wire.payload, 'topic'), false);

    assert.equal(harness.handleRadarDisplayHeightResult({
        request_id: pending.requestId,
        status: 'conflict',
        error_code: 'revision_conflict',
        snapshot: {
            ...initial,
            revision: 4,
            z_min: -240,
            z_max: 360,
        },
    }), true);
    assert.deepEqual(plain(harness.chart()), { zMin: -240, zMax: 360 });
    assert.deepEqual(plain(harness.inputs()), { zMin: '-80', zMax: '260' });
    assert.equal(harness.pending(), null);
    assert.match(harness.statuses.at(-1), /values are preserved.*review and save again/i);
});
