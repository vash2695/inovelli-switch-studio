(function () {
    function copyIfPresent(target, source, sourceKey, targetKey) {
        if (!source || !Object.prototype.hasOwnProperty.call(source, sourceKey)) return;
        target[targetKey || sourceKey] = source[sourceKey];
    }

    function normalize(payload, options) {
        if (!payload || typeof payload !== 'object') return null;
        const opts = options || {};
        const devicePayload = opts.devicePayload === true;
        const next = {};

        copyIfPresent(next, payload, 'available');
        copyIfPresent(next, payload, 'update_available', 'available');
        copyIfPresent(next, payload, 'updateAvailable', 'available');
        copyIfPresent(next, payload, 'downgrade');
        copyIfPresent(next, payload, 'installed_version');
        copyIfPresent(next, payload, 'installed_version_detail');
        copyIfPresent(next, payload, 'latest_version');
        copyIfPresent(next, payload, 'latest_version_detail');
        copyIfPresent(next, payload, 'official_versions');
        copyIfPresent(next, payload, 'last_checked');
        copyIfPresent(next, payload, 'last_error');
        copyIfPresent(next, payload, 'bridge_status');

        // A raw device payload's top-level state is load power, not OTA state.
        if (!devicePayload) {
            copyIfPresent(next, payload, 'state');
            copyIfPresent(next, payload, 'progress');
            copyIfPresent(next, payload, 'remaining');
        }

        if (payload.update && typeof payload.update === 'object') {
            const update = payload.update;
            copyIfPresent(next, update, 'available');
            copyIfPresent(next, update, 'update_available', 'available');
            copyIfPresent(next, update, 'updateAvailable', 'available');
            copyIfPresent(next, update, 'downgrade');
            copyIfPresent(next, update, 'installed_version');
            copyIfPresent(next, update, 'latest_version');
            copyIfPresent(next, update, 'installed_version_detail');
            copyIfPresent(next, update, 'latest_version_detail');
            if (Object.prototype.hasOwnProperty.call(update, 'state')) copyIfPresent(next, update, 'state');
            else copyIfPresent(next, update, 'status', 'state');
            copyIfPresent(next, update, 'progress');
            copyIfPresent(next, update, 'remaining');
            if (Object.prototype.hasOwnProperty.call(update, 'error')) copyIfPresent(next, update, 'error', 'last_error');
            else copyIfPresent(next, update, 'message', 'last_error');
        }

        return Object.keys(next).length > 0 ? next : null;
    }

    window.SwitchStudioFirmware = { normalize };
})();
