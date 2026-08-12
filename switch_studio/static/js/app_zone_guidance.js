(function () {
    const OFFICIAL_SOURCE_URL = 'https://help.inovelli.com/en/articles/12773613-blue-series-mmwave-presence-dimmer-switch-advanced-mmwave-configuration';
    const COMMUNITY_AREA_SOURCE_URL = 'https://community.inovelli.com/t/presence-area-configuration-best-practice/20933';
    const COMMUNITY_STAY_SOURCE_URL = 'https://community.inovelli.com/t/having-trouble-understanding-blue-mmwave-vzm32-sn-stay-settings-parameters/21585/4';

    const DEFAULT_ELEMENT_IDS = Object.freeze({
        toggle: 'zoneTypeGuidanceToggle',
        guidance: 'zoneTypeGuidance',
        title: 'zoneTypeGuidanceTitle',
        summary: 'zoneTypeGuidanceSummary',
        use: 'zoneTypeGuidanceUse',
        interaction: 'zoneTypeGuidanceInteraction',
        note: 'zoneTypeGuidanceNote',
        communityLink: 'zoneTypeGuidanceCommunityLink',
        communityLinkLabel: 'zoneTypeGuidanceCommunityLinkLabel',
    });

    let activeSelectEl = null;
    let activeChangeHandler = null;
    let activeToggleEl = null;
    let activeToggleHandler = null;
    let activeElements = null;
    let currentGuidance = null;
    let guidanceExpanded = false;

    function sourceFields(communitySourceUrl) {
        return {
            officialSourceUrl: OFFICIAL_SOURCE_URL,
            communitySourceUrl: communitySourceUrl,
        };
    }

    function resolveGuidance(target) {
        const normalizedTarget = String(target || '').trim().toLowerCase();
        const match = /^(mmwave_detection_areas|mmwave_interference_areas|mmwave_stay_areas):area([1-4])$/.exec(normalizedTarget);

        if (!match) {
            return {
                type: 'unknown',
                accentLabel: 'Zone guidance',
                title: 'Zone types',
                summary: 'Select a detection, interference, or stay area to see what it does.',
                use: 'Zone guidance changes with the selected zone.',
                interaction: 'Reading this guidance does not change the switch.',
                note: null,
                communityLinkLabel: 'Community area setup',
                ...sourceFields(COMMUNITY_AREA_SOURCE_URL),
            };
        }

        const category = match[1];
        if (category === 'mmwave_detection_areas') {
            return {
                type: 'detection',
                accentLabel: 'Detection',
                title: 'Detection Areas',
                summary: 'Active regions where the sensor reports presence.',
                use: 'Monitor the parts of the room where presence should count.',
                interaction: 'Detection areas may overlap. Each area reports its own occupancy, while overall occupancy is active when any detection area is occupied.',
                note: 'The Basic Range X/Y/Z controls configure Detection Area 1. They do not define a separate global or fifth zone.',
                communityLinkLabel: 'Community area setup',
                ...sourceFields(COMMUNITY_AREA_SOURCE_URL),
            };
        }

        if (category === 'mmwave_interference_areas') {
            return {
                type: 'interference',
                accentLabel: 'Interference',
                title: 'Interference Areas',
                summary: 'Exclusion regions where targets are ignored for presence reporting.',
                use: 'Block unwanted detections around sources such as moving fans, vents, or reflective surfaces.',
                interaction: 'Interference areas apply across the detection setup. Their numbers are storage slots, not pairings with detection-area numbers.',
                note: null,
                communityLinkLabel: 'Community area setup',
                ...sourceFields(COMMUNITY_AREA_SOURCE_URL),
            };
        }

        return {
            type: 'stay',
            accentLabel: 'Stay',
            title: 'Stay Areas',
            summary: 'Regions intended to help retain stationary presence.',
            use: 'Places where someone may sit or lie still, such as a desk, sofa, bed, or toilet.',
            interaction: 'Stay areas are normally placed inside or overlapping a Detection Area. They improve stationary retention but do not create separate occupancy badges or replace the active detection boundary.',
            note: 'Inovelli has confirmed a switch-firmware bug can return Stay Area X coordinates mirrored or with min/max swapped. After applying, verify the reported position; Switch Studio does not silently compensate.',
            communityLinkLabel: 'Stay-area guidance and firmware note',
            ...sourceFields(COMMUNITY_STAY_SOURCE_URL),
        };
    }

    function getElement(ownerDocument, suppliedElements, key) {
        if (suppliedElements && suppliedElements[key]) return suppliedElements[key];
        if (!ownerDocument || typeof ownerDocument.getElementById !== 'function') return null;
        return ownerDocument.getElementById(DEFAULT_ELEMENT_IDS[key]);
    }

    function resolveElements(options) {
        const opts = options || {};
        const ownerDocument = opts.ownerDocument || (typeof document !== 'undefined' ? document : null);
        const suppliedElements = opts.elements || null;
        return {
            toggle: getElement(ownerDocument, suppliedElements, 'toggle'),
            guidance: getElement(ownerDocument, suppliedElements, 'guidance'),
            title: getElement(ownerDocument, suppliedElements, 'title'),
            summary: getElement(ownerDocument, suppliedElements, 'summary'),
            use: getElement(ownerDocument, suppliedElements, 'use'),
            interaction: getElement(ownerDocument, suppliedElements, 'interaction'),
            note: getElement(ownerDocument, suppliedElements, 'note'),
            communityLink: getElement(ownerDocument, suppliedElements, 'communityLink'),
            communityLinkLabel: getElement(ownerDocument, suppliedElements, 'communityLinkLabel'),
        };
    }

    function setText(element, value) {
        if (!element) return;
        element.textContent = value || '';
    }

    function renderGuidance(guidance, elements) {
        const model = guidance || resolveGuidance('');
        const refs = elements || activeElements || {};

        setText(refs.title, model.title);
        setText(refs.summary, model.summary);
        setText(refs.use, model.use);
        setText(refs.interaction, model.interaction);
        setText(refs.note, model.note);
        setText(refs.communityLinkLabel, model.communityLinkLabel);

        if (refs.note) refs.note.hidden = !model.note;
        if (refs.communityLink && typeof refs.communityLink.setAttribute === 'function') {
            refs.communityLink.setAttribute('href', model.communitySourceUrl);
        }
        if (refs.guidance) {
            if (typeof refs.guidance.setAttribute === 'function') {
                refs.guidance.setAttribute('data-zone-type', model.type);
                refs.guidance.setAttribute('data-accent-label', model.accentLabel);
            }
        }
        if (refs.toggle && typeof refs.toggle.setAttribute === 'function') {
            refs.toggle.setAttribute('data-zone-type', model.type);
        }

        currentGuidance = { ...model };
        return { ...model };
    }

    function setExpanded(expanded) {
        const refs = activeElements || {};
        guidanceExpanded = Boolean(expanded && refs.guidance);

        if (refs.guidance) refs.guidance.hidden = !guidanceExpanded;
        if (refs.toggle && typeof refs.toggle.setAttribute === 'function') {
            const action = guidanceExpanded ? 'Hide' : 'Show';
            refs.toggle.setAttribute('aria-expanded', String(guidanceExpanded));
            refs.toggle.setAttribute('aria-label', `${action} zone type help`);
            refs.toggle.setAttribute('title', `${action} zone type help`);
        }
        return guidanceExpanded;
    }

    function init(options) {
        const opts = options || {};
        const ownerDocument = opts.ownerDocument || (typeof document !== 'undefined' ? document : null);
        const selectEl = opts.selectEl || (
            ownerDocument && typeof ownerDocument.getElementById === 'function'
                ? ownerDocument.getElementById(opts.selectId || 'zoneEditorSelect')
                : null
        );
        const elements = resolveElements({ ...opts, ownerDocument });

        if (activeSelectEl && activeChangeHandler && typeof activeSelectEl.removeEventListener === 'function') {
            activeSelectEl.removeEventListener('change', activeChangeHandler);
        }
        if (activeToggleEl && activeToggleHandler && typeof activeToggleEl.removeEventListener === 'function') {
            activeToggleEl.removeEventListener('click', activeToggleHandler);
        }

        activeSelectEl = selectEl;
        activeElements = elements;
        activeToggleEl = elements.toggle;
        activeChangeHandler = () => {
            const target = activeSelectEl ? activeSelectEl.value : '';
            renderGuidance(resolveGuidance(target), activeElements);
        };
        activeToggleHandler = () => setExpanded(!guidanceExpanded);

        if (activeSelectEl && typeof activeSelectEl.addEventListener === 'function') {
            activeSelectEl.addEventListener('change', activeChangeHandler);
        }
        if (activeToggleEl && typeof activeToggleEl.addEventListener === 'function') {
            activeToggleEl.addEventListener('click', activeToggleHandler);
        }
        activeChangeHandler();
        setExpanded(false);
        return window.SwitchStudioZoneGuidance;
    }

    window.SwitchStudioZoneGuidance = {
        init,
        resolveGuidance,
        renderGuidance,
        setExpanded,
        isExpanded: () => guidanceExpanded,
        getCurrentGuidance: () => (currentGuidance ? { ...currentGuidance } : null),
        sourceUrls: Object.freeze({
            official: OFFICIAL_SOURCE_URL,
            communityAreas: COMMUNITY_AREA_SOURCE_URL,
            communityStay: COMMUNITY_STAY_SOURCE_URL,
        }),
    };
})();
