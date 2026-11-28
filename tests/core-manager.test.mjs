/**
 * accordion editor and group-manager surfaces (M3).
 *
 * Split out of tests/core.test.mjs without touching a single test body: names and order within
 * this file are unchanged, and the shared helpers live in ./core-prelude.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPECIAL_GROUPS, addCustomGroup, buildCharacterBindingIndex, classifyWorldbooks, computeScanPromptState, installMockNativeFilterDom, moveBooksToNamedGroup, normalizeSettings, promoteSectionToTop, readPanelSource, readStyleSource } from './core-prelude.mjs';

test('M3 R2, R3 & R5 panel.js: 3-button+gear header, visibility-skipping moves, 全部 pinned hoisting, bare 当前编辑, scan prompt + 1-click assign, floating settings & Quick Hub split isolation', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevConfirm = globalThis.confirm;
    const prevSetTimeout = globalThis.setTimeout;
    const panelMod = await import('../src/panel.js');

    const settings = normalizeSettings({
        showCharBooks: false,
        activeFilterGroupId: SPECIAL_GROUPS.DEFAULT,
        autoScanNewCharacters: true,
        globalPresets: [{ id: 'gp1', name: '常用套', books: ['通用书'] }],
        pinnedBooks: ['通用书'],
    });
    const grpA = addCustomGroup(settings, { name: '设定组A' });
    const grpB = addCustomGroup(settings, { name: '设定组B' });
    settings.assignments['通用书'] = grpA.id;

    const characters = [
        { name: '同名角色甲', avatar: 'han.png', shallow: false, data: { name: '同名角色甲', extensions: {} } },
        { name: '角色乙', avatar: 'lu.png', shallow: false, data: { name: '角色乙', extensions: { world: '角色乙主世界书' } } },
    ];
    const worldNames = ['角色乙主世界书', '同名角色甲', '通用书', '未分组书'];
    let currentEditorName = '角色乙主世界书';
    const mutationCalls = [];

    const wiDrawer = dom.doc.createElement('div');
    wiDrawer.id = 'WorldInfo';
    const wiHeader = dom.doc.createElement('div');
    wiHeader.className = 'flex-container';
    const pinDiv = dom.doc.createElement('div');
    pinDiv.id = 'WI_panel_pin_div';
    wiHeader.appendChild(pinDiv);
    wiDrawer.appendChild(wiHeader);
    dom.doc.body.appendChild(wiDrawer);

    const editorSelect = dom.doc.createElement('select');
    editorSelect.id = 'world_editor_select';
    for (const [idx, n] of worldNames.entries()) {
        const opt = dom.doc.createElement('option');
        opt.value = String(idx);
        opt.textContent = n;
        if (n === currentEditorName) opt.selected = true;
        editorSelect.appendChild(opt);
    }
    const worldInfoSelect = dom.doc.createElement('select');
    worldInfoSelect.id = 'world_info';
    worldInfoSelect.multiple = true;
    for (const [idx, n] of worldNames.entries()) {
        const opt = dom.doc.createElement('option');
        opt.value = String(idx);
        opt.textContent = n;
        worldInfoSelect.appendChild(opt);
    }
    dom.doc.body.appendChild(editorSelect);
    dom.doc.body.appendChild(worldInfoSelect);

    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getWorldInfoNames: () => [...worldNames],
            world_names: [...worldNames],
        }),
    };

    const recomputeState = () => {
        const bindingMap = buildCharacterBindingIndex({
            characters,
            charLore: [],
            cachedCharBindings: settings.cachedCharBindings,
            worldNamesSet: new Set(worldNames),
            includeExtraCharBooks: true,
            includeEmbeddedNameMatch: true,
        });
        const classification = classifyWorldbooks({
            worldNames,
            bindingMap,
            personaMap: new Map(),
            settings,
        });
        return { settings, bindingMap, classification };
    };

    try {
        globalThis.confirm = () => true;
        let state = recomputeState();
        panelMod.bindPanelCallbacks({
            getState: () => state,
            onMutation: async (opts = {}) => {
                mutationCalls.push(opts);
                if (opts.uiOnly) {
                    if (opts.quickActionsOnly) panelMod.syncNativeQuickActionsUi();
                    return;
                }
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });

        panelMod.openManagerModal();

        // 1. Follow-up 15:18Z 3-button header [整理, 组合, 扫描] + gear icon in header-actions + no #wbo-mgr-combo-bar
        const headerTools = [...dom.doc.querySelectorAll('#wbo-manager-overlay .wbo-mgr-header-tools > .wbo-tool-btn')]
            .map((b) => b.textContent.trim().replace(/\s+/g, ' '));
        assert.deepEqual(headerTools, ['整理', '组合 1', '扫描']);
        assert.ok(dom.doc.querySelector('#wbo-manager-overlay .wbo-modal-header-actions .wbo-modal-settings-btn'), 'gear icon in header actions');
        assert.equal(dom.doc.getElementById('wbo-mgr-combo-bar'), null, 'bulky combo bar removed from main panel body');

        // 2. R1/R4 clean drag hint + R3 scan prompt + no dark .is-active on scan btn
        const dragHint = dom.doc.querySelector('#wbo-manager-overlay .wbo-mgr-drag-hint');
        assert.ok(dragHint && !dragHint.textContent.includes('展开态亦可') && !dragHint.textContent.includes('提示：'));
        const scanBtn = dom.doc.getElementById('wbo-mgr-scan-btn');
        assert.ok(scanBtn && !scanBtn.classList.contains('is-active'), 'scan btn must not have heavy dark .is-active border');
        const scanPrompt = dom.doc.getElementById('wbo-mgr-scan-prompt');
        assert.ok(scanPrompt && !scanPrompt.hidden && scanPrompt.textContent.includes('同名'), '1-line prompt shown for unbound same-name book 同名角色甲');

        // 3. R2 bare 当前编辑 when editing hidden char book outside showCharBooks
        const bareEditing = dom.doc.querySelector('#wbo-manager-overlay .wbo-mgr-bare-editing');
        assert.ok(bareEditing, 'hidden edited char book renders bare at top');
        assert.equal(bareEditing.querySelector('.wbo-book-row')?.getAttribute('data-book'), '角色乙主世界书');
        assert.ok(bareEditing.querySelector('.wbo-s2-badge.is-editing'), 'bare 当前编辑 carries inline badge');
        assert.equal(dom.doc.querySelector(`#wbo-manager-overlay .wbo-group[data-group-id="${SPECIAL_GROUPS.CHARACTER}"]`), null, 'no 角色世界书 (1) wrapper');

        // 4. R2 visibility-skipping section move arrows: when showCharBooks=false, UNGROUPED is visible #1 (canMoveUp=false!)
        const visibleGroups = dom.doc.querySelectorAll('#wbo-mgr-groups-list .wbo-group[data-group-id]');
        assert.deepEqual(visibleGroups.map((g) => g.getAttribute('data-group-id')), [SPECIAL_GROUPS.UNGROUPED, grpA.id, grpB.id]);
        const ungroupedUpBtn = visibleGroups[0].querySelector('[data-action="move-section-up"]');
        const ungroupedDownBtn = visibleGroups[0].querySelector('[data-action="move-section-down"]');
        assert.equal(ungroupedUpBtn.disabled, true, 'first visible section UNGROUPED must have disabled up arrow even though hidden __char__ precedes it');
        assert.equal(ungroupedDownBtn.disabled, false);

        // Single click on UNGROUPED down arrow skips nothing visible and swaps directly past hidden sections with grpA
        ungroupedDownBtn.click();
        await new Promise((r) => prevSetTimeout(r, 5));
        assert.deepEqual(
            dom.doc.querySelectorAll('#wbo-mgr-groups-list .wbo-group[data-group-id]').map((g) => g.getAttribute('data-group-id')),
            [grpA.id, SPECIAL_GROUPS.UNGROUPED, grpB.id],
        );

        // 5. R2 全部 view hoists 角色世界书 #1 and ★ 已置顶 #2 (both non-movable)
        settings.showCharBooks = true;
        promoteSectionToTop(settings, SPECIAL_GROUPS.CHARACTER);
        state = recomputeState();
        panelMod.renderEmbeddedPanel();
        const allViewIds = dom.doc.querySelectorAll('#wbo-mgr-groups-list .wbo-group[data-group-id]').map((g) => g.getAttribute('data-group-id'));
        assert.deepEqual(allViewIds.slice(0, 2), [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.PINNED]);
        assert.equal(dom.doc.querySelector(`#wbo-mgr-groups-list .wbo-group[data-group-id="${SPECIAL_GROUPS.PINNED}"] [data-action="move-section-up"]`), null);

        // 6. R3 Scan modal surfaces 同名角色甲 + 1-click 归入角色世界书 clears prompt & blurs scanBtn
        scanBtn.focus();
        scanBtn.click();
        const assignCharBtn = dom.doc.querySelector('[data-cov-assign-char="同名角色甲"]');
        assert.ok(assignCharBtn, 'Scan modal must surface unbound same-name book 同名角色甲 with 1-click assign');
        assignCharBtn.click();
        await new Promise((r) => prevSetTimeout(r, 10));
        assert.equal(settings.charBookOverrides['同名角色甲'], 'include_in_char');
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true, 'prompt hides once same-name book is classified');
        dom.doc.querySelector('#wbo-scan-close-btn')?.click();
        assert.notEqual(dom.doc.activeElement, scanBtn, 'closing scan modal blurs #wbo-mgr-scan-btn');

        // 7. R3 移动到分组 includes 角色世界书 and R4 footer has no .wbo-spacer inside .wbo-footer-pair
        dom.doc.querySelector('#wbo-mgr-groups-list .wbo-book-row[data-book="未分组书"] [data-action="book-more-menu"]').click();
        const moveBtn = dom.doc.querySelector('.wbo-book-more-popover [data-more-act="move-group"]');
        assert.ok(moveBtn);
        moveBtn.click();
        const moveCharOpt = dom.doc.querySelector(`.wbo-move-option[data-target-group="${SPECIAL_GROUPS.CHARACTER}"]`);
        assert.ok(moveCharOpt, '移动到分组 includes 角色世界书 for unbound books');
        const moveFooter = dom.doc.querySelector('#wbo-submodal-overlay .wbo-modal-footer.wbo-footer-pair');
        assert.equal(moveFooter.querySelector('.wbo-spacer'), null, 'footer-pair must not contain .wbo-spacer');
        moveCharOpt.click();
        await new Promise((r) => prevSetTimeout(r, 5));
        assert.equal(settings.charBookOverrides['未分组书'], 'include_in_char');

        // 8. R5 Non-blocking Settings + quickActionsOnly topbar stability
        dom.doc.querySelector('#wbo-manager-overlay [data-action="open-settings-modal"]').click();
        const settingsOverlay = dom.doc.getElementById('wbo-submodal-overlay');
        assert.ok(settingsOverlay.classList.contains('wbo-floating-overlay'), 'Settings overlay must be non-blocking floating');
        assert.ok(settingsOverlay.querySelector('input[data-setting="syncEntryOrderOnDrag"]'), 'Settings exposes syncEntryOrderOnDrag');
        const beforeMutLen = mutationCalls.length;
        settingsOverlay.querySelector('[data-quick-actions-mode="split"]').click();
        await new Promise((r) => prevSetTimeout(r, 5));
        assert.equal(mutationCalls[beforeMutLen]?.uiOnly, true);
        assert.equal(mutationCalls[beforeMutLen]?.quickActionsOnly, true);
        dom.doc.querySelector('#wbo-settings-close-btn')?.click();

        // 9. R5 Quick Hub split-mode isolation + direct combo delete
        const cbBtn = dom.doc.getElementById('wbo-wi-combo-btn');
        assert.ok(cbBtn);
        cbBtn.click();
        const qhubPop = dom.doc.querySelector('.wbo-qhub-popover');
        assert.ok(qhubPop, 'Quick Hub opens in split mode');
        assert.equal(qhubPop.querySelector('.wbo-qhub-tabs'), null, 'split mode hides cross-tab bar');
        assert.equal(qhubPop.querySelector('.wbo-qe-foot'), null, 'split mode omits 分组管理/搜条目 footer');
        const delComboBtn = qhubPop.querySelector('[data-qhub-delete="gp1"]');
        assert.ok(delComboBtn, 'Quick Hub renders direct combo delete button');
        delComboBtn.click();
        await new Promise((r) => prevSetTimeout(r, 5));
        assert.equal(settings.globalPresets.length, 0, 'direct delete removes global combo');
    } finally {
        panelMod.teardownPanels();
        globalThis.confirm = prevConfirm;
        dom.restore();
    }
});

test('M3 R4 & R5 static CSS guardrails: switch capsule !important, footer alignment, floating overlay, and 3-button header grid', () => {
    const css = readStyleSource();
    const panelSrc = readPanelSource();

    // Switch capsule isolation
    assert.match(css, /\.wbo-tool-switch\s*>\s*input,\s*\r?\n\.wbo-modal\s+\.wbo-tool-switch\s*>\s*input\[type="checkbox"\]\s*\{[\s\S]*?position:\s*absolute\s*!important;[\s\S]*?width:\s*1px\s*!important;/);
    assert.match(css, /:not\(\.wbo-show-char-checkbox\):not\(\.wbo-acc-toggle-enable\)/);
    assert.match(css, /\.wbo-eb-switch\s*\{[\s\S]*?padding:\s*0\s+6px\s*!important;/);

    // Floating submodal pass-through & 3-button header grid
    assert.match(css, /\.wbo-submodal-overlay\.wbo-floating-overlay\s*\{\s*pointer-events:\s*none;\s*\}/);
    assert.match(css, /@media\s*\(max-width:\s*680px\)[\s\S]*?\.wbo-mgr-header-tools\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/);
    assert.match(css, /@container\s+plugin-win\s*\(max-width:\s*600px\)[\s\S]*?\.wbo-mgr-header-tools\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/);

    // Modal footer fixes
    assert.match(css, /@container\s+plugin-win\s*\(max-width:\s*600px\)[\s\S]*?\.wbo-ai-footer\.wbo-ai-footer-single\s*\{[\s\S]*?flex-direction:\s*row;/);
    assert.match(css, /@container\s+plugin-win\s*\(max-width:\s*600px\)[\s\S]*?\.wbo-modal-footer\.wbo-footer-pair\s*>\s*\.wbo-spacer\s*\{\s*display:\s*none\s*!important;\s*\}/);

    // Clean copy & preview dedup in panel.js
    assert.equal(panelSrc.includes('（展开态亦可）'), false);
    assert.equal(panelSrc.includes('直编'), false);
    assert.equal(panelSrc.includes('id="wbo-mgr-combo-bar"'), false);
    assert.equal(panelSrc.includes('data-acc-extra="edit-book"'), false);
    assert.equal(panelSrc.includes('data-acc-extra="delete-single-book"'), false);

    // M3 R2 CSS regressions: keep [data-acc-sort] visible in .wbo-book-preview on mobile/narrow & 601-680px single-footer parity
    assert.equal(
        /\.wbo-book-preview\s+\.wbo-preview-head-actions\s*\{\s*display:\s*none/i.test(css),
        false,
        'style.css must NOT hide .wbo-book-preview .wbo-preview-head-actions (would hide [data-acc-sort])',
    );
    assert.match(css, /@media\s*\(max-width:\s*680px\)[\s\S]*?\.wbo-ai-footer\.wbo-ai-footer-single\s+\.wbo-ai-footer-right\s*>\s*\.wbo-btn\s*\{[\s\S]*?height:\s*30px\s*!important;/);
});

test('M3 R2 regression: syncEmbeddedPanelIndicators & toggle-global during active search filtering out edited char book never recurse infinitely', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevConfirm = globalThis.confirm;
    const prevSetTimeout = globalThis.setTimeout;
    const panelMod = await import('../src/panel.js');

    const settings = normalizeSettings({
        showCharBooks: false,
        activeFilterGroupId: SPECIAL_GROUPS.DEFAULT,
    });
    const characters = [
        { name: '角色乙', avatar: 'lu.png', shallow: false, data: { name: '角色乙', extensions: { world: '角色乙主世界书' } } },
    ];
    const worldNames = ['角色乙主世界书', '通用书'];

    const editorSelect = dom.doc.createElement('select');
    editorSelect.id = 'world_editor_select';
    for (const [idx, n] of worldNames.entries()) {
        const opt = dom.doc.createElement('option');
        opt.value = String(idx);
        opt.textContent = n;
        if (n === '角色乙主世界书') opt.selected = true;
        editorSelect.appendChild(opt);
    }
    const worldInfoSelect = dom.doc.createElement('select');
    worldInfoSelect.id = 'world_info';
    worldInfoSelect.multiple = true;
    for (const [idx, n] of worldNames.entries()) {
        const opt = dom.doc.createElement('option');
        opt.value = String(idx);
        opt.textContent = n;
        worldInfoSelect.appendChild(opt);
    }
    dom.doc.body.appendChild(editorSelect);
    dom.doc.body.appendChild(worldInfoSelect);

    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getWorldInfoNames: () => [...worldNames],
            world_names: [...worldNames],
        }),
    };

    const recomputeState = () => {
        const bindingMap = buildCharacterBindingIndex({
            characters,
            charLore: [],
            cachedCharBindings: settings.cachedCharBindings,
            worldNamesSet: new Set(worldNames),
            includeExtraCharBooks: true,
            includeEmbeddedNameMatch: true,
        });
        const classification = classifyWorldbooks({
            worldNames,
            bindingMap,
            personaMap: new Map(),
            settings,
        });
        return { settings, bindingMap, classification };
    };

    try {
        globalThis.confirm = () => true;
        let state = recomputeState();
        panelMod.bindPanelCallbacks({
            getState: () => state,
            onMutation: async (opts = {}) => {
                if (opts.uiOnly) return;
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });

        panelMod.openManagerModal();
        assert.ok(dom.doc.querySelector('#wbo-mgr-groups-list .wbo-mgr-bare-editing'), 'initial bare editing row present before search');

        // Search filters out 角色乙主世界书 while keeping 通用书 visible
        const searchInput = dom.doc.getElementById('wbo-mgr-search-input');
        assert.ok(searchInput);
        searchInput.value = '通用';
        searchInput.dispatchEvent(new dom.MockEvent('input', { bubbles: true }));
        await new Promise((r) => prevSetTimeout(r, 110));

        const listEl = dom.doc.getElementById('wbo-mgr-groups-list');
        assert.equal(listEl.querySelector('.wbo-mgr-bare-editing'), null, 'search hides non-matching bare editing row');
        const visibleRow = listEl.querySelector('.wbo-book-row[data-book="通用书"]');
        assert.ok(visibleRow, 'matching non-char book remains visible');

        // Direct syncEmbeddedPanelIndicators() & toggle-global must not throw RangeError
        assert.doesNotThrow(() => panelMod.syncEmbeddedPanelIndicators());
        const globalBtn = visibleRow.querySelector('[data-action="toggle-global"]');
        assert.ok(globalBtn);
        assert.doesNotThrow(() => globalBtn.click());
        await new Promise((r) => prevSetTimeout(r, 10));
        assert.equal(worldInfoSelect.options[1].selected, true, 'toggle-global activates 通用书 without recursion');
        assert.ok(visibleRow.classList.contains('is-active'));
    } finally {
        panelMod.teardownPanels();
        globalThis.confirm = prevConfirm;
        dom.restore();
    }
});

test('M3 R2 regression: 1-click 归入角色世界书 on embedded same-name book persists include_in_char, clears 同名待归类, and hides scan prompt', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevConfirm = globalThis.confirm;
    const prevSetTimeout = globalThis.setTimeout;
    const panelMod = await import('../src/panel.js');

    const settings = normalizeSettings({
        includeEmbeddedNameMatch: true,
        autoScanNewCharacters: true,
    });
    const characters = [
        {
            name: '角色F',
            avatar: 'charF.png',
            shallow: false,
            data: {
                name: '角色F',
                extensions: { world: '主书F' },
                character_book: { name: '旧内嵌F', entries: [] },
            },
        },
    ];
    const worldNames = ['主书F', '旧内嵌F'];

    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getWorldInfoNames: () => [...worldNames],
            world_names: [...worldNames],
        }),
    };

    const recomputeState = () => {
        const bindingMap = buildCharacterBindingIndex({
            characters,
            charLore: [],
            cachedCharBindings: settings.cachedCharBindings,
            worldNamesSet: new Set(worldNames),
            includeExtraCharBooks: true,
            includeEmbeddedNameMatch: settings.includeEmbeddedNameMatch !== false,
        });
        const classification = classifyWorldbooks({
            worldNames,
            bindingMap,
            personaMap: new Map(),
            settings,
        });
        return { settings, bindingMap, classification };
    };

    try {
        globalThis.confirm = () => true;
        let state = recomputeState();
        panelMod.bindPanelCallbacks({
            getState: () => state,
            onMutation: async (opts = {}) => {
                if (opts.uiOnly) return;
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });

        panelMod.openManagerModal();
        const scanPrompt = dom.doc.getElementById('wbo-mgr-scan-prompt');
        assert.ok(scanPrompt && !scanPrompt.hidden, 'scan prompt shown for unconfirmed embedded same-name book');

        const scanBtn = dom.doc.getElementById('wbo-mgr-scan-btn');
        assert.ok(scanBtn);
        scanBtn.click();

        const assignBtn = dom.doc.querySelector('[data-cov-assign-char="旧内嵌F"]');
        assert.ok(assignBtn, 'embedded same-name book renders 归入角色世界书 button');
        assert.equal(assignBtn.getAttribute('data-cov-match-kind'), 'embedded');

        assignBtn.click();
        await new Promise((r) => prevSetTimeout(r, 15));

        assert.equal(settings.charBookOverrides['旧内嵌F'], 'include_in_char', 'must record include_in_char override even though meta.isCharBound is true');
        assert.equal(dom.doc.querySelector('[data-cov-assign-char="旧内嵌F"]'), null, 'cleared from 同名待归类 after 1-click assign');
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true, 'scan prompt hides once embedded same-name book is confirmed');
    } finally {
        panelMod.teardownPanels();
        globalThis.confirm = prevConfirm;
        dom.restore();
    }
});

test('M3 R3 regression: assignBookToGroup / openMoveGroupModal round-trip & batch-ungroup preserve embedded charBookOverrides without resurrecting scan prompt', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevConfirm = globalThis.confirm;
    const prevToastr = globalThis.toastr;
    const prevSetTimeout = globalThis.setTimeout;
    const toasts = [];
    const panelMod = await import('../src/panel.js');

    const settings = normalizeSettings({
        showCharBooks: true,
        charGroupCollapsed: false,
        includeEmbeddedNameMatch: true,
        autoScanNewCharacters: true,
        groups: [{ id: 'g1', name: '剧情', color: '#6b7a8c', collapsed: false }],
    });
    const characters = [
        {
            name: '角色F',
            avatar: 'charF.png',
            shallow: false,
            data: {
                name: '角色F',
                extensions: { world: '主书F' },
                character_book: { name: '旧内嵌F', entries: [] },
            },
        },
        {
            name: '角色G',
            avatar: 'charG.png',
            shallow: false,
            data: {
                name: '角色G',
                extensions: {},
                character_book: { name: '内嵌孤书G', entries: [] },
            },
        },
    ];
    const worldNames = ['主书F', '旧内嵌F', '内嵌孤书G'];

    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getWorldInfoNames: () => [...worldNames],
            world_names: [...worldNames],
        }),
    };

    const recomputeState = () => {
        const bindingMap = buildCharacterBindingIndex({
            characters,
            charLore: [],
            cachedCharBindings: settings.cachedCharBindings,
            worldNamesSet: new Set(worldNames),
            includeExtraCharBooks: true,
            includeEmbeddedNameMatch: settings.includeEmbeddedNameMatch !== false,
        });
        const classification = classifyWorldbooks({
            worldNames,
            bindingMap,
            personaMap: new Map(),
            settings,
        });
        return { settings, bindingMap, classification };
    };

    const moveViaModal = async (bookName, targetGroupId) => {
        const row = dom.doc.querySelector(`#wbo-mgr-groups-list .wbo-book-row[data-book="${bookName}"]`);
        assert.ok(row, `book row for ${bookName} must exist`);
        row.querySelector('[data-action="book-more-menu"]').click();
        const moveBtn = dom.doc.querySelector('.wbo-book-more-popover [data-more-act="move-group"]');
        assert.ok(moveBtn, `move-group button for ${bookName} must exist`);
        moveBtn.click();
        const opt = dom.doc.querySelector(`.wbo-move-option[data-target-group="${targetGroupId}"]`);
        assert.ok(opt, `move option ${targetGroupId} must exist`);
        opt.click();
        await new Promise((r) => prevSetTimeout(r, 15));
    };

    try {
        globalThis.confirm = () => true;
        globalThis.toastr = {
            success: (msg) => toasts.push(['success', msg]),
            info: (msg) => toasts.push(['info', msg]),
            warning: (msg) => toasts.push(['warning', msg]),
            error: (msg) => toasts.push(['error', msg]),
        };
        let state = recomputeState();
        panelMod.bindPanelCallbacks({
            getState: () => state,
            onMutation: async (opts = {}) => {
                if (opts.uiOnly) return;
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });

        panelMod.openManagerModal();

        // 1. Confirm both embedded books via 1-click scan action
        dom.doc.getElementById('wbo-mgr-scan-btn').click();
        for (const name of ['旧内嵌F', '内嵌孤书G']) {
            const btn = dom.doc.querySelector(`[data-cov-assign-char="${name}"]`);
            assert.ok(btn, `1-click assign button for ${name}`);
            btn.click();
            await new Promise((r) => prevSetTimeout(r, 15));
        }
        dom.doc.querySelector('.wbo-submodal-overlay .wbo-modal-close')?.click();
        assert.equal(settings.charBookOverrides['旧内嵌F'], 'include_in_char');
        assert.equal(settings.charBookOverrides['内嵌孤书G'], 'include_in_char');
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true);

        // 2. Round-trip both embedded books: CHARACTER -> custom 'g1' -> CHARACTER
        for (const name of ['旧内嵌F', '内嵌孤书G']) {
            await moveViaModal(name, 'g1');
            assert.equal(settings.assignments[name], 'g1', `${name} moved to g1`);
            assert.equal(settings.charBookOverrides[name], 'exclude_from_char', `${name} excluded from char while in g1`);

            await moveViaModal(name, SPECIAL_GROUPS.CHARACTER);
            assert.equal(settings.assignments[name], undefined, `${name} assignment cleared when moved back to CHARACTER`);
            assert.equal(
                settings.charBookOverrides[name],
                'include_in_char',
                `${name} moved back to CHARACTER must preserve include_in_char instead of deleting override`,
            );
            const promptState = computeScanPromptState({
                worldNames,
                characters,
                bindingMap: state.bindingMap,
                settings,
            });
            assert.equal(promptState.sameNameNeedConfirmCount, 0, `${name} must not resurrect sameNameNeedConfirmCount`);
            assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true, `#wbo-mgr-scan-prompt must stay hidden after ${name} round-trip`);
        }

        // 3. Unconfirmed embedded book already in CHARACTER moved to CHARACTER via openMoveGroupModal still confirms include_in_char
        delete settings.charBookOverrides['内嵌孤书G'];
        panelMod.teardownPanels();
        state = recomputeState();
        panelMod.bindPanelCallbacks({
            getState: () => state,
            onMutation: async (opts = {}) => {
                if (opts.uiOnly) return;
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });
        panelMod.openManagerModal();
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, false);
        await moveViaModal('内嵌孤书G', SPECIAL_GROUPS.CHARACTER);
        assert.equal(settings.charBookOverrides['内嵌孤书G'], 'include_in_char');
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true);

        // 4. batch-ungroup preserves exclude_from_char on embedded books in custom groups,
        //    and restores real-bound books from UNGROUPED with accurate toast (not "原本就未分组")
        await moveViaModal('旧内嵌F', 'g1');
        await moveViaModal('主书F', SPECIAL_GROUPS.UNGROUPED);
        assert.equal(settings.charBookOverrides['旧内嵌F'], 'exclude_from_char');
        assert.equal(settings.charBookOverrides['主书F'], 'exclude_from_char');

        dom.doc.getElementById('wbo-mgr-batch-btn').click();
        const embCheck = dom.doc.querySelector('#wbo-mgr-groups-list .wbo-book-row[data-book="旧内嵌F"] .wbo-batch-check');
        assert.ok(embCheck);
        embCheck.checked = true;
        embCheck.click();
        dom.doc.querySelector('[data-action="batch-ungroup"]').click();
        await new Promise((r) => prevSetTimeout(r, 20));
        assert.equal(settings.assignments['旧内嵌F'], undefined, 'embedded book removed from custom group g1');
        assert.equal(settings.charBookOverrides['旧内嵌F'], 'exclude_from_char', 'batch-ungroup must keep exclude_from_char on embedded book');
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true);

        const realCheck = dom.doc.querySelector('#wbo-mgr-groups-list .wbo-book-row[data-book="主书F"] .wbo-batch-check');
        assert.ok(realCheck);
        realCheck.checked = true;
        realCheck.click();
        dom.doc.querySelector('[data-action="batch-ungroup"]').click();
        await new Promise((r) => prevSetTimeout(r, 20));
        assert.equal(settings.charBookOverrides['主书F'], undefined, 'real primary book restored to CHARACTER');
        assert.deepEqual(toasts.at(-1), ['success', '已解除 1 本世界书的分组'], 'must not emit false 原本就未分组 toast when exclude_from_char was cleared');

        // 5. batch-ungroup on already-ungrouped excluded embedded book preserves exclude_from_char and emits info toast
        const embUngroupedCheck = dom.doc.querySelector('#wbo-mgr-groups-list .wbo-book-row[data-book="旧内嵌F"] .wbo-batch-check');
        assert.ok(embUngroupedCheck);
        embUngroupedCheck.checked = true;
        embUngroupedCheck.click();
        dom.doc.querySelector('[data-action="batch-ungroup"]').click();
        await new Promise((r) => prevSetTimeout(r, 20));
        assert.equal(settings.charBookOverrides['旧内嵌F'], 'exclude_from_char');
        assert.deepEqual(toasts.at(-1), ['info', '选中的世界书原本就未分组']);
    } finally {
        panelMod.teardownPanels();
        globalThis.confirm = prevConfirm;
        if (prevToastr === undefined) delete globalThis.toastr;
        else globalThis.toastr = prevToastr;
        dom.restore();
    }
});

test('M3 R3 regression: AI organize isCharBoundFn persists include_in_char when assigning embedded book to 角色世界书', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevConfirm = globalThis.confirm;
    const prevDetails = globalThis.HTMLDetailsElement;
    const prevSetTimeout = globalThis.setTimeout;
    const panelMod = await import('../src/panel.js');

    const settings = normalizeSettings({
        includeEmbeddedNameMatch: true,
        autoScanNewCharacters: true,
        groups: [{ id: 'g1', name: '剧情', color: '#6b7a8c', collapsed: false }],
        assignments: { '旧内嵌F': 'g1' },
        charBookOverrides: { '旧内嵌F': 'exclude_from_char' },
    });
    const characters = [
        {
            name: '角色F',
            avatar: 'charF.png',
            shallow: false,
            data: {
                name: '角色F',
                extensions: { world: '主书F' },
                character_book: { name: '旧内嵌F', entries: [] },
            },
        },
    ];
    const worldNames = ['主书F', '旧内嵌F'];

    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getWorldInfoNames: () => [...worldNames],
            world_names: [...worldNames],
        }),
    };

    const recomputeState = () => {
        const bindingMap = buildCharacterBindingIndex({
            characters,
            charLore: [],
            cachedCharBindings: settings.cachedCharBindings,
            worldNamesSet: new Set(worldNames),
            includeExtraCharBooks: true,
            includeEmbeddedNameMatch: settings.includeEmbeddedNameMatch !== false,
        });
        const classification = classifyWorldbooks({
            worldNames,
            bindingMap,
            personaMap: new Map(),
            settings,
        });
        return { settings, bindingMap, classification };
    };

    try {
        globalThis.confirm = () => true;
        globalThis.HTMLDetailsElement = globalThis.HTMLElement;
        let state = recomputeState();
        panelMod.bindPanelCallbacks({
            getState: () => state,
            onMutation: async (opts = {}) => {
                if (opts.uiOnly) return;
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });

        panelMod.openManagerModal();
        dom.doc.querySelector('[data-action="open-ai-organize"]').click();

        const jsonInput = dom.doc.getElementById('wbo-ai-json-input');
        assert.ok(jsonInput);
        jsonInput.value = JSON.stringify([{ realName: '旧内嵌F', group: '角色世界书' }]);
        dom.doc.getElementById('wbo-ai-parse-paste-btn').click();

        const applyBtn = dom.doc.getElementById('wbo-ai-apply-btn');
        assert.ok(applyBtn);
        applyBtn.click();
        await new Promise((r) => prevSetTimeout(r, 20));

        assert.equal(settings.assignments['旧内嵌F'], undefined);
        assert.equal(
            settings.charBookOverrides['旧内嵌F'],
            'include_in_char',
            'assigning embedded book to 角色世界书 via AI organize must persist include_in_char',
        );
        assert.equal(state.classification.byName.get('旧内嵌F')?.groupId, SPECIAL_GROUPS.CHARACTER);
        const promptState = computeScanPromptState({
            worldNames,
            characters,
            bindingMap: state.bindingMap,
            settings,
        });
        assert.equal(promptState.sameNameNeedConfirmCount, 0);
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true);
    } finally {
        panelMod.teardownPanels();
        globalThis.confirm = prevConfirm;
        if (prevDetails === undefined) delete globalThis.HTMLDetailsElement;
        else globalThis.HTMLDetailsElement = prevDetails;
        dom.restore();
    }
});

test('M3 R4 regression: AI organize outbound moves to custom group or 未分组 set exclude_from_char for embedded and real char-bound books without resurrecting scan prompt', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevConfirm = globalThis.confirm;
    const prevDetails = globalThis.HTMLDetailsElement;
    const prevSetTimeout = globalThis.setTimeout;
    const panelMod = await import('../src/panel.js');

    const settings = normalizeSettings({
        includeEmbeddedNameMatch: true,
        autoScanNewCharacters: true,
        groups: [{ id: 'g1', name: '剧情', color: '#6b7a8c', collapsed: false }],
        assignments: {},
        charBookOverrides: {
            '旧内嵌F': 'include_in_char',
            '成人向_角色H内嵌': 'include_in_char',
            '同名角色甲': 'include_in_char',
        },
    });
    const characters = [
        {
            name: '角色F',
            avatar: 'charF.png',
            shallow: false,
            data: {
                name: '角色F',
                extensions: { world: '主书F' },
                character_book: { name: '旧内嵌F', entries: [] },
            },
        },
        {
            name: '角色H',
            avatar: 'charH.png',
            shallow: false,
            data: {
                name: '角色H',
                extensions: {},
                character_book: { name: '成人向_角色H内嵌', entries: [] },
            },
        },
    ];
    const worldNames = ['主书F', '旧内嵌F', '成人向_角色H内嵌', '同名角色甲'];

    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getWorldInfoNames: () => [...worldNames],
            world_names: [...worldNames],
        }),
    };

    const recomputeState = () => {
        const bindingMap = buildCharacterBindingIndex({
            characters,
            charLore: [],
            cachedCharBindings: settings.cachedCharBindings,
            worldNamesSet: new Set(worldNames),
            includeExtraCharBooks: true,
            includeEmbeddedNameMatch: settings.includeEmbeddedNameMatch !== false,
        });
        const classification = classifyWorldbooks({
            worldNames,
            bindingMap,
            personaMap: new Map(),
            settings,
        });
        return { settings, bindingMap, classification };
    };

    try {
        globalThis.confirm = () => true;
        globalThis.HTMLDetailsElement = globalThis.HTMLElement;
        let state = recomputeState();
        panelMod.bindPanelCallbacks({
            getState: () => state,
            onMutation: async (opts = {}) => {
                if (opts.uiOnly) return;
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });

        panelMod.openManagerModal();
        dom.doc.querySelector('[data-action="open-ai-organize"]').click();

        const jsonInput = dom.doc.getElementById('wbo-ai-json-input');
        assert.ok(jsonInput);
        jsonInput.value = JSON.stringify([
            { realName: '成人向_角色H内嵌', group: '剧情' },
            { realName: '旧内嵌F', group: '未分组' },
            { realName: '主书F', group: '未分组' },
            { realName: '同名角色甲', group: '未分组' },
        ]);
        dom.doc.getElementById('wbo-ai-parse-paste-btn').click();

        const applyBtn = dom.doc.getElementById('wbo-ai-apply-btn');
        assert.ok(applyBtn);
        applyBtn.click();
        await new Promise((r) => prevSetTimeout(r, 20));

        // Target 3B-ADV: embedded book moved to custom group '剧情'
        assert.equal(settings.assignments['成人向_角色H内嵌'], 'g1');
        assert.equal(settings.charBookOverrides['成人向_角色H内嵌'], 'exclude_from_char');
        assert.equal(state.classification.byName.get('成人向_角色H内嵌')?.groupId, 'g1');

        // Target 3B2-ADV: embedded & real char-bound books moved to '未分组'
        assert.equal(settings.assignments['旧内嵌F'], undefined);
        assert.equal(settings.charBookOverrides['旧内嵌F'], 'exclude_from_char');
        assert.equal(state.classification.byName.get('旧内嵌F')?.groupId, SPECIAL_GROUPS.UNGROUPED);

        assert.equal(settings.assignments['主书F'], undefined);
        assert.equal(settings.charBookOverrides['主书F'], 'exclude_from_char');
        assert.equal(state.classification.byName.get('主书F')?.groupId, SPECIAL_GROUPS.UNGROUPED);

        // Unbound control: '同名角色甲' clears include_in_char to undefined
        assert.equal(settings.assignments['同名角色甲'], undefined);
        assert.equal(settings.charBookOverrides['同名角色甲'], undefined);
        assert.equal(state.classification.byName.get('同名角色甲')?.groupId, SPECIAL_GROUPS.UNGROUPED);

        const promptState = computeScanPromptState({
            worldNames,
            characters,
            bindingMap: state.bindingMap,
            settings,
        });
        assert.equal(promptState.sameNameNeedConfirmCount, 0);
        assert.equal(dom.doc.getElementById('wbo-mgr-scan-prompt').hidden, true);
    } finally {
        panelMod.teardownPanels();
        globalThis.confirm = prevConfirm;
        if (prevDetails === undefined) delete globalThis.HTMLDetailsElement;
        else globalThis.HTMLDetailsElement = prevDetails;
        dom.restore();
    }
});

test('M3 R4 regression: 1-click NSFW & moveBooksToNamedGroup preserve exclude_from_char on embedded sensitive books', async () => {
    const dom = installMockNativeFilterDom({ innerWidth: 1280, innerHeight: 800 });
    const prevConfirm = globalThis.confirm;
    const prevDetails = globalThis.HTMLDetailsElement;
    const prevSetTimeout = globalThis.setTimeout;
    const panelMod = await import('../src/panel.js');

    const settings = normalizeSettings({
        includeEmbeddedNameMatch: true,
        autoScanNewCharacters: true,
        groups: [],
        assignments: {},
        charBookOverrides: { '成人向_角色H内嵌': 'exclude_from_char' },
    });
    const characters = [
        {
            name: '角色H',
            avatar: 'charH.png',
            shallow: false,
            data: {
                name: '角色H',
                extensions: {},
                character_book: { name: '成人向_角色H内嵌', entries: [] },
            },
        },
    ];
    const worldNames = ['成人向_角色H内嵌'];

    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getWorldInfoNames: () => [...worldNames],
            world_names: [...worldNames],
        }),
    };

    const recomputeState = () => {
        const bindingMap = buildCharacterBindingIndex({
            characters,
            charLore: [],
            cachedCharBindings: settings.cachedCharBindings,
            worldNamesSet: new Set(worldNames),
            includeExtraCharBooks: true,
            includeEmbeddedNameMatch: settings.includeEmbeddedNameMatch !== false,
        });
        const classification = classifyWorldbooks({
            worldNames,
            bindingMap,
            personaMap: new Map(),
            settings,
        });
        return { settings, bindingMap, classification };
    };

    try {
        globalThis.confirm = () => true;
        globalThis.HTMLDetailsElement = globalThis.HTMLElement;
        let state = recomputeState();
        panelMod.bindPanelCallbacks({
            getState: () => state,
            onMutation: async (opts = {}) => {
                if (opts.uiOnly) return;
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
            onRescan: async () => {
                state = recomputeState();
                panelMod.renderEmbeddedPanel();
            },
        });

        panelMod.openManagerModal();
        dom.doc.querySelector('[data-action="open-ai-organize"]').click();

        dom.doc.querySelector('[data-ai-book-tab="sensitive"]').click();
        dom.doc.getElementById('wbo-pick-toggle-sens').click();
        const moveNsfwBtn = dom.doc.querySelector('[data-action-move-nsfw]');
        assert.ok(moveNsfwBtn);
        assert.equal(moveNsfwBtn.hidden, false);
        moveNsfwBtn.click();

        const confirmOkBtn = dom.doc.getElementById('wbo-sens-confirm-ok');
        assert.ok(confirmOkBtn);
        confirmOkBtn.click();
        await new Promise((r) => prevSetTimeout(r, 20));

        const nsfwGroup = settings.groups.find((g) => g.name === 'NSFW');
        assert.ok(nsfwGroup, 'NSFW group must be created');
        assert.equal(settings.assignments['成人向_角色H内嵌'], nsfwGroup.id);
        assert.equal(
            settings.charBookOverrides['成人向_角色H内嵌'],
            'exclude_from_char',
            '1-click NSFW UI move must preserve exclude_from_char on embedded sensitive book',
        );
        assert.equal(state.classification.byName.get('成人向_角色H内嵌')?.groupId, nsfwGroup.id);
        let promptState = computeScanPromptState({
            worldNames,
            characters,
            bindingMap: state.bindingMap,
            settings,
        });
        assert.equal(promptState.sameNameNeedConfirmCount, 0);

        // Target 3C-ADV: direct moveBooksToNamedGroup with isCharBoundFn transitioning include_in_char -> exclude_from_char
        delete settings.assignments['成人向_角色H内嵌'];
        settings.charBookOverrides['成人向_角色H内嵌'] = 'include_in_char';
        state = recomputeState();
        const moveRes = moveBooksToNamedGroup(settings, ['成人向_角色H内嵌'], 'NSFW', {
            targetGroupId: nsfwGroup.id,
            isCharBoundFn: (name) => Boolean(state.classification.byName.get(name)?.isCharBound),
        });
        assert.equal(moveRes.movedCount, 1);
        assert.equal(settings.assignments['成人向_角色H内嵌'], nsfwGroup.id);
        assert.equal(
            settings.charBookOverrides['成人向_角色H内嵌'],
            'exclude_from_char',
            'moveBooksToNamedGroup must set exclude_from_char for embedded sensitive book starting with include_in_char',
        );
        promptState = computeScanPromptState({
            worldNames,
            characters,
            bindingMap: state.bindingMap,
            settings,
        });
        assert.equal(promptState.sameNameNeedConfirmCount, 0);
    } finally {
        panelMod.teardownPanels();
        globalThis.confirm = prevConfirm;
        if (prevDetails === undefined) delete globalThis.HTMLDetailsElement;
        else globalThis.HTMLDetailsElement = prevDetails;
        dom.restore();
    }
});

test('M4 P1 regression F2.5: applyEditorWorldSelectFilter preserves empty placeholder when DocumentFragment move triggers single-select auto-promotion', async () => {
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

        const enableChromiumAutoSelectOnRemove = (opt) => {
            const baseRemove = opt.remove.bind(opt);
            opt.remove = () => {
                const parent = opt.parentNode;
                const wasSelected = Boolean(opt.selected);
                baseRemove();
                if (parent === editorSel && !editorSel.multiple && wasSelected) {
                    const remaining = editorSel.options;
                    if (remaining.length > 0) {
                        for (const o of remaining) o.selected = false;
                        remaining[0].selected = true;
                    }
                }
            };
        };

        for (const [val, txt] of [['', '--- 选择以编辑 ---'], ['0', '隐藏角色书'], ['1', '普通书A'], ['2', '普通书B']]) {
            const opt = dom.doc.createElement('option');
            opt.value = val;
            opt.textContent = txt;
            if (val === '') opt.selected = true;
            enableChromiumAutoSelectOnRemove(opt);
            editorSel.appendChild(opt);
        }

        worldPopup.appendChild(editorSel);
        wiDrawer.append(multiSel, worldPopup);
        dom.doc.body.appendChild(wiDrawer);

        const bindingMap = new Map([['隐藏角色书', [{ avatar: 'CharB.png', charName: 'CharB', source: 'primary' }]]]);
        const settings = normalizeSettings({
            groups: [{ id: 'g1', name: '文风', color: '#5b8def', collapsed: false }],
            assignments: { 普通书A: 'g1' },
            showCharBooks: false,
            hideCharBooksByDefault: true,
            pinCurrentChatCharBookInEditor: false,
            showNativeOptgroups: true,
        });
        const cls = classifyWorldbooks({
            worldNames: ['隐藏角色书', '普通书A', '普通书B'],
            bindingMap,
            settings,
        });

        assert.equal(editorSel.value, '');
        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });

        assert.equal(editorSel.value, '', 'empty placeholder selection must survive DocumentFragment move');
        assert.equal(editorSel.selectedOptions[0]?.value, '', 'placeholder <option value=""> must remain selected');
        const trigger = dom.doc.getElementById('wbo-mobile-editor-trigger');
        assert.ok(trigger, 'mobile editor trigger should mount when >= 2 sections exist');
        assert.equal(trigger.textContent.trim(), '--- 选择以编辑 ---');
        assert.equal(trigger.classList.contains('is-placeholder'), true);

        // Simulate WORLDINFO_ENTRIES_LOADED for hidden char book while #world_editor_select still has value === ''
        nativeMod.setCurrentlyEditingWorld('隐藏角色书');
        nativeMod.applyAllNativeWorldFilters(cls, settings, { force: true });

        assert.equal(editorSel.value, '', 'selectEl.value must stay empty when _currentlyEditingWorld is tracked externally');
        assert.equal(trigger.textContent.trim(), '--- 选择以编辑 ---');

        trigger.dispatchEvent(new dom.MockEvent('click', { bubbles: true, cancelable: true }));
        const mpOverlay = dom.doc.getElementById('wbo-mobile-picker-overlay');
        assert.ok(mpOverlay, 'mobile picker overlay should open');
        const heads = mpOverlay.querySelectorAll('.wbo-mp-sec-head').map((h) => h.textContent.trim());
        assert.equal(heads.some((h) => h.includes('角色世界书')), false, 'hidden edited char book must NOT be wrapped under 角色世界书');
        const editedRow = mpOverlay.querySelectorAll('.wbo-mp-row').find((r) => r.textContent.includes('隐藏角色书'));
        assert.ok(editedRow, '隐藏角色书 must render bare in mobile picker');
        assert.ok(editedRow.textContent.includes('当前编辑'), '隐藏角色书 bare row must display 当前编辑 badge');
    } finally {
        nativeMod.teardownNativeFilters();
        dom.restore();
    }
});
