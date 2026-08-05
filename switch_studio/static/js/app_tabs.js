(function () {
    const STORAGE_KEY = 'switchStudio.activeTab';
    let tabButtons = [];
    let tabPanels = [];
    let primaryTabPanels = [];
    let activeTab = null;
    let onTabChange = null;

    function parsePanelList(raw) {
        if (!raw) return [];
        return raw
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }

    function normalizeTabName(tabName) {
        if (tabName === 'live') return 'zones';
        if (tabName === 'presence') return 'zones';
        if (tabName === 'maintenance') return 'advanced';
        return tabName;
    }

    function applyTab(tabName, options) {
        const opts = options || {};
        const normalizedTab = normalizeTabName(tabName);
        if (!normalizedTab) return;
        const changed = activeTab !== normalizedTab;
        activeTab = normalizedTab;

        tabButtons.forEach((button) => {
            const isActive = button.getAttribute('data-tab-target') === normalizedTab;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', String(isActive));
            button.setAttribute('tabindex', isActive ? '0' : '-1');
        });

        tabPanels.forEach((panel) => {
            const targets = parsePanelList(panel.getAttribute('data-tab-panels'));
            const shouldShow = targets.length === 0 || targets.includes(normalizedTab);
            panel.style.display = shouldShow ? '' : 'none';
        });

        try {
            localStorage.setItem(STORAGE_KEY, normalizedTab);
        } catch (err) {
            // Ignore storage errors (private mode / restricted browser context)
        }

        if (opts.notify !== false && (changed || opts.forceNotify) && typeof onTabChange === 'function') {
            onTabChange(normalizedTab);
        }
    }

    function getInitialTab(defaultTab) {
        try {
            const stored = normalizeTabName(localStorage.getItem(STORAGE_KEY));
            if (stored && tabButtons.some((button) => button.getAttribute('data-tab-target') === stored)) {
                return stored;
            }
        } catch (err) {
            // Ignore storage errors
        }

        const normalizedDefaultTab = normalizeTabName(defaultTab);
        if (normalizedDefaultTab && tabButtons.some((button) => button.getAttribute('data-tab-target') === normalizedDefaultTab)) {
            return normalizedDefaultTab;
        }

        if (tabButtons.length > 0) {
            return tabButtons[0].getAttribute('data-tab-target');
        }
        return null;
    }

    function init(options) {
        const opts = options || {};
        const root = opts.root || document;
        onTabChange = typeof opts.onTabChange === 'function' ? opts.onTabChange : null;
        tabButtons = Array.from(root.querySelectorAll('[data-tab-target]'));
        tabPanels = Array.from(root.querySelectorAll('[data-tab-panels]'));
        primaryTabPanels = Array.from(root.querySelectorAll('[data-tab-panel-primary]'));

        const buttonIds = new Map();
        tabButtons.forEach((button, index) => {
            const tabName = button.getAttribute('data-tab-target');
            const buttonId = button.getAttribute('id') || `switch-studio-tab-${tabName || index}`;
            button.setAttribute('id', buttonId);
            buttonIds.set(tabName, buttonId);
        });
        primaryTabPanels.forEach((panel, index) => {
            const panelId = panel.getAttribute('id') || `switch-studio-tab-panel-${index}`;
            const targets = parsePanelList(panel.getAttribute('data-tab-panels'));
            panel.setAttribute('id', panelId);
            if (targets.length > 0) {
                panel.setAttribute('role', 'tabpanel');
                panel.setAttribute(
                    'aria-labelledby',
                    targets.map((target) => buttonIds.get(target)).filter(Boolean).join(' ')
                );
            }
        });
        tabButtons.forEach((button) => {
            const tabName = button.getAttribute('data-tab-target');
            const controlledIds = primaryTabPanels
                .filter((panel) => parsePanelList(panel.getAttribute('data-tab-panels')).includes(tabName))
                .map((panel) => panel.getAttribute('id'))
                .filter(Boolean);
            if (controlledIds.length > 0) button.setAttribute('aria-controls', controlledIds.join(' '));
        });

        tabButtons.forEach((button) => {
            button.addEventListener('click', () => {
                const nextTab = button.getAttribute('data-tab-target');
                if (!nextTab || nextTab === activeTab) return;
                applyTab(nextTab);
            });
            button.addEventListener('keydown', (event) => {
                const currentIndex = tabButtons.indexOf(button);
                let nextIndex = null;
                if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabButtons.length;
                if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
                if (event.key === 'Home') nextIndex = 0;
                if (event.key === 'End') nextIndex = tabButtons.length - 1;
                if (nextIndex === null) return;
                event.preventDefault();
                const nextButton = tabButtons[nextIndex];
                applyTab(nextButton.getAttribute('data-tab-target'));
                if (typeof nextButton.focus === 'function') nextButton.focus();
            });
        });

        const initial = getInitialTab(opts.defaultTab || 'zones');
        applyTab(initial, { forceNotify: true });
    }

    window.SwitchStudioTabs = {
        init,
        setActiveTab: (tabName) => applyTab(tabName, { forceNotify: true }),
        getActiveTab: () => activeTab
    };
})();
