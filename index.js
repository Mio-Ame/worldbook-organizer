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
    refreshEditorWorldSelect,
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
    syncNativeQuickActionsUi,
    teardownPanels,
} from './src/panel.js';
import { startEntryGrouping, stopEntryGrouping } from './src/entry-groups/lifecycle.js';
import { configureEntryGroupingFeatureGate } from './src/entry-groups/feature-gate.js';
import { setNativeScrollEnabled } from './src/content-scroll.js';
import { closeManagerModal } from './src/panel-manager.js';
import { applyImportedWorldbookPlan, createWorldbookImportTracker, planImportedWorldbooks } from './src/import-organizer.js';

export const STYLE_ASSET_VERSION = '2.35.20';
let _initialized = false;
let _entryGroupingGate = null;
let _disabled = false;
let _bootCleanup = null;
let _chatImportTimer = null;
let _waitCharsTimer = null;
let _initialAutoScanRunning = false;
let _initialAutoScanTimer = null;
let _incrementalAutoScanRunning = false;
let _incrementalAutoScanTimer = null;
let _autoScanSignal = null;
const _autoScanAttemptedAvatars = new Set();
let _debounceTimer = null;
let _idleRefreshId = null;
let _deferredSaveTimer = null;
let _classification = null;
let _openPanelBridgeHandler = null;
let _wegEntriesToggledHandler = null;
const worldbookImports = createWorldbookImportTracker();
const importsAwaitingCharacterScan = new Map();

function captureWorldbookImport(event) {
    const input = event.target;
    if (input?.id !== 'world_import_file' || input.type !== 'file') return;
    worldbookImports.capture(Array.from(input.files || [], (file) => file.name), getWorldNames());
}

function applyNewBookImportRules(settings, worldNames, characters, charLore) {
    const config = settings.importOrganize;
    if (!config?.rules.length && !config?.sensitiveGroupId) {
        worldbookImports.clear();
        importsAwaitingCharacterScan.clear();
        return 0;
    }
    const now = Date.now();
    for (const name of worldbookImports.collect(worldNames, now)) {
        if (importsAwaitingCharacterScan.size >= 128) importsAwaitingCharacterScan.delete(importsAwaitingCharacterScan.keys().next().value);
        importsAwaitingCharacterScan.set(name, now + 5 * 60_000);
    }
    if (!importsAwaitingCharacterScan.size) return 0;
    const live = new Set(worldNames);
    for (const [name, expires] of importsAwaitingCharacterScan) {
        if (expires < now || !live.has(name)) importsAwaitingCharacterScan.delete(name);
    }
    if (!importsAwaitingCharacterScan.size || findUnscannedShallowCharacters(characters, settings.cachedCharBindings).length > 0) return 0;
    const plan = planImportedWorldbooks({ settings, titles: [...importsAwaitingCharacterScan.keys()], characters, charLore });
    importsAwaitingCharacterScan.clear();
    return applyImportedWorldbookPlan(settings, plan);
}

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
 * Normalize the return value of `scanShallowCharactersInBatches` (`{ scanned, done, cancelled }`
 * or an array) into the array of scanned character summaries expected by `updateCachedCharBindings`.
 * @param {any} scanResult
 * @returns {Array<any>}
 */
export function extractScannedCharacters(scanResult) {
    if (Array.isArray(scanResult)) return scanResult;
    if (scanResult && Array.isArray(scanResult.scanned)) return scanResult.scanned;
    return [];
}

/**
 * Execute one silent low-concurrency auto-scan catch-up batch and merge scanned
 * summaries into `settings.cachedCharBindings`.
 *
 * @param {object} [opts]
 * @returns {Promise<{ scannedCount: number, changed: boolean, skipped: boolean, cancelled: boolean }>}
 */
export async function runSilentAutoScanBatch({
    targets = [],
    batchSize = 1,
    yieldMs = 80,
    signal = null,
    scanFn = scanShallowCharactersInBatches,
    getSettingsFn = getSettings,
    saveSettingsFn = saveSettings,
    attemptedSet = _autoScanAttemptedAvatars,
    markInitialDone = false,
    checkInitialized = () => _initialized,
} = {}) {
    const list = Array.isArray(targets) ? targets.filter((t) => t?.avatar) : [];
    const curSettings = getSettingsFn();
    if (curSettings?.autoScanNewCharacters === false) {
        return { scannedCount: 0, changed: false, skipped: true, cancelled: false };
    }
    if (list.length === 0) {
        if (markInitialDone && curSettings && !curSettings.hasDoneInitialAutoScan) {
            curSettings.hasDoneInitialAutoScan = true;
            saveSettingsFn();
        }
        return { scannedCount: 0, changed: false, skipped: false, cancelled: false };
    }

    const scanRes = await scanFn(list, {
        batchSize,
        yieldMs,
        signal,
    });
    if (!checkInitialized()) {
        return { scannedCount: 0, changed: false, skipped: true, cancelled: true };
    }

    const cancelled = Boolean(
        scanRes &&
        typeof scanRes === 'object' &&
        !Array.isArray(scanRes) &&
        scanRes.cancelled,
    );
    const scannedCards = extractScannedCharacters(scanRes);
    const doneCount = Number.isFinite(scanRes?.done) ? scanRes.done : list.length;

    if (attemptedSet) {
        const attemptedSlice = cancelled ? list.slice(0, Math.max(0, doneCount)) : list;
        for (const item of attemptedSlice) {
            if (item?.avatar) attemptedSet.add(item.avatar);
        }
    }

    const latestSettings = getSettingsFn();
    const { cached, changed } = updateCachedCharBindings(
        latestSettings.cachedCharBindings,
        scannedCards,
        { pruneDeleted: false },
    );
    if (changed) {
        latestSettings.cachedCharBindings = cached;
    }
    if (markInitialDone && !cancelled) {
        latestSettings.hasDoneInitialAutoScan = true;
    }

    return {
        scannedCount: scannedCards.length,
        changed,
        skipped: false,
        cancelled,
    };
}

function scheduleIdleAutoScanCatchUp(settings, characters) {
    if (
        !settings ||
        settings.autoScanNewCharacters === false ||
        _initialAutoScanRunning ||
        _incrementalAutoScanRunning ||
        !Array.isArray(characters) ||
        characters.length === 0
    ) {
        return;
    }

    const pending = findUnscannedShallowCharacters(characters, settings.cachedCharBindings)
        .filter((item) => item?.avatar && !_autoScanAttemptedAvatars.has(item.avatar));
    if (pending.length === 0) return;

    clearTimeout(_incrementalAutoScanTimer);
    const runIncrementalScan = async () => {
        if (!_initialized || _incrementalAutoScanRunning || _initialAutoScanRunning) return;
        const curSettings = getSettings();
        if (curSettings.autoScanNewCharacters === false) return;
        const freshTargets = findUnscannedShallowCharacters(getCharactersInMemory(), curSettings.cachedCharBindings)
            .filter((item) => item?.avatar && !_autoScanAttemptedAvatars.has(item.avatar));
        if (freshTargets.length === 0) return;

        _incrementalAutoScanRunning = true;
        const signal = { cancelled: false };
        _autoScanSignal = signal;
        let shouldRerender = false;
        try {
            const res = await runSilentAutoScanBatch({
                targets: freshTargets,
                batchSize: 1,
                yieldMs: 80,
                signal,
                markInitialDone: true,
            });
            if (!_initialized) return;
            shouldRerender = Boolean(res.changed || !curSettings.hasDoneInitialAutoScan);
        } catch {
            // Non-fatal: user can still trigger manual scan from the Scan modal
        } finally {
            if (_autoScanSignal === signal) _autoScanSignal = null;
            _incrementalAutoScanRunning = false;
        }
        if (_initialized && shouldRerender) {
            recomputeAndRender({ save: true, deferGlobal: true, backgroundCatchUp: true });
        }
    };

    _incrementalAutoScanTimer = setTimeout(() => {
        _incrementalAutoScanTimer = null;
        if (!_initialized) return;
        if (typeof globalThis.requestIdleCallback === 'function') {
            globalThis.requestIdleCallback(() => { void runIncrementalScan(); }, { timeout: 2000 });
        } else {
            void runIncrementalScan();
        }
    }, 2200);
}

/**
 * Recompute in-memory classification and synchronize both the embedded panel
 * and native `#world_info` / `#world_editor_select` controls.
 * Zero disk I/O!
 *
 * @param {{ save?: boolean }} [opts]
 */
function recomputeAndRender({ save = false, deferGlobal = false, backgroundCatchUp = false } = {}) {
    if (_disabled) return;
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
    const importedMovedCount = applyNewBookImportRules(settings, worldNames, characters, charLore);
    if (importedMovedCount > 0) save = true;

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
    renderEmbeddedPanel({ backgroundCatchUp });
    if (importedMovedCount > 0) showToast('success', `已按标题将 ${importedMovedCount} 本导入世界书归组`);

    // Gentle initial auto-scan + silent idle catch-up when autoScanNewCharacters is ON
    if (
        !settings.hasDoneInitialAutoScan &&
        settings.autoScanNewCharacters !== false &&
        !_initialAutoScanRunning &&
        characters.length > 0
    ) {
        const unscanned = findUnscannedShallowCharacters(characters, settings.cachedCharBindings);
        if (unscanned.length > 0) {
            _initialAutoScanRunning = true;
            clearTimeout(_initialAutoScanTimer);
            _initialAutoScanTimer = setTimeout(async () => {
                _initialAutoScanTimer = null;
                if (!_initialized) {
                    _initialAutoScanRunning = false;
                    return;
                }
                const signal = { cancelled: false };
                _autoScanSignal = signal;
                let batchRes = { changed: false, cancelled: false };
                try {
                    const curSettings = getSettings();
                    const freshUnscanned = findUnscannedShallowCharacters(
                        getCharactersInMemory(),
                        curSettings.cachedCharBindings,
                    );
                    batchRes = await runSilentAutoScanBatch({
                        targets: freshUnscanned,
                        batchSize: 2,
                        yieldMs: 30,
                        signal,
                        markInitialDone: true,
                    });
                } catch {
                    // Non-fatal: user can always trigger manual scan later
                } finally {
                    if (_autoScanSignal === signal) _autoScanSignal = null;
                    _initialAutoScanRunning = false;
                }
                if (!_initialized) return;
                if (!batchRes.skipped) {
                    recomputeAndRender({ save: true, backgroundCatchUp: true });
                    const latest = getSettings();
                    if (!batchRes.cancelled && (_classification?.charCount || 0) > 0 && latest.hideCharBooksByDefault) {
                        showToast('info', `已自动识别并收纳 ${_classification.charCount} 本角色世界书，点「角色书」开关可随时查看`);
                    }
                }
            }, 900);
        } else {
            settings.hasDoneInitialAutoScan = true;
            saveSettings();
            if ((_classification?.charCount || 0) > 0 && settings.hideCharBooksByDefault) {
                showToast('info', `已自动识别并收纳 ${_classification.charCount} 本角色世界书，点「角色书」开关可随时查看`);
            }
        }
    } else if (settings.hasDoneInitialAutoScan) {
        scheduleIdleAutoScanCatchUp(settings, characters);
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

function cancelPendingIdleRefresh() {
    if (_idleRefreshId !== null) {
        if (typeof globalThis.cancelIdleCallback === 'function') {
            try { globalThis.cancelIdleCallback(_idleRefreshId); } catch { /* ignore */ }
        }
        _idleRefreshId = null;
    }
}

/**
 * Debounced refresh triggered by character or worldbook mutation events.
 * @param {number} [delayMs=450]
 */
function scheduleRefresh(delayMs = 550) {
    clearTimeout(_debounceTimer);
    cancelPendingIdleRefresh();
    _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        if (!_initialized) return;
        const run = () => {
            _idleRefreshId = null;
            if (!_initialized) return;
            recomputeAndRender({ save: false, deferGlobal: true });
        };
        if (delayMs <= 120 || typeof globalThis.requestIdleCallback !== 'function') {
            run();
        } else {
            let ran = false;
            const id = globalThis.requestIdleCallback(() => {
                ran = true;
                run();
            }, { timeout: 1200 });
            if (!ran) _idleRefreshId = id;
        }
    }, delayMs);
}

/**
 * Manual rescan requested by the user (only time fallback `/api/settings/get` is forced).
 */
async function performManualRescan() {
    _autoScanAttemptedAvatars.clear();
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
    if (_initialized || _disabled) return;
    _initialized = true;
    setNativeScrollEnabled(true);

    await waitForTauriReadyIfPresent();
    if (_disabled) return;
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
    if (_disabled) return;
    await ensurePowerUserModule();
    if (_disabled) return;
    await syncFallbackSettingsData(false);
    if (_disabled) return;

    bindPanelCallbacks({
        getState: () => ({
            settings: getSettings(),
            bindingMap: _bindingMap,
            classification: _classification || classifyWorldbooks({ worldNames: [], bindingMap: new Map(), settings: getSettings() }),
        }),
        onMutation: ({ save = true, uiOnly = false, charToggleOnly = false, pinInPlaceOnly = false, catchupScan = false, quickActionsOnly = false } = {}) => {
            if (uiOnly) {
                if (save) saveSettings();
                if (quickActionsOnly) {
                    syncNativeQuickActionsUi();
                }
                if (catchupScan) {
                    scheduleIdleAutoScanCatchUp(getSettings(), getCharactersInMemory());
                }
                return;
            }
            if (pinInPlaceOnly && _classification) {
                if (save) {
                    clearTimeout(_deferredSaveTimer);
                    _deferredSaveTimer = setTimeout(() => {
                        _deferredSaveTimer = null;
                        if (_initialized) saveSettings();
                    }, 120);
                }
                applyAllNativeWorldFilters(_classification, getSettings(), { deferGlobal: true });
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
    document.addEventListener('change', captureWorldbookImport, true);

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
            // Active globals sit at the top of the editor picker, so re-sort it on toggle.
            refreshEditorWorldSelect();
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
    trackHostEvent(eventSource, et.WORLDINFO_SETTINGS_UPDATED, () => scheduleRefresh(80));

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
        clearTimeout(_chatImportTimer);
        _chatImportTimer = null;
        const curSettings = getSettings();
        if (curSettings.autoImportMissingCharBook) {
            _chatImportTimer = setTimeout(async () => {
                _chatImportTimer = null;
                if (_disabled) return;
                const avatar = getCurrentCharacterAvatar();
                if (!avatar) return;
                const res = await importEmbeddedWorldbookForCharacter(avatar);
                if (_disabled) return;
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
            _waitCharsTimer = null;
            if (!_initialized) return;
            if (getCharactersInMemory().length > 0) {
                recomputeAndRender({ save: false });
                return;
            }
            if (retries < 6) {
                retries += 1;
                _waitCharsTimer = setTimeout(waitCharsOnce, 700);
            }
        };
        _waitCharsTimer = setTimeout(waitCharsOnce, 700);
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
        window.addEventListener('weg:entry-saved', _wegEntriesToggledHandler);
    }

    registerSlashCommands(ctx);
    ensureFreshStylesheet();
    _entryGroupingGate = configureEntryGroupingFeatureGate({
        getSettings,
        start: startEntryGrouping,
        stop: stopEntryGrouping,
        styleVersion: STYLE_ASSET_VERSION,
        onRevealNativeEditor: closeManagerModal,
    });
    await _entryGroupingGate.sync();
}

/**
 * Cleanly remove all listeners, observers, and DOM mounts, restoring native selects.
 */
export function onDisable() {
    _disabled = true;
    _bootCleanup?.();
    _bootCleanup = null;
    clearTimeout(_chatImportTimer);
    _chatImportTimer = null;
    clearTimeout(_waitCharsTimer);
    _waitCharsTimer = null;
    setNativeScrollEnabled(false);
    globalThis.document?.removeEventListener?.('change', captureWorldbookImport, true);
    worldbookImports.clear();
    importsAwaitingCharacterScan.clear();
    if (_openPanelBridgeHandler && typeof window !== 'undefined') {
        window.removeEventListener('wbo:open-panel', _openPanelBridgeHandler);
        _openPanelBridgeHandler = null;
    }
    if (_wegEntriesToggledHandler && typeof window !== 'undefined') {
        window.removeEventListener('weg:entries-toggled', _wegEntriesToggledHandler);
        window.removeEventListener('weg:entry-saved', _wegEntriesToggledHandler);
        _wegEntriesToggledHandler = null;
    }
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
    cancelPendingIdleRefresh();
    clearTimeout(_deferredSaveTimer);
    _deferredSaveTimer = null;
    clearTimeout(_initialAutoScanTimer);
    _initialAutoScanTimer = null;
    _initialAutoScanRunning = false;
    clearTimeout(_incrementalAutoScanTimer);
    _incrementalAutoScanTimer = null;
    _incrementalAutoScanRunning = false;
    if (_autoScanSignal) {
        _autoScanSignal.cancelled = true;
        _autoScanSignal = null;
    }
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

    if (_entryGroupingGate) _entryGroupingGate.dispose();
    else stopEntryGrouping();
    _entryGroupingGate = null;
    teardownNativeFilters();
    teardownPanels();
    const assetRoot = new URL('./', import.meta.url).href;
    document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
        if (link.href.startsWith(assetRoot)) link.remove();
    });
    _initialized = false;
}

export const onClean = onDisable;

// Schedule deferred boot cleanly on both SillyTavern (1.14–1.19+) and TauriTavern
function boot() {
    const timers = new Set();
    let idle = null;
    const later = (fn, delay) => {
        const id = setTimeout(() => {
            timers.delete(id);
            if (!_disabled) fn();
        }, delay);
        timers.add(id);
    };
    const start = () => {
        if (_disabled) return;
        if (typeof globalThis.requestIdleCallback === 'function') {
            if (idle !== null) return;
            idle = globalThis.requestIdleCallback(() => { idle = null; void init(); }, { timeout: 1500 });
        } else {
            later(() => { void init(); }, 250);
        }
    };

    const ctx = getHostContext();
    const eventSource = ctx?.eventSource;
    const et = ctx?.eventTypes || ctx?.event_types;

    _bootCleanup = () => {
        for (const id of timers) clearTimeout(id);
        timers.clear();
        if (idle !== null) globalThis.cancelIdleCallback?.(idle);
        idle = null;
        document.removeEventListener('DOMContentLoaded', start);
        const off = eventSource?.removeListener || eventSource?.off;
        if (et?.APP_READY && typeof off === 'function') off.call(eventSource, et.APP_READY, start);
    };

    if (eventSource && et?.APP_READY) {
        eventSource.once(et.APP_READY, start);
    }

    if (typeof globalThis.jQuery === 'function') {
        globalThis.jQuery(() => {
            // Fallback if APP_READY already fired before deferred extension activation
            if (!_disabled) later(start, 400);
        });
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
}

boot();
