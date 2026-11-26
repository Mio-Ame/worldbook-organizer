import { SPECIAL_GROUP_UNGROUPED } from './core.js';
import { getCurrentEditorWorldName, getNativeGroupingState, locateEntryInNativeEditor } from './host.js';

const BUTTON_ID = 'weg-native-group-manager';
const HEADING_CLASS = 'weg-native-group-heading';
const COLLAPSED_CLASS = 'weg-native-group-collapsed';
let visibleBook = null;
let decoratedList = null;
let nativeLayout = null;
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
        return;
    }
    clearNativeLayout();
    if ((!heading || !row) && (!sizeControl || !button)) return;
    const columns = [...(heading?.children || [])].map((label) => [label, row?.querySelector(nativeColumnControls.get(label.getAttribute('data-i18n')) || ':not(*)')]);
    const update = () => {
        if (heading?.clientWidth && row?.offsetWidth && columns.length && columns.every(([, control]) => control)) {
            const headerLeft = heading.getBoundingClientRect().left;
            const geometry = columns.map(([label, control]) => [label, control.getBoundingClientRect()]);
            for (const [label, { left, width }] of geometry) {
                label.style.setProperty('--weg-native-column-center', `${left + width / 2 - headerLeft}px`);
                label.style.setProperty('--weg-native-column-width', `${width}px`);
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
    if (sizeControl) observer?.observe(sizeControl);
    nativeLayout = { heading, row, sizeControl, button, observer };
    update();
}

function clearNativeLayout() {
    nativeLayout?.observer?.disconnect();
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

function makeGroupHeading() {
    const heading = document.createElement('div');
    heading.className = HEADING_CLASS;
    const button = document.createElement('button');
    button.type = 'button';
    heading.append(button);
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        const groupId = heading.dataset.groupId;
        if (!groupId || !visibleBook) return;
        if (collapsedGroups.has(groupId)) collapsedGroups.delete(groupId);
        else collapsedGroups.add(groupId);
        syncGroupRows(decoratedList, getNativeGroupingState(visibleBook).config);
    });
    return heading;
}

function syncGroupRows(list, config) {
    if (!list || !Array.isArray(config?.groups) || !config.groups.length) {
        clearNativeGroupRows();
        return;
    }
    if (decoratedList !== list) {
        clearNativeGroupRows();
        decoratedList = list;
    }
    const names = new Map(config.groups.map((group) => [group.id, group.name]));
    let previousId = null;
    let previousParent = null;
    for (const row of list.querySelectorAll('.world_entry[uid]')) {
        const assigned = config?.assignments?.[row.getAttribute('uid')];
        const groupId = names.has(assigned) ? assigned : SPECIAL_GROUP_UNGROUPED;
        const collapsed = collapsedGroups.has(groupId);
        const startsGroupRun = groupId !== previousId || row.parentElement !== previousParent;
        row.classList.toggle('weg-native-group-start', startsGroupRun);
        row.classList.toggle(COLLAPSED_CLASS, collapsed);
        previousId = groupId;
        previousParent = row.parentElement;

        let heading = row.querySelector(`:scope > .${HEADING_CLASS}`);
        if (!startsGroupRun) {
            heading?.remove();
            continue;
        }
        if (!heading) {
            heading = makeGroupHeading();
            row.prepend(heading);
        }
        if (heading.dataset.groupId !== groupId) heading.dataset.groupId = groupId;
        const button = heading.firstElementChild;
        const name = names.get(groupId) || '未分组';
        if (button.textContent !== name) button.textContent = name;
        const expanded = String(!collapsed);
        if (button.getAttribute('aria-expanded') !== expanded) button.setAttribute('aria-expanded', expanded);
    }
}

export function syncNativeEntryGroups(openPanel) {
    if (typeof document === 'undefined') return;
    const pagination = document.getElementById('world_info_pagination');
    const list = document.getElementById('world_popup_entries_list');
    const worldName = getCurrentEditorWorldName();
    const { config, showButton } = getNativeGroupingState(worldName);
    if (visibleBook !== worldName) {
        clearNativeGroupRows();
        visibleBook = worldName;
        collapsedGroups.clear();
    }

    let button = document.getElementById(BUTTON_ID);
    const anchor = pagination || list;
    if (anchor && worldName && showButton) {
        if (!button) {
            button = document.createElement('button');
            button.id = BUTTON_ID;
            button.type = 'button';
            button.className = 'menu_button';
            button.textContent = '条目分组';
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                void openPanel({ worldName: getCurrentEditorWorldName() });
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

    syncGroupRows(list, config);
    syncNativeLayout(list, pagination, button);
    syncNativePinnedEntries(list, worldName, config);
}

export function revealNativeEntryGroup(worldName, uid) {
    if (visibleBook !== worldName) return;
    const { config } = getNativeGroupingState(worldName);
    const groupId = config?.assignments?.[uid] || SPECIAL_GROUP_UNGROUPED;
    if (collapsedGroups.delete(groupId)) syncGroupRows(decoratedList, config);
}

function clearNativeGroupRows() {
    if (!decoratedList) return;
    decoratedList.querySelectorAll(`.${HEADING_CLASS}`).forEach((heading) => heading.remove());
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
    collapsedGroups.clear();
}
