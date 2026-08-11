(function () {
    'use strict';

    const STORAGE_KEY = 'switchStudio.radarViewMode';
    const DEFAULT_MODE = '2d';
    const DESKTOP_RENDER_INTERVAL_MS = 125;
    const MOBILE_RENDER_INTERVAL_MS = 200;
    const DEFAULT_BOUNDS = Object.freeze({
        xMin: -650,
        xMax: 650,
        yMin: 0,
        yMax: 650,
        zMin: -600,
        zMax: 600,
    });
    const DEFAULT_CAMERA = Object.freeze({
        eye: { x: 1.55, y: -1.72, z: 1.2 },
        center: { x: 0, y: 0.08, z: -0.08 },
        up: { x: 0, y: 0, z: 1 },
    });

    const ZONE_STYLES = Object.freeze({
        global: {
            name: 'Global detection area',
            color: '#1bd2dc',
            edgeColor: 'rgba(88, 233, 241, 0.82)',
            opacity: 0.045,
        },
        detection: {
            name: 'Detection area',
            color: '#43d17b',
            edgeColor: 'rgba(92, 234, 139, 0.9)',
            opacity: 0.105,
        },
        stay: {
            name: 'Stay area',
            color: '#f4a340',
            edgeColor: 'rgba(255, 183, 82, 0.92)',
            opacity: 0.115,
        },
        interference: {
            name: 'Interference area',
            color: '#ef6672',
            edgeColor: 'rgba(255, 121, 132, 0.92)',
            opacity: 0.115,
        },
    });

    let chart2dEl = null;
    let chart3dEl = null;
    let modeInputs = [];
    let resetButton = null;
    let statusEl = null;
    let legendEl = null;
    let descriptionEl = null;
    let interactionButton = null;
    let plotly = null;
    let zonesApi = null;
    let storage = null;
    let onStatus = null;
    let onModeChange = null;

    let visible = true;
    let editing = false;
    let preferredMode = DEFAULT_MODE;
    let activeMode = DEFAULT_MODE;
    let activeDevice = 'unselected';
    let cameraRevision = 0;
    let sceneModel = normalizeSceneModel({});
    let sceneSignature = '';
    let staticTraces = [];
    let latestSnapshot = { reason: 'init', targets: [], history: {} };

    let chartInitialized = false;
    let chartCreationPromise = null;
    let plotlyUnavailable = false;
    let webglUnavailable = false;
    let destroyed = false;
    let targetUnsubscribe = null;
    let resizeObserver = null;
    let pendingRenderTimer = null;
    let lastTargetRenderAt = -Infinity;
    let renderGeneration = 0;
    let lastRenderedGeneration = -1;
    let lifecycleGeneration = 0;
    let renderAttemptGeneration = 0;
    let modeInputBindings = [];
    let resetBinding = null;
    let webglLostBinding = null;
    let webglRestoredBinding = null;
    let interactionBinding = null;
    let mobileInteractionLocked = true;
    let lastMobileState = null;

    let nowFn = () => Date.now();
    let setTimeoutFn = (callback, delay) => setTimeout(callback, delay);
    let clearTimeoutFn = (timer) => clearTimeout(timer);
    let mobileFn = defaultIsMobile;

    function getWindow() {
        return typeof window !== 'undefined' ? window : null;
    }

    function toFinite(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function readBound(source, camelName, snakeName, fallback) {
        if (source && source[camelName] !== undefined) return toFinite(source[camelName], fallback);
        if (source && source[snakeName] !== undefined) return toFinite(source[snakeName], fallback);
        return fallback;
    }

    function normalizeBounds(rawBounds) {
        const raw = rawBounds || {};
        let xMin = readBound(raw, 'xMin', 'x_min', DEFAULT_BOUNDS.xMin);
        let xMax = readBound(raw, 'xMax', 'x_max', DEFAULT_BOUNDS.xMax);
        let yMin = readBound(raw, 'yMin', 'y_min', DEFAULT_BOUNDS.yMin);
        let yMax = readBound(raw, 'yMax', 'y_max', DEFAULT_BOUNDS.yMax);
        let zMin = readBound(raw, 'zMin', 'z_min', DEFAULT_BOUNDS.zMin);
        let zMax = readBound(raw, 'zMax', 'z_max', DEFAULT_BOUNDS.zMax);
        if (xMin > xMax) [xMin, xMax] = [xMax, xMin];
        if (yMin > yMax) [yMin, yMax] = [yMax, yMin];
        if (zMin > zMax) [zMin, zMax] = [zMax, zMin];
        if (xMin === xMax) xMax = xMin + 1;
        if (yMin === yMax) yMax = yMin + 1;
        if (zMin === zMax) zMax = zMin + 1;
        return { xMin, xMax, yMin, yMax, zMin, zMax };
    }

    function normalizeVisibility(rawVisibility) {
        const raw = rawVisibility || {};
        const detectionAreas = Array.isArray(raw.detectionAreas)
            ? raw.detectionAreas.slice(0, 4).map((value) => value !== false)
            : [true, true, true, true];
        while (detectionAreas.length < 4) detectionAreas.push(true);
        return {
            detection: raw.detection !== false,
            detectionAreas,
            stay: raw.stay !== false,
            interference: raw.interference !== false,
            fov: raw.fov !== false,
            grid: raw.grid !== false,
            labels: raw.labels !== false,
            targets: raw.targets !== false,
            trails: raw.trails !== false,
        };
    }

    function normalizeSceneModel(rawModel) {
        const raw = rawModel || {};
        const bounds = normalizeBounds(raw.bounds);
        const fovSource = raw.fovBounds || raw.bounds || {};
        let fovZMin = readBound(fovSource, 'zMin', 'z_min', bounds.zMin);
        let fovZMax = readBound(fovSource, 'zMax', 'z_max', bounds.zMax);
        if (fovZMin > fovZMax) [fovZMin, fovZMax] = [fovZMax, fovZMin];
        if (fovZMin === fovZMax) fovZMax = fovZMin + 1;
        return {
            zones: raw.zones && typeof raw.zones === 'object' ? raw.zones : {},
            visibility: normalizeVisibility(raw.visibility),
            bounds,
            fovBounds: { zMin: fovZMin, zMax: fovZMax },
        };
    }

    function stableStringify(value) {
        if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
        if (value && typeof value === 'object') {
            const pairs = Object.keys(value)
                .sort()
                .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
            return `{${pairs.join(',')}}`;
        }
        return JSON.stringify(value);
    }

    function copyCamera() {
        return {
            eye: { ...DEFAULT_CAMERA.eye },
            center: { ...DEFAULT_CAMERA.center },
            up: { ...DEFAULT_CAMERA.up },
        };
    }

    function copyRenderedCamera() {
        const renderedRevision = chart3dEl?._fullLayout?.scene?.uirevision
            ?? chart3dEl?._fullLayout?.uirevision
            ?? chart3dEl?.layout?.scene?.uirevision
            ?? chart3dEl?.layout?.uirevision;
        if (renderedRevision === null || renderedRevision === undefined) return null;
        if (String(renderedRevision) !== getUiRevision()) return null;
        const source = chart3dEl?._fullLayout?.scene?.camera
            || chart3dEl?.layout?.scene?.camera;
        if (!source || typeof source !== 'object') return null;
        const fallback = copyCamera();
        const camera = {};
        ['eye', 'center', 'up'].forEach((key) => {
            const vector = source[key];
            camera[key] = {
                x: toFinite(vector?.x, fallback[key].x),
                y: toFinite(vector?.y, fallback[key].y),
                z: toFinite(vector?.z, fallback[key].z),
            };
        });
        if (source.projection && typeof source.projection === 'object') {
            camera.projection = { ...source.projection };
        }
        return camera;
    }

    function defaultIsMobile() {
        const browserWindow = getWindow();
        if (!browserWindow || typeof browserWindow.matchMedia !== 'function') return false;
        try {
            return !!browserWindow.matchMedia(
                '(max-width: 700px), (hover: none) and (pointer: coarse)',
            ).matches;
        } catch (error) {
            return false;
        }
    }

    function safeStorageGet(key) {
        if (!storage || typeof storage.getItem !== 'function') return null;
        try {
            return storage.getItem(key);
        } catch (error) {
            return null;
        }
    }

    function safeStorageSet(key, value) {
        if (!storage || typeof storage.setItem !== 'function') return;
        try {
            storage.setItem(key, value);
        } catch (error) {
            // Private browsing and embedded WebViews can deny local storage.
        }
    }

    function normalizeMode(mode) {
        return String(mode || '').toLowerCase() === '3d' ? '3d' : '2d';
    }

    function readInputMode(input) {
        if (!input) return DEFAULT_MODE;
        return normalizeMode(
            input.value
            || input.dataset?.radarMode
            || input.dataset?.mode
            || input.getAttribute?.('data-radar-mode'),
        );
    }

    function setElementHidden(element, hidden) {
        if (!element) return;
        element.hidden = !!hidden;
        if (typeof element.setAttribute === 'function') {
            element.setAttribute('aria-hidden', hidden ? 'true' : 'false');
        }
    }

    function setStatus(message, kind) {
        if (statusEl) {
            statusEl.textContent = message;
            if (statusEl.dataset) statusEl.dataset.status = kind || 'info';
        }
        if (typeof onStatus === 'function') {
            onStatus(message, {
                kind: kind || 'info',
                mode: activeMode,
                forced: activeMode !== preferredMode,
            });
        }
    }

    function getModeStatus(mode, forced) {
        if (forced && editing) {
            return 'Zone editing uses the 2D radar. Your 3D view will return when editing ends.';
        }
        if (mode === '3d') {
            return '3D radar view. This view is for visualization; edit zones in 2D.';
        }
        return '2D radar view. Zone editing is available.';
    }

    function syncModeControls() {
        modeInputs.forEach((input) => {
            const inputMode = readInputMode(input);
            const selected = inputMode === activeMode;
            const tagName = String(input?.tagName || '').toUpperCase();
            if (tagName === 'INPUT' && 'checked' in input) input.checked = selected;
            if (tagName === 'BUTTON' && typeof input.setAttribute === 'function') {
                input.setAttribute('aria-pressed', selected ? 'true' : 'false');
            }
            const disable3d = inputMode === '3d' && (editing || webglUnavailable || plotlyUnavailable);
            if ('disabled' in input) input.disabled = disable3d;
            if (tagName !== 'INPUT' && typeof input.setAttribute === 'function') {
                input.setAttribute('aria-disabled', disable3d ? 'true' : 'false');
            }
        });
    }

    function syncSurfaceVisibility() {
        const show2d = visible && activeMode === '2d';
        const show3d = visible && activeMode === '3d';
        setElementHidden(chart2dEl, !show2d);
        setElementHidden(chart3dEl, !show3d);
        setElementHidden(legendEl, !show3d);
        setElementHidden(resetButton, !show3d);
        if (descriptionEl?.dataset) descriptionEl.dataset.radarMode = activeMode;
        syncInteractionState();
    }

    function syncInteractionState() {
        const isMobile = mobileFn();
        const breakpointChanged = lastMobileState !== null && isMobile !== lastMobileState;
        if (isMobile && lastMobileState === false) mobileInteractionLocked = true;
        lastMobileState = isMobile;
        const showControl = visible && activeMode === '3d' && isMobile;
        const locked = isMobile && mobileInteractionLocked;
        if (chart3dEl?.dataset) chart3dEl.dataset.interactionLocked = locked ? 'true' : 'false';
        if (interactionButton) {
            setElementHidden(interactionButton, !showControl);
            interactionButton.textContent = locked ? 'Explore 3D' : 'Done';
            interactionButton.setAttribute?.('aria-pressed', locked ? 'false' : 'true');
            interactionButton.setAttribute?.(
                'aria-label',
                locked
                    ? 'Enable 3D radar interaction'
                    : 'Finish 3D radar interaction and resume page scrolling',
            );
        }
        return breakpointChanged;
    }

    function invokeModeChange(forced) {
        if (typeof onModeChange === 'function') {
            onModeChange(activeMode, { forced: !!forced, preferredMode });
        }
    }

    function applyEffectiveMode(mode, options) {
        const opts = options || {};
        const normalized = normalizeMode(mode);
        const changed = normalized !== activeMode;
        activeMode = normalized;
        if (changed && activeMode === '3d' && mobileFn()) mobileInteractionLocked = true;
        syncModeControls();
        syncSurfaceVisibility();

        if (visible && activeMode === '3d') {
            ensureChart();
        } else {
            cancelScheduledRender();
        }

        // A synchronous Plotly/WebGL failure can move us back to 2D while
        // ensureChart is running. Preserve the more useful error status.
        if (activeMode !== normalized) return activeMode;

        if (changed || opts.announce === true) {
            const forced = opts.forced === true || activeMode !== preferredMode;
            setStatus(getModeStatus(activeMode, forced), 'info');
            invokeModeChange(forced);
        }
        return activeMode;
    }

    function setMode(mode, options) {
        const opts = options || {};
        const normalized = normalizeMode(mode);
        if (opts.updatePreference !== false) {
            preferredMode = normalized;
            if (opts.persist !== false) safeStorageSet(STORAGE_KEY, preferredMode);
        }

        const forcedTo2d = editing || webglUnavailable || plotlyUnavailable;
        return applyEffectiveMode(forcedTo2d ? '2d' : normalized, {
            forced: forcedTo2d && normalized === '3d',
            announce: opts.announce,
        });
    }

    function getMode() {
        return activeMode;
    }

    function setVisible(nextVisible) {
        visible = nextVisible !== false;
        syncSurfaceVisibility();
        if (!visible) {
            if (mobileFn()) mobileInteractionLocked = true;
            syncInteractionState();
            cancelScheduledRender();
            return activeMode;
        }
        if (activeMode === '3d') ensureChart();
        return activeMode;
    }

    function setEditing(nextEditing) {
        const normalized = !!nextEditing;
        if (normalized === editing) return activeMode;
        editing = normalized;
        if (editing) {
            return applyEffectiveMode('2d', { forced: preferredMode === '3d', announce: true });
        }
        return applyEffectiveMode(
            (webglUnavailable || plotlyUnavailable) ? '2d' : preferredMode,
            { forced: webglUnavailable || plotlyUnavailable, announce: true },
        );
    }

    function isCoordinateZone(zone) {
        if (!zone || typeof zone !== 'object') return false;
        return (
            zone.x_min !== undefined
            || zone.width_min !== undefined
            || zone.x_max !== undefined
            || zone.width_max !== undefined
        );
    }

    function areaNumberFrom(zone, fallbackIndex) {
        const id = zone?.area_id || zone?._areaKey || '';
        const match = String(id).match(/area\s*([1-9]\d*)/i);
        if (match) return Number(match[1]);
        const explicit = Number(zone?.area_index);
        if (Number.isFinite(explicit)) return explicit >= 1 ? explicit : explicit + 1;
        return fallbackIndex + 1;
    }

    function zonesFromCollection(collection) {
        if (Array.isArray(collection)) {
            return collection.filter((entry) => isCoordinateZone(entry?.zone || entry?.config || entry));
        }
        if (!collection || typeof collection !== 'object') return [];
        if (isCoordinateZone(collection)) return [collection];
        return Object.entries(collection)
            .sort(([left], [right]) => String(left).localeCompare(String(right), undefined, { numeric: true }))
            .filter(([, zone]) => isCoordinateZone(zone))
            .map(([key, zone]) => ({ ...zone, _areaKey: zone.area_id || key }));
    }

    function zoneTraces(zone, category, label) {
        if (!zonesApi || typeof zonesApi.buildZoneCuboidTraces !== 'function') return [];
        const style = ZONE_STYLES[category] || ZONE_STYLES.detection;
        return zonesApi.buildZoneCuboidTraces(zone, {
            name: label || style.name,
            color: style.color,
            edgeColor: style.edgeColor,
            opacity: style.opacity,
            edgeWidth: category === 'global' ? 1.3 : 2,
            visible: true,
            legendgroup: category,
        }) || [];
    }

    function buildStructuredZoneTraces(zones, visibility) {
        const traces = [];
        if (visibility.detection) {
            const detectionZones = zonesFromCollection(zones.mmwave_detection_areas);
            const primaryZone = detectionZones.find((zone, fallbackIndex) => areaNumberFrom(zone, fallbackIndex) === 1);
            if (visibility.detectionAreas[0]) {
                const primaryFallback = primaryZone || zonesFromCollection(zones.global)[0];
                if (primaryFallback) {
                    traces.push(...zoneTraces(primaryFallback, 'global', 'Primary detection area'));
                }
            }
            detectionZones.forEach((zone, fallbackIndex) => {
                const areaNumber = areaNumberFrom(zone, fallbackIndex);
                if (areaNumber === 1) return;
                if (visibility.detectionAreas[areaNumber - 1] === false) return;
                traces.push(...zoneTraces(zone, 'detection', `Detection area ${areaNumber}`));
            });
        }
        if (visibility.stay) {
            zonesFromCollection(zones.mmwave_stay_areas).forEach((zone, fallbackIndex) => {
                const areaNumber = areaNumberFrom(zone, fallbackIndex);
                traces.push(...zoneTraces(zone, 'stay', `Stay area ${areaNumber}`));
            });
        }
        if (visibility.interference) {
            zonesFromCollection(zones.mmwave_interference_areas).forEach((zone, fallbackIndex) => {
                const areaNumber = areaNumberFrom(zone, fallbackIndex);
                traces.push(...zoneTraces(zone, 'interference', `Interference area ${areaNumber}`));
            });
        }
        return traces;
    }

    function normalizeFlatZoneCategory(zone) {
        const raw = String(zone?.category || zone?.type || zone?.kind || 'detection').toLowerCase();
        if (raw.includes('interference')) return 'interference';
        if (raw.includes('stay')) return 'stay';
        if (raw.includes('global') || raw.includes('primary')) return 'global';
        return 'detection';
    }

    function buildFlatZoneTraces(zones, visibility) {
        const traces = [];
        zonesFromCollection(zones).forEach((zone, fallbackIndex) => {
            const category = normalizeFlatZoneCategory(zone);
            if (category === 'detection' || category === 'global') {
                if (!visibility.detection) return;
                if (category === 'detection') {
                    const areaNumber = areaNumberFrom(zone, fallbackIndex);
                    if (visibility.detectionAreas[areaNumber - 1] === false) return;
                }
            }
            if (category === 'stay' && !visibility.stay) return;
            if (category === 'interference' && !visibility.interference) return;
            const style = ZONE_STYLES[category];
            const label = zone.label || zone.name || `${style.name} ${areaNumberFrom(zone, fallbackIndex)}`;
            traces.push(...zoneTraces(zone.zone || zone.config || zone, category, label));
        });
        return traces;
    }

    function buildSensorTrace() {
        return {
            type: 'scatter3d',
            mode: 'markers+text',
            x: [0],
            y: [0],
            z: [0],
            text: ['Sensor'],
            textposition: 'bottom center',
            textfont: { color: '#9fb6c7', size: 10, family: 'DM Sans, sans-serif' },
            marker: {
                size: 5,
                color: '#ff6f7d',
                symbol: 'diamond',
                line: { color: '#ffd5d9', width: 1 },
            },
            hovertemplate: '<b>Sensor</b><br>Origin (0, 0, 0 cm)<extra></extra>',
            showlegend: false,
            name: 'Sensor',
        };
    }

    function buildStaticTraces(model) {
        const traces = [];
        const { zones, visibility, bounds, fovBounds } = model;
        if (visibility.fov && zonesApi && typeof zonesApi.buildFov3DTraces === 'function') {
            traces.push(...(zonesApi.buildFov3DTraces({
                xMin: bounds.xMin,
                xMax: bounds.xMax,
                yMax: Math.min(600, Math.max(0, bounds.yMax)),
                zMin: fovBounds.zMin,
                zMax: fovBounds.zMax,
                innerHalfAngleDegrees: 60,
                outerHalfAngleDegrees: 75,
                visible: true,
            }) || []));
        }

        const structured = zones && !Array.isArray(zones) && (
            Object.prototype.hasOwnProperty.call(zones, 'global')
            || Object.prototype.hasOwnProperty.call(zones, 'mmwave_detection_areas')
            || Object.prototype.hasOwnProperty.call(zones, 'mmwave_stay_areas')
            || Object.prototype.hasOwnProperty.call(zones, 'mmwave_interference_areas')
        );
        traces.push(...(structured
            ? buildStructuredZoneTraces(zones, visibility)
            : buildFlatZoneTraces(zones, visibility)));
        traces.push(buildSensorTrace());
        return traces;
    }

    function buildTargetTraces() {
        if (!zonesApi || typeof zonesApi.buildTarget3DTraces !== 'function') return [];
        return zonesApi.buildTarget3DTraces(
            latestSnapshot.targets || [],
            latestSnapshot.history || {},
            {
                visible: sceneModel.visibility.targets,
                showLabels: sceneModel.visibility.labels,
                showTrails: sceneModel.visibility.trails,
            },
        ) || [];
    }

    function getUiRevision() {
        return `switch-studio-radar-3d:${activeDevice}:${cameraRevision}`;
    }

    function axisLayout(title, range, showGrid) {
        return {
            title: { text: title, font: { color: '#a8bac8', size: 11 } },
            range: range.slice(),
            showgrid: showGrid,
            showline: true,
            zeroline: showGrid,
            gridcolor: 'rgba(124, 157, 177, 0.18)',
            zerolinecolor: 'rgba(139, 185, 202, 0.3)',
            linecolor: 'rgba(124, 157, 177, 0.32)',
            tickfont: { color: '#8ea4b4', size: 9 },
            ticksuffix: ' cm',
            showbackground: true,
            backgroundcolor: 'rgba(7, 18, 28, 0.25)',
        };
    }

    function buildLayout(options) {
        const opts = options || {};
        const { bounds, visibility } = sceneModel;
        const revision = getUiRevision();
        const mobile = mobileFn();
        return {
            autosize: true,
            paper_bgcolor: 'rgba(0, 0, 0, 0)',
            plot_bgcolor: 'rgba(0, 0, 0, 0)',
            font: { color: '#c9d9e4', family: 'DM Sans, sans-serif' },
            margin: mobile
                ? { l: 30, r: 24, t: 10, b: 32 }
                : { l: 14, r: 18, t: 8, b: 14 },
            showlegend: false,
            hovermode: 'closest',
            uirevision: revision,
            scene: {
                uirevision: revision,
                bgcolor: 'rgba(0, 0, 0, 0)',
                aspectmode: 'data',
                dragmode: 'orbit',
                camera: opts.camera || copyCamera(),
                xaxis: axisLayout('Width (cm)', [bounds.xMin, bounds.xMax], visibility.grid),
                yaxis: axisLayout('Depth (cm)', [bounds.yMin, bounds.yMax], visibility.grid),
                zaxis: axisLayout('Height (cm)', [bounds.zMin, bounds.zMax], visibility.grid),
            },
        };
    }

    function buildConfig() {
        return {
            responsive: true,
            scrollZoom: !mobileFn(),
            displayModeBar: false,
            displaylogo: false,
        };
    }

    function assembleTraces() {
        return [...staticTraces, ...buildTargetTraces()];
    }

    function canRender3d() {
        return !destroyed
            && visible
            && activeMode === '3d'
            && !editing
            && !webglUnavailable
            && !!chart3dEl;
    }

    function resolvePlotly() {
        if (plotly) return plotly;
        const browserWindow = getWindow();
        plotly = browserWindow?.Plotly || null;
        return plotly;
    }

    function handleRenderFailure(error, message) {
        chartCreationPromise = null;
        chartInitialized = false;
        plotlyUnavailable = true;
        cancelScheduledRender();
        syncModeControls();
        applyEffectiveMode('2d', { forced: true });
        setStatus(
            message || 'The 3D radar is unavailable in this browser. Showing the 2D radar instead.',
            'error',
        );
        const browserWindow = getWindow();
        if (browserWindow?.console && error) browserWindow.console.warn('3D radar render failed', error);
    }

    function reactCurrentScene(reason, options) {
        if (!canRender3d() || !chartInitialized) return false;
        const renderer = resolvePlotly();
        if (!renderer || typeof renderer.react !== 'function') {
            handleRenderFailure(null);
            return false;
        }
        try {
            const renderLifecycle = lifecycleGeneration;
            const renderAttempt = ++renderAttemptGeneration;
            const resetCamera = reason === 'device' || reason === 'device-reset';
            const layoutOptions = { ...(options || {}) };
            if (!layoutOptions.camera && !resetCamera) {
                layoutOptions.camera = copyRenderedCamera() || copyCamera();
            }
            const result = renderer.react(
                chart3dEl,
                assembleTraces(),
                buildLayout(layoutOptions),
                buildConfig(),
            );
            if (result && typeof result.catch === 'function') {
                result.catch((error) => {
                    if (
                        !destroyed &&
                        renderLifecycle === lifecycleGeneration &&
                        renderAttempt === renderAttemptGeneration
                    ) handleRenderFailure(error);
                });
            }
            if (reason === 'targets') lastTargetRenderAt = nowFn();
            lastRenderedGeneration = renderGeneration;
            return true;
        } catch (error) {
            handleRenderFailure(error);
            return false;
        }
    }

    function restyleTargets() {
        if (!canRender3d() || !chartInitialized) return false;
        const renderer = resolvePlotly();
        if (!renderer || typeof renderer.restyle !== 'function') {
            return reactCurrentScene('targets');
        }
        const targetTraces = buildTargetTraces();
        if (targetTraces.length < 2) return reactCurrentScene('targets');
        const targetTrace = targetTraces[0];
        const trailTrace = targetTraces[1];
        const traceIndices = [staticTraces.length, staticTraces.length + 1];
        const update = {
            x: [targetTrace.x || [], trailTrace.x || []],
            y: [targetTrace.y || [], trailTrace.y || []],
            z: [targetTrace.z || [], trailTrace.z || []],
            text: [targetTrace.text || [], trailTrace.text || []],
            customdata: [targetTrace.customdata || [], trailTrace.customdata || []],
        };
        try {
            const renderLifecycle = lifecycleGeneration;
            const renderAttempt = ++renderAttemptGeneration;
            const result = renderer.restyle(chart3dEl, update, traceIndices);
            if (result && typeof result.catch === 'function') {
                result.catch(() => {
                    if (
                        !destroyed &&
                        renderLifecycle === lifecycleGeneration &&
                        renderAttempt === renderAttemptGeneration
                    ) reactCurrentScene('targets');
                });
            }
            lastTargetRenderAt = nowFn();
            lastRenderedGeneration = renderGeneration;
            return true;
        } catch (error) {
            return reactCurrentScene('targets');
        }
    }

    function renderCurrentScene(reason) {
        if (reason === 'targets') return restyleTargets();
        return reactCurrentScene(reason);
    }

    function ensureChart() {
        if (!canRender3d()) return null;
        if (chartInitialized) {
            if (lastRenderedGeneration !== renderGeneration) reactCurrentScene('reactivate');
            else scheduleTargetRender(true);
            return chart3dEl;
        }
        if (chartCreationPromise) return chartCreationPromise;

        const renderer = resolvePlotly();
        if (!renderer || typeof renderer.newPlot !== 'function') {
            handleRenderFailure(null);
            return null;
        }
        plotlyUnavailable = false;
        syncModeControls();
        try {
            const creationGeneration = renderGeneration;
            const creationLifecycle = lifecycleGeneration;
            const result = renderer.newPlot(chart3dEl, assembleTraces(), buildLayout(), buildConfig());
            const finalize = () => {
                if (destroyed || creationLifecycle !== lifecycleGeneration) return null;
                chartInitialized = true;
                chartCreationPromise = null;
                lastTargetRenderAt = nowFn();
                lastRenderedGeneration = creationGeneration;
                if (canRender3d() && creationGeneration !== renderGeneration) {
                    // Device, zone, or target state may have changed while
                    // WebGL initialized. Reconcile once with the latest model
                    // so an old device frame can never survive the async gap.
                    reactCurrentScene('post-create');
                }
                if (canRender3d()) resizeChart();
                return chart3dEl;
            };
            if (result && typeof result.then === 'function') {
                chartCreationPromise = result.then(finalize).catch((error) => {
                    if (!destroyed && creationLifecycle === lifecycleGeneration) handleRenderFailure(error);
                    return null;
                });
                return chartCreationPromise;
            }
            return finalize();
        } catch (error) {
            handleRenderFailure(error);
            return null;
        }
    }

    function cancelScheduledRender() {
        if (pendingRenderTimer !== null) {
            clearTimeoutFn(pendingRenderTimer);
            pendingRenderTimer = null;
        }
    }

    function scheduleTargetRender(immediate) {
        if (!canRender3d()) return;
        if (!chartInitialized) {
            ensureChart();
            return;
        }
        if (pendingRenderTimer !== null) return;
        const interval = mobileFn() ? MOBILE_RENDER_INTERVAL_MS : DESKTOP_RENDER_INTERVAL_MS;
        const elapsed = nowFn() - lastTargetRenderAt;
        const delay = immediate === true ? 0 : Math.max(0, interval - elapsed);
        if (delay <= 0) {
            renderCurrentScene('targets');
            return;
        }
        pendingRenderTimer = setTimeoutFn(() => {
            pendingRenderTimer = null;
            renderCurrentScene('targets');
        }, delay);
    }

    function handleTargetSnapshot(snapshot) {
        latestSnapshot = {
            reason: snapshot?.reason || 'snapshot',
            targets: Array.isArray(snapshot?.targets) ? snapshot.targets.map((target) => ({ ...target })) : [],
            history: snapshot?.history && typeof snapshot.history === 'object' ? snapshot.history : {},
        };
        renderGeneration += 1;
        scheduleTargetRender(false);
    }

    function rebuildStaticScene(force) {
        const nextSignature = stableStringify(sceneModel);
        if (!force && nextSignature === sceneSignature) return false;
        sceneSignature = nextSignature;
        staticTraces = buildStaticTraces(sceneModel);
        renderGeneration += 1;
        if (canRender3d()) {
            if (chartInitialized) renderCurrentScene('scene');
            else ensureChart();
        }
        return true;
    }

    function setSceneModel(nextModel) {
        sceneModel = normalizeSceneModel(nextModel);
        rebuildStaticScene(false);
        return sceneModel;
    }

    function refreshScene() {
        plotlyUnavailable = false;
        rebuildStaticScene(true);
        syncModeControls();
        if (preferredMode === '3d' && !editing && !webglUnavailable) {
            applyEffectiveMode('3d', { announce: false });
        } else if (canRender3d()) {
            ensureChart();
        }
        return sceneModel;
    }

    function resizeChart() {
        if (!canRender3d() || !chartInitialized) return;
        const renderer = resolvePlotly();
        try {
            if (renderer?.Plots && typeof renderer.Plots.resize === 'function') {
                renderer.Plots.resize(chart3dEl);
            }
        } catch (error) {
            // A resize can race with Plotly teardown while navigating devices.
        }
    }

    function setActiveDevice(deviceKey) {
        const normalized = String(deviceKey || 'unselected');
        if (normalized === activeDevice) return activeDevice;
        activeDevice = normalized;
        cameraRevision = 0;
        latestSnapshot = { reason: 'device-change', targets: [], history: {} };
        renderGeneration += 1;
        lastTargetRenderAt = -Infinity;
        cancelScheduledRender();
        if (canRender3d() && chartInitialized) renderCurrentScene('device');
        return activeDevice;
    }

    function resetView() {
        if (!canRender3d() || !chartInitialized) return false;
        const renderer = resolvePlotly();
        if (!renderer || typeof renderer.relayout !== 'function') return false;
        cameraRevision += 1;
        try {
            const renderLifecycle = lifecycleGeneration;
            const renderAttempt = ++renderAttemptGeneration;
            const result = renderer.relayout(chart3dEl, {
                'scene.camera': copyCamera(),
                uirevision: getUiRevision(),
                'scene.uirevision': getUiRevision(),
            });
            if (result && typeof result.catch === 'function') {
                result.catch((error) => {
                    if (
                        !destroyed &&
                        renderLifecycle === lifecycleGeneration &&
                        renderAttempt === renderAttemptGeneration
                    ) handleRenderFailure(error);
                });
            }
            return true;
        } catch (error) {
            handleRenderFailure(error);
            return false;
        }
    }

    function resetForDeviceChange(deviceKey) {
        if (deviceKey !== undefined) setActiveDevice(deviceKey);
        latestSnapshot = { reason: 'device-reset', targets: [], history: {} };
        sceneModel = normalizeSceneModel({});
        sceneSignature = '';
        staticTraces = buildStaticTraces(sceneModel);
        renderGeneration += 1;
        cameraRevision += 1;
        lastTargetRenderAt = -Infinity;
        cancelScheduledRender();
        if (canRender3d() && chartInitialized) renderCurrentScene('device-reset');
        return activeDevice;
    }

    function handleWebglLost(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        // Invalidate any pending newPlot attempt. Its promise may settle after
        // the browser has restored WebGL and a replacement chart is active.
        lifecycleGeneration += 1;
        renderAttemptGeneration += 1;
        webglUnavailable = true;
        chartInitialized = false;
        chartCreationPromise = null;
        cancelScheduledRender();
        syncModeControls();
        applyEffectiveMode('2d', { forced: true });
        setStatus('The 3D radar lost its graphics context. Showing the 2D radar instead.', 'error');
    }

    function handleWebglRestored() {
        webglUnavailable = false;
        plotlyUnavailable = false;
        chartInitialized = false;
        chartCreationPromise = null;
        syncModeControls();
        if (!editing && preferredMode === '3d') {
            applyEffectiveMode('3d', { announce: true });
        }
    }

    function bindControls() {
        modeInputBindings = modeInputs.map((input) => {
            const eventName = String(input?.tagName || '').toUpperCase() === 'BUTTON' ? 'click' : 'change';
            const handler = () => {
                if (input.disabled) return;
                setMode(readInputMode(input), { persist: true, announce: true });
            };
            input?.addEventListener?.(eventName, handler);
            return { input, eventName, handler };
        });

        if (resetButton?.addEventListener) {
            const handler = () => resetView();
            resetButton.addEventListener('click', handler);
            resetBinding = { element: resetButton, eventName: 'click', handler };
        }

        if (interactionButton?.addEventListener) {
            const handler = () => {
                if (!mobileFn() || activeMode !== '3d') return;
                mobileInteractionLocked = !mobileInteractionLocked;
                syncInteractionState();
            };
            interactionButton.addEventListener('click', handler);
            interactionBinding = { element: interactionButton, eventName: 'click', handler };
        }

        if (chart3dEl?.addEventListener) {
            chart3dEl.addEventListener('webglcontextlost', handleWebglLost);
            chart3dEl.addEventListener('webglcontextrestored', handleWebglRestored);
            webglLostBinding = { element: chart3dEl, eventName: 'webglcontextlost', handler: handleWebglLost };
            webglRestoredBinding = { element: chart3dEl, eventName: 'webglcontextrestored', handler: handleWebglRestored };
        }
    }

    function bindResizeObserver() {
        const browserWindow = getWindow();
        const Observer = browserWindow?.ResizeObserver
            || (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null);
        if (!Observer || !chart3dEl) return;
        try {
            resizeObserver = new Observer(() => {
                const breakpointChanged = syncInteractionState();
                if (breakpointChanged && canRender3d() && chartInitialized) {
                    // Plotly's responsive resize preserves the existing layout
                    // and config. Rebuild once when crossing the phone boundary
                    // so margins, scroll zoom, and the interaction lock follow
                    // the newly active input mode.
                    reactCurrentScene('breakpoint', { camera: copyRenderedCamera() || copyCamera() });
                }
                resizeChart();
            });
            resizeObserver.observe(chart3dEl);
        } catch (error) {
            resizeObserver = null;
        }
    }

    function removeBinding(binding) {
        if (!binding?.element || typeof binding.element.removeEventListener !== 'function') return;
        binding.element.removeEventListener(binding.eventName, binding.handler);
    }

    function destroy() {
        lifecycleGeneration += 1;
        destroyed = true;
        cancelScheduledRender();
        if (typeof targetUnsubscribe === 'function') targetUnsubscribe();
        targetUnsubscribe = null;
        if (resizeObserver && typeof resizeObserver.disconnect === 'function') resizeObserver.disconnect();
        resizeObserver = null;
        modeInputBindings.forEach(removeBinding);
        modeInputBindings = [];
        removeBinding(resetBinding);
        removeBinding(webglLostBinding);
        removeBinding(webglRestoredBinding);
        removeBinding(interactionBinding);
        resetBinding = null;
        webglLostBinding = null;
        webglRestoredBinding = null;
        interactionBinding = null;
        const renderer = resolvePlotly();
        if (renderer && typeof renderer.purge === 'function' && chart3dEl) {
            try {
                renderer.purge(chart3dEl);
            } catch (error) {
                // Plotly may already have purged a detached surface.
            }
        }
        chartInitialized = false;
        chartCreationPromise = null;
        lastRenderedGeneration = -1;
    }

    function init(options) {
        if (!destroyed && (chart2dEl || chart3dEl)) destroy();
        lifecycleGeneration += 1;
        const opts = options || {};
        chart2dEl = opts.chart2dEl || null;
        chart3dEl = opts.chart3dEl || null;
        modeInputs = Array.from(opts.modeInputs || []).filter(Boolean);
        resetButton = opts.resetButton || null;
        statusEl = opts.statusEl || null;
        legendEl = opts.legendEl || null;
        descriptionEl = opts.descriptionEl || null;
        interactionButton = opts.interactionButton || null;
        plotly = opts.plotly || getWindow()?.Plotly || null;
        zonesApi = opts.zonesApi || getWindow()?.SwitchStudioZones || null;
        storage = opts.storage || getWindow()?.localStorage || null;
        onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
        onModeChange = typeof opts.onModeChange === 'function' ? opts.onModeChange : null;
        visible = opts.visible !== false;
        editing = false;
        activeDevice = String(opts.activeDevice || 'unselected');
        cameraRevision = 0;
        sceneModel = normalizeSceneModel(opts.sceneModel || {});
        sceneSignature = '';
        staticTraces = [];
        latestSnapshot = { reason: 'init', targets: [], history: {} };
        chartInitialized = false;
        chartCreationPromise = null;
        plotlyUnavailable = false;
        webglUnavailable = false;
        destroyed = false;
        pendingRenderTimer = null;
        lastTargetRenderAt = -Infinity;
        renderGeneration = 0;
        lastRenderedGeneration = -1;
        renderAttemptGeneration = 0;
        mobileInteractionLocked = true;
        lastMobileState = null;
        nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
        setTimeoutFn = typeof opts.setTimeoutFn === 'function' ? opts.setTimeoutFn : (callback, delay) => setTimeout(callback, delay);
        clearTimeoutFn = typeof opts.clearTimeoutFn === 'function' ? opts.clearTimeoutFn : (timer) => clearTimeout(timer);
        mobileFn = typeof opts.isMobile === 'function' ? opts.isMobile : defaultIsMobile;

        const storedMode = safeStorageGet(STORAGE_KEY);
        preferredMode = normalizeMode(storedMode || opts.initialMode || DEFAULT_MODE);
        activeMode = preferredMode;

        if (statusEl?.setAttribute) statusEl.setAttribute('aria-live', 'polite');
        bindControls();
        bindResizeObserver();
        syncModeControls();
        syncSurfaceVisibility();
        rebuildStaticScene(true);

        if (zonesApi && typeof zonesApi.setTargetSnapshotListener === 'function') {
            targetUnsubscribe = zonesApi.setTargetSnapshotListener(handleTargetSnapshot);
        } else if (zonesApi && typeof zonesApi.getTargetSnapshot === 'function') {
            handleTargetSnapshot(zonesApi.getTargetSnapshot('radar3d-init'));
        }

        setStatus(getModeStatus(activeMode, false), 'info');
        invokeModeChange(false);
        if (visible && activeMode === '3d') ensureChart();
        return getPublicApi();
    }

    function getPublicApi() {
        return {
            init,
            setVisible,
            setActiveDevice,
            setEditing,
            setSceneModel,
            setMode,
            getMode,
            refreshScene,
            resetView,
            resetForDeviceChange,
            destroy,
        };
    }

    const publicApi = getPublicApi();
    const browserWindow = getWindow();
    if (browserWindow) browserWindow.SwitchStudioRadar3D = publicApi;
})();
