/**
 * Worldbook Entry Groups — Entry module for SillyTavern & TauriTavern.
 *
 * Lifecycle guarantees:
 * - Zero polling, zero background worldbook scanning, zero multi-floor chat history scanning.
 * - Enhances the native World Info pagination and visible entry rows.
 * - O(1) metadata-based per-chat route restoration on `CHAT_CHANGED` + pre-WorldInfo scene auto-toggle
 *   on `GENERATION_AFTER_COMMANDS`.
 */

import {
    migrateSettingsOnWorldRename,
    MODULE_NAME,
    removeDeletedWorldsFromSettings,
} from './core.js';
import {
    captureExternalWorldbookSwitchForActiveChat,
    clearRuntimeBookSnapshots,
    ensureWorldInfoModule,
    getCurrentCharacterPrimaryWorldName,
    getHostContext,
    getNativeGroupingPreferences,
    getSettings,
    isWithinSelfWriteWindow,
    saveSettings,
    switchNamedGroupInActiveChat,
    syncSceneGroupsBeforeGeneration,
    syncWorldbookForActiveChat,
} from './host.js';
import {
    bindPanelCallbacks,
    getCurrentModalWorldName,
    handleExternalEntriesUpdated,
    handleExternalWorldbookDeleted,
    handleExternalWorldbookRenamed,
    isEntryGroupsModalOpen,
    openEntryGroupsModal,
    refreshOpenModalBook,
    syncAllNativeEntryPoints,
    syncEntryGroupsTheme,
    teardownPanels,
} from './panel.js';
import { hasEnabledLegacyGrouping, isLegacyGroupingMounted } from './legacy.js';
import { isEntryGroupingEnabled } from './feature-gate.js';

let _initialized = false;
let _lifecycleEpoch = 0;
let _mountJob = null;
let _editorChangeCleanup = null;
let _stylesheet = null;
const _registeredSlashParsers = new WeakSet();
let _nativeMountObserver = null;
let _nativeMountTarget = null;
let _greetingSyncTimer = null;
let _chatSwitchSyncTimer = null;
let _externalFollowTimer = null;
let _wboEntriesTimer = null;
let _suppressExternalFollowUntil = 0;
/** @type {Array<{ event: string, handler: Function }>} */
const _boundHostEvents = [];
let _onWboRenamed = null;
let _onWboDeleted = null;
let _onWboEntriesUpdated = null;
let _onWegOpenPanel = null;

export function isEntryGroupingAvailable() {
    return isEntryGroupingEnabled(getHostContext()?.extensionSettings?.worldbook_organizer)
        && (_initialized || isLegacyGroupingMounted());
}

function trackHostEvent(eventSource, eventName, handler) {
    if (!eventSource || !eventName || typeof eventSource.on !== 'function') return;
    eventSource.on(eventName, handler);
    _boundHostEvents.push({ event: eventName, handler });
}

function scheduleOpenModalSync(delayMs = 480) {
    if (!isEntryGroupsModalOpen()) return;

    clearTimeout(_greetingSyncTimer);
    _greetingSyncTimer = setTimeout(() => {
        _greetingSyncTimer = null;
        if (!_initialized || !isEntryGroupsModalOpen()) return;
        if (isWithinSelfWriteWindow()) return;

        const openBook = getCurrentModalWorldName();
        const activeCharBook = getCurrentCharacterPrimaryWorldName();
        if (openBook && (!activeCharBook || openBook === activeCharBook)) {
            void refreshOpenModalBook({ silent: true, reason: 'external-sync' });
        }
    }, delayMs);
}

function scheduleChatSaveRouteSync(reason, delayMs) {
    clearTimeout(_chatSwitchSyncTimer);
    _chatSwitchSyncTimer = setTimeout(async () => {
        _chatSwitchSyncTimer = null;
        if (!_initialized) return;
        const epoch = _lifecycleEpoch;
        const settings = getSettings();
        if (settings.autoSwitchOnChatChange === false) {
            syncAllNativeEntryPoints();
            if (isEntryGroupsModalOpen()) {
                void refreshOpenModalBook({ silent: true, reason });
            }
            return;
        }

        await syncWorldbookForActiveChat({
            reason,
            silentToast: reason === 'floor0-swipe',
            isCurrent: () => _initialized && epoch === _lifecycleEpoch,
        });

        if (!_initialized || epoch !== _lifecycleEpoch) return;
        syncAllNativeEntryPoints();
        if (isEntryGroupsModalOpen()) {
            void refreshOpenModalBook({ silent: true, reason });
        }
    }, delayMs);
}

function stopNativeEditorObserver() {
    _nativeMountObserver?.disconnect();
    _nativeMountObserver = null;
    _nativeMountTarget = null;
}

function syncNativeEditorIntegration() {
    if (!_initialized) return;
    syncAllNativeEntryPoints();
    if (!getNativeGroupingPreferences().active) {
        _mountJob?.();
        _mountJob = null;
        stopNativeEditorObserver();
        return;
    }
    startNativeEditorObserver(scheduleNativeEntrySync);
}

function scheduleNativeEntrySync() {
    if (!_initialized) return;
    if (_mountJob) return;
    const run = () => {
        _mountJob = null;
        if (_initialized) syncNativeEditorIntegration();
    };
    if (typeof globalThis.requestAnimationFrame === 'function') {
        const id = globalThis.requestAnimationFrame(run);
        _mountJob = () => globalThis.cancelAnimationFrame?.(id);
    } else {
        const id = setTimeout(run, 16);
        _mountJob = () => clearTimeout(id);
    }
}

function startNativeEditorObserver(scheduleSync) {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    const popup = document.getElementById('world_popup');
    const drawer = document.getElementById('WorldInfo');
    const target = drawer?.contains(popup) ? drawer : popup || drawer;
    if (_nativeMountTarget === target) return;
    _nativeMountObserver?.disconnect();
    _nativeMountObserver = null;
    _nativeMountTarget = target;
    if (!target) return;

    const nativeParts = '#world_popup, #world_info_pagination, #world_info_pagination select, #world_popup_entries_list, #WIEntryHeaderTitlesPC, .world_entry[uid]';
    _nativeMountObserver = new MutationObserver((records) => {
        const changed = records.some((record) => {
            if (record.target instanceof Element && record.target.closest('.world_entry[uid]')) return false;
            return [...record.addedNodes, ...record.removedNodes].some((node) =>
                node instanceof Element && (node.matches(nativeParts) || node.querySelector(nativeParts)),
            );
        });
        if (changed) scheduleSync();
    });
    _nativeMountObserver.observe(target, { childList: true, subtree: true });
}

/**
 * Register `/weg [分组名 | 世界书名称]` slash command:
 * - `/weg` -> opens panel
 * - `/weg 分组名` -> switches a matching group in the active chat.
 * - `/weg 世界书名` -> opens that worldbook in panel
 */
function registerSlashCommand(ctx) {
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx || {};
        if (!SlashCommandParser || !SlashCommand || _registeredSlashParsers.has(SlashCommandParser)) return;

        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: 'weg',
                callback: async (_namedArgs, unnamedArgs) => {
                    if (!_initialized || !isEntryGroupingAvailable()) return '';
                    const epoch = _lifecycleEpoch;
                    const arg = String(unnamedArgs ?? '').trim();
                    if (!arg) {
                        await openEntryGroupsModal();
                        return 'opened';
                    }
                    const switched = await switchNamedGroupInActiveChat(arg, { isCurrent: () => _initialized && epoch === _lifecycleEpoch });
                    if (!_initialized || epoch !== _lifecycleEpoch) return '';
                    if (switched.matched) {
                        syncAllNativeEntryPoints();
                        if (isEntryGroupsModalOpen()) {
                            void refreshOpenModalBook({ silent: true, reason: 'slash-switch' });
                        }
                        return switched.groupName || arg;
                    }
                    await openEntryGroupsModal({ worldName: arg });
                    return arg;
                },
                unnamedArgumentList: SlashCommandArgument && ARGUMENT_TYPE ? [
                    SlashCommandArgument.fromProps({
                        description: '可选：分组名称或世界书名称',
                        typeList: [ARGUMENT_TYPE.STRING],
                        isRequired: false,
                    }),
                ] : [],
                helpString: '打开世界书条目分组面板，或直接切换本档分组路线：/weg [分组名|世界书名称]',
            }),
        );
        _registeredSlashParsers.add(SlashCommandParser);
    } catch {
        // Non-fatal
    }
}

export async function startEntryGrouping(styleVersion, { onRevealNativeEditor } = {}) {
    const ctx = getHostContext();
    if (!isEntryGroupingEnabled(ctx?.extensionSettings?.worldbook_organizer)) return;
    if (_initialized) return;
    if (!ctx || typeof document === 'undefined') return;
    const epoch = ++_lifecycleEpoch;
    if (await hasEnabledLegacyGrouping(ctx) || epoch !== _lifecycleEpoch
        || !isEntryGroupingEnabled(getHostContext()?.extensionSettings?.worldbook_organizer)) return;
    await ensureWorldInfoModule();
    if (epoch !== _lifecycleEpoch
        || !isEntryGroupingEnabled(getHostContext()?.extensionSettings?.worldbook_organizer)
        || isLegacyGroupingMounted(ctx)) return;
    _initialized = true;
    getSettings();

    if (document.head) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL(`./style.css?v=${encodeURIComponent(styleVersion)}`, import.meta.url).href;
        document.head.appendChild(link);
        _stylesheet = link;
    }

    bindPanelCallbacks({
        onRevealNativeEditor,
        onNativeDisplayChanged: syncNativeEditorIntegration,
        onSettingsChanged: () => {
            saveSettings();
            syncNativeEditorIntegration();
        },
    });

    await syncAllNativeEntryPoints();
    if (!_initialized || epoch !== _lifecycleEpoch) return;
    if (!isEntryGroupingEnabled(getHostContext()?.extensionSettings?.worldbook_organizer)) {
        stopEntryGrouping();
        return;
    }

    if (typeof window !== 'undefined') {
        window.addEventListener('wbo:panel-theme-changed', syncEntryGroupsTheme);
        if (!_onWboRenamed) {
            _onWboRenamed = (ev) => {
                const oldName = String(ev?.detail?.oldName ?? '').trim();
                const newName = String(ev?.detail?.newName ?? '').trim();
                if (!oldName || !newName) return;
                clearRuntimeBookSnapshots(oldName);
                const settings = getSettings();
                if (migrateSettingsOnWorldRename(settings, oldName, newName)) {
                    saveSettings();
                }
                const liveCtx = getHostContext();
                if (liveCtx?.chatMetadata?.[MODULE_NAME]?.worldName === oldName) {
                    liveCtx.chatMetadata[MODULE_NAME].worldName = newName;
                    if (typeof liveCtx.saveMetadataDebounced === 'function') {
                        try { liveCtx.saveMetadataDebounced(); } catch { /* ignore */ }
                    } else if (typeof liveCtx.saveMetadata === 'function') {
                        try { void liveCtx.saveMetadata(); } catch { /* ignore */ }
                    }
                }
                handleExternalWorldbookRenamed(oldName, newName);
                syncAllNativeEntryPoints();
            };
            window.addEventListener('wbo:worldbook-renamed', _onWboRenamed);
        }

        if (!_onWboDeleted) {
            _onWboDeleted = (ev) => {
                const names = Array.isArray(ev?.detail?.names) ? ev.detail.names : [];
                if (names.length === 0) return;
                const delSet = new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean));
                for (const n of delSet) clearRuntimeBookSnapshots(n);
                const settings = getSettings();
                if (removeDeletedWorldsFromSettings(settings, names)) {
                    saveSettings();
                }
                const liveCtx = getHostContext();
                const boundMetaWorld = String(liveCtx?.chatMetadata?.[MODULE_NAME]?.worldName ?? '').trim();
                if (boundMetaWorld && delSet.has(boundMetaWorld)) {
                    delete liveCtx.chatMetadata[MODULE_NAME];
                    if (typeof liveCtx.saveMetadataDebounced === 'function') {
                        try { liveCtx.saveMetadataDebounced(); } catch { /* ignore */ }
                    } else if (typeof liveCtx.saveMetadata === 'function') {
                        try { void liveCtx.saveMetadata(); } catch { /* ignore */ }
                    }
                }
                handleExternalWorldbookDeleted(names);
                syncAllNativeEntryPoints();
            };
            window.addEventListener('wbo:worldbook-deleted', _onWboDeleted);
        }

        if (!_onWegOpenPanel) {
            _onWegOpenPanel = (ev) => {
                const worldName = String(ev?.detail?.worldName ?? '').trim();
                void openEntryGroupsModal(worldName ? { worldName } : {});
            };
            window.addEventListener('weg:open-panel', _onWegOpenPanel);
        }

        if (!_onWboEntriesUpdated) {
            _onWboEntriesUpdated = (ev) => {
                const worldName = String(ev?.detail?.worldName ?? '').trim();
                if (!worldName) return;
                clearRuntimeBookSnapshots(worldName);
                if (!isEntryGroupsModalOpen()) return;
                if (getCurrentModalWorldName() !== worldName) return;
                clearTimeout(_wboEntriesTimer);
                _wboEntriesTimer = setTimeout(() => {
                    _wboEntriesTimer = null;
                    if (!_initialized || !isEntryGroupsModalOpen()) return;
                    if (getCurrentModalWorldName() !== worldName) return;
                    void handleExternalEntriesUpdated(worldName);
                }, 120);
            };
            window.addEventListener('wbo:entries-updated', _onWboEntriesUpdated);
        }
    }

    const eventSource = ctx.eventSource;
    const et = ctx.eventTypes || ctx.event_types || {};

    syncNativeEditorIntegration();

    const onEditorChange = (event) => {
        if (event.target?.id === 'world_editor_select') scheduleNativeEntrySync();
    };
    const jqDocument = typeof globalThis.jQuery === 'function' ? globalThis.jQuery(document) : null;
    if (jqDocument?.on && jqDocument?.off) {
        // Delegation also receives synthetic change events when the editor select is replaced.
        jqDocument.on('change.wegNativeEntry', '#world_editor_select', onEditorChange);
        _editorChangeCleanup = () => jqDocument.off('change.wegNativeEntry', onEditorChange);
    } else {
        document.addEventListener('change', onEditorChange);
        _editorChangeCleanup = () => document.removeEventListener('change', onEditorChange);
    }

    trackHostEvent(eventSource, et.APP_READY, scheduleNativeEntrySync);
    trackHostEvent(eventSource, et.EXTENSION_SETTINGS_LOADED, scheduleNativeEntrySync);
    trackHostEvent(eventSource, et.WORLDINFO_SETTINGS_UPDATED, () => {
        if (isEntryGroupsModalOpen() && !isWithinSelfWriteWindow()) {
            scheduleOpenModalSync(380);
        }
    });
    trackHostEvent(eventSource, et.WORLDINFO_ENTRIES_LOADED, scheduleNativeEntrySync);
    trackHostEvent(eventSource, et.WORLDINFO_UPDATED, (worldName) => {
        const cleanUpdated = worldName ? String(worldName).trim() : '';
        if (cleanUpdated) clearRuntimeBookSnapshots(cleanUpdated);
        if (isWithinSelfWriteWindow()) return;

        // Follow external script worldbook switches (unless right in the middle of a chat switch!)
        if (Date.now() > _suppressExternalFollowUntil) {
            clearTimeout(_externalFollowTimer);
            _externalFollowTimer = setTimeout(async () => {
                _externalFollowTimer = null;
                if (!_initialized || isWithinSelfWriteWindow() || Date.now() <= _suppressExternalFollowUntil) return;
                await captureExternalWorldbookSwitchForActiveChat(cleanUpdated);
                syncAllNativeEntryPoints();
            }, 460);
        }

        if (!isEntryGroupsModalOpen()) return;
        const openBook = getCurrentModalWorldName();
        if (!cleanUpdated || cleanUpdated === openBook) {
            scheduleOpenModalSync(320);
        }
    });

    trackHostEvent(eventSource, et.MESSAGE_SWIPED, (msgId) => {
        if (Number(msgId) === 0 || msgId === undefined) {
            scheduleChatSaveRouteSync('floor0-swipe', 520);
        }
    });
    trackHostEvent(eventSource, et.CHARACTER_MESSAGE_RENDERED, (msgId) => {
        if (Number(msgId) === 0) {
            scheduleOpenModalSync(480);
        }
    });

    // O(1) metadata restore when switching chat saves (`CHAT_CHANGED`)
    trackHostEvent(eventSource, et.CHAT_CHANGED, () => {
        // Suppress external floor-0 script echo during the first 900ms of a chat switch so our saved route wins!
        _suppressExternalFollowUntil = Date.now() + 900;
        clearTimeout(_externalFollowTimer);
        _externalFollowTimer = null;
        scheduleNativeEntrySync();
        scheduleChatSaveRouteSync('chat-changed', 650);
    });

    // Awaited pre-WorldInfo hook: turns `scene` (NSFW) groups ON/OFF right before prompt assembly!
    trackHostEvent(eventSource, et.GENERATION_AFTER_COMMANDS, async (type, _opts, dryRun) => {
        const epoch = _lifecycleEpoch;
        const res = await syncSceneGroupsBeforeGeneration(type, Boolean(dryRun), { isCurrent: () => _initialized && epoch === _lifecycleEpoch });
        if (!_initialized || epoch !== _lifecycleEpoch) return;
        if (res.changedCount > 0 && isEntryGroupsModalOpen()) {
            void refreshOpenModalBook({ silent: true, reason: 'scene-auto' });
        }
    });

    registerSlashCommand(ctx);
}

export function stopEntryGrouping() {
    _lifecycleEpoch += 1;
    if (!_initialized) return;
    _initialized = false;
    _editorChangeCleanup?.();
    _editorChangeCleanup = null;
    _mountJob?.();
    _mountJob = null;
    _stylesheet?.remove();
    _stylesheet = null;
    clearTimeout(_greetingSyncTimer);
    _greetingSyncTimer = null;
    clearTimeout(_chatSwitchSyncTimer);
    _chatSwitchSyncTimer = null;
    clearTimeout(_externalFollowTimer);
    _externalFollowTimer = null;
    clearTimeout(_wboEntriesTimer);
    _wboEntriesTimer = null;

    stopNativeEditorObserver();

    if (typeof window !== 'undefined') {
        window.removeEventListener('wbo:panel-theme-changed', syncEntryGroupsTheme);
        if (_onWboRenamed) {
            window.removeEventListener('wbo:worldbook-renamed', _onWboRenamed);
            _onWboRenamed = null;
        }
        if (_onWboDeleted) {
            window.removeEventListener('wbo:worldbook-deleted', _onWboDeleted);
            _onWboDeleted = null;
        }
        if (_onWboEntriesUpdated) {
            window.removeEventListener('wbo:entries-updated', _onWboEntriesUpdated);
            _onWboEntriesUpdated = null;
        }
        if (_onWegOpenPanel) {
            window.removeEventListener('weg:open-panel', _onWegOpenPanel);
            _onWegOpenPanel = null;
        }
    }

    const ctx = getHostContext();
    const eventSource = ctx?.eventSource;
    if (eventSource) {
        const removeFn = eventSource.removeListener || eventSource.off;
        if (typeof removeFn === 'function') {
            for (const { event, handler } of _boundHostEvents) {
                try {
                    removeFn.call(eventSource, event, handler);
                } catch {
                    // Ignore
                }
            }
        }
    }
    _boundHostEvents.length = 0;

    clearRuntimeBookSnapshots();
    teardownPanels();
}
