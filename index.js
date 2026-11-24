/**
 * Worldbook Organizer — Entry module for SillyTavern & TauriTavern.
 *
 * Lifecycle guarantees:
 * - Idempotent boot compatible with both SillyTavern (1.14–1.19+) and TauriTavern
 *   deferred third-party extension activation after `APP_READY`.
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
    showToast,
    syncFallbackSettingsData,
    waitForTauriReadyIfPresent,
} from './src/host.js';
import {
    applyAllNativeWorldFilters,
    getDetachedWorldNames,
    setCurrentlyEditingWorld,
    startNativeObservers,
    teardownNativeFilters,
} from './src/native-filter.js';
import {
    bindPanelCallbacks,
    renderEmbeddedPanel,
    renderExtensionSettingsPanel,
    syncEmbeddedPanelIndicators,
    teardownPanels,
} from './src/panel.js';

let _initialized = false;
let _debounceTimer = null;
let _classification = null;
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
function recomputeAndRender({ save = false } = {}) {
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
        saveSettings();
    }

    applyAllNativeWorldFilters(_classification, settings);
    renderEmbeddedPanel();
    renderExtensionSettingsPanel();
}

/**
 * Debounced refresh triggered by character or worldbook mutation events.
 * @param {number} [delayMs=450]
 */
function scheduleRefresh(delayMs = 450) {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
        if (!_initialized) return;
        recomputeAndRender({ save: false });
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
                    if (!settings.showCharBooks && settings.activeFilterGroupId === SPECIAL_GROUPS.CHARACTER) {
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
    // Honor default hide preference cleanly on fresh boot
    if (settings.hideCharBooksByDefault) {
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
        onMutation: ({ save = true, uiOnly = false } = {}) => {
            if (uiOnly) {
                if (save) saveSettings();
                return;
            }
            recomputeAndRender({ save });
        },
        onRescan: performManualRescan,
    });

    recomputeAndRender({ save: false });

    // Watch only direct `<option>` changes in `#world_info` / `#world_editor_select` + bind popup
    startNativeObservers(() => {
        scheduleRefresh(150);
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
            syncEmbeddedPanelIndicators();
        };
        $(document).on('change.wbo', '#world_info', _domWorldInfoChangeHandler);
        $(document).on('change.wbo', '#world_editor_select', _domEditorChangeHandler);
    }

    // Subscribe ONLY to relevant low-frequency character & worldbook events (zero message-turn overhead!)
    const eventSource = ctx.eventSource;
    const et = ctx.eventTypes || ctx.event_types || {};

    const onCharOrWorldChanged = () => scheduleRefresh(500);
    trackHostEvent(eventSource, et.CHARACTER_EDITED, onCharOrWorldChanged);
    trackHostEvent(eventSource, et.CHARACTER_DELETED, onCharOrWorldChanged);
    trackHostEvent(eventSource, et.CHARACTER_RENAMED, onCharOrWorldChanged);
    trackHostEvent(eventSource, et.CHARACTER_DUPLICATED, onCharOrWorldChanged);
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
        scheduleRefresh(600);
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

    registerSlashCommands(ctx);
}

/**
 * Cleanly remove all listeners, observers, and DOM mounts, restoring native selects.
 */
export function onDisable() {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;

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
            // Fallback if APP_READY already fired before deferred third-party activation
            setTimeout(start, 400);
        });
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
}

boot();
