(function () {
    'use strict';

    const STORAGE_KEY = 'switchStudio.radarViewMode';
    const DISPLAY_HEIGHT_STORAGE_PREFIX = 'switchStudio.radarDisplayHeight:';
    const DISPLAY_HEIGHT_MIN = -600;
    const DISPLAY_HEIGHT_MAX = 600;
    const DISPLAY_HEIGHT_MIN_SPAN = 20;
    const DEFAULT_MODE = '2d';
    const DESKTOP_RENDER_INTERVAL_MS = 125;
    const MOBILE_RENDER_INTERVAL_MS = 200;
    const CAMERA_TRANSITION_DURATION_MS = 560;
    const CAMERA_TRANSITION_STEP_MS = 24;
    const SURFACE_TRANSITION_DURATION_MS = 170;
    const TOP_DOWN_ORBIT_AZIMUTH = -Math.PI / 2;
    const MIN_CAMERA_RADIUS = 0.82;
    const MAX_CAMERA_RADIUS = 4.6;
    const ZONE_RENDER_PADDING_MIN_CM = 20;
    const ZONE_RENDER_PADDING_MAX_CM = 60;
    const ZONE_RENDER_PADDING_RATIO = 0.03;
    const CAMERA_POLE_MARGIN = 0.015;
    const MIN_CAMERA_ELEVATION = (-Math.PI / 2) + CAMERA_POLE_MARGIN;
    const MAX_CAMERA_ELEVATION = (Math.PI / 2) - CAMERA_POLE_MARGIN;
    const DEFAULT_BOUNDS = Object.freeze({
        xMin: -650,
        xMax: 650,
        yMin: 0,
        yMax: 650,
        zMin: -600,
        zMax: 600,
    });
    const FIXED_CAMERA_CENTER = Object.freeze({ x: 0, y: 0, z: 0 });
    const PERSPECTIVE_UP = Object.freeze({ x: 0, y: 0, z: 1 });
    const DEFAULT_CAMERA = Object.freeze({
        eye: { x: 1.55, y: -1.72, z: 1.2 },
        center: FIXED_CAMERA_CENTER,
        up: PERSPECTIVE_UP,
        projection: { type: 'perspective' },
    });
    const TOP_DOWN_CAMERA = Object.freeze({
        // Keep a very small forward component so Plotly never reaches the
        // singular eye/up alignment at an exactly vertical camera. The
        // native Cartesian surface remains the actual 2D view.
        eye: { x: 0, y: -0.12, z: 1.68 },
        center: FIXED_CAMERA_CENTER,
        up: PERSPECTIVE_UP,
        projection: { type: 'perspective' },
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
    let renderedCameraMode = DEFAULT_MODE;
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
    let fullRenderInFlight = false;
    let modeInputBindings = [];
    let resetBinding = null;
    let webglLostBinding = null;
    let webglRestoredBinding = null;
    let interactionBinding = null;
    let mobileInteractionLocked = true;
    let lastMobileState = null;
    let lastPerspectiveCamera = null;
    let perspectiveCameraGeneration = 0;
    let perspectiveCameraAuthoritative = false;
    let cameraTransitionTimer = null;
    let cameraTransitionGeneration = 0;
    let modeRequestGeneration = 0;
    let cameraTransitioning = false;
    let cameraTransitionChangesMode = false;
    let pendingCameraTarget = null;
    let lastModePathProgress = 0;
    let lastModePathProgressValid = true;
    let lastIssuedCameraSignature = '';
    let lastIssuedCamera = null;
    let plotlyRelayoutBindings = [];
    let gestureBindings = [];
    let cameraGestureActive = false;
    let cameraGestureGeneration = 0;
    let cameraGestureEndTimer = null;
    let cameraGestureCamera = null;
    let cameraGestureDeferredRender = false;
    let cameraGestureDeferredResize = false;
    let surfaceTransitionTimer = null;
    let surfaceTransitionDirection = null;

    let nowFn = () => Date.now();
    let setTimeoutFn = (callback, delay) => setTimeout(callback, delay);
    let clearTimeoutFn = (timer) => clearTimeout(timer);
    let mobileFn = defaultIsMobile;
    let reducedMotionFn = defaultPrefersReducedMotion;

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

    function readZoneCoordinate(source, names) {
        for (const name of names) {
            const rawValue = source?.[name];
            if (rawValue === null || rawValue === undefined) continue;
            if (typeof rawValue === 'string' && !rawValue.trim()) continue;
            const value = Number(rawValue);
            if (Number.isFinite(value)) return value;
        }
        return null;
    }

    function getZoneCoordinateBounds(zone) {
        const source = zone?.zone || zone?.config || zone;
        if (!source || typeof source !== 'object') return null;
        if (zonesApi && typeof zonesApi.buildZoneCuboidGeometry === 'function') {
            const geometry = zonesApi.buildZoneCuboidGeometry(source);
            const geometryBounds = geometry?.bounds;
            if (geometryBounds && ['xMin', 'xMax', 'yMin', 'yMax', 'zMin', 'zMax'].every(
                (key) => Number.isFinite(Number(geometryBounds[key])),
            )) {
                if (
                    Number(geometryBounds.xMin) === Number(geometryBounds.xMax)
                    || Number(geometryBounds.yMin) === Number(geometryBounds.yMax)
                    || Number(geometryBounds.zMin) === Number(geometryBounds.zMax)
                ) return null;
                return normalizeBounds(geometryBounds);
            }
        }

        const values = {
            xMin: readZoneCoordinate(source, ['x_min', 'width_min']),
            xMax: readZoneCoordinate(source, ['x_max', 'width_max']),
            yMin: readZoneCoordinate(source, ['y_min', 'depth_min']),
            yMax: readZoneCoordinate(source, ['y_max', 'depth_max']),
            zMin: readZoneCoordinate(source, ['z_min', 'height_min']),
            zMax: readZoneCoordinate(source, ['z_max', 'height_max']),
        };
        if (Object.values(values).some((value) => value === null)) return null;
        if (values.xMin === values.xMax || values.yMin === values.yMax || values.zMin === values.zMax) return null;
        const normalized = normalizeBounds(values);
        return normalized;
    }

    function collectConfiguredZoneBounds(source, output, visited) {
        if (!source || typeof source !== 'object') return output;
        const seen = visited || new WeakSet();
        if (seen.has(source)) return output;
        seen.add(source);
        if (Array.isArray(source)) {
            source.forEach((entry) => collectConfiguredZoneBounds(entry, output, seen));
            return output;
        }
        const zoneBounds = getZoneCoordinateBounds(source);
        if (zoneBounds) {
            output.push(zoneBounds);
            return output;
        }
        Object.values(source).forEach((entry) => collectConfiguredZoneBounds(entry, output, seen));
        return output;
    }

    function buildRenderBounds(displayBounds, zones) {
        const renderBounds = { ...displayBounds };
        const zoneBounds = collectConfiguredZoneBounds(zones, [], new WeakSet());
        const contentBounds = { ...displayBounds };
        zoneBounds.forEach((bounds) => {
            contentBounds.xMin = Math.min(contentBounds.xMin, bounds.xMin);
            contentBounds.xMax = Math.max(contentBounds.xMax, bounds.xMax);
            contentBounds.yMin = Math.min(contentBounds.yMin, bounds.yMin);
            contentBounds.yMax = Math.max(contentBounds.yMax, bounds.yMax);
            contentBounds.zMin = Math.min(contentBounds.zMin, bounds.zMin);
            contentBounds.zMax = Math.max(contentBounds.zMax, bounds.zMax);
        });

        const axes = [
            ['xMin', 'xMax'],
            ['yMin', 'yMax'],
            ['zMin', 'zMax'],
        ];
        axes.forEach(([minKey, maxKey]) => {
            const span = contentBounds[maxKey] - contentBounds[minKey];
            const padding = Math.min(
                ZONE_RENDER_PADDING_MAX_CM,
                Math.max(ZONE_RENDER_PADDING_MIN_CM, Math.ceil(span * ZONE_RENDER_PADDING_RATIO)),
            );
            const zoneTouchesMin = zoneBounds.some((bounds) => bounds[minKey] <= displayBounds[minKey]);
            const zoneTouchesMax = zoneBounds.some((bounds) => bounds[maxKey] >= displayBounds[maxKey]);
            if (zoneTouchesMin) renderBounds[minKey] = contentBounds[minKey] - padding;
            else renderBounds[minKey] = contentBounds[minKey];
            if (zoneTouchesMax) renderBounds[maxKey] = contentBounds[maxKey] + padding;
            else renderBounds[maxKey] = contentBounds[maxKey];

            // The physical switch remains a reference point even when a user
            // chooses a display range that excludes zero. Unlike zone meshes,
            // the point itself does not need extra clipping clearance.
            renderBounds[minKey] = Math.min(renderBounds[minKey], 0);
            renderBounds[maxKey] = Math.max(renderBounds[maxKey], 0);
        });
        return renderBounds;
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
        const displayBounds = normalizeBounds(raw.displayBounds || raw.bounds);
        const zones = raw.zones && typeof raw.zones === 'object' ? raw.zones : {};
        const renderBounds = buildRenderBounds(displayBounds, zones);
        const fovSource = raw.fovBounds || {};
        let fovZMin = readBound(fovSource, 'zMin', 'z_min', DISPLAY_HEIGHT_MIN);
        let fovZMax = readBound(fovSource, 'zMax', 'z_max', DISPLAY_HEIGHT_MAX);
        if (fovZMin > fovZMax) [fovZMin, fovZMax] = [fovZMax, fovZMin];
        if (fovZMin === fovZMax) fovZMax = fovZMin + 1;
        return {
            zones,
            visibility: normalizeVisibility(raw.visibility),
            bounds: displayBounds,
            displayBounds,
            renderBounds,
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

    function cloneCamera(camera) {
        const source = camera || DEFAULT_CAMERA;
        return {
            eye: { ...source.eye },
            center: { ...source.center },
            up: { ...source.up },
            projection: { type: source.projection?.type === 'orthographic' ? 'orthographic' : 'perspective' },
        };
    }

    function copyCamera() {
        return cloneCamera(DEFAULT_CAMERA);
    }

    function copyTopDownCamera() {
        return cloneCamera(TOP_DOWN_CAMERA);
    }

    function vectorLength(vector) {
        return Math.hypot(vector.x, vector.y, vector.z);
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function sanitizePerspectiveCamera(rawCamera) {
        const fallback = lastPerspectiveCamera || DEFAULT_CAMERA;
        const rawEye = rawCamera?.eye || fallback.eye;
        let x = toFinite(rawEye.x, fallback.eye.x);
        let y = toFinite(rawEye.y, fallback.eye.y);
        let z = toFinite(rawEye.z, fallback.eye.z);
        let radius = Math.hypot(x, y, z);
        if (!Number.isFinite(radius) || radius < 0.001) {
            x = fallback.eye.x;
            y = fallback.eye.y;
            z = fallback.eye.z;
            radius = Math.hypot(x, y, z);
        }
        const rawElevation = Math.asin(clamp(z / radius, -1, 1));
        const elevation = clamp(rawElevation, MIN_CAMERA_ELEVATION, MAX_CAMERA_ELEVATION);
        const horizontalRadiusRaw = Math.hypot(x, y);
        const fallbackAzimuth = Math.atan2(fallback.eye.y, fallback.eye.x);
        const azimuth = (horizontalRadiusRaw / radius) <= Math.cos(MAX_CAMERA_ELEVATION)
            ? fallbackAzimuth
            : Math.atan2(y, x);
        radius = clamp(radius, MIN_CAMERA_RADIUS, MAX_CAMERA_RADIUS);
        const horizontalRadius = radius * Math.cos(elevation);
        return {
            eye: {
                x: horizontalRadius * Math.cos(azimuth),
                y: horizontalRadius * Math.sin(azimuth),
                z: radius * Math.sin(elevation),
            },
            center: { ...FIXED_CAMERA_CENTER },
            up: { ...PERSPECTIVE_UP },
            projection: { type: 'perspective' },
        };
    }

    function sanitizeOrthographicCamera() {
        return copyTopDownCamera();
    }

    function cameraForMode(mode) {
        return normalizeMode(mode) === '3d'
            ? sanitizePerspectiveCamera(lastPerspectiveCamera || DEFAULT_CAMERA)
            : sanitizeOrthographicCamera();
    }

    function cameraForSteadyRender(mode) {
        const normalized = normalizeMode(mode);
        if (normalized === '3d' && perspectiveCameraAuthoritative) return cameraForMode('3d');
        return copyRenderedCamera(normalized) || cameraForMode(normalized);
    }

    function cameraSignature(camera) {
        if (!camera) return '';
        return stableStringify({
            eye: camera.eye,
            center: camera.center,
            up: camera.up,
            projection: camera.projection,
        });
    }

    function cameraNearlyEqual(left, right, tolerance) {
        if (!left || !right) return false;
        const epsilon = Number.isFinite(tolerance) ? tolerance : 0.0005;
        const sameVector = (a, b) => ['x', 'y', 'z'].every((key) => Math.abs(Number(a?.[key]) - Number(b?.[key])) <= epsilon);
        return sameVector(left.eye, right.eye)
            && sameVector(left.center, right.center)
            && sameVector(left.up, right.up)
            && String(left.projection?.type || 'perspective') === String(right.projection?.type || 'perspective');
    }

    function copyRenderedCamera(mode) {
        const renderedRevision = chart3dEl?._fullLayout?.scene?.uirevision
            ?? chart3dEl?._fullLayout?.uirevision
            ?? chart3dEl?.layout?.scene?.uirevision
            ?? chart3dEl?.layout?.uirevision;
        if (renderedRevision === null || renderedRevision === undefined) return null;
        const baseRevision = getUiRevision();
        const normalizedRevision = String(renderedRevision);
        if (
            normalizedRevision !== baseRevision
            && !normalizedRevision.startsWith(`${baseRevision}:scene:`)
        ) return null;
        const source = chart3dEl?._fullLayout?.scene?.camera
            || chart3dEl?.layout?.scene?.camera;
        if (!source || typeof source !== 'object') return null;
        const fallback = cameraForMode(mode || activeMode);
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
        const requestedMode = mode || (camera.projection?.type === 'orthographic' ? '2d' : activeMode);
        return normalizeMode(requestedMode) === '3d'
            ? sanitizePerspectiveCamera(camera)
            : sanitizeOrthographicCamera(camera);
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

    function defaultPrefersReducedMotion() {
        const browserWindow = getWindow();
        if (!browserWindow || typeof browserWindow.matchMedia !== 'function') return false;
        try {
            return !!browserWindow.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
        if (!storage || typeof storage.setItem !== 'function') return false;
        try {
            storage.setItem(key, value);
            return true;
        } catch (error) {
            // Private browsing and embedded WebViews can deny local storage.
            return false;
        }
    }

    function displayHeightStorageKey(deviceKey) {
        const normalizedDevice = String(deviceKey || '').trim();
        return normalizedDevice
            ? `${DISPLAY_HEIGHT_STORAGE_PREFIX}${encodeURIComponent(normalizedDevice)}`
            : '';
    }

    function normalizeDisplayHeightBounds(rawMin, rawMax) {
        if (rawMin === null || rawMin === undefined || rawMax === null || rawMax === undefined) return null;
        if (typeof rawMin === 'string' && !rawMin.trim()) return null;
        if (typeof rawMax === 'string' && !rawMax.trim()) return null;
        const parsedMin = Number(rawMin);
        const parsedMax = Number(rawMax);
        if (!Number.isFinite(parsedMin) || !Number.isFinite(parsedMax)) return null;
        const zMin = Math.min(parsedMin, parsedMax);
        const zMax = Math.max(parsedMin, parsedMax);
        if (zMin < DISPLAY_HEIGHT_MIN || zMax > DISPLAY_HEIGHT_MAX) return null;
        if ((zMax - zMin) < DISPLAY_HEIGHT_MIN_SPAN) return null;
        return { zMin, zMax };
    }

    function loadDisplayHeightBounds(deviceKey) {
        const fallback = { zMin: DISPLAY_HEIGHT_MIN, zMax: DISPLAY_HEIGHT_MAX };
        const key = displayHeightStorageKey(deviceKey);
        if (!key) return fallback;
        const stored = safeStorageGet(key);
        if (!stored) return fallback;
        try {
            const parsed = JSON.parse(stored);
            return normalizeDisplayHeightBounds(parsed?.zMin, parsed?.zMax) || fallback;
        } catch (error) {
            return fallback;
        }
    }

    function saveDisplayHeightBounds(deviceKey, rawMin, rawMax) {
        const key = displayHeightStorageKey(deviceKey);
        const normalized = normalizeDisplayHeightBounds(rawMin, rawMax);
        if (!key || !normalized) return null;
        safeStorageSet(key, JSON.stringify(normalized));
        return normalized;
    }

    function saveDisplayHeightBoundsForDevices(deviceKeys, rawMin, rawMax) {
        const bounds = normalizeDisplayHeightBounds(rawMin, rawMax);
        if (!bounds) return null;
        const normalizedKeys = Array.from(new Set(
            (Array.isArray(deviceKeys) ? deviceKeys : [])
                .map((deviceKey) => String(deviceKey || '').trim())
                .filter(Boolean),
        ));
        if (!normalizedKeys.length) return null;
        const serialized = JSON.stringify(bounds);
        const savedDeviceKeys = [];
        const failedDeviceKeys = [];
        normalizedKeys.forEach((deviceKey) => {
            const key = displayHeightStorageKey(deviceKey);
            if (key && safeStorageSet(key, serialized)) savedDeviceKeys.push(deviceKey);
            else failedDeviceKeys.push(deviceKey);
        });
        return {
            bounds: { ...bounds },
            deviceKeys: savedDeviceKeys,
            failedDeviceKeys,
        };
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
            return '3D fixed-center radar view. This view is for visualization; edit zones in 2D.';
        }
        return '2D top-down radar view. Zone editing is available.';
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

    function setSurfaceState(element, state, hidden) {
        if (!element) return;
        setElementHidden(element, hidden === true);
        if (element.dataset) element.dataset.radarSurfaceState = state;
        element.setAttribute?.('aria-hidden', state === 'active' ? 'false' : 'true');
    }

    function beginSurfaceTransition(targetMode) {
        surfaceTransitionDirection = normalizeMode(targetMode);
        if (surfaceTransitionTimer !== null) {
            clearTimeoutFn(surfaceTransitionTimer);
            surfaceTransitionTimer = null;
        }
        if (surfaceTransitionDirection === '3d') {
            setSurfaceState(chart2dEl, 'outgoing', false);
            setSurfaceState(chart3dEl, 'incoming', false);
        } else {
            setSurfaceState(chart2dEl, 'incoming', false);
            setSurfaceState(chart3dEl, 'outgoing', false);
        }
    }

    function startSurfaceFade(targetMode) {
        const target = normalizeMode(targetMode);
        if (target === '3d') {
            setSurfaceState(chart2dEl, 'retiring', false);
            setSurfaceState(chart3dEl, 'active', false);
        } else {
            setSurfaceState(chart2dEl, 'active', false);
            setSurfaceState(chart3dEl, 'retiring', false);
        }
    }

    function settleSurfaceTransition(targetMode) {
        const target = normalizeMode(targetMode);
        surfaceTransitionDirection = null;
        if (surfaceTransitionTimer !== null) {
            clearTimeoutFn(surfaceTransitionTimer);
            surfaceTransitionTimer = null;
        }
        if (!visible) {
            setSurfaceState(chart2dEl, 'inactive', true);
            setSurfaceState(chart3dEl, 'inactive', true);
            return;
        }
        if (target === '3d' && !editing && !webglUnavailable && !plotlyUnavailable && chartInitialized) {
            setSurfaceState(chart2dEl, 'inactive', true);
            setSurfaceState(chart3dEl, 'active', false);
        } else {
            setSurfaceState(chart2dEl, 'active', false);
            setSurfaceState(chart3dEl, 'inactive', true);
        }
    }

    function syncSurfaceVisibility() {
        const sceneEligible = !editing && !webglUnavailable && !plotlyUnavailable;
        const sceneAvailable = sceneEligible && chartInitialized;
        if (!visible) {
            setSurfaceState(chart2dEl, 'inactive', true);
            setSurfaceState(chart3dEl, 'inactive', true);
        } else if (surfaceTransitionDirection && sceneEligible) {
            setElementHidden(chart2dEl, false);
            setElementHidden(chart3dEl, false);
        } else if (!sceneAvailable) {
            setSurfaceState(chart2dEl, 'active', false);
            setSurfaceState(chart3dEl, 'inactive', true);
        } else if (!surfaceTransitionDirection) {
            settleSurfaceTransition(activeMode);
        }
        const showScene = visible && sceneAvailable && (activeMode === '3d' || !!surfaceTransitionDirection);
        setElementHidden(legendEl, !showScene);
        setElementHidden(
            resetButton,
            !(showScene && activeMode === '3d' && !cameraTransitioning && !surfaceTransitionDirection),
        );
        if (chart3dEl?.dataset) {
            chart3dEl.dataset.radarMode = activeMode;
            chart3dEl.dataset.transitioning = cameraTransitioning ? 'true' : 'false';
        }
        chart3dEl?.setAttribute?.(
            'aria-label',
            activeMode === '3d'
                ? 'Three-dimensional live presence radar map with targets, zone volumes, and sensor field of view. Exact target coordinates are listed in the table below.'
                : 'Top-down live presence radar map with targets, zones, and sensor field of view. Exact target coordinates are listed in the table below.',
        );
        if (descriptionEl?.dataset) descriptionEl.dataset.radarMode = activeMode;
        syncInteractionState();
    }

    function syncInteractionState() {
        const isMobile = mobileFn();
        const breakpointChanged = lastMobileState !== null && isMobile !== lastMobileState;
        if (isMobile && lastMobileState === false) mobileInteractionLocked = true;
        lastMobileState = isMobile;
        const showControl = visible && chartInitialized && !editing && !cameraTransitioning && activeMode === '3d' && isMobile;
        const locked = activeMode !== '3d' || cameraTransitioning || (isMobile && mobileInteractionLocked);
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
            const sceneSurface = activeMode === '3d' && !editing && !webglUnavailable && !plotlyUnavailable;
            onModeChange(activeMode, {
                forced: !!forced,
                preferredMode,
                surface: sceneSurface ? 'scene' : 'editor2d',
                transitioning: cameraTransitioning,
                ready: sceneSurface && chartInitialized,
            });
        }
    }

    function easeCameraProgress(progress) {
        const value = clamp(progress, 0, 1);
        return value < 0.5
            ? 4 * value * value * value
            : 1 - Math.pow(-2 * value + 2, 3) / 2;
    }

    function shortestAngleDelta(start, end) {
        let delta = end - start;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        return delta;
    }

    function sphericalEye(eye) {
        const radius = Math.max(0.001, vectorLength(eye));
        return {
            radius,
            azimuth: Math.atan2(eye.y, eye.x),
            elevation: Math.asin(clamp(eye.z / radius, -1, 1)),
        };
    }

    function cameraAlongModePath(perspectiveCamera, progress) {
        const target = sphericalEye(perspectiveCamera.eye);
        const topDown = sphericalEye(TOP_DOWN_CAMERA.eye);
        const pathProgress = clamp(progress, 0, 1);
        const tiltProgress = easeCameraProgress(clamp(pathProgress / 0.72, 0, 1));
        const orbitProgress = easeCameraProgress(clamp((pathProgress - 0.18) / 0.82, 0, 1));
        const azimuth = TOP_DOWN_ORBIT_AZIMUTH
            + shortestAngleDelta(TOP_DOWN_ORBIT_AZIMUTH, target.azimuth) * orbitProgress;
        const elevation = topDown.elevation + (target.elevation - topDown.elevation) * tiltProgress;
        const topDownRadius = topDown.radius;
        const radius = Math.exp(
            Math.log(topDownRadius)
            + (Math.log(target.radius) - Math.log(topDownRadius)) * tiltProgress,
        );
        const horizontalRadius = radius * Math.cos(elevation);
        const eye = {
            x: horizontalRadius * Math.cos(azimuth),
            y: horizontalRadius * Math.sin(azimuth),
            z: radius * Math.sin(elevation),
        };
        return {
            eye,
            center: { ...FIXED_CAMERA_CENTER },
            // A fixed world-Z up vector prevents the horizon roll that Plotly
            // introduces when camera.up is independently interpolated.
            up: { ...PERSPECTIVE_UP },
            projection: { type: 'perspective' },
        };
    }

    function buildModePathArcLookup(perspectiveCamera) {
        const sampleCount = 160;
        const samples = [{ progress: 0, distance: 0 }];
        let prior = cameraAlongModePath(perspectiveCamera, 0).eye;
        let distance = 0;
        for (let index = 1; index <= sampleCount; index += 1) {
            const progress = index / sampleCount;
            const eye = cameraAlongModePath(perspectiveCamera, progress).eye;
            distance += Math.hypot(
                eye.x - prior.x,
                eye.y - prior.y,
                eye.z - prior.z,
            );
            samples.push({ progress, distance });
            prior = eye;
        }
        return { samples, totalDistance: Math.max(distance, 0.001) };
    }

    function modePathDistanceFraction(lookup, progress) {
        const samples = lookup.samples;
        const scaled = clamp(progress, 0, 1) * (samples.length - 1);
        const lowIndex = Math.floor(scaled);
        const highIndex = Math.min(samples.length - 1, lowIndex + 1);
        const localProgress = scaled - lowIndex;
        const distance = samples[lowIndex].distance
            + (samples[highIndex].distance - samples[lowIndex].distance) * localProgress;
        return distance / lookup.totalDistance;
    }

    function modePathProgressAtDistance(lookup, distanceFraction) {
        const samples = lookup.samples;
        const targetDistance = clamp(distanceFraction, 0, 1) * lookup.totalDistance;
        let lowIndex = 0;
        let highIndex = samples.length - 1;
        while (lowIndex + 1 < highIndex) {
            const middle = Math.floor((lowIndex + highIndex) / 2);
            if (samples[middle].distance < targetDistance) lowIndex = middle;
            else highIndex = middle;
        }
        const low = samples[lowIndex];
        const high = samples[highIndex];
        const span = Math.max(0.000001, high.distance - low.distance);
        const localProgress = clamp((targetDistance - low.distance) / span, 0, 1);
        return low.progress + (high.progress - low.progress) * localProgress;
    }

    function smoothModeProgress(progress) {
        const value = clamp(progress, 0, 1);
        return value * value * (3 - 2 * value);
    }

    function modePathProgressForCamera(camera, perspectiveCamera) {
        if (!camera || camera.projection?.type !== 'perspective') return 0;
        const current = sphericalEye(camera.eye);
        const target = sphericalEye(perspectiveCamera.eye);
        const topDown = sphericalEye(TOP_DOWN_CAMERA.eye);
        const elevationSpan = Math.max(0.001, topDown.elevation - target.elevation);
        return clamp((topDown.elevation - current.elevation) / elevationSpan, 0, 1);
    }

    function interpolatePerspectiveCameras(startCamera, targetCamera, progress) {
        const start = sphericalEye(startCamera.eye);
        const target = sphericalEye(targetCamera.eye);
        const value = clamp(progress, 0, 1);
        const azimuth = start.azimuth + shortestAngleDelta(start.azimuth, target.azimuth) * value;
        const elevation = start.elevation + (target.elevation - start.elevation) * value;
        const radius = Math.exp(
            Math.log(start.radius) + (Math.log(target.radius) - Math.log(start.radius)) * value,
        );
        const horizontalRadius = radius * Math.cos(elevation);
        return {
            eye: {
                x: horizontalRadius * Math.cos(azimuth),
                y: horizontalRadius * Math.sin(azimuth),
                z: radius * Math.sin(elevation),
            },
            center: { ...FIXED_CAMERA_CENTER },
            up: { ...PERSPECTIVE_UP },
            projection: { type: 'perspective' },
        };
    }

    function cancelCameraTransition(options) {
        const opts = options || {};
        const canceledModeHandoff = cameraTransitioning && cameraTransitionChangesMode;
        cameraTransitionGeneration += 1;
        cameraTransitioning = false;
        cameraTransitionChangesMode = false;
        if (cameraTransitionTimer !== null) {
            clearTimeoutFn(cameraTransitionTimer);
            cameraTransitionTimer = null;
        }
        if (surfaceTransitionTimer !== null) {
            clearTimeoutFn(surfaceTransitionTimer);
            surfaceTransitionTimer = null;
        }
        if (chart3dEl?.dataset) chart3dEl.dataset.transitioning = 'false';
        if (surfaceTransitionDirection && opts.settleSurface !== false) {
            settleSurfaceTransition(activeMode);
        }
        if (canceledModeHandoff) {
            // An interrupted scene camera is neither a completed 2D bridge nor
            // the saved 3D view. Treat native 2D as the stable anchor so the
            // next 3D request re-prepares and finishes the orbit.
            renderedCameraMode = '2d';
            lastModePathProgress = 0;
            lastModePathProgressValid = true;
        }
        syncInteractionState();
    }

    function pruneStaleSceneCanvases() {
        if (!chart3dEl || typeof chart3dEl.querySelectorAll !== 'function') return;
        const activeCanvas = chart3dEl._fullLayout?.scene?._scene?.glplot?.canvas;
        if (!activeCanvas) return;
        Array.from(chart3dEl.querySelectorAll('canvas')).forEach((canvas) => {
            if (!canvas || canvas === activeCanvas) return;
            const getContext = typeof canvas.getContext === 'function'
                ? canvas.getContext.bind(canvas)
                : null;
            try {
                canvas.remove?.();
                const context = getContext?.('webgl2')
                    || getContext?.('webgl')
                    || getContext?.('experimental-webgl');
                context?.getExtension?.('WEBGL_lose_context')?.loseContext?.();
            } catch (error) {
                // A superseded context may already have been reclaimed.
            }
        });
    }

    function issueCameraRelayout(camera, extraUpdate, options) {
        if (!chartInitialized || destroyed) return false;
        const renderer = resolvePlotly();
        if (!renderer || typeof renderer.relayout !== 'function') return false;
        const normalizedCamera = cloneCamera(camera);
        const cameraUpdate = cloneCamera(normalizedCamera);
        // Plotly rebuilds the GL3D scene whenever projection.type is included,
        // even if its value did not change. The live scene stays perspective,
        // so projection writes must be an explicit exceptional operation.
        const includeProjection = options?.includeProjection === true;
        if (!includeProjection) delete cameraUpdate.projection;
        lastIssuedCamera = cloneCamera(normalizedCamera);
        lastIssuedCameraSignature = cameraSignature(normalizedCamera);
        const update = includeProjection
            ? {
                'scene.camera': cameraUpdate,
                ...(extraUpdate || {}),
            }
            : {
                'scene.camera.eye': cameraUpdate.eye,
                'scene.camera.center': cameraUpdate.center,
                'scene.camera.up': cameraUpdate.up,
                ...(extraUpdate || {}),
            };
        try {
            const callLifecycle = lifecycleGeneration;
            const callTransitionGeneration = cameraTransitionGeneration;
            const result = renderer.relayout(chart3dEl, update);
            const cleanProjectionHandoff = () => {
                if (
                    includeProjection
                    && !destroyed
                    && callLifecycle === lifecycleGeneration
                    && callTransitionGeneration === cameraTransitionGeneration
                ) {
                    pruneStaleSceneCanvases();
                }
            };
            if (result && typeof result.catch === 'function') {
                result.catch((error) => {
                    if (
                        !destroyed
                        && callLifecycle === lifecycleGeneration
                        && callTransitionGeneration === cameraTransitionGeneration
                        && options?.fatal !== false
                    ) {
                        handleRenderFailure(error);
                    }
                });
            }
            if (result && typeof result.then === 'function') {
                const cleanupResult = result.then(cleanProjectionHandoff);
                cleanupResult?.catch?.(() => {});
            } else {
                cleanProjectionHandoff();
            }
            return result || true;
        } catch (error) {
            if (options?.fatal !== false) handleRenderFailure(error);
            return false;
        }
    }

    function finishCameraTransition(generation, targetMode, targetCamera, options) {
        if (generation !== cameraTransitionGeneration || destroyed) return;
        cameraTransitionTimer = null;
        const exactCamera = targetMode === '3d'
            ? sanitizePerspectiveCamera(targetCamera)
            : sanitizeOrthographicCamera();
        const finalUpdate = {
            uirevision: getUiRevision(),
            'scene.uirevision': getSceneUiRevision(),
            ...getSceneModeRelayout(targetMode),
        };
        const settle = () => {
            if (generation !== cameraTransitionGeneration || destroyed) return;
            if (targetMode === '3d') lastPerspectiveCamera = cloneCamera(exactCamera);
            renderedCameraMode = targetMode;
            lastModePathProgress = targetMode === '3d' ? 1 : 0;
            lastModePathProgressValid = true;
            cameraTransitioning = false;
            cameraTransitionChangesMode = false;
            if (chart3dEl?.dataset) chart3dEl.dataset.transitioning = 'false';
            settleSurfaceTransition(targetMode);
            syncSurfaceVisibility();
            if (lastRenderedGeneration !== renderGeneration) {
                reactCurrentScene('mode-transition', { camera: exactCamera });
            } else {
                scheduleTargetRender(true);
            }
        };
        const finishSurface = () => {
            if (generation !== cameraTransitionGeneration || destroyed) return;
            if (targetMode === '2d' && options?.surfaceTransition !== false && !reducedMotionFn()) {
                startSurfaceFade('2d');
                surfaceTransitionTimer = setTimeoutFn(() => {
                    surfaceTransitionTimer = null;
                    settle();
                }, SURFACE_TRANSITION_DURATION_MS);
            } else {
                settle();
            }
        };
        const finalRelayout = issueCameraRelayout(
            exactCamera,
            finalUpdate,
            { fatal: true, includeProjection: false },
        );
        if (finalRelayout && typeof finalRelayout.then === 'function') {
            finalRelayout.then(finishSurface, () => {});
        } else {
            finishSurface();
        }
    }

    function startCameraTransition(previousMode, targetMode, startingCamera, options) {
        if (!chartInitialized || !canRenderScene()) return false;
        const opts = options || {};
        const toMode = normalizeMode(targetMode);
        const changesMode = normalizeMode(previousMode) !== toMode;
        const wasCameraTransitioning = cameraTransitioning;
        const wasModeHandoff = cameraTransitionChangesMode;
        const usesCanonicalModePath = changesMode && lastModePathProgressValid;
        const carriedModePathProgress = lastModePathProgress;
        const continuesVisibleScene = (
            changesMode
            && toMode === '3d'
            && wasCameraTransitioning
            && wasModeHandoff
            && usesCanonicalModePath
            && carriedModePathProgress > 0
            && carriedModePathProgress < 1
        );
        const usesSurfaceHandoff = (changesMode || opts.surfaceHandoff === true) && !continuesVisibleScene;
        cancelCameraTransition({ settleSurface: false });
        const requestedPathEndpoint = toMode === '3d' ? 1 : 0;
        if (
            changesMode
            && usesCanonicalModePath
            && Math.abs(carriedModePathProgress - requestedPathEndpoint) < 0.000001
        ) {
            // The latest request returned to the endpoint before the camera
            // ever left it (usually during the prepared-surface crossfade).
            // Restore that surface immediately instead of running a stale
            // 24 ms zero-distance handoff in the opposite direction.
            renderedCameraMode = toMode;
            lastModePathProgress = requestedPathEndpoint;
            lastModePathProgressValid = true;
            settleSurfaceTransition(toMode);
            syncSurfaceVisibility();
            if (toMode === '3d') scheduleTargetRender(true);
            return true;
        }
        if (continuesVisibleScene) settleSurfaceTransition('3d');
        const generation = ++cameraTransitionGeneration;
        cameraTransitioning = true;
        cameraTransitionChangesMode = changesMode;
        if (!usesCanonicalModePath) lastModePathProgressValid = false;
        if (chart3dEl?.dataset) chart3dEl.dataset.transitioning = 'true';
        syncInteractionState();

        if (usesSurfaceHandoff) beginSurfaceTransition(toMode);
        const perspectiveTarget = sanitizePerspectiveCamera(lastPerspectiveCamera || DEFAULT_CAMERA);
        const topDown = sanitizeOrthographicCamera();
        const startingIsPerspective = startingCamera?.projection?.type === 'perspective';
        const start = startingIsPerspective
            ? coerceCamera(startingCamera, topDown)
            : topDown;

        if (reducedMotionFn()) {
            finishCameraTransition(
                generation,
                toMode,
                toMode === '3d' ? perspectiveTarget : topDown,
                { includeProjection: false, surfaceTransition: changesMode },
            );
            return true;
        }

        const startPathProgress = usesCanonicalModePath
            ? clamp(carriedModePathProgress, 0, 1)
            : (startingIsPerspective ? modePathProgressForCamera(start, perspectiveTarget) : 0);
        const endPathProgress = toMode === '3d' ? 1 : 0;
        const modePathLookup = usesCanonicalModePath
            ? buildModePathArcLookup(perspectiveTarget)
            : null;
        const startPathDistance = modePathLookup
            ? modePathDistanceFraction(modePathLookup, startPathProgress)
            : 0;
        const endPathDistance = modePathLookup
            ? modePathDistanceFraction(modePathLookup, endPathProgress)
            : 1;
        const pathDistance = Math.abs(endPathDistance - startPathDistance);
        const transitionDuration = usesCanonicalModePath
            ? Math.max(CAMERA_TRANSITION_STEP_MS, CAMERA_TRANSITION_DURATION_MS * pathDistance)
            : CAMERA_TRANSITION_DURATION_MS;
        let startedAt = null;
        const step = () => {
            if (generation !== cameraTransitionGeneration || destroyed) return;
            if (startedAt === null) startedAt = nowFn();
            const progress = clamp((nowFn() - startedAt) / transitionDuration, 0, 1);
            if (progress >= 1) {
                finishCameraTransition(
                    generation,
                    toMode,
                    toMode === '3d' ? perspectiveTarget : topDown,
                    { includeProjection: false, surfaceTransition: changesMode },
                );
                return;
            }
            const easedProgress = usesCanonicalModePath
                ? smoothModeProgress(progress)
                : easeCameraProgress(progress);
            const pathProgress = usesCanonicalModePath
                ? modePathProgressAtDistance(
                    modePathLookup,
                    startPathDistance + (endPathDistance - startPathDistance) * easedProgress,
                )
                : null;
            const camera = usesCanonicalModePath
                ? cameraAlongModePath(perspectiveTarget, pathProgress)
                : interpolatePerspectiveCameras(
                    start,
                    changesMode && toMode === '2d' ? topDown : perspectiveTarget,
                    easedProgress,
                );
            if (usesCanonicalModePath) {
                lastModePathProgress = pathProgress;
            }
            if (!usesCanonicalModePath) lastModePathProgressValid = false;
            const relayout = issueCameraRelayout(camera, null, { fatal: true, includeProjection: false });
            const scheduleNext = () => {
                if (generation !== cameraTransitionGeneration || destroyed) return;
                cameraTransitionTimer = setTimeoutFn(step, CAMERA_TRANSITION_STEP_MS);
            };
            if (relayout && typeof relayout.then === 'function') {
                relayout.then(scheduleNext, () => {});
            } else {
                scheduleNext();
            }
        };
        const begin = () => {
            if (generation !== cameraTransitionGeneration || destroyed) return;
            const beginOrbit = () => {
                if (generation !== cameraTransitionGeneration || destroyed) return;
                startedAt = nowFn();
                cameraTransitionTimer = setTimeoutFn(step, CAMERA_TRANSITION_STEP_MS);
            };
            if (usesSurfaceHandoff && toMode === '3d') {
                // The successful 3D-to-2D handoff finishes its orbit before
                // swapping surfaces. Run that sequence in exact reverse here:
                // first reveal the prepared top-down WebGL map, then lift it
                // smoothly into the saved perspective camera.
                surfaceTransitionTimer = setTimeoutFn(() => {
                    surfaceTransitionTimer = null;
                    if (generation !== cameraTransitionGeneration || destroyed) return;
                    startSurfaceFade('3d');
                    surfaceTransitionTimer = setTimeoutFn(() => {
                        surfaceTransitionTimer = null;
                        if (generation !== cameraTransitionGeneration || destroyed) return;
                        settleSurfaceTransition('3d');
                        beginOrbit();
                    }, SURFACE_TRANSITION_DURATION_MS);
                }, CAMERA_TRANSITION_STEP_MS * 2);
            } else {
                beginOrbit();
            }
        };
        begin();
        return true;
    }

    function prepareSceneForTransition(camera, renderedMode, requestGeneration, expectedMode, onReady) {
        if (
            destroyed
            || requestGeneration !== modeRequestGeneration
            || activeMode !== expectedMode
            || !chartInitialized
        ) return false;
        if (lastRenderedGeneration === renderGeneration) {
            onReady();
            return true;
        }
        const prepared = reactCurrentScene('mode-prepare', {
            camera,
            renderedMode,
        });
        const continueWhenCurrent = () => {
            if (
                destroyed
                || requestGeneration !== modeRequestGeneration
                || activeMode !== expectedMode
                || !chartInitialized
            ) return;
            if (lastRenderedGeneration !== renderGeneration) {
                prepareSceneForTransition(camera, renderedMode, requestGeneration, expectedMode, onReady);
                return;
            }
            onReady();
        };
        if (prepared && typeof prepared.then === 'function') {
            prepared.then(continueWhenCurrent, () => {});
        } else if (prepared) {
            continueWhenCurrent();
        }
        return prepared;
    }

    function applyEffectiveMode(mode, options) {
        const opts = options || {};
        const requestGeneration = ++modeRequestGeneration;
        const normalized = normalizeMode(mode);
        if (normalized !== activeMode) cancelCameraGesture({ captureCamera: true });
        const previousMode = activeMode;
        const previousRenderedMode = renderedCameraMode;
        const startingCamera = cameraTransitioning && lastIssuedCamera
            ? cloneCamera(lastIssuedCamera)
            : previousRenderedMode === '3d'
                ? cameraForSteadyRender('3d')
                : copyTopDownCamera();
        if (previousRenderedMode === '3d' && !cameraTransitioning) {
            lastPerspectiveCamera = sanitizePerspectiveCamera(startingCamera);
        }
        const changed = normalized !== activeMode;
        if (
            cameraTransitioning
            && !cameraTransitionChangesMode
            && previousMode === '3d'
            && normalized === '2d'
        ) {
            pendingCameraTarget = cloneCamera(lastPerspectiveCamera || DEFAULT_CAMERA);
        }
        activeMode = normalized;
        if (changed && activeMode === '3d' && mobileFn()) mobileInteractionLocked = true;
        syncModeControls();
        if (changed && visible && !editing && !webglUnavailable && !plotlyUnavailable) {
            if (activeMode === '2d' && !chartInitialized) {
                // A still-pending newPlot has no usable pixels to fade back
                // from. Keep the real Cartesian map visible while the stale
                // async creation resolves harmlessly in the background.
                settleSurfaceTransition('2d');
            } else {
                beginSurfaceTransition(activeMode);
            }
        }
        syncSurfaceVisibility();

        if (visible && !editing && !webglUnavailable && !plotlyUnavailable) {
            if (chartInitialized && activeMode === '3d' && pendingCameraTarget) {
                const targetCamera = cloneCamera(pendingCameraTarget);
                lastPerspectiveCamera = targetCamera;
                if (cameraTransitioning) {
                    // Supersede an in-flight reverse orbit before reconciling a
                    // dirty scene. reactCurrentScene intentionally refuses to
                    // race camera relayouts, and the pending Reset target must
                    // survive until preparation actually completes.
                    cancelCameraTransition();
                    beginSurfaceTransition('3d');
                    syncSurfaceVisibility();
                }
                prepareSceneForTransition(
                    startingCamera,
                    previousRenderedMode,
                    requestGeneration,
                    activeMode,
                    () => {
                        if (requestGeneration !== modeRequestGeneration || activeMode !== '3d') return;
                        pendingCameraTarget = null;
                        startCameraTransition('3d', '3d', startingCamera, { surfaceHandoff: true });
                    },
                );
            } else if (chartInitialized && (activeMode !== renderedCameraMode || cameraTransitioning)) {
                const startRequestedTransition = () => {
                    if (requestGeneration !== modeRequestGeneration || activeMode !== normalized) return;
                    startCameraTransition(previousMode, activeMode, startingCamera);
                };
                if (cameraTransitioning) startRequestedTransition();
                else prepareSceneForTransition(
                    startingCamera,
                    previousRenderedMode,
                    requestGeneration,
                    activeMode,
                    startRequestedTransition,
                );
            } else if (!chartInitialized && activeMode === '3d') {
                const created = ensureChart({
                    camera: copyTopDownCamera(),
                    // A freshly prepared bridge camera is logically the 2D
                    // end of the handoff even if an older WebGL scene had
                    // previously completed in 3D before context loss.
                    renderedMode: previousMode,
                });
                const startAfterCreate = () => {
                    if (
                        !destroyed
                        && requestGeneration === modeRequestGeneration
                        && activeMode === '3d'
                        && chartInitialized
                        && renderedCameraMode !== activeMode
                    ) {
                        const preparedMode = renderedCameraMode;
                        prepareSceneForTransition(
                            copyTopDownCamera(),
                            preparedMode,
                            requestGeneration,
                            activeMode,
                            () => startCameraTransition(preparedMode, activeMode, copyTopDownCamera()),
                        );
                    }
                };
                if (created && typeof created.then === 'function') created.then(startAfterCreate, () => {});
                else if (created) startAfterCreate();
            } else if (chartInitialized && changed) {
                // Editing can temporarily show the native 2D surface while the
                // already-prepared 3D camera remains current. Restoring that
                // preference needs only a surface crossfade, not another
                // camera orbit.
                const startSurfaceOnlyTransition = () => {
                    if (requestGeneration !== modeRequestGeneration || activeMode !== normalized) return;
                    startSurfaceFade(activeMode);
                    if (reducedMotionFn()) {
                        settleSurfaceTransition(activeMode);
                        syncSurfaceVisibility();
                    } else {
                        surfaceTransitionTimer = setTimeoutFn(() => {
                            surfaceTransitionTimer = null;
                            settleSurfaceTransition(activeMode);
                            syncSurfaceVisibility();
                        }, SURFACE_TRANSITION_DURATION_MS);
                    }
                };
                prepareSceneForTransition(
                    startingCamera,
                    renderedCameraMode,
                    requestGeneration,
                    activeMode,
                    startSurfaceOnlyTransition,
                );
            }
        } else {
            cancelCameraTransition();
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
        if (!visible) {
            cancelCameraGesture({ captureCamera: true });
            if (cameraTransitioning && !cameraTransitionChangesMode && activeMode === '3d') {
                pendingCameraTarget = cloneCamera(lastPerspectiveCamera || DEFAULT_CAMERA);
            }
            modeRequestGeneration += 1;
            syncSurfaceVisibility();
            if (mobileFn()) mobileInteractionLocked = true;
            syncInteractionState();
            cancelCameraTransition();
            cancelScheduledRender();
            return activeMode;
        }
        if (activeMode === '3d' && chartInitialized && pendingCameraTarget) {
            const requestGeneration = ++modeRequestGeneration;
            const startingCamera = cameraForSteadyRender('3d') || lastIssuedCamera || copyCamera();
            lastPerspectiveCamera = cloneCamera(pendingCameraTarget);
            pendingCameraTarget = null;
            prepareSceneForTransition(
                startingCamera,
                '3d',
                requestGeneration,
                '3d',
                () => {
                    if (requestGeneration !== modeRequestGeneration || activeMode !== '3d') return;
                    syncSurfaceVisibility();
                    startCameraTransition('3d', '3d', startingCamera);
                },
            );
            return activeMode;
        }
        if (
            activeMode === '3d'
            && chartInitialized
            && renderedCameraMode === '3d'
            && lastRenderedGeneration !== renderGeneration
        ) {
            const requestGeneration = ++modeRequestGeneration;
            const camera = cameraForSteadyRender('3d');
            beginSurfaceTransition('3d');
            syncSurfaceVisibility();
            prepareSceneForTransition(
                camera,
                '3d',
                requestGeneration,
                '3d',
                () => {
                    if (requestGeneration !== modeRequestGeneration || activeMode !== '3d') return;
                    startSurfaceFade('3d');
                    if (reducedMotionFn()) {
                        settleSurfaceTransition('3d');
                        syncSurfaceVisibility();
                    } else {
                        surfaceTransitionTimer = setTimeoutFn(() => {
                            surfaceTransitionTimer = null;
                            settleSurfaceTransition('3d');
                            syncSurfaceVisibility();
                        }, SURFACE_TRANSITION_DURATION_MS);
                    }
                },
            );
            return activeMode;
        }
        if (activeMode === '3d' && chartInitialized && renderedCameraMode !== '3d') {
            const requestGeneration = ++modeRequestGeneration;
            const bridgeCamera = copyTopDownCamera();
            beginSurfaceTransition('3d');
            syncSurfaceVisibility();
            prepareSceneForTransition(
                bridgeCamera,
                '2d',
                requestGeneration,
                '3d',
                () => startCameraTransition('2d', '3d', bridgeCamera),
            );
            return activeMode;
        }
        syncSurfaceVisibility();
        if (activeMode === '3d') {
            ensureChart();
        }
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
            hoverinfo: 'skip',
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

    function buildSensorTraces() {
        const origin = {
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
        return [origin];
    }

    function buildFloorGridTrace(bounds) {
        const divisions = 5;
        const x = [];
        const y = [];
        const z = [];
        const appendLine = (x1, y1, x2, y2) => {
            x.push(x1, x2, null);
            y.push(y1, y2, null);
            z.push(bounds.zMin, bounds.zMin, null);
        };
        for (let index = 0; index <= divisions; index += 1) {
            const ratio = index / divisions;
            const xValue = bounds.xMin + ((bounds.xMax - bounds.xMin) * ratio);
            const yValue = bounds.yMin + ((bounds.yMax - bounds.yMin) * ratio);
            appendLine(xValue, bounds.yMin, xValue, bounds.yMax);
            appendLine(bounds.xMin, yValue, bounds.xMax, yValue);
        }
        return {
            type: 'scatter3d',
            mode: 'lines',
            x,
            y,
            z,
            // GL3D line shaders emphasize RGB luminance even at tiny alpha
            // values, so use a deliberately dark slate for a quiet floor cue.
            line: { color: 'rgb(42, 61, 72)', width: 1 },
            hoverinfo: 'skip',
            showlegend: false,
            connectgaps: false,
            name: 'Floor grid',
        };
    }

    function buildStaticTraces(model) {
        const traces = [];
        const { zones, visibility, fovBounds } = model;
        const displayBounds = model.displayBounds || model.bounds;
        if (visibility.grid) traces.push(buildFloorGridTrace(displayBounds));
        if (visibility.fov && zonesApi && typeof zonesApi.buildFov3DTraces === 'function') {
            traces.push(...(zonesApi.buildFov3DTraces({
                xMin: displayBounds.xMin,
                xMax: displayBounds.xMax,
                yMax: Math.min(600, Math.max(0, displayBounds.yMax)),
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
        traces.push(...buildSensorTraces());
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
                missingZValue: activeMode === '2d' ? 0 : null,
            },
        ) || [];
    }

    function getUiRevision() {
        return `switch-studio-radar-3d:${activeDevice}:${cameraRevision}`;
    }

    function getSceneUiRevision() {
        const bounds = sceneModel.renderBounds || sceneModel.bounds;
        return `${getUiRevision()}:scene:${[
            bounds.xMin,
            bounds.xMax,
            bounds.yMin,
            bounds.yMax,
            bounds.zMin,
            bounds.zMax,
        ].join(',')}`;
    }

    function getSceneAspectRatio() {
        const bounds = sceneModel.renderBounds || sceneModel.bounds;
        const xSpan = bounds.xMax - bounds.xMin;
        const ySpan = bounds.yMax - bounds.yMin;
        const horizontalMax = Math.max(xSpan, ySpan);
        return {
            x: xSpan / horizontalMax,
            y: ySpan / horizontalMax,
            z: 1,
        };
    }

    function getSceneModeRelayout(mode) {
        const bounds = sceneModel.renderBounds || sceneModel.bounds;
        return {
            'scene.xaxis.range': [bounds.xMin, bounds.xMax],
            'scene.yaxis.range': [bounds.yMin, bounds.yMax],
            'scene.zaxis.range': [bounds.zMin, bounds.zMax],
            'scene.zaxis.visible': true,
            'scene.aspectmode': 'manual',
            'scene.aspectratio': getSceneAspectRatio(),
            'scene.dragmode': normalizeMode(mode) === '3d' ? 'turntable' : false,
        };
    }

    function axisLayout(title, range, showGrid, options) {
        const opts = options || {};
        const showPlane = opts.showPlane !== false;
        return {
            title: { text: title, font: { color: '#a8bac8', size: 11 } },
            range: range.slice(),
            showgrid: showGrid && showPlane,
            showline: true,
            zeroline: showGrid && showPlane,
            // Plotly's GL3D axes flatten translucent colors differently across
            // GPUs. Low-luminance opaque colors stay consistently subdued.
            gridcolor: 'rgb(45, 64, 76)',
            zerolinecolor: 'rgb(61, 82, 94)',
            linecolor: 'rgb(52, 72, 84)',
            tickfont: { color: '#8ea4b4', size: 9 },
            nticks: mobileFn() ? 5 : 7,
            ticksuffix: ' cm',
            showbackground: showGrid && showPlane,
            backgroundcolor: 'rgb(12, 20, 28)',
            showspikes: false,
            spikesides: false,
        };
    }

    function buildLayout(options) {
        const opts = options || {};
        const { visibility } = sceneModel;
        const bounds = sceneModel.renderBounds || sceneModel.bounds;
        const revision = getUiRevision();
        const mobile = mobileFn();
        const zAxis = axisLayout('Height (cm)', [bounds.zMin, bounds.zMax], visibility.grid, {
            showPlane: false,
        });
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
                // Let new configured room bounds replace stale axis ranges;
                // the explicit camera still preserves this device's view.
                uirevision: getSceneUiRevision(),
                bgcolor: 'rgba(0, 0, 0, 0)',
                aspectmode: 'manual',
                aspectratio: getSceneAspectRatio(),
                dragmode: activeMode === '3d' ? 'turntable' : false,
                camera: opts.camera || cameraForMode(activeMode),
                xaxis: axisLayout('Width (cm)', [bounds.xMin, bounds.xMax], visibility.grid),
                yaxis: axisLayout('Depth (cm)', [bounds.yMin, bounds.yMax], visibility.grid),
                zaxis: zAxis,
            },
        };
    }

    function buildConfig() {
        return {
            responsive: true,
            // Wheel zoom is app-owned in perspective mode so horizontal
            // gestures cannot roll the room plane or pan its fixed focus.
            scrollZoom: false,
            displayModeBar: false,
            displaylogo: false,
        };
    }

    function assembleTraces() {
        return [...staticTraces, ...buildTargetTraces()];
    }

    function canRenderScene() {
        return !destroyed
            && visible
            && !editing
            && !webglUnavailable
            && !plotlyUnavailable
            && (activeMode === '3d' || !!surfaceTransitionDirection || cameraTransitioning)
            && !!chart3dEl;
    }

    function resolvePlotly() {
        if (plotly) return plotly;
        const browserWindow = getWindow();
        plotly = browserWindow?.Plotly || null;
        return plotly;
    }

    function handleRenderFailure(error, message) {
        cancelCameraGesture({ captureCamera: false, clearDeferred: true });
        chartCreationPromise = null;
        chartInitialized = false;
        fullRenderInFlight = false;
        plotlyUnavailable = true;
        cancelScheduledRender();
        syncModeControls();
        applyEffectiveMode('2d', { forced: true });
        setStatus(
            message || 'The enhanced radar is unavailable in this browser. Showing the Cartesian 2D radar instead.',
            'error',
        );
        const browserWindow = getWindow();
        if (browserWindow?.console && error) browserWindow.console.warn('Enhanced radar render failed', error);
    }

    function reactCurrentScene(reason, options) {
        if (!canRenderScene() || !chartInitialized || cameraTransitioning) return false;
        if (cameraGestureActive) {
            cameraGestureDeferredRender = true;
            return false;
        }
        const renderer = resolvePlotly();
        if (!renderer || typeof renderer.react !== 'function') {
            handleRenderFailure(null);
            return false;
        }
        try {
            cameraGestureDeferredRender = false;
            const renderLifecycle = lifecycleGeneration;
            const renderAttempt = ++renderAttemptGeneration;
            const renderedGeneration = renderGeneration;
            const resetCamera = reason === 'device' || reason === 'device-reset';
            const layoutOptions = { ...(options || {}) };
            const resultingCameraMode = layoutOptions.renderedMode
                ? normalizeMode(layoutOptions.renderedMode)
                : activeMode;
            delete layoutOptions.renderedMode;
            if (!layoutOptions.camera && !resetCamera) {
                // Plotly's layout camera can lag behind a native orbit even
                // after plotly_relayout reports the new view. The controller's
                // remembered camera is therefore authoritative for every
                // steady same-device render.
                layoutOptions.camera = resultingCameraMode === '3d'
                    ? cameraForSteadyRender('3d')
                    : (copyRenderedCamera('2d') || cameraForMode('2d'));
            }
            const perspectiveGenerationAtStart = perspectiveCameraGeneration;
            const requestedCamera = layoutOptions.camera ? cloneCamera(layoutOptions.camera) : null;
            fullRenderInFlight = true;
            const result = renderer.react(
                chart3dEl,
                assembleTraces(),
                buildLayout(layoutOptions),
                buildConfig(),
            );
            const finalizeRender = () => {
                if (
                    destroyed
                    || renderLifecycle !== lifecycleGeneration
                    || renderAttempt !== renderAttemptGeneration
                ) return null;
                fullRenderInFlight = false;
                pruneStaleSceneCanvases();
                if (reason === 'targets') lastTargetRenderAt = nowFn();
                renderedCameraMode = resultingCameraMode;
                lastModePathProgress = resultingCameraMode === '3d' ? 1 : 0;
                lastModePathProgressValid = true;
                lastRenderedGeneration = renderedGeneration;
                if (
                    resultingCameraMode === '3d'
                    && !cameraTransitioning
                    && perspectiveCameraGeneration !== perspectiveGenerationAtStart
                ) {
                    const latestCamera = cameraForMode('3d');
                    if (!requestedCamera || !cameraNearlyEqual(requestedCamera, latestCamera)) {
                        issueCameraRelayout(latestCamera, null, { fatal: false, includeProjection: false });
                    }
                }
                return chart3dEl;
            };
            if (result && typeof result.then === 'function') {
                return result.then(finalizeRender, (error) => {
                    if (
                        !destroyed
                        && renderLifecycle === lifecycleGeneration
                        && renderAttempt === renderAttemptGeneration
                    ) {
                        fullRenderInFlight = false;
                        handleRenderFailure(error);
                    }
                    return null;
                });
            }
            finalizeRender();
            return true;
        } catch (error) {
            fullRenderInFlight = false;
            handleRenderFailure(error);
            return false;
        }
    }

    function restyleTargets() {
        if (!canRenderScene() || !chartInitialized || cameraTransitioning) return false;
        if (cameraGestureActive && cameraGestureDeferredRender) return false;
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

    function ensureChart(options) {
        const opts = options || {};
        if (!canRenderScene()) return null;
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
            // Plotly.newPlot purges graphDiv emitter listeners. Clear our
            // bookkeeping first so finalize always binds plotly_relayout to
            // the newly created scene (not a listener removed by the purge).
            unbindPlotlyRelayout();
            const creationGeneration = renderGeneration;
            const creationLifecycle = lifecycleGeneration;
            const creationMode = activeMode;
            const creationCamera = opts.camera || cameraForMode(creationMode);
            const result = renderer.newPlot(
                chart3dEl,
                assembleTraces(),
                buildLayout({ camera: creationCamera }),
                buildConfig(),
            );
            const finalize = () => {
                if (destroyed || creationLifecycle !== lifecycleGeneration) return null;
                chartInitialized = true;
                renderedCameraMode = opts.renderedMode
                    ? normalizeMode(opts.renderedMode)
                    : creationMode;
                lastModePathProgress = renderedCameraMode === '3d' ? 1 : 0;
                lastModePathProgressValid = true;
                chartCreationPromise = null;
                bindPlotlyRelayout();
                lastTargetRenderAt = nowFn();
                lastRenderedGeneration = creationGeneration;
                if (activeMode !== '3d' || editing) {
                    settleSurfaceTransition('2d');
                    syncSurfaceVisibility();
                    return chart3dEl;
                }
                syncSurfaceVisibility();
                if (canRenderScene()) resizeChart();
                if (canRenderScene() && creationGeneration !== renderGeneration) {
                    // Device, zone, or target state may have changed while
                    // WebGL initialized. Reconcile before the prepared scene
                    // is allowed to fade in, while preserving its bridge
                    // camera and logical 2D rendered state.
                    return reactCurrentScene('post-create', {
                        camera: creationCamera,
                        renderedMode: opts.renderedMode || creationMode,
                    });
                }
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
        if (!canRenderScene() || cameraTransitioning) return;
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
        if (canRenderScene() && !cameraTransitioning) {
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
        } else if (canRenderScene()) {
            ensureChart();
        }
        return sceneModel;
    }

    function resizeChart() {
        if (!canRenderScene() || !chartInitialized) return;
        if (cameraGestureActive) {
            cameraGestureDeferredResize = true;
            return;
        }
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
        cancelCameraGesture({ captureCamera: false });
        modeRequestGeneration += 1;
        pendingCameraTarget = null;
        activeDevice = normalized;
        cancelCameraTransition();
        cameraRevision = 0;
        lastPerspectiveCamera = copyCamera();
        perspectiveCameraAuthoritative = false;
        perspectiveCameraGeneration += 1;
        lastModePathProgress = activeMode === '3d' ? 1 : 0;
        lastModePathProgressValid = true;
        latestSnapshot = { reason: 'device-change', targets: [], history: {} };
        renderGeneration += 1;
        lastTargetRenderAt = -Infinity;
        cancelScheduledRender();
        if (canRenderScene() && chartInitialized) renderCurrentScene('device');
        return activeDevice;
    }

    function resetView() {
        if (
            !canRenderScene()
            || !chartInitialized
            || activeMode !== '3d'
            || !!surfaceTransitionDirection
        ) return false;
        cancelCameraGesture({ captureCamera: true });
        const currentCamera = cameraForSteadyRender('3d');
        pendingCameraTarget = null;
        cancelCameraTransition();
        cameraRevision += 1;
        lastPerspectiveCamera = copyCamera();
        perspectiveCameraGeneration += 1;
        perspectiveCameraAuthoritative = true;
        return startCameraTransition('3d', '3d', currentCamera);
    }

    function resetForDeviceChange(deviceKey) {
        cancelCameraGesture({ captureCamera: false });
        modeRequestGeneration += 1;
        pendingCameraTarget = null;
        if (deviceKey !== undefined) setActiveDevice(deviceKey);
        latestSnapshot = { reason: 'device-reset', targets: [], history: {} };
        sceneModel = normalizeSceneModel({});
        sceneSignature = '';
        staticTraces = buildStaticTraces(sceneModel);
        renderGeneration += 1;
        cameraRevision += 1;
        cancelCameraTransition();
        lastPerspectiveCamera = copyCamera();
        perspectiveCameraAuthoritative = false;
        perspectiveCameraGeneration += 1;
        lastModePathProgress = activeMode === '3d' ? 1 : 0;
        lastModePathProgressValid = true;
        lastTargetRenderAt = -Infinity;
        cancelScheduledRender();
        if (canRenderScene() && chartInitialized) renderCurrentScene('device-reset');
        return activeDevice;
    }

    function handleWebglLost(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        cancelCameraGesture({ captureCamera: true });
        // Invalidate any pending newPlot attempt. Its promise may settle after
        // the browser has restored WebGL and a replacement chart is active.
        lifecycleGeneration += 1;
        renderAttemptGeneration += 1;
        cancelCameraTransition();
        webglUnavailable = true;
        chartInitialized = false;
        chartCreationPromise = null;
        cancelScheduledRender();
        syncModeControls();
        applyEffectiveMode('2d', { forced: true });
        setStatus('The live radar lost its graphics context. Showing the Cartesian 2D radar instead.', 'error');
    }

    function handleWebglRestored() {
        webglUnavailable = false;
        plotlyUnavailable = false;
        chartInitialized = false;
        chartCreationPromise = null;
        syncModeControls();
        if (!editing) applyEffectiveMode(preferredMode, { announce: true });
    }

    function coerceCamera(rawCamera, fallbackCamera) {
        const fallback = fallbackCamera || cameraForMode(activeMode);
        const source = rawCamera || {};
        const readVector = (name) => ({
            x: toFinite(source[name]?.x, fallback[name].x),
            y: toFinite(source[name]?.y, fallback[name].y),
            z: toFinite(source[name]?.z, fallback[name].z),
        });
        return {
            eye: readVector('eye'),
            center: readVector('center'),
            up: readVector('up'),
            projection: {
                type: source.projection?.type === 'orthographic'
                    ? 'orthographic'
                    : (fallback.projection?.type || 'perspective'),
            },
        };
    }

    function cameraFromRelayoutEvent(event) {
        if (!event || typeof event !== 'object') return null;
        if (event['scene.camera'] && typeof event['scene.camera'] === 'object') {
            return event['scene.camera'];
        }
        const cameraKeys = Object.keys(event).filter((key) => key.startsWith('scene.camera.'));
        if (!cameraKeys.length) return null;
        const fallback = activeMode === '3d'
            ? cameraForSteadyRender('3d')
            : (copyRenderedCamera('2d') || cameraForMode('2d'));
        const camera = cloneCamera(fallback);
        cameraKeys.forEach((key) => {
            const parts = key.split('.').slice(2);
            if (parts.length === 2 && ['eye', 'center', 'up'].includes(parts[0]) && ['x', 'y', 'z'].includes(parts[1])) {
                camera[parts[0]][parts[1]] = event[key];
            } else if (parts.join('.') === 'projection.type') {
                camera.projection.type = event[key];
            }
        });
        return camera;
    }

    function rememberPerspectiveCamera(rawCamera) {
        const observed = coerceCamera(rawCamera, cameraForMode('3d'));
        const corrected = sanitizePerspectiveCamera(observed);
        lastPerspectiveCamera = cloneCamera(corrected);
        perspectiveCameraGeneration += 1;
        perspectiveCameraAuthoritative = true;
        lastModePathProgress = 1;
        lastModePathProgressValid = true;
        return { observed, corrected };
    }

    function rememberGestureCamera(rawCamera) {
        if (!rawCamera || activeMode !== '3d') return null;
        const remembered = rememberPerspectiveCamera(rawCamera);
        cameraGestureCamera = cloneCamera(remembered.corrected);
        return remembered;
    }

    function handlePlotlyRelayouting(event) {
        if (!cameraGestureActive || destroyed || !chartInitialized || cameraTransitioning) return;
        const rawCamera = cameraFromRelayoutEvent(event);
        if (!rawCamera || cameraSignature(rawCamera) === lastIssuedCameraSignature) return;
        rememberGestureCamera(rawCamera);
    }

    function handlePlotlyRelayout(event) {
        const rawCamera = cameraFromRelayoutEvent(event);
        if (!rawCamera || destroyed || !chartInitialized) return;
        const fallback = cameraForMode(activeMode);
        const observed = coerceCamera(rawCamera, fallback);
        if (cameraSignature(observed) === lastIssuedCameraSignature) return;

        if (cameraTransitioning) return;
        if (cameraGestureActive && activeMode === '3d') {
            rememberGestureCamera(observed);
            scheduleCameraGestureEnd();
            return;
        }

        const corrected = activeMode === '3d'
            ? rememberPerspectiveCamera(observed).corrected
            : sanitizeOrthographicCamera();
        if (cameraNearlyEqual(observed, corrected)) return;

        // Each raw relayout describes what Plotly has already rendered. Never
        // drop a newer unsafe camera while an earlier correction is settling;
        // issued-camera signatures and the near-equality check prevent loops.
        issueCameraRelayout(corrected, null, { fatal: false });
    }

    function bindPlotlyRelayout() {
        if (plotlyRelayoutBindings.length || !chart3dEl || typeof chart3dEl.on !== 'function') return;
        const bindings = [
            { eventName: 'plotly_relayouting', handler: handlePlotlyRelayouting },
            { eventName: 'plotly_relayout', handler: handlePlotlyRelayout },
        ];
        bindings.forEach((binding) => chart3dEl.on(binding.eventName, binding.handler));
        plotlyRelayoutBindings = bindings.map((binding) => ({ element: chart3dEl, ...binding }));
    }

    function unbindPlotlyRelayout() {
        plotlyRelayoutBindings.forEach((binding) => {
            if (typeof binding.element?.removeListener === 'function') {
                binding.element.removeListener(binding.eventName, binding.handler);
            }
        });
        plotlyRelayoutBindings = [];
    }

    function clearCameraGestureEndTimer() {
        if (cameraGestureEndTimer === null) return;
        clearTimeoutFn(cameraGestureEndTimer);
        cameraGestureEndTimer = null;
    }

    function setCameraGestureState(active) {
        cameraGestureActive = active === true;
        if (chart3dEl?.dataset) chart3dEl.dataset.cameraGesture = cameraGestureActive ? 'active' : 'idle';
    }

    function cancelCameraGesture(options) {
        const opts = options || {};
        const hadGesture = cameraGestureActive || cameraGestureEndTimer !== null;
        if (hadGesture && opts.captureCamera !== false && activeMode === '3d' && chartInitialized) {
            const captured = cameraGestureCamera || copyRenderedCamera('3d');
            if (captured) rememberPerspectiveCamera(captured);
        }
        cameraGestureGeneration += 1;
        clearCameraGestureEndTimer();
        setCameraGestureState(false);
        cameraGestureCamera = null;
        cameraGestureDeferredResize = false;
        if (opts.clearDeferred !== false) cameraGestureDeferredRender = false;
        if (hadGesture) renderAttemptGeneration += 1;
        return hadGesture;
    }

    function beginCameraGesture() {
        if (cameraGestureActive) return true;
        clearCameraGestureEndTimer();
        cameraGestureGeneration += 1;
        setCameraGestureState(true);
        cameraGestureCamera = null;
        if (fullRenderInFlight) {
            cameraGestureDeferredRender = true;
            fullRenderInFlight = false;
        }
        // A React that started just before pointer-down may settle after the
        // orbit has moved. Its finalizer must not restore that earlier camera.
        renderAttemptGeneration += 1;
        if (!perspectiveCameraAuthoritative) {
            const renderedCamera = copyRenderedCamera('3d');
            if (renderedCamera) rememberPerspectiveCamera(renderedCamera);
        }
        cancelCameraTransition();
        return true;
    }

    function finishCameraGesture(generation) {
        if (
            generation !== cameraGestureGeneration
            || !cameraGestureActive
            || destroyed
        ) return false;
        clearCameraGestureEndTimer();
        const captured = cameraGestureCamera
            || copyRenderedCamera('3d')
            || lastPerspectiveCamera
            || DEFAULT_CAMERA;
        const { corrected } = rememberPerspectiveCamera(captured);
        const needsFullRender = cameraGestureDeferredRender;
        const needsTargetRender = !needsFullRender && lastRenderedGeneration !== renderGeneration;
        const needsResize = cameraGestureDeferredResize;
        cancelScheduledRender();
        setCameraGestureState(false);
        cameraGestureCamera = null;
        cameraGestureDeferredRender = false;
        cameraGestureDeferredResize = false;

        if (!canRenderScene() || activeMode !== '3d' || !chartInitialized) return false;
        if (needsFullRender) {
            reactCurrentScene('gesture-reconcile', {
                camera: corrected,
                renderedMode: '3d',
            });
        } else {
            // Reassert the sanitized fixed-center, world-Z-up camera only after
            // Plotly has finished its native orbit gesture.
            issueCameraRelayout(corrected, null, { fatal: false, includeProjection: false });
            if (needsTargetRender) scheduleTargetRender(true);
        }
        if (needsResize) resizeChart();
        return true;
    }

    function scheduleCameraGestureEnd() {
        if (!cameraGestureActive) return false;
        clearCameraGestureEndTimer();
        const generation = cameraGestureGeneration;
        cameraGestureEndTimer = setTimeoutFn(() => finishCameraGesture(generation), 0);
        return true;
    }

    function cameraInteractionEnabled() {
        return canRenderScene()
            && chartInitialized
            && activeMode === '3d'
            && !(mobileFn() && mobileInteractionLocked);
    }

    function stopCameraGesture(event) {
        event?.preventDefault?.();
        event?.stopImmediatePropagation?.();
        event?.stopPropagation?.();
    }

    function handleCameraMouseDown(event) {
        if (!cameraInteractionEnabled()) return;
        if (Number(event?.button) === 2 || event?.ctrlKey) {
            stopCameraGesture(event);
            return;
        }
        beginCameraGesture();
    }

    function handleCameraWheel(event) {
        if (!cameraInteractionEnabled()) return;
        const deltaX = toFinite(event?.deltaX, 0);
        const deltaY = toFinite(event?.deltaY, 0);
        if (Math.abs(deltaX) > Math.abs(deltaY)) {
            stopCameraGesture(event);
            return;
        }
        if (Math.abs(deltaY) < 0.01) return;
        stopCameraGesture(event);
        if (cameraGestureActive) finishCameraGesture(cameraGestureGeneration);
        cancelCameraTransition();
        const current = cameraForSteadyRender('3d');
        const factor = Math.exp(clamp(deltaY, -500, 500) * 0.0012);
        const zoomed = sanitizePerspectiveCamera({
            ...current,
            eye: {
                x: current.eye.x * factor,
                y: current.eye.y * factor,
                z: current.eye.z * factor,
            },
        });
        lastPerspectiveCamera = cloneCamera(zoomed);
        perspectiveCameraGeneration += 1;
        perspectiveCameraAuthoritative = true;
        issueCameraRelayout(zoomed, null, { fatal: false, includeProjection: false });
    }

    function handleCameraContextMenu(event) {
        if (cameraInteractionEnabled()) stopCameraGesture(event);
    }

    function handleCameraTouchStart() {
        if (cameraInteractionEnabled()) beginCameraGesture();
    }

    function handleCameraGestureEnd() {
        scheduleCameraGestureEnd();
    }

    function bindCameraGestureGuards() {
        if (!chart3dEl?.addEventListener || gestureBindings.length) return;
        const bindings = [
            { element: chart3dEl, eventName: 'pointerdown', handler: handleCameraMouseDown, options: { capture: true } },
            { eventName: 'mousedown', handler: handleCameraMouseDown, options: { capture: true } },
            { eventName: 'wheel', handler: handleCameraWheel, options: { capture: true, passive: false } },
            { eventName: 'contextmenu', handler: handleCameraContextMenu, options: { capture: true } },
            { eventName: 'touchstart', handler: handleCameraTouchStart, options: { capture: true, passive: true } },
        ].map((binding) => ({ element: chart3dEl, ...binding }));
        const endTargets = [chart3dEl, getWindow()]
            .filter((element, index, values) => (
                element
                && typeof element.addEventListener === 'function'
                && values.indexOf(element) === index
            ));
        endTargets.forEach((element) => {
            bindings.push(
                { element, eventName: 'pointerup', handler: handleCameraGestureEnd, options: { capture: true } },
                { element, eventName: 'pointercancel', handler: handleCameraGestureEnd, options: { capture: true } },
                { element, eventName: 'mouseup', handler: handleCameraGestureEnd, options: { capture: true } },
                { element, eventName: 'touchend', handler: handleCameraGestureEnd, options: { capture: true, passive: true } },
                { element, eventName: 'touchcancel', handler: handleCameraGestureEnd, options: { capture: true, passive: true } },
            );
        });
        bindings.push({
            element: chart3dEl,
            eventName: 'lostpointercapture',
            handler: handleCameraGestureEnd,
            options: { capture: true },
        });
        bindings.forEach((binding) => {
            binding.element.addEventListener(binding.eventName, binding.handler, binding.options);
        });
        gestureBindings = bindings;
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
                if (!mobileInteractionLocked && cameraGestureActive) {
                    finishCameraGesture(cameraGestureGeneration);
                }
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
        bindCameraGestureGuards();
    }

    function bindResizeObserver() {
        const browserWindow = getWindow();
        const Observer = browserWindow?.ResizeObserver
            || (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null);
        if (!Observer || !chart3dEl) return;
        try {
            resizeObserver = new Observer(() => {
                const breakpointChanged = syncInteractionState();
                if (breakpointChanged && chartInitialized) {
                    renderGeneration += 1;
                    // Plotly's responsive resize preserves the existing layout
                    // and config. Rebuild once when crossing the phone boundary
                    // so margins, scroll zoom, and the interaction lock follow
                    // the newly active input mode. Hidden 2D periods stay dirty
                    // so the next 3D handoff prepares this layout before reveal.
                    if (canRenderScene()) {
                        reactCurrentScene('breakpoint', {
                            camera: activeMode === '3d'
                                ? cameraForSteadyRender('3d')
                                : (copyRenderedCamera('2d') || cameraForMode('2d')),
                            renderedMode: renderedCameraMode,
                        });
                    }
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
        binding.element.removeEventListener(binding.eventName, binding.handler, binding.options);
    }

    function destroy() {
        lifecycleGeneration += 1;
        destroyed = true;
        cancelCameraGesture({ captureCamera: false });
        cancelCameraTransition();
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
        gestureBindings.forEach(removeBinding);
        gestureBindings = [];
        unbindPlotlyRelayout();
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
        fullRenderInFlight = false;
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
        fullRenderInFlight = false;
        mobileInteractionLocked = true;
        lastMobileState = null;
        lastPerspectiveCamera = copyCamera();
        perspectiveCameraGeneration = 0;
        perspectiveCameraAuthoritative = false;
        cameraTransitionTimer = null;
        cameraTransitionGeneration = 0;
        modeRequestGeneration = 0;
        cameraTransitioning = false;
        cameraTransitionChangesMode = false;
        pendingCameraTarget = null;
        lastIssuedCameraSignature = '';
        lastIssuedCamera = null;
        plotlyRelayoutBindings = [];
        gestureBindings = [];
        cameraGestureActive = false;
        cameraGestureGeneration = 0;
        cameraGestureEndTimer = null;
        cameraGestureCamera = null;
        cameraGestureDeferredRender = false;
        cameraGestureDeferredResize = false;
        nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
        setTimeoutFn = typeof opts.setTimeoutFn === 'function' ? opts.setTimeoutFn : (callback, delay) => setTimeout(callback, delay);
        clearTimeoutFn = typeof opts.clearTimeoutFn === 'function' ? opts.clearTimeoutFn : (timer) => clearTimeout(timer);
        mobileFn = typeof opts.isMobile === 'function' ? opts.isMobile : defaultIsMobile;
        reducedMotionFn = typeof opts.prefersReducedMotion === 'function'
            ? opts.prefersReducedMotion
            : defaultPrefersReducedMotion;

        const storedMode = safeStorageGet(STORAGE_KEY);
        preferredMode = normalizeMode(storedMode || opts.initialMode || DEFAULT_MODE);
        activeMode = preferredMode;
        renderedCameraMode = activeMode;
        lastModePathProgress = activeMode === '3d' ? 1 : 0;
        lastModePathProgressValid = true;

        if (statusEl?.setAttribute) statusEl.setAttribute('aria-live', 'polite');
        setCameraGestureState(false);
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

        if (!plotlyUnavailable) setStatus(getModeStatus(activeMode, false), 'info');
        invokeModeChange(plotlyUnavailable || webglUnavailable);
        if (visible && !editing && activeMode === '3d') ensureChart();
        return getPublicApi();
    }

    function getPublicApi() {
        return {
            init,
            normalizeDisplayHeightBounds,
            loadDisplayHeightBounds,
            saveDisplayHeightBounds,
            saveDisplayHeightBoundsForDevices,
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
