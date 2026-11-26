/** Shared window controls, overlays and panel utilities. */

import {
    applyTauriSurface,
    showToast,
} from './host.js';

const CHAR_TOGGLE_BTN_ID = 'wbo-hdr-show-char';

const WI_QUICK_ACTIONS_ID = 'wbo-wi-quick-actions';

const WAND_ENTRY_ID = 'wbo-wand-entry';

const MANAGER_OVERLAY_ID = 'wbo-manager-overlay';

const GROUP_MGR_OVERLAY_ID = 'wbo-gm-floating-overlay';

const SUBMODAL_OVERLAY_ID = 'wbo-submodal-overlay';

const PROMPT_OVERLAY_ID = 'wbo-prompt-overlay';

let _callbacks = null;

/** @type {{ left?: number, top?: number, width: number, height: number } | null} */
let _sessionManagerModalBox = null;
const _sessionMobileBoxes = new Map();

/** @type {Map<string, { total: number, enabledCount: number, entries: Array<any> }>} */
const _previewCache = new Map();

function placeOverlayAboveOpenPanels(overlay) {
    const currentLayer = Number.parseInt(getComputedStyle(overlay).zIndex, 10) || 0;
    let layer = currentLayer;
    // Read only our own open panel roots, once when creating the child window.
    document.querySelectorAll('.wbo-modal-overlay, .weg-modal-backdrop').forEach((panel) => {
        if (panel === overlay || panel.hidden || !panel.getClientRects().length) return;
        layer = Math.max(layer, (Number.parseInt(getComputedStyle(panel).zIndex, 10) || 0) + 1);
    });
    if (layer > currentLayer) overlay.style.zIndex = String(layer);
}

function isDesktopAutoFocusAllowed() {
    const w = globalThis.innerWidth || (typeof document !== 'undefined' ? document.documentElement?.clientWidth : 0) || 0;
    const coarse = typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches;
    return w > 680 && !coarse;
}

function bindImeSafeEnter(inputEl, onEnter, { preventDefault = true } = {}) {
    if (!(inputEl instanceof HTMLElement) || typeof onEnter !== 'function') return;
    let composing = false;
    inputEl.addEventListener('compositionstart', () => { composing = true; });
    inputEl.addEventListener('compositionend', () => { composing = false; });
    inputEl.addEventListener('keydown', (ev) => {
        if (ev.isComposing || ev.keyCode === 229 || composing) return;
        if (ev.key === 'Enter') {
            if (preventDefault) ev.preventDefault();
            onEnter(ev);
        }
    });
}

const UNDO_SVG = '<svg class="wbo-undo-svg" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';

/**
 * Detect whether the current SillyTavern / TauriTavern theme is light or dark
 * by inspecting computed body text luminance, so our modals & controls stay
 * 100% solid, legible, and insulated from translucent or colored host themes.
 * @returns {'wbo-theme-light' | 'wbo-theme-dark'}
 */
function detectHostThemeClass() {
    try {
        const probe = document.getElementById('WorldInfo') || document.body;
        const colorStr = probe ? globalThis.getComputedStyle(probe).color : '';
        const match = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (match) {
            const r = Number(match[1]);
            const g = Number(match[2]);
            const b = Number(match[3]);
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            // Dark text -> light theme; bright text -> dark theme
            return lum < 140 ? 'wbo-theme-light' : 'wbo-theme-dark';
        }
    } catch {
        // Fallback below
    }
    return 'wbo-theme-dark';
}

const THEME_PALETTES = Object.freeze([
    { id: 'classic', label: '素雅纸墨', lightBg: '#f6f6f3', darkBg: '#191a1d', accent: '#2b2b2e' },
    { id: 'ink', label: '素纸青岚', lightBg: '#f1f4f6', darkBg: '#20252d', accent: '#2c7a7b' },
    { id: 'warm', label: '暖笺琥珀', lightBg: '#f6f2ea', darkBg: '#221e1b', accent: '#b66634' },
    { id: 'sakura', label: '雾粉紫烟', lightBg: '#f8f4f7', darkBg: '#211d24', accent: '#b85c88' },
    { id: 'host', label: '跟随酒馆', lightBg: '#eef1f5', darkBg: '#242730', accent: '#7c8594' },
]);

/**
 * Sync the active palette & light/dark mode onto a modal element.
 * @param {HTMLElement | null} el
 */
function applyThemeClass(el) {
    if (!el) return;
    const { mode, palette } = getPanelTheme();
    el.classList.remove('wbo-theme-light', 'wbo-theme-dark');
    el.classList.add(`wbo-theme-${mode}`);
    el.setAttribute('data-wbo-palette', palette);
}

function getPanelTheme() {
    const settings = _callbacks?.getState?.()?.settings;
    const palette = settings?.themePalette || 'classic';
    const preference = settings?.themeMode;
    const mode = preference === 'light' || preference === 'dark'
        ? preference
        : (detectHostThemeClass() === 'wbo-theme-light' ? 'light' : 'dark');
    return { mode, palette };
}

/**
 * Sync theme classes onto all currently open plugin modals immediately.
 */
function syncAllOpenModalsTheme() {
    document.querySelectorAll('.wbo-modal, #wbo-restore-pill').forEach((el) => {
        if (el instanceof HTMLElement) applyThemeClass(el);
    });
    window.dispatchEvent(new Event('wbo:panel-theme-changed'));
}

/**
 * Escape HTML special characters safely.
 * @param {string} str
 * @returns {string}
 */
function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Configure host/controller callbacks used by UI actions.
 * @param {{
 *   getState: () => { settings: any, classification: any, bindingMap: Map<string, any> },
 *   onMutation: (opts?: { save?: boolean, uiOnly?: boolean }) => void | Promise<void>,
 *   onRescan: () => Promise<void>,
 * }} callbacks
 */
function bindPanelCallbacks(callbacks) {
    _callbacks = callbacks;
}

function closeGroupVisibilityPopover() {
    const visibilityPopover = document.getElementById('wbo-vis-popover-backdrop');
    visibilityPopover?.dispatchEvent(new Event('wbo:popover-close'));
    visibilityPopover?.remove();
    document.getElementById('wbo-quick-exclude-backdrop')?.remove();
    document.getElementById('wbo-search-opts-backdrop')?.remove();
}

/** @type {WeakMap<HTMLElement, () => void>} */
const _modalWindowCleanupMap = new WeakMap();

/**
 * Prevent `mousedown`, `touchstart`, and `click` events inside floating roots
 * from bubbling to `document.documentElement` (`<html>`), which SillyTavern uses
 * to auto-collapse unpinned `.openDrawer`s. Always bubble phase (`false`) so
 * child inputs, scrolling, and clicks keep working cleanly.
 * @param {HTMLElement | null} rootEl
 */
function bindDrawerSafeBubbleGuard(rootEl) {
    if (!(rootEl instanceof HTMLElement) || rootEl.dataset.wboBubbleGuarded === '1') return;
    rootEl.dataset.wboBubbleGuarded = '1';
    const stopBubble = (ev) => ev.stopPropagation();
    rootEl.addEventListener('mousedown', stopBubble, false);
    rootEl.addEventListener('touchstart', stopBubble, { capture: false, passive: true });
    rootEl.addEventListener('click', stopBubble, false);
}

/**
 * Enable unified desktop `PointerEvent` header dragging and 8-direction invisible edge/corner
 * resizing with fixed top/left anchoring (zero flex-center rebound!) and session box memory.
 * @param {HTMLElement} modal
 * @param {HTMLElement | null} handleEl
 * @param {{ initialBox?: { left?: number, top?: number, width?: number, height?: number } | null }} [opts]
 * @returns {() => void}
 */
function attachModalWindowControls(modal, handleEl, { initialBox = null } = {}) {
    if (!modal || !handleEl) return () => {};

    const isManager = modal.classList.contains('wbo-manager-modal');
    const fullScreen = modal.querySelector('[data-wbo-fullscreen-btn]');
    const mobileWindowKey = fullScreen?.dataset.wboFullscreenBtn;
    const storageKey = `wbo-window-size:${mobileWindowKey}`;
    const stableHeight = modal.style.getPropertyValue('--wbo-stable-h');
    let posLeft = 0;
    let posTop = 0;
    let hasFixedPos = false;
    let dragging = false;
    let resizing = false;
    let resizeDir = '';
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;
    let dragW = 0;
    let dragH = 0;
    let startRect = null;

    const getBounds = () => {
        const vw = Math.max(globalThis.innerWidth || document.documentElement?.clientWidth || 1200, 280);
        const vh = Math.max(globalThis.innerHeight || document.documentElement?.clientHeight || 800, 320);
        const isMobile = (vw <= 680 && Boolean(globalThis.matchMedia?.('(pointer: coarse)')?.matches)) || Boolean(mobileWindowKey && (
            globalThis.__TAURITAVERN_HOST__?.kind === 'mobile'
        ));
        const minW = isMobile ? Math.min(310, Math.max(240, vw - 16)) : 340;
        const minH = isMobile ? 250 : 280;
        const maxW = isMobile ? Math.max(minW, Math.round(vw - 16)) : Math.max(minW, vw);
        const maxH = isMobile ? Math.max(minH, Math.round(vh - 16)) : Math.max(minH, vh);
        return { vw, vh, isMobile, minW, minH, maxW, maxH };
    };

    const isMobileFloating = () => Boolean(mobileWindowKey && modal.classList.contains('is-resized'));

    const updateFullscreenButton = () => {
        if (!fullScreen) return;
        const label = isMobileFloating() ? '最大化' : '还原窗口';
        fullScreen.setAttribute('aria-label', label);
        fullScreen.title = isMobileFloating() ? '最大化' : '还原窗口后可移动和调整大小';
        fullScreen.querySelector('i').className = `fa-solid ${isMobileFloating() ? 'fa-expand' : 'fa-compress'}`;
    };

    const getMobileArea = ({ vw, vh }) => {
        const surface = isMobileFloating() ? modal.parentElement : modal;
        const css = globalThis.getComputedStyle(surface);
        const inset = (edge) => Math.max(8, Math.ceil(parseFloat(css?.[edge]) || 0));
        return {
            left: inset('paddingLeft'),
            top: inset('paddingTop'),
            right: vw - inset('paddingRight'),
            bottom: vh - inset('paddingBottom'),
        };
    };

    const applyFixedPosition = (left, top) => {
        posLeft = Math.round(left);
        posTop = Math.round(top);
        hasFixedPos = true;
        modal.classList.add('is-positioned');
        modal.style.left = `${posLeft}px`;
        modal.style.top = `${posTop}px`;
        modal.style.transform = 'none';
    };

    const pinToFixedPosition = () => {
        const { isMobile } = getBounds();
        if (hasFixedPos || (isMobile && !isMobileFloating())) return;
        const rect = modal.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        applyFixedPosition(rect.left, rect.top);
    };

    const fitMobileBox = (box, area = getMobileArea(getBounds())) => {
        const maxW = Math.max(1, area.right - area.left);
        const maxH = Math.max(1, area.bottom - area.top);
        const width = Math.round(Math.max(Math.min(310, maxW), Math.min(maxW, box.width)));
        const height = Math.round(Math.max(Math.min(250, maxH), Math.min(maxH, box.height)));
        modal.classList.add('is-resized');
        modal.style.width = `${width}px`;
        modal.style.height = `${height}px`;
        modal.style.maxHeight = `${height}px`;
        modal.style.setProperty('--wbo-stable-h', `${height}px`);
        applyFixedPosition(
            Math.max(area.left, Math.min(area.right - width, box.left ?? area.left + (maxW - width) / 2)),
            Math.max(area.top, Math.min(area.bottom - height, box.top ?? area.top + (maxH - height) / 2)),
        );
        updateFullscreenButton();
    };

    const saveWindowBox = ({ rememberSize = false } = {}) => {
        const { isMobile } = getBounds();
        if (!isManager && !isMobileFloating()) return;
        const r = modal.getBoundingClientRect();
        const box = {
            left: hasFixedPos ? posLeft : Math.round(r.left),
            top: hasFixedPos ? posTop : Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
        };
        if (isMobile && isMobileFloating()) {
            _sessionMobileBoxes.set(mobileWindowKey, box);
            if (rememberSize) {
                try {
                    const saved = JSON.stringify({ width: box.width, height: box.height });
                    if (globalThis.localStorage?.getItem(storageKey) !== saved) globalThis.localStorage?.setItem(storageKey, saved);
                } catch { /* Session geometry still works without browser storage. */ }
            }
        }
        if (isManager && !isMobile && r.width >= 300 && r.height >= 260) _sessionManagerModalBox = box;
    };

    const restoreMobileWindow = () => {
        const area = getMobileArea(getBounds());
        let box = _sessionMobileBoxes.get(mobileWindowKey);
        if (!box) {
            try {
                const saved = JSON.parse(globalThis.localStorage?.getItem(storageKey) || 'null');
                if (Number.isFinite(saved?.width) && saved.width > 0 && Number.isFinite(saved?.height) && saved.height > 0) {
                    box = { width: saved.width, height: saved.height };
                }
            } catch { /* Invalid or unavailable stored geometry uses the default size. */ }
        }
        if (!box) box = { width: (area.right - area.left) * 0.9, height: (area.bottom - area.top) * 0.76 };
        _sessionMobileBoxes.set(mobileWindowKey, box);
        fitMobileBox(box, area);
    };

    const clampIntoViewport = (preferredMobileBox = null) => {
        const { vw, vh, isMobile, minW, minH, maxW, maxH } = getBounds();
        if (isMobile) {
            if (isMobileFloating()) fitMobileBox(preferredMobileBox || modal.getBoundingClientRect());
            return;
        }

        if (modal.classList.contains('is-resized')) {
            const curRect = modal.getBoundingClientRect();
            const clampedW = Math.max(minW, Math.min(maxW, Math.round(curRect.width || minW)));
            const clampedH = Math.max(minH, Math.min(maxH, Math.round(curRect.height || minH)));
            modal.style.width = `${clampedW}px`;
            modal.style.height = `${clampedH}px`;
            modal.style.maxHeight = `${clampedH}px`;
            modal.style.setProperty('--wbo-stable-h', `${clampedH}px`);
        }

        const rect = modal.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const visibleHeaderMin = Math.min(100, Math.max(56, Math.round(rect.width * 0.35)));
        let nextLeft = hasFixedPos ? posLeft : Math.round(rect.left);
        let nextTop = hasFixedPos ? posTop : Math.round(rect.top);
        let changed = false;

        if (nextLeft + rect.width < visibleHeaderMin) {
            nextLeft = visibleHeaderMin - rect.width;
            changed = true;
        } else if (nextLeft > vw - visibleHeaderMin) {
            nextLeft = vw - visibleHeaderMin;
            changed = true;
        }
        if (nextTop < 0) {
            nextTop = 0;
            changed = true;
        } else if (nextTop > vh - 48) {
            nextTop = Math.max(0, vh - 48);
            changed = true;
        }
        if (changed && hasFixedPos) {
            applyFixedPosition(nextLeft, nextTop);
        }
    };

    // Initialize desktop fixed anchoring & optional initial/saved box
    const initBounds = getBounds();
    modal.classList.toggle('wbo-touch-window', Boolean(mobileWindowKey && initBounds.isMobile));
    updateFullscreenButton();
    if (!initBounds.isMobile) {
        if (isManager && _sessionManagerModalBox) {
            const savedW = Math.max(initBounds.minW, Math.min(initBounds.maxW, _sessionManagerModalBox.width));
            const savedH = Math.max(initBounds.minH, Math.min(initBounds.maxH, _sessionManagerModalBox.height));
            modal.classList.add('is-resized');
            modal.style.width = `${savedW}px`;
            modal.style.height = `${savedH}px`;
            modal.style.maxHeight = `${savedH}px`;
            modal.style.setProperty('--wbo-stable-h', `${savedH}px`);
            if (Number.isFinite(_sessionManagerModalBox.left) && Number.isFinite(_sessionManagerModalBox.top)) {
                applyFixedPosition(_sessionManagerModalBox.left, _sessionManagerModalBox.top);
            } else {
                pinToFixedPosition();
            }
            clampIntoViewport();
        } else if (initialBox && Number.isFinite(initialBox.width) && Number.isFinite(initialBox.height)) {
            const w = Math.max(initBounds.minW, Math.min(initBounds.maxW, Math.round(initialBox.width)));
            const h = Math.max(initBounds.minH, Math.min(initBounds.maxH, Math.round(initialBox.height)));
            modal.classList.add('is-resized');
            modal.style.width = `${w}px`;
            modal.style.height = `${h}px`;
            modal.style.maxHeight = `${h}px`;
            modal.style.setProperty('--wbo-stable-h', `${h}px`);
            if (Number.isFinite(initialBox.left) && Number.isFinite(initialBox.top)) {
                applyFixedPosition(initialBox.left, initialBox.top);
            } else {
                pinToFixedPosition();
            }
            clampIntoViewport();
        } else {
            pinToFixedPosition();
        }
    }

    const maximizeMobileWindow = () => {
        if (!getBounds().isMobile || !mobileWindowKey) return;
        hasFixedPos = false;
        modal.classList.remove('is-positioned', 'is-resized');
        for (const property of ['left', 'top', 'width', 'height', 'max-height', 'transform']) {
            modal.style.removeProperty(property);
        }
        modal.style.setProperty('--wbo-stable-h', stableHeight);
        updateFullscreenButton();
    };
    fullScreen?.addEventListener('click', () => {
        if (!getBounds().isMobile) return;
        if (isMobileFloating()) maximizeMobileWindow();
        else restoreMobileWindow();
    });
    modal.addEventListener('wbo:window-reopened', maximizeMobileWindow);

    handleEl.addEventListener('pointerdown', (ev) => {
        if (ev.isPrimary === false || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
        const target = ev.target instanceof Element ? ev.target : null;
        if (target?.closest('button, input, select, textarea, a, label, .wbo-resize-edge')) return;
        if (getBounds().isMobile && !isMobileFloating()) return;

        pinToFixedPosition();
        dragging = true;
        startX = ev.clientX;
        startY = ev.clientY;
        baseLeft = posLeft;
        baseTop = posTop;
        const rect = modal.getBoundingClientRect();
        dragW = rect.width || 360;
        dragH = rect.height;
        modal.classList.add('is-dragging-modal');
        try { handleEl.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
        ev.preventDefault();
    });

    handleEl.addEventListener('pointermove', (ev) => {
        if (!dragging) return;
        const bounds = getBounds();
        if (bounds.isMobile) {
            if (!isMobileFloating()) return;
            const area = getMobileArea(bounds);
            applyFixedPosition(
                Math.max(area.left, Math.min(area.right - dragW, baseLeft + ev.clientX - startX)),
                Math.max(area.top, Math.min(area.bottom - dragH, baseTop + ev.clientY - startY)),
            );
            return;
        }
        const { vw, vh } = bounds;
        const visibleHeaderMin = Math.min(100, Math.max(56, Math.round(dragW * 0.35)));
        const minLeft = -(dragW - visibleHeaderMin);
        const maxLeft = vw - visibleHeaderMin;
        const maxTop = Math.max(0, vh - 48);

        const nextLeft = Math.max(minLeft, Math.min(maxLeft, baseLeft + (ev.clientX - startX)));
        const nextTop = Math.max(0, Math.min(maxTop, baseTop + (ev.clientY - startY)));
        applyFixedPosition(nextLeft, nextTop);
    });

    const endDrag = (ev) => {
        if (!dragging) return;
        dragging = false;
        modal.classList.remove('is-dragging-modal');
        try { handleEl.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
        saveWindowBox();
    };
    handleEl.addEventListener('pointerup', endDrag);
    handleEl.addEventListener('pointercancel', endDrag);

    // Eight desktop resize edges, with the bottom-right edge also used by the touch grip.
    const resizeDirs = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
    if (!modal.classList.contains('wbo-prompt-modal')) {
        for (const dir of resizeDirs) {
            if (modal.querySelector(`.wbo-resize-edge[data-resize-dir="${dir}"]`)) continue;
            const edge = document.createElement('div');
            edge.className = `wbo-resize-edge wbo-resize-${dir}`;
            edge.setAttribute('data-resize-dir', dir);
            if (mobileWindowKey && dir === 'se') edge.title = '拖动调整窗口大小';
            modal.appendChild(edge);

            edge.addEventListener('pointerdown', (ev) => {
                if (ev.isPrimary === false || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
                if (getBounds().isMobile && (!mobileWindowKey || dir !== 'se')) return;
                ev.stopPropagation();
                ev.preventDefault();
                pinToFixedPosition();
                const rect = modal.getBoundingClientRect();
                resizing = true;
                resizeDir = dir;
                startX = ev.clientX;
                startY = ev.clientY;
                startRect = {
                    left: hasFixedPos ? posLeft : Math.round(rect.left),
                    top: hasFixedPos ? posTop : Math.round(rect.top),
                    right: Math.round((hasFixedPos ? posLeft : rect.left) + rect.width),
                    bottom: Math.round((hasFixedPos ? posTop : rect.top) + rect.height),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                };
                modal.classList.add('is-resizing-modal');
                try { edge.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
            });

            edge.addEventListener('pointermove', (ev) => {
                if (!resizing || resizeDir !== dir || !startRect) return;
                const bounds = getBounds();
                const dxPtr = ev.clientX - startX;
                const dyPtr = ev.clientY - startY;
                if (bounds.isMobile) {
                    if (!mobileWindowKey || dir !== 'se' || (!isMobileFloating() && dxPtr >= -4 && dyPtr >= -4)) return;
                    const area = getMobileArea(bounds);
                    const left = Math.max(area.left, startRect.left);
                    const top = Math.max(area.top, startRect.top);
                    fitMobileBox({
                        left,
                        top,
                        width: Math.min(area.right - left, startRect.width + dxPtr),
                        height: Math.min(area.bottom - top, startRect.height + dyPtr),
                    }, area);
                    return;
                }
                const { vw, vh, minW, minH, maxW, maxH } = bounds;

                let nextLeft = startRect.left;
                let nextTop = startRect.top;
                let nextW = startRect.width;
                let nextH = startRect.height;

                if (dir.includes('e')) {
                    const availW = startRect.left >= 0 ? Math.min(maxW, vw - startRect.left) : maxW;
                    nextW = Math.round(Math.max(minW, Math.min(Math.max(minW, availW), startRect.width + dxPtr)));
                } else if (dir.includes('w')) {
                    const availW = Math.min(maxW, startRect.right);
                    nextW = Math.round(Math.max(minW, Math.min(Math.max(minW, availW), startRect.width - dxPtr)));
                    nextLeft = startRect.right - nextW;
                }

                if (dir.includes('s')) {
                    const availH = Math.min(maxH, vh - startRect.top);
                    nextH = Math.round(Math.max(minH, Math.min(Math.max(minH, availH), startRect.height + dyPtr)));
                } else if (dir.includes('n')) {
                    const availH = Math.min(maxH, startRect.bottom);
                    nextH = Math.round(Math.max(minH, Math.min(Math.max(minH, availH), startRect.height - dyPtr)));
                    nextTop = startRect.bottom - nextH;
                }

                modal.classList.add('is-resized');
                modal.style.width = `${nextW}px`;
                modal.style.height = `${nextH}px`;
                modal.style.maxHeight = `${nextH}px`;
                modal.style.setProperty('--wbo-stable-h', `${nextH}px`);
                if (dir.includes('w') || dir.includes('n')) {
                    applyFixedPosition(nextLeft, nextTop);
                }
            });

            const endResize = (ev) => {
                if (!resizing || resizeDir !== dir) return;
                resizing = false;
                resizeDir = '';
                startRect = null;
                modal.classList.remove('is-resizing-modal');
                try { edge.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
                clampIntoViewport();
                saveWindowBox({ rememberSize: true });
            };
            edge.addEventListener('pointerup', endResize);
            edge.addEventListener('pointercancel', endResize);
        }
    }

    const onViewportChange = () => {
        if (!modal.isConnected) return;
        const { isMobile } = getBounds();
        modal.classList.toggle('wbo-touch-window', Boolean(mobileWindowKey && isMobile));
        if (isMobile && !isMobileFloating()) {
            hasFixedPos = false;
            modal.classList.remove('is-positioned');
            modal.style.left = '';
            modal.style.top = '';
            modal.style.transform = '';
            return;
        }
        pinToFixedPosition();
        clampIntoViewport(isMobile && !dragging && !resizing ? _sessionMobileBoxes.get(mobileWindowKey) : null);
    };
    globalThis.addEventListener('resize', onViewportChange);
    globalThis.addEventListener('orientationchange', onViewportChange);

    return () => {
        globalThis.removeEventListener('resize', onViewportChange);
        globalThis.removeEventListener('orientationchange', onViewportChange);
        modal.removeEventListener('wbo:window-reopened', maximizeMobileWindow);
    };
}

// ==================== Sub-Modals (stack above Manager Modal) ====================

/** @type {HTMLElement[]} */
const _subModalStack = [];

function prunePreviewCacheAfterSubModal() {
    const expandedBooks = new Set();
    document.querySelectorAll(`#${MANAGER_OVERLAY_ID} .wbo-book-item[data-book]`).forEach((item) => {
        const preview = item.querySelector('.wbo-book-preview');
        const name = item.getAttribute('data-book');
        if (name && preview instanceof HTMLElement && !preview.hidden) {
            expandedBooks.add(name);
        }
    });
    for (const key of [..._previewCache.keys()]) {
        if (!expandedBooks.has(key)) {
            _previewCache.delete(key);
        }
    }
}

function cleanupOverlayWindowControls(overlayEl) {
    if (!(overlayEl instanceof HTMLElement)) return;
    const m = overlayEl.querySelector('.wbo-modal');
    if (m instanceof HTMLElement) {
        const fn = _modalWindowCleanupMap.get(m);
        if (typeof fn === 'function') {
            fn();
            _modalWindowCleanupMap.delete(m);
        }
    }
}

function closeSubModal(opts = null) {
    const promptOverlay = document.getElementById(PROMPT_OVERLAY_ID);
    if (promptOverlay) {
        cleanupOverlayWindowControls(promptOverlay);
        promptOverlay.remove();
    }
    const closeAll = Boolean(opts && opts.all === true);
    if (closeAll) {
        while (_subModalStack.length > 0) {
            const top = _subModalStack.pop();
            cleanupOverlayWindowControls(top);
            top?.remove();
        }
        document.querySelectorAll(`#${SUBMODAL_OVERLAY_ID}, .wbo-submodal-overlay`).forEach((el) => {
            cleanupOverlayWindowControls(el);
            el.remove();
        });
        prunePreviewCacheAfterSubModal();
        return;
    }

    const specific = opts?.overlay instanceof HTMLElement ? opts.overlay : null;
    if (specific) {
        const idx = _subModalStack.lastIndexOf(specific);
        if (idx >= 0) _subModalStack.splice(idx, 1);
        cleanupOverlayWindowControls(specific);
        specific.remove();
    } else if (_subModalStack.length > 0) {
        const top = _subModalStack.pop();
        cleanupOverlayWindowControls(top);
        top?.remove();
    } else {
        const el = document.getElementById(SUBMODAL_OVERLAY_ID);
        cleanupOverlayWindowControls(el);
        el?.remove();
    }
    if (_subModalStack.length === 0) {
        prunePreviewCacheAfterSubModal();
    }
    document.getElementById('wbo-mgr-scan-btn')?.blur?.();
}

/**
 * Lightweight in-plugin text prompt submodal (safe replacement for `window.prompt()`
 * in iOS WKWebView / TauriTavern).
 * @param {{ title?: string, label?: string, initialValue?: string, placeholder?: string, confirmText?: string, cancelText?: string }} [opts]
 * @returns {Promise<string | null>}
 */
function openInlineTextPrompt({
    title = '输入内容',
    label = '',
    initialValue = '',
    placeholder = '请输入...',
    confirmText = '确定',
    cancelText = '取消',
} = {}) {
    document.getElementById(PROMPT_OVERLAY_ID)?.remove();
    return new Promise((resolve) => {
        let settled = false;
        const finish = (val) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onEsc, true);
            cleanupOverlayWindowControls(overlay);
            overlay.remove();
            resolve(val);
        };

        const overlay = document.createElement('div');
        overlay.id = PROMPT_OVERLAY_ID;
        overlay.className = 'wbo-modal-overlay wbo-prompt-overlay';
        applyTauriSurface(overlay, 'backdrop');

        const modal = document.createElement('div');
        modal.className = 'wbo-modal wbo-prompt-modal';
        applyThemeClass(modal);
        applyTauriSurface(modal, 'fullscreen-window');

        modal.innerHTML = `
            <div class="wbo-modal-header wbo-draggable-header">
                <div class="wbo-modal-header-top">
                    <span class="wbo-modal-title">${esc(title)}</span>
                    <button type="button" class="wbo-icon-btn wbo-modal-close" aria-label="关闭">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            <div class="wbo-modal-body">
                <div class="wbo-field">
                    ${label ? `<label class="wbo-label">${esc(label)}</label>` : ''}
                    <div class="wbo-input-clear-row">
                        <input type="text" class="wbo-input" id="wbo-inline-prompt-input" value="${esc(initialValue)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
                        <button type="button" class="wbo-btn wbo-input-clear-btn" id="wbo-inline-prompt-clear" title="清空输入框">清空</button>
                    </div>
                </div>
                <div class="wbo-modal-footer wbo-footer-pair">
                    <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-inline-prompt-ok">${esc(confirmText)}</button>
                    <button type="button" class="wbo-btn" id="wbo-inline-prompt-cancel">${esc(cancelText)}</button>
                </div>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        placeOverlayAboveOpenPanels(overlay);

        bindDrawerSafeBubbleGuard(overlay);
        bindDrawerSafeBubbleGuard(modal);
        const promptWinCleanup = attachModalWindowControls(modal, modal.querySelector('.wbo-modal-header'));
        _modalWindowCleanupMap.set(modal, promptWinCleanup);

        const input = modal.querySelector('#wbo-inline-prompt-input');
        const clearBtn = modal.querySelector('#wbo-inline-prompt-clear');
        const okBtn = modal.querySelector('#wbo-inline-prompt-ok');
        const cancelBtn = modal.querySelector('#wbo-inline-prompt-cancel');
        const closeBtn = modal.querySelector('.wbo-modal-close');

        const confirm = () => {
            const val = input instanceof HTMLInputElement ? input.value.trim() : '';
            if (!val) {
                showToast('warning', '请输入内容');
                if (input instanceof HTMLInputElement && isDesktopAutoFocusAllowed()) {
                    input.focus({ preventScroll: true });
                }
                return;
            }
            finish(val);
        };

        const onEsc = (ev) => {
            if (ev.key === 'Escape') {
                ev.preventDefault();
                ev.stopPropagation();
                finish(null);
            }
        };
        document.addEventListener('keydown', onEsc, true);

        closeBtn?.addEventListener('click', () => finish(null));
        cancelBtn?.addEventListener('click', () => finish(null));
        okBtn?.addEventListener('click', confirm);
        clearBtn?.addEventListener('click', () => {
            if (input instanceof HTMLInputElement) {
                input.value = '';
                if (isDesktopAutoFocusAllowed()) input.focus({ preventScroll: true });
            }
        });
        if (input instanceof HTMLInputElement) {
            bindImeSafeEnter(input, confirm);
            if (isDesktopAutoFocusAllowed()) {
                input.focus({ preventScroll: true });
                input.select();
            }
        }
    });
}

/**
 * Create a sub-modal stacked above the Group Manager modal without closing `#WorldInfo`.
 */
function createSubModal(title, bodyHtml, { wide = false, pinnedLayout = false, stack = false, floating = false, prompt = false } = {}) {
    if (!stack) {
        closeSubModal({ all: true });
    }
    const stackIdx = _subModalStack.length;
    const overlay = document.createElement('div');
    overlay.id = stackIdx === 0 ? SUBMODAL_OVERLAY_ID : `${SUBMODAL_OVERLAY_ID}-${stackIdx}`;
    overlay.className = `wbo-modal-overlay wbo-submodal-overlay${floating ? ' wbo-floating-overlay' : ''}${prompt ? ' wbo-prompt-overlay' : ''}`;
    if (stackIdx > 0) {
        overlay.style.zIndex = String(10020 + stackIdx);
    }
    applyTauriSurface(overlay, 'backdrop');

    const modal = document.createElement('div');
    modal.className = `wbo-modal${wide ? ' is-wide' : ''}${pinnedLayout ? ' is-pinned-layout' : ''}${prompt ? ' wbo-prompt-modal' : ''}`;
    applyThemeClass(modal);
    if (!prompt) applyTauriSurface(modal, 'fullscreen-window');
    if (wide || pinnedLayout) {
        // Lock a steady window height so switching tabs/views NEVER jumps the modal vertically!
        const baseVh = Math.max(globalThis.innerHeight || 0, document.documentElement?.clientHeight || 0, 560);
        const stableH = wide
            ? Math.round(Math.min(baseVh * 0.84, 680))
            : Math.round(Math.min(baseVh * 0.78, 600));
        modal.style.setProperty('--wbo-stable-h', `${stableH}px`);
    }

    modal.innerHTML = `
        <div class="wbo-modal-header wbo-draggable-header">
            <div class="wbo-modal-header-top">
                <span class="wbo-modal-title">${esc(title)}</span>
                <div class="wbo-modal-header-actions">
                    <button type="button" class="wbo-icon-btn wbo-modal-close" aria-label="关闭">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
        </div>
        <div class="wbo-modal-body${pinnedLayout ? ' wbo-pinned-body' : ''}">${bodyHtml}</div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    placeOverlayAboveOpenPanels(overlay);
    _subModalStack.push(overlay);

    // Isolate events from SillyTavern and close ONLY via the `×` / action buttons (never backdrop click!)
    if (!floating) {
        bindDrawerSafeBubbleGuard(overlay);
    }
    bindDrawerSafeBubbleGuard(modal);
    const subWinCleanup = attachModalWindowControls(modal, modal.querySelector('.wbo-modal-header'));
    _modalWindowCleanupMap.set(modal, subWinCleanup);
    modal.querySelector('.wbo-modal-close')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeSubModal({ overlay });
    });

    return { overlay, modal };
}

export {
    _callbacks,
    _modalWindowCleanupMap,
    _previewCache,
    applyThemeClass,
    attachModalWindowControls,
    bindDrawerSafeBubbleGuard,
    bindImeSafeEnter,
    bindPanelCallbacks,
    CHAR_TOGGLE_BTN_ID,
    cleanupOverlayWindowControls,
    closeGroupVisibilityPopover,
    closeSubModal,
    createSubModal,
    detectHostThemeClass,
    esc,
    getPanelTheme,
    GROUP_MGR_OVERLAY_ID,
    isDesktopAutoFocusAllowed,
    MANAGER_OVERLAY_ID,
    openInlineTextPrompt,
    PROMPT_OVERLAY_ID,
    syncAllOpenModalsTheme,
    THEME_PALETTES,
    UNDO_SVG,
    WAND_ENTRY_ID,
    WI_QUICK_ACTIONS_ID,
};
