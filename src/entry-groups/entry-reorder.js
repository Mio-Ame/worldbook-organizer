import { reorderEntryUids } from '../core.js';
import { buildGroupedView, extractWorldbookEntrySummaries } from './core.js';

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
