const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class MockClassList {
    constructor() {
        this.values = new Set();
    }

    toggle(name, force) {
        if (typeof force === 'undefined') {
            if (this.values.has(name)) {
                this.values.delete(name);
            } else {
                this.values.add(name);
            }
            return;
        }
        if (force) {
            this.values.add(name);
        } else {
            this.values.delete(name);
        }
    }

    contains(name) {
        return this.values.has(name);
    }
}

class MockElement {
    constructor(attributes) {
        this.attributes = { ...(attributes || {}) };
        this.classList = new MockClassList();
        this.style = { display: '' };
        this.listeners = {};
        this.focused = false;
        this.textContent = '';
        this.children = [];
    }

    getAttribute(name) {
        return this.attributes[name] ?? null;
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    addEventListener(type, callback) {
        this.listeners[type] = callback;
    }

    click() {
        if (this.listeners.click) {
            this.listeners.click();
        }
    }

    focus() {
        this.focused = true;
    }

    contains(target) {
        return target === this || this.children.includes(target);
    }
}

function loadTabsModule(options) {
    const scriptPath = path.resolve(__dirname, '../../switch_studio/static/js/app_tabs.js');
    const source = fs.readFileSync(scriptPath, 'utf8');

    const storageMap = new Map();
    if (options && options.storedTab) {
        storageMap.set('switchStudio.activeTab', options.storedTab);
    }

    const localStorage = {
        getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
        setItem: (key, value) => storageMap.set(key, String(value)),
    };

    const buttons = [
        new MockElement({ 'data-tab-target': 'zones' }),
        new MockElement({ 'data-tab-target': 'load' }),
        new MockElement({ 'data-tab-target': 'led' }),
        new MockElement({ 'data-tab-target': 'advanced' }),
    ];
    ['Presence & Zones', 'Load & Dimming', 'LED & Notifications', 'Advanced'].forEach((label, index) => {
        buttons[index].textContent = label;
    });
    const panels = [
        new MockElement({ 'data-tab-panels': 'zones', 'data-tab-panel-primary': '' }),
        new MockElement({ 'data-tab-panels': 'load', 'data-tab-panel-primary': '' }),
        new MockElement({ 'data-tab-panels': 'led', 'data-tab-panel-primary': '' }),
        new MockElement({ 'data-tab-panels': 'advanced', 'data-tab-panel-primary': '' }),
        new MockElement({ 'data-tab-panels': '' }),
    ];
    const nestedPanel = new MockElement({
        id: 'zonesPaneControls',
        role: 'tabpanel',
        'aria-labelledby': 'zonesPaneTabControls',
        'data-tab-panels': 'zones',
        'data-zones-pane': 'controls',
    });
    const nestedTabList = new MockElement({
        id: 'zonesSidebarTabs',
        role: 'tablist',
        'aria-label': 'Presence and zones sidebar views',
        'data-tab-panels': 'zones',
    });
    panels.push(nestedTabList, nestedPanel);
    const primaryPanels = panels.filter((panel) => panel.getAttribute('data-tab-panel-primary') !== null);

    const root = {
        querySelectorAll: (selector) => {
            if (selector === '[data-tab-target]') return buttons;
            if (selector === '[data-tab-panels]') return panels;
            if (selector === '[data-tab-panel-primary]') return primaryPanels;
            return [];
        },
    };

    const mobileNav = new MockElement();
    const mobileTitle = new MockElement();
    const mobileToggle = new MockElement({ 'aria-expanded': 'false' });
    mobileNav.children = [mobileToggle, ...buttons];
    const ownerDocument = {
        listeners: {},
        addEventListener(type, callback) {
            this.listeners[type] = callback;
        },
    };
    const mobileMediaQuery = {
        matches: true,
        listeners: {},
        addEventListener(type, callback) {
            this.listeners[type] = callback;
        },
    };
    const mobileOptions = { mobileNav, mobileTitle, mobileToggle, ownerDocument, mobileMediaQuery };

    const context = {
        window: {},
        document: {},
        localStorage,
        console,
    };
    context.global = context;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: scriptPath });

    return {
        tabs: context.window.SwitchStudioTabs,
        buttons,
        panels,
        nestedPanel,
        nestedTabList,
        storageMap,
        root,
        mobileNav,
        mobileTitle,
        mobileToggle,
        ownerDocument,
        mobileMediaQuery,
        mobileOptions,
    };
}

test('tab module applies default tab, toggles panels, and persists on click', () => {
    const { tabs, buttons, panels, storageMap, root } = loadTabsModule();
    tabs.init({ root, defaultTab: 'live' });

    assert.equal(tabs.getActiveTab(), 'zones');
    assert.equal(buttons[0].classList.contains('active'), true);
    assert.equal(buttons[1].classList.contains('active'), false);
    assert.equal(panels[0].style.display, '');
    assert.equal(panels[1].style.display, 'none');
    assert.equal(storageMap.get('switchStudio.activeTab'), 'zones');

    buttons[1].click();
    assert.equal(tabs.getActiveTab(), 'load');
    assert.equal(buttons[1].classList.contains('active'), true);
    assert.equal(buttons[0].classList.contains('active'), false);
    assert.equal(panels[0].style.display, 'none');
    assert.equal(panels[1].style.display, '');
    assert.equal(storageMap.get('switchStudio.activeTab'), 'load');
});

test('tab module restores persisted tab from storage', () => {
    const { tabs, buttons, panels, root } = loadTabsModule({ storedTab: 'live' });
    tabs.init({ root, defaultTab: 'live' });

    assert.equal(tabs.getActiveTab(), 'zones');
    assert.equal(buttons[0].classList.contains('active'), true);
    assert.equal(panels[0].style.display, '');
    assert.equal(panels[1].style.display, 'none');
    assert.equal(panels[2].style.display, 'none');
});

test('tab module remaps legacy maintenance tab to advanced', () => {
    const { tabs, buttons, panels, root } = loadTabsModule({ storedTab: 'maintenance' });
    tabs.init({ root, defaultTab: 'zones' });

    assert.equal(tabs.getActiveTab(), 'advanced');
    assert.equal(buttons[3].classList.contains('active'), true);
    assert.equal(buttons[0].classList.contains('active'), false);
    assert.equal(panels[3].style.display, '');
    assert.equal(panels[0].style.display, 'none');
});

test('programmatic tab changes notify the workspace callback even when forcing the active tab', () => {
    const { tabs, root } = loadTabsModule();
    const notifications = [];
    tabs.init({ root, defaultTab: 'load', onTabChange: (tab) => notifications.push(tab) });

    assert.deepEqual(notifications, ['load']);
    tabs.setActiveTab('zones');
    tabs.setActiveTab('zones');
    assert.deepEqual(notifications, ['load', 'zones', 'zones']);
});

test('tab keyboard navigation uses arrow keys and a roving tab stop', () => {
    const { tabs, buttons, root } = loadTabsModule();
    tabs.init({ root, defaultTab: 'zones' });
    let prevented = false;

    buttons[0].listeners.keydown({ key: 'ArrowRight', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(tabs.getActiveTab(), 'load');
    assert.equal(buttons[1].focused, true);
    assert.equal(buttons[0].getAttribute('tabindex'), '-1');
    assert.equal(buttons[1].getAttribute('tabindex'), '0');
});

test('top-level tab ARIA preserves nested zone tablist and tabpanel ownership', () => {
    const { tabs, buttons, panels, nestedPanel, nestedTabList, root } = loadTabsModule();
    tabs.init({ root, defaultTab: 'zones' });

    assert.equal(panels[0].getAttribute('role'), 'tabpanel');
    assert.equal(panels[0].getAttribute('aria-labelledby'), buttons[0].getAttribute('id'));
    assert.match(buttons[0].getAttribute('aria-controls'), new RegExp(panels[0].getAttribute('id')));
    assert.doesNotMatch(buttons[0].getAttribute('aria-controls'), /zonesPaneControls/);
    assert.equal(nestedTabList.getAttribute('role'), 'tablist');
    assert.equal(nestedTabList.getAttribute('aria-label'), 'Presence and zones sidebar views');
    assert.equal(nestedTabList.getAttribute('aria-labelledby'), null);
    assert.equal(nestedPanel.getAttribute('role'), 'tabpanel');
    assert.equal(nestedPanel.getAttribute('aria-labelledby'), 'zonesPaneTabControls');

    buttons[1].click();
    assert.equal(nestedTabList.style.display, 'none');
    assert.equal(nestedPanel.style.display, 'none');
    assert.equal(nestedTabList.getAttribute('role'), 'tablist');
    assert.equal(nestedPanel.getAttribute('aria-labelledby'), 'zonesPaneTabControls');
});

test('mobile section header tracks the active tab and closes after tab selection', () => {
    const { tabs, buttons, root, mobileNav, mobileTitle, mobileToggle, mobileOptions } = loadTabsModule();
    tabs.init({ root, defaultTab: 'zones', ...mobileOptions });

    assert.equal(mobileTitle.textContent, 'Presence & Zones');
    assert.equal(mobileToggle.getAttribute('aria-expanded'), 'false');

    mobileToggle.click();
    assert.equal(tabs.isMobileMenuOpen(), true);
    assert.equal(mobileNav.classList.contains('mobile-menu-open'), true);
    assert.equal(mobileToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(buttons[0].focused, true);

    mobileToggle.focused = false;
    buttons[1].click();
    assert.equal(tabs.getActiveTab(), 'load');
    assert.equal(mobileTitle.textContent, 'Load & Dimming');
    assert.equal(tabs.isMobileMenuOpen(), false);
    assert.equal(mobileToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(mobileToggle.focused, true);
});

test('mobile section disclosure closes on active-tab click and Escape', () => {
    const { tabs, buttons, root, mobileToggle, mobileOptions } = loadTabsModule();
    tabs.init({ root, defaultTab: 'zones', ...mobileOptions });

    mobileToggle.click();
    mobileToggle.focused = false;
    buttons[0].click();
    assert.equal(tabs.getActiveTab(), 'zones');
    assert.equal(tabs.isMobileMenuOpen(), false);
    assert.equal(mobileToggle.focused, true);

    mobileToggle.focused = false;
    mobileToggle.click();
    let prevented = false;
    buttons[0].listeners.keydown({ key: 'Escape', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(tabs.isMobileMenuOpen(), false);
    assert.equal(mobileToggle.focused, true);
});

test('mobile section arrow navigation stays open while updating the page title', () => {
    const { tabs, buttons, root, mobileTitle, mobileToggle, mobileOptions } = loadTabsModule();
    tabs.init({ root, defaultTab: 'zones', ...mobileOptions });
    mobileToggle.click();

    buttons[0].listeners.keydown({ key: 'ArrowRight', preventDefault() {} });

    assert.equal(tabs.isMobileMenuOpen(), true);
    assert.equal(tabs.getActiveTab(), 'load');
    assert.equal(mobileTitle.textContent, 'Load & Dimming');
    assert.equal(buttons[1].focused, true);
    assert.equal(mobileToggle.getAttribute('aria-expanded'), 'true');
});

test('outside pointer and desktop transition dismiss the mobile disclosure without stealing focus', () => {
    const {
        tabs, root, mobileToggle, ownerDocument, mobileMediaQuery, mobileOptions,
    } = loadTabsModule();
    tabs.init({ root, defaultTab: 'zones', ...mobileOptions });

    mobileToggle.click();
    mobileToggle.focused = false;
    ownerDocument.listeners.pointerdown({ target: {} });
    assert.equal(tabs.isMobileMenuOpen(), false);
    assert.equal(mobileToggle.focused, false);

    mobileToggle.click();
    mobileToggle.focused = false;
    mobileMediaQuery.listeners.change({ matches: false });
    assert.equal(tabs.isMobileMenuOpen(), false);
    assert.equal(mobileToggle.focused, false);
});

test('programmatic mobile tab changes update the header and quietly close navigation', () => {
    const { tabs, root, mobileTitle, mobileToggle, mobileOptions } = loadTabsModule({ storedTab: 'maintenance' });
    tabs.init({ root, defaultTab: 'zones', ...mobileOptions });
    assert.equal(mobileTitle.textContent, 'Advanced');

    mobileToggle.click();
    mobileToggle.focused = false;
    tabs.setActiveTab('led');
    assert.equal(mobileTitle.textContent, 'LED & Notifications');
    assert.equal(tabs.isMobileMenuOpen(), false);
    assert.equal(mobileToggle.focused, false);
});
