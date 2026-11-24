/**
 * Worldbook Organizer — Pure core logic (DOM-free, unit-testable).
 *
 * Design guarantees:
 * 1. Never mutates real worldbook filenames on disk -> all character, persona,
 *    chat, preset, and script bindings stay 100% intact.
 * 2. Pure in-memory character binding detection + persistent lazy-load cache
 *    -> zero polling and zero full-disk scanning.
 * 3. Deterministic grouping, character-book hiding, virtual aliasing, search,
 *    and AI organize prompt/response parsing with undo support.
 */

export const MODULE_NAME = 'worldbook_organizer';

export const SPECIAL_GROUPS = Object.freeze({
    DEFAULT: '__default__',
    ALL: '__all__',
    UNGROUPED: '__ungrouped__',
    CHARACTER: '__char__',
});

export const GROUP_COLOR_PALETTE = Object.freeze([
    '#5b8def',
    '#4caf84',
    '#e09f3e',
    '#d96b6b',
    '#9b72cf',
    '#3da5b8',
    '#d977a6',
    '#8c99a6',
]);

export const DEFAULT_SETTINGS = Object.freeze({
    version: 1,
    sectionOrderVersion: 2,
    hideCharBooksByDefault: true,
    showCharBooks: false,
    charBookTitleMode: 'char_with_sub', // 'char_with_sub' | 'char_only' | 'original'
    aliasTitleMode: 'alias_with_sub',   // 'alias_with_sub' | 'alias_only'
    themePalette: 'classic',            // 'classic' | 'ink' | 'warm' | 'sakura' | 'host'
    themeMode: 'auto',                  // 'auto' | 'light' | 'dark'
    includeExtraCharBooks: true,
    includeEmbeddedNameMatch: true,
    autoImportMissingCharBook: false,
    autoHideInCharBindPopup: true,
    showNativeOptgroups: true,
    groupPanelExpanded: false,
    charGroupCollapsed: true,
    ungroupedCollapsed: false,
    dropdownCollapsed: {},
    activeFilterGroupId: SPECIAL_GROUPS.DEFAULT,
    sectionOrder: [SPECIAL_GROUPS.UNGROUPED, SPECIAL_GROUPS.CHARACTER],
    apiProvider: 'host', // 'host' | 'custom'
    activeApiChannelId: '',
    apiChannels: [], // Array<{ id, name, baseUrl, apiKey, model }>
    groups: [],
    assignments: {},
    aliases: {},
    notes: {},
    charBookOverrides: {},
    cachedCharBindings: {},
    undoSnapshots: [],
});

/**
 * Safe structured clone fallback for older WebViews.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepClone(value) {
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

/**
 * Strip extension from a character avatar filename (e.g. "Alice.png" -> "Alice").
 * Matches SillyTavern's `getCharaFilename` key used in `world_info.charLore`.
 * @param {string | null | undefined} avatar
 * @returns {string}
 */
export function charaFileName(avatar) {
    return String(avatar ?? '').replace(/\.[^/.]+$/, '');
}

/**
 * Normalize and backfill persisted settings without discarding unknown user keys.
 * @param {Record<string, any> | null | undefined} raw
 * @returns {Record<string, any>}
 */
export function normalizeSettings(raw) {
    const base = deepClone(DEFAULT_SETTINGS);
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const merged = { ...base, ...source };

    if (!Array.isArray(merged.groups)) merged.groups = [];
    merged.groups = merged.groups
        .filter((g) => g && typeof g === 'object' && typeof g.id === 'string' && g.id.trim())
        .map((g, idx) => ({
            id: g.id.trim(),
            name: String(g.name ?? '未命名分组').trim() || '未命名分组',
            color: typeof g.color === 'string' && g.color.trim()
                ? g.color.trim()
                : GROUP_COLOR_PALETTE[idx % GROUP_COLOR_PALETTE.length],
            collapsed: Boolean(g.collapsed),
        }));

    for (const dictKey of ['assignments', 'aliases', 'notes', 'charBookOverrides', 'cachedCharBindings', 'dropdownCollapsed']) {
        if (!merged[dictKey] || typeof merged[dictKey] !== 'object' || Array.isArray(merged[dictKey])) {
            merged[dictKey] = {};
        }
    }

    if (!Array.isArray(merged.undoSnapshots)) {
        merged.undoSnapshots = [];
    }

    if (merged.apiProvider !== 'custom') {
        merged.apiProvider = 'host';
    }
    if (!Array.isArray(merged.apiChannels)) {
        merged.apiChannels = [];
    }
    merged.apiChannels = merged.apiChannels
        .filter((ch) => ch && typeof ch === 'object' && typeof ch.id === 'string' && ch.id.trim())
        .map((ch) => ({
            id: ch.id.trim(),
            name: String(ch.name ?? '自定义 API').trim() || '自定义 API',
            baseUrl: String(ch.baseUrl ?? ch.url ?? '').trim(),
            apiKey: String(ch.apiKey ?? ch.key ?? '').trim(),
            model: String(ch.model ?? '').trim(),
        }));
    if (
        typeof merged.activeApiChannelId !== 'string' ||
        (merged.activeApiChannelId && !merged.apiChannels.some((c) => c.id === merged.activeApiChannelId))
    ) {
        merged.activeApiChannelId = merged.apiChannels[0]?.id || '';
    }

    if (!['char_with_sub', 'char_only', 'original'].includes(merged.charBookTitleMode)) {
        merged.charBookTitleMode = DEFAULT_SETTINGS.charBookTitleMode;
    }
    if (!['alias_with_sub', 'alias_only'].includes(merged.aliasTitleMode)) {
        merged.aliasTitleMode = DEFAULT_SETTINGS.aliasTitleMode;
    }
    if (!['classic', 'ink', 'warm', 'sakura', 'host'].includes(merged.themePalette)) {
        merged.themePalette = DEFAULT_SETTINGS.themePalette;
    }
    if (!['auto', 'light', 'dark'].includes(merged.themeMode)) {
        merged.themeMode = DEFAULT_SETTINGS.themeMode;
    }

    const validGroupIds = new Set(merged.groups.map((g) => g.id));
    const specialSet = new Set(Object.values(SPECIAL_GROUPS));
    if (!specialSet.has(merged.activeFilterGroupId) && !validGroupIds.has(merged.activeFilterGroupId)) {
        merged.activeFilterGroupId = SPECIAL_GROUPS.DEFAULT;
    }

    // Normalize unified sectionOrder containing all custom groups + __ungrouped__ + __char__
    // Default order places custom groups first, general/ungrouped next, and character books at the bottom.
    const allowedSectionIds = new Set([
        ...merged.groups.map((g) => g.id),
        SPECIAL_GROUPS.UNGROUPED,
        SPECIAL_GROUPS.CHARACTER,
    ]);
    const rawOrder = Array.isArray(merged.sectionOrder) ? merged.sectionOrder : [];
    const cleanedOrder = [];
    const seenOrder = new Set();
    for (const id of rawOrder) {
        if (typeof id === 'string' && allowedSectionIds.has(id) && !seenOrder.has(id)) {
            seenOrder.add(id);
            cleanedOrder.push(id);
        }
    }
    // Any newly present custom groups not yet in sectionOrder are inserted
    // after existing custom groups and before builtin sections (`__ungrouped__`, `__char__`).
    const missingCustom = merged.groups.map((g) => g.id).filter((id) => !seenOrder.has(id));
    const finalOrder = [...cleanedOrder];
    if (missingCustom.length > 0) {
        const firstBuiltinIdx = finalOrder.findIndex(
            (id) => id === SPECIAL_GROUPS.UNGROUPED || id === SPECIAL_GROUPS.CHARACTER,
        );
        if (firstBuiltinIdx >= 0) {
            finalOrder.splice(firstBuiltinIdx, 0, ...missingCustom);
        } else {
            finalOrder.push(...missingCustom);
        }
    }
    for (const builtin of [SPECIAL_GROUPS.UNGROUPED, SPECIAL_GROUPS.CHARACTER]) {
        if (!seenOrder.has(builtin)) finalOrder.push(builtin);
    }

    // One-time v1 -> v2 migration: if user still had legacy default [..., __char__, __ungrouped__],
    // place general/ungrouped above character worldbooks so character books default to the bottom.
    const prevOrderVer = Number(source.sectionOrderVersion || 1);
    if (prevOrderVer < 2 && finalOrder.length >= 2) {
        const last = finalOrder[finalOrder.length - 1];
        const secondLast = finalOrder[finalOrder.length - 2];
        if (secondLast === SPECIAL_GROUPS.CHARACTER && last === SPECIAL_GROUPS.UNGROUPED) {
            finalOrder[finalOrder.length - 2] = SPECIAL_GROUPS.UNGROUPED;
            finalOrder[finalOrder.length - 1] = SPECIAL_GROUPS.CHARACTER;
        }
    }
    merged.sectionOrderVersion = 2;
    merged.sectionOrder = finalOrder;

    return merged;
}

/**
 * Reorder a section ID up (-1) or down (+1) in `settings.sectionOrder`,
 * keeping `settings.groups` order synchronized for custom groups.
 * @param {Record<string, any>} settings
 * @param {string} sectionId
 * @param {-1 | 1} delta
 * @returns {boolean}
 */
export function moveSectionOrder(settings, sectionId, delta) {
    const normalized = normalizeSettings(settings);
    const order = [...normalized.sectionOrder];
    const idx = order.indexOf(sectionId);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= order.length) return false;
    [order[idx], order[targetIdx]] = [order[targetIdx], order[idx]];
    settings.sectionOrder = order;

    // Keep custom groups array in the same relative order
    const groupById = new Map((settings.groups || []).map((g) => [g.id, g]));
    settings.groups = order.filter((id) => groupById.has(id)).map((id) => groupById.get(id));
    return true;
}

/**
 * Promote a section ID to the very first slot of `settings.sectionOrder`
 * (e.g. bringing `角色世界书` to the top whenever the user toggles it ON).
 * @param {Record<string, any>} settings
 * @param {string} sectionId
 */
export function promoteSectionToTop(settings, sectionId) {
    const normalized = normalizeSettings(settings);
    const nextOrder = [sectionId, ...normalized.sectionOrder.filter((id) => id !== sectionId)];
    settings.sectionOrder = nextOrder;
    const groupById = new Map((settings.groups || []).map((g) => [g.id, g]));
    settings.groups = nextOrder.filter((id) => groupById.has(id)).map((id) => groupById.get(id));
}

/**
 * Reorder a section ID by dragging it before or after a target section ID,
 * keeping `settings.groups` order synchronized for custom groups.
 * @param {Record<string, any>} settings
 * @param {string} draggedId
 * @param {string} targetId
 * @param {'before' | 'after'} [position='before']
 * @returns {boolean}
 */
export function reorderSection(settings, draggedId, targetId, position = 'before') {
    if (!draggedId || !targetId || draggedId === targetId) return false;
    const normalized = normalizeSettings(settings);
    const order = [...normalized.sectionOrder];
    const fromIdx = order.indexOf(draggedId);
    const rawTargetIdx = order.indexOf(targetId);
    if (fromIdx < 0 || rawTargetIdx < 0) return false;

    order.splice(fromIdx, 1);
    const targetIdx = order.indexOf(targetId);
    const insertIdx = position === 'after' ? targetIdx + 1 : targetIdx;
    order.splice(insertIdx, 0, draggedId);

    const unchanged = order.every((id, i) => id === normalized.sectionOrder[i]);
    if (unchanged) return false;

    settings.sectionOrder = order;
    const groupById = new Map((settings.groups || []).map((g) => [g.id, g]));
    settings.groups = order.filter((id) => groupById.has(id)).map((id) => groupById.get(id));
    return true;
}

/**
 * Append a new custom group in chronological creation order:
 * first-created -> second-created -> ... -> ungrouped -> character worldbooks.
 * @param {Record<string, any>} settings
 * @param {{ name: string, color?: string }} input
 */
export function addCustomGroup(settings, { name, color }) {
    const normalized = normalizeSettings(settings);
    const group = {
        id: createGroupId(normalized.groups),
        name: String(name || '').trim() || '未命名分组',
        color: color || GROUP_COLOR_PALETTE[normalized.groups.length % GROUP_COLOR_PALETTE.length],
        collapsed: false,
    };
    settings.groups = [...normalized.groups, group];
    const nextOrder = normalized.sectionOrder.filter((id) => id !== group.id);
    const firstBuiltinIdx = nextOrder.findIndex(
        (id) => id === SPECIAL_GROUPS.UNGROUPED || id === SPECIAL_GROUPS.CHARACTER,
    );
    if (firstBuiltinIdx >= 0) {
        nextOrder.splice(firstBuiltinIdx, 0, group.id);
    } else {
        nextOrder.push(group.id);
    }
    settings.sectionOrder = nextOrder;
    return group;
}

/**
 * Generate a collision-free custom group ID.
 * @param {Array<{ id: string }>} existingGroups
 * @returns {string}
 */
export function createGroupId(existingGroups = []) {
    const taken = new Set(existingGroups.map((g) => g.id));
    let id = '';
    do {
        id = `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    } while (taken.has(id));
    return id;
}

/**
 * Incrementally update cached character-world bindings from in-memory `characters`.
 * Supports `lazyLoadCharacters: true`: shallow characters reuse cached bindings
 * instead of triggering disk reads or losing their classification.
 *
 * @param {Record<string, { name: string, primary: string | null, embedded: string | null }>} cachedBindings
 * @param {Array<any>} characters
 * @returns {{ cached: Record<string, { name: string, primary: string | null, embedded: string | null }>, changed: boolean }}
 */
export function updateCachedCharBindings(cachedBindings, characters) {
    const next = { ...(cachedBindings || {}) };
    let changed = false;

    if (!Array.isArray(characters) || characters.length === 0) {
        return { cached: next, changed: false };
    }

    const liveAvatars = new Set();

    for (const ch of characters) {
        const avatar = String(ch?.avatar ?? '').trim();
        if (!avatar) continue;
        liveAvatars.add(avatar);

        const charName = String(ch?.name || ch?.data?.name || charaFileName(avatar)).trim() || avatar;
        const isShallow = Boolean(ch?.shallow);
        const existing = next[avatar];

        if (isShallow) {
            // Keep previously learned primary/embedded bindings, only refresh display name if needed.
            if (existing && existing.name !== charName) {
                next[avatar] = { ...existing, name: charName };
                changed = true;
            }
            continue;
        }

        const rawPrimary = ch?.data?.extensions?.world;
        const primary = typeof rawPrimary === 'string' && rawPrimary.trim() ? rawPrimary.trim() : null;

        let embedded = null;
        let embeddedEntryCount = 0;
        if (ch?.data?.character_book && typeof ch.data.character_book === 'object') {
            const entries = ch.data.character_book.entries;
            embeddedEntryCount = Array.isArray(entries)
                ? entries.length
                : (entries && typeof entries === 'object' ? Object.keys(entries).length : 0);
            const rawEmb = ch.data.character_book.name || `${charName}'s Lorebook`;
            if (typeof rawEmb === 'string' && rawEmb.trim()) {
                embedded = rawEmb.trim();
            }
        }

        if (primary || embedded) {
            if (
                !existing ||
                existing.name !== charName ||
                existing.primary !== primary ||
                existing.embedded !== embedded ||
                existing.embeddedEntryCount !== embeddedEntryCount ||
                existing.scanned !== true
            ) {
                next[avatar] = {
                    name: charName,
                    primary,
                    embedded,
                    embeddedEntryCount,
                    scanned: true,
                };
                changed = true;
            }
        } else if (!existing || existing.scanned !== true || existing.primary || existing.embedded) {
            // Remember scanned characters with no bindings too so shallow mode never re-scans them!
            next[avatar] = {
                name: charName,
                primary: null,
                embedded: null,
                embeddedEntryCount: 0,
                scanned: true,
            };
            changed = true;
        }
    }

    // Remove deleted characters from cache (only when character list is loaded).
    for (const avatar of Object.keys(next)) {
        if (!liveAvatars.has(avatar)) {
            delete next[avatar];
            changed = true;
        }
    }

    return { cached: next, changed };
}

/**
 * Find shallow characters that have not been scanned into cache yet.
 * @param {Array<any>} characters
 * @param {Record<string, any>} cachedBindings
 * @returns {Array<{ chid: number, avatar: string, name: string }>}
 */
export function findUnscannedShallowCharacters(characters = [], cachedBindings = {}) {
    const out = [];
    if (!Array.isArray(characters)) return out;
    characters.forEach((ch, chid) => {
        const avatar = String(ch?.avatar ?? '').trim();
        if (!avatar || !ch?.shallow) return;
        const cached = cachedBindings?.[avatar];
        if (!cached || cached.scanned !== true) {
            out.push({
                chid,
                avatar,
                name: String(ch?.name || ch?.data?.name || charaFileName(avatar)).trim() || avatar,
            });
        }
    });
    return out;
}

/**
 * Find characters whose embedded `character_book` has entries and can be imported
 * cleanly without overwriting any existing worldbook file.
 * @param {object} params
 * @param {Array<any>} params.characters
 * @param {Set<string>} params.worldNamesSet
 * @param {Record<string, any>} [params.cachedCharBindings={}]
 * @returns {Array<{ chid: number, avatar: string, charName: string, importName: string, entryCount: number, reason: 'missing' | 'unbound' }>}
 */
export function findCardsWithUnimportedBooks({
    characters = [],
    worldNamesSet = new Set(),
    cachedCharBindings = {},
}) {
    const out = [];
    if (!Array.isArray(characters)) return out;

    characters.forEach((ch, chid) => {
        const avatar = String(ch?.avatar ?? '').trim();
        if (!avatar) return;
        const charName = String(ch?.name || ch?.data?.name || charaFileName(avatar)).trim() || avatar;
        const isShallow = Boolean(ch?.shallow);
        const cached = cachedCharBindings?.[avatar];

        let primary = '';
        let embeddedName = '';
        let entryCount = 0;

        if (isShallow) {
            if (!cached) return;
            primary = String(cached.primary || '').trim();
            embeddedName = String(cached.embedded || '').trim();
            entryCount = Number(cached.embeddedEntryCount || 0);
        } else {
            primary = String(ch?.data?.extensions?.world || '').trim();
            const book = ch?.data?.character_book;
            if (book && typeof book === 'object') {
                const entries = book.entries;
                entryCount = Array.isArray(entries)
                    ? entries.length
                    : (entries && typeof entries === 'object' ? Object.keys(entries).length : 0);
                embeddedName = String(book.name || `${charName}'s Lorebook`).trim();
            }
        }

        if (!embeddedName || entryCount <= 0) return;

        // Already bound to an existing worldbook -> no import needed
        if (primary && worldNamesSet.has(primary)) return;

        const targetName = primary || embeddedName;
        // Never propose overwriting an existing worldbook with the same name
        if (worldNamesSet.has(targetName)) return;

        out.push({
            chid,
            avatar,
            charName,
            importName: targetName,
            entryCount,
            reason: primary ? 'missing' : 'unbound',
        });
    });

    return out;
}

/**
 * Summarize character-to-worldbook coverage so users immediately know why
 * character count and recognized worldbook count differ (e.g. 71 cards vs 70 books).
 *
 * @param {object} params
 * @param {Array<any>} params.characters
 * @param {Map<string, Array<{ avatar: string, charName: string, source: string }>>} params.bindingMap
 * @param {Set<string>} params.worldNamesSet
 * @param {Record<string, any>} [params.cachedCharBindings={}]
 */
export function summarizeCharacterWorldCoverage({
    characters = [],
    bindingMap = new Map(),
    worldNamesSet = new Set(),
    cachedCharBindings = {},
}) {
    const boundAvatars = new Set();
    const sharedBooks = [];
    const booksByAvatar = new Map();
    const liveAvatarSet = new Set(
        (characters || []).map((c) => String(c?.avatar ?? '').trim()).filter(Boolean),
    );
    const orphanExtraBooks = [];

    for (const [worldName, owners] of bindingMap.entries()) {
        for (const o of owners) {
            boundAvatars.add(o.avatar);
            if (!liveAvatarSet.has(o.avatar)) {
                orphanExtraBooks.push({ worldName, charName: o.charName, source: o.source });
            } else {
                let list = booksByAvatar.get(o.avatar);
                if (!list) {
                    list = { avatar: o.avatar, charName: o.charName, books: [] };
                    booksByAvatar.set(o.avatar, list);
                }
                list.books.push({ worldName, source: o.source });
            }
        }
        const uniqueOwnerMap = new Map();
        for (const o of owners) {
            if (!uniqueOwnerMap.has(o.avatar)) {
                uniqueOwnerMap.set(o.avatar, { avatar: o.avatar, charName: o.charName });
            }
        }
        if (uniqueOwnerMap.size > 1) {
            const ownerList = [...uniqueOwnerMap.values()];
            sharedBooks.push({
                worldName,
                charNames: ownerList.map((x) => x.charName),
                owners: ownerList,
            });
        }
    }

    const multiBookChars = [];
    for (const info of booksByAvatar.values()) {
        if (info.books.length > 1) {
            multiBookChars.push(info);
        }
    }

    const unboundChars = [];
    const missingFileChars = [];

    for (const ch of characters || []) {
        const avatar = String(ch?.avatar ?? '').trim();
        if (!avatar) continue;
        if (boundAvatars.has(avatar)) continue;

        const charName = String(ch?.name || ch?.data?.name || charaFileName(avatar)).trim() || avatar;
        const cached = cachedCharBindings?.[avatar];
        const primary = ch?.shallow
            ? String(cached?.primary || '').trim()
            : String(ch?.data?.extensions?.world || '').trim();

        if (primary && !worldNamesSet.has(primary)) {
            missingFileChars.push({ avatar, charName, missingWorld: primary });
        } else {
            unboundChars.push({ avatar, charName, shallow: Boolean(ch?.shallow && cached?.scanned !== true) });
        }
    }

    return {
        unboundChars,
        missingFileChars,
        sharedBooks,
        multiBookChars,
        orphanExtraBooks,
    };
}

/**
 * Generate a collision-free API channel ID.
 * @param {Array<{ id: string }>} existingChannels
 */
export function createApiChannelId(existingChannels = []) {
    const taken = new Set(existingChannels.map((c) => c.id));
    let id = '';
    do {
        id = `api_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    } while (taken.has(id));
    return id;
}

/**
 * Build a Map<worldName, Array<{ avatar: string, charName: string, source: 'primary' | 'extra' | 'embedded' }>>
 * purely from in-memory data + cache (zero disk I/O).
 *
 * @param {object} params
 * @param {Array<any>} params.characters
 * @param {Array<{ name: string, extraBooks?: string[] }>} params.charLore
 * @param {Record<string, { name: string, primary: string | null, embedded: string | null }>} params.cachedCharBindings
 * @param {Set<string>} [params.worldNamesSet]
 * @param {boolean} [params.includeExtraCharBooks=true]
 * @param {boolean} [params.includeEmbeddedNameMatch=true]
 * @returns {Map<string, Array<{ avatar: string, charName: string, source: 'primary' | 'extra' | 'embedded' }>>}
 */
export function buildCharacterBindingIndex({
    characters = [],
    charLore = [],
    cachedCharBindings = {},
    worldNamesSet = null,
    includeExtraCharBooks = true,
    includeEmbeddedNameMatch = true,
}) {
    /** @type {Map<string, Array<{ avatar: string, charName: string, source: 'primary' | 'extra' | 'embedded' }>>} */
    const bindingMap = new Map();
    const charByFileName = new Map();

    const addBinding = (worldName, avatar, charName, source) => {
        const cleanWorld = String(worldName ?? '').trim();
        if (!cleanWorld) return;
        if (worldNamesSet && worldNamesSet.size > 0 && !worldNamesSet.has(cleanWorld)) return;

        let list = bindingMap.get(cleanWorld);
        if (!list) {
            list = [];
            bindingMap.set(cleanWorld, list);
        }
        const existing = list.find((item) => item.avatar === avatar);
        if (existing) {
            // Upgrade precedence: primary > extra > embedded
            const rank = { primary: 3, extra: 2, embedded: 1 };
            if (rank[source] > rank[existing.source]) {
                existing.source = source;
            }
            return;
        }
        list.push({ avatar, charName, source });
    };

    const charList = Array.isArray(characters) ? characters : [];
    for (const ch of charList) {
        const avatar = String(ch?.avatar ?? '').trim();
        if (!avatar) continue;
        const charName = String(ch?.name || ch?.data?.name || charaFileName(avatar)).trim() || avatar;
        charByFileName.set(charaFileName(avatar), { avatar, charName });

        const isShallow = Boolean(ch?.shallow);
        const cached = cachedCharBindings?.[avatar];

        const primary = isShallow
            ? cached?.primary
            : (typeof ch?.data?.extensions?.world === 'string' ? ch.data.extensions.world.trim() : null);

        if (primary) {
            addBinding(primary, avatar, charName, 'primary');
        }

        if (includeEmbeddedNameMatch) {
            const embedded = isShallow
                ? cached?.embedded
                : (ch?.data?.character_book
                    ? String(ch.data.character_book.name || `${charName}'s Lorebook`).trim()
                    : null);
            if (embedded) {
                addBinding(embedded, avatar, charName, 'embedded');
            }
        }
    }

    if (includeExtraCharBooks && Array.isArray(charLore)) {
        for (const entry of charLore) {
            const keyName = String(entry?.name ?? '').trim();
            if (!keyName || !Array.isArray(entry?.extraBooks)) continue;
            const matchedChar = charByFileName.get(keyName);
            const avatar = matchedChar?.avatar || `${keyName}.png`;
            const charName = matchedChar?.charName || keyName;
            for (const book of entry.extraBooks) {
                addBinding(book, avatar, charName, 'extra');
            }
        }
    }

    return bindingMap;
}

/**
 * Build a Map<worldName, string[]> of User Personas referencing a worldbook.
 * Read purely from in-memory `powerUserSettings`.
 * @param {Record<string, any> | null | undefined} powerUserSettings
 * @returns {Map<string, string[]>}
 */
export function buildPersonaBindingIndex(powerUserSettings) {
    /** @type {Map<string, string[]>} */
    const map = new Map();
    const descs = powerUserSettings?.persona_descriptions;
    const names = powerUserSettings?.personas || {};
    if (!descs || typeof descs !== 'object') return map;

    for (const [pid, desc] of Object.entries(descs)) {
        const lorebook = typeof desc?.lorebook === 'string' ? desc.lorebook.trim() : '';
        if (!lorebook) continue;
        const personaName = String(names[pid] || pid).trim();
        let list = map.get(lorebook);
        if (!list) {
            list = [];
            map.set(lorebook, list);
        }
        if (!list.includes(personaName)) {
            list.push(personaName);
        }
    }
    return map;
}

/**
 * Count how many worldbooks each character avatar owns, so duplicate display names
 * (e.g. a character with both a primary and an extra lorebook) are cleanly disambiguated.
 * @param {Map<string, Array<{ avatar: string, charName: string, source: string }>>} bindingMap
 * @returns {Map<string, Array<{ worldName: string, source: string }>>}
 */
export function buildCharBooksCountMap(bindingMap) {
    /** @type {Map<string, Array<{ worldName: string, source: string }>>} */
    const perChar = new Map();
    for (const [worldName, owners] of bindingMap.entries()) {
        for (const owner of owners) {
            let list = perChar.get(owner.avatar);
            if (!list) {
                list = [];
                perChar.set(owner.avatar, list);
            }
            list.push({ worldName, source: owner.source });
        }
    }
    return perChar;
}

/**
 * Format a clean character-based display title for a character-bound worldbook.
 * @param {string} realName
 * @param {Array<{ avatar: string, charName: string, source: 'primary' | 'extra' | 'embedded' }>} owners
 * @param {Map<string, Array<{ worldName: string, source: string }>>} perCharBooks
 * @returns {string}
 */
export function formatCharacterDisplayTitle(realName, owners, perCharBooks) {
    if (!Array.isArray(owners) || owners.length === 0) return realName;

    if (owners.length === 1) {
        const owner = owners[0];
        const siblings = perCharBooks?.get(owner.avatar) || [];
        if (siblings.length <= 1) {
            return owner.charName;
        }
        if (owner.source === 'primary') {
            return owner.charName;
        }
        const extraSiblings = siblings.filter((s) => s.source !== 'primary');
        const idx = extraSiblings.findIndex((s) => s.worldName === realName);
        const tag = owner.source === 'extra' ? '附加' : '内嵌';
        return extraSiblings.length > 1 && idx >= 0
            ? `${owner.charName} · ${tag}${idx + 1}`
            : `${owner.charName} · ${tag}`;
    }

    const uniqueNames = [...new Set(owners.map((o) => o.charName))];
    if (uniqueNames.length <= 2) {
        return uniqueNames.join('、');
    }
    return `${uniqueNames.slice(0, 2).join('、')} 等${uniqueNames.length}卡`;
}

/**
 * Classify all worldbooks into structured groups and compute display presentation.
 *
 * @param {object} params
 * @param {string[]} params.worldNames
 * @param {Map<string, Array<{ avatar: string, charName: string, source: 'primary' | 'extra' | 'embedded' }>>} params.bindingMap
 * @param {Map<string, string[]>} [params.personaMap]
 * @param {Record<string, any>} params.settings
 */
export function classifyWorldbooks({
    worldNames = [],
    bindingMap = new Map(),
    personaMap = new Map(),
    settings,
}) {
    const cfg = normalizeSettings(settings);
    const validGroupMap = new Map(cfg.groups.map((g) => [g.id, g]));
    const perCharBooks = buildCharBooksCountMap(bindingMap);

    /** @type {Map<string, any>} */
    const byName = new Map();
    /** @type {Map<string, any[]>} */
    const customBuckets = new Map(cfg.groups.map((g) => [g.id, []]));
    /** @type {any[]} */
    const ungroupedBooks = [];
    /** @type {any[]} */
    const characterBooks = [];

    const seen = new Set();
    for (const rawName of worldNames) {
        const realName = String(rawName ?? '').trim();
        if (!realName || seen.has(realName)) continue;
        seen.add(realName);

        const charOwners = bindingMap.get(realName) || [];
        const personaOwners = personaMap.get(realName) || [];
        const isCharBound = charOwners.length > 0;
        const isExcludedFromChar = cfg.charBookOverrides[realName] === 'exclude_from_char';

        const assignedGroupId = cfg.assignments[realName];
        const hasValidManualGroup = Boolean(assignedGroupId && validGroupMap.has(assignedGroupId));

        let groupId;
        if (hasValidManualGroup) {
            groupId = assignedGroupId;
        } else if (isCharBound && !isExcludedFromChar) {
            groupId = SPECIAL_GROUPS.CHARACTER;
        } else {
            groupId = SPECIAL_GROUPS.UNGROUPED;
        }

        const isInCharGroup = groupId === SPECIAL_GROUPS.CHARACTER;
        const alias = typeof cfg.aliases[realName] === 'string' ? cfg.aliases[realName].trim() : '';
        const note = typeof cfg.notes[realName] === 'string' ? cfg.notes[realName].trim() : '';

        let primaryTitle = realName;
        let subtitle = '';

        if (alias) {
            primaryTitle = alias;
            if (cfg.aliasTitleMode === 'alias_with_sub' && alias !== realName) {
                subtitle = realName;
            }
        } else if (isInCharGroup && cfg.charBookTitleMode !== 'original') {
            const charTitle = formatCharacterDisplayTitle(realName, charOwners, perCharBooks);
            primaryTitle = charTitle;
            if (cfg.charBookTitleMode === 'char_with_sub' && charTitle !== realName) {
                subtitle = realName;
            }
        }

        const groupName =
            groupId === SPECIAL_GROUPS.CHARACTER
                ? '角色世界书'
                : groupId === SPECIAL_GROUPS.UNGROUPED
                    ? '未分组'
                    : validGroupMap.get(groupId)?.name || '未分组';

        const ownerNames = charOwners.map((o) => o.charName);
        const searchableText = [
            realName,
            alias,
            primaryTitle,
            note,
            groupName,
            ...ownerNames,
            ...personaOwners,
        ]
            .filter(Boolean)
            .join('\n')
            .toLowerCase();

        const meta = {
            realName,
            primaryTitle,
            subtitle,
            alias,
            note,
            groupId,
            groupName,
            isCharBound,
            isInCharGroup,
            isExcludedFromChar,
            charOwners,
            personaOwners,
            searchableText,
        };

        byName.set(realName, meta);

        if (groupId === SPECIAL_GROUPS.CHARACTER) {
            characterBooks.push(meta);
        } else if (groupId === SPECIAL_GROUPS.UNGROUPED) {
            ungroupedBooks.push(meta);
        } else {
            customBuckets.get(groupId).push(meta);
        }
    }

    const sortByTitle = (a, b) => a.primaryTitle.localeCompare(b.primaryTitle, 'zh-CN');
    for (const bucket of customBuckets.values()) bucket.sort(sortByTitle);
    ungroupedBooks.sort(sortByTitle);
    characterBooks.sort(sortByTitle);

    const customGroups = cfg.groups.map((g) => ({
        ...g,
        books: customBuckets.get(g.id) || [],
    }));
    const customGroupById = new Map(customGroups.map((g) => [g.id, g]));

    const orderedSections = cfg.sectionOrder
        .map((id) => {
            if (id === SPECIAL_GROUPS.CHARACTER) {
                return {
                    id,
                    kind: 'character',
                    name: '角色世界书',
                    color: '#9b72cf',
                    books: characterBooks,
                };
            }
            if (id === SPECIAL_GROUPS.UNGROUPED) {
                return {
                    id,
                    kind: 'ungrouped',
                    name: '未分组',
                    color: '#8c99a6',
                    books: ungroupedBooks,
                };
            }
            const g = customGroupById.get(id);
            if (!g) return null;
            return {
                id: g.id,
                kind: 'custom',
                name: g.name,
                color: g.color,
                collapsed: g.collapsed,
                books: g.books,
            };
        })
        .filter(Boolean);

    return {
        byName,
        customGroups,
        ungroupedBooks,
        characterBooks,
        orderedSections,
        sectionOrder: cfg.sectionOrder,
        totalCount: byName.size,
        nonCharCount: byName.size - characterBooks.length,
        charCount: characterBooks.length,
    };
}

/**
 * Determine whether a worldbook should be visible inside native selectors
 * (`#world_info` or `#world_editor_select`) under current filter & toggle state.
 *
 * Safety invariant: an already-active or currently-edited book is ALWAYS kept
 * visible so filtering never deactivates a live book or breaks the open editor.
 *
 * @param {object} params
 * @param {any} params.bookMeta
 * @param {string} params.activeFilterGroupId
 * @param {boolean} params.showCharBooks
 * @param {boolean} [params.isSelected=false]
 * @param {boolean} [params.isCurrentlyEditing=false]
 * @returns {boolean}
 */
export function isBookVisibleInSelector({
    bookMeta,
    activeFilterGroupId,
    showCharBooks,
    isSelected = false,
    isCurrentlyEditing = false,
}) {
    if (isSelected || isCurrentlyEditing) return true;
    if (!bookMeta) return true;

    if (activeFilterGroupId === SPECIAL_GROUPS.ALL) {
        return true;
    }
    if (activeFilterGroupId === SPECIAL_GROUPS.CHARACTER) {
        return bookMeta.isInCharGroup;
    }
    if (activeFilterGroupId === SPECIAL_GROUPS.UNGROUPED) {
        return bookMeta.groupId === SPECIAL_GROUPS.UNGROUPED;
    }
    if (activeFilterGroupId && activeFilterGroupId !== SPECIAL_GROUPS.DEFAULT) {
        return bookMeta.groupId === activeFilterGroupId;
    }

    // Default mode: hide character-group books unless explicitly shown.
    if (bookMeta.isInCharGroup && !showCharBooks) {
        return false;
    }
    return true;
}

/**
 * Determine whether a worldbook should be shown inside the character's
 * "Link to World Info" popup (hiding OTHER characters' books while keeping
 * the current character's own books and all non-character books).
 *
 * @param {object} params
 * @param {any} params.bookMeta
 * @param {string | null} params.currentCharAvatar
 * @param {boolean} params.hideOtherCharBooks
 * @param {string} [params.filterGroupId='__default__']
 * @param {boolean} [params.isSelected=false]
 * @returns {boolean}
 */
export function isBookVisibleInCharBindPopup({
    bookMeta,
    currentCharAvatar,
    hideOtherCharBooks,
    filterGroupId = SPECIAL_GROUPS.DEFAULT,
    isSelected = false,
}) {
    if (isSelected) return true;
    if (!bookMeta) return true;

    const belongsToCurrentChar = Boolean(
        currentCharAvatar &&
        bookMeta.charOwners?.some((o) => o.avatar === currentCharAvatar),
    );

    if (filterGroupId === SPECIAL_GROUPS.ALL) return true;
    if (filterGroupId === SPECIAL_GROUPS.CHARACTER) return bookMeta.isInCharGroup;
    if (filterGroupId === SPECIAL_GROUPS.UNGROUPED) return bookMeta.groupId === SPECIAL_GROUPS.UNGROUPED;
    if (filterGroupId && filterGroupId !== SPECIAL_GROUPS.DEFAULT) {
        return bookMeta.groupId === filterGroupId;
    }

    if (!hideOtherCharBooks) return true;
    if (belongsToCurrentChar) return true;
    return !bookMeta.isInCharGroup;
}

/**
 * Multi-keyword space-separated fuzzy match across name, alias, note, group, and bound characters.
 * @param {any} bookMeta
 * @param {string} query
 * @returns {boolean}
 */
export function matchesSearch(bookMeta, query) {
    const clean = String(query ?? '').trim().toLowerCase();
    if (!clean) return true;
    const tokens = clean.split(/\s+/).filter(Boolean);
    const haystack = bookMeta?.searchableText || String(bookMeta?.realName || '').toLowerCase();
    return tokens.every((tok) => haystack.includes(tok));
}

/**
 * Heuristically detect whether a worldbook title contains common NSFW / sensitive
 * keywords that may trigger strict safety refusals on commercial AI models,
 * while avoiding common false positives (e.g. 成人礼 / 领土扩张 / small / entry).
 * @param {string} text
 * @returns {boolean}
 */
export function isPotentiallySensitiveTitle(text) {
    const s = String(text ?? '');
    if (
        /(?:nsfw|18\+|r-?18g?|bdsm|hentai|erotica|erotic|fetish|色情|情色|涩情|黄文|小黄文|肉文|纯肉|肉戏|床戏|车文|肉欲|情欲|色欲|涩欲|色气|涩气|淫荡|淫靡|淫秽|淫乱|淫词|淫水|淫叫|娇喘|浪叫|发骚|发浪|调教|性爱|性癖|性奴|性交|性侵|性虐|性骚扰|性描写|性行为|性技巧|性器官|性高潮|性凝视|性玩具|成人玩具|情趣用品|情趣内衣|恶俗|恶堕|雌堕|涩涩|涩图|成人向|成人内容|成人描写|高h|h文|擦边|做爱|啪啪|打飞机|飞机杯|跳蛋|震动棒|假阳具|阳具|阴茎|肉棒|鸡巴|嫩穴|花穴|骚穴|蜜穴|阴道|阴蒂|精液|射精|喷水|潮喷|深喉|吞精|榨精|榨汁|抽插|后入|骑乘位|无套|触手|媚药|催情|春药|发情|情趣|色诱|凌辱|羞辱|拘束|母狗|肉便器|口交|足交|乳交|肛交|舔乳|舔阴|吮吸乳|乳首|内射|颜射|中出|潮吹|自慰|手淫|双性|扶她|兽交|轮奸|强奸|迷奸|乱伦|绿帽|产卵|产乳|泌乳|失禁|露出癖|灌肠|尿道|身体开发|约炮|一夜情|嫖娼|卖淫|援交|黄暴|黄腔|肉汤|炖肉|工口|里番|重口|猎奇|血腥|虐杀|自残|(?:孕期|孕|羞耻|放置|窒息|露出|捆绑|催眠|电击|尿道|灌肠)\s*play)/i.test(s)
    ) {
        return true;
    }
    // Short ASCII tokens require non-letter boundaries so words like "small", "smart", "entry", "ignore" never false-positive
    return /(?<![a-z])(?:sm|sex|ntr|porn|smut|lewd|gore)(?![a-z])/i.test(s);
}

/**
 * Detect whether raw AI output is a safety/policy refusal apology instead of JSON,
 * so the UI can explain clearly why it failed and guide the user.
 * @param {string} rawText
 * @returns {boolean}
 */
export function detectAiRefusal(rawText) {
    const s = String(rawText ?? '').trim();
    if (!s) return false;
    return /(?:i['’]?m sorry|i am sorry|i cannot|i can['’]?t (?:assist|help|fulfill|process|comply|organize)|unable to (?:assist|help|process|fulfill)|against my (?:guidelines|policy|safety)|explicit|nsfw|sexual content|safety polic|抱歉|对不起|很抱歉|我无法(?:处理|完成|协助|提供|整理|满足)|不能(?:处理|提供|协助|生成)|涉及(?:敏感|成人|色情|不当|违规)|安全政策|内容政策)/i.test(s);
}

/**
 * Remove plugin metadata entries for worldbooks deleted from disk.
 * @param {Record<string, any>} settings
 * @param {string[]} deletedNames
 */
export function cleanupDeletedWorldSettings(settings, deletedNames = []) {
    if (!settings || !Array.isArray(deletedNames) || deletedNames.length === 0) return;
    const removed = new Set(deletedNames.map((n) => String(n ?? '').trim()).filter(Boolean));
    for (const dictKey of ['assignments', 'aliases', 'notes', 'charBookOverrides']) {
        const dict = settings[dictKey];
        if (!dict || typeof dict !== 'object') continue;
        for (const name of removed) {
            delete dict[name];
        }
    }
}

/**
 * Build a compact, strict JSON-only prompt for AI worldbook naming & grouping.
 * Uses neutral file-cataloging framing, SillyTavern domain taxonomy guidance,
 * and optional user feedback for partial re-organization of dissatisfied items.
 *
 * @param {object} params
 * @param {Array<{ realName: string, currentAlias?: string, currentGroup?: string, sampleEntries?: string[] }>} params.books
 * @param {string[]} params.existingGroups
 * @param {string} [params.customInstruction='']
 * @param {{
 *   reason?: string,
 *   previousProposals?: Array<{ realName: string, alias?: string, group?: string, note?: string }>,
 *   acceptedGroups?: string[],
 * } | null} [params.feedback=null]
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export function buildAiOrganizePrompt({ books, existingGroups = [], customInstruction = '', feedback = null }) {
    const systemPrompt = [
        '你是本地文档资料库（SillyTavern 角色扮演世界书）的文件目录归类助手。',
        '请仅做客观的文件名规范化与目录归类，不要展开或评价任何文件内容。',
        '根据输入的 realName 以及可选的条目摘要（clues），为每本资料建议：',
        '1. alias：更干净、简洁、统一风格的中文显示名（虚拟别名，不会修改原文件名，去掉冗余版本号/装饰符号/广告词，保留核心主题与必要区分）。',
        '2. group：简短清晰的分类分组名（优先复用已有分组名，总分组数尽量精简在 3~8 个内）。',
        '3. note：一句话极简用途说明（不超过 25 字）。',
        '',
        '酒馆世界书常见分类维度参考（注意区分，勿混为一谈）：',
        '- 「文风」：控制行文语气、叙事风格、描写质感、去 AI 味、对话风格、节奏等写作规范。',
        '- 「缝合」：设计用来缝合进系统预设/指令模板的功能补丁与规则模块（如防抢话、思维链、输出格式、记忆/逻辑增强、通用规则指令等）。',
        '- 「场景与互动」：约会场景与流程指南、恋爱/日常互动、生活情景、剧情推进模板、特定场合事件等（不要把约会指南、恋爱/日常互动流程误归入「世界观」或「角色设定」）。',
        '- 「世界观设定」：架空历史、地理势力、时代背景、魔法/科技体系等宏观世界设定。',
        '- 「小剧场与扩展」：随机小剧场、状态栏/前端扩展、互动小游戏等玩法组件。',
        '- 「人设与素材」：外貌穿搭、职业生活常识、台词词库、通用素材参考等。',
        '',
        '严格要求：',
        '- 必须只输出一个合法 JSON 对象，不要包含任何解释文字、道歉或额外注释。',
        '- JSON 的 key 必须与输入的 realName 完全逐字一致，不可篡改、不可遗漏、不可杜撰新 key。',
        '- 输出格式：{"原始名称": {"alias": "整理后显示名", "group": "分组名", "note": "一句话说明"}}',
    ].join('\n');

    const lines = [];
    const mergedGroups = [...new Set([
        ...(existingGroups || []),
        ...(Array.isArray(feedback?.acceptedGroups) ? feedback.acceptedGroups : []),
    ].map((g) => String(g || '').trim()).filter(Boolean))];

    if (mergedGroups.length > 0) {
        lines.push(`当前已有/已确认可复用的分组：${mergedGroups.join('、')}`);
    }
    if (customInstruction && customInstruction.trim()) {
        lines.push(`用户额外偏好：${customInstruction.trim()}`);
    }
    if (feedback && typeof feedback === 'object') {
        const fbLines = [
            '【重新分组反馈】用户对上一次的整理结果中以下几项的分组或命名不满意，请根据用户意见重新归类并优化，不要机械沿用被退回的旧分组（previousGroup）。',
        ];
        if (feedback.reason && String(feedback.reason).trim()) {
            fbLines.push(`用户不满意的原因与期望：${String(feedback.reason).trim()}`);
        }
        lines.push(fbLines.join('\n'));
    }

    const prevMap = new Map(
        (Array.isArray(feedback?.previousProposals) ? feedback.previousProposals : [])
            .filter((p) => p?.realName)
            .map((p) => [p.realName, p]),
    );

    lines.push('待归类资料清单（JSON 数组）：');
    const payload = books.map((b) => {
        const row = { realName: b.realName };
        if (b.currentAlias) row.currentAlias = b.currentAlias;
        if (b.currentGroup && b.currentGroup !== '未分组' && b.currentGroup !== '非角色世界书') {
            row.currentGroup = b.currentGroup;
        }
        const prev = prevMap.get(b.realName);
        if (prev) {
            if (prev.group) row.previousGroup = prev.group;
            if (prev.alias) row.previousAlias = prev.alias;
        }
        if (Array.isArray(b.sampleEntries) && b.sampleEntries.length > 0) {
            row.clues = b.sampleEntries;
        }
        return row;
    });
    lines.push(JSON.stringify(payload, null, 2));

    return {
        systemPrompt,
        userPrompt: lines.join('\n\n'),
    };
}

/**
 * Extract and validate AI organize proposals from raw LLM output text.
 * Supports fenced code blocks, leading/trailing prose, object map, or array format.
 *
 * @param {string} rawText
 * @param {Set<string> | string[]} validWorldNames
 * @returns {{ ok: boolean, proposals: Array<{ realName: string, alias: string, group: string, note: string }>, ignoredCount: number, error?: string }}
 */
export function parseAiOrganizeResponse(rawText, validWorldNames) {
    const validSet = validWorldNames instanceof Set ? validWorldNames : new Set(validWorldNames || []);
    const text = String(rawText ?? '').trim();
    if (!text) {
        return { ok: false, proposals: [], ignoredCount: 0, error: 'AI 返回内容为空' };
    }

    // Try fenced JSON block first, then outermost {...} or [...]
    const candidates = [];
    const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let m;
    while ((m = fenceRegex.exec(text)) !== null) {
        if (m[1]?.trim()) candidates.push(m[1].trim());
    }
    candidates.push(text);

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        candidates.push(text.slice(firstBrace, lastBrace + 1));
    }
    const firstBracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
        candidates.push(text.slice(firstBracket, lastBracket + 1));
    }

    let parsed = null;
    for (const chunk of candidates) {
        try {
            const val = JSON.parse(chunk);
            if (val && typeof val === 'object') {
                parsed = val;
                break;
            }
        } catch {
            // Try next candidate
        }
    }

    if (!parsed) {
        const isRefusal = detectAiRefusal(text);
        return {
            ok: false,
            proposals: [],
            ignoredCount: 0,
            isRefusal,
            refusalSnippet: text.slice(0, 140),
            error: isRefusal
                ? 'AI 触发了内容安全策略并拒绝回复（常见于包含敏感/18+词的世界书或条目摘要）。建议取消勾选敏感世界书后重试（敏感书可直接手动拖拽分组），或切换无审查模型 / 仅按书名整理。'
                : '未能从返回文本中解析出合法 JSON',
        };
    }

    /** @type {Array<{ realName: string, alias: string, group: string, note: string }>} */
    const proposals = [];
    const seen = new Set();
    let ignoredCount = 0;

    const pushRow = (realName, item) => {
        const cleanReal = String(realName ?? '').trim();
        if (!cleanReal || seen.has(cleanReal)) return;
        if (validSet.size > 0 && !validSet.has(cleanReal)) {
            ignoredCount += 1;
            return;
        }
        if (!item || typeof item !== 'object') {
            ignoredCount += 1;
            return;
        }
        const alias = String(item.alias ?? item.displayName ?? item.name ?? '').trim();
        const group = String(item.group ?? item.category ?? item.folder ?? '').trim();
        const note = String(item.note ?? item.description ?? item.summary ?? '').trim();
        if (!alias && !group && !note) {
            ignoredCount += 1;
            return;
        }
        seen.add(cleanReal);
        proposals.push({ realName: cleanReal, alias, group, note });
    };

    if (Array.isArray(parsed)) {
        for (const row of parsed) {
            if (row && typeof row === 'object') {
                pushRow(row.realName || row.originalName || row.world || row.key, row);
            }
        }
    } else if (Array.isArray(parsed.items)) {
        for (const row of parsed.items) {
            if (row && typeof row === 'object') {
                pushRow(row.realName || row.originalName || row.world || row.key, row);
            }
        }
    } else {
        for (const [key, val] of Object.entries(parsed)) {
            pushRow(key, val);
        }
    }

    if (proposals.length === 0) {
        return {
            ok: false,
            proposals: [],
            ignoredCount,
            error: 'JSON 已解析，但没有匹配到当前存在的世界书名',
        };
    }

    return { ok: true, proposals, ignoredCount };
}

/**
 * Apply confirmed AI organize proposals to settings (non-destructive virtual aliases & groups).
 * Saves an undo snapshot beforehand.
 *
 * @param {Record<string, any>} settings
 * @param {Array<{ realName: string, alias?: string, group?: string, note?: string, applyAlias?: boolean, applyGroup?: boolean, applyNote?: boolean }>} proposals
 * @returns {{ appliedCount: number, createdGroups: string[] }}
 */
export function applyAiOrganizeProposals(settings, proposals) {
    if (!Array.isArray(proposals) || proposals.length === 0) {
        return { appliedCount: 0, createdGroups: [] };
    }

    // Save undo snapshot (keep last 3)
    const snapshot = {
        at: Date.now(),
        count: proposals.length,
        groups: deepClone(settings.groups || []),
        assignments: deepClone(settings.assignments || {}),
        aliases: deepClone(settings.aliases || {}),
        notes: deepClone(settings.notes || {}),
        charBookOverrides: deepClone(settings.charBookOverrides || {}),
    };
    settings.undoSnapshots = [snapshot, ...(settings.undoSnapshots || [])].slice(0, 3);

    const groupByName = new Map(
        (settings.groups || []).map((g) => [g.name.trim().toLowerCase(), g]),
    );
    const createdGroups = [];
    let appliedCount = 0;

    for (const p of proposals) {
        if (!p?.realName) continue;
        let touched = false;

        const shouldAlias = p.applyAlias !== false;
        const shouldGroup = p.applyGroup !== false;
        const shouldNote = p.applyNote !== false;

        if (shouldAlias && typeof p.alias === 'string' && p.alias.trim()) {
            const cleanAlias = p.alias.trim();
            if (cleanAlias === p.realName) {
                delete settings.aliases[p.realName];
            } else {
                settings.aliases[p.realName] = cleanAlias;
            }
            touched = true;
        }

        if (shouldNote && typeof p.note === 'string' && p.note.trim()) {
            settings.notes[p.realName] = p.note.trim();
            touched = true;
        }

        if (shouldGroup && typeof p.group === 'string' && p.group.trim()) {
            const cleanGroup = p.group.trim();
            if (cleanGroup === '未分组') {
                delete settings.assignments[p.realName];
                touched = true;
            } else if (cleanGroup === '角色世界书') {
                delete settings.assignments[p.realName];
                delete settings.charBookOverrides[p.realName];
                touched = true;
            } else {
                const key = cleanGroup.toLowerCase();
                let targetGroup = groupByName.get(key);
                if (!targetGroup) {
                    targetGroup = {
                        id: createGroupId(settings.groups),
                        name: cleanGroup,
                        color: GROUP_COLOR_PALETTE[settings.groups.length % GROUP_COLOR_PALETTE.length],
                        collapsed: false,
                    };
                    settings.groups.push(targetGroup);
                    groupByName.set(key, targetGroup);
                    createdGroups.push(cleanGroup);
                }
                settings.assignments[p.realName] = targetGroup.id;
                touched = true;
            }
        }

        if (touched) appliedCount += 1;
    }

    return { appliedCount, createdGroups };
}

/**
 * Migrate all plugin metadata keys cleanly when a worldbook is truly renamed on disk.
 * @param {Record<string, any>} settings
 * @param {string} oldName
 * @param {string} newName
 */
export function migrateSettingsOnWorldRename(settings, oldName, newName) {
    const cleanOld = String(oldName ?? '').trim();
    const cleanNew = String(newName ?? '').trim();
    if (!cleanOld || !cleanNew || cleanOld === cleanNew) return;

    for (const dictKey of ['assignments', 'notes', 'charBookOverrides']) {
        const dict = settings[dictKey];
        if (dict && Object.hasOwn(dict, cleanOld)) {
            dict[cleanNew] = dict[cleanOld];
            delete dict[cleanOld];
        }
    }

    if (settings.aliases && Object.hasOwn(settings.aliases, cleanOld)) {
        const oldAlias = settings.aliases[cleanOld];
        delete settings.aliases[cleanOld];
        if (oldAlias && oldAlias !== cleanNew) {
            settings.aliases[cleanNew] = oldAlias;
        }
    }

    if (settings.cachedCharBindings && typeof settings.cachedCharBindings === 'object') {
        for (const entry of Object.values(settings.cachedCharBindings)) {
            if (!entry || typeof entry !== 'object') continue;
            if (entry.primary === cleanOld) entry.primary = cleanNew;
            if (entry.embedded === cleanOld) entry.embedded = cleanNew;
        }
    }
}

/**
 * Undo the most recent AI organize batch.
 * @param {Record<string, any>} settings
 * @returns {boolean}
 */
export function undoLastAiOrganize(settings) {
    if (!Array.isArray(settings.undoSnapshots) || settings.undoSnapshots.length === 0) {
        return false;
    }
    const [latest, ...rest] = settings.undoSnapshots;
    settings.groups = deepClone(latest.groups || []);
    settings.assignments = deepClone(latest.assignments || {});
    settings.aliases = deepClone(latest.aliases || {});
    settings.notes = deepClone(latest.notes || {});
    settings.charBookOverrides = deepClone(latest.charBookOverrides || {});
    settings.undoSnapshots = rest;
    return true;
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
            includeExtraCharBooks: cfg.includeExtraCharBooks,
            includeEmbeddedNameMatch: cfg.includeEmbeddedNameMatch,
            autoHideInCharBindPopup: cfg.autoHideInCharBindPopup,
            showNativeOptgroups: cfg.showNativeOptgroups,
            sectionOrder: cfg.sectionOrder,
            groups: cfg.groups,
            assignments: cfg.assignments,
            aliases: cfg.aliases,
            notes: cfg.notes,
            charBookOverrides: cfg.charBookOverrides,
        },
    };
}

/**
 * Import backup JSON into settings safely.
 * @param {Record<string, any>} settings
 * @param {any} rawPayload
 * @returns {{ ok: boolean, error?: string, stats?: { groups: number, assignments: number, aliases: number } }}
 */
export function importConfigData(settings, rawPayload) {
    const payload = typeof rawPayload === 'string' ? (() => {
        try { return JSON.parse(rawPayload); } catch { return null; }
    })() : rawPayload;

    if (!payload || typeof payload !== 'object') {
        return { ok: false, error: '无效的 JSON 文件' };
    }
    const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    if (!Array.isArray(data.groups) && typeof data.assignments !== 'object' && typeof data.aliases !== 'object') {
        return { ok: false, error: '未在文件中找到分组或别名配置' };
    }

    const normalized = normalizeSettings({ ...settings, ...data });
    Object.assign(settings, normalized);

    return {
        ok: true,
        stats: {
            groups: settings.groups.length,
            assignments: Object.keys(settings.assignments).length,
            aliases: Object.keys(settings.aliases).length,
        },
    };
}
