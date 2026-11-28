/**
 * Visibility classification, selector filtering, search matching and stale-setting cleanup.
 *
 * Move-only slice of src/core.js (original lines 1582-2268). Every declaration body is byte-
 * identical; the surroundings are import/export wiring only.
 */

import { SPECIAL_GROUPS, charaFileName, compareZhCn, normalizeSettings } from './settings.js';

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

    const addBinding = (worldName, avatar, charName, source, orphan = false) => {
        const cleanWorld = String(worldName ?? '').trim();
        if (!cleanWorld) return;
        if (worldNamesSet && !worldNamesSet.has(cleanWorld)) return;

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
            if (!orphan) existing.orphan = false;
            return;
        }
        list.push(orphan ? { avatar, charName, source, orphan: true } : { avatar, charName, source });
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
        const hasLoadedChars = charList.length > 0;
        for (const entry of charLore) {
            const keyName = String(entry?.name ?? '').trim();
            if (!keyName || !Array.isArray(entry?.extraBooks)) continue;
            const matchedChar = charByFileName.get(keyName);
            const avatar = matchedChar?.avatar || `${keyName}.png`;
            const charName = matchedChar?.charName || keyName;
            const isOrphan = Boolean(hasLoadedChars && !matchedChar);
            for (const book of entry.extraBooks) {
                addBinding(book, avatar, charName, 'extra', isOrphan);
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
    const pinnedSet = new Set(cfg.pinnedBooks || []);

    /** @type {Map<string, any>} */
    const byName = new Map();
    /** @type {Map<string, any[]>} */
    const customBuckets = new Map(cfg.groups.map((g) => [g.id, []]));
    /** @type {any[]} */
    const ungroupedBooks = [];
    /** @type {any[]} */
    const characterBooks = [];
    /** @type {any[]} */
    const pinnedBooks = [];

    const seen = new Set();
    for (const rawName of worldNames) {
        const realName = String(rawName ?? '').trim();
        if (!realName || seen.has(realName)) continue;
        seen.add(realName);

        const rawOwners = bindingMap.get(realName) || [];
        // Ignore stale `charLore` entries whose character card was already deleted so books
        // never stay trapped in「角色世界书」after a character is removed.
        const charOwners = rawOwners.filter((o) => !o.orphan);
        const personaOwners = personaMap.get(realName) || [];
        const isCharBound = charOwners.length > 0;
        const charOverride = cfg.charBookOverrides[realName];
        const isExcludedFromChar = charOverride === 'exclude_from_char';
        const isIncludedInChar = charOverride === 'include_in_char';

        const assignedGroupId = cfg.assignments[realName];
        const hasValidManualGroup = Boolean(assignedGroupId && validGroupMap.has(assignedGroupId));

        let groupId;
        if (hasValidManualGroup) {
            groupId = assignedGroupId;
        } else if ((isCharBound && !isExcludedFromChar) || isIncludedInChar) {
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
        } else if ((isInCharGroup || (isCharBound && !isExcludedFromChar)) && cfg.charBookTitleMode !== 'original') {
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
            isPinned: pinnedSet.has(realName),
            isCharBound,
            isInCharGroup,
            isExcludedFromChar,
            isCharIncluded: isIncludedInChar,
            isCharManualOverride: isIncludedInChar && !isCharBound,
            charOwners,
            personaOwners,
            searchableText,
        };

        byName.set(realName, meta);
        if (meta.isPinned) {
            pinnedBooks.push(meta);
        }

        if (groupId === SPECIAL_GROUPS.CHARACTER) {
            characterBooks.push(meta);
        } else if (groupId === SPECIAL_GROUPS.UNGROUPED) {
            ungroupedBooks.push(meta);
        } else {
            customBuckets.get(groupId).push(meta);
        }
    }

    const sortByPinnedAndTitle = (a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return compareZhCn(a.primaryTitle, b.primaryTitle);
    };
    const sortBucketForGroup = (bucket, groupId) => {
        const customArr = Array.isArray(cfg.bookOrders?.[groupId]) ? cfg.bookOrders[groupId] : null;
        if (!customArr || customArr.length === 0) {
            bucket.sort(sortByPinnedAndTitle);
            return;
        }
        const orderMap = new Map(customArr.map((name, i) => [name, i]));
        bucket.sort((a, b) => {
            const ia = orderMap.get(a.realName);
            const ib = orderMap.get(b.realName);
            if (ia !== undefined && ib !== undefined) return ia - ib;
            if (ia !== undefined && ib === undefined) return b.isPinned ? 1 : -1;
            if (ia === undefined && ib !== undefined) return a.isPinned ? -1 : 1;
            return sortByPinnedAndTitle(a, b);
        });
    };
    for (const [gid, bucket] of customBuckets.entries()) sortBucketForGroup(bucket, gid);
    sortBucketForGroup(ungroupedBooks, SPECIAL_GROUPS.UNGROUPED);
    sortBucketForGroup(characterBooks, SPECIAL_GROUPS.CHARACTER);
    pinnedBooks.sort((a, b) => compareZhCn(a.primaryTitle, b.primaryTitle));

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
        pinnedBooks,
        orderedSections,
        sectionOrder: cfg.sectionOrder,
        totalCount: byName.size,
        nonCharCount: byName.size - characterBooks.length,
        charCount: characterBooks.length,
        pinnedCount: pinnedBooks.length,
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
    hiddenGroupIds = null,
    isSelected = false,
    isCurrentlyEditing = false,
    isCurrentChatCharBook = false,
}) {
    if (isSelected || isCurrentlyEditing || isCurrentChatCharBook) return true;
    if (!bookMeta) return true;

    if (activeFilterGroupId === SPECIAL_GROUPS.ALL) {
        return true;
    }
    if (activeFilterGroupId === SPECIAL_GROUPS.PINNED) {
        return Boolean(bookMeta.isPinned);
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

    // Reveal toggle ON: show all hidden groups (character books + any user-excluded custom groups)
    if (showCharBooks) {
        return true;
    }

    // Default mode: hide user-configured excluded groups for this selector (defaults to character books)
    if (hiddenGroupIds !== null && hiddenGroupIds !== undefined) {
        const isHidden = hiddenGroupIds instanceof Set
            ? hiddenGroupIds.has(bookMeta.groupId)
            : Array.isArray(hiddenGroupIds) && hiddenGroupIds.includes(bookMeta.groupId);
        return !isHidden;
    }

    if (bookMeta.isInCharGroup) {
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
    if (filterGroupId === SPECIAL_GROUPS.PINNED) return Boolean(bookMeta.isPinned);
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
 * Search match across selected book metadata fields (book name/alias/note/group and/or character/persona names),
 * supporting either exact phrase matching or optional space-separated multi-word AND matching.
 * @param {any} bookMeta
 * @param {string} query
 * @param {{ searchBookName?: boolean, searchCharName?: boolean, splitSpaces?: boolean }} [opts]
 * @returns {boolean}
 */

export function matchesSearch(bookMeta, query, opts = null) {
    const clean = String(query ?? '').trim().toLowerCase();
    if (!clean) return true;

    if (!opts) {
        const tokens = clean.split(/\s+/).filter(Boolean);
        const haystack = bookMeta?.searchableText || String(bookMeta?.realName || '').toLowerCase();
        return tokens.every((tok) => haystack.includes(tok));
    }

    const searchBookName = opts.searchBookName !== false;
    const searchCharName = opts.searchCharName !== false;
    if (!searchBookName && !searchCharName) return false;

    const parts = [];
    if (searchBookName) {
        if (bookMeta?.realName) parts.push(bookMeta.realName);
        if (bookMeta?.alias) parts.push(bookMeta.alias);
        if (bookMeta?.primaryTitle) parts.push(bookMeta.primaryTitle);
        if (bookMeta?.note) parts.push(bookMeta.note);
        if (bookMeta?.groupName) parts.push(bookMeta.groupName);
    }
    if (searchCharName) {
        for (const o of bookMeta?.charOwners || []) {
            if (o?.charName) parts.push(o.charName);
        }
        for (const p of bookMeta?.personaOwners || []) {
            if (p) parts.push(p);
        }
    }
    const haystack = parts.join('\n').toLowerCase();
    if (!haystack) return false;

    if (opts.splitSpaces) {
        const tokens = clean.split(/\s+/).filter(Boolean);
        return tokens.every((tok) => haystack.includes(tok));
    }
    return haystack.includes(clean);
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
        /(?:nsfw|18\+|r-?18g?|bdsm|hentai|erotica|erotic|fetish|dirty\s*talk|色情|情色|涩情|黄文|小黄文|肉文|纯肉|肉戏|床戏|车文|车速|开车|肉欲|情欲|色欲|涩欲|色气|涩气|淫荡|淫靡|淫秽|淫乱|淫词|淫语|淫水|淫叫|淫娃|骚话|荤话|下流话|娇喘|浪叫|发骚|发浪|骚货|荡妇|母猪|调教|性爱|性癖|性奴|性交|性侵|性虐|性骚扰|性描写|性行为|性技巧|性器官|性器|生殖器|性高潮|性凝视|性玩具|成人玩具|情趣用品|情趣内衣|恶俗|恶堕|雌堕|涩涩|瑟瑟|色色|涩图|成人向|成人内容|成人描写|高h|h文|擦边|做爱|啪啪|打飞机|飞机杯|名器|撸管|手冲|导管|自渎|跳蛋|震动棒|假阳具|假鸡巴|假肉棒|肛塞|拉珠|贞操锁|贞操带|口球|乳夹|阴夹|阴环|乳环|阳具|阴茎|肉棒|鸡巴|龟头|睾丸|嫩穴|花穴|骚穴|蜜穴|肉洞|穴口|宫口|阴唇|阴道|阴蒂|后庭|前列腺|精液|射精|喷水|潮喷|深喉|吞精|口爆|颜爆|榨精|榨汁|抽插|后入|骑乘位|素股|臀交|无套|寸止|放尿|触手|媚药|催情|春药|发情|情趣|色诱|凌辱|羞辱|拘束|捆绑|绳艺|项圈|恋足|足控|肉偿|强制爱|母狗|肉便器|精盆|肉壶|口交|足交|乳交|肛交|舔乳|舔阴|舔脚|舔足|吮吸乳|乳首|奶头|奶子|揉奶|舔奶|吸奶|爆乳|内射|颜射|中出|潮吹|自慰|手淫|双性|扶她|兽交|轮奸|强奸|迷奸|乱伦|绿帽|绿奴|牛头人|媚黑|产卵|产乳|泌乳|催乳|失禁|露出癖|灌肠|尿道|身体开发|炮友|约炮|一夜情|嫖娼|卖淫|援交|多p|3p|群p|群交|乱交|黄暴|黄腔|肉汤|炖肉|后庭扩张|阴道扩张|工口|里番|重口|猎奇|血腥|虐杀|自残|(?:孕期|孕|羞耻|放置|窒息|露出|捆绑|催眠|电击|尿道|灌肠|黄金|强制)\s*play)/i.test(s)
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
    if (Array.isArray(settings.pinnedBooks)) {
        settings.pinnedBooks = settings.pinnedBooks.filter((n) => !removed.has(String(n ?? '').trim()));
    }
    if (Array.isArray(settings.globalPresets)) {
        for (const preset of settings.globalPresets) {
            if (preset && Array.isArray(preset.books)) {
                preset.books = preset.books.filter((n) => !removed.has(String(n ?? '').trim()));
            }
        }
    }
    if (settings.bookOrders && typeof settings.bookOrders === 'object') {
        for (const [gid, arr] of Object.entries(settings.bookOrders)) {
            if (!Array.isArray(arr)) continue;
            const next = arr.filter((n) => !removed.has(String(n ?? '').trim()));
            if (next.length > 0) settings.bookOrders[gid] = next;
            else delete settings.bookOrders[gid];
        }
    }
}

/**
 * Synchronously prune metadata entries referencing worldbooks that no longer exist
 * (covers deletions performed from SillyTavern's native UI as well as our plugin).
 * Safe no-op if `liveWorldNamesSet` is empty (e.g. during early boot before host loads).
 * @param {Record<string, any>} settings
 * @param {Set<string>} liveWorldNamesSet
 * @returns {boolean} true if any stale keys were removed
 */

export function pruneStaleWorldbookSettings(settings, liveWorldNamesSet) {
    if (!settings || !(liveWorldNamesSet instanceof Set) || liveWorldNamesSet.size === 0) {
        return false;
    }
    let changed = false;
    for (const dictKey of ['assignments', 'aliases', 'notes', 'charBookOverrides']) {
        const dict = settings[dictKey];
        if (!dict || typeof dict !== 'object') continue;
        for (const name of Object.keys(dict)) {
            if (!liveWorldNamesSet.has(name)) {
                delete dict[name];
                changed = true;
            }
        }
    }
    if (Array.isArray(settings.pinnedBooks)) {
        const nextPinned = settings.pinnedBooks.filter((name) => liveWorldNamesSet.has(String(name ?? '').trim()));
        if (nextPinned.length !== settings.pinnedBooks.length) {
            settings.pinnedBooks = nextPinned;
            changed = true;
        }
    }
    if (Array.isArray(settings.globalPresets)) {
        for (const preset of settings.globalPresets) {
            if (!preset || !Array.isArray(preset.books)) continue;
            const nextBooks = preset.books.filter((name) => liveWorldNamesSet.has(String(name ?? '').trim()));
            if (nextBooks.length !== preset.books.length) {
                preset.books = nextBooks;
                changed = true;
            }
        }
    }
    if (settings.bookOrders && typeof settings.bookOrders === 'object') {
        for (const [gid, arr] of Object.entries(settings.bookOrders)) {
            if (!Array.isArray(arr)) continue;
            const next = arr.filter((name) => liveWorldNamesSet.has(String(name ?? '').trim()));
            if (next.length !== arr.length) {
                if (next.length > 0) settings.bookOrders[gid] = next;
                else delete settings.bookOrders[gid];
                changed = true;
            }
        }
    }
    return changed;
}

/**
 * Zero-API, instant rule-based worldbook organizer using user-selected built-in categories,
 * optional bracket prefixes, optional custom user rules (`关键词 => 分组名`), and optional title cleanup.
 * Completely immune to AI safety refusals and consumes 0 API quota!
 *
 * @param {object} params
 * @param {Array<{ realName: string, currentAlias?: string, currentGroup?: string }>} params.books
 * @param {boolean} [params.usePrefix=true]
 * @param {boolean} [params.useAnyBracketPrefix=false]
 * @param {boolean} [params.useKeywords=true]
 * @param {boolean} [params.cleanTitles=false]
 * @param {string[] | Set<string> | null} [params.enabledCategoryIds=null]
 * @param {string} [params.customRulesText='']
 * @returns {Array<{ realName: string, alias: string, group: string, note: string }>}
 */
