import { SPECIAL_GROUP_UNGROUPED } from './core.js';
import { getCurrentEditorWorldName, getNativeGroupingState } from './host.js';

const BUTTON_ID = 'weg-native-group-manager';
const HEADING_CLASS = 'weg-native-group-heading';
const COLLAPSED_CLASS = 'weg-native-group-collapsed';
let visibleBook = null;
let decoratedList = null;
const collapsedGroups = new Set();

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
        if (!pagination && list.previousElementSibling !== button) list.before(button);
    } else {
        button?.remove();
    }

    syncGroupRows(list, config);
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
    clearNativeGroupRows();
    visibleBook = null;
    collapsedGroups.clear();
}
