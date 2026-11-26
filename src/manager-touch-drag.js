/** Scoped touch gestures for the manager's dedicated drag handles. */
export function bindManagerTouchDrag(modal, { start, over, drop, cancel }) {
    const doc = modal.ownerDocument || globalThis.document;
    let gesture = null;
    let frame = 0;
    const makeEvent = (target, event) => ({ target, clientX: event.clientX, clientY: event.clientY,
        preventDefault() {}, dataTransfer: null });
    const updateTarget = (event) => {
        const hit = doc.elementFromPoint(event.clientX, event.clientY);
        return hit && modal.contains(hit) ? hit : modal;
    };
    const scrollAtEdge = () => {
        frame = 0;
        if (!gesture?.active) return;
        if (modal.isConnected === false || doc?.hidden || modal.getClientRects?.().length === 0) {
            finish();
            return;
        }
        const { clientX, clientY } = gesture;
        const scroller = modal.matches?.('.wbo-touch-window.is-resized')
            ? modal.querySelector('.wbo-mgr-window-scroll') : modal.querySelector('#wbo-mgr-groups-list');
        const scrollEdge = (el, horizontal = false) => {
            if (!el) return false;
            const bounds = el.getBoundingClientRect();
            const point = horizontal ? clientX : clientY;
            if (horizontal && (clientY < bounds.top || clientY > bounds.bottom)) return false;
            if (!horizontal && (clientX < bounds.left || clientX > bounds.right)) return false;
            const near = horizontal ? bounds.left : bounds.top;
            const far = horizontal ? bounds.right : bounds.bottom;
            const delta = point < near + 30 ? -9 : point > far - 30 ? 9 : 0;
            const key = horizontal ? 'scrollLeft' : 'scrollTop';
            const before = el[key];
            el[key] += delta;
            return el[key] !== before;
        };
        const moved = scrollEdge(scroller);
        const pillsMoved = scrollEdge(modal.querySelector('#wbo-mgr-pills'), true);
        if (moved || pillsMoved) over(makeEvent(updateTarget(gesture), gesture));
        if (gesture?.active) frame = requestAnimationFrame(scrollAtEdge);
    };
    const finish = (event) => {
        if (!gesture || (event && event.pointerId !== gesture.pointerId)) return;
        const current = gesture;
        gesture = null;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        if (event?.type === 'pointerup' && current.active) {
            const mapped = makeEvent(updateTarget(event), event);
            over(mapped);
            void drop(mapped);
        } else cancel();
        if (modal.hasPointerCapture?.(current.pointerId)) modal.releasePointerCapture(current.pointerId);
    };
    const down = (event) => {
        if (gesture || event.isPrimary === false || event.button !== 0
            || !(event.pointerType === 'touch' || event.pointerType === 'pen')) return;
        const handle = event.target.closest?.('.wbo-drag-handle, .wbo-group-drag-handle');
        if (!handle || !modal.contains(handle)) return;
        event.preventDefault();
        gesture = { source: handle, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
            clientX: event.clientX, clientY: event.clientY, active: false };
        modal.setPointerCapture?.(event.pointerId);
    };
    const move = (event) => {
        if (gesture?.pointerId !== event.pointerId) return;
        event.preventDefault();
        gesture.clientX = event.clientX;
        gesture.clientY = event.clientY;
        if (!gesture.active) {
            if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 6) return;
            gesture.active = true;
            start(makeEvent(gesture.source, event));
            if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(scrollAtEdge);
        }
        over(makeEvent(updateTarget(event), event));
    };
    const blockHandleMenu = (event) => {
        if (event.target.closest?.('.wbo-drag-handle, .wbo-group-drag-handle')) event.preventDefault();
    };
    const onVisibility = () => {
        if (doc?.hidden) finish();
    };
    const listeners = [['pointerdown', down], ['pointermove', move], ['pointerup', finish],
        ['pointercancel', finish], ['lostpointercapture', finish], ['contextmenu', blockHandleMenu],
        ['selectstart', blockHandleMenu]];
    for (const [type, handler] of listeners) modal.addEventListener(type, handler);
    doc?.addEventListener?.('visibilitychange', onVisibility);
    return () => {
        finish();
        for (const [type, handler] of listeners) modal.removeEventListener(type, handler);
        doc?.removeEventListener?.('visibilitychange', onVisibility);
    };
}
