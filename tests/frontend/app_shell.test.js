const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const templatePath = path.resolve(__dirname, '../../switch_studio/templates/index.html');
const template = fs.readFileSync(templatePath, 'utf8');

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
    assert.match(selectionSource, /if \(isEditingZone\) endZoneEdit\(\);/);
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

test('3D display height supports an accessible bulk action and supplies the single visible-height scene contract', () => {
    assert.match(template, /Radar Display Range \(cm\)/);
    assert.match(
        template,
        /Display only; does not change zones\. X\/Y affect both views\. Z affects 3D and uses the switch as 0 cm \(negative below, positive above\)\. The 3D view expands when needed to keep every zone whole\. Saved per device in this browser\./,
    );
    assert.match(template, /<label for="vizZMin">Height min \(Z\)<\/label><input type="number" id="vizZMin" min="-600" max="600" step="1" value="-600">/);
    assert.match(template, /<label for="vizZMax">Height max \(Z\)<\/label><input type="number" id="vizZMax" min="-600" max="600" step="1" value="600">/);
    assert.match(template, /id="btnApplyRadarDisplayRange" type="button" onclick="updateRadarScale\(\)"[^>]*>Apply Display Range<\/button>/);
    assert.match(
        template,
        /id="btnApplyRadarHeightToAll" type="button" aria-describedby="radarHeightApplyAllHelp" onclick="applyRadarHeightToAllDevices\(\)">Apply Height to All Switches<\/button>/,
    );
    assert.match(
        template,
        /id="radarHeightApplyAllHelp">Copies only Height min\/max to every currently discovered switch with a 3D radar view in this browser\. Switches discovered later keep their own range\.<\/div>/,
    );
    assert.match(template, /id="toastContainer" role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(template, /\.radar-display-range-grid\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
    assert.match(template, /\.radar-display-range-actions\s*\{\s*display:\s*grid;[\s\S]*?\.radar-display-range-apply-all\s*\{/);
    assert.match(template, /@media \(max-width: 640px\)[\s\S]*?\.radar-display-range-grid \.zone-input-group input\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?font-size:\s*16px;[\s\S]*?\.radar-display-range-actions \.cmd-btn\s*\{[\s\S]*?min-height:\s*44px;/);
    assert.match(template, /@media \(hover: none\) and \(pointer: coarse\)[\s\S]*?\.radar-display-range-grid \.zone-input-group input\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?font-size:\s*16px;[\s\S]*?\.radar-display-range-actions \.cmd-btn\s*\{[\s\S]*?min-height:\s*44px;/);
    assert.equal((template.match(/id="vizZMin"/g) || []).length, 1);
    assert.equal((template.match(/id="vizZMax"/g) || []).length, 1);
    assert.equal((template.match(/id="btnApplyRadarHeightToAll"/g) || []).length, 1);
    assert.equal((template.match(/id="radarHeightApplyAllHelp"/g) || []).length, 1);

    assert.match(template, /let chartZMin = -600;[\s\S]*?let chartZMax = 600;/);
    assert.match(
        template,
        /function loadRadarDisplayHeightBounds\(topic\)[\s\S]*?radar3dModule\.loadDisplayHeightBounds\(topic\)[\s\S]*?chartZMin = loaded\.zMin;[\s\S]*?chartZMax = loaded\.zMax;[\s\S]*?setRadarDisplayHeightInputs\(\)/,
    );

    const selectionStart = template.indexOf('function requestDeviceSelection(nextTopic, options)');
    const selectionEnd = template.indexOf('function applyLegacyLayout()', selectionStart);
    assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
    const selectionSource = template.slice(selectionStart, selectionEnd);
    const hydrateIndex = selectionSource.indexOf('loadRadarDisplayHeightBounds(normalizedNext);');
    const activateIndex = selectionSource.indexOf('radar3dModule.setActiveDevice(normalizedNext);');
    const refreshIndex = selectionSource.indexOf('refreshRadar3dScene();', activateIndex);
    assert.ok(hydrateIndex >= 0, 'device selection should hydrate its display-height pair');
    assert.ok(activateIndex > hydrateIndex, 'height inputs should hydrate before the new device scene is activated');
    assert.ok(refreshIndex > activateIndex, 'the selected device scene should immediately receive its stored display range');

    const sceneStart = template.indexOf('function buildRadar3dSceneModel()');
    const sceneEnd = template.indexOf('function refreshRadar3dScene()', sceneStart);
    const sceneSource = template.slice(sceneStart, sceneEnd);
    assert.match(sceneSource, /bounds:\s*\{[\s\S]*?zMin:\s*chartZMin,[\s\S]*?zMax:\s*chartZMax/);
    assert.doesNotMatch(sceneSource, /fovBounds|getConfiguredRadarHeightBounds/);

    const requestedStart = template.indexOf('function getRequestedRadarDisplayHeightBounds()');
    const targetStart = template.indexOf('function getRadarDisplayHeightTargetTopics()', requestedStart);
    const applyAllStart = template.indexOf('function applyRadarHeightToAllDevices()', targetStart);
    const applyAllEnd = template.indexOf('function applyVizSettings()', applyAllStart);
    assert.ok(requestedStart >= 0 && targetStart > requestedStart && applyAllStart > targetStart && applyAllEnd > applyAllStart);
    const requestedSource = template.slice(requestedStart, targetStart);
    const targetSource = template.slice(targetStart, applyAllStart);
    const applyAllSource = template.slice(applyAllStart, applyAllEnd);
    const bulkFeatureSource = template.slice(requestedStart, applyAllEnd);

    assert.match(requestedSource, /normalizeDisplayHeightBounds\(vizZMin\.value, vizZMax\.value\)/);
    assert.match(targetSource, /SwitchStudioDevices\.getDevices\(\)/);
    assert.match(targetSource, /device\.capabilities\.full_editor !== false/);
    assert.match(targetSource, /\.map\(\(device\) => String\(device\.topic\)\.trim\(\)\)/);
    assert.match(targetSource, /return Array\.from\(new Set\(topics\.filter\(Boolean\)\)\);/);
    assert.doesNotMatch(
        targetSource,
        /activeDeviceTopic/,
        'an open topic absent from the current compatible inventory must not be targeted or counted',
    );

    const readIndex = applyAllSource.indexOf('getRequestedRadarDisplayHeightBounds();');
    const targetsIndex = applyAllSource.indexOf('getRadarDisplayHeightTargetTopics();');
    const saveIndex = applyAllSource.indexOf('saveDisplayHeightBoundsForDevices(topics, nextHeightBounds.zMin, nextHeightBounds.zMax)');
    const allFailedIndex = applyAllSource.indexOf('if (!saved || !saved.deviceKeys.length)');
    const activeSavedIndex = applyAllSource.indexOf('const activeWasSaved = saved.deviceKeys.includes');
    const refreshAllIndex = applyAllSource.indexOf('refreshRadar3dScene();');
    assert.ok(readIndex >= 0 && targetsIndex > readIndex && saveIndex > targetsIndex, 'bulk save must validate before snapshotting and writing the current inventory');
    assert.ok(allFailedIndex > saveIndex && activeSavedIndex > allFailedIndex, 'all-failed persistence must exit before any active-device update or success');
    assert.match(
        applyAllSource,
        /if \(!saved \|\| !saved\.deviceKeys\.length\) \{[\s\S]*?showToast\('error', 'This browser could not save the height range\. No switches were changed\.', 3200\);[\s\S]*?setRadarDisplayHeightInputs\(\);[\s\S]*?return false;/,
    );
    assert.match(
        applyAllSource,
        /const activeWasSaved = saved\.deviceKeys\.includes\(String\(activeDeviceTopic \|\| ''\)\.trim\(\)\);[\s\S]*?if \(activeWasSaved\) \{[\s\S]*?chartZMin = saved\.bounds\.zMin;[\s\S]*?chartZMax = saved\.bounds\.zMax;[\s\S]*?setRadarDisplayHeightInputs\(\);[\s\S]*?refreshRadar3dScene\(\);[\s\S]*?\} else \{[\s\S]*?setRadarDisplayHeightInputs\(\);/,
    );
    assert.ok(refreshAllIndex > activeSavedIndex, 'the active 3D scene should refresh only inside the saved-active branch');
    assert.equal((applyAllSource.match(/refreshRadar3dScene\(\);/g) || []).length, 1);
    assert.match(applyAllSource, /saved\.deviceKeys\.length === 1 \? 'switch' : 'switches'/);
    assert.match(
        applyAllSource,
        /if \(saved\.failedDeviceKeys && saved\.failedDeviceKeys\.length\) \{[\s\S]*?showToast\([\s\S]*?'error',[\s\S]*?Height range saved for \$\{saved\.deviceKeys\.length\} \$\{noun\}; \$\{saved\.failedDeviceKeys\.length\} could not be saved\.[\s\S]*?\} else \{[\s\S]*?showToast\('success'/,
    );
    assert.match(applyAllSource, /Height range applied to \$\{saved\.deviceKeys\.length\} \$\{noun\}\./);
    assert.doesNotMatch(bulkFeatureSource, /\b(?:chart|viz)[XY](?:Min|Max)\b/);
    assert.doesNotMatch(bulkFeatureSource, /localStorage\.setItem|socket\.emit|sendCommand|updateRadarScale\(\)|\.setMode\(/);

    const updateStart = template.indexOf('function updateRadarScale()');
    const updateEnd = template.indexOf('// Attach Listeners', updateStart);
    const updateSource = template.slice(updateStart, updateEnd);
    assert.match(updateSource, /const nextHeightBounds = getRequestedRadarDisplayHeightBounds\(\);/);
    assert.match(updateSource, /if \(!nextHeightBounds\)[\s\S]*?return false;/);
    assert.match(updateSource, /chartZMin = nextHeightBounds\.zMin;[\s\S]*?chartZMax = nextHeightBounds\.zMax;/);
    assert.match(updateSource, /saveDisplayHeightBounds\(activeDeviceTopic, chartZMin, chartZMax\)/);
    assert.match(updateSource, /localStorage\.setItem\('vizXMin',[\s\S]*?localStorage\.setItem\('vizYMax'/);
    assert.doesNotMatch(updateSource, /localStorage\.setItem\('vizZ(?:Min|Max)'/);
    assert.match(updateSource, /'xaxis\.range': \[chartXMin, chartXMax\],[\s\S]*?'yaxis\.range': \[chartYMin, chartYMax\]/);
    assert.doesNotMatch(updateSource, /zaxis\.range/);
    assert.doesNotMatch(updateSource, /\.setMode\(/);
});
