/**
 * native dropdown picker, popover isolation, static CSS guards.
 *
 * Split out of tests/core.test.mjs without touching a single test body: names and order within
 * this file are unchanged, and the shared helpers live in ./core-prelude.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyWorldbooks, installMockNativeFilterDom, normalizeSettings, readPanelSource, readStyleSource } from './core-prelude.mjs';

test('R6.1 mobile editor picker keeps #wbo-mp-search open & focused during soft-keyboard resize/scroll and closes on unfocused width change', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 390, innerHeight: 844 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        const wiDrawer = dom.doc.createElement('div');
        wiDrawer.id = 'WorldInfo';
        const multiSel = dom.doc.createElement('div');
        multiSel.id = 'WIMultiSelector';
        const globalSel = dom.doc.createElement('select');
        globalSel.id = 'world_info';
        globalSel.multiple = true;
        multiSel.appendChild(globalSel);

        const worldPopup = dom.doc.createElement('div');
        worldPopup.id = 'world_popup';
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '书A'], ['1', '书B'], ['2', '书C']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        worldPopup.appendChild(editorSel);
        wiDrawer.appendChild(multiSel);
        wiDrawer.appendChild(worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 书A: 'g1' },
            showNativeOptgroups: true,
        });
        const cls = classifyWorldbooks({
            worldNames: ['书A', '书B', '书C'],
            bindingMap: new Map(),
            settings,
        });

        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        const trigger = dom.doc.getElementById('wbo-mobile-editor-trigger');
        assert.ok(trigger, 'mobile editor trigger should mount when Select2 is absent and >=2 sections exist');

        trigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        const overlay = dom.doc.getElementById('wbo-mobile-picker-overlay');
        assert.ok(overlay && overlay.isConnected, 'mobile picker overlay should open');
        const popover = overlay.querySelector('.wbo-mp-popover');
        const searchInput = overlay.querySelector('#wbo-mp-search');
        assert.ok(popover && searchInput, 'popover and #wbo-mp-search must exist');

        // Focus search input to raise soft keyboard
        searchInput.focus();
        assert.equal(dom.doc.activeElement, searchInput);

        // Simulate iOS WKWebView keyboard opening: innerHeight & visualViewport.height shrink 844 -> 460 while innerWidth stays 390
        globalThis.innerHeight = 460;
        dom.vv.height = 460;
        globalThis.dispatchEvent(new dom.MockEvent('resize'));
        dom.vv.dispatchEvent(new dom.MockEvent('resize'));
        dom.vv.dispatchEvent(new dom.MockEvent('scroll'));

        assert.equal(overlay.isConnected, true, 'overlay must stay open when soft keyboard triggers resize/scroll');
        assert.equal(dom.doc.activeElement, searchInput, '#wbo-mp-search must retain focus');
        assert.equal(overlay.querySelector('#wbo-mp-search'), searchInput, '#wbo-mp-search DOM identity must not be rebuilt');
        const clampedMaxH = parseInt(popover.style.maxHeight, 10);
        assert.ok(Number.isFinite(clampedMaxH) && clampedMaxH >= 120 && clampedMaxH <= 320, `maxHeight should clamp inside 460px viewport, got ${popover.style.maxHeight}`);

        // Orientation change while #wbo-mp-search is focused updates initialVw and repositions without closing
        globalThis.innerWidth = 844;
        globalThis.innerHeight = 390;
        dom.vv.height = 390;
        globalThis.dispatchEvent(new dom.MockEvent('orientationchange'));
        assert.equal(overlay.isConnected, true, 'focused orientationchange must keep picker open');
        assert.equal(dom.doc.activeElement, searchInput);

        // Unfocused orientation/width change (844 -> 390) should close cleanly
        searchInput.blur();
        assert.equal(dom.doc.activeElement, dom.doc.body);
        globalThis.innerWidth = 390;
        globalThis.innerHeight = 844;
        dom.vv.height = 844;
        globalThis.dispatchEvent(new dom.MockEvent('resize'));
        assert.equal(overlay.isConnected, false, 'unfocused width change should close the mobile picker');
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('R6.1 grouped popup picker (#wbo-pop-search) clamps to visualViewport without closing or rebuilding input', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 390, innerHeight: 844 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        const dialog = dom.doc.createElement('dialog');
        const personaPopup = dom.doc.createElement('div');
        personaPopup.className = 'persona_world';
        const personaSel = dom.doc.createElement('select');
        personaSel.className = 'persona_world_info_selector';
        for (const [val, txt] of [['', '--- None ---'], ['0', '书A'], ['1', '书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            personaSel.appendChild(opt);
        }
        personaPopup.appendChild(personaSel);
        dialog.appendChild(personaPopup);
        dom.doc.body.appendChild(dialog);

        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 书A: 'g1' },
            adaptPersonaBindPopup: true,
        });
        const cls = classifyWorldbooks({
            worldNames: ['书A', '书B'],
            bindingMap: new Map(),
            settings,
        });

        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        nativeMod.startNativeObservers(() => {});

        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body && o.options?.childList);
        assert.ok(bodyObserver, 'body MutationObserver should be registered');
        bodyObserver.cb([{ addedNodes: [dialog] }]);

        const trigger = personaPopup.querySelector('.wbo-popup-select-trigger');
        assert.ok(trigger, 'grouped popup select trigger should mount');
        trigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));

        const backdrop = dialog.querySelector('.wbo-mp-backdrop');
        const popover = backdrop?.querySelector('.wbo-mp-popover');
        const popSearch = popover?.querySelector('#wbo-pop-search');
        assert.ok(backdrop && popover && popSearch, '#wbo-pop-search grouped popover should open');

        popSearch.focus();
        globalThis.innerHeight = 460;
        dom.vv.height = 460;
        globalThis.dispatchEvent(new dom.MockEvent('resize'));
        dom.vv.dispatchEvent(new dom.MockEvent('resize'));
        dom.vv.dispatchEvent(new dom.MockEvent('scroll'));

        assert.equal(backdrop.isConnected, true, '#wbo-pop-search popover must stay open on keyboard resize/scroll');
        assert.equal(dom.doc.activeElement, popSearch);
        assert.equal(popover.querySelector('#wbo-pop-search'), popSearch);
        const maxH = parseInt(popover.style.maxHeight, 10);
        assert.ok(Number.isFinite(maxH) && maxH >= 120 && maxH <= 320, `expected clamped maxHeight, got ${popover.style.maxHeight}`);
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('R6.2 .gr-container-enhanced & #world_popup .gr-select2-display isolation + ungrouped bubble guard', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 390, innerHeight: 844 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        const wiDrawer = dom.doc.createElement('div');
        wiDrawer.id = 'WorldInfo';
        const multiSel = dom.doc.createElement('div');
        multiSel.id = 'WIMultiSelector';
        const globalSel = dom.doc.createElement('select');
        globalSel.id = 'world_info';
        globalSel.multiple = true;
        const globalGrDisplay = dom.doc.createElement('div');
        globalGrDisplay.className = 'gr-select2-display';
        multiSel.appendChild(globalSel);
        multiSel.appendChild(globalGrDisplay);

        const worldPopup = dom.doc.createElement('div');
        worldPopup.id = 'world_popup';
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '书A'], ['1', '书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        const editorGrDisplay = dom.doc.createElement('div');
        editorGrDisplay.className = 'gr-select2-display';
        worldPopup.appendChild(editorSel);
        worldPopup.appendChild(editorGrDisplay);
        wiDrawer.appendChild(multiSel);
        wiDrawer.appendChild(worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        // Zero custom groups, zero pinned, showCharBooks: false -> needsPopoverGrouping is FALSE!
        const settings = normalizeSettings({ groups: [], showCharBooks: false });
        const cls = classifyWorldbooks({
            worldNames: ['书A', '书B'],
            bindingMap: new Map(),
            settings,
        });

        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        nativeMod.startNativeObservers(() => {});

        // Simulate host mounting an ungrouped editor `.gr-container-enhanced` AND a global `#gr-global-dropdown-container`
        const editorEnhanced = dom.doc.createElement('div');
        editorEnhanced.className = 'gr-container-enhanced';
        for (const [v, t] of [['0', '书A'], ['1', '书B']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            editorEnhanced.appendChild(opt);
        }
        const globalEnhanced = dom.doc.createElement('div');
        globalEnhanced.id = 'gr-global-dropdown-container';
        globalEnhanced.className = 'gr-container-enhanced';
        dom.doc.body.appendChild(editorEnhanced);
        dom.doc.body.appendChild(globalEnhanced);

        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body && o.options?.childList);
        assert.ok(bodyObserver, 'body MutationObserver should be registered');
        bodyObserver.cb([{ addedNodes: [editorEnhanced, globalEnhanced] }]);

        assert.equal(editorEnhanced.dataset.wboPopoverRole, 'editor', 'ungrouped editor .gr-container-enhanced must still receive role=editor');
        assert.equal(editorEnhanced.dataset.wboBubbleGuarded, '1', 'ungrouped editor .gr-container-enhanced must receive bubble guard');
        assert.equal(globalEnhanced.dataset.wboPopoverRole, 'global');
        assert.equal(globalEnhanced.dataset.wboBubbleGuarded, '1');

        // Clicking #world_popup .gr-select2-display must preserve editorEnhanced while closing globalEnhanced!
        editorGrDisplay.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true }));
        assert.equal(editorEnhanced.isConnected, true, 'clicking #world_popup .gr-select2-display must NOT close editor .gr-container-enhanced');
        assert.notEqual(editorEnhanced.style.display, 'none');
        assert.equal(globalEnhanced.isConnected, false, 'clicking editor trigger must close global dropdown');

        // Direct closeAllOpenWorldDropdowns({ except: 'editor' }) must also keep editorEnhanced intact
        nativeMod.closeAllOpenWorldDropdowns({ except: 'editor' });
        assert.equal(editorEnhanced.isConnected, true);
        assert.notEqual(editorEnhanced.style.display, 'none');

        // Clicking #WIMultiSelector .gr-select2-display closes editorEnhanced
        globalGrDisplay.dispatchEvent(new dom.MockEvent('pointerdown', { bubbles: true, cancelable: true }));
        assert.equal(editorEnhanced.isConnected, false, 'clicking global .gr-select2-display should close editor dropdown');
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('R6.3 & Challenger R2 static CSS/JS guardrails (.wbo-vis-popover min-width, mobile >=16px inputs, no resize closePicker)', () => {
    const cssSrc = readStyleSource();
    const nativeSrc = readFileSync(new URL('../src/native-filter.js', import.meta.url), 'utf8');

    const visBlock = cssSrc.match(/\.wbo-vis-popover\s*\{[\s\S]*?\}/);
    assert.ok(visBlock, '.wbo-vis-popover block must exist in style.css');
    assert.match(visBlock[0], /min-width:\s*0\s*!important\s*;/, '.wbo-vis-popover must reset .wbo-modal min-width: 340px with min-width: 0 !important;');

    const mobileInputBlock = cssSrc.match(/@media\s*\(max-width:\s*680px\),\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.wbo-mp-popover\s+\.wbo-search-input[\s\S]*?\}\s*\}/);
    assert.ok(mobileInputBlock, 'mobile/coarse >=16px input media block must exist in style.css');
    assert.match(mobileInputBlock[0], /font-size:\s*16px\s*!important\s*;/);
    assert.match(mobileInputBlock[0], /height:\s*34px\s*!important\s*;/);
    assert.match(mobileInputBlock[0], /min-height:\s*34px\s*!important\s*;/);

    assert.equal(/const\s+onViewportChange\s*=\s*\(\)\s*=>\s*closePicker\s*\(\)/.test(nativeSrc), false, 'native-filter.js must never unconditionally close mobile picker on resize');
    assert.match(nativeSrc, /displaySelector:\s*'#WIMultiSelector \.gr-select2-display'/);
});

test('R6.2 grouped enhanceCustomDropdownPopover works for global (★ 已置顶 hoisting) and editor popovers + placeholder-only isolation', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 390, innerHeight: 844 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        const wiDrawer = dom.doc.createElement('div');
        wiDrawer.id = 'WorldInfo';
        const multiSel = dom.doc.createElement('div');
        multiSel.id = 'WIMultiSelector';
        const globalSel = dom.doc.createElement('select');
        globalSel.id = 'world_info';
        globalSel.multiple = true;
        const globalGrDisplay = dom.doc.createElement('div');
        globalGrDisplay.className = 'gr-select2-display';
        multiSel.appendChild(globalSel);
        multiSel.appendChild(globalGrDisplay);

        const worldPopup = dom.doc.createElement('div');
        worldPopup.id = 'world_popup';
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '书A'], ['1', '书B'], ['2', '书C']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        const editorGrDisplay = dom.doc.createElement('div');
        editorGrDisplay.className = 'gr-select2-display';
        worldPopup.appendChild(editorSel);
        worldPopup.appendChild(editorGrDisplay);
        wiDrawer.appendChild(multiSel);
        wiDrawer.appendChild(worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 书A: 'g1' },
            pinnedBooks: ['书A'],
            showNativeOptgroups: true,
        });
        const cls = classifyWorldbooks({
            worldNames: ['书A', '书B', '书C'],
            bindingMap: new Map(),
            settings,
        });

        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        nativeMod.startNativeObservers(() => {});

        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body && o.options?.childList);
        assert.ok(bodyObserver, 'body MutationObserver should be registered');

        // 1) Grouped #gr-global-dropdown-container (exercises isGlobalPopover === true, orderedSections >= 2, initialPopPinned > 0)
        const globalEnhanced = dom.doc.createElement('div');
        globalEnhanced.id = 'gr-global-dropdown-container';
        globalEnhanced.className = 'gr-container-enhanced';
        const globalSearch = dom.doc.createElement('input');
        globalSearch.className = 'gr-search-input';
        const globalOptionsHost = dom.doc.createElement('div');
        globalOptionsHost.className = 'gr-options-list';
        for (const [v, t] of [['0', '书A'], ['1', '书B'], ['2', '书C']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            globalOptionsHost.appendChild(opt);
        }
        globalEnhanced.appendChild(globalSearch);
        globalEnhanced.appendChild(globalOptionsHost);
        dom.doc.body.appendChild(globalEnhanced);

        bodyObserver.cb([{ addedNodes: [globalEnhanced] }]);

        assert.equal(globalEnhanced.dataset.wboPopoverRole, 'global');
        assert.equal(globalEnhanced.dataset.wboPopoverReady, '1');
        const globalSections = globalOptionsHost.querySelectorAll('.wbo-pop-section');
        assert.ok(globalSections.length >= 2, 'global popover should render pinned + ungrouped sections');
        assert.equal(globalSections[0].getAttribute('data-wbo-dd-group'), '__pinned__');
        assert.match(globalSections[0].querySelector('.wbo-dd-group-head')?.textContent || '', /收藏 \(1\)/);
        const globalFilterBar = globalEnhanced.querySelector('.wbo-pop-filter-bar');
        assert.ok(globalFilterBar, 'global popover should receive .wbo-pop-filter-bar');
        assert.equal(globalFilterBar.querySelector('[data-wbo-pill="__pinned__"]')?.getAttribute('aria-pressed'), 'true');
        const g1Pill = Array.from(globalFilterBar.querySelectorAll('.wbo-dd-pill')).find((b) => b.getAttribute('data-wbo-pill') === 'g1');
        assert.equal(g1Pill?.textContent, '文风 1', 'global pill count must include hoisted pinned item from that group');

        // 2) Grouped editor .gr-container-enhanced (exercises isGlobalPopover === false, orderedSections >= 2)
        const editorEnhanced = dom.doc.createElement('div');
        editorEnhanced.className = 'gr-container-enhanced';
        const editorSearch = dom.doc.createElement('input');
        editorSearch.className = 'gr-search-input';
        const editorOptionsHost = dom.doc.createElement('div');
        editorOptionsHost.className = 'gr-options-list';
        for (const [v, t] of [['', '--- Pick to Edit ---'], ['0', '书A'], ['1', '书B'], ['2', '书C']]) {
            const opt = dom.doc.createElement('div');
            opt.className = 'gr-option';
            opt.dataset.value = v;
            opt.textContent = t;
            editorOptionsHost.appendChild(opt);
        }
        editorEnhanced.appendChild(editorSearch);
        editorEnhanced.appendChild(editorOptionsHost);
        dom.doc.body.appendChild(editorEnhanced);

        bodyObserver.cb([{ addedNodes: [editorEnhanced] }]);

        assert.equal(editorEnhanced.dataset.wboPopoverRole, 'editor');
        assert.equal(editorEnhanced.dataset.wboPopoverReady, '1');
        // v2.35.40: the editor popover lists favorites in one flat 已收藏 section (origin shown as
        // a badge) instead of repeating a group header per original group.
        const editorPinnedSection = editorEnhanced.querySelector('.wbo-pop-section[data-wbo-dd-group="__pinned__"]');
        assert.ok(editorPinnedSection, 'editor popover renders one flat favorites section');
        // v2.35.102: the favorites block is also the visible home in 全部, so expanding its head
        // shows the pinned books instead of an empty body.
        assert.equal(editorPinnedSection.querySelectorAll('.gr-option').length, 1, 'favorites block lists the pinned book in 全部');
        const editorSections = editorOptionsHost.querySelectorAll('.wbo-pop-section');
        assert.equal(editorSections.length, 3, 'editor popover should render favorites, g1 and ungrouped sections');
        assert.equal(editorSections[0].getAttribute('data-wbo-dd-group'), '__pinned__');
        assert.equal(editorSections[1].getAttribute('data-wbo-dd-group'), 'g1');

        // 3) Challenge 2: placeholder-only .gr-container-enhanced preserved when except='editor', unrelated non-world popover closed
        const placeholderEditorEnhanced = dom.doc.createElement('div');
        placeholderEditorEnhanced.className = 'gr-container-enhanced';
        const phOpt = dom.doc.createElement('div');
        phOpt.className = 'gr-option';
        phOpt.dataset.value = '';
        phOpt.textContent = '--- Pick to Edit ---';
        placeholderEditorEnhanced.appendChild(phOpt);
        dom.doc.body.appendChild(placeholderEditorEnhanced);

        const unrelatedEnhanced = dom.doc.createElement('div');
        unrelatedEnhanced.className = 'gr-container-enhanced';
        const unOpt = dom.doc.createElement('div');
        unOpt.className = 'gr-option';
        unOpt.dataset.value = '0';
        unOpt.textContent = '非世界书预设A';
        unrelatedEnhanced.appendChild(unOpt);
        dom.doc.body.appendChild(unrelatedEnhanced);

        nativeMod.closeAllOpenWorldDropdowns({ except: 'editor' });
        assert.equal(placeholderEditorEnhanced.isConnected, true, 'placeholder-only editor popover should be exempted when except="editor"');
        assert.equal(unrelatedEnhanced.isConnected, true, 'non-worldbook .gr-container-enhanced must be preserved untouched');
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('R6.1 toggle-closing #wbo-mobile-editor-trigger cleans up window/visualViewport/document listeners and wiDrawerObserver', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 390, innerHeight: 844 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        const wiDrawer = dom.doc.createElement('div');
        wiDrawer.id = 'WorldInfo';
        const multiSel = dom.doc.createElement('div');
        multiSel.id = 'WIMultiSelector';
        const globalSel = dom.doc.createElement('select');
        globalSel.id = 'world_info';
        globalSel.multiple = true;
        multiSel.appendChild(globalSel);

        const worldPopup = dom.doc.createElement('div');
        worldPopup.id = 'world_popup';
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '书A'], ['1', '书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        worldPopup.appendChild(editorSel);
        wiDrawer.appendChild(multiSel);
        wiDrawer.appendChild(worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 书A: 'g1' },
            showNativeOptgroups: true,
        });
        const cls = classifyWorldbooks({
            worldNames: ['书A', '书B'],
            bindingMap: new Map(),
            settings,
        });

        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        nativeMod.startNativeObservers(() => {});
        const trigger = dom.doc.getElementById('wbo-mobile-editor-trigger');
        assert.ok(trigger);

        const basePointerDownCount = (dom.doc.documentElement._listeners.get('pointerdown') || []).length;
        const baseObserverCount = dom.observerInstances.length;

        // First click opens mobile picker
        trigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        const overlay = dom.doc.getElementById('wbo-mobile-picker-overlay');
        assert.ok(overlay && overlay.isConnected);
        assert.equal(trigger.classList.contains('is-open'), true);
        assert.equal(dom.winListeners.get('resize')?.size || 0, 1);
        assert.equal(dom.winListeners.get('orientationchange')?.size || 0, 1);
        assert.equal(dom.vvListeners.get('resize')?.size || 0, 1);
        assert.equal(dom.vvListeners.get('scroll')?.size || 0, 1);
        assert.equal((dom.doc.documentElement._listeners.get('pointerdown') || []).length, basePointerDownCount + 1);
        const wiObs = dom.observerInstances[baseObserverCount];
        assert.equal(wiObs?.target, wiDrawer);

        // Second click toggle-closes via _closeMobileEditorPicker
        trigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        assert.equal(overlay.isConnected, false, 'toggle click must remove overlay');
        assert.equal(trigger.classList.contains('is-open'), false, 'toggle click must clear is-open');
        assert.equal(dom.winListeners.get('resize')?.size || 0, 0, 'window resize listener must be removed on toggle close');
        assert.equal(dom.winListeners.get('orientationchange')?.size || 0, 0, 'window orientationchange listener must be removed on toggle close');
        assert.equal(dom.vvListeners.get('resize')?.size || 0, 0, 'visualViewport resize listener must be removed on toggle close');
        assert.equal(dom.vvListeners.get('scroll')?.size || 0, 0, 'visualViewport scroll listener must be removed on toggle close');
        assert.equal((dom.doc.documentElement._listeners.get('pointerdown') || []).length, basePointerDownCount, 'document pointerdown listener must be removed on toggle close');
        assert.equal(wiObs?.target, null, 'wiDrawerObserver must be disconnected on toggle close');
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('R6.2 .wbo-mp-backdrop pointerdown over trigger rect suppresses trailing click reopen on both #wbo-mobile-editor-trigger and .wbo-popup-select-trigger', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 390, innerHeight: 844 });
    const nativeMod = await import('../src/native-filter.js');
    try {
        // 1. Setup #wbo-mobile-editor-trigger
        const wiDrawer = dom.doc.createElement('div');
        wiDrawer.id = 'WorldInfo';
        const multiSel = dom.doc.createElement('div');
        multiSel.id = 'WIMultiSelector';
        const globalSel = dom.doc.createElement('select');
        globalSel.id = 'world_info';
        globalSel.multiple = true;
        multiSel.appendChild(globalSel);

        const worldPopup = dom.doc.createElement('div');
        worldPopup.id = 'world_popup';
        const editorSel = dom.doc.createElement('select');
        editorSel.id = 'world_editor_select';
        for (const [val, txt] of [['', '--- Pick to Edit ---'], ['0', '书A'], ['1', '书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            editorSel.appendChild(opt);
        }
        worldPopup.appendChild(editorSel);
        wiDrawer.appendChild(multiSel);
        wiDrawer.appendChild(worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        // 2. Setup <dialog> with .persona_world_info_selector for attachGroupedSelectControl
        const dialog = dom.doc.createElement('dialog');
        const personaPopup = dom.doc.createElement('div');
        personaPopup.className = 'persona_world';
        const personaSel = dom.doc.createElement('select');
        personaSel.className = 'persona_world_info_selector';
        for (const [val, txt] of [['', '--- None ---'], ['0', '书A'], ['1', '书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            personaSel.appendChild(opt);
        }
        personaPopup.appendChild(personaSel);
        dialog.appendChild(personaPopup);
        dom.doc.body.appendChild(dialog);

        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 书A: 'g1' },
            showNativeOptgroups: true,
            adaptPersonaBindPopup: true,
        });
        const cls = classifyWorldbooks({
            worldNames: ['书A', '书B'],
            bindingMap: new Map(),
            settings,
        });

        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });
        nativeMod.startNativeObservers(() => {});

        const bodyObserver = dom.observerInstances.find((o) => o.target === dom.doc.body && o.options?.childList);
        assert.ok(bodyObserver);
        bodyObserver.cb([{ addedNodes: [dialog] }]);

        // --- Part A: #wbo-mobile-editor-trigger ---
        const editorTrigger = dom.doc.getElementById('wbo-mobile-editor-trigger');
        assert.ok(editorTrigger);
        editorTrigger._rect = { left: 20, top: 120, right: 260, bottom: 156, width: 240, height: 36 };

        // Tap #1: opens picker
        editorTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        let editorOverlay = dom.doc.getElementById('wbo-mobile-picker-overlay');
        assert.ok(editorOverlay && editorOverlay.isConnected, 'Tap #1 should open #wbo-mobile-picker-overlay');
        assert.equal(editorTrigger.classList.contains('is-open'), true);

        // Tap #2: real-browser hit-testing sends pointerdown onto .wbo-mp-backdrop inside trigger rect,
        // which removes overlay, then synthesized click lands on uncovered triggerEl underneath.
        editorOverlay.dispatchEvent(new dom.MockEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            clientX: 100,
            clientY: 138,
        }));
        assert.equal(editorOverlay.isConnected, false, 'pointerdown on backdrop must remove #wbo-mobile-picker-overlay');
        editorTrigger.dispatchEvent(new dom.MockEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: 100,
            clientY: 138,
        }));
        assert.equal(dom.doc.getElementById('wbo-mobile-picker-overlay'), null, 'trailing click after backdrop pointerdown over trigger must NOT reopen #wbo-mobile-picker-overlay');
        assert.equal(editorTrigger.classList.contains('is-open'), false, 'editor trigger must stay closed (is-open: false)');
        assert.equal(editorTrigger.dataset.wboDismissedTapAt, undefined, 'dismiss stamp must be consumed and deleted');

        // Tap #3 (immediate): opens cleanly again
        editorTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        editorOverlay = dom.doc.getElementById('wbo-mobile-picker-overlay');
        assert.ok(editorOverlay && editorOverlay.isConnected, 'Tap #3 must reopen #wbo-mobile-picker-overlay cleanly');
        assert.equal(editorTrigger.classList.contains('is-open'), true);

        // Dismiss outside trigger rect leaves no stamp and allows immediate next click on trigger
        editorOverlay.dispatchEvent(new dom.MockEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            clientX: 5,
            clientY: 5,
        }));
        assert.equal(editorOverlay.isConnected, false);
        assert.equal(editorTrigger.dataset.wboDismissedTapAt, undefined);
        editorTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        assert.ok(dom.doc.getElementById('wbo-mobile-picker-overlay')?.isConnected, 'clicking trigger after outside-rect dismiss must open immediately');
        // Clean close before Part B
        editorTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        assert.equal(dom.doc.getElementById('wbo-mobile-picker-overlay'), null);

        // --- Part B: attachGroupedSelectControl .wbo-popup-select-trigger ---
        const popTrigger = personaPopup.querySelector('.wbo-popup-select-trigger');
        assert.ok(popTrigger);
        popTrigger._rect = { left: 40, top: 200, right: 280, bottom: 236, width: 240, height: 36 };

        // Tap #1: opens grouped popup popover
        popTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        let popOverlay = dialog.querySelector('.wbo-mp-backdrop');
        assert.ok(popOverlay && popOverlay.isConnected, 'Tap #1 should open .wbo-mp-backdrop inside dialog');
        assert.equal(popTrigger.classList.contains('is-open'), true);

        // Tap #2: pointerdown on .wbo-mp-backdrop over trigger rect -> click on trigger
        popOverlay.dispatchEvent(new dom.MockEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            clientX: 150,
            clientY: 218,
        }));
        assert.equal(popOverlay.isConnected, false, 'pointerdown on backdrop must remove popup .wbo-mp-backdrop');
        popTrigger.dispatchEvent(new dom.MockEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: 150,
            clientY: 218,
        }));
        assert.equal(dialog.querySelector('.wbo-mp-backdrop'), null, 'trailing click after backdrop pointerdown over popup trigger must NOT reopen popover');
        assert.equal(popTrigger.classList.contains('is-open'), false, 'popup trigger must stay closed (is-open: false)');
        assert.equal(popTrigger.dataset.wboDismissedTapAt, undefined, 'popup dismiss stamp must be consumed and deleted');

        // Tap #3 (immediate): opens cleanly again
        popTrigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        popOverlay = dialog.querySelector('.wbo-mp-backdrop');
        assert.ok(popOverlay && popOverlay.isConnected, 'Tap #3 must reopen popup .wbo-mp-backdrop cleanly');
        assert.equal(popTrigger.classList.contains('is-open'), true);
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});

test('narrow worldbook preview keeps the summary, sort picker and binding action readable', () => {
    const css = readStyleSource();
    assert.match(css, /\.wbo-acc-summary\s*\{[^}]*white-space:\s*nowrap/s);
    assert.match(css, /\.wbo-preview-head\s*\{[^}]*flex-wrap:\s*wrap/s);
    assert.match(css, /@container\s+plugin-win\s*\(max-width:\s*600px\)[\s\S]*?\.wbo-book-preview\s+\.wbo-preview-head-actions\s*>\s*:not\(\.wbo-acc-sort-control\)\s*\{\s*display:\s*none\s*!important;/);
    assert.match(css, /@media\s*\(max-width:\s*680px\)[\s\S]*?\.wbo-book-preview\s+\.wbo-preview-head-actions\s*>\s*:not\(\.wbo-acc-sort-control\)\s*\{\s*display:\s*none\s*!important;/);
});

test('v2.35.1 polish: deleteWorldbookEntryDirect, gr-option pin stars across flat/grouped/re-rendered popovers, no duplicate scan status, and standard undo SVG', async () => {
    const panelSrc = readPanelSource();
    const accSrc = readFileSync(new URL('../src/entry-accordion.js', import.meta.url), 'utf8');
    const cssSrc = readStyleSource();

    // 1. Zero ugly Unicode undo/redo arrows anywhere in panel.js or entry-accordion.js
    assert.ok(!panelSrc.includes('↶') && !panelSrc.includes('↷'), 'panel.js must not use ugly Unicode undo arrows');
    assert.ok(!accSrc.includes('↶') && !accSrc.includes('↷'), 'entry-accordion.js must not use ugly Unicode undo arrows');

    // 2. Scan modal has ONLY ONE #wbo-scan-status and zero #wbo-scan-top-status duplicate ID
    assert.ok(!panelSrc.includes('id="wbo-scan-top-status"'), 'duplicate scan status box removed');
    assert.equal((panelSrc.match(/id="wbo-scan-status"/g) || []).length, 1, 'exactly one scan status element');

    // 3. A legacy settings record alone must not be used as an install marker.
    const legacySrc = readFileSync(new URL('../src/entry-groups/legacy.js', import.meta.url), 'utf8');
    assert.ok(legacySrc.includes('disabledExtensions'));
    assert.ok(!panelSrc.includes('ctx?.extensionSettings?.worldbook_entry_groups !== undefined'));

    // 4. Tall mode never calls scrollIntoView on contentArea, and find nav wraps prev+next together
    assert.ok(!accSrc.includes('contentArea.scrollIntoView'), 'tall mode must keep scroll position stationary');
    assert.ok(accSrc.includes('class="wbo-acc-find-nav"'), 'find prev/next grouped in indivisible nav container');
    assert.ok(accSrc.includes('data-acc-ta-backdrop'), 'live in-textarea keyword highlight backdrop present');
    assert.ok(accSrc.includes('data-acc-delete'), 'delete entry button present in accordion editor');
    assert.match(cssSrc, /\.wbo-diff-chips\s+\.wbo-tag[\s\S]*?white-space:\s*normal/);

    // 5. Test deleteWorldbookEntryDirect against mocked /api/worldinfo/get + /api/worldinfo/edit
    const prevFetch = globalThis.fetch;
    let savedPayload = null;
    try {
        globalThis.fetch = async (url, init) => {
            const u = String(url);
            if (u.includes('/api/worldinfo/get')) {
                return {
                    ok: true,
                    json: async () => ({
                        entries: {
                            '10': { uid: 10, comment: '保留项', content: 'A' },
                            '20': { uid: 20, comment: '待删项', content: 'B' },
                        },
                    }),
                };
            }
            if (u.includes('/api/worldinfo/edit')) {
                savedPayload = JSON.parse(init.body);
                return { ok: true, json: async () => ({ ok: true }) };
            }
            return { ok: false, status: 404 };
        };
        const hostMod = await import('../src/host.js');
        const delRes = await hostMod.deleteWorldbookEntryDirect('测试世界书', '20');
        assert.equal(delRes.ok, true);
        assert.equal(delRes.uid, '20');
        assert.ok(savedPayload && Object.hasOwn(savedPayload.data.entries, '10'));
        assert.ok(!Object.hasOwn(savedPayload.data.entries, '20'));
    } finally {
        globalThis.fetch = prevFetch;
    }
});
