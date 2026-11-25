/**
 * Worldbook Organizer — Entry module for SillyTavern & TauriTavern.
 *
 * Lifecycle guarantees:
 * - Idempotent boot compatible with both SillyTavern (1.14–1.19+) and TauriTavern
 *   deferred extension activation after `APP_READY`.
 * - Zero polling & zero background disk scanning: builds its index purely from
 *   in-memory character/worldbook state + persistent lazy-load cache, refreshing
 *   only on debounced character/worldbook mutation events or explicit user action.
 * - Full deterministic cleanup (`onDisable` / `onClean`) restores native DOM,
 *   detaches observers, and unregisters all host event listeners.
 */

import {
    SPECIAL_GROUPS,
    buildCharacterBindingIndex,
    buildPersonaBindingIndex,
    classifyWorldbooks,
    findUnscannedShallowCharacters,
    promoteSectionToTop,
    pruneStaleWorldbookSettings,
    updateCachedCharBindings,
} from './src/core.js';
import {
    ensurePowerUserModule,
    ensureWorldInfoModule,
    getCharLoreEntries,
    getCharactersInMemory,
    getCurrentCharacterAvatar,
    getHostContext,
    getPowerUserSettings,
    getSettings,
    getWorldNames,
    importEmbeddedWorldbookForCharacter,
    migrateLegacyLocalApiConfig,
    saveSettings,
    scanShallowCharactersInBatches,
    showToast,
    syncFallbackSettingsData,
    waitForTauriReadyIfPresent,
} from './src/host.js';
import {
    applyAllNativeWorldFilters,
    getDetachedWorldNames,
    pruneDetachedWorldNames,
    setCurrentlyEditingWorld,
    startNativeObservers,
    syncMobileEditorTriggerLabel,
    teardownNativeFilters,
} from './src/native-filter.js';
import {
    bindPanelCallbacks,
    invalidatePreviewCache,
    openManagerModal,
    renderEmbeddedPanel,
    syncEmbeddedPanelIndicators,
    teardownPanels,
} from './src/panel.js';

export const STYLE_ASSET_VERSION = '2.34.5';
let _initialized = false;
let _initialAutoScanRunning = false;
let _incrementalAutoScanRunning = false;
let _incrementalAutoScanTimer = null;
const _autoScanAttemptedAvatars = new Set();
let _debounceTimer = null;
let _deferredSaveTimer = null;
let _classification = null;
let _openPanelBridgeHandler = null;
let _wegEntriesToggledHandler = null;

/**
 * Bust stale browser/WebView disk cache on `style.css` after an extension update
 * without causing a flash of unstyled content.
 */
function ensureFreshStylesheet() {
    if (typeof document === 'undefined' || !document.head) return;
    try {
        const targetHref = new URL(`./style.css?v=${STYLE_ASSET_VERSION}`, import.meta.url).href;
        const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
        const existing = links.filter((el) => {
            const h = el.getAttribute('href') || '';
            return h.includes('worldbook-organizer/style.css');
        });
        if (existing.some((el) => el.href === targetHref)) return;
        const fresh = document.createElement('link');
        fresh.rel = 'stylesheet';
        fresh.href = targetHref;
        fresh.setAttribute('data-wbo-style-ver', STYLE_ASSET_VERSION);
        fresh.addEventListener('load', () => {
            for (const old of existing) {
                if (old !== fresh) old.remove();
            }
        });
        document.head.appendChild(fresh);
    } catch {
        // Ignore in non-browser or restricted environments
    }
}
let _bindingMap = new Map();
/** @type {Array<{ event: string, handler: Function }>} */
const _boundEvents = [];
let _domWorldInfoChangeHandler = null;
let _domEditorChangeHandler = null;

/**
 * Recompute in-memory classification and synchronize both the embedded panel
 * and native `#world_info` / `#world_editor_select` controls.
 * Zero disk I/O!
 *
 * @param {{ save?: boolean }} [opts]
 */
function recomputeAndRender({ save = false, deferGlobal = false } = {}) {
    const settings = getSettings();
    const characters = getCharactersInMemory();

    // Update lazy-load cache purely from already-loaded in-memory characters
    const { cached, changed } = updateCachedCharBindings(settings.cachedCharBindings, characters);
    if (changed) {
        settings.cachedCharBindings = cached;
        save = true;
    }

    const worldNames = getWorldNames(getDetachedWorldNames());
    const worldNamesSet = new Set(worldNames);
    pruneDetachedWorldNames(worldNamesSet);
    if (pruneStaleWorldbookSettings(settings, worldNamesSet)) {
        save = true;
    }
    const charLore = getCharLoreEntries();
    const powerUser = getPowerUserSettings();

    _bindingMap = buildCharacterBindingIndex({
        characters,
        charLore,
        cachedCharBindings: settings.cachedCharBindings,
        worldNamesSet,
        includeExtraCharBooks: Boolean(settings.includeExtraCharBooks),
        includeEmbeddedNameMatch: Boolean(settings.includeEmbeddedNameMatch),
    });

    const personaMap = buildPersonaBindingIndex(powerUser);

    _classification = classifyWorldbooks({
        worldNames,
        bindingMap: _bindingMap,
        personaMap,
        settings,
    });

    if (save) {
        clearTimeout(_deferredSaveTimer);
        if (deferGlobal) {
            _deferredSaveTimer = setTimeout(() => {
                _deferredSaveTimer = null;
                if (_initialized) saveSettings();
            }, 300);
        } else {
            _deferredSaveTimer = null;
            saveSettings();
        }
    }

    applyAllNativeWorldFilters(_classification, settings, { deferGlobal });
    renderEmbeddedPanel();

    // One-time gentle initial auto-scan on first install (handles lazyLoadCharacters seamlessly
    // and notifies newcomers clearly where their character worldbooks are tucked away).
    if (!settings.hasDoneInitialAutoScan && !_initialAutoScanRunning && characters.length > 0) {
        _initialAutoScanRunning = true;
        const unscanned = findUnscannedShallowCharacters(characters, settings.cachedCharBindings);
        settings.hasDoneInitialAutoScan = true;
        saveSettings();

        if (unscanned.length > 0) {
            setTimeout(async () => {
                try {
                    const scanned = await scanShallowCharactersInBatches(unscanned, { batchSize: 2 });
                    if (!_initialized) return;
                    const curSettings = getSettings();
                    const { cached, changed } = updateCachedCharBindings(curSettings.cachedCharBindings, scanned, { pruneDeleted: false });
                    if (changed) {
                        curSettings.cachedCharBindings = cached;
                    }
                    recomputeAndRender({ save: true });
                    if ((_classification?.charCount || 0) > 0 && curSettings.hideCharBooksByDefault) {
                        showToast('info', `已自动识别并收纳 ${_classification.charCount} 本角色世界书，点「角色书」开关可随时查看`);
                    }
                } catch {
                    // Non-fatal: user can always trigger manual scan later
                } finally {
                    _initialAutoScanRunning = false;
                }
            }, 900);
        } else {
            _initialAutoScanRunning = false;
            if ((_classification?.charCount || 0) > 0 && settings.hideCharBooksByDefault) {
                showToast('info', `已自动识别并收纳 ${_classification.charCount} 本角色世界书，点「角色书」开关可随时查看`);
            }
        }
    } else if (
        settings.hasDoneInitialAutoScan &&
        settings.autoScanNewCharacters !== false &&
        !_initialAutoScanRunning &&
        !_incrementalAutoScanRunning &&
        characters.length > 0
    ) {
        // Incremental auto-scan for newly imported lazy-loaded character cards only.
        // Wait until native import/UI painting is completely idle (2.2s debounce + requestIdleCallback,
        // 1 card at a time with 80ms yield) so native character import stays 100% stutter-free!
        const pending = findUnscannedShallowCharacters(characters, settings.cachedCharBindings)
            .filter((item) => item?.avatar && !_autoScanAttemptedAvatars.has(item.avatar));
        if (pending.length > 0) {
            clearTimeout(_incrementalAutoScanTimer);
            const runIncrementalScan = async () => {
                if (!_initialized || _incrementalAutoScanRunning) return;
                const curSettings = getSettings();
                if (curSettings.autoScanNewCharacters === false) return;
                const freshTargets = findUnscannedShallowCharacters(getCharactersInMemory(), curSettings.cachedCharBindings)
                    .filter((item) => item?.avatar && !_autoScanAttemptedAvatars.has(item.avatar));
                if (freshTargets.length === 0) return;

                _incrementalAutoScanRunning = true;
                for (const item of freshTargets) {
                    _autoScanAttemptedAvatars.add(item.avatar);
                }
                try {
                    const scanned = await scanShallowCharactersInBatches(freshTargets, {
                        batchSize: 1,
                        yieldMs: 80,
                    });
                    if (!_initialized) return;
                    const latestSettings = getSettings();
                    const { cached, changed } = updateCachedCharBindings(latestSettings.cachedCharBindings, scanned, { pruneDeleted: false });
                    if (changed) {
                        latestSettings.cachedCharBindings = cached;
                    }
                    recomputeAndRender({ save: true, deferGlobal: true });
                } catch {
                    // Non-fatal: user can still trigger manual scan from the Scan modal
                } finally {
                    _incrementalAutoScanRunning = false;
                }
            };
            _incrementalAutoScanTimer = setTimeout(() => {
                _incrementalAutoScanTimer = null;
                if (typeof globalThis.requestIdleCallback === 'function') {
                    globalThis.requestIdleCallback(() => { void runIncrementalScan(); }, { timeout: 2000 });
                } else {
                    void runIncrementalScan();
                }
            }, 2200);
        }
    }
}

/**
 * Ultra-lightweight fast-path when ONLY `showCharBooks` (and optional section promotion) changed:
 * reuses the existing in-memory `_classification` without rescanning characters or re-sorting 200+ books,
 * updates `#world_editor_select` immediately, and defers `#world_info` + `saveSettings()` off the tap frame.
 * @param {{ save?: boolean }} [opts]
 */
function applyCharToggleFastPath({ save = true } = {}) {
    if (!_classification) {
        recomputeAndRender({ save });
        return;
    }
    const settings = getSettings();
    const order = Array.isArray(settings.sectionOrder) ? settings.sectionOrder : _classification.sectionOrder;
    if (Array.isArray(order) && Array.isArray(_classification.orderedSections)) {
        const byId = new Map(_classification.orderedSections.map((s) => [s.id, s]));
        const reordered = [];
        for (const id of order) {
            const sec = byId.get(id);
            if (sec) {
                reordered.push(sec);
                byId.delete(id);
            }
        }
        for (const rest of byId.values()) reordered.push(rest);
        _classification.orderedSections = reordered;
        _classification.sectionOrder = [...order];
    }

    applyAllNativeWorldFilters(_classification, settings, { deferGlobal: true });
    renderEmbeddedPanel();

    if (save) {
        clearTimeout(_deferredSaveTimer);
        _deferredSaveTimer = setTimeout(() => {
            _deferredSaveTimer = null;
            if (_initialized) saveSettings();
        }, 120);
    }
}

/**
 * Debounced refresh triggered by character or worldbook mutation events.
 * @param {number} [delayMs=450]
 */
function scheduleRefresh(delayMs = 550) {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
        if (!_initialized) return;
        const run = () => {
            if (!_initialized) return;
            recomputeAndRender({ save: false, deferGlobal: true });
        };
        if (typeof globalThis.requestIdleCallback === 'function') {
            globalThis.requestIdleCallback(run, { timeout: 1200 });
        } else {
            run();
        }
    }, delayMs);
}

/**
 * Manual rescan requested by the user (only time fallback `/api/settings/get` is forced).
 */
async function performManualRescan() {
    await ensureWorldInfoModule();
    await syncFallbackSettingsData(true);
    recomputeAndRender({ save: true });
}

/**
 * Subscribe safely to host eventSource with cleanup tracking.
 * @param {any} eventSource
 * @param {string | undefined} eventName
 * @param {Function} handler
 */
function trackHostEvent(eventSource, eventName, handler) {
    if (!eventSource || !eventName || typeof eventSource.on !== 'function') return;
    eventSource.on(eventName, handler);
    _boundEvents.push({ event: eventName, handler });
}

/**
 * Register lightweight `/wbo` slash command when `SlashCommandParser` is available.
 */
function registerSlashCommands(ctx) {
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx || {};
        if (!SlashCommandParser || !SlashCommand || !SlashCommandArgument || !ARGUMENT_TYPE) return;

        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: 'wbo',
                callback: async (_namedArgs, unnamedArgs) => {
                    const action = String(unnamedArgs ?? '').trim().toLowerCase() || 'toggle';
                    const settings = getSettings();
                    if (action === 'show') {
                        settings.showCharBooks = true;
                        settings.charGroupCollapsed = false;
                        promoteSectionToTop(settings, SPECIAL_GROUPS.CHARACTER);
                        recomputeAndRender({ save: true });
                        showToast('info', '已显示角色世界书');
                        return 'shown';
                    }
                    if (action === 'hide') {
                        settings.showCharBooks = false;
                        if (settings.activeFilterGroupId === SPECIAL_GROUPS.CHARACTER) {
                            settings.activeFilterGroupId = SPECIAL_GROUPS.DEFAULT;
                        }
                        recomputeAndRender({ save: true });
                        showToast('info', '已隐藏角色世界书');
                        return 'hidden';
                    }
                    if (action === 'rescan') {
                        await performManualRescan();
                        showToast('success', '已重新扫描角色世界书绑定');
                        return 'rescanned';
                    }
                    settings.showCharBooks = !settings.showCharBooks;
                    if (settings.showCharBooks) {
                        settings.charGroupCollapsed = false;
                        promoteSectionToTop(settings, SPECIAL_GROUPS.CHARACTER);
                    } else if (settings.activeFilterGroupId === SPECIAL_GROUPS.CHARACTER) {
                        settings.activeFilterGroupId = SPECIAL_GROUPS.DEFAULT;
                    }
                    recomputeAndRender({ save: true });
                    showToast('info', settings.showCharBooks ? '已显示角色世界书' : '已隐藏角色世界书');
                    return settings.showCharBooks ? 'shown' : 'hidden';
                },
                unnamedArgumentList: [
                    SlashCommandArgument.fromProps({
                        description: 'toggle | show | hide | rescan',
                        typeList: [ARGUMENT_TYPE.STRING],
                        isRequired: false,
                        enumList: ['toggle', 'show', 'hide', 'rescan'],
                    }),
                ],
                helpString: '切换角色世界书显隐或重新扫描绑定：/wbo [toggle|show|hide|rescan]',
            }),
        );
    } catch {
        // Non-fatal if host slash command API differs
    }
}

/**
 * Main idempotent initialization routine.
 */
async function init() {
    if (_initialized) return;
    _initialized = true;

    await waitForTauriReadyIfPresent();
    const ctx = getHostContext();
    if (!ctx) {
        _initialized = false;
        return;
    }

    const settings = getSettings();
    // Honor default hide preference cleanly on fresh boot (character books or any custom excluded groups)
    const hasAnyDefaultHidden = Boolean(
        settings.hideCharBooksByDefault ||
        (Array.isArray(settings.globalHiddenGroupIds) && settings.globalHiddenGroupIds.length > 0) ||
        (Array.isArray(settings.editorHiddenGroupIds) && settings.editorHiddenGroupIds.length > 0),
    );
    if (hasAnyDefaultHidden) {
        settings.showCharBooks = false;
        if (settings.activeFilterGroupId === SPECIAL_GROUPS.CHARACTER) {
            settings.activeFilterGroupId = SPECIAL_GROUPS.DEFAULT;
        }
    }

    // Migrate legacy v1.4.0 localStorage API config into cross-device extensionSettings once
    if (migrateLegacyLocalApiConfig(settings)) {
        saveSettings();
    }

    // Load in-memory world-info & power-user modules once (with ST 1.14 fallbacks)
    await ensureWorldInfoModule();
    await ensurePowerUserModule();
    await syncFallbackSettingsData(false);

    bindPanelCallbacks({
        getState: () => ({
            settings: getSettings(),
            bindingMap: _bindingMap,
            classification: _classification || classifyWorldbooks({ worldNames: [], bindingMap: new Map(), settings: getSettings() }),
        }),
        onMutation: ({ save = true, uiOnly = false, charToggleOnly = false } = {}) => {
            if (uiOnly) {
                if (save) saveSettings();
                return;
            }
            if (charToggleOnly && _classification) {
                applyCharToggleFastPath({ save });
                return;
            }
            recomputeAndRender({ save });
        },
        onRescan: performManualRescan,
    });

    // Remove any legacy extension-drawer mount from earlier versions (settings now live in Group Manager)
    document.getElementById('wbo-extension-settings')?.remove();

    recomputeAndRender({ save: false });

    // Watch only direct `<option>` changes in `#world_info` / `#world_editor_select` + bind popup
    startNativeObservers(() => {
        scheduleRefresh(380);
    });

    // Listen to native select changes so checkboxes & active indicators stay in sync
    // WITHOUT full DOM innerHTML rebuilds (preserves scroll position & IME state!)
    const $ = globalThis.jQuery;
    if ($) {
        _domWorldInfoChangeHandler = () => {
            syncEmbeddedPanelIndicators();
        };
        _domEditorChangeHandler = () => {
            const sel = document.getElementById('world_editor_select');
            const selectedOpt = sel?.selectedOptions?.[0];
            const name = selectedOpt && selectedOpt.value !== '' ? (selectedOpt.textContent || '').trim() : null;
            setCurrentlyEditingWorld(name);
            syncMobileEditorTriggerLabel();
            syncEmbeddedPanelIndicators();
        };
        $(document).on('change.wbo', '#world_info', _domWorldInfoChangeHandler);
        $(document).on('change.wbo', '#world_editor_select', _domEditorChangeHandler);
    }

    // Subscribe ONLY to relevant low-frequency character & worldbook events (zero message-turn overhead!)
    const eventSource = ctx.eventSource;
    const et = ctx.eventTypes || ctx.event_types || {};

    const onCharOrWorldChanged = () => scheduleRefresh(700);
    trackHostEvent(eventSource, et.CHARACTER_EDITED, onCharOrWorldChanged);
    trackHostEvent(eventSource, et.CHARACTER_DELETED, onCharOrWorldChanged);
    trackHostEvent(eventSource, et.CHARACTER_RENAMED, onCharOrWorldChanged);
    trackHostEvent(eventSource, et.CHARACTER_DUPLICATED, onCharOrWorldChanged);
    trackHostEvent(eventSource, et.CHARACTER_IMPORTED, onCharOrWorldChanged);
    trackHostEvent(eventSource, et.CHARACTER_PAGE_LOADED, onCharOrWorldChanged);
    trackHostEvent(eventSource, et.WORLDINFO_SETTINGS_UPDATED, onCharOrWorldChanged);

    // When user opens a character's hidden lorebook directly via the character card globe icon,
    // keep that book temporarily visible in `#world_editor_select`.
    trackHostEvent(eventSource, et.WORLDINFO_ENTRIES_LOADED, (worldName) => {
        if (typeof worldName === 'string' && worldName.trim()) {
            setCurrentlyEditingWorld(worldName.trim());
            scheduleRefresh(120);
        }
    });

    // Always rescan once APP_READY fires (in SillyTavern, `getCharacters()` finishes right before APP_READY!)
    trackHostEvent(eventSource, et.APP_READY, () => scheduleRefresh(120));
    trackHostEvent(eventSource, et.EXTENSION_SETTINGS_LOADED, () => scheduleRefresh(200));

    // When switching to a chat with a shallow character that just became unshallowed,
    // refresh in-memory cache once gently (no disk scan), and optionally auto-import
    // its missing embedded lorebook if user enabled that setting.
    trackHostEvent(eventSource, et.CHAT_CHANGED, () => {
        scheduleRefresh(220);
        const curSettings = getSettings();
        if (curSettings.autoImportMissingCharBook) {
            setTimeout(async () => {
                const avatar = getCurrentCharacterAvatar();
                if (!avatar) return;
                const res = await importEmbeddedWorldbookForCharacter(avatar);
                if (res.status === 'imported') {
                    showToast('info', `已自动导入角色内嵌世界书「${res.name}」并归入角色分组`);
                    recomputeAndRender({ save: true });
                }
            }, 900);
        }
    });

    // One-time gentle fallback if characters finished loading right after early init
    if (getCharactersInMemory().length === 0) {
        let retries = 0;
        const waitCharsOnce = () => {
            if (!_initialized) return;
            if (getCharactersInMemory().length > 0) {
                recomputeAndRender({ save: false });
                return;
            }
            if (retries < 6) {
                retries += 1;
                setTimeout(waitCharsOnce, 700);
            }
        };
        setTimeout(waitCharsOnce, 700);
    }

    if (!_openPanelBridgeHandler && typeof window !== 'undefined') {
        _openPanelBridgeHandler = () => {
            openManagerModal();
        };
        window.addEventListener('wbo:open-panel', _openPanelBridgeHandler);
    }
    if (!_wegEntriesToggledHandler && typeof window !== 'undefined') {
        _wegEntriesToggledHandler = (ev) => {
            const worldName = String(ev?.detail?.worldName ?? '').trim();
            invalidatePreviewCache(worldName || null);
        };
        window.addEventListener('weg:entries-toggled', _wegEntriesToggledHandler);
    }

    registerSlashCommands(ctx);
    ensureFreshStylesheet();
}

/**
 * Cleanly remove all listeners, observers, and DOM mounts, restoring native selects.
 */
export function onDisable() {
    if (_openPanelBridgeHandler && typeof window !== 'undefined') {
        window.removeEventListener('wbo:open-panel', _openPanelBridgeHandler);
        _openPanelBridgeHandler = null;
    }
    if (_wegEntriesToggledHandler && typeof window !== 'undefined') {
        window.removeEventListener('weg:entries-toggled', _wegEntriesToggledHandler);
        _wegEntriesToggledHandler = null;
    }
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
    clearTimeout(_deferredSaveTimer);
    _deferredSaveTimer = null;
    clearTimeout(_incrementalAutoScanTimer);
    _incrementalAutoScanTimer = null;
    _incrementalAutoScanRunning = false;
    _autoScanAttemptedAvatars.clear();

    const ctx = getHostContext();
    const eventSource = ctx?.eventSource;
    if (eventSource && typeof eventSource.removeListener === 'function') {
        for (const { event, handler } of _boundEvents) {
            try {
                eventSource.removeListener(event, handler);
            } catch {
                // Ignore
            }
        }
    }
    _boundEvents.length = 0;

    const $ = globalThis.jQuery;
    if ($) {
        $(document).off('.wbo');
    }
    _domWorldInfoChangeHandler = null;
    _domEditorChangeHandler = null;

    teardownNativeFilters();
    teardownPanels();
    _initialized = false;
}

export const onClean = onDisable;

// Schedule deferred boot cleanly on both SillyTavern (1.14–1.19+) and TauriTavern
function boot() {
    const start = () => {
        if (typeof globalThis.requestIdleCallback === 'function') {
            globalThis.requestIdleCallback(() => { void init(); }, { timeout: 1500 });
        } else {
            setTimeout(() => { void init(); }, 250);
        }
    };

    const ctx = getHostContext();
    const eventSource = ctx?.eventSource;
    const et = ctx?.eventTypes || ctx?.event_types;

    if (eventSource && et?.APP_READY) {
        eventSource.once(et.APP_READY, start);
    }

    if (typeof globalThis.jQuery === 'function') {
        globalThis.jQuery(() => {
            // Fallback if APP_READY already fired before deferred extension activation
            setTimeout(start, 400);
        });
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
}

boot();
