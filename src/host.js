/**
 * Worldbook Organizer — Dual-host adapter for SillyTavern & TauriTavern.
 *
 * Performance & safety rules:
 * - Zero polling, zero periodic disk scanning.
 * - Reads live in-memory state first (`SillyTavern.getContext()` and cached
 *   `/scripts/world-info.js` exports), falling back to a single cached
 *   `/api/settings/get` only when needed.
 * - Direct `/api/worldinfo/get` reads happen ONLY on demand (preview, clues, search,
 *   or rename) without polluting SillyTavern's persistent `worldInfoCache`.
 */

import {
    MODULE_NAME,
    charaFileName,
    createNewRawWorldEntry,
    deepClone,
    extractEntryListItems,
    extractSingleEntryForEdit,
    isPotentiallySensitiveTitle,
    mergeEntryPatchOntoRaw,
    migrateSettingsOnWorldRename,
    normalizeSettings,
} from './core.js';

const CUSTOM_API_STORAGE_KEY = 'wbo_custom_api_v1';
const PREVIEW_CONTENT_MAX_CHARS = 1600;

let _worldInfoModule = null;
let _worldInfoModuleTried = false;
let _powerUserModule = null;
let _powerUserModuleTried = false;
let _cachedSettingsCharLore = null;
let _cachedSettingsWorldNames = null;
/** @type {Array<{ oldName: string, newName: string }>} */
const _pendingRenamedEvents = [];

/**
 * Return SillyTavern / TauriTavern global context safely.
 * @returns {any | null}
 */
export function getHostContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch {
        return null;
    }
}

/**
 * Detect whether the extension is running inside TauriTavern.
 * @returns {boolean}
 */
export function isTauriTavern() {
    return Boolean(globalThis.__TAURITAVERN__ || globalThis.__TAURI_RUNNING__);
}

/**
 * Wait for TauriTavern host readiness if present (no-op on standard SillyTavern).
 */
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

/**
 * Lazily import `/scripts/world-info.js` once to read in-memory `world_info.charLore`
 * and `selected_world_info` without hitting disk or network.
 * Works identically in both SillyTavern and TauriTavern.
 */
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

/**
 * ST 1.14 fallback: load `/scripts/power-user.js` once if `getContext().powerUserSettings`
 * is not exposed on older SillyTavern versions.
 */
export async function ensurePowerUserModule() {
    if (_powerUserModuleTried) return _powerUserModule;
    _powerUserModuleTried = true;
    if (getHostContext()?.powerUserSettings) return null;
    try {
        const url = new URL('/scripts/power-user.js', globalThis.location.href).href;
        _powerUserModule = await import(/* @vite-ignore */ url);
    } catch {
        _powerUserModule = null;
    }
    return _powerUserModule;
}

/**
 * Build request headers compatible with ST 1.14–1.19+ and TauriTavern.
 */
function buildRequestHeaders() {
    const ctx = getHostContext();
    if (typeof ctx?.getRequestHeaders === 'function') {
        return ctx.getRequestHeaders();
    }
    return { 'Content-Type': 'application/json' };
}

/**
 * Read and normalize persisted extension settings in place.
 * @returns {Record<string, any>}
 */
export function getSettings() {
    const ctx = getHostContext();
    if (!ctx?.extensionSettings) {
        return normalizeSettings(null);
    }
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = normalizeSettings(null);
    } else {
        const normalized = normalizeSettings(ctx.extensionSettings[MODULE_NAME]);
        Object.assign(ctx.extensionSettings[MODULE_NAME], normalized);
    }
    return ctx.extensionSettings[MODULE_NAME];
}

/**
 * Emit a decoupled browser CustomEvent so companion extensions can react
 * without creating any module import coupling.
 * @param {string} type
 * @param {Record<string, any>} detail
 */
function emitBridgeEvent(type, detail) {
    try {
        if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent(type, { detail }));
        }
    } catch {
        // Ignore in non-browser test runtimes
    }
}

/**
 * Persist extension settings via host debounced saver.
 */
export function saveSettings() {
    const ctx = getHostContext();
    if (typeof ctx?.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
    emitBridgeEvent('wbo:settings-updated', { reason: 'save' });
}

/**
 * Fetch `/api/settings/get` ONLY as fallback when in-memory `world-info.js`
 * exports are unavailable or when the user explicitly clicks "Rescan".
 * @param {boolean} [force=false]
 */
export async function syncFallbackSettingsData(force = false) {
    // When live SillyTavern `world-info.js` exports are already loaded in memory,
    // NEVER re-download & JSON-parse the entire multi-MB `/api/settings/get` payload!
    if (_worldInfoModule?.world_info && Array.isArray(_worldInfoModule?.world_names)) {
        return;
    }
    if (!force && _cachedSettingsCharLore !== null) {
        return;
    }

    const ctx = getHostContext();
    try {
        const headers = typeof ctx?.getRequestHeaders === 'function'
            ? ctx.getRequestHeaders()
            : { 'Content-Type': 'application/json' };
        const res = await fetch('/api/settings/get', {
            method: 'POST',
            headers,
            body: JSON.stringify({}),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data?.world_names)) {
            _cachedSettingsWorldNames = data.world_names.filter(Boolean);
        }
        let parsedSettings = data?.settings;
        if (typeof parsedSettings === 'string') {
            try {
                parsedSettings = JSON.parse(parsedSettings);
            } catch {
                parsedSettings = null;
            }
        }
        const charLore =
            parsedSettings?.world_info?.charLore ||
            parsedSettings?.world_info_settings?.world_info?.charLore ||
            data?.world_info?.charLore;
        _cachedSettingsCharLore = Array.isArray(charLore) ? charLore : [];
    } catch {
        if (_cachedSettingsCharLore === null) _cachedSettingsCharLore = [];
    }
}

/**
 * Return all characters currently in host memory (zero disk reads).
 * @returns {Array<any>}
 */
export function getCharactersInMemory() {
    const ctx = getHostContext();
    return Array.isArray(ctx?.characters) ? ctx.characters : [];
}

/**
 * Return current active character avatar if in a single-character chat, else null.
 * @returns {string | null}
 */
export function getCurrentCharacterAvatar() {
    const ctx = getHostContext();
    if (!ctx || ctx.groupId) return null;
    const chid = ctx.characterId;
    if (chid === undefined || chid === null || chid === '') return null;
    const ch = ctx.characters?.[Number(chid)];
    return ch?.avatar ? String(ch.avatar) : null;
}

/**
 * Return in-memory `powerUserSettings` (compatible with ST 1.14–1.19+ and TauriTavern).
 * @returns {Record<string, any> | null}
 */
export function getPowerUserSettings() {
    return getHostContext()?.powerUserSettings || _powerUserModule?.power_user || null;
}

/**
 * Return `world_info.charLore` entries from memory (or cached fallback).
 * @returns {Array<{ name: string, extraBooks?: string[] }>}
 */
export function getCharLoreEntries() {
    if (Array.isArray(_worldInfoModule?.world_info?.charLore)) {
        return _worldInfoModule.world_info.charLore;
    }
    return Array.isArray(_cachedSettingsCharLore) ? _cachedSettingsCharLore : [];
}

/**
 * Return the authoritative list of worldbook names purely from memory/DOM.
 * @param {string[]} [extraKnownNames=[]]
 * @returns {string[]}
 */
export function getWorldNames(extraKnownNames = []) {
    const ctx = getHostContext();
    let names = [];
    let hasAuthoritativeHostList = false;

    if (typeof ctx?.getWorldInfoNames === 'function') {
        const list = ctx.getWorldInfoNames();
        if (Array.isArray(list) && list.length > 0) {
            names = list;
            hasAuthoritativeHostList = true;
        }
    }
    if (!hasAuthoritativeHostList && Array.isArray(_worldInfoModule?.world_names) && _worldInfoModule.world_names.length > 0) {
        names = _worldInfoModule.world_names;
        hasAuthoritativeHostList = true;
    }
    if (!hasAuthoritativeHostList && Array.isArray(_cachedSettingsWorldNames) && _cachedSettingsWorldNames.length > 0) {
        names = _cachedSettingsWorldNames;
    }

    // Only merge `extraKnownNames` (detached DOM options) when host modules are unavailable;
    // when authoritative `world_names` is loaded, NEVER resurrect deleted books from detached maps!
    const sourceList = hasAuthoritativeHostList ? names : [...names, ...extraKnownNames];
    const merged = [];
    const seen = new Set();
    for (const item of sourceList) {
        const clean = String(item ?? '').trim();
        if (clean && !seen.has(clean)) {
            seen.add(clean);
            merged.push(clean);
        }
    }

    // Last-resort DOM fallback if host modules haven't populated yet
    if (merged.length === 0 && typeof document !== 'undefined') {
        const sel = document.getElementById('world_editor_select') || document.getElementById('world_info');
        if (sel) {
            sel.querySelectorAll('option').forEach((opt) => {
                const v = opt.value;
                const t = (opt.textContent || '').trim();
                if (v !== '' && t && !seen.has(t)) {
                    seen.add(t);
                    merged.push(t);
                }
            });
        }
    }

    return merged;
}

/**
 * Return the Set of currently active global worldbooks.
 * Prefers live `#world_info option:checked` in DOM because it updates synchronously
 * on toggle while upstream `selected_world_info` updates asynchronously.
 * @returns {Set<string>}
 */
export function getActiveGlobalWorldSet() {
    if (typeof document !== 'undefined') {
        const sel = document.getElementById('world_info');
        if (sel) {
            const active = new Set();
            sel.querySelectorAll('option:checked').forEach((opt) => {
                const t = (opt.textContent || '').trim();
                if (opt.value !== '' && t) active.add(t);
            });
            return active;
        }
    }
    if (Array.isArray(_worldInfoModule?.selected_world_info)) {
        return new Set(_worldInfoModule.selected_world_info);
    }
    return new Set();
}

/**
 * Return the worldbook currently open in the native editor, if any.
 * @returns {string | null}
 */
export function getCurrentEditorWorldName() {
    const sel = document.getElementById('world_editor_select');
    if (!sel) return null;
    const selectedOpt = sel.selectedOptions?.[0];
    if (!selectedOpt || selectedOpt.value === '') return null;
    return (selectedOpt.textContent || '').trim() || null;
}

/**
 * On-demand preview of a single worldbook's entries for in-modal inspection.
 * NEVER called automatically in the background; reads only when the user clicks to expand a book.
 *
 * @param {string} worldName
 * @returns {Promise<{ total: number, enabledCount: number, entries: Array<{ uid: string, title: string, keys: string[], content: string, disabled: boolean, constant: boolean }> }>}
 */
export async function fetchWorldbookPreviewEntries(worldName) {
    const data = await fetchWorldInfoUncached(worldName);
    const entriesObj = data?.entries;
    if (!entriesObj || typeof entriesObj !== 'object') {
        return { total: 0, enabledCount: 0, entries: [] };
    }
    const list = Object.values(entriesObj)
        .filter((e) => e && typeof e === 'object')
        .sort((a, b) => (Number(a.displayIndex ?? a.order ?? a.uid ?? 0) - Number(b.displayIndex ?? b.order ?? b.uid ?? 0)))
        .map((e, idx) => {
            const keys = Array.isArray(e.key)
                ? e.key.map((k) => String(k || '').trim()).filter(Boolean)
                : [];
            const rawContent = String(e.content || '').trim();
            const content = rawContent.length > PREVIEW_CONTENT_MAX_CHARS
                ? `${rawContent.slice(0, PREVIEW_CONTENT_MAX_CHARS)}…（内容较长，完整正文请在编辑器查看）`
                : rawContent;
            return {
                uid: String(e.uid ?? idx),
                title: String(e.comment || '').trim() || keys.slice(0, 2).join(' / ') || `条目 #${idx + 1}`,
                keys: keys.slice(0, 6),
                content,
                disabled: Boolean(e.disable),
                constant: Boolean(e.constant),
            };
        });
    const enabledCount = list.filter((x) => !x.disabled).length;
    return { total: list.length, enabledCount, entries: list };
}

/**
 * Sync SillyTavern's `worldInfoCache` ONLY if `worldName` is already present in cache.
 * Never populates `worldInfoCache` for uncached books (prevents TT iOS memory bloat).
 * @param {string} worldName
 * @param {any} updatedPayload
 * @returns {Promise<boolean>}
 */
export async function syncWorldInfoCacheIfPresent(worldName, updatedPayload) {
    await ensureWorldInfoModule();
    const cache = _worldInfoModule?.worldInfoCache;
    let updated = false;
    if (cache && typeof cache.has === 'function' && typeof cache.set === 'function') {
        if (cache.has(worldName)) {
            cache.set(worldName, deepClone(updatedPayload));
            updated = true;
        }
    } else if (cache && typeof cache === 'object' && !(cache instanceof Map) && Object.hasOwn(cache, worldName)) {
        cache[worldName] = deepClone(updatedPayload);
        updated = true;
    }

    if (updated && getCurrentEditorWorldName() === worldName && typeof _worldInfoModule?.reloadEditor === 'function') {
        try {
            _worldInfoModule.reloadEditor(worldName);
        } catch {
            // Non-fatal
        }
    }
    return updated;
}

/**
 * Load lightweight entry list metadata for a single worldbook via uncached `/api/worldinfo/get`.
 * @param {string} worldName
 */
export async function fetchWorldbookEntryList(worldName) {
    let data = await fetchWorldInfoUncached(worldName);
    if (!data || typeof data !== 'object') {
        return { ok: false, total: 0, enabledCount: 0, items: [], error: `无法读取世界书「${worldName}」` };
    }
    const projected = extractEntryListItems(data);
    data = null;
    return { ok: true, ...projected };
}

/**
 * Load editable fields for a single entry on demand via uncached `/api/worldinfo/get`.
 * @param {string} worldName
 * @param {string | number} uid
 */
export async function fetchSingleWorldbookEntry(worldName, uid) {
    let data = await fetchWorldInfoUncached(worldName);
    if (!data || typeof data !== 'object') {
        return { ok: false, entry: null, error: `无法读取世界书「${worldName}」` };
    }
    const entry = extractSingleEntryForEdit(data, uid);
    data = null;
    if (!entry) {
        return { ok: false, entry: null, error: '未找到对应条目（可能已被外部删除）' };
    }
    return { ok: true, entry };
}

/**
 * Save changes to a single worldbook entry cleanly:
 * 1. Fetches full original JSON via uncached `/api/worldinfo/get`.
 * 2. Locates original `rawEntry` by `uid` and shallow-merges edited fields onto it
 *    (100% lossless for all undisplayed native/extension fields).
 * 3. Writes via `/api/worldinfo/edit` and updates `worldInfoCache` ONLY if already cached.
 *
 * @param {string} worldName
 * @param {string | number} uid
 * @param {Record<string, any>} patch
 */
export async function saveWorldbookEntryPatch(worldName, uid, patch) {
    const clean = String(worldName ?? '').trim();
    if (!clean) return { ok: false, error: '世界书名称为空' };

    let data = await fetchWorldInfoUncached(clean);
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
        return { ok: false, error: `无法读取世界书「${clean}」` };
    }

    const targetUid = String(uid);
    let entryKey = null;
    if (Object.hasOwn(data.entries, targetUid) && data.entries[targetUid] && typeof data.entries[targetUid] === 'object') {
        entryKey = targetUid;
    } else {
        for (const [k, e] of Object.entries(data.entries)) {
            if (e && typeof e === 'object' && String(e.uid ?? k) === targetUid) {
                entryKey = k;
                break;
            }
        }
    }
    if (entryKey === null) {
        data = null;
        return { ok: false, error: '未找到对应条目（可能已被删除）' };
    }

    const mergedEntry = mergeEntryPatchOntoRaw(data.entries[entryKey], patch);
    data.entries[entryKey] = mergedEntry;

    try {
        const res = await fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: buildRequestHeaders(),
            body: JSON.stringify({ name: clean, data }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
        data = null;
        return { ok: false, error: `保存条目失败：${err?.message || err}` };
    }

    await syncWorldInfoCacheIfPresent(clean, data);
    const ctx = getHostContext();
    const et = ctx?.eventTypes || ctx?.event_types || {};
    if (ctx?.eventSource?.emit && et.WORLDINFO_UPDATED) {
        try { await ctx.eventSource.emit(et.WORLDINFO_UPDATED, clean, data); } catch { /* ignore */ }
    }
    emitBridgeEvent('wbo:entries-updated', { worldName: clean });

    const savedEntry = extractSingleEntryForEdit({ entries: { [entryKey]: mergedEntry } }, targetUid);
    data = null;
    return { ok: true, entry: savedEntry };
}

/**
 * Create a new entry in a worldbook via uncached `/api/worldinfo/get` -> `/api/worldinfo/edit`.
 * @param {string} worldName
 * @param {Record<string, any>} [initialFields={}]
 */
export async function createWorldbookEntryDirect(worldName, initialFields = {}) {
    const clean = String(worldName ?? '').trim();
    if (!clean) return { ok: false, error: '世界书名称为空' };

    let data = await fetchWorldInfoUncached(clean);
    if (!data || typeof data !== 'object') {
        return { ok: false, error: `无法读取世界书「${clean}」` };
    }
    if (!data.entries || typeof data.entries !== 'object') {
        data.entries = {};
    }

    const newEntry = createNewRawWorldEntry(data.entries, initialFields);
    const uidKey = String(newEntry.uid);
    data.entries[uidKey] = newEntry;

    try {
        const res = await fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: buildRequestHeaders(),
            body: JSON.stringify({ name: clean, data }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
        data = null;
        return { ok: false, error: `创建条目失败：${err?.message || err}` };
    }

    await syncWorldInfoCacheIfPresent(clean, data);
    const ctx = getHostContext();
    const et = ctx?.eventTypes || ctx?.event_types || {};
    if (ctx?.eventSource?.emit && et.WORLDINFO_UPDATED) {
        try { await ctx.eventSource.emit(et.WORLDINFO_UPDATED, clean, data); } catch { /* ignore */ }
    }
    emitBridgeEvent('wbo:entries-updated', { worldName: clean });

    const createdEntry = extractSingleEntryForEdit({ entries: { [uidKey]: newEntry } }, uidKey);
    data = null;
    return { ok: true, uid: uidKey, entry: createdEntry };
}

/**
 * Jump directly to a character card by its avatar filename so users can inspect
 * or fix character-worldbook bindings reported by the scan modal.
 * @param {string} avatar
 * @returns {Promise<boolean>}
 */
export async function openCharacterByAvatar(avatar) {
    const clean = String(avatar ?? '').trim();
    if (!clean) return false;
    const ctx = getHostContext();
    const list = Array.isArray(ctx?.characters) ? ctx.characters : [];
    const chid = list.findIndex((c) => c?.avatar === clean);
    if (chid < 0) return false;

    try {
        // Close WorldInfo drawer if unpinned so the character card is visible
        const wiDrawer = document.getElementById('WorldInfo');
        const wiPin = document.getElementById('WI_panel_pin');
        if (wiDrawer && !wiDrawer.classList.contains('closedDrawer') && !(wiPin instanceof HTMLInputElement && wiPin.checked)) {
            const wiIcon = document.querySelector('#WI-SP-button .drawer-icon');
            if (wiIcon instanceof HTMLElement) wiIcon.click();
        }

        if (typeof ctx?.selectCharacterById === 'function') {
            await ctx.selectCharacterById(chid);
        } else {
            const cardEl = document.querySelector(`.character_select[chid="${chid}"]`);
            if (cardEl instanceof HTMLElement) cardEl.click();
        }

        // Ensure right-hand character management drawer is open on the selected character
        const rightDrawer = document.getElementById('right-nav-panel');
        if (rightDrawer && rightDrawer.classList.contains('closedDrawer')) {
            const rightIcon = document.querySelector('#rightNavDrawerIcon');
            if (rightIcon instanceof HTMLElement) rightIcon.click();
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Strip template/markup noise and compact an entry body into a concise clue snippet.
 * @param {string} content
 * @param {number} maxChars
 * @returns {string}
 */
function compactEntrySnippet(content, maxChars) {
    if (!content || maxChars <= 0) return '';
    const cleaned = String(content)
        .replace(/<%[\s\S]*?%>/g, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]{1,120}>/g, ' ')
        .replace(/\{\{[^}]{1,80}\}\}/g, ' ')
        .replace(/[`#*_>~|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return '';
    return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}…` : cleaned;
}

/**
 * On-demand read of a single worldbook's top entries (enabled entries prioritized)
 * with optional compact content snippets for AI Organize clues.
 * Automatically skips individual entries whose title/keys/snippet contain NSFW
 * or sensitive keywords so a single adult entry inside an otherwise normal book
 * will NOT trigger commercial AI safety refusals!
 * NEVER called automatically in the background!
 *
 * @param {string} worldName
 * @param {number} [maxClues=5]
 * @param {{ snippetChars?: number, filterSensitive?: boolean, statsOut?: { skippedEntries: number } }} [opts]
 * @returns {Promise<string[]>}
 */
export async function fetchWorldbookCluesOnDemand(
    worldName,
    maxClues = 5,
    { snippetChars = 50, filterSensitive = true, statsOut = null } = {},
) {
    const limit = Math.max(1, Math.min(20, Number(maxClues) || 5));
    const maxSnippet = Math.max(0, Math.min(200, Number(snippetChars) || 0));
    const data = await fetchWorldInfoUncached(worldName);
    const entriesObj = data?.entries;
    if (!entriesObj || typeof entriesObj !== 'object') return [];

    // Prioritize enabled entries with meaningful content/titles first
    const allEntries = Object.values(entriesObj)
        .filter((e) => e && typeof e === 'object')
        .sort((a, b) => {
            const da = a.disable ? 1 : 0;
            const db = b.disable ? 1 : 0;
            if (da !== db) return da - db;
            return Number(a.displayIndex ?? a.order ?? a.uid ?? 0) - Number(b.displayIndex ?? b.order ?? b.uid ?? 0);
        });

    const clues = [];
    for (const entry of allEntries) {
        const fullTitle = String(entry.comment || '').trim();
        const title = fullTitle.slice(0, 32);
        const allKeys = Array.isArray(entry.key)
            ? entry.key.map((k) => String(k || '').trim()).filter(Boolean)
            : [];
        const keys = allKeys.slice(0, 3);
        const head = title
            ? (keys.length > 0 ? `${title}[${keys.join('/')}]` : title)
            : keys.join('/');
        const snippet = compactEntrySnippet(entry.content, maxSnippet);
        const inspectSnippet = compactEntrySnippet(entry.content, Math.max(maxSnippet + 24, 100));

        let line = '';
        if (head && snippet) line = `${head}：${snippet}`;
        else if (head) line = head;
        else if (snippet) line = snippet;

        if (!line) continue;

        // Check full title, all trigger keys, and expanded snippet so truncated sensitive words never leak through
        if (filterSensitive && isPotentiallySensitiveTitle(`${fullTitle} ${allKeys.join(' ')} ${inspectSnippet}`)) {
            if (statsOut) statsOut.skippedEntries = (statsOut.skippedEntries || 0) + 1;
            continue;
        }

        if (!clues.includes(line)) {
            clues.push(line);
        }
        if (clues.length >= limit) break;
    }
    return clues;
}

/**
 * Permanently delete one or more worldbooks from disk via SillyTavern's standard
 * `/api/worldinfo/delete` endpoint, deactivating global selection first if needed,
 * and refreshing the host world list afterward.
 *
 * @param {string[]} worldNames
 * @returns {Promise<{ deleted: string[], failed: Array<{ name: string, error: string }> }>}
 */
export async function deleteWorldbooksFromHost(worldNames) {
    const targets = [...new Set((worldNames || []).map((n) => String(n ?? '').trim()).filter(Boolean))];
    const deleted = [];
    const failed = [];
    if (targets.length === 0) return { deleted, failed };

    const ctx = getHostContext();
    await ensureWorldInfoModule();

    // Remove from active global selection first so ST won't hold dangling references
    if (Array.isArray(_worldInfoModule?.selected_world_info)) {
        const nextSelected = _worldInfoModule.selected_world_info.filter((n) => !targets.includes(n));
        if (nextSelected.length !== _worldInfoModule.selected_world_info.length) {
            _worldInfoModule.selected_world_info.splice(0, _worldInfoModule.selected_world_info.length, ...nextSelected);
        }
    }

    for (const name of targets) {
        try {
            const res = await fetch('/api/worldinfo/delete', {
                method: 'POST',
                headers: buildRequestHeaders(),
                body: JSON.stringify({ name }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            deleted.push(name);
        } catch (err) {
            failed.push({ name, error: String(err?.message || err) });
        }
    }

    const updateListFn = ctx?.updateWorldInfoList || _worldInfoModule?.updateWorldInfoList;
    if (typeof updateListFn === 'function') {
        try { await updateListFn(); } catch { /* ignore */ }
    }
    if (deleted.length > 0) {
        emitBridgeEvent('wbo:worldbook-deleted', { names: [...deleted] });
    }
    return { deleted, failed };
}

/**
 * Call the host's configured AI model cleanly for worldbook organizing.
 * Prefers `generateRaw` (sends only our tiny prompt without chat history)
 * and falls back to `generateQuietPrompt`.
 *
 * @param {{ systemPrompt: string, userPrompt: string }} prompts
 * @returns {Promise<string>}
 */
export async function callHostAiForOrganize({ systemPrompt, userPrompt }) {
    const ctx = getHostContext();
    if (!ctx) {
        throw new Error('未检测到 SillyTavern / TauriTavern 上下文');
    }

    if (typeof ctx.generateRaw === 'function') {
        const result = await ctx.generateRaw({
            prompt: userPrompt,
            systemPrompt,
            quietToLoud: false,
            instructOverride: false,
        });
        return String(result ?? '');
    }

    if (typeof ctx.generateQuietPrompt === 'function') {
        const result = await ctx.generateQuietPrompt({
            quietPrompt: `${systemPrompt}\n\n${userPrompt}`,
            quietToLoud: false,
            skipWIAN: true,
        });
        return String(result ?? '');
    }

    throw new Error('当前宿主未提供 generateRaw 或 generateQuietPrompt 接口，请改用「复制提示词 / 粘贴 JSON」模式');
}

/**
 * Fetch full character data for a single shallow character on demand (without
 * switching chats). When `allowUnshallow` is false, fetches a transient JSON copy
 * via `/api/characters/get` WITHOUT calling `ctx.unshallowCharacter()` so bulk
 * scans on lazy-loaded libraries never bloat host memory on TT iOS.
 * @param {string} avatar
 * @param {{ allowUnshallow?: boolean }} [opts]
 * @returns {Promise<any | null>}
 */
export async function fetchFullCharacterOnDemand(avatar, { allowUnshallow = true } = {}) {
    const ctx = getHostContext();
    const list = Array.isArray(ctx?.characters) ? ctx.characters : [];
    const chid = list.findIndex((c) => c?.avatar === avatar);
    if (chid >= 0 && !list[chid]?.shallow) {
        return list[chid];
    }

    if (allowUnshallow && chid >= 0 && typeof ctx?.unshallowCharacter === 'function') {
        try {
            await ctx.unshallowCharacter(chid);
            return ctx.characters?.[chid] || null;
        } catch {
            // Fall through to direct API fetch
        }
    }

    try {
        const headers = typeof ctx?.getRequestHeaders === 'function'
            ? ctx.getRequestHeaders()
            : { 'Content-Type': 'application/json' };
        const res = await fetch('/api/characters/get', {
            method: 'POST',
            headers,
            body: JSON.stringify({ avatar_url: avatar }),
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

/**
 * Scan unscanned shallow characters in small throttled batches (concurrency = 2)
 * without calling `unshallowCharacter`, so full character JSONs are released to GC immediately.
 *
 * @param {Array<{ chid: number, avatar: string, name: string }>} targets
 * @param {{ onProgress?: (done: number, total: number, currentName: string) => void, signal?: { cancelled: boolean } }} [opts]
 * @returns {Promise<{ scanned: Array<any>, done: number, cancelled: boolean }>}
 */
export async function scanShallowCharactersInBatches(targets, { onProgress, signal, batchSize = 2, yieldMs = 30 } = {}) {
    const scanned = [];
    const total = targets.length;
    const step = Math.max(1, Math.min(3, Number(batchSize) || 2));
    const pauseMs = Math.max(16, Number(yieldMs) || 30);
    let done = 0;

    for (let i = 0; i < total; i += step) {
        if (signal?.cancelled) {
            return { scanned, done, cancelled: true };
        }
        const batch = targets.slice(i, i + step);
        const results = await Promise.all(
            batch.map(async (item) => {
                const full = await fetchFullCharacterOnDemand(item.avatar, { allowUnshallow: false });
                done += 1;
                onProgress?.(done, total, item.name);
                if (!full || !full.avatar) return null;
                // Extract ONLY tiny binding fields (~150B) and drop the multi-MB full character JSON
                // immediately so bulk-importing 20+ cards never spikes memory on mobile WebViews!
                const charName = String(full?.name || full?.data?.name || item.name || '').trim() || full.avatar;
                const rawPrimary = full?.data?.extensions?.world;
                const primary = typeof rawPrimary === 'string' && rawPrimary.trim() ? rawPrimary.trim() : null;
                let embedded = null;
                let embeddedEntryCount = 0;
                if (full?.data?.character_book && typeof full.data.character_book === 'object') {
                    const entries = full.data.character_book.entries;
                    embeddedEntryCount = Array.isArray(entries)
                        ? entries.length
                        : (entries && typeof entries === 'object' ? Object.keys(entries).length : 0);
                    const rawEmb = full.data.character_book.name || `${charName}'s Lorebook`;
                    if (typeof rawEmb === 'string' && rawEmb.trim()) {
                        embedded = rawEmb.trim();
                    }
                }
                return {
                    avatar: full.avatar,
                    name: charName,
                    shallow: false,
                    wboCompactSummary: true,
                    primary,
                    embedded,
                    embeddedEntryCount,
                };
            }),
        );
        for (const summary of results) {
            if (summary && summary.avatar) scanned.push(summary);
        }
        // Yield briefly between batches so mobile UI stays smooth and GC can reclaim full card payloads
        await new Promise((r) => setTimeout(r, pauseMs));
    }

    return { scanned, done, cancelled: false };
}

/**
 * Import a character card's embedded `character_book` into SillyTavern / TauriTavern
 * and bind it to the character via standard host APIs.
 * NEVER overwrites an existing worldbook with the same name!
 *
 * @param {string} avatar
 * @param {{ worldNamesSet?: Set<string>, deferRefresh?: boolean }} [opts]
 * @returns {Promise<{ status: 'imported' | 'exists' | 'nobook' | 'failed', name?: string, error?: string }>}
 */
export async function importEmbeddedWorldbookForCharacter(avatar, { worldNamesSet, deferRefresh = false } = {}) {
    const ctx = getHostContext();
    await ensureWorldInfoModule();

    const fullChar = await fetchFullCharacterOnDemand(avatar, { allowUnshallow: false });
    const list = Array.isArray(ctx?.characters) ? ctx.characters : [];
    const chid = list.findIndex((c) => c?.avatar === avatar);
    const charObj = (chid >= 0 && !list[chid]?.shallow ? list[chid] : fullChar) || null;
    const book = charObj?.data?.character_book;

    if (!charObj || !book || typeof book !== 'object') {
        return { status: 'nobook' };
    }

    const entries = book.entries;
    const count = Array.isArray(entries)
        ? entries.length
        : (entries && typeof entries === 'object' ? Object.keys(entries).length : 0);
    if (count <= 0) {
        return { status: 'nobook' };
    }

    const charName = String(charObj.name || charObj.data?.name || avatar).trim();
    const boundName = String(charObj.data?.extensions?.world || '').trim();
    const targetName = boundName || String(book.name || `${charName}'s Lorebook`).trim();
    if (!targetName) return { status: 'nobook' };

    const existingNames = worldNamesSet || new Set(getWorldNames());
    if (existingNames.has(targetName)) {
        return { status: 'exists', name: targetName };
    }

    const convertFn = _worldInfoModule?.convertCharacterBook || ctx?.convertCharacterBook;
    const saveFn = ctx?.saveWorldInfo || _worldInfoModule?.saveWorldInfo;
    const updateListFn = ctx?.updateWorldInfoList || _worldInfoModule?.updateWorldInfoList;

    if (typeof convertFn !== 'function' || typeof saveFn !== 'function') {
        return { status: 'failed', name: targetName, error: '当前宿主缺少 convertCharacterBook 或 saveWorldInfo 接口' };
    }

    try {
        const clonedBook = typeof structuredClone === 'function'
            ? structuredClone(book)
            : JSON.parse(JSON.stringify(book));
        const converted = convertFn(clonedBook);
        await saveFn(targetName, converted, true);
        if (!deferRefresh && typeof updateListFn === 'function') {
            await updateListFn();
        }
        if (chid >= 0 && boundName !== targetName && typeof ctx?.writeExtensionField === 'function') {
            await ctx.writeExtensionField(chid, 'world', targetName);
        }
        return { status: 'imported', name: targetName };
    } catch (err) {
        return { status: 'failed', name: targetName, error: String(err?.message || err) };
    }
}

/**
 * One-time migration from legacy v1.4.0 localStorage custom API config into
 * cross-device `extensionSettings` channels.
 * @param {Record<string, any>} settings
 * @returns {boolean} true if migrated
 */
export function migrateLegacyLocalApiConfig(settings) {
    if (!settings || (Array.isArray(settings.apiChannels) && settings.apiChannels.length > 0)) {
        return false;
    }
    try {
        const raw = globalThis.localStorage?.getItem(CUSTOM_API_STORAGE_KEY);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        if (!parsed || (!parsed.baseUrl && !parsed.apiKey && !parsed.model)) return false;
        const id = `api_${Date.now().toString(36)}`;
        settings.apiChannels = [{
            id,
            name: parsed.model ? `自定义 · ${parsed.model}` : '自定义 API',
            baseUrl: String(parsed.baseUrl || 'https://api.openai.com/v1').trim(),
            apiKey: String(parsed.apiKey || '').trim(),
            model: String(parsed.model || '').trim(),
        }];
        settings.activeApiChannelId = id;
        if (parsed.provider === 'custom') settings.apiProvider = 'custom';
        globalThis.localStorage?.removeItem(CUSTOM_API_STORAGE_KEY);
        return true;
    } catch {
        return false;
    }
}

/**
 * Test a custom OpenAI-compatible API channel cleanly.
 * @param {{ baseUrl: string, apiKey: string, model: string }} cfg
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function testCustomApiChannel({ baseUrl, apiKey, model }) {
    try {
        if (model) {
            const out = await callCustomApiForOrganize({
                baseUrl,
                apiKey,
                model,
                systemPrompt: 'Reply with OK only.',
                userPrompt: 'ping',
            });
            return { ok: true, message: `连接成功（返回：${out.slice(0, 24).trim() || 'OK'}）` };
        }
        const models = await fetchCustomApiModels({ baseUrl, apiKey });
        return { ok: true, message: `连接成功，获取到 ${models.length} 个模型` };
    } catch (err) {
        return { ok: false, message: String(err?.message || err) };
    }
}

/**
 * Read custom OpenAI-compatible API settings from localStorage (device-local,
 * never exported in backup JSON so API keys stay private).
 */
export function getCustomApiConfig() {
    const defaults = {
        provider: 'host', // 'host' | 'custom'
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: '',
    };
    try {
        const raw = globalThis.localStorage?.getItem(CUSTOM_API_STORAGE_KEY);
        if (!raw) return defaults;
        const parsed = JSON.parse(raw);
        return {
            provider: parsed?.provider === 'custom' ? 'custom' : 'host',
            baseUrl: String(parsed?.baseUrl || defaults.baseUrl).trim(),
            apiKey: String(parsed?.apiKey || '').trim(),
            model: String(parsed?.model || '').trim(),
        };
    } catch {
        return defaults;
    }
}

/**
 * Save custom OpenAI-compatible API settings to localStorage.
 * @param {{ provider?: string, baseUrl?: string, apiKey?: string, model?: string }} next
 */
export function saveCustomApiConfig(next) {
    const current = getCustomApiConfig();
    const merged = {
        provider: next.provider === 'custom' ? 'custom' : (next.provider === 'host' ? 'host' : current.provider),
        baseUrl: next.baseUrl !== undefined ? String(next.baseUrl).trim() : current.baseUrl,
        apiKey: next.apiKey !== undefined ? String(next.apiKey).trim() : current.apiKey,
        model: next.model !== undefined ? String(next.model).trim() : current.model,
    };
    try {
        globalThis.localStorage?.setItem(CUSTOM_API_STORAGE_KEY, JSON.stringify(merged));
    } catch {
        // Ignore storage quota errors
    }
    return merged;
}

/**
 * Normalize an OpenAI-compatible base URL into an endpoint URL.
 * @param {string} baseUrl
 * @param {string} suffix
 * @returns {string}
 */
function buildOpenAiEndpoint(baseUrl, suffix) {
    let clean = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!clean) throw new Error('请填写 API Base URL');
    if (clean.endsWith('/chat/completions') && suffix === '/chat/completions') return clean;
    if (clean.endsWith('/chat/completions') && suffix === '/models') {
        clean = clean.slice(0, -'/chat/completions'.length);
    }
    return `${clean}${suffix}`;
}

/**
 * Fetch available model IDs from a custom OpenAI-compatible endpoint.
 * @param {{ baseUrl: string, apiKey: string }} cfg
 * @returns {Promise<string[]>}
 */
export async function fetchCustomApiModels({ baseUrl, apiKey }) {
    const url = buildOpenAiEndpoint(baseUrl, '/models');
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
        throw new Error(`拉取模型失败 (HTTP ${res.status})`);
    }
    const json = await res.json();
    const list = Array.isArray(json?.data) ? json.data : (Array.isArray(json?.models) ? json.models : []);
    return list
        .map((m) => (typeof m === 'string' ? m : String(m?.id || m?.name || '').trim()))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}

/**
 * Call a user-configured OpenAI-compatible API directly for worldbook organizing.
 * @param {{ baseUrl: string, apiKey: string, model: string, systemPrompt: string, userPrompt: string }} params
 * @returns {Promise<string>}
 */
export async function callCustomApiForOrganize({ baseUrl, apiKey, model, systemPrompt, userPrompt }) {
    const cleanModel = String(model || '').trim();
    if (!cleanModel) throw new Error('请填写模型名称');
    const url = buildOpenAiEndpoint(baseUrl, '/chat/completions');
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: cleanModel,
            temperature: 0.2,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
        }),
    });

    if (!res.ok) {
        let detail = '';
        try {
            detail = (await res.text()).slice(0, 180);
        } catch {
            // ignore
        }
        throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
    }
    throw new Error('自定义 API 未返回有效文本内容');
}

/**
 * Fetch a single worldbook payload WITHOUT populating SillyTavern's persistent
 * in-memory `worldInfoCache`, so scanning 300+ worldbooks on mobile / TauriTavern iOS
 * lets GC reclaim every book immediately and prevents OOM crashes!
 * @param {string} worldName
 * @returns {Promise<any | null>}
 */
async function fetchWorldInfoUncached(worldName) {
    try {
        const res = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: buildRequestHeaders(),
            body: JSON.stringify({ name: worldName }),
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

/**
 * Low-memory, streaming cross-worldbook entry search designed for large libraries
 * (including mobile WKWebView / TauriTavern iOS):
 * - Bypasses `worldInfoCache` so peak RAM stays ~2 books regardless of library size.
 * - Yields between small batches (`concurrency = 2`) so UI & Stop button stay responsive.
 * - Emits matches incrementally per book as soon as found.
 *
 * @param {object} params
 * @param {string[]} params.worldNames
 * @param {(payload: any, worldName: string) => { hits: any[], totalMatchesInBook: number }} params.matcher
 * @param {number} [params.concurrency=2]
 * @param {number} [params.yieldMs=12]
 * @param {number} [params.maxTotalHits=150]
 * @param {{ cancelled: boolean }} [params.signal]
 * @param {(result: { worldName: string, hits: any[], totalMatchesInBook: number }) => void} [params.onBookResult]
 * @param {(info: { done: number, total: number, hitCount: number, matchedBooks: number, currentName: string }) => void} [params.onProgress]
 * @returns {Promise<{ done: number, total: number, hitCount: number, matchedBooks: number, cancelled: boolean, capped: boolean }>}
 */
export async function searchWorldbookEntriesStream({
    worldNames = [],
    matcher,
    concurrency = 2,
    yieldMs = 12,
    maxTotalHits = 150,
    signal = { cancelled: false },
    onBookResult,
    onProgress,
}) {
    const list = Array.isArray(worldNames) ? worldNames : [];
    const total = list.length;
    const step = Math.max(1, Math.min(4, Number(concurrency) || 2));
    let done = 0;
    let hitCount = 0;
    let matchedBooks = 0;
    let capped = false;

    for (let i = 0; i < total; i += step) {
        if (signal?.cancelled) {
            return { done, total, hitCount, matchedBooks, cancelled: true, capped };
        }
        if (hitCount >= maxTotalHits) {
            capped = true;
            break;
        }

        const batch = list.slice(i, i + step);
        await Promise.all(
            batch.map(async (worldName) => {
                if (signal?.cancelled || hitCount >= maxTotalHits) return;
                let payload = await fetchWorldInfoUncached(worldName);
                done += 1;
                if (signal?.cancelled) {
                    payload = null;
                    return;
                }
                if (payload) {
                    const res = matcher(payload, worldName);
                    // Release reference immediately so GC can reclaim full JSON before next batch
                    payload = null;
                    if (res && Array.isArray(res.hits) && res.hits.length > 0) {
                        const remaining = Math.max(0, maxTotalHits - hitCount);
                        if (remaining > 0) {
                            const kept = res.hits.slice(0, remaining);
                            hitCount += kept.length;
                            matchedBooks += 1;
                            onBookResult?.({
                                worldName,
                                hits: kept,
                                totalMatchesInBook: res.totalMatchesInBook || kept.length,
                            });
                            if (hitCount >= maxTotalHits) capped = true;
                        }
                    }
                }
                onProgress?.({ done, total, hitCount, matchedBooks, currentName: worldName });
            }),
        );

        if (yieldMs > 0 && i + step < total && !signal?.cancelled && !capped) {
            await new Promise((resolve) => setTimeout(resolve, yieldMs));
        }
    }

    return { done, total, hitCount, matchedBooks, cancelled: Boolean(signal?.cancelled), capped };
}

/**
 * Discard queued `wbo:worldbook-renamed` bridge events (both forward and reverse)
 * for forward rename pairs that were successfully rolled back BEFORE `flushWorldInfoListRefresh()`.
 * Note: If a forward rename was already flushed before rollback (e.g. post-batch rollback),
 * its forward event is no longer in `_pendingRenamedEvents`, so the reverse rollback event
 * is preserved so companion extensions can revert the book name cleanly.
 *
 * @param {Array<{ oldName: string, newName: string }>} rolledBackPairs
 * @returns {number} number of discarded pending event entries
 */
export function discardPendingRenamedEventsForRollback(rolledBackPairs = []) {
    if (!Array.isArray(rolledBackPairs) || rolledBackPairs.length === 0) return 0;
    const cancelKeys = new Set();
    for (const p of rolledBackPairs) {
        const o = String(p?.oldName ?? '').trim();
        const n = String(p?.newName ?? '').trim();
        if (!o || !n) continue;
        const fwdKey = `${o}\0${n}`;
        const hasPendingForward = _pendingRenamedEvents.some((ev) => `${ev.oldName}\0${ev.newName}` === fwdKey);
        if (hasPendingForward) {
            cancelKeys.add(fwdKey);
            cancelKeys.add(`${n}\0${o}`);
        }
    }
    if (cancelKeys.size === 0) return 0;
    let removed = 0;
    for (let i = _pendingRenamedEvents.length - 1; i >= 0; i -= 1) {
        const ev = _pendingRenamedEvents[i];
        if (cancelKeys.has(`${ev.oldName}\0${ev.newName}`)) {
            _pendingRenamedEvents.splice(i, 1);
            removed += 1;
        }
    }
    return removed;
}

/**
 * Clear all queued `wbo:worldbook-renamed` bridge events without emitting them.
 */
export function clearPendingRenamedEvents() {
    _pendingRenamedEvents.length = 0;
}

/**
 * Flush SillyTavern's worldbook list once after a batch of file renames/deletes,
 * and emit any queued `wbo:worldbook-renamed` bridge events strictly AFTER `world_names` refreshes.
 */
export async function flushWorldInfoListRefresh() {
    const ctx = getHostContext();
    await ensureWorldInfoModule();
    saveSettings();
    const updateListFn = ctx?.updateWorldInfoList || _worldInfoModule?.updateWorldInfoList;
    if (typeof updateListFn === 'function') {
        try { await updateListFn(); } catch { /* ignore */ }
    }
    const pendingRenames = _pendingRenamedEvents.splice(0, _pendingRenamedEvents.length);
    for (const ev of pendingRenames) {
        emitBridgeEvent('wbo:worldbook-renamed', ev);
    }
}

/**
 * Truly rename a worldbook on disk AND migrate all live bindings safely:
 * 1. Save new file first (abort before deleting old if anything fails or collides)
 * 2. Update all User Persona bindings (`power_user.persona_descriptions` + active persona)
 * 3. Update all character primary bindings (`/api/characters/merge-attributes` / `writeExtensionField`)
 * 4. Update all character extra bindings (`world_info.charLore[].extraBooks`)
 * 5. Update current chat binding (`chat_metadata.world_info`)
 * 6. Update active global selection (`selected_world_info`) & plugin metadata
 * 7. Delete old file (and refresh host list unless `deferRefresh: true` for fast batch mode)
 *
 * @param {string} oldName
 * @param {string} newName
 * @param {Record<string, any>} pluginSettings
 * @param {{ deferRefresh?: boolean, existingNamesSet?: Set<string> | null }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, migrated?: { chars: number, extras: number, personas: number, currentChat: boolean, globalActive: boolean } }>}
 */
export async function realRenameWorldbook(oldName, newName, pluginSettings, { deferRefresh = false, existingNamesSet = null } = {}) {
    const cleanOld = String(oldName ?? '').trim();
    const cleanNew = String(newName ?? '').trim();
    if (!cleanOld || !cleanNew) return { ok: false, error: '名称不能为空' };
    if (cleanOld === cleanNew) return { ok: true, migrated: { chars: 0, extras: 0, personas: 0, currentChat: false, globalActive: false } };

    // Sanitize illegal filename chars conservatively
    if (/[\\/:*?"<>|]/.test(cleanNew)) {
        return { ok: false, error: '文件名不能包含 \\ / : * ? " < > |' };
    }

    const ctx = getHostContext();
    await ensureWorldInfoModule();
    await ensurePowerUserModule();

    const existingNames = existingNamesSet || new Set(getWorldNames());
    if (existingNames.has(cleanNew)) {
        return { ok: false, error: `已存在同名世界书「${cleanNew}」` };
    }

    // Step 1: Load original worldbook content without bloating host `worldInfoCache`
    // (critical on memory-constrained mobile WebViews like TauriTavern iOS).
    let data = await fetchWorldInfoUncached(cleanOld);
    if (!data || typeof data !== 'object' || !('entries' in data)) {
        return { ok: false, error: `无法读取原世界书「${cleanOld}」` };
    }

    // Step 2: Save to new filename FIRST (never delete old before new succeeds!)
    // Always write via `/api/worldinfo/edit` directly so ST doesn't duplicate the book in
    // `worldInfoCache` or run `updateWorldInfoList()` twice during a single rename.
    try {
        const saveRes = await fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: buildRequestHeaders(),
            body: JSON.stringify({ name: cleanNew, data }),
        });
        if (!saveRes.ok) throw new Error(`HTTP ${saveRes.status}`);
    } catch (err) {
        return { ok: false, error: `写入新世界书失败：${err?.message || err}` };
    }
    // Release potentially large worldbook payload immediately for mobile GC before list refresh
    data = null;

    const migrated = {
        chars: 0,
        extras: 0,
        personas: 0,
        currentChat: false,
        globalActive: false,
    };

    // Step 3: Migrate character extra bindings (`world_info.charLore`)
    const charLore = _worldInfoModule?.world_info?.charLore;
    if (Array.isArray(charLore)) {
        for (const item of charLore) {
            if (Array.isArray(item?.extraBooks) && item.extraBooks.includes(cleanOld)) {
                item.extraBooks = [...new Set(item.extraBooks.map((b) => (b === cleanOld ? cleanNew : b)))];
                migrated.extras += 1;
            }
        }
    }

    // Step 4: Migrate User Persona bindings (`power_user.persona_descriptions` + active persona)
    const pu = getPowerUserSettings();
    if (pu) {
        if (pu.persona_description_lorebook === cleanOld) {
            pu.persona_description_lorebook = cleanNew;
        }
        const descs = pu.persona_descriptions;
        if (descs && typeof descs === 'object') {
            for (const desc of Object.values(descs)) {
                if (desc && typeof desc === 'object' && desc.lorebook === cleanOld) {
                    desc.lorebook = cleanNew;
                    migrated.personas += 1;
                }
            }
        }
    }

    // Step 5: Migrate current chat-bound worldbook (`chatMetadata.world_info`)
    if (ctx?.chatMetadata?.world_info === cleanOld) {
        ctx.chatMetadata.world_info = cleanNew;
        migrated.currentChat = true;
        if (typeof ctx.saveMetadata === 'function') {
            try { await ctx.saveMetadata(); } catch { /* non-fatal */ }
        }
    }

    // Step 6: Migrate character primary bindings (`extensions.world`)
    const characters = getCharactersInMemory();
    const linkedTargets = [];
    characters.forEach((ch, chid) => {
        if (!ch?.avatar) return;
        const cached = pluginSettings?.cachedCharBindings?.[ch.avatar];
        const primary = ch.shallow ? cached?.primary : ch.data?.extensions?.world;
        if (primary === cleanOld) {
            linkedTargets.push({ chid, avatar: ch.avatar });
        }
    });

    for (const target of linkedTargets) {
        try {
            const res = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: buildRequestHeaders(),
                body: JSON.stringify({
                    avatar: target.avatar,
                    data: { extensions: { world: cleanNew } },
                }),
            });
            if (res.ok) {
                migrated.chars += 1;
                if (characters[target.chid]?.data?.extensions) {
                    characters[target.chid].data.extensions.world = cleanNew;
                }
            } else if (typeof ctx?.writeExtensionField === 'function') {
                await ctx.writeExtensionField(target.chid, 'world', cleanNew);
                migrated.chars += 1;
            }
        } catch {
            // Best effort; keep going for other characters
        }
    }

    // Step 7: Preserve global active status
    const wasGlobalActive = getActiveGlobalWorldSet().has(cleanOld);
    if (wasGlobalActive && Array.isArray(_worldInfoModule?.selected_world_info)) {
        const idx = _worldInfoModule.selected_world_info.indexOf(cleanOld);
        if (idx >= 0) {
            _worldInfoModule.selected_world_info[idx] = cleanNew;
            migrated.globalActive = true;
        }
    }

    // Step 8: Migrate plugin metadata & save host settings
    if (pluginSettings) {
        migrateSettingsOnWorldRename(pluginSettings, cleanOld, cleanNew);
    }
    if (!deferRefresh) {
        saveSettings();
    }

    // Step 9: Delete old file & refresh upstream list (deferred in batch mode!)
    try {
        const delRes = await fetch('/api/worldinfo/delete', {
            method: 'POST',
            headers: buildRequestHeaders(),
            body: JSON.stringify({ name: cleanOld }),
        });
        if (!delRes.ok) {
            throw new Error(`HTTP ${delRes.status}`);
        }
    } catch (err) {
        return {
            ok: false,
            error: `已创建新文件并迁移绑定，但删除旧文件失败：${err?.message || err}`,
            migrated,
        };
    }

    if (existingNamesSet) {
        existingNamesSet.delete(cleanOld);
        existingNamesSet.add(cleanNew);
    }

    if (deferRefresh) {
        _pendingRenamedEvents.push({ oldName: cleanOld, newName: cleanNew });
    } else {
        const updateListFn = ctx?.updateWorldInfoList || _worldInfoModule?.updateWorldInfoList;
        if (typeof updateListFn === 'function') {
            try { await updateListFn(); } catch { /* ignore */ }
        }
        emitBridgeEvent('wbo:worldbook-renamed', { oldName: cleanOld, newName: cleanNew });
    }

    return { ok: true, migrated };
}

/**
 * Remove a specific extra worldbook binding from `world_info.charLore` for a character
 * (also works for deleted/orphan character entries!).
 * @param {string} charKeyOrAvatar
 * @param {string} worldName
 * @param {{ deferSave?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function unbindExtraWorldbookFromChar(charKeyOrAvatar, worldName, { deferSave = false } = {}) {
    const cleanWorld = String(worldName ?? '').trim();
    const keyCandidate = charaFileName(String(charKeyOrAvatar ?? '').trim()) || String(charKeyOrAvatar ?? '').trim();
    if (!keyCandidate || !cleanWorld) return { ok: false, error: '参数无效' };

    await ensureWorldInfoModule();
    const charLore = _worldInfoModule?.world_info?.charLore;
    if (!Array.isArray(charLore)) {
        return { ok: false, error: '未能访问酒馆附加世界书列表' };
    }

    let removed = false;
    for (let i = charLore.length - 1; i >= 0; i -= 1) {
        const entry = charLore[i];
        const entryKey = String(entry?.name ?? '').trim();
        if (!entryKey) continue;
        if (entryKey !== keyCandidate && entryKey !== String(charKeyOrAvatar ?? '').trim()) continue;
        if (Array.isArray(entry.extraBooks) && entry.extraBooks.includes(cleanWorld)) {
            entry.extraBooks = entry.extraBooks.filter((b) => b !== cleanWorld);
            removed = true;
            if (entry.extraBooks.length === 0) {
                charLore.splice(i, 1);
            }
        }
    }

    if (!removed) {
        return { ok: false, error: '未找到对应的附加世界书绑定记录' };
    }

    if (!deferSave) {
        saveSettings();
    }
    return { ok: true };
}

/**
 * Clear a character card's primary worldbook binding (`extensions.world = ''`),
 * e.g. to clean up a broken reference to a deleted worldbook file.
 * @param {string} avatar
 * @param {Record<string, any>} [pluginSettings]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function unbindPrimaryWorldbookFromChar(avatar, pluginSettings = null) {
    const cleanAvatar = String(avatar ?? '').trim();
    if (!cleanAvatar) return { ok: false, error: '角色标识为空' };

    const ctx = getHostContext();
    const characters = getCharactersInMemory();
    const chid = characters.findIndex((c) => c?.avatar === cleanAvatar);

    try {
        const res = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: buildRequestHeaders(),
            body: JSON.stringify({
                avatar: cleanAvatar,
                data: { extensions: { world: '' } },
            }),
        });
        if (!res.ok) {
            if (chid >= 0 && typeof ctx?.writeExtensionField === 'function') {
                await ctx.writeExtensionField(chid, 'world', '');
            } else {
                throw new Error(`HTTP ${res.status}`);
            }
        }
        if (chid >= 0 && characters[chid]?.data?.extensions) {
            characters[chid].data.extensions.world = '';
        }
        if (pluginSettings?.cachedCharBindings?.[cleanAvatar]) {
            pluginSettings.cachedCharBindings[cleanAvatar].primary = null;
        }
        saveSettings();
        return { ok: true };
    } catch (err) {
        return { ok: false, error: String(err?.message || err) };
    }
}

/**
 * Clear a User Persona's worldbook binding (`persona_descriptions[pid].lorebook = ''`
 * and active `persona_description_lorebook` when matching) without touching disk files.
 * @param {string} pid
 * @param {string} [expectedWorld='']
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function unbindWorldbookFromPersona(pid, expectedWorld = '') {
    const cleanPid = String(pid ?? '').trim();
    const cleanWorld = String(expectedWorld ?? '').trim();
    if (!cleanPid) return { ok: false, error: '人设标识为空' };

    await ensurePowerUserModule();
    const pu = getPowerUserSettings();
    if (!pu) return { ok: false, error: '未能访问人设配置' };

    let changed = false;
    if (cleanPid !== '__active__' && pu.persona_descriptions?.[cleanPid] && typeof pu.persona_descriptions[cleanPid] === 'object') {
        const cur = String(pu.persona_descriptions[cleanPid].lorebook ?? '').trim();
        if (!cleanWorld || cur === cleanWorld) {
            pu.persona_descriptions[cleanPid].lorebook = '';
            changed = true;
        }
    }
    if (cleanWorld && String(pu.persona_description_lorebook ?? '').trim() === cleanWorld) {
        pu.persona_description_lorebook = '';
        changed = true;
    } else if (cleanPid === '__active__' && pu.persona_description_lorebook) {
        pu.persona_description_lorebook = '';
        changed = true;
    }

    if (!changed) return { ok: false, error: '未找到对应的人设世界书绑定' };
    saveSettings();
    return { ok: true };
}

/**
 * Apply TauriTavern mobile surface attribute cleanly when applicable.
 * @param {HTMLElement | null} el
 * @param {'fullscreen-window' | 'backdrop' | 'free-window'} surface
 */
export function applyTauriSurface(el, surface) {
    if (!el || !isTauriTavern()) return;
    el.setAttribute('data-tt-mobile-surface', surface);
}

/**
 * Display a non-intrusive toast notification.
 * @param {'success' | 'info' | 'warning' | 'error'} type
 * @param {string} message
 */
export function showToast(type, message) {
    const toastr = globalThis.toastr;
    if (toastr && typeof toastr[type] === 'function') {
        toastr[type](message, '世界书分组管理');
    } else {
        console.log(`[WorldbookOrganizer][${type}] ${message}`);
    }
}
