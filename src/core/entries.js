/**
 * World entry comparison, search, config export/import, global presets, pinning and entry patches.
 *
 * Move-only slice of src/core.js (original lines 3177-4335). Every declaration body is byte-
 * identical; the surroundings are import/export wiring only.
 */

import { compareZhCn, deepClone, normalizeSettings } from './settings.js';

export function compareWorldbookEntries(entriesA = [], entriesB = []) {
    const countCharacters = (content) => {
        let length = 0;
        for (const character of content) length += 1;
        return length;
    };
    const buildIndexed = (list) => {
        const counts = new Map();
        const map = new Map();
        for (const item of list || []) {
            const base = String(item?.title || '').trim().toLowerCase()
                || (Array.isArray(item?.keys) ? item.keys.slice(0, 3).join('|').toLowerCase() : '')
                || String(item?.content || '').slice(0, 40).toLowerCase();
            const n = (counts.get(base) || 0) + 1;
            counts.set(base, n);
            const key = n > 1 ? `${base}#${n}` : base;
            map.set(key, {
                title: String(item?.title || '').trim() || '(无标题)',
                keys: Array.isArray(item?.keys) ? item.keys : [],
                content: String(item?.content ?? ''),
            });
        }
        return map;
    };

    const mapA = buildIndexed(entriesA);
    const mapB = buildIndexed(entriesB);

    let sameCount = 0;
    const onlyA = [];
    const onlyB = [];
    const modified = [];

    for (const [k, a] of mapA.entries()) {
        if (!mapB.has(k)) {
            onlyA.push(a);
        } else {
            const b = mapB.get(k);
            if (a.content === b.content) {
                sameCount += 1;
            } else {
                modified.push({
                    title: a.title,
                    lenA: countCharacters(a.content),
                    lenB: countCharacters(b.content),
                    snippetA: a.content.slice(0, 120),
                    snippetB: b.content.slice(0, 120),
                });
            }
        }
    }
    for (const [k, b] of mapB.entries()) {
        if (!mapA.has(k)) {
            onlyB.push(b);
        }
    }

    return {
        totalA: (entriesA || []).length,
        totalB: (entriesB || []).length,
        sameCount,
        onlyA,
        onlyB,
        modified,
    };
}

/**
 * Pure, zero-retention full-text matcher for a single worldbook payload.
 * Performs direct case-insensitive exact substring matching (Ctrl+F style, without splitting spaces)
 * across entry title/comment, primary/secondary trigger keys, and body content.
 *
 * @param {any} payload
 * @param {string} query
 * @param {{
 *   searchTitleAndKeys?: boolean,
 *   searchContent?: boolean,
 *   includeDisabled?: boolean,
 *   maxHitsPerBook?: number,
 *   snippetRadius?: number,
 * }} [opts]
 * @returns {{ hits: Array<{ uid: string, title: string, keys: string[], disabled: boolean, constant: boolean, matchedIn: string[], snippet: string, content: string }>, totalMatchesInBook: number }}
 */

export function searchEntriesInPayload(
    payload,
    query,
    {
        searchTitleAndKeys = true,
        searchContent = true,
        includeDisabled = true,
        splitSpaces = false,
        maxHitsPerBook = 8,
        snippetRadius = 46,
    } = {},
) {
    const needle = String(query ?? '').trim().toLowerCase();
    const tokens = splitSpaces ? needle.split(/\s+/).filter(Boolean) : (needle ? [needle] : []);
    if (tokens.length === 0 || (!searchTitleAndKeys && !searchContent)) {
        return { hits: [], totalMatchesInBook: 0 };
    }
    const entriesObj = payload?.entries;
    if (!entriesObj || typeof entriesObj !== 'object') {
        return { hits: [], totalMatchesInBook: 0 };
    }

    const entries = Object.values(entriesObj).filter((e) => e && typeof e === 'object');
    const hits = [];
    let totalMatchesInBook = 0;

    for (let idx = 0; idx < entries.length; idx += 1) {
        const e = entries[idx];
        const disabled = Boolean(e.disable);
        if (!includeDisabled && disabled) continue;

        const comment = String(e.comment ?? '').trim();
        const keysPrimary = Array.isArray(e.key) ? e.key.map((k) => String(k ?? '').trim()).filter(Boolean) : [];
        const keysSecondary = Array.isArray(e.keysecondary) ? e.keysecondary.map((k) => String(k ?? '').trim()).filter(Boolean) : [];
        const allKeys = [...keysPrimary, ...keysSecondary];
        const keysJoined = allKeys.join(', ');
        const content = String(e.content ?? '').trim();

        const commentLower = searchTitleAndKeys ? comment.toLowerCase() : '';
        const keysLower = searchTitleAndKeys ? keysJoined.toLowerCase() : '';
        const contentLower = searchContent ? content.toLowerCase() : '';

        const allMatched = tokens.every(
            (tok) => commentLower.includes(tok) || keysLower.includes(tok) || contentLower.includes(tok),
        );
        if (!allMatched) continue;

        totalMatchesInBook += 1;
        if (hits.length >= maxHitsPerBook) continue;

        const matchedIn = [];
        if (searchTitleAndKeys && tokens.some((tok) => commentLower.includes(tok))) matchedIn.push('标题');
        if (searchTitleAndKeys && tokens.some((tok) => keysLower.includes(tok))) matchedIn.push('触发词');
        if (searchContent && tokens.some((tok) => contentLower.includes(tok))) matchedIn.push('正文');

        // Build a compact snippet centered around the first matched token in content
        let snippet = '';
        if (content) {
            const firstMatch = tokens
                .map((tok) => ({ pos: contentLower.indexOf(tok), len: tok.length }))
                .filter((m) => m.pos >= 0)
                .sort((a, b) => a.pos - b.pos)[0];
            if (firstMatch) {
                const start = Math.max(0, firstMatch.pos - snippetRadius);
                const end = Math.min(content.length, firstMatch.pos + firstMatch.len + snippetRadius);
                snippet = `${start > 0 ? '…' : ''}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${end < content.length ? '…' : ''}`;
            } else {
                const compact = content.replace(/\s+/g, ' ').trim();
                snippet = compact.length > 100 ? `${compact.slice(0, 100)}…` : compact;
            }
        }

        hits.push({
            uid: String(e.uid ?? idx),
            title: comment || keysPrimary.slice(0, 2).join(' / ') || `条目 #${idx + 1}`,
            keys: allKeys.slice(0, 8),
            disabled,
            constant: Boolean(e.constant),
            matchedIn,
            snippet,
            content,
        });
    }

    return { hits, totalMatchesInBook };
}

/**
 * Export portable backup object (excludes transient runtime state).
 * @param {Record<string, any>} settings
 */

export function exportConfigData(settings) {
    const cfg = normalizeSettings(settings);
    return {
        format: 'worldbook-organizer-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
            hideCharBooksByDefault: cfg.hideCharBooksByDefault,
            charBookTitleMode: cfg.charBookTitleMode,
            aliasTitleMode: cfg.aliasTitleMode,
            themePalette: cfg.themePalette,
            themeMode: cfg.themeMode,
            outsideDropdownFollowHostTheme: cfg.outsideDropdownFollowHostTheme,
            includeExtraCharBooks: cfg.includeExtraCharBooks,
            includeEmbeddedNameMatch: cfg.includeEmbeddedNameMatch,
            autoScanNewCharacters: cfg.autoScanNewCharacters,
            importOrganize: cfg.importOrganize,
            autoHideInCharBindPopup: cfg.autoHideInCharBindPopup,
            adaptCharBindPopup: cfg.adaptCharBindPopup,
            adaptPersonaBindPopup: cfg.adaptPersonaBindPopup,
            adaptChatBindPopup: cfg.adaptChatBindPopup,
            adaptMoveEntryPopup: cfg.adaptMoveEntryPopup,
            adaptEnhancedPresetGroups: cfg.adaptEnhancedPresetGroups,
            overrideEnhancedDropdownStyle: cfg.overrideEnhancedDropdownStyle,
            showNativeOptgroups: cfg.showNativeOptgroups,
            pinCurrentChatCharBookInEditor: cfg.pinCurrentChatCharBookInEditor,
            showNativeCharToggleBtn: cfg.showNativeCharToggleBtn,
            nativeQuickActionsMode: cfg.nativeQuickActionsMode,
            showNativeComboBtn: cfg.showNativeComboBtn,
            showNativeExcludeBtn: cfg.showNativeExcludeBtn,
            showNativeEntrySearchBtn: cfg.showNativeEntrySearchBtn,
            entryEditorMonoFont: cfg.entryEditorMonoFont,
            entryEditorTall: cfg.entryEditorTall,
            syncEntryOrderOnDrag: cfg.syncEntryOrderOnDrag,
            entrySearchScope: cfg.entrySearchScope,
            entrySearchInTitle: cfg.entrySearchInTitle,
            entrySearchInContent: cfg.entrySearchInContent,
            entrySearchIncludeDisabled: cfg.entrySearchIncludeDisabled,
            mgrSearchInBookName: cfg.mgrSearchInBookName,
            mgrSearchInCharName: cfg.mgrSearchInCharName,
            mgrSearchInEntries: cfg.mgrSearchInEntries,
            mgrSearchSplitSpaces: cfg.mgrSearchSplitSpaces,
            globalHiddenGroupIds: cfg.globalHiddenGroupIds,
            editorHiddenGroupIds: cfg.editorHiddenGroupIds,
            localOrganizeCategories: cfg.localOrganizeCategories,
            localOrganizeScope: cfg.localOrganizeScope,
            localOrganizeUseAnyPrefix: cfg.localOrganizeUseAnyPrefix,
            localOrganizeCleanTitles: cfg.localOrganizeCleanTitles,
            localOrganizeCustomRules: cfg.localOrganizeCustomRules,
            organizeLastTab: cfg.organizeLastTab,
            aiOrganizeScope: cfg.aiOrganizeScope,
            aiOrganizePresets: cfg.aiOrganizePresets,
            aiOrganizePresetIds: cfg.aiOrganizePresetIds,
            aiOrganizeCustomRule: cfg.aiOrganizeCustomRule,
            aiOrganizeIncludeClues: cfg.aiOrganizeIncludeClues,
            aiOrganizeClueCount: cfg.aiOrganizeClueCount,
            aiOrganizeSnippetLen: cfg.aiOrganizeSnippetLen,
            groupPanelExpanded: cfg.groupPanelExpanded,
            sectionOrderVersion: cfg.sectionOrderVersion,
            sectionOrder: cfg.sectionOrder,
            groups: cfg.groups,
            globalPresets: cfg.globalPresets,
            bookOrders: cfg.bookOrders,
            assignments: cfg.assignments,
            aliases: cfg.aliases,
            notes: cfg.notes,
            charBookOverrides: cfg.charBookOverrides,
            pinnedBooks: cfg.pinnedBooks,
        },
    };
}

/**
 * Import backup JSON into settings safely.
 * @param {Record<string, any>} settings
 * @param {any} rawPayload
 * @returns {{ ok: boolean, error?: string, stats?: { groups: number, assignments: number, aliases: number, globalPresets: number } }}
 */

export function importConfigData(settings, rawPayload) {
    const payload = typeof rawPayload === 'string' ? (() => {
        try { return JSON.parse(rawPayload); } catch { return null; }
    })() : rawPayload;

    if (!payload || typeof payload !== 'object') {
        return { ok: false, error: '无效的 JSON 文件' };
    }
    const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    if (
        !Array.isArray(data.groups) &&
        !Array.isArray(data.globalPresets) &&
        typeof data.assignments !== 'object' &&
        typeof data.aliases !== 'object'
    ) {
        return { ok: false, error: '未在文件中找到分组、组合或别名配置' };
    }

    const mergeInput = { ...settings, ...data };
    if (
        Object.hasOwn(data, 'sectionOrder') &&
        (!Object.hasOwn(data, 'sectionOrderVersion') || data.sectionOrderVersion == null)
    ) {
        mergeInput.sectionOrderVersion = 1;
    }
    const normalized = normalizeSettings(mergeInput);
    Object.assign(settings, normalized);

    return {
        ok: true,
        stats: {
            groups: settings.groups.length,
            assignments: Object.keys(settings.assignments).length,
            aliases: Object.keys(settings.aliases).length,
            globalPresets: settings.globalPresets.length,
        },
    };
}

/**
 * Generate a collision-free Global Worldbook Combo ID.
 * @param {Array<{ id: string }>} [existingPresets=[]]
 * @returns {string}
 */

export function createGlobalPresetId(existingPresets = []) {
    const taken = new Set((existingPresets || []).map((p) => p?.id).filter(Boolean));
    let id = '';
    do {
        id = `cmb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    } while (taken.has(id));
    return id;
}

/**
 * Create or update a saved Global Worldbook Combo in `settings.globalPresets`.
 *
 * @param {Record<string, any>} settings
 * @param {{ id?: string | null, name: string, books: Iterable<string> }} input
 * @returns {{ ok: boolean, created?: boolean, preset?: { id: string, name: string, books: string[], updatedAt: number }, error?: string }}
 */

export function upsertGlobalPreset(settings, { id = null, name, books = [] } = {}) {
    if (!settings) return { ok: false, error: '配置未就绪' };
    const cleanName = String(name ?? '').trim();
    if (!cleanName) return { ok: false, error: '请输入组合名称' };

    const cleanBooks = [
        ...new Set(
            Array.from(books || [])
                .map((b) => String(b ?? '').trim())
                .filter(Boolean),
        ),
    ];
    if (cleanBooks.length === 0) {
        return { ok: false, error: '请至少选择 1 本世界书' };
    }

    if (!Array.isArray(settings.globalPresets)) {
        settings.globalPresets = [];
    }
    const targetId = id ? String(id).trim() : '';
    const dup = settings.globalPresets.find(
        (p) => p && p.id !== targetId && String(p.name || '').trim().toLowerCase() === cleanName.toLowerCase(),
    );
    if (dup) {
        return { ok: false, error: `已存在同名组合「${cleanName}」，请换一个名称` };
    }

    const now = Date.now();
    if (targetId) {
        const idx = settings.globalPresets.findIndex((p) => p && p.id === targetId);
        if (idx >= 0) {
            const updated = {
                ...settings.globalPresets[idx],
                name: cleanName,
                books: cleanBooks,
                updatedAt: now,
            };
            settings.globalPresets[idx] = updated;
            return { ok: true, created: false, preset: updated };
        }
    }

    const created = {
        id: createGlobalPresetId(settings.globalPresets),
        name: cleanName,
        books: cleanBooks,
        updatedAt: now,
    };
    settings.globalPresets.push(created);
    return { ok: true, created: true, preset: created };
}

/**
 * Delete a Global Worldbook Combo by ID.
 * @param {Record<string, any>} settings
 * @param {string} presetId
 * @returns {boolean}
 */

export function deleteGlobalPreset(settings, presetId) {
    const cleanId = String(presetId ?? '').trim();
    if (!settings || !cleanId || !Array.isArray(settings.globalPresets)) return false;
    const prevLen = settings.globalPresets.length;
    settings.globalPresets = settings.globalPresets.filter((p) => p?.id !== cleanId);
    return settings.globalPresets.length !== prevLen;
}

/**
 * Reorder a Global Worldbook Combo up (-1) or down (+1).
 * @param {Record<string, any>} settings
 * @param {string} presetId
 * @param {-1 | 1} delta
 * @returns {boolean}
 */

export function moveGlobalPreset(settings, presetId, delta) {
    const cleanId = String(presetId ?? '').trim();
    if (!settings || !cleanId || !Array.isArray(settings.globalPresets)) return false;
    const idx = settings.globalPresets.findIndex((p) => p?.id === cleanId);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= settings.globalPresets.length) return false;
    const next = [...settings.globalPresets];
    [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
    settings.globalPresets = next;
    return true;
}

/**
 * Find the saved Global Worldbook Combo whose book set exactly equals `activeBooksIterable`.
 * @param {Array<{ id: string, name: string, books: string[] }>} [globalPresets=[]]
 * @param {Iterable<string>} [activeBooksIterable=[]]
 */

export function findMatchingGlobalPreset(globalPresets = [], activeBooksIterable = []) {
    if (!Array.isArray(globalPresets) || globalPresets.length === 0) return null;
    const activeSet = new Set(
        Array.from(activeBooksIterable || [])
            .map((b) => String(b ?? '').trim())
            .filter(Boolean),
    );
    if (activeSet.size === 0) return null;

    for (const preset of globalPresets) {
        if (!preset || !Array.isArray(preset.books) || preset.books.length === 0) continue;
        const pSet = new Set(preset.books.map((b) => String(b ?? '').trim()).filter(Boolean));
        if (pSet.size !== activeSet.size) continue;
        let allMatch = true;
        for (const name of pSet) {
            if (!activeSet.has(name)) {
                allMatch = false;
                break;
            }
        }
        if (allMatch) return preset;
    }
    return null;
}

/**
 * Check whether a worldbook is starred/pinned in settings.
 * @param {Record<string, any>} settings
 * @param {string} worldName
 * @returns {boolean}
 */

export function isBookPinned(settings, worldName) {
    const clean = String(worldName ?? '').trim();
    if (!clean || !Array.isArray(settings?.pinnedBooks)) return false;
    return settings.pinnedBooks.includes(clean);
}

/**
 * Toggle star/pin state for a worldbook in `settings.pinnedBooks`.
 * @param {Record<string, any>} settings
 * @param {string} worldName
 * @returns {boolean} new pinned state
 */

export function togglePinnedBook(settings, worldName) {
    const clean = String(worldName ?? '').trim();
    if (!settings || !clean) return false;
    if (!Array.isArray(settings.pinnedBooks)) settings.pinnedBooks = [];
    const idx = settings.pinnedBooks.indexOf(clean);
    if (idx >= 0) {
        settings.pinnedBooks.splice(idx, 1);
        return false;
    }
    settings.pinnedBooks.unshift(clean);
    return true;
}


export const WORLD_ENTRY_POSITIONS = Object.freeze([
    { value: 0, label: '角色定义前' },
    { value: 1, label: '角色定义后' },
    { value: 2, label: '作者注释前' },
    { value: 3, label: '作者注释后' },
    { value: 4, label: '按深度插入 (@D)' },
    { value: 5, label: '示例消息前' },
    { value: 6, label: '示例消息后' },
    { value: 7, label: 'Outlet' },
]);

/**
 * Parse an optional finite number without coercing `null`, `undefined`, booleans,
 * or empty/whitespace strings into `0`.
 * @param {any} val
 * @returns {number | null}
 */

export function parseOptionalFiniteNumber(val) {
    if (val === null || val === undefined || typeof val === 'boolean') return null;
    if (typeof val === 'string' && val.trim() === '') return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
}

/**
 * Normalize comma / Chinese-comma / newline separated entry keywords into a clean deduplicated array.
 * @param {string | string[]} raw
 * @returns {string[]}
 */

export function normalizeEntryKeywordsInput(raw) {
    const parts = Array.isArray(raw)
        ? raw.map((x) => String(x ?? '').trim())
        : String(raw ?? '').split(/[,\n，、]+/).map((x) => x.trim());
    const out = [];
    const seen = new Set();
    for (const p of parts) {
        if (p && !seen.has(p)) {
            seen.add(p);
            out.push(p);
        }
    }
    return out;
}

/**
 * Resolve an entry's displayIndex using SillyTavern priority without coercing
 * `null` / `''` / booleans to `0` while still preserving legitimate `0`.
 * @param {any} entry
 * @param {string | number} [mapKey]
 * @param {number} [fallbackIdx=0]
 * @returns {number}
 */

export function resolveEntryDisplayIndex(entry, mapKey, fallbackIdx = 0) {
    return (
        parseOptionalFiniteNumber(entry?.displayIndex) ??
        parseOptionalFiniteNumber(entry?.extensions?.display_index) ??
        parseOptionalFiniteNumber(entry?.uid) ??
        parseOptionalFiniteNumber(mapKey) ??
        fallbackIdx
    );
}


function compareEntryUidValues(uidA, uidB) {
    const na = parseOptionalFiniteNumber(uidA);
    const nb = parseOptionalFiniteNumber(uidB);
    if (na !== null && nb !== null && na !== nb) return na - nb;
    return String(uidA ?? '').localeCompare(String(uidB ?? ''));
}


function getEntrySortTitle(item) {
    const direct = String(item?.title ?? item?.comment ?? '').trim();
    if (direct) return direct;
    if (Array.isArray(item?.keys) && item.keys.length > 0) return item.keys.join(' / ');
    if (Array.isArray(item?.key) && item.key.length > 0) return item.key.join(' / ');
    return '';
}

/**
 * Sort projected or raw worldbook entry items without mutating the input array.
 * Supported modes:
 * - `'custom'` (default): `displayIndex` asc -> `order` asc -> `uid` asc
 * - `'order'`: `order` asc -> `displayIndex` asc -> `uid` asc
 * - `'title'`: `title`/`comment`/`keys` `zh-CN` asc -> `displayIndex` asc -> `uid` asc
 *
 * @template T
 * @param {T[]} [items=[]]
 * @param {'custom' | 'order' | 'title'} [sortMode='custom']
 * @returns {T[]}
 */

export function sortEntryListItems(items = [], sortMode = 'custom') {
    const list = Array.isArray(items) ? [...items] : [];
    const mode = sortMode === 'order' || sortMode === 'title' ? sortMode : 'custom';

    const disp = (x) =>
        parseOptionalFiniteNumber(x?.displayIndex) ??
        parseOptionalFiniteNumber(x?.extensions?.display_index) ??
        parseOptionalFiniteNumber(x?.uid) ??
        0;
    const ord = (x) => parseOptionalFiniteNumber(x?.order) ?? 100;

    list.sort((a, b) => {
        if (mode === 'order') {
            return (
                ord(a) - ord(b) ||
                disp(a) - disp(b) ||
                compareEntryUidValues(a?.uid, b?.uid)
            );
        }
        if (mode === 'title') {
            return (
                compareZhCn(getEntrySortTitle(a), getEntrySortTitle(b)) ||
                disp(a) - disp(b) ||
                compareEntryUidValues(a?.uid, b?.uid)
            );
        }
        return (
            disp(a) - disp(b) ||
            ord(a) - ord(b) ||
            compareEntryUidValues(a?.uid, b?.uid)
        );
    });
    return list;
}

/**
 * Compute sequential `displayIndex` (and optional ascending `order`) updates
 * for a full or partial `orderedUids` sequence, preserving unmentioned entries'
 * relative global slots so filtered drag-reordering never collides with hidden rows.
 *
 * @param {Record<string, any> | Array<any>} entries
 * @param {Array<string | number>} [orderedUids=[]]
 * @param {{ syncOrder?: boolean }} [options={}]
 * @returns {{ orderedUids: string[], updatesByUid: Record<string, { key: string, uid: string, displayIndex: number, order?: number }>, updates: Array<{ key: string, uid: string, displayIndex: number, order?: number }>, changed: boolean }}
 */

export function computeReorderedEntries(entries, orderedUids = [], { syncOrder = false } = {}) {
    const rawList = [];
    const seenUids = new Set();

    const pushRaw = (mapKey, e, idx) => {
        if (!e || typeof e !== 'object') return;
        const uid = String(e.uid ?? mapKey ?? idx).trim();
        if (!uid || seenUids.has(uid)) return;
        seenUids.add(uid);
        const hasExplicitDisplay =
            parseOptionalFiniteNumber(e.displayIndex) !== null ||
            parseOptionalFiniteNumber(e.extensions?.display_index) !== null;
        const displayIndex = resolveEntryDisplayIndex(e, mapKey, idx);
        const orderNum = parseOptionalFiniteNumber(e.order);
        const order = orderNum !== null ? orderNum : 100;
        rawList.push({
            key: String(mapKey),
            uid,
            entry: e,
            displayIndex,
            order,
            rawOrder: orderNum,
            hasExplicitDisplay,
        });
    };

    if (Array.isArray(entries)) {
        entries.forEach((e, idx) => {
            pushRaw(String(idx), e, idx);
        });
    } else if (entries && typeof entries === 'object') {
        Object.entries(entries).forEach(([mapKey, e], idx) => {
            pushRaw(mapKey, e, idx);
        });
    }

    if (rawList.length === 0) {
        return { orderedUids: [], updatesByUid: {}, updates: [], changed: false };
    }

    const globalSorted = [...rawList].sort((a, b) => (
        a.displayIndex - b.displayIndex ||
        a.order - b.order ||
        compareEntryUidValues(a.uid, b.uid)
    ));
    const byUid = new Map(globalSorted.map((item) => [item.uid, item]));

    const matchedUids = [];
    const matchedSet = new Set();
    for (const rawUid of Array.isArray(orderedUids) ? orderedUids : []) {
        const uid = String(rawUid ?? '').trim();
        if (uid && byUid.has(uid) && !matchedSet.has(uid)) {
            matchedSet.add(uid);
            matchedUids.push(uid);
        }
    }

    if (matchedUids.length === 0) {
        return { orderedUids: [], updatesByUid: {}, updates: [], changed: false };
    }

    let cursor = 0;
    const mergedGlobal = globalSorted.map((item) => {
        if (!matchedSet.has(item.uid)) return item;
        const nextItem = byUid.get(matchedUids[cursor]);
        cursor += 1;
        return nextItem;
    });

    const allExplicit = globalSorted.every((x) => x.hasExplicitDisplay);
    const disps = globalSorted.map((x) => x.displayIndex);
    const allDistinctNonNeg =
        new Set(disps).size === globalSorted.length &&
        disps.every((d) => Number.isFinite(d) && d >= 0);
    const minDisplayIndex = allExplicit && allDistinctNonNeg ? Math.min(...disps) : 0;

    const finiteNonNegOrders = mergedGlobal
        .map((x) => x.rawOrder)
        .filter((n) => n !== null && n >= 0);
    const baseOrder = finiteNonNegOrders.length > 0 ? Math.min(...finiteNonNegOrders) : 100;

    const updates = [];
    const updatesByUid = {};
    let changed = false;

    mergedGlobal.forEach((item, globalIdx) => {
        const nextDisplayIndex = minDisplayIndex + globalIdx;
        const nextOrder = syncOrder ? baseOrder + globalIdx : item.order;
        if (
            item.displayIndex !== nextDisplayIndex ||
            !item.hasExplicitDisplay ||
            (syncOrder && item.order !== nextOrder)
        ) {
            changed = true;
        }
        const upd = syncOrder
            ? { key: item.key, uid: item.uid, displayIndex: nextDisplayIndex, order: nextOrder }
            : { key: item.key, uid: item.uid, displayIndex: nextDisplayIndex };
        updates.push(upd);
        updatesByUid[item.uid] = upd;
    });

    return {
        orderedUids: mergedGlobal.map((x) => x.uid),
        updatesByUid,
        updates,
        changed,
    };
}

/**
 * Move `draggedUid` before or after `targetUid` and compute the resulting
 * ordered UID list and `displayIndex` (plus optional `order`) update maps.
 *
 * @param {Array<string | any> | Record<string, any>} entries
 * @param {string | number} draggedUid
 * @param {string | number} targetUid
 * @param {boolean | 'before' | 'after'} [insertAfter=false]
 * @param {{ syncOrder?: boolean }} [options={}]
 * @returns {{ changed: boolean, orderedUids: string[], displayIndexMap: Record<string, number>, orderMap: Record<string, number> | null, updatesByUid: Record<string, any> }}
 */

export function reorderEntryUids(
    entries,
    draggedUid,
    targetUid,
    insertAfter = false,
    { syncOrder = false } = {},
) {
    const emptyRes = (uids = []) => ({
        changed: false,
        orderedUids: uids,
        displayIndexMap: {},
        orderMap: syncOrder ? {} : null,
        updatesByUid: {},
    });

    let currentUids = [];
    let isObjectBacked = false;

    if (Array.isArray(entries)) {
        const hasObjects = entries.some((e) => e && typeof e === 'object');
        if (hasObjects) {
            isObjectBacked = true;
            currentUids = sortEntryListItems(entries.filter((e) => e && typeof e === 'object'), 'custom')
                .map((e, idx) => String(e.uid ?? idx).trim())
                .filter(Boolean);
        } else {
            const seen = new Set();
            for (const raw of entries) {
                const id = String(raw ?? '').trim();
                if (id && !seen.has(id)) {
                    seen.add(id);
                    currentUids.push(id);
                }
            }
        }
    } else if (entries && typeof entries === 'object') {
        isObjectBacked = true;
        const list = Object.entries(entries)
            .filter(([, e]) => e && typeof e === 'object')
            .map(([k, e]) => ({
                ...e,
                uid: String(e.uid ?? k).trim(),
                displayIndex: resolveEntryDisplayIndex(e, k, 0),
            }));
        currentUids = sortEntryListItems(list, 'custom').map((e) => e.uid);
    }

    const dragStr = String(draggedUid ?? '').trim();
    const targetStr = String(targetUid ?? '').trim();
    if (!dragStr || !targetStr || dragStr === targetStr) {
        return emptyRes(currentUids);
    }

    const fromIdx = currentUids.indexOf(dragStr);
    const rawTargetIdx = currentUids.indexOf(targetStr);
    if (fromIdx < 0 || rawTargetIdx < 0) {
        return emptyRes(currentUids);
    }

    const nextUids = [...currentUids];
    nextUids.splice(fromIdx, 1);
    const targetIdx = nextUids.indexOf(targetStr);
    const after = insertAfter === true || insertAfter === 'after';
    nextUids.splice(after ? targetIdx + 1 : targetIdx, 0, dragStr);

    const unchanged =
        nextUids.length === currentUids.length &&
        nextUids.every((id, idx) => id === currentUids[idx]);
    if (unchanged) {
        return emptyRes(currentUids);
    }

    if (isObjectBacked) {
        const plan = computeReorderedEntries(entries, nextUids, { syncOrder });
        const displayIndexMap = {};
        const orderMap = syncOrder ? {} : null;
        for (const upd of plan.updates) {
            displayIndexMap[upd.uid] = upd.displayIndex;
            if (syncOrder && Number.isFinite(upd.order)) {
                orderMap[upd.uid] = upd.order;
            }
        }
        return {
            changed: true,
            orderedUids: plan.orderedUids,
            displayIndexMap,
            orderMap,
            updatesByUid: plan.updatesByUid,
        };
    }

    const displayIndexMap = {};
    const orderMap = syncOrder ? {} : null;
    const updatesByUid = {};
    nextUids.forEach((uid, idx) => {
        displayIndexMap[uid] = idx;
        if (syncOrder) {
            orderMap[uid] = 100 + idx;
            updatesByUid[uid] = { uid, displayIndex: idx, order: 100 + idx };
        } else {
            updatesByUid[uid] = { uid, displayIndex: idx };
        }
    });

    return {
        changed: true,
        orderedUids: nextUids,
        displayIndexMap,
        orderMap,
        updatesByUid,
    };
}

/**
 * Project a worldbook JSON payload into lightweight entry rows for fast list rendering
 * without retaining full large entry bodies or dozens of form controls in DOM.
 * @param {any} payload
 * @returns {{ total: number, enabledCount: number, items: Array<{ uid: string, displayIndex: number, title: string, keys: string[], keysecondary: string[], constant: boolean, disable: boolean, selective: boolean, position: number, depth: number, order: number, searchText: string }> }}
 */

export function extractEntryListItems(payload) {
    const entriesObj = payload?.entries;
    if (!entriesObj || typeof entriesObj !== 'object') {
        return { total: 0, enabledCount: 0, items: [] };
    }
    const rawList = Object.entries(entriesObj)
        .filter(([, e]) => e && typeof e === 'object')
        .map(([mapKey, e], rawIdx) => ({
            mapKey,
            e,
            uid: String(e.uid ?? mapKey ?? rawIdx),
            displayIndex: resolveEntryDisplayIndex(e, mapKey, rawIdx),
            order: parseOptionalFiniteNumber(e.order) ?? 100,
        }))
        .sort((a, b) => (
            a.displayIndex - b.displayIndex ||
            a.order - b.order ||
            compareEntryUidValues(a.uid, b.uid)
        ));

    const items = rawList.map(({ mapKey, e, uid, displayIndex, order }, idx) => {
        const keys = Array.isArray(e.key) ? e.key.map((k) => String(k ?? '').trim()).filter(Boolean) : [];
        const keysecondary = Array.isArray(e.keysecondary) ? e.keysecondary.map((k) => String(k ?? '').trim()).filter(Boolean) : [];
        const comment = String(e.comment ?? '').trim();
        const title = comment || keys.slice(0, 2).join(' / ') || `条目 #${idx + 1}`;
        const disable = Boolean(e.disable);
        const constant = Boolean(e.constant);
        const selective = e.selective !== undefined ? Boolean(e.selective) : !constant;
        const posNum = parseOptionalFiniteNumber(e.position);
        const position = posNum !== null && Number.isInteger(posNum) ? posNum : 0;
        const depthNum = parseOptionalFiniteNumber(e.depth);
        const depth = depthNum !== null ? depthNum : 4;
        const searchText = [comment, ...keys, ...keysecondary].join('\n').toLowerCase();
        return {
            uid,
            displayIndex,
            title,
            keys: keys.slice(0, 6),
            keysecondary: keysecondary.slice(0, 4),
            constant,
            disable,
            selective,
            position,
            depth,
            order,
            searchText,
        };
    });
    const enabledCount = items.filter((x) => !x.disable).length;
    return { total: items.length, enabledCount, items };
}

/**
 * Extract editable fields for a single entry by UID (loaded on demand when editing 1 entry).
 * @param {any} payload
 * @param {string | number} uid
 */

export function extractSingleEntryForEdit(payload, uid) {
    const entriesObj = payload?.entries;
    if (!entriesObj || typeof entriesObj !== 'object') return null;
    const targetUid = String(uid);
    let raw = null;
    const direct = Object.hasOwn(entriesObj, targetUid) ? entriesObj[targetUid] : null;
    if (direct && typeof direct === 'object' && (!Array.isArray(entriesObj) || String(direct.uid ?? targetUid) === targetUid)) {
        raw = direct;
    } else {
        for (const [k, e] of Object.entries(entriesObj)) {
            if (e && typeof e === 'object' && String(e.uid ?? k) === targetUid) {
                raw = e;
                break;
            }
        }
    }
    if (!raw) return null;
    const constant = Boolean(raw.constant);
    const posNum = parseOptionalFiniteNumber(raw.position);
    const depthNum = parseOptionalFiniteNumber(raw.depth);
    const orderNum = parseOptionalFiniteNumber(raw.order);
    return {
        uid: String(raw.uid ?? targetUid),
        comment: String(raw.comment ?? ''),
        disable: Boolean(raw.disable),
        constant,
        selective: raw.selective !== undefined ? Boolean(raw.selective) : !constant,
        key: Array.isArray(raw.key) ? raw.key.map((k) => String(k ?? '').trim()).filter(Boolean) : [],
        keysecondary: Array.isArray(raw.keysecondary) ? raw.keysecondary.map((k) => String(k ?? '').trim()).filter(Boolean) : [],
        position: posNum !== null && Number.isInteger(posNum) ? posNum : 0,
        depth: depthNum !== null ? depthNum : 4,
        order: orderNum !== null ? orderNum : 100,
        content: String(raw.content ?? ''),
    };
}

/**
 * Shallow-merge edited core fields onto the original raw worldbook entry object,
 * strictly preserving 100% of undisplayed native fields and any custom/unknown keys!
 *
 * @param {Record<string, any>} rawEntry
 * @param {{
 *   comment?: string,
 *   disable?: boolean,
 *   constant?: boolean,
 *   selective?: boolean,
 *   key?: string[] | string,
 *   keysecondary?: string[] | string,
 *   position?: number,
 *   depth?: number,
 *   order?: number,
 *   content?: string,
 * }} [patch={}]
 * @returns {Record<string, any>}
 */

export function mergeEntryPatchOntoRaw(rawEntry, patch = {}) {
    const base = rawEntry && typeof rawEntry === 'object' ? deepClone(rawEntry) : {};
    const next = { ...base };

    if (patch.comment !== undefined) {
        next.comment = String(patch.comment);
        if (Object.hasOwn(base, 'addMemo')) {
            next.addMemo = Boolean(next.comment.trim());
        }
    }
    if (patch.disable !== undefined) {
        next.disable = Boolean(patch.disable);
    }
    if (patch.constant !== undefined) {
        const prevConstant = Boolean(base.constant);
        next.constant = Boolean(patch.constant);
        if (patch.selective !== undefined) {
            next.selective = Boolean(patch.selective);
        } else if (next.constant !== prevConstant) {
            next.selective = !next.constant;
        }
    } else if (patch.selective !== undefined) {
        next.selective = Boolean(patch.selective);
    }
    if (patch.key !== undefined) {
        next.key = normalizeEntryKeywordsInput(patch.key);
    }
    if (patch.keysecondary !== undefined) {
        next.keysecondary = normalizeEntryKeywordsInput(patch.keysecondary);
    }
    if (patch.position !== undefined) {
        const pos = parseOptionalFiniteNumber(patch.position);
        next.position = pos !== null && Number.isInteger(pos) && pos >= 0 && pos <= 7 ? pos : (base.position ?? 0);
    }
    if (patch.depth !== undefined) {
        const d = parseOptionalFiniteNumber(patch.depth);
        next.depth = d !== null && d >= 0 ? Math.round(d) : (base.depth ?? 4);
    }
    if (patch.order !== undefined) {
        const ord = parseOptionalFiniteNumber(patch.order);
        next.order = ord !== null ? Math.round(ord) : (base.order ?? 100);
    }
    if (patch.content !== undefined) {
        next.content = String(patch.content);
    }
    return next;
}

/**
 * Create a new native-compatible worldbook entry object with the next free integer UID.
 * @param {Record<string, any>} entriesObj
 * @param {Record<string, any>} [initialFields={}]
 * @returns {Record<string, any>}
 */

export function createNewRawWorldEntry(entriesObj = {}, initialFields = {}) {
    const taken = new Set();
    let maxDisplay = -1;
    for (const [k, e] of Object.entries(entriesObj || {})) {
        const uidNum = Number(e?.uid ?? k);
        if (Number.isInteger(uidNum) && uidNum >= 0) taken.add(uidNum);
        const disp = Number(e?.displayIndex);
        if (Number.isFinite(disp) && disp > maxDisplay) maxDisplay = disp;
    }
    let freeUid = 0;
    while (taken.has(freeUid)) freeUid += 1;

    const template = {
        uid: freeUid,
        key: [],
        keysecondary: [],
        comment: '',
        content: '',
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: false,
        order: 100,
        position: 0,
        disable: false,
        ignoreBudget: false,
        excludeRecursion: false,
        preventRecursion: false,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: 4,
        outletName: '',
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        triggers: [],
        displayIndex: maxDisplay + 1,
    };
    return mergeEntryPatchOntoRaw(template, initialFields);
}

/**
 * Auto-detect an existing custom group whose name matches common sensitive/NSFW synonyms
 * (`nsfw`, `成人`, `18+`, `r18`, `涩`, `色`, `肉`, `车`, or bounded `h` / `h向` / `h文`),
 * without false-matching unrelated English words like `History` or `Character`.
 *
 * @param {Array<{ id: string, name: string, color?: string }>} [groups=[]]
 * @returns {{ id: string, name: string, color?: string } | null}
 */

export function findSensitiveTargetGroup(groups = []) {
    const list = Array.isArray(groups) ? groups.filter((g) => g && typeof g.name === 'string' && g.name.trim()) : [];
    if (list.length === 0) return null;

    const exactNsfw = list.find((g) => g.name.trim().toLowerCase() === 'nsfw');
    if (exactNsfw) return exactNsfw;

    const mainPattern = /(?:nsfw|18\+|r-?18g?|成人|涩|色情|色色|黄色|肉文|肉向|炖肉|肉麻|开车|飙车|车文|车速|黄文|工口)/i;
    const standaloneCjk = /(?:^|[\s/·\-_|【\[(\（])(?:色|肉|车)(?:$|[\s/·\-_|】\])\）])/;
    const hPattern = /(?:^|[^a-z])h(?:[^a-z]|$)|h向|h文/i;
    return list.find((g) => {
        const name = g.name.trim();
        return mainPattern.test(name) || standaloneCjk.test(name) || hPattern.test(name);
    }) || null;
}

/**
 * Lightweight, deterministic token estimator for worldbook entry content
 * (handles mixed CJK and Latin text without loading a heavy tokenizer).
 * @param {string} text
 * @returns {number}
 */

export function estimateEntryTokens(text) {
    const s = String(text ?? '');
    if (!s) return 0;
    const cjkMatches = s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/g);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    const nonCjkCount = s.length - cjkCount;
    return Math.max(1, Math.round(cjkCount * 1.35 + nonCjkCount * 0.28));
}

/**
 * Partition worldbook picker candidates for `openCreateOrRenameGroupModal` into:
 * - `currentMembers`: existing members when editing (or seeded `initialBookName`)
 * - `ungroupedBooks`: ungrouped candidates not already in `currentMembers`
 * - `otherGroups`: books already assigned to OTHER custom groups, grouped by original group
 * - `allCandidates`: flat deduplicated list across all three partitions
 *
 * @param {object} params
 * @param {any} params.classification
 * @param {string | null} [params.groupId=null]
 * @param {string | null} [params.initialBookName=null]
 */

export function partitionGroupPickerBooks({ classification, groupId = null, initialBookName = null } = {}) {
    const byName = classification?.byName instanceof Map ? classification.byName : new Map();
    const ungroupedRaw = Array.isArray(classification?.ungroupedBooks) ? classification.ungroupedBooks : [];
    const customGroupsRaw = Array.isArray(classification?.customGroups) ? classification.customGroups : [];

    const currentMemberSet = new Set();
    if (groupId) {
        const targetGroup = customGroupsRaw.find((g) => g.id === groupId);
        for (const b of targetGroup?.books || []) {
            if (b?.realName) currentMemberSet.add(b.realName);
        }
    } else if (initialBookName) {
        currentMemberSet.add(initialBookName);
    }

    const currentMembers = [];
    const seenCurrent = new Set();
    for (const name of currentMemberSet) {
        const meta = byName.get(name);
        if (meta && !seenCurrent.has(meta.realName)) {
            seenCurrent.add(meta.realName);
            currentMembers.push(meta);
        }
    }

    const ungroupedBooks = ungroupedRaw.filter((b) => b?.realName && !currentMemberSet.has(b.realName));
    const otherGroups = customGroupsRaw
        .filter((g) => g && g.id !== groupId)
        .map((g) => ({
            id: g.id,
            name: g.name,
            color: g.color || '#5b8def',
            books: (g.books || []).filter((b) => b?.realName && !currentMemberSet.has(b.realName)),
        }))
        .filter((g) => g.books.length > 0);

    const allCandidates = [
        ...currentMembers,
        ...ungroupedBooks,
        ...otherGroups.flatMap((g) => g.books),
    ];

    return {
        currentMemberSet,
        currentMembers,
        ungroupedBooks,
        otherGroups,
        otherTotalCount: otherGroups.reduce((sum, g) => sum + g.books.length, 0),
        allCandidates,
    };
}

