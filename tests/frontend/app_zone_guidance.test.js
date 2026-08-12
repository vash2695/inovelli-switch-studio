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

function loadGuidanceModule(options = {}) {
    const scriptPath = path.resolve(__dirname, '../../switch_studio/static/js/app_zone_guidance.js');
    const source = fs.readFileSync(scriptPath, 'utf8');
    const select = new MockElement(options.initialTarget || 'mmwave_detection_areas:area1');
    const elements = {
        guidance: new MockElement(),
        title: new MockElement(),
        summary: new MockElement(),
        use: new MockElement(),
        interaction: new MockElement(),
        note: new MockElement(),
        communityLink: new MockElement(),
    };
    const byId = {
        zoneEditorSelect: select,
        zoneTypeGuidance: elements.guidance,
        zoneTypeGuidanceTitle: elements.title,
        zoneTypeGuidanceSummary: elements.summary,
        zoneTypeGuidanceUse: elements.use,
        zoneTypeGuidanceInteraction: elements.interaction,
        zoneTypeGuidanceNote: elements.note,
        zoneTypeGuidanceCommunityLink: elements.communityLink,
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

test('guidance resolver classifies all supported zone targets and rejects separators or malformed values', () => {
    const { guidance } = loadGuidanceModule();

    for (let area = 1; area <= 4; area += 1) {
        assert.equal(guidance.resolveGuidance(`mmwave_detection_areas:area${area}`).type, 'detection');
        assert.equal(guidance.resolveGuidance(`mmwave_interference_areas:area${area}`).type, 'interference');
        assert.equal(guidance.resolveGuidance(`mmwave_stay_areas:area${area}`).type, 'stay');
    }

    for (const target of ['', null, 'mmwave_detection_areas:area5', 'area1', '--- Stay Areas ---']) {
        const result = guidance.resolveGuidance(target);
        assert.equal(result.type, 'unknown');
        assert.equal(result.title, 'Choose a zone');
    }
});

test('detection guidance distinguishes Area 1 without inventing a fifth or global zone', () => {
    const { guidance } = loadGuidanceModule();
    const primary = plain(guidance.resolveGuidance('mmwave_detection_areas:area1'));
    const secondary = plain(guidance.resolveGuidance('mmwave_detection_areas:area2'));

    assert.equal(primary.accentLabel, 'Default detection');
    assert.equal(primary.title, 'Detection Area 1');
    assert.match(primary.summary, /reports movement or occupancy/);
    assert.match(primary.interaction, /may overlap/);
    assert.match(primary.interaction, /overall occupancy is on when any detection area is occupied/);
    assert.match(primary.note, /default detection area/);
    assert.match(primary.note, /same area, not a separate fifth or global zone/);

    assert.equal(secondary.accentLabel, 'Detection');
    assert.equal(secondary.title, 'Detection Area 2');
    assert.equal(secondary.summary, primary.summary);
    assert.equal(secondary.interaction, primary.interaction);
    assert.equal(secondary.note, null);
    assert.doesNotMatch(`${secondary.accentLabel} ${secondary.title}`, /Primary/);
});

test('interference and stay guidance describes their verified purpose and interaction', () => {
    const { guidance } = loadGuidanceModule();
    const interference = guidance.resolveGuidance('mmwave_interference_areas:area2');
    const stay = guidance.resolveGuidance('mmwave_stay_areas:area3');

    assert.match(interference.summary, /targets are ignored for presence reporting/);
    assert.match(interference.use, /fans, vents, or reflective surfaces/);
    assert.match(interference.interaction, /independent and apply across the detection setup/);
    assert.match(interference.interaction, /not paired with Detection Area 2/);

    assert.match(stay.summary, /stationary presence/);
    assert.match(stay.use, /desk, sofa, or bed/);
    assert.match(stay.interaction, /complement detection areas/);
    assert.match(stay.interaction, /inside or overlapping a detection area/);
    assert.match(stay.interaction, /do not replace the active detection boundary/);
    assert.match(stay.note, /Inovelli has confirmed/);
    assert.match(stay.note, /X coordinates mirrored or with min\/max swapped/);
    assert.match(stay.note, /verify the reported position/);
    assert.doesNotMatch(`${stay.summary} ${stay.use} ${stay.interaction}`, /breathing|high-sensitivity|lock onto/i);
});

test('each guidance result exposes relevant official and community references', () => {
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
});

test('init renders current guidance and selection changes update the accessible note without moving focus', () => {
    const { guidance, select, elements, ownerDocument } = loadGuidanceModule();
    select.focus();
    guidance.init({ ownerDocument });

    assert.equal(elements.title.textContent, 'Detection Area 1');
    assert.equal(elements.note.hidden, false);
    assert.match(elements.note.textContent, /default detection area/);
    assert.equal(elements.guidance.getAttribute('role'), 'note');
    assert.equal(elements.guidance.getAttribute('aria-live'), 'polite');
    assert.equal(elements.guidance.getAttribute('aria-atomic'), 'true');
    assert.equal(elements.guidance.getAttribute('data-zone-type'), 'detection');
    assert.equal(elements.guidance.getAttribute('data-accent-label'), 'Default detection');
    assert.match(elements.communityLink.getAttribute('href'), /presence-area-configuration-best-practice/);

    select.value = 'mmwave_stay_areas:area4';
    select.dispatch('change');

    assert.equal(elements.title.textContent, 'Stay Area 4');
    assert.match(elements.summary.textContent, /stationary presence/);
    assert.match(elements.note.textContent, /Inovelli has confirmed/);
    assert.match(elements.note.textContent, /X coordinates mirrored or with min\/max swapped/);
    assert.equal(elements.note.hidden, false);
    assert.equal(elements.guidance.getAttribute('data-zone-type'), 'stay');
    assert.equal(elements.guidance.getAttribute('data-accent-label'), 'Stay');
    assert.match(elements.communityLink.getAttribute('href'), /having-trouble-understanding-blue-mmwave-vzm32-sn-stay-settings-parameters/);
    assert.equal(select.focused, true, 'dynamic guidance should not steal keyboard focus');
});

test('init supports an explicit element map and harmlessly renders disabled separator values', () => {
    const { guidance, select, elements } = loadGuidanceModule();
    guidance.init({ selectEl: select, elements });

    select.value = '';
    select.dispatch('change');

    assert.equal(elements.title.textContent, 'Choose a zone');
    assert.match(elements.summary.textContent, /Select a detection, interference, or stay area/);
    assert.equal(elements.note.hidden, true);
    assert.equal(guidance.getCurrentGuidance().type, 'unknown');
});

test('guidance init, keyboard-equivalent changes, and direct rendering never emit device commands', () => {
    const { guidance, select, elements, ownerDocument, socketCalls } = loadGuidanceModule();
    guidance.init({ ownerDocument });

    select.value = 'mmwave_interference_areas:area3';
    select.dispatch('change');
    guidance.renderGuidance(guidance.resolveGuidance('mmwave_detection_areas:area4'), elements);

    assert.deepEqual(socketCalls, []);
    assert.equal(typeof guidance.sendCommand, 'undefined');
    assert.equal(typeof guidance.updateParameter, 'undefined');
});

test('reinitializing detaches the prior select listener and renders from the new selection', () => {
    const { guidance, select, elements } = loadGuidanceModule();
    const nextSelect = new MockElement('mmwave_stay_areas:area2');
    guidance.init({ selectEl: select, elements });
    guidance.init({ selectEl: nextSelect, elements });

    assert.equal(elements.title.textContent, 'Stay Area 2');
    select.value = 'mmwave_interference_areas:area1';
    select.dispatch('change');
    assert.equal(elements.title.textContent, 'Stay Area 2', 'the detached select must no longer control guidance');
});
