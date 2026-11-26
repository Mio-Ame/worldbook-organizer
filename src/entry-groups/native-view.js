import { GROUP_MODES, SPECIAL_GROUP_UNGROUPED } from './core.js';
import { detectHostColorScheme, getCurrentEditorWorldName, getNativeGroupingState, locateEntryInNativeEditor, showToast } from './host.js';
import { findScrollableContent, restoreContentAnchor } from '../content-scroll.js';

const BUTTON_ID = 'weg-native-group-manager';
const HEADING_CLASS = 'weg-native-group-heading';
const CONTINUATION_CLASS = 'weg-native-group-continuation';
const COLLAPSED_CLASS = 'weg-native-group-collapsed';
let visibleBook = null;
let decoratedList = null;
let nativeLayout = null;
let nativeActions = null;
let stickyBar = null;
let stickyFrame = 0;
let nativeThemeObserver = null;
let groupMarkers = [];
const groupHeadings = new Map();
const collapsedGroups = new Set();

const nativeColumnControls = new Map([
    ['Title/Memo', 'textarea[name="comment"]'],
    ['Strategy', '[name="entryStateSelector"]'],
    ['Position', 'select[name="position"]'],
    ['Depth', 'input[name="depth"]'],
    ['Order', 'input[name="order"]'],
    ['Trigger %', 'input[name="probability"]'],
]);

function syncNativeLayout(list, pagination, button) {
    const heading = list?.querySelector('#WIEntryHeaderTitlesPC');
    const row = list?.querySelector('.world_entry:not(.weg-native-group-collapsed) .inline-drawer-header');
    const sizeControl = pagination?.querySelector('select');
    if (nativeLayout?.heading === heading && nativeLayout?.row === row && nativeLayout?.sizeControl === sizeControl && nativeLayout?.button === button) {
        nativeLayout.update();
        return;
    }
    clearNativeLayout();
    if ((!heading || !row) && (!sizeControl || !button)) return;
    const columns = [...(heading?.children || [])].map((label) => [label, row?.querySelector(nativeColumnControls.get(label.getAttribute('data-i18n')) || ':not(*)')]);
    const update = () => {
        if (heading?.clientWidth && row?.offsetWidth && columns.length && columns.every(([, control]) => control)) {
            const headerLeft = heading.getBoundingClientRect().left;
            const scale = heading.getBoundingClientRect().width / heading.offsetWidth || 1;
            const geometry = columns.map(([label, control]) => {
                const visible = control.offsetWidth ? control : control.nextElementSibling;
                return [label, visible?.getBoundingClientRect()];
            });
            if (geometry.some(([, rect]) => !rect?.width)) return;
            for (const [label, { left, width }] of geometry) {
                label.style.setProperty('--weg-native-column-center', `${(left + width / 2 - headerLeft) / scale - heading.clientLeft}px`);
                label.style.setProperty('--weg-native-column-width', `${width / scale}px`);
            }
            heading.classList.add('weg-native-aligned-columns');
        }
        if (button && sizeControl?.offsetHeight) {
            button.style.setProperty('--weg-native-page-height', `${sizeControl.getBoundingClientRect().height}px`);
            button.style.setProperty('--weg-native-page-font', getComputedStyle(sizeControl).fontSize);
        }
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    if (list) observer?.observe(list);
    if (row) observer?.observe(row);
    for (const [, control] of columns) if (control) observer?.observe(control);
    if (sizeControl) observer?.observe(sizeControl);
    const styleObserver = typeof MutationObserver === 'function' && list ? new MutationObserver(update) : null;
    styleObserver?.observe(list, { attributes: true, attributeFilter: ['style'] });
    nativeLayout = { heading, row, sizeControl, button, observer, styleObserver, update };
    update();
}

function clearNativeLayout() {
    nativeLayout?.observer?.disconnect();
    nativeLayout?.styleObserver?.disconnect();
    nativeLayout?.heading?.classList.remove('weg-native-aligned-columns');
    nativeLayout?.button?.style.removeProperty('--weg-native-page-height');
    nativeLayout?.button?.style.removeProperty('--weg-native-page-font');
    nativeLayout = null;
}

function syncNativePinnedEntries(list, worldName, config) {
    let panel = document.getElementById('weg-native-pinned-entries');
    const pinned = config?.pinnedEntryUids || [];
    if (!list || !pinned.length) {
        panel?.remove();
        return;
    }
    if (!panel) {
        panel = document.createElement('details');
        panel.id = 'weg-native-pinned-entries';
        panel.append(document.createElement('summary'), document.createElement('div'));
    }
    if (list.previousElementSibling !== panel) list.before(panel);
    const titles = new Map();
    for (const row of list.querySelectorAll('.world_entry[uid]')) {
        const uid = row.getAttribute('uid');
        const title = row.querySelector('textarea[name="comment"], .we-title');
        titles.set(uid, (title?.value || title?.textContent || '').trim());
    }
    const signature = JSON.stringify([worldName, ...pinned.map((uid) => [uid, titles.get(uid)])]);
    if (panel.dataset.signature === signature) return;
    panel.dataset.signature = signature;
    panel.firstElementChild.textContent = `★ 已置顶条目（${pinned.length}）`;
    const links = pinned.map((uid) => {
        const title = titles.get(uid) || '';
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'menu_button';
        link.textContent = title || `条目 #${uid}`;
        link.addEventListener('click', (event) => {
            event.stopPropagation();
            revealNativeEntryGroup(worldName, uid);
            void locateEntryInNativeEditor(worldName, uid, title);
        });
        return link;
    });
    panel.lastElementChild.replaceChildren(...links);
}

function makeGroupControls(parent, resolveGroup) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'weg-native-group-disclosure';
    const icon = document.createElement('i');
    icon.className = 'weg-native-group-chevron';
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon, document.createElement('span'));
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        const groupId = resolveGroup();
        const heading = groupHeadings.get(groupId);
        if (!heading || !visibleBook) return;
        const disclosure = heading.firstElementChild;
        if (disclosure.disabled) return;
        const scroller = findScrollableContent(heading, document.getElementById('WorldInfo')?.parentElement);
        const top = scroller?.getBoundingClientRect().top || 0;
        const offset = Math.max(0, heading.getBoundingClientRect().top - top);
        const collapsed = !collapsedGroups.delete(groupId);
        if (collapsed) collapsedGroups.add(groupId);
        refreshNativeRows();
        if (restoreContentAnchor(scroller, heading, offset) > 8 && collapsed) {
            showToast('info', `已折叠「${disclosure.textContent}」`);
        }
        scheduleStickyUpdate();
    });
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'weg-native-group-switch';
    toggle.setAttribute('role', 'checkbox');
    const toggleIcon = document.createElement('i');
    toggleIcon.setAttribute('aria-hidden', 'true');
    toggle.append(toggleIcon);
    toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const groupId = resolveGroup();
        if (visibleBook && groupId) void nativeActions?.toggleGroup(visibleBook, groupId);
    });
    parent.append(button, toggle);
}

function setAttributeIfChanged(element, name, value) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function updateGroupControls(parent, name, collapsed, canFold, total, enabled, radio, partial) {
    const [disclosure, toggle] = parent.children;
    if (disclosure.lastElementChild.textContent !== name) disclosure.lastElementChild.textContent = name;
    if (disclosure.disabled === canFold) disclosure.disabled = !canFold;
    if (canFold) setAttributeIfChanged(disclosure, 'aria-expanded', String(!collapsed));
    else disclosure.removeAttribute('aria-expanded');
    const on = total > 0 && (radio ? enabled > 0 : enabled === total);
    const state = partial ? 'mixed' : on ? 'true' : enabled > 0 ? 'mixed' : 'false';
    setAttributeIfChanged(toggle, 'aria-checked', state);
    const action = partial ? '切换' : on ? '关闭' : '开启';
    const label = `${action}「${name}」整组条目`;
    setAttributeIfChanged(toggle, 'aria-label', label);
    setAttributeIfChanged(toggle, 'title', label);
    const icon = `fa-solid ${state === 'mixed' ? 'fa-circle-half-stroke' : on ? 'fa-toggle-on' : 'fa-toggle-off'}`;
    if (toggle.firstElementChild.className !== icon) toggle.firstElementChild.className = icon;
    const disabled = total === 0 || Boolean(nativeActions?.busy);
    if (toggle.disabled !== disabled) toggle.disabled = disabled;
}

function handleNativeScroll(event) {
    if (event.target === document || event.target.contains?.(decoratedList)) scheduleStickyUpdate();
}

function scheduleStickyUpdate() {
    if (stickyBar && !stickyFrame) stickyFrame = requestAnimationFrame(updateStickyGroup);
}

function updateStickyGroup() {
    stickyFrame = 0;
    if (!stickyBar?.isConnected) return;
    const controls = stickyBar.querySelector('.weg-native-sticky-group');
    const top = stickyBar.getBoundingClientRect().top;
    let low = 0;
    let high = groupMarkers.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (groupMarkers[middle].getBoundingClientRect().top < top - 1) low = middle + 1;
        else high = middle;
    }
    const id = groupMarkers[low - 1]?.dataset.groupId;
    const heading = groupHeadings.get(id);
    const show = Boolean(heading && !collapsedGroups.has(id));
    controls.hidden = !show;
    if (!show) return;
    if (controls.dataset.groupId !== id) controls.dataset.groupId = id;
    const [sourceDisclosure, sourceToggle] = heading.children;
    const [disclosure, toggle] = controls.children;
    const name = sourceDisclosure.lastElementChild.textContent;
    if (disclosure.lastElementChild.textContent !== name) disclosure.lastElementChild.textContent = name;
    disclosure.disabled = sourceDisclosure.disabled;
    if (sourceDisclosure.disabled) disclosure.removeAttribute('aria-expanded');
    else setAttributeIfChanged(disclosure, 'aria-expanded', 'true');
    toggle.disabled = sourceToggle.disabled;
    for (const name of ['aria-checked', 'aria-label', 'title']) {
        setAttributeIfChanged(toggle, name, sourceToggle.getAttribute(name));
    }
    if (toggle.firstElementChild.className !== sourceToggle.firstElementChild.className) {
        toggle.firstElementChild.className = sourceToggle.firstElementChild.className;
    }
}

function syncStickyBar(list) {
    if (!stickyBar) {
        stickyBar = document.createElement('div');
        stickyBar.className = 'weg-native-list-sticky';
        const bar = document.createElement('div');
        const controls = document.createElement('div');
        controls.className = 'weg-native-sticky-group';
        controls.hidden = true;
        makeGroupControls(controls, () => controls.dataset.groupId);
        const undo = document.createElement('button');
        undo.id = 'weg-native-undo';
        undo.type = 'button';
        undo.className = 'menu_button';
        undo.addEventListener('click', (event) => {
            event.stopPropagation();
            if (visibleBook) void nativeActions?.undo(visibleBook);
        });
        bar.append(controls, undo);
        stickyBar.append(bar);
        document.addEventListener('scroll', handleNativeScroll, { capture: true, passive: true });
        window.addEventListener('resize', scheduleStickyUpdate, { passive: true });
    }
    const columns = list.querySelector(':scope > #WIEntryHeaderTitlesPC');
    if (columns && columns.nextElementSibling !== stickyBar) columns.after(stickyBar);
    else if (!columns && list.firstElementChild !== stickyBar) list.prepend(stickyBar);
    const undo = stickyBar.firstElementChild.lastElementChild;
    const label = nativeActions?.undoLabel(visibleBook) || '';
    undo.hidden = !label;
    undo.disabled = Boolean(nativeActions?.busy);
    if (undo.textContent !== label) undo.textContent = label;
    stickyBar.classList.toggle('has-undo', Boolean(label));
    scheduleStickyUpdate();
}

function refreshNativeRows() {
    if (decoratedList && visibleBook) syncGroupRows(decoratedList, getNativeGroupingState(visibleBook));
}

function handleNativeEntryToggle(event) {
    if (event.target.closest?.('.killSwitch, [name="entryKillSwitch"]')) refreshNativeRows();
}

export function syncNativeEntryGroupsTheme(settings = null) {
    if (!decoratedList || !nativeActions) return;
    const themeSettings = settings || getNativeGroupingState(visibleBook).themeSettings;
    const { palette, mode } = themeSettings?.followNativeTheme === false
        ? nativeActions.getTheme(themeSettings)
        : { palette: 'host', mode: detectHostColorScheme() };
    decoratedList.classList.add('weg-native-themed');
    decoratedList.classList.toggle('weg-theme-light', mode === 'light');
    decoratedList.classList.toggle('weg-theme-dark', mode !== 'light');
    setAttributeIfChanged(decoratedList, 'data-weg-palette', palette);
    nativeLayout?.update();
}

function syncGroupRows(list, { config, disabledByUid, banners, themeSettings }) {
    const rows = list?.querySelectorAll('.world_entry[uid]');
    if (!visibleBook || !rows?.length) {
        clearNativeGroupRows();
        return;
    }
    if (decoratedList !== list) {
        clearNativeGroupRows();
        decoratedList = list;
        list.addEventListener('click', handleNativeEntryToggle);
        if (typeof MutationObserver === 'function') {
            nativeThemeObserver = new MutationObserver(() => syncNativeEntryGroupsTheme());
            nativeThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
        }
    }
    syncNativeEntryGroupsTheme(themeSettings || {});
    const groups = new Map((config?.groups || []).map((group) => [group.id, group]));
    const getGroupId = (uid) => {
        const assigned = config?.assignments?.[uid];
        return groups.has(assigned) ? assigned : SPECIAL_GROUP_UNGROUPED;
    };
    const knownStates = new Map(disabledByUid);
    for (const row of rows) {
        const uid = row.getAttribute('uid');
        const disabled = row.classList.contains('disabledWIEntry');
        if (disabled || !knownStates.has(uid) || row.querySelector('.killSwitch, [name="entryKillSwitch"]')) {
            knownStates.set(uid, disabled);
        }
    }
    const partial = !disabledByUid && Boolean(document.getElementById('world_info_search')?.value
        || document.getElementById('world_info_pagination')?.querySelector('.paginationjs-next:not(.disabled), .paginationjs-prev:not(.disabled)'));
    const groupCounts = new Map();
    for (const [uid, disabled] of knownStates) {
        if (banners?.has(uid)) continue;
        const groupId = getGroupId(uid);
        const counts = groupCounts.get(groupId) || { total: 0, enabled: 0 };
        counts.total++;
        if (!disabled) counts.enabled++;
        groupCounts.set(groupId, counts);
    }
    groupMarkers = [];
    groupHeadings.clear();
    const seen = new Set();
    let previousId = null;
    let previousParent = null;
    for (const row of rows) {
        const groupId = getGroupId(row.getAttribute('uid'));
        const collapsed = collapsedGroups.has(groupId);
        const startsGroupRun = groupId !== previousId || row.parentElement !== previousParent;
        const firstRun = !seen.has(groupId);
        const showContinuation = startsGroupRun && !firstRun && !collapsed;
        seen.add(groupId);
        row.classList.toggle('weg-native-group-start', firstRun || showContinuation);
        row.classList.toggle(COLLAPSED_CLASS, collapsed);
        previousId = groupId;
        previousParent = row.parentElement;

        let heading = row.querySelector(`:scope > .${HEADING_CLASS}`);
        let continuation = row.querySelector(`:scope > .${CONTINUATION_CLASS}`);
        const group = groups.get(groupId);
        const name = group?.name || '未分组';
        if (!firstRun) {
            heading?.remove();
            if (showContinuation) {
                if (!continuation) {
                    continuation = document.createElement('span');
                    continuation.className = CONTINUATION_CLASS;
                    row.prepend(continuation);
                }
                if (continuation.dataset.groupId !== groupId) continuation.dataset.groupId = groupId;
                const label = `${name}（续）`;
                if (continuation.textContent !== label) continuation.textContent = label;
                groupMarkers.push(continuation);
            } else {
                continuation?.remove();
            }
            continue;
        }
        continuation?.remove();
        if (!heading) {
            heading = document.createElement('div');
            heading.className = HEADING_CLASS;
            makeGroupControls(heading, () => heading.dataset.groupId);
            row.prepend(heading);
        }
        if (heading.dataset.groupId !== groupId) heading.dataset.groupId = groupId;
        const { total, enabled } = groupCounts.get(groupId) || { total: 0, enabled: 0 };
        updateGroupControls(heading, name, collapsed, groups.size > 0, total, enabled, group?.mode === GROUP_MODES.RADIO, partial);
        groupHeadings.set(groupId, heading);
        groupMarkers.push(heading);
    }
    syncStickyBar(list);
}

export function syncNativeEntryGroups(actions) {
    if (typeof document === 'undefined') return;
    nativeActions = actions;
    const pagination = document.getElementById('world_info_pagination');
    const list = document.getElementById('world_popup_entries_list');
    const worldName = getCurrentEditorWorldName();
    const state = getNativeGroupingState(worldName);
    if (visibleBook !== worldName) {
        clearNativeGroupRows();
        visibleBook = worldName;
        collapsedGroups.clear();
    }

    let button = document.getElementById(BUTTON_ID);
    const anchor = pagination || list;
    if (anchor && worldName && state.showButton) {
        if (!button) {
            button = document.createElement('button');
            button.id = BUTTON_ID;
            button.type = 'button';
            button.className = 'menu_button';
            button.textContent = '条目分组';
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                void nativeActions?.openPanel({ worldName: getCurrentEditorWorldName() });
            });
        }
        if (pagination && pagination.nextElementSibling !== button) pagination.after(button);
        if (!pagination) {
            const pinned = document.getElementById('weg-native-pinned-entries');
            const before = pinned && pinned.nextElementSibling === list ? pinned : list;
            if (before.previousElementSibling !== button) before.before(button);
        }
    } else {
        button?.remove();
    }

    syncGroupRows(list, state);
    syncNativeLayout(list, pagination, button);
    syncNativePinnedEntries(list, worldName, state.config);
}

export function revealNativeEntryGroup(worldName, uid) {
    if (visibleBook !== worldName) return;
    const { config } = getNativeGroupingState(worldName);
    const groupId = config?.assignments?.[uid] || SPECIAL_GROUP_UNGROUPED;
    if (collapsedGroups.delete(groupId)) refreshNativeRows();
}

function clearNativeGroupRows() {
    if (!decoratedList) return;
    nativeThemeObserver?.disconnect();
    nativeThemeObserver = null;
    decoratedList.classList.remove('weg-native-themed', 'weg-theme-light', 'weg-theme-dark');
    decoratedList.removeAttribute('data-weg-palette');
    decoratedList.removeEventListener('click', handleNativeEntryToggle);
    document.removeEventListener('scroll', handleNativeScroll, true);
    window.removeEventListener('resize', scheduleStickyUpdate);
    if (stickyFrame) cancelAnimationFrame(stickyFrame);
    stickyFrame = 0;
    stickyBar?.remove();
    stickyBar = null;
    groupMarkers = [];
    groupHeadings.clear();
    decoratedList.querySelectorAll(`.${HEADING_CLASS}, .${CONTINUATION_CLASS}`).forEach((heading) => heading.remove());
    decoratedList.querySelectorAll(`.${COLLAPSED_CLASS}, .weg-native-group-start`).forEach((row) => {
        row.classList.remove(COLLAPSED_CLASS, 'weg-native-group-start');
    });
    decoratedList = null;
}

export function removeNativeEntryGroups() {
    if (typeof document === 'undefined') return;
    document.getElementById(BUTTON_ID)?.remove();
    document.getElementById('weg-native-pinned-entries')?.remove();
    clearNativeLayout();
    clearNativeGroupRows();
    visibleBook = null;
    nativeActions = null;
    collapsedGroups.clear();
}
