(function () {
    const STORAGE_KEY = 'switchStudio.activeTab';
    let tabButtons = [];
    let tabPanels = [];
    let primaryTabPanels = [];
    let activeTab = null;
    let onTabChange = null;
    let mobileNav = null;
    let mobileTitle = null;
    let mobileToggle = null;
    let mobileMenuOpen = false;
    let ownerDocument = null;
    let mobileMediaQuery = null;

    function activeButton() {
        return tabButtons.find((button) => button.getAttribute('data-tab-target') === activeTab) || null;
    }

    function buttonLabel(button) {
        return String(button && (button.textContent || button.innerText) || '').trim();
    }

    function updateMobileTitle() {
        if (!mobileTitle) return;
        const label = buttonLabel(activeButton());
        mobileTitle.textContent = label || 'Device settings';
    }

    function setMobileMenuOpen(open, options) {
        const opts = options || {};
        mobileMenuOpen = !!(open && mobileNav && mobileToggle);
        if (mobileNav && mobileNav.classList) {
            mobileNav.classList.toggle('mobile-menu-open', mobileMenuOpen);
        }
        if (mobileToggle) {
            mobileToggle.setAttribute('aria-expanded', String(mobileMenuOpen));
            mobileToggle.setAttribute(
                'aria-label',
                mobileMenuOpen ? 'Close section menu' : 'Open section menu'
            );
        }
        if (mobileMenuOpen && opts.focusActive) {
            const current = activeButton();
            if (current && typeof current.focus === 'function') current.focus();
        } else if (!mobileMenuOpen && opts.restoreFocus && mobileToggle && typeof mobileToggle.focus === 'function') {
            mobileToggle.focus();
        }
    }

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
        updateMobileTitle();

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
        mobileNav = opts.mobileNav || null;
        mobileTitle = opts.mobileTitle || null;
        mobileToggle = opts.mobileToggle || null;
        ownerDocument = opts.ownerDocument || (typeof document !== 'undefined' ? document : null);
        mobileMediaQuery = opts.mobileMediaQuery || (
            typeof window !== 'undefined' && typeof window.matchMedia === 'function'
                ? window.matchMedia('(max-width: 900px)')
                : null
        );
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
                if (!nextTab) return;
                if (nextTab !== activeTab) applyTab(nextTab);
                if (mobileMenuOpen) setMobileMenuOpen(false, { restoreFocus: true });
            });
            button.addEventListener('keydown', (event) => {
                if (event.key === 'Escape' && mobileMenuOpen) {
                    event.preventDefault();
                    setMobileMenuOpen(false, { restoreFocus: true });
                    return;
                }
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

        if (mobileToggle) {
            mobileToggle.addEventListener('click', () => {
                setMobileMenuOpen(!mobileMenuOpen, { focusActive: !mobileMenuOpen });
            });
            mobileToggle.addEventListener('keydown', (event) => {
                if (event.key !== 'Escape' || !mobileMenuOpen) return;
                event.preventDefault();
                setMobileMenuOpen(false, { restoreFocus: true });
            });
        }
        if (ownerDocument && typeof ownerDocument.addEventListener === 'function') {
            ownerDocument.addEventListener('pointerdown', (event) => {
                if (!mobileMenuOpen || !mobileNav || typeof mobileNav.contains !== 'function') return;
                if (mobileNav.contains(event.target)) return;
                setMobileMenuOpen(false);
            });
        }
        if (mobileMediaQuery) {
            const handleMediaChange = (event) => {
                if (!event.matches) setMobileMenuOpen(false);
            };
            if (typeof mobileMediaQuery.addEventListener === 'function') {
                mobileMediaQuery.addEventListener('change', handleMediaChange);
            } else if (typeof mobileMediaQuery.addListener === 'function') {
                mobileMediaQuery.addListener(handleMediaChange);
            }
        }

        const initial = getInitialTab(opts.defaultTab || 'zones');
        applyTab(initial, { forceNotify: true });
        setMobileMenuOpen(false);
    }

    window.SwitchStudioTabs = {
        init,
        setActiveTab: (tabName) => {
            applyTab(tabName, { forceNotify: true });
            setMobileMenuOpen(false);
        },
        closeMobileMenu: (options) => setMobileMenuOpen(false, options),
        getActiveTab: () => activeTab,
        isMobileMenuOpen: () => mobileMenuOpen,
    };
})();
