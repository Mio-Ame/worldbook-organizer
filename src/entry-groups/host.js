/**
 * Worldbook Entry Groups — Dual-host adapter for SillyTavern & TauriTavern.
 *
 * Key guarantees:
 * 1. Zero chat-history scanning: `CHAT_CHANGED` reads ONLY `chatMetadata` (~200B, O(1)),
 *    so 100MB+ / multi-thousand-floor chats never incur regex loops or memory spikes.
 * 2. In-save timeline progression (e.g. 18岁 -> 30岁): switching an IF-line group updates
 *    the save's `chatMetadata` stage immediately and is never reverted by floor-0 openings.
 * 3. Pre-WorldInfo scene auto-toggle (`GENERATION_AFTER_COMMANDS`): inspects ONLY the latest
 *    1–2 turn snippets (~1200 chars max) with a zero-I/O fast path on normal turns, enabling
 *    `scene` (e.g. NSFW) groups right before `getWorldInfoPrompt` and cooling down automatically.
 */

import {
    GROUP_MODES,
    MODULE_NAME,
    WORLD_INFO_POSITION,
    applyEntryEditToPayload,
    applyTogglePlanToPayload,
    buildChatProfileFromCurrentState,
    buildGreetingCoordinationIndex,
    buildInitialProfileFromFloorZero,
    computeChatProfileRestorePlan,
    computeGreetingPresetPlan,
    computeGroupTogglePlan,
    evaluateSceneAutoToggle,
    extractEditableEntrySnapshot,
    extractExternalScriptRouteLabel,
    extractWorldbookEntrySummaries,
    findRawEntryInPayload,
    normalizeBookConfig,
    normalizeChatProfile,
    normalizeSettings,
    upsertStoredChatProfile,
} from './core.js';
import { scrollNativeWorldEntry } from '../content-scroll.js';

let _worldInfoModule = null;
let _worldInfoModuleTried = false;
let _selfWriteGuardUntil = 0;

/** @type {Map<string, Record<string, number>>} chatKey -> (groupId -> remainingCooldownTurns) */
const _sceneCooldownByChat = new Map();
/** @type {Map<string, Map<string, boolean>>} worldName -> (uid -> disabled) lightweight state cache */
const _knownEntryDisabledByBook = new Map();

export function getHostContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch {
        return null;
    }
}

export function isTauriTavern() {
    return Boolean(globalThis.__TAURITAVERN__ || globalThis.__TAURI_RUNNING__);
}

export function applyTauriSurface(el, surface) {
    if (!el || !isTauriTavern()) return;
    el.setAttribute('data-tt-mobile-surface', surface);
}

export async function waitForTauriReadyIfPresent() {
    const readyPromise =
        globalThis.__TAURITAVERN__?.ready ??
        globalThis.__TAURITAVERN_MAIN_READY__ ??
        null;
    if (readyPromise && typeof readyPromise.then === 'function') {
        try {
            await readyPromise;
        } catch {
            // Do not block fallback initialization
        }
    }
}

export async function ensureWorldInfoModule() {
    if (_worldInfoModuleTried) return _worldInfoModule;
    _worldInfoModuleTried = true;
    try {
        const url = new URL('/scripts/world-info.js', globalThis.location.href).href;
        _worldInfoModule = await import(/* @vite-ignore */ url);
    } catch {
        _worldInfoModule = null;
    }
    return _worldInfoModule;
}

function buildRequestHeaders() {
    const ctx = getHostContext();
    if (typeof ctx?.getRequestHeaders === 'function') {
        return ctx.getRequestHeaders();
    }
    return { 'Content-Type': 'application/json' };
}

export function emitBridgeEvent(type, detail = {}) {
    try {
        if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent(type, { detail }));
        }
    } catch {
        // Ignore in headless/non-browser runtimes
    }
}

function getSettingsContainer() {
    const ctx = getHostContext();
    return ctx?.extensionSettings || globalThis.extension_settings;
}

export function getNativeGroupingState(worldName) {
    const settings = getSettingsContainer()?.[MODULE_NAME];
    return { config: settings?.books?.[worldName], showButton: settings?.showNativeEntryBtn !== false };
}

export function getSettings() {
    const container = getSettingsContainer();
    if (!container || typeof container !== 'object') {
        return normalizeSettings(null);
    }
    if (!container[MODULE_NAME]) {
        container[MODULE_NAME] = normalizeSettings(null);
    } else {
        const previousVersion = container[MODULE_NAME].version;
        const normalized = normalizeSettings(container[MODULE_NAME]);
        Object.assign(container[MODULE_NAME], normalized);
        if (normalized.version !== previousVersion) getHostContext()?.saveSettingsDebounced?.();
    }
    return container[MODULE_NAME];
}

export function saveSettings() {
    const ctx = getHostContext();
    if (typeof ctx?.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
    emitBridgeEvent('weg:settings-updated', { reason: 'save' });
}

export function isWithinSelfWriteWindow() {
    return Date.now() < _selfWriteGuardUntil;
}

function cacheLightDisabledSnapshot(worldName, summaries) {
    if (!worldName || !Array.isArray(summaries)) return;
    if (_knownEntryDisabledByBook.size > 12 && !_knownEntryDisabledByBook.has(worldName)) {
        const oldest = _knownEntryDisabledByBook.keys().next().value;
        if (oldest !== undefined) _knownEntryDisabledByBook.delete(oldest);
    }
    _knownEntryDisabledByBook.set(
        worldName,
        new Map(summaries.map((s) => [s.uid, Boolean(s.disabled)])),
    );
}

export function clearRuntimeBookSnapshots(worldName = '') {
    if (worldName) {
        _knownEntryDisabledByBook.delete(worldName);
    } else {
        _knownEntryDisabledByBook.clear();
        _sceneCooldownByChat.clear();
    }
}

export function getWorldNames() {
    const ctx = getHostContext();
    let rawList = [];

    if (typeof ctx?.getWorldInfoNames === 'function') {
        const list = ctx.getWorldInfoNames();
        if (Array.isArray(list) && list.length > 0) {
            rawList = list;
        }
    }
    if (rawList.length === 0 && Array.isArray(_worldInfoModule?.world_names) && _worldInfoModule.world_names.length > 0) {
        rawList = _worldInfoModule.world_names;
    }

    const seen = new Set();
    const cleanList = [];
    for (const item of rawList) {
        const name = String(item ?? '').trim();
        if (name && !seen.has(name)) {
            seen.add(name);
            cleanList.push(name);
        }
    }

    if (cleanList.length === 0 && typeof document !== 'undefined') {
        const sel = document.getElementById('world_editor_select') || document.getElementById('world_info');
        if (sel) {
            sel.querySelectorAll('option').forEach((opt) => {
                const t = (opt.textContent || '').trim();
                if (opt.value !== '' && t && !seen.has(t)) {
                    seen.add(t);
                    cleanList.push(t);
                }
            });
        }
    }

    return cleanList;
}

export function getCurrentEditorWorldName() {
    if (typeof document === 'undefined') return null;
    const sel = document.getElementById('world_editor_select');
    if (!sel) return null;
    const selectedOpt = sel.selectedOptions?.[0];
    if (!selectedOpt || selectedOpt.value === '') return null;
    return (selectedOpt.textContent || '').trim() || null;
}

export function getCurrentCharacterPrimaryWorldName() {
    const ctx = getHostContext();
    if (!ctx) return null;

    if (!ctx.groupId && ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '') {
        const ch = ctx.characters?.[Number(ctx.characterId)];
        const charWorld = ch?.data?.extensions?.world;
        if (typeof charWorld === 'string' && charWorld.trim()) {
            return charWorld.trim();
        }
        const wboCached = ctx?.extensionSettings?.worldbook_organizer?.cachedCharBindings?.[ch?.avatar];
        if (typeof wboCached?.primary === 'string' && wboCached.primary.trim()) {
            return wboCached.primary.trim();
        }
    }

    const chatWorld = ctx?.chatMetadata?.world_info;
    if (typeof chatWorld === 'string' && chatWorld.trim()) {
        return chatWorld.trim();
    }

    return null;
}

/**
 * O(1) chat identity lookup — reads ONLY lightweight scalar properties, NEVER iterates `ctx.chat`.
 */
export function getCurrentChatSaveContext() {
    const ctx = getHostContext();
    if (!ctx) return null;

    let rawChatId = '';
    if (typeof ctx.getCurrentChatId === 'function') {
        try {
            rawChatId = String(ctx.getCurrentChatId() ?? '').trim();
        } catch {
            rawChatId = '';
        }
    }
    if (!rawChatId) {
        rawChatId = String(ctx.chatId ?? '').trim();
    }

    let avatarKey = '';
    let characterName = '';
    if (ctx.groupId) {
        avatarKey = `group_${ctx.groupId}`;
        characterName = '群聊';
    } else if (ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '') {
        const ch = ctx.characters?.[Number(ctx.characterId)];
        avatarKey = String(ch?.avatar ?? '').trim();
        characterName = String(ch?.name || ch?.data?.name || '').trim();
        if (!rawChatId && ch?.chat) {
            rawChatId = String(ch.chat).trim();
        }
    }

    if (!rawChatId) return null;

    const primaryWorldName = getCurrentCharacterPrimaryWorldName() || '';
    const floorCount = Array.isArray(ctx.chat) ? ctx.chat.length : 0;

    return {
        chatId: rawChatId,
        chatKey: `${avatarKey || 'chat'}::${rawChatId}`,
        characterName,
        primaryWorldName,
        floorCount,
    };
}

/**
 * O(1) read of the bound route profile for the active chat save.
 */
export function getActiveChatBoundProfile(expectedWorldName = '') {
    const saveCtx = getCurrentChatSaveContext();
    if (!saveCtx) return { saveCtx: null, profile: null };

    const ctx = getHostContext();
    const settings = getSettings();

    const metaProfile = normalizeChatProfile(ctx?.chatMetadata?.[MODULE_NAME]);
    const storedProfile = normalizeChatProfile(settings.chatProfiles?.[saveCtx.chatKey]);
    const candidate = metaProfile || storedProfile || null;

    const cleanExpected = String(expectedWorldName ?? '').trim();
    if (candidate && cleanExpected && candidate.worldName !== cleanExpected) {
        return { saveCtx, profile: null };
    }

    return { saveCtx, profile: candidate };
}

/**
 * Persist a route profile into BOTH `chatMetadata` AND `settings.chatProfiles`.
 */
export function saveActiveChatBoundProfile(rawProfile) {
    const saveCtx = getCurrentChatSaveContext();
    if (!saveCtx) return false;

    const ctx = getHostContext();
    const settings = getSettings();
    const norm = rawProfile ? normalizeChatProfile(rawProfile) : null;

    if (ctx?.chatMetadata && typeof ctx.chatMetadata === 'object') {
        if (norm) {
            ctx.chatMetadata[MODULE_NAME] = norm;
        } else {
            delete ctx.chatMetadata[MODULE_NAME];
        }
        if (typeof ctx.saveMetadataDebounced === 'function') {
            try { ctx.saveMetadataDebounced(); } catch { /* ignore */ }
        } else if (typeof ctx.saveMetadata === 'function') {
            try { void ctx.saveMetadata(); } catch { /* ignore */ }
        }
    }

    upsertStoredChatProfile(settings, saveCtx.chatKey, norm);
    saveSettings();
    return true;
}

export function getPreferredDefaultBook(settings) {
    const names = getWorldNames();
    if (names.length === 0) return '';
    const nameSet = new Set(names);

    const editorBook = getCurrentEditorWorldName();
    if (editorBook && nameSet.has(editorBook)) return editorBook;

    const charBook = getCurrentCharacterPrimaryWorldName();
    if (charBook && nameSet.has(charBook)) return charBook;

    const lastBook = String(settings?.lastOpenedBook ?? '').trim();
    if (lastBook && nameSet.has(lastBook)) return lastBook;

    return names[0];
}

async function fetchWorldInfoUncached(worldName) {
    const clean = String(worldName ?? '').trim();
    if (!clean) return null;

    try {
        const res = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: buildRequestHeaders(),
            body: JSON.stringify({ name: clean }),
        });
        if (res.ok) {
            return await res.json();
        }
    } catch {
        // Fallback below
    }

    try {
        const ctx = getHostContext();
        await ensureWorldInfoModule();
        const loader = ctx?.loadWorldInfo || _worldInfoModule?.loadWorldInfo;
        if (typeof loader === 'function') {
            return await loader(clean);
        }
    } catch {
        // Ignore
    }
    return null;
}

export async function loadWorldbookSummariesUncached(worldName) {
    const clean = String(worldName ?? '').trim();
    if (!clean) return { ok: false, summaries: [], error: '未选择世界书' };

    let payload = await fetchWorldInfoUncached(clean);
    if (!payload || typeof payload !== 'object' || !('entries' in payload)) {
        return { ok: false, summaries: [], error: `无法读取世界书「${clean}」` };
    }

    const summaries = extractWorldbookEntrySummaries(payload);
    payload = null;
    cacheLightDisabledSnapshot(clean, summaries);

    return { ok: true, summaries };
}

export async function loadWorldbookEntryForEditUncached(worldName, uid) {
    const clean = String(worldName ?? '').trim();
    const targetUid = String(uid ?? '').trim();
    if (!clean || !targetUid) {
        return { ok: false, entry: null, error: '缺少目标世界书或条目 UID' };
    }

    let payload = await fetchWorldInfoUncached(clean);
    if (!payload || typeof payload !== 'object' || !('entries' in payload)) {
        payload = null;
        return { ok: false, entry: null, error: `无法读取世界书「${clean}」` };
    }

    const found = findRawEntryInPayload(payload, targetUid);
    if (!found) {
        payload = null;
        return { ok: false, entry: null, error: `未找到条目 #${targetUid}` };
    }

    const entry = extractEditableEntrySnapshot(found.entry, targetUid);
    payload = null;
    return { ok: true, entry };
}

function escapeCssAttr(value) {
    const str = String(value ?? '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(str);
    }
    return str.replace(/["\\]/g, '\\$&');
}

export function syncWorldInfoCacheMap(cache, worldName, updatedPayload, appliedChanges) {
    if (cache instanceof Map && cache.has(worldName)) {
        const cachedObj = cache.get(worldName);
        if (cachedObj && typeof cachedObj === 'object' && cachedObj.entries && typeof cachedObj.entries === 'object') {
            const changeMap = new Map(
                (appliedChanges || []).map((c) => [String(c.uid), Boolean(c.disabled)]),
            );
            for (const [k, entry] of Object.entries(cachedObj.entries)) {
                if (!entry || typeof entry !== 'object') continue;
                const uid = String(entry.uid ?? k);
                if (changeMap.has(uid)) {
                    const nextDisabled = changeMap.get(uid);
                    if ('disable' in entry || !('enabled' in entry)) {
                        entry.disable = nextDisabled;
                    }
                    if ('enabled' in entry) {
                        entry.enabled = !nextDisabled;
                    }
                }
            }
            if (Array.isArray(cachedObj.originalData?.entries)) {
                for (const orig of cachedObj.originalData.entries) {
                    if (!orig || typeof orig !== 'object') continue;
                    const uid = String(orig.uid ?? '');
                    if (changeMap.has(uid)) {
                        orig.enabled = !changeMap.get(uid);
                    }
                }
            }
            cache.set(worldName, cachedObj);
        } else {
            cache.set(worldName, updatedPayload);
        }
        return true;
    }

    if (cache && typeof cache === 'object' && !(cache instanceof Map) && Object.hasOwn(cache, worldName)) {
        cache[worldName] = updatedPayload;
        return true;
    }

    return false;
}

function patchCachedWorldObjSingleEntry(cachedObj, targetUid, updatedEntry) {
    if (!cachedObj || typeof cachedObj !== 'object' || !cachedObj.entries || typeof cachedObj.entries !== 'object') {
        return false;
    }
    const found = findRawEntryInPayload(cachedObj, targetUid);
    if (!found) return false;

    cachedObj.entries[found.keyOrIndex] = {
        ...found.entry,
        ...structuredClone(updatedEntry),
    };

    if (Array.isArray(cachedObj.originalData?.entries)) {
        const orig = cachedObj.originalData.entries.find(
            (item) => item && String(item.uid ?? item.id ?? '').trim() === targetUid,
        );
        if (orig && typeof orig === 'object') {
            orig.comment = updatedEntry.comment ?? orig.comment;
            const nextDisabled = 'disable' in updatedEntry
                ? Boolean(updatedEntry.disable)
                : ('enabled' in updatedEntry ? !updatedEntry.enabled : false);
            orig.enabled = !nextDisabled;
            if ('constant' in updatedEntry) orig.constant = Boolean(updatedEntry.constant);
            if ('selective' in updatedEntry) orig.selective = Boolean(updatedEntry.selective);
            if (Array.isArray(updatedEntry.key)) orig.keys = [...updatedEntry.key];
            if (Array.isArray(updatedEntry.keysecondary)) orig.secondary_keys = [...updatedEntry.keysecondary];
            if ('order' in updatedEntry) orig.insertion_order = updatedEntry.order;
            if ('content' in updatedEntry) orig.content = updatedEntry.content;
            if ('position' in updatedEntry) {
                orig.position = updatedEntry.position === WORLD_INFO_POSITION.BEFORE
                    ? 'before_char'
                    : (updatedEntry.position === WORLD_INFO_POSITION.AFTER ? 'after_char' : updatedEntry.position);
            }
            if (orig.extensions && typeof orig.extensions === 'object') {
                if ('position' in updatedEntry) orig.extensions.position = updatedEntry.position;
                if ('depth' in updatedEntry) orig.extensions.depth = updatedEntry.depth;
                if ('vectorized' in updatedEntry) orig.extensions.vectorized = Boolean(updatedEntry.vectorized);
                if ('role' in updatedEntry && orig.extensions.role == null) orig.extensions.role = updatedEntry.role;
            }
        }
    }

    return true;
}

export function syncWorldInfoCacheEntry(cache, worldName, uid, updatedEntry) {
    const clean = String(worldName ?? '').trim();
    const targetUid = String(uid ?? '').trim();
    if (!clean || !targetUid || !updatedEntry || typeof updatedEntry !== 'object') return false;

    if (cache instanceof Map && cache.has(clean)) {
        const cachedObj = cache.get(clean);
        if (!patchCachedWorldObjSingleEntry(cachedObj, targetUid, updatedEntry)) {
            return false;
        }
        cache.set(clean, cachedObj);
        return true;
    }

    if (cache && typeof cache === 'object' && !(cache instanceof Map) && Object.hasOwn(cache, clean)) {
        return patchCachedWorldObjSingleEntry(cache[clean], targetUid, updatedEntry);
    }

    return false;
}

export function syncNativeEditorDomFallback(listEl, appliedChanges) {
    if (!listEl || !Array.isArray(appliedChanges)) return 0;
    let updated = 0;
    for (const { uid, disabled } of appliedChanges) {
        const row = listEl.querySelector(`.world_entry[uid="${escapeCssAttr(String(uid))}"]`);
        if (!row) continue;
        const nextDisabled = Boolean(disabled);
        row.classList.toggle('disabledWIEntry', nextDisabled);
        const killSwitch = row.querySelector('.killSwitch');
        if (killSwitch) {
            killSwitch.classList.toggle('fa-toggle-off', nextDisabled);
            killSwitch.classList.toggle('fa-toggle-on', !nextDisabled);
            killSwitch.classList.remove('disabled');
        }
        updated += 1;
    }
    return updated;
}

async function syncHostCacheAndOpenEditorIfPresent(worldName, updatedPayload, appliedChanges) {
    await ensureWorldInfoModule();
    const cache = _worldInfoModule?.worldInfoCache;
    const wasInCache = syncWorldInfoCacheMap(cache, worldName, updatedPayload, appliedChanges);

    if (getCurrentEditorWorldName() === worldName && typeof document !== 'undefined') {
        if (typeof _worldInfoModule?.reloadEditor === 'function' && wasInCache) {
            try {
                _worldInfoModule.reloadEditor(worldName);
                return;
            } catch {
                // Fall back to lightweight DOM class sync below
            }
        }

        const listEl = document.getElementById('world_popup_entries_list');
        syncNativeEditorDomFallback(listEl, appliedChanges);
    }
}

export async function applyWorldbookTogglePlan(worldName, togglePlan) {
    const clean = String(worldName ?? '').trim();
    if (!clean) {
        return { ok: false, changedCount: 0, appliedChanges: [], summaries: [], error: '未选择世界书' };
    }

    let payload = await fetchWorldInfoUncached(clean);
    if (!payload || typeof payload !== 'object' || !('entries' in payload)) {
        return { ok: false, changedCount: 0, appliedChanges: [], summaries: [], error: `无法读取世界书「${clean}」` };
    }

    const { changedCount, appliedChanges } = applyTogglePlanToPayload(payload, togglePlan);
    if (changedCount === 0) {
        const summaries = extractWorldbookEntrySummaries(payload);
        payload = null;
        cacheLightDisabledSnapshot(clean, summaries);
        return { ok: true, changedCount: 0, appliedChanges: [], summaries };
    }

    _selfWriteGuardUntil = Date.now() + 1200;

    try {
        const res = await fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: buildRequestHeaders(),
            body: JSON.stringify({ name: clean, data: payload }),
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
    } catch (err) {
        payload = null;
        return {
            ok: false,
            changedCount: 0,
            appliedChanges: [],
            summaries: [],
            error: `保存世界书失败：${err?.message || err}`,
        };
    }

    await syncHostCacheAndOpenEditorIfPresent(clean, payload, appliedChanges);

    const summaries = extractWorldbookEntrySummaries(payload);
    payload = null;
    cacheLightDisabledSnapshot(clean, summaries);

    emitBridgeEvent('weg:entries-toggled', {
        worldName: clean,
        changedCount,
        changes: appliedChanges,
    });

    return {
        ok: true,
        changedCount,
        appliedChanges,
        summaries,
    };
}

export async function saveWorldbookEntryEdit(worldName, uid, editPatch = {}) {
    const clean = String(worldName ?? '').trim();
    const targetUid = String(uid ?? '').trim();
    if (!clean || !targetUid) {
        return { ok: false, error: '未选择世界书或条目' };
    }

    let payload = await fetchWorldInfoUncached(clean);
    if (!payload || typeof payload !== 'object' || !('entries' in payload)) {
        payload = null;
        return { ok: false, error: `无法读取世界书「${clean}」` };
    }

    const editRes = applyEntryEditToPayload(payload, targetUid, editPatch);
    if (!editRes.ok) {
        payload = null;
        return { ok: false, error: editRes.error || '未找到目标条目' };
    }

    _selfWriteGuardUntil = Date.now() + 1200;

    try {
        const res = await fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: buildRequestHeaders(),
            body: JSON.stringify({ name: clean, data: payload }),
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
    } catch (err) {
        payload = null;
        return {
            ok: false,
            error: `保存条目失败：${err?.message || err}`,
        };
    }

    await ensureWorldInfoModule();
    const cache = _worldInfoModule?.worldInfoCache;
    const wasInCache = syncWorldInfoCacheEntry(cache, clean, targetUid, editRes.updatedEntry);

    if (getCurrentEditorWorldName() === clean && typeof document !== 'undefined') {
        let reloaded = false;
        if (wasInCache && typeof _worldInfoModule?.reloadEditor === 'function') {
            try {
                _worldInfoModule.reloadEditor(clean);
                reloaded = true;
            } catch {
                // Fall back to lightweight DOM class sync below
            }
        }
        if (!reloaded && editRes.disabledChanged) {
            const listEl = document.getElementById('world_popup_entries_list');
            syncNativeEditorDomFallback(listEl, [{ uid: targetUid, disabled: editRes.nextDisabled }]);
        }
    }

    const summaries = extractWorldbookEntrySummaries(payload);
    const entry = extractEditableEntrySnapshot(editRes.updatedEntry, targetUid);
    payload = null;
    cacheLightDisabledSnapshot(clean, summaries);

    emitBridgeEvent('weg:entry-saved', {
        worldName: clean,
        uid: targetUid,
        comment: entry.comment,
        disabled: Boolean(editRes.nextDisabled),
    });

    if (editRes.disabledChanged) {
        emitBridgeEvent('weg:entries-toggled', {
            worldName: clean,
            changedCount: 1,
            changes: [{ uid: targetUid, disabled: Boolean(editRes.nextDisabled) }],
        });
    }

    return {
        ok: true,
        entry,
        summaries,
        disabledChanged: editRes.disabledChanged,
    };
}

export async function resolveGreetingCoordinationForBook(worldName, { allowFetchShallow = false } = {}) {
    const clean = String(worldName ?? '').trim();
    if (!clean) return { characterName: '', greetingIndex: null };

    const ctx = getHostContext();
    const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];

    if (ctx && !ctx.groupId && ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '') {
        const activeChar = characters[Number(ctx.characterId)];
        const activeBook = getCurrentCharacterPrimaryWorldName();
        if (activeChar && activeBook === clean) {
            const msg0 = ctx.chat?.[0];
            const swipes = Array.isArray(msg0?.swipes) && msg0.swipes.length > 0 ? msg0.swipes : null;
            const currentSwipeId = Number.isInteger(msg0?.swipe_id) ? msg0.swipe_id : null;
            const idx = buildGreetingCoordinationIndex({
                swipes,
                firstMes: activeChar.first_mes || activeChar.data?.first_mes || '',
                alternateGreetings: activeChar.data?.alternate_greetings || [],
                currentSwipeId,
            });
            return {
                characterName: String(activeChar.name || activeChar.data?.name || '').trim(),
                greetingIndex: idx,
            };
        }
    }

    const matchedLoaded = characters.find(
        (ch) => ch && !ch.shallow && String(ch?.data?.extensions?.world ?? '').trim() === clean,
    );
    if (matchedLoaded) {
        const idx = buildGreetingCoordinationIndex({
            firstMes: matchedLoaded.first_mes || matchedLoaded.data?.first_mes || '',
            alternateGreetings: matchedLoaded.data?.alternate_greetings || [],
            currentSwipeId: null,
        });
        return {
            characterName: String(matchedLoaded.name || matchedLoaded.data?.name || '').trim(),
            greetingIndex: idx,
        };
    }

    if (allowFetchShallow) {
        const wboBindings = ctx?.extensionSettings?.worldbook_organizer?.cachedCharBindings;
        let targetAvatar = null;
        if (wboBindings && typeof wboBindings === 'object') {
            for (const [avatar, meta] of Object.entries(wboBindings)) {
                if (meta?.primary === clean) {
                    targetAvatar = avatar;
                    break;
                }
            }
        }
        if (targetAvatar) {
            try {
                const res = await fetch('/api/characters/get', {
                    method: 'POST',
                    headers: buildRequestHeaders(),
                    body: JSON.stringify({ avatar_url: targetAvatar }),
                });
                if (res.ok) {
                    let fullChar = await res.json();
                    const idx = buildGreetingCoordinationIndex({
                        firstMes: fullChar?.first_mes || fullChar?.data?.first_mes || '',
                        alternateGreetings: fullChar?.data?.alternate_greetings || [],
                        currentSwipeId: null,
                    });
                    const charName = String(fullChar?.name || fullChar?.data?.name || '').trim();
                    fullChar = null;
                    return { characterName: charName, greetingIndex: idx };
                }
            } catch {
                // Ignore
            }
        }
    }

    return { characterName: '', greetingIndex: null };
}

/**
 * Pure O(1) metadata-driven save route restoration!
 * - NEVER scans or iterates multi-floor chat history (100% safe on 500MB+ chat files).
 * - Only inspects `chat[0]` header (~1.2KB slice) when `chat.length === 1` (freshly created 1-message save).
 * - Once bound in `chatMetadata` (e.g. `18岁线`, or later switched to `30岁线` mid-save), restores `chatMetadata` directly!
 */
export async function syncWorldbookForActiveChat({ reason = 'chat-changed', silentToast = false } = {}) {
    const settings = getSettings();
    if (reason !== 'manual' && settings.autoSwitchOnChatChange === false) {
        return { synced: false, changedCount: 0, routeLabel: '', worldName: '' };
    }

    const ctx = getHostContext();
    const saveCtx = getCurrentChatSaveContext();
    if (!ctx || !saveCtx || !saveCtx.primaryWorldName) {
        return { synced: false, changedCount: 0, routeLabel: '', worldName: '' };
    }

    const worldName = saveCtx.primaryWorldName;
    const bookConfig = normalizeBookConfig(settings.books?.[worldName]);
    let { profile } = getActiveChatBoundProfile(worldName);
    if (reason !== 'manual' && !settings.books?.[worldName] && !profile) {
        return { synced: false, changedCount: 0, routeLabel: '', worldName };
    }

    // ONLY inspect floor 0 header when the chat is a brand-new 1-floor opening (`floorCount === 1`)!
    if (saveCtx.floorCount === 1 && (!profile || reason === 'floor0-swipe')) {
        const floorZeroHeader = String(ctx.chat?.[0]?.mes ?? '').slice(0, 1200);
        if (floorZeroHeader.includes('<!--')) {
            const { greetingIndex } = await resolveGreetingCoordinationForBook(worldName, { allowFetchShallow: false });
            const initial = buildInitialProfileFromFloorZero({
                worldName,
                floorZeroMes: floorZeroHeader,
                greetingIndex,
                bookConfig,
            });
            if (initial) {
                profile = initial;
                saveActiveChatBoundProfile(profile);
            }
        }
    }

    if (!profile) {
        return { synced: false, changedCount: 0, routeLabel: '', worldName };
    }

    const readRes = await loadWorldbookSummariesUncached(worldName);
    if (!readRes.ok || readRes.summaries.length === 0) {
        return { synced: false, changedCount: 0, routeLabel: profile.routeLabel, worldName };
    }

    const restorePlan = computeChatProfileRestorePlan(readRes.summaries, bookConfig, profile);
    if (restorePlan.size === 0) {
        return { synced: true, changedCount: 0, routeLabel: profile.routeLabel, worldName };
    }

    const writeRes = await applyWorldbookTogglePlan(worldName, restorePlan);
    if (writeRes.ok && writeRes.changedCount > 0 && !silentToast) {
        showToast('info', `已按当前存档切换至「${profile.routeLabel}」`);
    }

    return {
        synced: Boolean(writeRes.ok),
        changedCount: writeRes.changedCount || 0,
        routeLabel: profile.routeLabel,
        worldName,
    };
}

/**
 * Switch a named group (e.g. `/weg 30岁线`) directly in the active character's primary worldbook
 * and update the active chat save's stage binding (supports instant 18岁 -> 30岁 mid-save jump!).
 *
 * @param {string} groupNameQuery
 * @returns {Promise<{ matched: boolean, groupName?: string, error?: string }>}
 */
export async function switchNamedGroupInActiveChat(groupNameQuery) {
    const query = String(groupNameQuery ?? '').trim();
    if (!query) return { matched: false };

    const worldName = getCurrentCharacterPrimaryWorldName();
    if (!worldName) return { matched: false };

    const settings = getSettings();
    const bookCfg = normalizeBookConfig(settings.books?.[worldName]);
    if (bookCfg.groups.length === 0) return { matched: false };

    const targetGrp = bookCfg.groups.find((g) => g.name === query)
        || bookCfg.groups.find((g) => g.name.toLowerCase() === query.toLowerCase());
    if (!targetGrp) return { matched: false };

    const readRes = await loadWorldbookSummariesUncached(worldName);
    if (!readRes.ok) return { matched: true, groupName: targetGrp.name, error: readRes.error };

    const plan = computeGroupTogglePlan(readRes.summaries, bookCfg, targetGrp.id, true);
    let latestSummaries = readRes.summaries;
    if (plan.size > 0) {
        const writeRes = await applyWorldbookTogglePlan(worldName, plan);
        if (!writeRes.ok) return { matched: true, groupName: targetGrp.name, error: writeRes.error };
        latestSummaries = writeRes.summaries;
    }

    recordStateIntoActiveChatIfMatching(worldName, latestSummaries, {
        preferredIfGroupId: targetGrp.mode === GROUP_MODES.IF_LINE ? targetGrp.id : '',
        customLabel: targetGrp.name,
        force: true,
    });

    showToast('success', `已切换本档至「${targetGrp.name}」`);
    return { matched: true, groupName: targetGrp.name };
}

/**
 * Pre-WorldInfo generation hook (`GENERATION_AFTER_COMMANDS`):
 * Automatically enables `scene` groups (e.g. NSFW lore) right before SillyTavern calls
 * `getWorldInfoPrompt()` when recent dialogue hits scene cues, and automatically turns them
 * back OFF once the conversation returns to normal plot!
 *
 * Fast-path: 0ms & 0 I/O when no `scene` groups exist or when state requires no transition!
 */
export async function syncSceneGroupsBeforeGeneration(type, dryRun = false) {
    if (dryRun || type === 'quiet') return { changedCount: 0 };

    const settings = getSettings();
    if (settings.enableSceneAutoToggle === false) return { changedCount: 0 };

    const ctx = getHostContext();
    const saveCtx = getCurrentChatSaveContext();
    if (!ctx || !saveCtx || !saveCtx.primaryWorldName) return { changedCount: 0 };

    const worldName = saveCtx.primaryWorldName;
    const bookConfig = normalizeBookConfig(settings.books?.[worldName]);
    if (!bookConfig.groups.some((g) => g.mode === GROUP_MODES.SCENE)) {
        return { changedCount: 0 };
    }

    // Read ONLY the tail ~600 chars of the latest 2 messages (never touches earlier chat history!)
    const chatArr = Array.isArray(ctx.chat) ? ctx.chat : [];
    const tailCount = Math.min(2, chatArr.length);
    const snippets = [];
    for (let i = chatArr.length - tailCount; i < chatArr.length; i += 1) {
        const raw = String(chatArr[i]?.mes ?? '');
        if (raw) snippets.push(raw.slice(-600));
    }
    const recentText = snippets.join('\n');

    // Use lightweight in-memory disabled snapshot (or `worldInfoCache`) first to avoid `fetch` on idle turns!
    await ensureWorldInfoModule();
    let probeEntries = null;
    const hostCache = _worldInfoModule?.worldInfoCache;
    if (hostCache instanceof Map && hostCache.has(worldName)) {
        const cachedPayload = hostCache.get(worldName);
        if (cachedPayload?.entries) {
            probeEntries = Object.entries(cachedPayload.entries).map(([k, e]) => ({
                uid: String(e?.uid ?? k),
                disabled: Boolean(e?.disable),
            }));
        }
    } else if (_knownEntryDisabledByBook.has(worldName)) {
        const knownMap = _knownEntryDisabledByBook.get(worldName);
        probeEntries = [...knownMap.entries()].map(([uid, disabled]) => ({ uid, disabled }));
    }

    if (!probeEntries) {
        const readRes = await loadWorldbookSummariesUncached(worldName);
        if (!readRes.ok) return { changedCount: 0 };
        probeEntries = readRes.summaries;
    }

    const prevCooldown = _sceneCooldownByChat.get(saveCtx.chatKey) || {};
    const evalRes = evaluateSceneAutoToggle({
        entries: probeEntries,
        bookConfig,
        recentText,
        cooldownByGroupId: prevCooldown,
    });
    _sceneCooldownByChat.set(saveCtx.chatKey, evalRes.nextCooldownByGroupId);

    if (evalRes.togglePlan.size === 0) {
        return { changedCount: 0 };
    }

    const writeRes = await applyWorldbookTogglePlan(worldName, evalRes.togglePlan);
    if (writeRes.ok && writeRes.changedCount > 0) {
        if (evalRes.activatedGroups.length > 0) {
            showToast('info', `检测到剧情信号，已临时开启「${evalRes.activatedGroups.join('、')}」`);
        } else if (evalRes.deactivatedGroups.length > 0) {
            showToast('info', `剧情已恢复日常，已自动收起「${evalRes.deactivatedGroups.join('、')}」`);
        }
    }

    return {
        changedCount: writeRes.changedCount || 0,
        activatedGroups: evalRes.activatedGroups,
        deactivatedGroups: evalRes.deactivatedGroups,
    };
}

export function recordStateIntoActiveChatIfMatching(worldName, summaries, opts = {}) {
    const cleanWorld = String(worldName ?? '').trim();
    if (!cleanWorld) return null;

    const settings = getSettings();
    if (!opts.force && settings.autoSwitchOnChatChange === false) return null;

    const ctx = getHostContext();
    const saveCtx = getCurrentChatSaveContext();
    if (!saveCtx || saveCtx.primaryWorldName !== cleanWorld) return null;

    const bookConfig = normalizeBookConfig(settings.books?.[cleanWorld]);
    const externalRouteHint = extractExternalScriptRouteLabel(ctx?.chatMetadata);
    const profile = buildChatProfileFromCurrentState(cleanWorld, summaries, bookConfig, {
        ...opts,
        externalRouteHint,
    });
    if (!profile) return null;

    saveActiveChatBoundProfile(profile);
    return profile;
}

/**
 * Automatically follow & snapshot worldbook switches made by any author's script
 * (e.g. `setLorebookEntries` triggered by custom route buttons or opening managers) into the
 * active chat save's `chatMetadata` so switching saves later restores all layers seamlessly!
 */
export async function captureExternalWorldbookSwitchForActiveChat(worldName = '') {
    const settings = getSettings();
    if (settings.autoSwitchOnChatChange === false || isWithinSelfWriteWindow()) return null;

    const saveCtx = getCurrentChatSaveContext();
    if (!saveCtx || !saveCtx.primaryWorldName) return null;
    if (worldName && String(worldName).trim() !== saveCtx.primaryWorldName) return null;
    if (!settings.books?.[saveCtx.primaryWorldName] && !getActiveChatBoundProfile(saveCtx.primaryWorldName).profile) return null;

    const readRes = await loadWorldbookSummariesUncached(saveCtx.primaryWorldName);
    if (!readRes.ok || readRes.summaries.length === 0) return null;

    return recordStateIntoActiveChatIfMatching(saveCtx.primaryWorldName, readRes.summaries);
}

/**
 * Apply a character card's greeting preset (`<!-- lore / exclude -->`) in 1 single disk write
 * and lock the resulting multi-group entry combination onto the active chat save!
 */
export async function applyGreetingPresetToWorldbook(worldName, greetingIndex, swipeIndex) {
    const cleanWorld = String(worldName ?? '').trim();
    if (!cleanWorld || !greetingIndex) {
        return { ok: false, error: '缺少开场白联动方案数据' };
    }

    const readRes = await loadWorldbookSummariesUncached(cleanWorld);
    if (!readRes.ok) {
        return { ok: false, error: readRes.error };
    }

    const preset = computeGreetingPresetPlan(readRes.summaries, greetingIndex, swipeIndex);
    if (!preset) {
        return { ok: false, error: '该开场白未配置世界书联动标签' };
    }

    const writeRes = await applyWorldbookTogglePlan(cleanWorld, preset.plan);
    if (!writeRes.ok) {
        return { ok: false, error: writeRes.error };
    }

    recordStateIntoActiveChatIfMatching(cleanWorld, writeRes.summaries, {
        customLabel: preset.routeLabel,
        force: true,
    });

    return {
        ok: true,
        changedCount: writeRes.changedCount,
        routeLabel: preset.routeLabel,
        summaries: writeRes.summaries,
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(predicate, { timeoutMs = 1200, intervalMs = 80 } = {}) {
    const start = Date.now();
    while (true) {
        const val = predicate();
        if (val) return val;
        if (Date.now() - start >= timeoutMs) return null;
        await sleep(intervalMs);
    }
}

export async function locateEntryInNativeEditor(worldName, uid, entryTitle = '', opts = {}) {
    const cleanWorld = String(worldName ?? '').trim();
    const uidStr = String(uid ?? '').trim();
    if (!cleanWorld || !uidStr || typeof document === 'undefined') return false;

    const {
        initialWaitMs = 160,
        searchDebounceMs = 420,
        pollIntervalMs = 80,
        pollTimeoutMs = 600,
        pageWaitMs = 120,
    } = opts && typeof opts === 'object' ? opts : {};
    const initialListTimeoutMs = typeof opts?.pollTimeoutMs === 'number' ? opts.pollTimeoutMs : 800;

    const rawHint = String(entryTitle ?? '').trim();
    const searchTerm = (!rawHint || /^未命名条目 #\d+$/.test(rawHint)) ? uidStr : rawHint;

    const findEntryEl = () => document.getElementById('world_popup_entries_list')
        ?.querySelector?.(`.world_entry[uid="${escapeCssAttr(uidStr)}"]`) || null;
    const highlightElement = (entryEl) => {
        scrollNativeWorldEntry(entryEl);
        entryEl.classList?.remove('weg-entry-locate-flash');
        void entryEl.offsetWidth;
        entryEl.classList?.add('weg-entry-locate-flash');
        setTimeout(() => entryEl.classList?.remove('weg-entry-locate-flash'), 2000);
    };

    const nativeApi = globalThis.__TAURITAVERN__?.api?.worldInfo;
    if (typeof nativeApi?.openEntry === 'function') {
        const drawer = document.getElementById('WorldInfo');
        const page = document.scrollingElement;
        const drawerTop = drawer?.scrollTop;
        const pageTop = page?.scrollTop;
        try {
            const result = await nativeApi.openEntry({ world: cleanWorld, uid: uidStr });
            if (result?.opened) {
                const entry = getCurrentEditorWorldName() === cleanWorld ? findEntryEl() : null;
                if (entry) {
                    if (drawer && drawer.scrollTop !== drawerTop) drawer.scrollTop = drawerTop;
                    if (page && page.scrollTop !== pageTop) page.scrollTop = pageTop;
                    highlightElement(entry);
                }
                return true;
            }
        } catch {
            // Older hosts can still use the editor's DOM navigation.
        }
    }

    const ctx = getHostContext();
    await ensureWorldInfoModule();

    const drawer = document.getElementById('WorldInfo');
    if (drawer && drawer.classList?.contains('closedDrawer')) {
        const icon = document.querySelector('#WI-SP-button .drawer-icon');
        if (icon && typeof icon.click === 'function') icon.click();
    }

    const selectEl = document.getElementById('world_editor_select');
    if (!selectEl) return false;

    const et = ctx?.eventTypes || ctx?.event_types || {};
    if (ctx?.eventSource && et.WORLDINFO_ENTRIES_LOADED && typeof ctx.eventSource.emit === 'function') {
        try {
            ctx.eventSource.emit(et.WORLDINFO_ENTRIES_LOADED, cleanWorld);
        } catch {
            // Non-fatal
        }
    }

    let targetOpt = Array.from(selectEl.querySelectorAll('option')).find(
        (opt) => opt.value !== '' && (opt.textContent || '').trim() === cleanWorld,
    );

    if (!targetOpt) {
        const allNames = getWorldNames();
        const worldIdx = allNames.indexOf(cleanWorld);
        if (worldIdx >= 0) {
            const tempOpt = document.createElement('option');
            tempOpt.value = String(worldIdx);
            tempOpt.textContent = cleanWorld;
            selectEl.appendChild(tempOpt);
            targetOpt = tempOpt;
        }
    }

    if (!targetOpt) return false;

    if (getCurrentEditorWorldName() !== cleanWorld) {
        const $ = globalThis.jQuery;
        if ($) {
            $(selectEl).val(targetOpt.value).trigger('change');
        } else {
            selectEl.value = targetOpt.value;
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    const isInputLike = (el) => Boolean(
        el && typeof el === 'object'
        && typeof el.value === 'string'
        && typeof el.dispatchEvent === 'function'
        && ((typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement) || el.tagName === 'INPUT'),
    );

    await sleep(initialWaitMs);
    await waitForCondition(() => {
        if (findEntryEl()) return true;
        const list = document.getElementById('world_popup_entries_list');
        return Boolean(list && list.children && list.children.length > 0);
    }, { timeoutMs: initialListTimeoutMs, intervalMs: pollIntervalMs });

    let found = findEntryEl();
    if (found) {
        highlightElement(found);
        return true;
    }

    const searchInputEl = document.getElementById('world_info_search');
    const searchInput = isInputLike(searchInputEl) ? searchInputEl : null;

    // Step 1: Clear any pre-existing search filter first so it never blocks target search or pagination
    if (searchInput && searchInput.value.trim() !== '') {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(searchDebounceMs);
        found = await waitForCondition(findEntryEl, { timeoutMs: pollTimeoutMs, intervalMs: pollIntervalMs });
        if (found) {
            highlightElement(found);
            return true;
        }
    }

    // Step 2: Search using rawComment / trigger key / UID
    if (searchInput && searchTerm) {
        searchInput.value = searchTerm;
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(searchDebounceMs);
        found = await waitForCondition(findEntryEl, { timeoutMs: pollTimeoutMs, intervalMs: pollIntervalMs });
        if (found) {
            highlightElement(found);
            return true;
        }
    }

    // Unconditionally clear non-empty search before Step 3 pagination (even if unrelated entries matched on page 1)
    if (searchInput && searchInput.value.trim() !== '') {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(searchDebounceMs);
        found = await waitForCondition(findEntryEl, { timeoutMs: pollTimeoutMs, intervalMs: pollIntervalMs });
        if (found) {
            highlightElement(found);
            return true;
        }
    }

    // Step 3: Traverse `#world_info_pagination` pages for >25-entry worldbooks
    const pagEl = document.getElementById('world_info_pagination');
    if (pagEl) {
        const $ = globalThis.jQuery;
        let usedJqPagination = false;
        if (typeof $ === 'function') {
            try {
                const $pag = $(pagEl);
                if ($pag && typeof $pag.pagination === 'function') {
                    const totalPages = Number($pag.pagination('getTotalPage')) || 0;
                    const currentPage = Number($pag.pagination('getCurrentPageNum')) || 1;
                    if (totalPages > 1) {
                        usedJqPagination = true;
                        const maxPages = Math.min(totalPages, 25);
                        for (let page = 1; page <= maxPages; page += 1) {
                            if (page === currentPage) continue;
                            $pag.pagination('go', page);
                            await sleep(pageWaitMs);
                            found = await waitForCondition(findEntryEl, { timeoutMs: pollTimeoutMs, intervalMs: pollIntervalMs });
                            if (found) {
                                highlightElement(found);
                                return true;
                            }
                        }
                    }
                }
            } catch {
                // Fall back to clicking next page button below
            }
        }

        if (!usedJqPagination) {
            const firstBtn = pagEl.querySelector?.('.paginationjs-first:not(.disabled) a')
                || pagEl.querySelector?.('.paginationjs-first:not(.disabled)')
                || pagEl.querySelector?.('.paginationjs-page[data-num="1"]:not(.active):not(.disabled) a')
                || pagEl.querySelector?.('.paginationjs-page[data-num="1"]:not(.active):not(.disabled)');
            if (firstBtn && typeof firstBtn.click === 'function') {
                firstBtn.click();
                await sleep(pageWaitMs);
                found = await waitForCondition(findEntryEl, { timeoutMs: pollTimeoutMs, intervalMs: pollIntervalMs });
                if (found) {
                    highlightElement(found);
                    return true;
                }
            } else {
                for (let step = 0; step < 24; step += 1) {
                    const prevBtn = pagEl.querySelector?.('.paginationjs-prev:not(.disabled) a')
                        || pagEl.querySelector?.('.paginationjs-prev:not(.disabled)');
                    if (!prevBtn || typeof prevBtn.click !== 'function') break;
                    prevBtn.click();
                    await sleep(pageWaitMs);
                    found = await waitForCondition(findEntryEl, { timeoutMs: pollTimeoutMs, intervalMs: pollIntervalMs });
                    if (found) {
                        highlightElement(found);
                        return true;
                    }
                }
            }

            for (let step = 0; step < 24; step += 1) {
                const nextBtn = pagEl.querySelector?.('.paginationjs-next:not(.disabled) a')
                    || pagEl.querySelector?.('.paginationjs-next:not(.disabled)');
                if (!nextBtn || typeof nextBtn.click !== 'function') break;
                nextBtn.click();
                await sleep(pageWaitMs);
                found = await waitForCondition(findEntryEl, { timeoutMs: pollTimeoutMs, intervalMs: pollIntervalMs });
                if (found) {
                    highlightElement(found);
                    return true;
                }
            }
        }
    }

    return false;
}

export async function copyTextToClipboard(text) {
    const content = String(text ?? '');
    if (!content) return false;
    try {
        if (globalThis.navigator?.clipboard?.writeText) {
            await globalThis.navigator.clipboard.writeText(content);
            return true;
        }
    } catch {
        // Fallback below
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = content;
        ta.setAttribute('readonly', 'true');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return Boolean(ok);
    } catch {
        return false;
    }
}

export function detectHostColorScheme() {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return 'dark';
    try {
        const probe = document.getElementById('world_popup') || document.getElementById('WorldInfo') || document.body;
        const style = probe ? getComputedStyle(probe) : null;
        if (style) {
            const rawBg = style.backgroundColor || '';
            const bgMatch = rawBg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
            if (bgMatch) {
                const alpha = bgMatch[4] === undefined ? 1 : Number(bgMatch[4]);
                if (alpha > 0.05) {
                    const r = Number(bgMatch[1]);
                    const g = Number(bgMatch[2]);
                    const b = Number(bgMatch[3]);
                    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                    if (luminance > 0.56) return 'light';
                    if (luminance < 0.44) return 'dark';
                }
            }
            const rawFg = style.color || '';
            const fgMatch = rawFg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
            if (fgMatch) {
                const fgAlpha = fgMatch[4] === undefined ? 1 : Number(fgMatch[4]);
                if (fgAlpha > 0.05) {
                    const r = Number(fgMatch[1]);
                    const g = Number(fgMatch[2]);
                    const b = Number(fgMatch[3]);
                    const fgLuminance = 0.299 * r + 0.587 * g + 0.114 * b;
                    return fgLuminance < 140 ? 'light' : 'dark';
                }
            }
        }
    } catch {
        // Ignore
    }
    if (globalThis.matchMedia?.('(prefers-color-scheme: light)')?.matches) {
        return 'light';
    }
    return 'dark';
}

export function showToast(type, message) {
    const toastr = globalThis.toastr;
    if (toastr && typeof toastr[type] === 'function') {
        toastr[type](message, '世界书条目分组');
    } else {
        console.log(`[WorldbookEntryGroups][${type}] ${message}`);
    }
}
