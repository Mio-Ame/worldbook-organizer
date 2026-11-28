/**
 * Character/persona binding index, shallow-scan helpers and coverage summaries.
 *
 * Move-only slice of src/core.js (original lines 842-1581). Every declaration body is byte-
 * identical; the surroundings are import/export wiring only.
 */

import { charaFileName, compareZhCn } from './settings.js';

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

export function updateCachedCharBindings(cachedBindings, characters, { pruneDeleted = true } = {}) {
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

        const isCompactSummary = Boolean(ch && ch.wboCompactSummary === true);
        const rawPrimary = isCompactSummary ? ch.primary : ch?.data?.extensions?.world;
        const primary = typeof rawPrimary === 'string' && rawPrimary.trim() ? rawPrimary.trim() : null;

        let embedded = null;
        let embeddedEntryCount = 0;
        if (isCompactSummary) {
            if (typeof ch.embedded === 'string' && ch.embedded.trim()) {
                embedded = ch.embedded.trim();
            }
            embeddedEntryCount = Number.isFinite(ch.embeddedEntryCount) ? Math.max(0, ch.embeddedEntryCount) : 0;
        } else if (ch?.data?.character_book && typeof ch.data.character_book === 'object') {
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

    // Remove deleted characters from cache (only when full live character list is passed).
    if (pruneDeleted) {
        for (const avatar of Object.keys(next)) {
            if (!liveAvatars.has(avatar)) {
                delete next[avatar];
                changed = true;
            }
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
 * Normalize a character or worldbook title for conservative similar-name matching:
 * NFKC -> lowercase -> iteratively strip trailing copy suffixes `(n)`, media/json
 * extensions, keycap emoji, pictographs, variation selectors, ZWJ, whitespace,
 * and punctuation/symbols (without stripping legitimate version digits like `2.0`).
 *
 * @param {string | null | undefined} raw
 * @returns {string}
 */

export function normalizeMatchName(raw) {
    let s = String(raw ?? '').normalize('NFKC').trim().toLowerCase();
    if (!s) return '';
    let prev;
    do {
        prev = s;
        s = s
            .replace(/(?:\s*\(\d+\))+$/g, '')
            .replace(/\.(?:png|jpe?g|webp|json)$/i, '')
            .replace(/[0-9#*][\uFE0E\uFE0F]?\u20E3$/g, '')
            .replace(/(?:[\p{Extended_Pictographic}\p{S}\s\uFE00-\uFE0F\u200D\u20E3]|(?![)])\p{P})+$/gu, '')
            .trim();
    } while (s !== prev);
    return s
        .replace(/[0-9#*][\uFE0E\uFE0F]?\u20E3/g, '')
        .replace(/[\p{Extended_Pictographic}\p{P}\p{S}\s\uFE00-\uFE0F\u200D\u20E3]+/gu, '');
}


const CJK_CHAR_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;


function isExactMatchableToken(token) {
    const clean = String(token ?? '').trim();
    if (clean.length < 2) return false;
    if (/^\d+$/.test(clean)) return false;
    return true;
}


function isNormalizedMatchableToken(norm) {
    if (!norm || /^\d+$/.test(norm)) return false;
    return CJK_CHAR_RE.test(norm) ? norm.length >= 2 : norm.length >= 3;
}

/**
 * Find unbound standalone worldbooks whose title matches a scanned or shallow
 * character card's `name` or `charaFileName(avatar)` (exact or normalized stripping
 * trailing `(n)` copy suffixes, emoji, whitespace, and punctuation).
 *
 * Excludes books already bound to a live card in `bindingIndex` or already handled
 * via `charBookOverrides` (`'include_in_char'` / `'exclude_from_char'`).
 *
 * @param {string[]} [worldNames=[]]
 * @param {Array<any>} [characters=[]]
 * @param {Map<string, Array<{ avatar: string, charName: string, source: string, orphan?: boolean }>>} [bindingIndex=new Map()]
 * @param {Record<string, any>} [settings={}]
 * @returns {Array<{ worldName: string, avatar: string, charName: string, reason: 'unscanned_card_name' | 'exact_name' | 'normalized_name', matchType: 'exact' | 'normalized', hasUnscanned: boolean, matchedChars: Array<{ avatar: string, charName: string, matchType: 'exact' | 'normalized', isUnscanned: boolean }> }>}
 */

export function findUnboundCharacterNameMatches(
    worldNames = [],
    characters = [],
    bindingIndex = new Map(),
    settings = {},
) {
    const worlds = Array.isArray(worldNames) ? worldNames : [];
    const chars = Array.isArray(characters) ? characters : [];
    if (worlds.length === 0 || chars.length === 0) return [];

    const overrides = settings?.charBookOverrides || {};
    const cachedBindings = settings?.cachedCharBindings || {};

    const charCandidates = [];
    const seenAvatars = new Set();
    for (const ch of chars) {
        const avatar = String(ch?.avatar ?? '').trim();
        if (!avatar || seenAvatars.has(avatar)) continue;
        seenAvatars.add(avatar);

        const avatarBase = charaFileName(avatar).trim();
        const charName = String(ch?.name || ch?.data?.name || avatarBase).trim() || avatar;
        const cached = cachedBindings?.[avatar];
        const isUnscanned = Boolean(ch?.shallow && cached?.scanned !== true);

        const labels = [];
        const seenLabels = new Set();
        for (const rawLabel of [charName, avatarBase]) {
            const clean = String(rawLabel ?? '').trim();
            if (!clean) continue;
            const exact = clean.normalize('NFKC').toLowerCase();
            if (seenLabels.has(exact)) continue;
            seenLabels.add(exact);
            labels.push({
                exact,
                norm: normalizeMatchName(clean),
            });
        }
        if (labels.length === 0) continue;
        charCandidates.push({ avatar, charName, isUnscanned, labels });
    }

    if (charCandidates.length === 0) return [];

    const out = [];
    const seenWorlds = new Set();

    for (const rawWorld of worlds) {
        const worldName = String(rawWorld ?? '').trim();
        if (!worldName || seenWorlds.has(worldName)) continue;
        seenWorlds.add(worldName);

        const owners = bindingIndex?.get?.(worldName);
        if (Array.isArray(owners) && owners.some((o) => !o?.orphan)) continue;

        const ov = overrides[worldName];
        if (ov === 'include_in_char' || ov === 'exclude_from_char') continue;

        const worldExact = worldName.normalize('NFKC').trim().toLowerCase();
        const worldNorm = normalizeMatchName(worldName);
        const canExact = isExactMatchableToken(worldExact);
        const canNorm = isNormalizedMatchableToken(worldNorm);
        if (!canExact && !canNorm) continue;

        const matchedChars = [];
        for (const ch of charCandidates) {
            let matchType = null;
            for (const lbl of ch.labels) {
                if (canExact && isExactMatchableToken(lbl.exact) && worldExact === lbl.exact) {
                    matchType = 'exact';
                    break;
                }
                if (canNorm && isNormalizedMatchableToken(lbl.norm) && worldNorm === lbl.norm) {
                    matchType = 'normalized';
                }
            }
            if (matchType) {
                matchedChars.push({
                    avatar: ch.avatar,
                    charName: ch.charName,
                    matchType,
                    isUnscanned: ch.isUnscanned,
                });
            }
        }

        if (matchedChars.length === 0) continue;

        // Prioritize exact matches first, then scanned over unscanned
        matchedChars.sort((a, b) => {
            if (a.matchType !== b.matchType) return a.matchType === 'exact' ? -1 : 1;
            if (a.isUnscanned !== b.isUnscanned) return a.isUnscanned ? 1 : -1;
            return compareZhCn(a.charName, b.charName);
        });

        const primaryMatch = matchedChars[0];
        const hasUnscanned = matchedChars.some((m) => m.isUnscanned);
        const reason = primaryMatch.isUnscanned
            ? 'unscanned_card_name'
            : (primaryMatch.matchType === 'exact' ? 'exact_name' : 'normalized_name');

        out.push({
            worldName,
            avatar: primaryMatch.avatar,
            charName: primaryMatch.charName,
            reason,
            matchType: primaryMatch.matchType,
            hasUnscanned,
            matchedChars,
        });
    }

    out.sort((a, b) => compareZhCn(a.worldName, b.worldName));
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
 * @param {Record<string, any> | null} [params.settings=null]
 */

export function summarizeCharacterWorldCoverage({
    characters = [],
    bindingMap = new Map(),
    worldNamesSet = new Set(),
    cachedCharBindings = {},
    settings = null,
}) {
    const boundAvatars = new Set();
    const sharedBooks = [];
    const booksByAvatar = new Map();
    const embeddedByAvatar = new Map();
    const liveAvatarSet = new Set(
        (characters || []).map((c) => String(c?.avatar ?? '').trim()).filter(Boolean),
    );
    const orphanExtraBooks = [];

    for (const [worldName, owners] of bindingMap.entries()) {
        for (const o of owners) {
            if (!liveAvatarSet.has(o.avatar)) {
                orphanExtraBooks.push({
                    worldName,
                    charName: o.charName,
                    charKey: charaFileName(o.avatar) || o.charName,
                    source: o.source,
                });
            } else if (o.source === 'embedded') {
                let list = embeddedByAvatar.get(o.avatar);
                if (!list) {
                    list = { avatar: o.avatar, charName: o.charName, books: [] };
                    embeddedByAvatar.set(o.avatar, list);
                }
                list.books.push({ worldName, source: 'embedded' });
            } else {
                boundAvatars.add(o.avatar);
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

    // Only real SillyTavern bindings (primary + extra) belong in `multiBookChars`;
    // passive embedded-name matches are reported separately so users are never misled!
    const multiBookChars = [];
    for (const info of booksByAvatar.values()) {
        if (info.books.length > 1) {
            multiBookChars.push(info);
        }
    }

    const embeddedNameMatches = [];
    for (const [avatar, emb] of embeddedByAvatar.entries()) {
        const realInfo = booksByAvatar.get(avatar);
        const hasRealBinding = Boolean(realInfo && realInfo.books.length > 0);
        for (const b of emb.books) {
            if (bindingMap.get(b.worldName)?.some((owner) => owner.source !== 'embedded' && liveAvatarSet.has(owner.avatar))) continue;
            embeddedNameMatches.push({
                avatar,
                charName: emb.charName,
                worldName: b.worldName,
                primaryWorld: realInfo?.books?.find((book) => book.source === 'primary')?.worldName || '',
                hasRealBinding,
            });
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

    const worldList = worldNamesSet instanceof Set
        ? [...worldNamesSet]
        : (Array.isArray(worldNamesSet) ? worldNamesSet : []);
    const unboundNameMatches = findUnboundCharacterNameMatches(
        worldList,
        characters,
        bindingMap,
        settings || { cachedCharBindings },
    );

    return {
        unboundChars,
        missingFileChars,
        sharedBooks,
        multiBookChars,
        orphanExtraBooks,
        embeddedNameMatches,
        unboundNameMatches,
    };
}

/**
 * Compute F3.3 scan prompt & badge state:
 * - Shows a 1-line prompt ONLY when unbound/embedded same-name books need user
 *   confirmation OR when `autoScanNewCharacters === false` and unscanned shallow cards remain.
 * - When `autoScanNewCharacters !== false` and no same-name books need confirmation,
 *   background idle catch-up handles remaining shallow cards silently (`shouldShowPrompt: false`).
 *
 * @param {object} params
 * @param {string[] | Set<string>} [params.worldNames=[]]
 * @param {Array<any>} [params.characters=[]]
 * @param {Map<string, any>} [params.bindingMap=new Map()]
 * @param {Record<string, any>} [params.settings={}]
 */

export function computeScanPromptState({
    worldNames = [],
    characters = [],
    bindingMap = new Map(),
    settings = {},
} = {}) {
    const worldNamesSet = worldNames instanceof Set
        ? worldNames
        : new Set((Array.isArray(worldNames) ? worldNames : []).map((n) => String(n ?? '').trim()).filter(Boolean));
    const cachedCharBindings = settings?.cachedCharBindings || {};
    const overrides = settings?.charBookOverrides || {};

    const unscannedShallowCount = findUnscannedShallowCharacters(characters, cachedCharBindings).length;
    const unimportedBookCount = findCardsWithUnimportedBooks({
        characters,
        worldNamesSet,
        cachedCharBindings,
    }).length;

    const cov = summarizeCharacterWorldCoverage({
        characters,
        bindingMap,
        worldNamesSet,
        cachedCharBindings,
        settings,
    });

    const unboundNameMatches = cov.unboundNameMatches || [];
    const embeddedNameMatches = (cov.embeddedNameMatches || []).filter((m) => {
        const ov = overrides[m?.worldName];
        return ov !== 'include_in_char' && ov !== 'exclude_from_char';
    });

    const sameNameSet = new Set();
    for (const m of unboundNameMatches) {
        if (m?.worldName) sameNameSet.add(m.worldName);
    }
    for (const m of embeddedNameMatches) {
        if (m?.worldName) sameNameSet.add(m.worldName);
    }

    const sameNameNeedConfirmCount = sameNameSet.size;
    const autoScanDisabled = settings?.autoScanNewCharacters === false;
    const manualScanRequiredCount = autoScanDisabled ? unscannedShallowCount : 0;
    const shouldShowPrompt = sameNameNeedConfirmCount > 0 || manualScanRequiredCount > 0;

    let promptKind = 'none';
    let promptMessage = '';
    if (sameNameNeedConfirmCount > 0 && manualScanRequiredCount > 0) {
        promptKind = 'both';
        promptMessage = `发现 ${sameNameNeedConfirmCount} 本同名世界书待确认，另有 ${manualScanRequiredCount} 张未扫描角色卡`;
    } else if (sameNameNeedConfirmCount > 0) {
        promptKind = 'same_name';
        promptMessage = `发现 ${sameNameNeedConfirmCount} 本与角色同名的世界书待归类`;
    } else if (manualScanRequiredCount > 0) {
        promptKind = 'manual_scan';
        promptMessage = `有 ${manualScanRequiredCount} 张懒加载角色卡待手动扫描`;
    }

    const badgeCount = unscannedShallowCount + unimportedBookCount;

    return {
        shouldShowPrompt,
        promptKind,
        promptMessage,
        sameNameNeedConfirmCount,
        unboundNameMatches,
        embeddedNameMatches,
        unscannedShallowCount,
        unimportedBookCount,
        manualScanRequiredCount,
        badgeCount,
    };
}

/**
 * Extract a lightweight preview entry list from an embedded V2 `character_book`
 * (supporting both Array and Object `entries` layouts) without touching host cache.
 * @param {any} charObj
 * @param {number} [maxChars=1600]
 * @returns {{ name: string, total: number, enabledCount: number, entries: Array<{ uid: string, title: string, keys: string[], content: string, disabled: boolean, constant: boolean }> } | null}
 */

export function extractEmbeddedCharacterBookPreview(charObj, maxChars = 1600) {
    const book = charObj?.data?.character_book;
    if (!book || typeof book !== 'object') return null;

    const charName = String(charObj?.name || charObj?.data?.name || charaFileName(charObj?.avatar || '')).trim();
    const bookName = String(book.name || (charName ? `${charName}'s Lorebook` : '卡内世界书')).trim();
    const rawEntries = Array.isArray(book.entries)
        ? book.entries
        : (book.entries && typeof book.entries === 'object' ? Object.values(book.entries) : []);

    const entries = rawEntries
        .filter((e) => e && typeof e === 'object')
        .map((e, idx) => {
            const rawKeys = Array.isArray(e.keys) ? e.keys : (Array.isArray(e.key) ? e.key : []);
            const keys = rawKeys.map((k) => String(k ?? '').trim()).filter(Boolean);
            const rawContent = maxChars === Infinity ? String(e.content ?? '') : String(e.content ?? '').trim();
            const content = rawContent.length > maxChars
                ? `${rawContent.slice(0, maxChars)}…`
                : rawContent;
            const disabled = e.enabled !== undefined ? !e.enabled : Boolean(e.disable);
            return {
                uid: String(e.id ?? e.uid ?? idx),
                title: String(e.comment || e.name || '').trim() || keys.slice(0, 2).join(' / ') || `条目 #${idx + 1}`,
                keys: keys.slice(0, 6),
                content,
                disabled,
                constant: Boolean(e.constant),
            };
        });

    const enabledCount = entries.filter((x) => !x.disabled).length;
    return {
        name: bookName,
        total: entries.length,
        enabledCount,
        entries,
    };
}

/**
 * Inspect `powerUserSettings` User Persona worldbook bindings (`persona_descriptions`
 * and active `persona_description_lorebook`) to surface missing files, multi-persona
 * sharing, and cross-bindings with Character Cards.
 *
 * @param {object} params
 * @param {Record<string, any> | null | undefined} params.powerUserSettings
 * @param {Set<string>} [params.worldNamesSet]
 * @param {Map<string, Array<{ avatar: string, charName: string, source: string }>>} [params.bindingMap]
 */

export function summarizePersonaWorldBindings({
    powerUserSettings,
    worldNamesSet = new Set(),
    bindingMap = new Map(),
}) {
    const descs = powerUserSettings?.persona_descriptions;
    const names = powerUserSettings?.personas || {};
    const personaBindings = [];
    const missingPersonaBindings = [];
    const personaCharCrossBindings = [];
    const byWorld = new Map();
    const seenPid = new Set();

    const recordBinding = (pid, personaName, lorebook) => {
        const cleanBook = String(lorebook ?? '').trim();
        if (!cleanBook) return;
        const missing = worldNamesSet.size > 0 ? !worldNamesSet.has(cleanBook) : false;
        const charOwners = (bindingMap?.get?.(cleanBook) || []).map((o) => ({
            avatar: o.avatar,
            charName: o.charName,
            source: o.source,
        }));
        const item = {
            pid: String(pid),
            personaName: String(personaName || pid).trim(),
            worldName: cleanBook,
            missing,
            charOwners,
        };
        personaBindings.push(item);
        if (missing) missingPersonaBindings.push(item);
        if (charOwners.length > 0) personaCharCrossBindings.push(item);

        let list = byWorld.get(cleanBook);
        if (!list) {
            list = [];
            byWorld.set(cleanBook, list);
        }
        list.push(item);
    };

    if (descs && typeof descs === 'object') {
        for (const [pid, desc] of Object.entries(descs)) {
            if (!desc || typeof desc !== 'object') continue;
            const lorebook = typeof desc.lorebook === 'string' ? desc.lorebook.trim() : '';
            if (!lorebook) continue;
            seenPid.add(pid);
            const baseName = String(names[pid] || pid).trim();
            const sub = String(desc.title || '').trim();
            const label = sub ? `${baseName} (${sub})` : baseName;
            recordBinding(pid, label, lorebook);
        }
    }

    const activeBook = typeof powerUserSettings?.persona_description_lorebook === 'string'
        ? powerUserSettings.persona_description_lorebook.trim()
        : '';
    if (activeBook && !personaBindings.some((b) => b.worldName === activeBook)) {
        recordBinding('__active__', '当前激活人设', activeBook);
    }

    const sharedPersonaBooks = [];
    for (const [worldName, items] of byWorld.entries()) {
        if (items.length > 1) {
            sharedPersonaBooks.push({
                worldName,
                personas: items.map((x) => x.personaName),
                items,
            });
        }
    }

    return {
        personaBindings,
        missingPersonaBindings,
        personaCharCrossBindings,
        sharedPersonaBooks,
        totalBoundCount: personaBindings.length,
        anomalyCount: missingPersonaBindings.length + personaCharCrossBindings.length,
    };
}

/**
 * Generate a collision-free API channel ID.
 * @param {Array<{ id: string }>} existingChannels
 */
