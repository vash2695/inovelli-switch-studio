const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class MockElement {
    constructor(value = '') {
        this.value = value;
        this.textContent = '';
        this.hidden = false;
        this.attributes = {};
        this.listeners = {};
        this.focused = false;
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    getAttribute(name) {
        return this.attributes[name] ?? null;
    }

    addEventListener(type, callback) {
        this.listeners[type] = callback;
    }

    removeEventListener(type, callback) {
        if (this.listeners[type] === callback) delete this.listeners[type];
    }

    dispatch(type) {
        if (this.listeners[type]) this.listeners[type]({ target: this });
    }

    focus() {
        this.focused = true;
    }
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function makeElements() {
    const elements = {
        toggle: new MockElement(),
        guidance: new MockElement(),
        title: new MockElement(),
        summary: new MockElement(),
        use: new MockElement(),
        interaction: new MockElement(),
        note: new MockElement(),
        communityLink: new MockElement(),
        communityLinkLabel: new MockElement(),
    };
    elements.toggle.setAttribute('aria-expanded', 'false');
    elements.toggle.setAttribute('aria-controls', 'zoneTypeGuidance');
    elements.guidance.setAttribute('id', 'zoneTypeGuidance');
    return elements;
}

function loadGuidanceModule(options = {}) {
    const scriptPath = path.resolve(__dirname, '../../switch_studio/static/js/app_zone_guidance.js');
    const source = fs.readFileSync(scriptPath, 'utf8');
    const select = new MockElement(options.initialTarget || 'mmwave_detection_areas:area1');
    const elements = makeElements();
    const byId = {
        zoneEditorSelect: select,
        zoneTypeGuidanceToggle: elements.toggle,
        zoneTypeGuidance: elements.guidance,
        zoneTypeGuidanceTitle: elements.title,
        zoneTypeGuidanceSummary: elements.summary,
        zoneTypeGuidanceUse: elements.use,
        zoneTypeGuidanceInteraction: elements.interaction,
        zoneTypeGuidanceNote: elements.note,
        zoneTypeGuidanceCommunityLink: elements.communityLink,
        zoneTypeGuidanceCommunityLinkLabel: elements.communityLinkLabel,
    };
    const ownerDocument = {
        getElementById: (id) => byId[id] || null,
    };
    const socketCalls = [];
    const context = {
        window: {},
        document: ownerDocument,
        socket: { emit: (...args) => socketCalls.push(args) },
        console,
    };
    context.global = context;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: scriptPath });

    return {
        guidance: context.window.SwitchStudioZoneGuidance,
        select,
        elements,
        ownerDocument,
        socketCalls,
    };
}

function visibleCopy(elements) {
    return {
        title: elements.title.textContent,
        summary: elements.summary.textContent,
        use: elements.use.textContent,
        interaction: elements.interaction.textContent,
        note: elements.note.textContent,
        communityHref: elements.communityLink.getAttribute('href'),
        communityLabel: elements.communityLinkLabel.textContent,
        type: elements.guidance.getAttribute('data-zone-type'),
        accentLabel: elements.guidance.getAttribute('data-accent-label'),
    };
}

test('guidance resolver classifies every numbered slot and rejects malformed values', () => {
    const { guidance } = loadGuidanceModule();

    for (let area = 1; area <= 4; area += 1) {
        assert.equal(guidance.resolveGuidance(`mmwave_detection_areas:area${area}`).type, 'detection');
        assert.equal(guidance.resolveGuidance(`mmwave_interference_areas:area${area}`).type, 'interference');
        assert.equal(guidance.resolveGuidance(`mmwave_stay_areas:area${area}`).type, 'stay');
    }

    for (const target of ['', null, 'mmwave_detection_areas:area5', 'area1', '--- Stay Areas ---']) {
        const result = guidance.resolveGuidance(target);
        assert.equal(result.type, 'unknown');
        assert.equal(result.title, 'Zone types');
    }
});

test('numbered slots in one family resolve to identical generic guidance', () => {
    const { guidance } = loadGuidanceModule();
    const families = [
        ['mmwave_detection_areas', 'Detection Areas'],
        ['mmwave_stay_areas', 'Stay Areas'],
        ['mmwave_interference_areas', 'Interference Areas'],
    ];

    families.forEach(([prefix, title]) => {
        const baseline = plain(guidance.resolveGuidance(`${prefix}:area1`));
        assert.equal(baseline.title, title);
        for (let area = 2; area <= 4; area += 1) {
            assert.deepEqual(
                plain(guidance.resolveGuidance(`${prefix}:area${area}`)),
                baseline,
                `${title} copy and sources should not depend on the selected storage slot`,
            );
        }
    });
});

test('family guidance describes verified purpose without selected-slot language', () => {
    const { guidance } = loadGuidanceModule();
    const detection = guidance.resolveGuidance('mmwave_detection_areas:area3');
    const interference = guidance.resolveGuidance('mmwave_interference_areas:area2');
    const stay = guidance.resolveGuidance('mmwave_stay_areas:area4');

    assert.equal(detection.accentLabel, 'Detection');
    assert.match(detection.summary, /reports presence/);
    assert.match(detection.interaction, /may overlap/);
    assert.match(detection.interaction, /overall occupancy is active when any detection area is occupied/);
    assert.match(`${detection.use} ${detection.interaction} ${detection.note}`, /Area 1/);
    assert.match(`${detection.use} ${detection.interaction} ${detection.note}`, /same area|basic/i);
    assert.doesNotMatch(detection.title, /[1-4]/);

    assert.match(interference.summary, /targets are ignored for presence reporting/);
    assert.match(interference.use, /fans, vents, or reflective surfaces/);
    assert.match(interference.interaction, /apply across the detection setup/);
    assert.match(interference.interaction, /not pairings/i);
    assert.doesNotMatch(interference.interaction, /Interference Area [1-4]|Detection Area [2-4]/);

    assert.match(stay.summary, /stationary presence/);
    assert.match(stay.use, /desk, sofa, bed/);
    assert.match(stay.interaction, /inside or overlapping a Detection Area/);
    assert.match(stay.interaction, /improve stationary retention/);
    assert.match(stay.interaction, /do not create separate occupancy badges or replace the active detection boundary/);
    assert.match(stay.note, /Inovelli has confirmed/);
    assert.match(stay.note, /X coordinates mirrored or with min\/max swapped/);
    assert.doesNotMatch(`${stay.summary} ${stay.use} ${stay.interaction}`, /breathing|high-sensitivity|lock onto/i);
});

test('each family exposes its verified official and community references', () => {
    const { guidance } = loadGuidanceModule();
    const detection = guidance.resolveGuidance('mmwave_detection_areas:area1');
    const interference = guidance.resolveGuidance('mmwave_interference_areas:area1');
    const stay = guidance.resolveGuidance('mmwave_stay_areas:area1');

    for (const result of [detection, interference, stay]) {
        assert.equal(
            result.officialSourceUrl,
            'https://help.inovelli.com/en/articles/12773613-blue-series-mmwave-presence-dimmer-switch-advanced-mmwave-configuration',
        );
        assert.match(result.communitySourceUrl, /^https:\/\/community\.inovelli\.com\/t\//);
    }
    assert.match(detection.communitySourceUrl, /presence-area-configuration-best-practice/);
    assert.equal(interference.communitySourceUrl, detection.communitySourceUrl);
    assert.match(stay.communitySourceUrl, /having-trouble-understanding-blue-mmwave-vzm32-sn-stay-settings-parameters/);
    assert.equal(detection.communityLinkLabel, 'Community area setup');
    assert.equal(interference.communityLinkLabel, 'Community area setup');
    assert.equal(stay.communityLinkLabel, 'Stay-area guidance and firmware note');
});

test('guidance is initially hidden and the compact disclosure toggles expanded state', () => {
    const { guidance, elements, ownerDocument } = loadGuidanceModule();
    guidance.init({ ownerDocument });

    assert.equal(elements.guidance.hidden, true);
    assert.equal(elements.guidance.getAttribute('role'), null);
    assert.equal(elements.guidance.getAttribute('aria-live'), null);
    assert.equal(elements.guidance.getAttribute('aria-atomic'), null);
    assert.equal(elements.toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(elements.toggle.getAttribute('aria-controls'), 'zoneTypeGuidance');
    assert.equal(elements.title.textContent, 'Detection Areas');

    elements.toggle.dispatch('click');
    assert.equal(elements.guidance.hidden, false);
    assert.equal(elements.toggle.getAttribute('aria-expanded'), 'true');

    elements.toggle.dispatch('click');
    assert.equal(elements.guidance.hidden, true);
    assert.equal(elements.toggle.getAttribute('aria-expanded'), 'false');

    elements.toggle.dispatch('click');
    assert.equal(elements.guidance.hidden, false);
    assert.equal(elements.toggle.getAttribute('aria-expanded'), 'true');
});

test('numbered selection changes retain copy and source while a family change updates an open disclosure', () => {
    const { guidance, select, elements, ownerDocument } = loadGuidanceModule();
    select.focus();
    guidance.init({ ownerDocument });
    elements.toggle.dispatch('click');

    const detectionCopy = visibleCopy(elements);
    select.value = 'mmwave_detection_areas:area4';
    select.dispatch('change');
    assert.deepEqual(visibleCopy(elements), detectionCopy);
    assert.equal(elements.guidance.hidden, false);
    assert.equal(elements.toggle.getAttribute('aria-expanded'), 'true');

    select.value = 'mmwave_stay_areas:area2';
    select.dispatch('change');
    assert.equal(elements.title.textContent, 'Stay Areas');
    assert.match(elements.summary.textContent, /stationary presence/);
    assert.match(elements.communityLink.getAttribute('href'), /having-trouble-understanding-blue-mmwave-vzm32-sn-stay-settings-parameters/);
    assert.match(elements.communityLinkLabel.textContent, /Stay-area guidance and firmware note/);
    assert.equal(elements.guidance.hidden, false, 'family changes must not close an open disclosure');
    assert.equal(elements.toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(select.focused, true, 'dynamic guidance must not steal selection focus');
});

test('family changes while closed are ready when the disclosure reopens', () => {
    const { guidance, select, elements } = loadGuidanceModule();
    guidance.init({ selectEl: select, elements });
    elements.toggle.dispatch('click');
    elements.toggle.dispatch('click');

    select.value = 'mmwave_interference_areas:area3';
    select.dispatch('change');
    assert.equal(elements.guidance.hidden, true);
    assert.equal(elements.toggle.getAttribute('aria-expanded'), 'false');

    elements.toggle.dispatch('click');
    assert.equal(elements.guidance.hidden, false);
    assert.equal(elements.title.textContent, 'Interference Areas');
    assert.match(elements.summary.textContent, /ignored for presence reporting/);
});

test('selection and disclosure interactions never emit device commands', () => {
    const { guidance, select, elements, ownerDocument, socketCalls } = loadGuidanceModule();
    guidance.init({ ownerDocument });

    elements.toggle.dispatch('click');
    select.value = 'mmwave_interference_areas:area3';
    select.dispatch('change');
    elements.toggle.dispatch('click');
    guidance.renderGuidance(guidance.resolveGuidance('mmwave_detection_areas:area4'), elements);

    assert.deepEqual(socketCalls, []);
    assert.equal(typeof guidance.sendCommand, 'undefined');
    assert.equal(typeof guidance.updateParameter, 'undefined');
});

test('reinitializing detaches both prior select and disclosure listeners', () => {
    const { guidance, select, elements } = loadGuidanceModule();
    const nextSelect = new MockElement('mmwave_stay_areas:area2');
    const nextElements = makeElements();
    guidance.init({ selectEl: select, elements });
    guidance.init({ selectEl: nextSelect, elements: nextElements });

    assert.equal(nextElements.title.textContent, 'Stay Areas');
    assert.equal(nextElements.guidance.hidden, true);

    select.value = 'mmwave_interference_areas:area1';
    select.dispatch('change');
    elements.toggle.dispatch('click');
    assert.equal(nextElements.title.textContent, 'Stay Areas', 'the detached select must no longer control guidance');
    assert.equal(nextElements.guidance.hidden, true, 'the detached disclosure must no longer control active guidance');

    nextElements.toggle.dispatch('click');
    assert.equal(nextElements.guidance.hidden, false);
    assert.equal(nextElements.toggle.getAttribute('aria-expanded'), 'true');
});
