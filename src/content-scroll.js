export function findScrollableContent(target, boundary) {
    for (let node = target?.parentElement; node && node !== boundary; node = node.parentElement) {
        if (node === document.body || node === document.documentElement) break;
        if (node.clientHeight > 0 && node.scrollHeight > node.clientHeight
            && /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)) return node;
    }
    return null;
}

export function scrollContentToItem(scroller, item, { align = 'nearest', margin = 6 } = {}) {
    if (!item || !scroller?.contains?.(item) || scroller.clientHeight <= 0) return;
    const listTop = scroller.getBoundingClientRect().top + scroller.clientTop;
    const row = item.getBoundingClientRect();
    if (row.height === 0) return;
    const viewTop = listTop + margin;
    const viewBottom = listTop + scroller.clientHeight - margin;
    const toStart = align === 'start' || row.top < viewTop || row.height > viewBottom - viewTop;
    const delta = toStart ? row.top - viewTop : Math.max(0, row.bottom - viewBottom);
    if (delta === 0) return;
    const top = Math.max(0, Math.min(scroller.scrollTop + delta, scroller.scrollHeight - scroller.clientHeight));
    if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top, behavior: 'instant' });
    else scroller.scrollTop = top;
}

export function restoreContentAnchor(scroller, item, offset) {
    if (!item || !scroller?.contains(item)) return 0;
    const currentOffset = item.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const currentScroll = scroller.scrollTop;
    scroller.scrollTop = Math.max(0, Math.min(currentScroll + currentOffset - offset, scroller.scrollHeight - scroller.clientHeight));
    return currentOffset - (scroller.scrollTop - currentScroll) - offset;
}

export function scrollNativeWorldEntry(entry) {
    const drawer = document.getElementById('WorldInfo');
    const list = document.getElementById('world_popup_entries_list');
    if (!list?.contains?.(entry)) return;
    const boundary = drawer?.contains?.(entry) ? drawer : list.parentElement;
    let scroller = findScrollableContent(entry, boundary);
    if (!scroller) {
        const viewport = globalThis.visualViewport;
        const viewportBottom = viewport ? viewport.offsetTop + viewport.height : globalThis.innerHeight;
        const top = list.getBoundingClientRect().top;
        const drawerBottom = drawer?.getBoundingClientRect().bottom;
        const bottom = drawerBottom > top ? Math.min(drawerBottom, viewportBottom) : viewportBottom;
        const available = Math.max(56, Math.floor(bottom - top - 8));
        if (list.scrollHeight <= available) return;
        list.style.setProperty('--wbo-native-entry-list-space', `${available}px`);
        list.style.setProperty('--wbo-native-entry-list-top', `${Math.max(0, top)}px`);
        list.classList.add('wbo-native-contained-scroll');
        scroller = list;
    }
    scrollContentToItem(scroller, entry, { align: 'start' });
}
