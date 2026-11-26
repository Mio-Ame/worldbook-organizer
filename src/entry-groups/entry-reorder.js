import { reorderEntryUids } from '../core.js';
import { buildGroupedView, extractWorldbookEntrySummaries, SPECIAL_GROUP_UNGROUPED } from './core.js';

export function getNativeGroupOrder(config) {
    const available = new Set([...(config?.groups || []).map(({ id }) => id), SPECIAL_GROUP_UNGROUPED]);
    const ordered = [...new Set([...(config?.nativeGroupOrder || []), ...available])].filter((id) => available.has(id));
    const pinned = new Set(config?.pinnedGroupIds || []);
    return [...ordered.filter((id) => pinned.has(id)), ...ordered.filter((id) => !pinned.has(id))];
}

export function planNativeGroupMove(config, from, to, after) {
    const order = getNativeGroupOrder(config);
    const pinned = new Set(config?.pinnedGroupIds || []);
    if (pinned.has(from) !== pinned.has(to)) return [];
    const result = reorderEntryUids(order, from, to, after);
    return result.changed ? result.orderedUids : [];
}

export function planEntryGroupOrder(entries, config, draggedUid, targetUid, after) {
    const summaries = extractWorldbookEntrySummaries({ entries });
    const group = buildGroupedView(summaries, config, { sortPinned: false })
        .sections.find((section) => section.entries.some(({ uid }) => uid === draggedUid));
    const members = group?.entries.map(({ uid }) => uid) || [];
    const reordered = reorderEntryUids(members, draggedUid, targetUid, after);
    if (!reordered.changed) return [];
    const memberSet = new Set(members);
    let index = 0;
    return summaries.map(({ uid }) => memberSet.has(uid) ? reordered.orderedUids[index++] : uid);
}

export function planNativeEntryMove(entries, config, draggedUid, targetGroupId, targetUid, after) {
    if (targetGroupId !== SPECIAL_GROUP_UNGROUPED && !config.groups.some(({ id }) => id === targetGroupId)) return [];
    const summaries = extractWorldbookEntrySummaries({ entries });
    const uids = summaries.map(({ uid }) => uid);
    if (!uids.includes(draggedUid)) return [];
    const groupOf = (uid) => config.assignments[uid] || SPECIAL_GROUP_UNGROUPED;
    if (targetUid && (targetUid === draggedUid || !uids.includes(targetUid) || groupOf(targetUid) !== targetGroupId)) return [];
    const members = uids.filter((uid) => uid !== draggedUid && groupOf(uid) === targetGroupId);
    const anchor = targetUid || members.at(-1);
    if (!anchor) return groupOf(draggedUid) === targetGroupId ? [] : [...uids.filter((uid) => uid !== draggedUid), draggedUid];
    const result = reorderEntryUids(uids, draggedUid, anchor, targetUid ? after : true);
    return result.changed || groupOf(draggedUid) !== targetGroupId ? result.orderedUids : [];
}

export function bindEntryGroupReordering(list, { isAllowed, onMove }) {
    let drag = null;

    const clearTarget = () => {
        drag?.target?.classList.remove('weg-entry-drop-before', 'weg-entry-drop-after');
    };
    list.addEventListener('pointerdown', (event) => {
        const handle = event.target.closest?.('[data-weg-entry-drag]');
        if (!handle || !isAllowed() || event.button !== 0 || !event.isPrimary) return;
        const row = handle.closest('[data-weg-entry-row]');
        const group = row.closest('[data-weg-group-card]');
        event.preventDefault();
        drag = { row, group, pointerId: event.pointerId };
        row.classList.add('weg-entry-dragging');
        list.setPointerCapture(event.pointerId);
    });
    list.addEventListener('pointermove', (event) => {
        if (drag?.pointerId !== event.pointerId) return;
        const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-weg-entry-row]');
        clearTarget();
        drag.target = null;
        if (!row || row === drag.row || row.closest('[data-weg-group-card]') !== drag.group) return;
        const bounds = row.getBoundingClientRect();
        drag.after = event.clientY > bounds.top + bounds.height / 2;
        drag.target = row;
        row.classList.add(drag.after ? 'weg-entry-drop-after' : 'weg-entry-drop-before');
    });
    const finish = (event) => {
        if (drag?.pointerId !== event.pointerId) return;
        const { row, target, after } = drag;
        clearTarget();
        row.classList.remove('weg-entry-dragging');
        drag = null;
        if (event.type === 'pointerup' && target && isAllowed()) {
            void onMove(row.dataset.wegEntryRow, target.dataset.wegEntryRow, after);
        }
    };
    list.addEventListener('pointerup', finish);
    list.addEventListener('pointercancel', finish);
    list.addEventListener('lostpointercapture', finish);
}
