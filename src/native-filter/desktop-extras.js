/**
 * desktop extras / character-bind / standard world-info popup enhancement.
 *
 * Move-only slice of src/native-filter.js (original lines 6141-6705). Not a single body was
 * rewritten: the declarations are byte-identical and the surrounding wiring is import/export
 * only. The hub re-imports whatever it still calls, so import sites outside did not change.
 */

import { SPECIAL_GROUPS, _latestClassification, _latestSettings, _observersActive, attachGroupedSelectControl, bindDrawerSafeBubbleGuard, bindSelect2PinHandlers, buildPopupGroupedSections, createDropdownFilterBar, customSelect2Matcher, ensureSelect2RowsHavePinBtn, escHtml, getCurrentCharacterAvatar, isNativeMobileSelectMode, patchExistingSelect2InPlace, renderSelect2OptionResult, restoreSelect2Options, unbindDrawerSafeBubbleGuard } from '../native-filter.js';

export const _extrasCleanups = new Map();

export const _extrasWaitTimers = new Set();


function enhanceDesktopExtrasSelect2(extrasSelect, currentAvatar) {
    const $ = globalThis.jQuery;
    if (!$ || !extrasSelect || !_observersActive) return;
    const $sel = $(extrasSelect);
    if (!$sel.data('select2')) return;
    _extrasCleanups.get(extrasSelect)?.();
    let active = true;
    let frame = null;
    let dropdownCleanup = null;
    const clearDropdown = () => {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        dropdownCleanup?.();
        dropdownCleanup = null;
    };
    const dispose = () => {
        active = false;
        clearDropdown();
        $sel.off('.wboExtras');
        restoreSelect2Options($sel);
        for (const group of extrasSelect.querySelectorAll('optgroup[data-wbo-group]')) group.replaceWith(...group.children);
        _extrasCleanups.delete(extrasSelect);
    };
    _extrasCleanups.set(extrasSelect, dispose);

    const rebuildExtrasOptgroups = () => {
        // First unwrap any existing optgroups without losing option.selected
        const existingGroups = Array.from(extrasSelect.querySelectorAll('optgroup'));
        if (existingGroups.length > 0) {
            const unwrapFrag = document.createDocumentFragment();
            for (const g of existingGroups) {
                while (g.firstChild) unwrapFrag.appendChild(g.firstChild);
                g.remove();
            }
            extrasSelect.appendChild(unwrapFrag);
        }

        const { bareBooks, sections } = buildPopupGroupedSections(extrasSelect, {
            currentAvatar,
            prioritizeCharGroup: false,
            pinSelectedSection: true,
        });
        const optMap = new Map();
        for (const opt of Array.from(extrasSelect.querySelectorAll('option'))) {
            if (opt.value !== '') optMap.set(opt.value, opt);
        }

        if (sections.length >= 2) {
            const frag = document.createDocumentFragment();
            for (const b of bareBooks) {
                const opt = optMap.get(b.value);
                if (opt) frag.appendChild(opt);
            }
            for (const sec of sections) {
                const grp = document.createElement('optgroup');
                grp.label = `${sec.name} (${sec.books.length})`;
                grp.setAttribute('data-wbo-group', sec.id);
                for (const b of sec.books) {
                    const opt = optMap.get(b.value);
                    if (opt) grp.appendChild(opt);
                }
                if (grp.childElementCount > 0) frag.appendChild(grp);
            }
            extrasSelect.appendChild(frag);
        } else if (bareBooks.length > 0) {
            const frag = document.createDocumentFragment();
            for (const b of bareBooks) {
                const opt = optMap.get(b.value);
                if (opt) frag.appendChild(opt);
            }
            for (const sec of sections) {
                for (const b of sec.books) {
                    const opt = optMap.get(b.value);
                    if (opt) frag.appendChild(opt);
                }
            }
            extrasSelect.appendChild(frag);
        }
    };

    rebuildExtrasOptgroups();

    patchExistingSelect2InPlace($sel, {
        matcher: customSelect2Matcher,
        templateResult: (state) => renderSelect2OptionResult(state, { showGroupPill: false }),
    });

    const localCollapsed = {};
    if (_latestSettings?.autoHideInCharBindPopup) {
        localCollapsed[SPECIAL_GROUPS.CHARACTER] = true;
    }
    let activePillId = SPECIAL_GROUPS.ALL;

    $sel.off('select2:opening.wboExtras select2:open.wboExtras')
        .on('select2:opening.wboExtras', () => {
            if (!active || !_observersActive) return;
            rebuildExtrasOptgroups();
        })
        .on('select2:close.wboExtras', clearDropdown)
        .on('select2:open.wboExtras', () => {
        clearDropdown();
        frame = requestAnimationFrame(() => {
            frame = null;
            if (!active || !_observersActive || !extrasSelect.isConnected) return;
            const inst = $sel.data('select2');
            const dropdownEl = inst?.$dropdown?.[0];
            if (!(dropdownEl instanceof HTMLElement)) return;
            const resultsList = dropdownEl.querySelector('.select2-results__options');
            if (!(resultsList instanceof HTMLElement)) return;
            const cleanups = [];
            const listen = (target, type, handler, options) => {
                target.addEventListener(type, handler, options);
                cleanups.push(() => target.removeEventListener(type, handler, options));
            };
            dropdownCleanup = () => {
                for (const cleanup of cleanups) cleanup();
                dropdownEl.querySelectorAll('.wbo-dd-filter-bar, .wbo-s2-pin-btn').forEach((node) => node.remove());
                for (const node of [resultsList, ...resultsList.querySelectorAll('[data-wbo-dd-group]')]) {
                    node.classList.remove('wbo-s2-li-flex', 'wbo-dd-group-head', 'is-isolated', 'wbo-dd-group-hidden', 'wbo-dd-collapsed');
                    delete node.dataset.wboDdGroup;
                }
                delete resultsList.dataset.wboExtrasPinBound;
                delete resultsList.dataset.wboExtrasListBound;
                delete resultsList._wboExtrasState;
                unbindDrawerSafeBubbleGuard(dropdownEl);
            };

            ensureSelect2RowsHavePinBtn(resultsList);
            if (resultsList.dataset.wboExtrasPinBound !== '1') {
                resultsList.dataset.wboExtrasPinBound = '1';
                bindDrawerSafeBubbleGuard(dropdownEl);
                cleanups.push(bindSelect2PinHandlers(resultsList));
                const pinObs = new MutationObserver(() => ensureSelect2RowsHavePinBtn(resultsList));
                pinObs.observe(resultsList, { childList: true });
                cleanups.push(() => pinObs.disconnect());
            }

            const labelToId = new Map();
            const pillSections = [];
            extrasSelect.querySelectorAll('optgroup[data-wbo-group]').forEach((og) => {
                const gid = og.getAttribute('data-wbo-group');
                const lbl = og.label || '';
                if (gid && lbl) {
                    labelToId.set(lbl, gid);
                    pillSections.push({ id: gid, label: lbl.replace(/\s*\((\d+)\)$/, ' $1') });
                }
            });
            if (pillSections.length < 2) return;

            dropdownEl.querySelector('.wbo-dd-filter-bar')?.remove();
            const built = createDropdownFilterBar(pillSections, activePillId);
            const barEl = built.barEl;

            const syncGroups = () => {
                const searchField = extrasSelect.parentElement?.querySelector('.select2-search__field');
                const searching = searchField instanceof HTMLInputElement && searchField.value.trim().length > 0;
                const isIsolated = !searching && activePillId !== SPECIAL_GROUPS.ALL;
                resultsList.querySelectorAll(':scope > li.select2-results__option--group').forEach((li) => {
                    const head = li.querySelector(':scope > .select2-results__group');
                    if (!(head instanceof HTMLElement)) return;
                    const gid = labelToId.get((head.textContent || '').trim());
                    if (!gid) return;
                    head.classList.add('wbo-dd-group-head');
                    head.classList.toggle('is-isolated', isIsolated);
                    head.setAttribute('data-wbo-dd-group', gid);
                    li.classList.toggle('wbo-dd-group-hidden', isIsolated && gid !== activePillId);
                    li.classList.toggle('wbo-dd-collapsed', !searching && !isIsolated && Boolean(localCollapsed[gid]));
                });
            };

            barEl.addEventListener('mousedown', (ev) => ev.stopPropagation());
            barEl.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const btn = ev.target instanceof Element ? ev.target.closest('.wbo-dd-pill') : null;
                if (!btn) return;
                ev.preventDefault();
                const gid = btn.getAttribute('data-wbo-pill') || SPECIAL_GROUPS.ALL;
                activePillId = (gid === activePillId && gid !== SPECIAL_GROUPS.ALL) ? SPECIAL_GROUPS.ALL : gid;
                barEl.querySelectorAll('.wbo-dd-pill').forEach((b) => {
                    b.classList.toggle('is-active', b.getAttribute('data-wbo-pill') === activePillId);
                });
                syncGroups();
                resultsList.scrollTop = 0;
            });

            resultsList._wboExtrasState = {
                getActivePillId: () => activePillId,
                localCollapsed,
                syncGroups,
            };
            if (resultsList.dataset.wboExtrasListBound !== '1') {
                resultsList.dataset.wboExtrasListBound = '1';
                bindDrawerSafeBubbleGuard(dropdownEl);
                listen(resultsList, 'mousedown', (ev) => {
                    const head = ev.target instanceof Element ? ev.target.closest('.wbo-dd-group-head') : null;
                    if (!head) return;
                    ev.preventDefault();
                    ev.stopPropagation();
                    const st = resultsList._wboExtrasState;
                    if (!st || st.getActivePillId() !== SPECIAL_GROUPS.ALL) return;
                    const gid = head.getAttribute('data-wbo-dd-group');
                    if (!gid) return;
                    st.localCollapsed[gid] = !st.localCollapsed[gid];
                    st.syncGroups();
                }, true);
                listen(resultsList, 'mouseup', (ev) => {
                    if (ev.target instanceof Element && ev.target.closest('.wbo-dd-group-head')) {
                        ev.preventDefault();
                        ev.stopPropagation();
                    }
                }, true);
                listen(resultsList, 'click', (ev) => {
                    if (ev.target instanceof Element && ev.target.closest('.wbo-dd-group-head')) {
                        ev.preventDefault();
                        ev.stopPropagation();
                    }
                }, true);
            }

            const resultsContainer = dropdownEl.querySelector('.select2-results');
            if (resultsContainer) {
                resultsContainer.parentElement?.insertBefore(barEl, resultsContainer);
            }
            const searchField = extrasSelect.parentElement?.querySelector('.select2-search__field');
            if (searchField instanceof HTMLInputElement && searchField.dataset.wboExtrasSearch !== '1') {
                searchField.dataset.wboExtrasSearch = '1';
                let searchFrame = null;
                listen(searchField, 'input', () => {
                    if (searchFrame !== null) cancelAnimationFrame(searchFrame);
                    searchFrame = requestAnimationFrame(() => {
                        searchFrame = null;
                        if (active && _observersActive) syncGroups();
                    });
                });
                cleanups.push(() => {
                    if (searchFrame !== null) cancelAnimationFrame(searchFrame);
                    delete searchField.dataset.wboExtrasSearch;
                });
            }
            syncGroups();
        });
    });
}

/**
 * Enhance a dynamically opened `.character_world` ("Link to World Info") popup:
 * - Zero intrusive top filter bars!
 * - Primary Worldbook gets an in-place grouped+searchable dropdown pinning `当前角色` first
 *   and keeping `角色世界书` easily accessible (collapsed by default if `autoHideInCharBindPopup`).
 * - Extra Worldbooks get grouped `<optgroup>` + in-dropdown pills on desktop Select2,
 *   and an in-place multi-select grouped+searchable dropdown on mobile!
 * @param {HTMLElement} charWorldEl
 */
/**
 * Group a desktop single-select worldbook `<select>` in place (no custom popover), so the host's
 * own Select2 keeps opening right under the select box.
 * @param {HTMLSelectElement} selectEl
 * @param {string | null} currentAvatar
 */

function groupDesktopSingleWorldSelect(selectEl, currentAvatar) {
    if (!(selectEl instanceof HTMLSelectElement) || selectEl.dataset.wboSingleGrouped === '1') return;
    const $jq = globalThis.jQuery;
    if (!$jq || !_latestClassification) return;
    const { bareBooks, sections } = buildPopupGroupedSections(selectEl, {
        currentAvatar,
        prioritizeCharGroup: true,
    });
    if (sections.length === 0 && bareBooks.length === 0) return;
    const optMap = new Map();
    for (const opt of Array.from(selectEl.querySelectorAll('option'))) {
        if (opt.value !== '') optMap.set(opt.value, opt);
    }
    const existingGroups = Array.from(selectEl.querySelectorAll('optgroup'));
    if (existingGroups.length > 0) {
        const unwrap = document.createDocumentFragment();
        for (const group of existingGroups) {
            while (group.firstChild) unwrap.appendChild(group.firstChild);
            group.remove();
        }
        selectEl.appendChild(unwrap);
    }
    const build = document.createDocumentFragment();
    for (const book of bareBooks) {
        const opt = optMap.get(book.value);
        if (opt) build.appendChild(opt);
    }
    for (const section of sections) {
        const group = document.createElement('optgroup');
        group.label = `${section.name} (${section.books.length})`;
        group.setAttribute('data-wbo-group', section.id);
        for (const book of section.books) {
            const opt = optMap.get(book.value);
            if (opt) group.appendChild(opt);
        }
        if (group.childElementCount > 0) build.appendChild(group);
    }
    selectEl.appendChild(build);
    selectEl.dataset.wboSingleGrouped = '1';
    $jq(selectEl).trigger('change.select2');
}

/**
 * Render one option of a single-select worldbook dropdown with the plugin's friendly title.
 * @param {any} state
 */

function renderSingleWorldResult(state) {
    if (!state.id) return state.text;
    const realName = String(state.element?.dataset?.wboRealName || state.text || '').trim();
    const meta = _latestClassification?.byName?.get(realName);
    if (!meta) return state.text;
    const $jq = globalThis.jQuery;
    if (!$jq) return state.text;
    return $jq(`<span class="wbo-s2-item" data-wbo-world="${escHtml(meta.realName)}">
        <span class="wbo-s2-main">
            <span class="wbo-s2-title">${escHtml(meta.primaryTitle)}</span>
            ${meta.subtitle ? `<span class="wbo-s2-sub">${escHtml(meta.subtitle)}</span>` : ''}
        </span>
    </span>`);
}

/**
 * @param {any} state
 */

function renderSingleWorldSelection(state) {
    if (!state.id) return state.text;
    const meta = _latestClassification?.byName?.get(String(state.element?.dataset?.wboRealName || state.text || '').trim());
    return meta?.primaryTitle || state.text;
}

/**
 * Give the bind-popup primary worldbook dropdown the same group pills as the ordinary picker:
 * the optgroups already carry `data-wbo-group`, so a pill simply shows one of them (U2).
 * @param {HTMLSelectElement} selectEl
 */

function attachBindWorldGroupPills(selectEl) {
    const $jq = globalThis.jQuery;
    if (!$jq || !(selectEl instanceof HTMLSelectElement)) return;
    if (selectEl.dataset.wboBindPills === '1') return;
    selectEl.dataset.wboBindPills = '1';

    let detachCurrent = null;
    const onOpen = () => {
        detachCurrent?.();
        detachCurrent = null;
        const inst = $jq(selectEl).data('select2');
        const dropdownEl = inst?.$dropdown?.[0];
        if (!(dropdownEl instanceof HTMLElement)) return;
        const results = dropdownEl.querySelector('.select2-results__options');
        if (!(results instanceof HTMLElement) || !results.parentElement) return;
        const groups = [...selectEl.querySelectorAll('optgroup[data-wbo-group]')].map((og) => ({
            id: og.getAttribute('data-wbo-group'),
            label: (og.label || '').replace(/\s*\(\d+\)\s*$/, '').trim() || og.label || '',
            rawLabel: og.label || '',
        }));
        if (groups.length === 0) return;

        let activeId = SPECIAL_GROUPS.ALL;
        const built = createDropdownFilterBar(
            // 全部 is rendered by the shared filter bar itself.
            groups.map((group) => ({ id: group.id, label: group.label })),
            activeId,
        );
        const barEl = built.barEl;
        barEl.classList.add('wbo-bind-dd-bar');
        const byLabel = new Map();
        for (const group of groups) {
            byLabel.set(group.rawLabel, group.id);
            byLabel.set(group.label, group.id);
        }
        const applyFilter = () => {
            results.querySelectorAll(':scope > li').forEach((li) => {
                if (!(li instanceof HTMLElement)) return;
                if (li.classList.contains('select2-results__option--group')) {
                    const label = li.getAttribute('aria-label')
                        || li.querySelector('.select2-results__group')?.textContent?.trim()
                        || '';
                    const gid = byLabel.get(label) || byLabel.get(label.replace(/\s*\(\d+\)\s*$/, '').trim());
                    li.style.display = activeId === SPECIAL_GROUPS.ALL || gid === activeId ? '' : 'none';
                    return;
                }
                if (li.classList.contains('select2-results__message')) return;
                // Bare (ungrouped) rows only belong to 全部.
                li.style.display = activeId === SPECIAL_GROUPS.ALL ? '' : 'none';
            });
        };
        barEl.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
        });
        barEl.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const btn = ev.target instanceof Element ? ev.target.closest('.wbo-dd-pill') : null;
            if (!btn) return;
            ev.preventDefault();
            activeId = btn.getAttribute('data-wbo-pill') || SPECIAL_GROUPS.ALL;
            barEl.querySelectorAll('.wbo-dd-pill').forEach((pill) => {
                pill.classList.toggle('is-active', pill.getAttribute('data-wbo-pill') === activeId);
            });
            applyFilter();
        });
        results.parentElement.insertBefore(barEl, results);
        const observer = new MutationObserver(applyFilter);
        observer.observe(results, { childList: true });
        applyFilter();
        detachCurrent = () => {
            observer.disconnect();
            barEl.remove();
            detachCurrent = null;
        };
    };
    $jq(selectEl)
        .off('select2:open.wboBindPills select2:close.wboBindPills')
        .on('select2:open.wboBindPills', onOpen)
        .on('select2:close.wboBindPills', () => {
            detachCurrent?.();
        });
}

/**
 * Give a desktop single worldbook select the same in-place experience as the extras select:
 * searchable, grouped optgroups, friendly titles, and a dropdown anchored under the select.
 * @param {HTMLSelectElement} selectEl
 * @param {string | null} currentAvatar
 * @param {HTMLElement | null} hostEl
 */

function enhanceDesktopSingleWorldSelect2(selectEl, currentAvatar, hostEl) {
    const $jq = globalThis.jQuery;
    if (!$jq || !(selectEl instanceof HTMLSelectElement)) return;
    if (selectEl.dataset.wboSingleEnhanced === '1') {
        groupDesktopSingleWorldSelect(selectEl, currentAvatar);
        attachBindWorldGroupPills(selectEl);
        return;
    }
    const config = {
        width: '100%',
        minimumResultsForSearch: 0,
        templateResult: renderSingleWorldResult,
        templateSelection: renderSingleWorldSelection,
    };
    if (hostEl instanceof HTMLElement) config.dropdownParent = $jq(hostEl);
    if ($jq(selectEl).data('select2')) {
        $jq(selectEl).select2(config);
    } else {
        $jq(selectEl).select2({ ...config, placeholder: '--- 无主世界书 ---', allowClear: true });
    }
    groupDesktopSingleWorldSelect(selectEl, currentAvatar);
    attachBindWorldGroupPills(selectEl);
    selectEl.dataset.wboSingleEnhanced = '1';
}


export function enhanceCharBindPopup(charWorldEl) {
    if (!charWorldEl || charWorldEl.dataset.wboEnhanced === '1') return;
    if (!_latestClassification || !_latestSettings) return;
    if (_latestSettings.adaptCharBindPopup === false) return;
    charWorldEl.dataset.wboEnhanced = '1';

    const primarySelect = charWorldEl.querySelector('.character_world_info_selector');
    const extrasSelect = charWorldEl.querySelector('.character_extra_world_info_selector');
    if (!primarySelect && !extrasSelect) return;

    const currentAvatar = getCurrentCharacterAvatar();
    const collapseChar = Boolean(_latestSettings.autoHideInCharBindPopup);

    // Primary worldbook: on desktop stay with the host's own Select2 (it opens right under the
    // select and never drifts); only rebuild its optgroups so the list is grouped. On mobile the
    // host has no Select2, so keep the plugin's grouped control.
    if (primarySelect instanceof HTMLSelectElement) {
        if (isNativeMobileSelectMode()) {
            attachGroupedSelectControl(primarySelect, {
                multiple: false,
                currentAvatar,
                collapseCharByDefault: false,
                prioritizeCharGroup: true,
                placeholder: '--- 无主世界书 ---',
            });
        } else {
            let primaryAttempts = 0;
            const waitPrimarySelect2 = () => {
                if (!_observersActive || !primarySelect.isConnected) return;
                const $jq = globalThis.jQuery;
                const hasS2 = Boolean($jq && ($jq(primarySelect).data('select2') || $jq(primarySelect).hasClass('select2-hidden-accessible')));
                if (hasS2) {
                    enhanceDesktopSingleWorldSelect2(primarySelect, currentAvatar, charWorldEl);
                    return;
                }
                if (primaryAttempts < 0) {
                    primaryAttempts += 1;
                    setTimeout(waitPrimarySelect2, 60);
                    return;
                }
                // The host never initialized Select2 here: do it ourselves so the list is
                // searchable, grouped and anchored under the select.
                enhanceDesktopSingleWorldSelect2(primarySelect, currentAvatar, charWorldEl);
            };
            waitPrimarySelect2();
        }
    }

    // Extra worldbooks:
    // - On desktop (`!isNativeMobileSelectMode()`), SillyTavern ALWAYS initializes Select2 inside `Popup.onOpen`
    //   (which may run slightly after the `<dialog>` is appended!). Wait cleanly for Select2 and patch it in place;
    //   NEVER attach a duplicate native trigger button below desktop Select2!
    // - On mobile (`isNativeMobileSelectMode()`), SillyTavern skips Select2 -> attach our clean single-line
    //   grouped+searchable multi-select control.
    if (extrasSelect instanceof HTMLSelectElement) {
        if (isNativeMobileSelectMode()) {
            attachGroupedSelectControl(extrasSelect, {
                multiple: true,
                currentAvatar,
                collapseCharByDefault: false,
                prioritizeCharGroup: false,
                placeholder: '未选择附加世界书，点击选择...',
            });
        } else {
            let attempts = 0;
            const later = (delay) => {
                const timer = setTimeout(() => { _extrasWaitTimers.delete(timer); waitDesktopSelect2(); }, delay);
                _extrasWaitTimers.add(timer);
            };
            const waitDesktopSelect2 = () => {
                if (!_observersActive || !extrasSelect.isConnected) return;
                const $ = globalThis.jQuery;
                const hasS2 = Boolean($ && ($(extrasSelect).data('select2') || $(extrasSelect).hasClass('select2-hidden-accessible')));
                if (hasS2) {
                    enhanceDesktopExtrasSelect2(extrasSelect, currentAvatar);
                    return;
                }
                if (attempts < 10) {
                    attempts += 1;
                    later(60);
                }
            };
            later(40);
        }
    }
}

/**
 * Enhance any standard SillyTavern single-select worldbook popup
 * (User Persona / Chat / Move-Copy Entry) with the same clean in-place grouped+searchable dropdown!
 * Zero external filter bars glued above the popup!
 *
 * @param {HTMLElement} hostContainer
 * @param {HTMLSelectElement} selectEl
 * @param {{ settingKey: string }} opts
 */

export function enhanceStandardWorldSelectPopup(hostContainer, selectEl, { settingKey }) {
    if (!hostContainer || !selectEl || selectEl.dataset.wboEnhanced === '1') return;
    if (!_latestClassification || !_latestSettings) return;
    if (settingKey && _latestSettings[settingKey] === false) return;
    selectEl.dataset.wboEnhanced = '1';

    attachGroupedSelectControl(selectEl, {
        multiple: false,
        currentAvatar: null,
        collapseCharByDefault: !Boolean(_latestSettings.showCharBooks),
        prioritizeCharGroup: false,
        placeholder: selectEl.querySelector('option[value=""]')?.textContent?.trim() || '--- 无 ---',
    });
}

/** @type {(() => void) | null} */
