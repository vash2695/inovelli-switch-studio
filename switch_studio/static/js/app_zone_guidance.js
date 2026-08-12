(function () {
    const OFFICIAL_SOURCE_URL = 'https://help.inovelli.com/en/articles/12773613-blue-series-mmwave-presence-dimmer-switch-advanced-mmwave-configuration';
    const COMMUNITY_AREA_SOURCE_URL = 'https://community.inovelli.com/t/presence-area-configuration-best-practice/20933';
    const COMMUNITY_STAY_SOURCE_URL = 'https://community.inovelli.com/t/having-trouble-understanding-blue-mmwave-vzm32-sn-stay-settings-parameters/21585';

    const DEFAULT_ELEMENT_IDS = Object.freeze({
        guidance: 'zoneTypeGuidance',
        title: 'zoneTypeGuidanceTitle',
        summary: 'zoneTypeGuidanceSummary',
        use: 'zoneTypeGuidanceUse',
        interaction: 'zoneTypeGuidanceInteraction',
        note: 'zoneTypeGuidanceNote',
        communityLink: 'zoneTypeGuidanceCommunityLink',
    });

    let activeSelectEl = null;
    let activeChangeHandler = null;
    let activeElements = null;
    let currentGuidance = null;

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
                title: 'Choose a zone',
                summary: 'Select a detection, interference, or stay area to see what it does.',
                use: 'Zone guidance changes with the selected zone.',
                interaction: 'Reading this guidance does not change the switch.',
                note: null,
                ...sourceFields(COMMUNITY_AREA_SOURCE_URL),
            };
        }

        const category = match[1];
        const areaNumber = Number(match[2]);

        if (category === 'mmwave_detection_areas') {
            const isPrimary = areaNumber === 1;
            return {
                type: 'detection',
                accentLabel: isPrimary ? 'Default detection' : 'Detection',
                title: `Detection Area ${areaNumber}`,
                summary: 'An active region where the sensor reports movement or occupancy.',
                use: 'Use detection areas to monitor the parts of the room where presence should count.',
                interaction: 'Detection areas may overlap. Each area reports its own occupancy, while overall occupancy is on when any detection area is occupied.',
                note: isPrimary
                    ? 'Area 1 is the default detection area: the switch\'s basic range parameters configure this same area, not a separate fifth or global zone.'
                    : null,
                ...sourceFields(COMMUNITY_AREA_SOURCE_URL),
            };
        }

        if (category === 'mmwave_interference_areas') {
            return {
                type: 'interference',
                accentLabel: 'Interference',
                title: `Interference Area ${areaNumber}`,
                summary: 'An exclusion region where targets are ignored for presence reporting.',
                use: 'Use interference areas around sources of unwanted detections, such as moving fans, vents, or reflective surfaces.',
                interaction: 'Interference areas are independent and apply across the detection setup. Area numbers are storage slots; Interference Area 2 is not paired with Detection Area 2.',
                note: null,
                ...sourceFields(COMMUNITY_AREA_SOURCE_URL),
            };
        }

        return {
            type: 'stay',
            accentLabel: 'Stay',
            title: `Stay Area ${areaNumber}`,
            summary: 'A region intended to help the sensor continue detecting stationary presence.',
            use: 'Use stay areas around places where someone may sit or lie still, such as a desk, sofa, or bed.',
            interaction: 'Stay areas complement detection areas and are typically placed inside or overlapping a detection area; they do not replace the active detection boundary.',
            note: 'Inovelli has confirmed a switch-firmware bug can return Stay Area X coordinates mirrored or with min/max swapped. After applying, verify the reported position; Switch Studio will not silently compensate for it.',
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
            guidance: getElement(ownerDocument, suppliedElements, 'guidance'),
            title: getElement(ownerDocument, suppliedElements, 'title'),
            summary: getElement(ownerDocument, suppliedElements, 'summary'),
            use: getElement(ownerDocument, suppliedElements, 'use'),
            interaction: getElement(ownerDocument, suppliedElements, 'interaction'),
            note: getElement(ownerDocument, suppliedElements, 'note'),
            communityLink: getElement(ownerDocument, suppliedElements, 'communityLink'),
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

        if (refs.note) refs.note.hidden = !model.note;
        if (refs.communityLink && typeof refs.communityLink.setAttribute === 'function') {
            refs.communityLink.setAttribute('href', model.communitySourceUrl);
        }
        if (refs.guidance) {
            if (typeof refs.guidance.setAttribute === 'function') {
                refs.guidance.setAttribute('role', 'note');
                refs.guidance.setAttribute('aria-live', 'polite');
                refs.guidance.setAttribute('aria-atomic', 'true');
                refs.guidance.setAttribute('data-zone-type', model.type);
                refs.guidance.setAttribute('data-accent-label', model.accentLabel);
            }
        }

        currentGuidance = { ...model };
        return { ...model };
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

        activeSelectEl = selectEl;
        activeElements = elements;
        activeChangeHandler = () => {
            const target = activeSelectEl ? activeSelectEl.value : '';
            renderGuidance(resolveGuidance(target), activeElements);
        };

        if (activeSelectEl && typeof activeSelectEl.addEventListener === 'function') {
            activeSelectEl.addEventListener('change', activeChangeHandler);
        }
        activeChangeHandler();
        return window.SwitchStudioZoneGuidance;
    }

    window.SwitchStudioZoneGuidance = {
        init,
        resolveGuidance,
        renderGuidance,
        getCurrentGuidance: () => (currentGuidance ? { ...currentGuidance } : null),
        sourceUrls: Object.freeze({
            official: OFFICIAL_SOURCE_URL,
            communityAreas: COMMUNITY_AREA_SOURCE_URL,
            communityStay: COMMUNITY_STAY_SOURCE_URL,
        }),
    };
})();
