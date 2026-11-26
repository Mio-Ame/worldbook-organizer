/**
 * Worldbook Entry Groups — Pure domain model, IF-line mutex planner,
 * O(1) metadata-only per-chat route memory, multi-author external script coordination,
 * scene-triggered auto-groups (e.g. NSFW), and multi-style worldbook layering detector.
 *
 * Zero DOM or browser globals required; zero multi-floor chat history scanning.
 */

export const MODULE_NAME = 'worldbook_entry_groups';

export const SPECIAL_GROUP_UNGROUPED = '__ungrouped__';

export const GROUP_MODES = Object.freeze({
    NORMAL: 'normal',
    IF_LINE: 'if_line',
    RADIO: 'radio',
    SCENE: 'scene',
});

export const VALID_PALETTES = Object.freeze(['paper', 'ink', 'warm', 'sakura', 'host']);
export const VALID_COLOR_MODES = Object.freeze(['auto', 'light', 'dark']);
export const VALID_EDITOR_HEIGHTS = Object.freeze(['S', 'M', 'L']);

export const WORLD_INFO_POSITION = Object.freeze({
    BEFORE: 0,
    AFTER: 1,
    AN_TOP: 2,
    AN_BOTTOM: 3,
    AT_DEPTH: 4,
    EM_TOP: 5,
    EM_BOTTOM: 6,
    OUTLET: 7,
});

export const ENTRY_ACTIVATION_MODES = Object.freeze({
    CONSTANT: 'constant',
    SELECTIVE: 'selective',
    VECTORIZED: 'vectorized',
});

const MAX_STORED_CHAT_PROFILES = 120;

const TITLE_TAG_REGEX = /<!---?[\s\u3000]*title[\s\u3000]*[:：][\s\u3000]*(.*?)[\s\u3000]*-?-->/i;
const DESC_TAG_REGEX = /<!---?[\s\u3000]*desc[\s\u3000]*[:：][\s\u3000]*(.*?)[\s\u3000]*-?-->/i;
const LORE_TAG_REGEX = /<!---?[\s\u3000]*lore[\s\u3000]*[:：][\s\u3000]*([\d,\s\u3000，]+)[\s\u3000]*-?-->/i;
const EXCLUDE_TAG_REGEX = /<!---?[\s\u3000]*exclude[\s\u3000]*[:：][\s\u3000]*([\d,\s\u3000，]+)[\s\u3000]*-?-->/i;
const ROUTE_INDEX_TAG_REGEX = /<!---?[\s\u3000]*route[\s\u3000]*[:：][\s\u3000]*(\d+)[\s\u3000]*-?-->/i;

// Common / shared base lore names MUST stay NORMAL (never auto-marked as mutually exclusive IF lines!)
const COMMON_BASE_NAME_REGEX = /(?:通用|常规|公共|基础|共用|主线基础|全局|必开|状态栏|变量列表|输出格式|输出规范|世界观基础)/i;
const IF_NAME_HINT_REGEX = /(?:^|[\s【\[「(（·\-_/:：|｜])(?:if\s*线?|分支|路线|支线|世界线|结局线|if\d+|\d+岁线?)(?:$|[\s】\]」)）·\-_/:：|｜\d])|(?:线)$/i;
const RADIO_SECTION_HINT_REGEX = /(?:自选|二选一|多选一|三选一|四选一|场景选择|身份选择|分支选择|路线选择)/i;
const NSFW_TITLE_HINT_REGEX = /\b(?:nsfw|nfsw|r18|18\+|smut|ero|dirtytalk)\b|(?:亲密剧情|亲密行为|亲密设定|情事|床笫|欢爱|肉体设定|敏感带|敏感点|性癖|瑟瑟|涩涩|色情|成人向|情欲|交合|体位|炖肉)/i;

/**
 * Built-in default trigger cues when a `scene` group leaves custom keywords blank.
 * Matched ONLY against the latest 1–2 turn snippets (capped to ~600 chars per turn).
 */
export const DEFAULT_SCENE_KEYWORDS = Object.freeze([
    '亲吻', '深吻', '接吻', '吻住', '唇舌', '舌尖',
    '喘息', '低喘', '娇喘', '呻吟',
    '褪去', '解开衣', '衣扣', '衣衫半解', '赤裸', '寸缕',
    '锁骨', '耳垂', '腰肢', '腿间', '私密', '下身',
    '情欲', '动情', '欲望', '滚烫', '缠绵',
    '交合', '进入身体', '抵住', '抽送', '顶弄', '高潮', '痉挛',
    'nsfw', 'r18',
]);

export function createGroupId(prefix = 'grp') {
    const rand = Math.random().toString(36).slice(2, 7);
    return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

export function normalizeKeywordList(raw) {
    const items = Array.isArray(raw)
        ? raw
        : String(raw ?? '').split(/[,，、;\n\r]+/);
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const clean = String(item ?? '').trim().toLowerCase();
        if (clean && !seen.has(clean)) {
            seen.add(clean);
            out.push(clean);
        }
    }
    return out.slice(0, 60);
}

export function normalizeBookConfig(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const seenIds = new Set();
    const groups = [];

    if (Array.isArray(src.groups)) {
        for (const item of src.groups) {
            if (!item || typeof item !== 'object') continue;
            const id = String(item.id ?? '').trim();
            const name = String(item.name ?? '').trim();
            if (!id || !name || id === SPECIAL_GROUP_UNGROUPED || seenIds.has(id)) continue;
            seenIds.add(id);

            const rawMode = String(item.mode ?? '').trim();
            const mode = (
                rawMode === GROUP_MODES.IF_LINE ||
                rawMode === GROUP_MODES.RADIO ||
                rawMode === GROUP_MODES.SCENE
            )
                ? rawMode
                : GROUP_MODES.NORMAL;

            const rawCooldown = Number.parseInt(String(item.cooldownTurns ?? 2), 10);
            const cooldownTurns = Number.isInteger(rawCooldown)
                ? Math.max(1, Math.min(10, rawCooldown))
                : 2;

            groups.push({
                id,
                name,
                mode,
                collapsed: Boolean(item.collapsed),
                sceneKeywords: normalizeKeywordList(item.sceneKeywords),
                cooldownTurns,
            });
        }
    }

    const assignments = {};
    if (src.assignments && typeof src.assignments === 'object' && !Array.isArray(src.assignments)) {
        for (const [rawUid, rawGroupId] of Object.entries(src.assignments)) {
            const uid = String(rawUid ?? '').trim();
            const groupId = String(rawGroupId ?? '').trim();
            if (!uid || !groupId || !seenIds.has(groupId)) continue;
            assignments[uid] = groupId;
        }
    }

    const pinnedGroupIds = [];
    const seenPinnedGroups = new Set();
    if (Array.isArray(src.pinnedGroupIds)) {
        for (const rawGid of src.pinnedGroupIds) {
            const gid = String(rawGid ?? '').trim();
            if (!gid || gid === SPECIAL_GROUP_UNGROUPED || !seenIds.has(gid) || seenPinnedGroups.has(gid)) continue;
            seenPinnedGroups.add(gid);
            pinnedGroupIds.push(gid);
        }
    }

    const pinnedEntryUids = [];
    const seenPinnedUids = new Set();
    if (Array.isArray(src.pinnedEntryUids)) {
        for (const rawUid of src.pinnedEntryUids) {
            const uid = String(rawUid ?? '').trim();
            if (!uid || seenPinnedUids.has(uid)) continue;
            seenPinnedUids.add(uid);
            pinnedEntryUids.push(uid);
        }
    }

    return {
        groups,
        assignments,
        ungroupedCollapsed: Boolean(src.ungroupedCollapsed),
        pinnedGroupIds,
        pinnedEntryUids,
    };
}

export function normalizeChatProfile(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const worldName = String(raw.worldName ?? '').trim();
    if (!worldName) return null;

    const entryDisabledMap = {};
    if (raw.entryDisabledMap && typeof raw.entryDisabledMap === 'object' && !Array.isArray(raw.entryDisabledMap)) {
        for (const [uid, dis] of Object.entries(raw.entryDisabledMap)) {
            const cleanUid = String(uid ?? '').trim();
            if (!cleanUid) continue;
            entryDisabledMap[cleanUid] = Boolean(dis);
        }
    }

    const ifGroupId = String(raw.ifGroupId ?? '').trim();
    const routeLabel = String(raw.routeLabel ?? '').trim();

    if (!ifGroupId && Object.keys(entryDisabledMap).length === 0) return null;

    return {
        worldName,
        routeLabel,
        ifGroupId,
        entryDisabledMap,
        updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
    };
}

export function cloneBookConfig(bookConfig) {
    const norm = normalizeBookConfig(bookConfig);
    return {
        groups: norm.groups.map((g) => ({
            ...g,
            sceneKeywords: [...(g.sceneKeywords || [])],
        })),
        assignments: { ...norm.assignments },
        ungroupedCollapsed: norm.ungroupedCollapsed,
        pinnedGroupIds: [...norm.pinnedGroupIds],
        pinnedEntryUids: [...norm.pinnedEntryUids],
    };
}

export function isBookConfigEmpty(bookConfig) {
    const norm = normalizeBookConfig(bookConfig);
    return (
        norm.groups.length === 0
        && Object.keys(norm.assignments).length === 0
        && norm.pinnedGroupIds.length === 0
        && norm.pinnedEntryUids.length === 0
    );
}

export function normalizeSettings(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const palette = VALID_PALETTES.includes(src.palette) ? src.palette : 'paper';
    const colorMode = VALID_COLOR_MODES.includes(src.colorMode) ? src.colorMode : 'auto';
    const rawHeight = String(src.editorHeightSize ?? '').trim().toUpperCase();
    const editorHeightSize = VALID_EDITOR_HEIGHTS.includes(rawHeight) ? rawHeight : 'M';

    const books = {};
    if (src.books && typeof src.books === 'object' && !Array.isArray(src.books)) {
        for (const [bookName, cfg] of Object.entries(src.books)) {
            const cleanName = String(bookName ?? '').trim();
            if (!cleanName) continue;
            const normalizedCfg = normalizeBookConfig(cfg);
            if (!isBookConfigEmpty(normalizedCfg)) {
                books[cleanName] = normalizedCfg;
            }
        }
    }

    const chatProfiles = {};
    if (src.chatProfiles && typeof src.chatProfiles === 'object' && !Array.isArray(src.chatProfiles)) {
        const validPairs = [];
        for (const [chatKey, prof] of Object.entries(src.chatProfiles)) {
            const cleanKey = String(chatKey ?? '').trim();
            if (!cleanKey) continue;
            const normProf = normalizeChatProfile(prof);
            if (normProf) {
                validPairs.push([cleanKey, normProf]);
            }
        }
        validPairs.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
        for (const [k, v] of validPairs.slice(0, MAX_STORED_CHAT_PROFILES)) {
            chatProfiles[k] = v;
        }
    }

    return {
        ...src,
        version: 1,
        palette,
        colorMode,
        showNativeEntryBtn: src.showNativeEntryBtn !== false,
        showWandMenuEntry: src.showWandMenuEntry !== false,
        closeOnLocate: src.closeOnLocate !== false,
        syncGreetingTags: src.syncGreetingTags !== false,
        autoSwitchOnChatChange: src.autoSwitchOnChatChange !== false,
        enableSceneAutoToggle: src.enableSceneAutoToggle !== false,
        searchMultiTerm: Boolean(src.searchMultiTerm),
        editorMonospace: Boolean(src.editorMonospace),
        editorHeightSize,
        lastOpenedBook: String(src.lastOpenedBook ?? '').trim(),
        books,
        chatProfiles,
    };
}

export function upsertStoredChatProfile(settings, chatKey, rawProfile) {
    const cleanKey = String(chatKey ?? '').trim();
    if (!settings || !cleanKey) return;
    if (!settings.chatProfiles || typeof settings.chatProfiles !== 'object') {
        settings.chatProfiles = {};
    }
    const norm = normalizeChatProfile(rawProfile);
    if (!norm) {
        delete settings.chatProfiles[cleanKey];
        return;
    }
    settings.chatProfiles[cleanKey] = norm;

    const keys = Object.keys(settings.chatProfiles);
    if (keys.length > MAX_STORED_CHAT_PROFILES) {
        keys.sort((a, b) => (settings.chatProfiles[b]?.updatedAt || 0) - (settings.chatProfiles[a]?.updatedAt || 0));
        for (const staleKey of keys.slice(MAX_STORED_CHAT_PROFILES)) {
            delete settings.chatProfiles[staleKey];
        }
    }
}

/**
 * Strip decorative wrapper symbols, directional arrows (`⬇️` / `⬆️`), and outer emoji pairs
 * from a divider comment so group names read cleanly (e.g. `——🐰🐰背景信息选择🦊🦊——` -> `背景信息选择`,
 * `——⬇️⬇️USER身份自选⬇️⬇️——` -> `USER身份自选`).
 *
 * @param {string} rawInner
 * @returns {string}
 */
function cleanDividerLabelText(rawInner) {
    let s = String(rawInner ?? '')
        .replace(/[=\-—─━═_*~～✦✧★☆◆◇■□▼▽▲△▸▹◂◃#⬇️⬆️↓↑⤵️⤴️\ufe0f]/g, ' ')
        .replace(/^[【\[「(（\s]+|[】\]」)）\s]+$/g, '')
        // Strip leading & trailing decorative emoji runs while keeping CJK / ASCII / numbers intact
        .replace(/^[\p{Extended_Pictographic}\s]+|[\p{Extended_Pictographic}\s]+$/gu, '')
        .replace(/^(?:以下是|下面是|以上是|上面是)\s*/, '')
        .replace(/\s*(?:结束|到此为止|分割线|分隔线)$/, '')
        .replace(/\s+/g, ' ')
        .trim();

    // Trim long parenthetical author instructions in divider headers like `常规信息，以下所有除了选开都别动`
    if (s.length > 10 && /[，,（(]/.test(s)) {
        const headPart = s.split(/[，,（(]/)[0].trim();
        if (headPart.length >= 2) {
            s = headPart;
        }
    }
    return s;
}

/**
 * Check whether an entry comment is a visual divider banner, distinguishing:
 * - `'start'`: explicitly opens a bounded block (e.g. `——⬇️⬇️神女线⬇️⬇️——`, `【以下是世界观】`)
 * - `'end'`: explicitly closes a bounded block (e.g. `——⬆️⬆️神女线⬆️⬆️——`, `=== 以上是权谋线 ===`)
 * - `'section'`: single header divider that starts a new section until the next divider (e.g. `——🐰🐰背景信息选择🦊🦊——`, `=== 基础设定 ===`)
 *
 * @param {string} rawComment
 * @param {{ disabled?: boolean, hasContent?: boolean, keyCount?: number }} [meta]
 * @returns {{ isDivider: boolean, dividerKind: 'none' | 'start' | 'end' | 'section', label: string, isPureBanner: boolean }}
 */
export function parseDividerComment(rawComment, meta = {}) {
    const text = String(rawComment ?? '').trim();
    const isEmptyBodyAndKeys = !meta.hasContent && (meta.keyCount || 0) === 0;
    if (!text) return { isDivider: false, dividerKind: 'none', label: '', isPureBanner: false };

    const hasUpEndCue = /(?:⬆️|▲|△|↑|⤴️|以上是|上面是|到此为止|(?:^|\s)end(?:\s|$))/i.test(text);
    const hasDownStartCue = /(?:⬇️|▼|▽|↓|⤵️|以下是|下面是)/i.test(text);

    // 1. Explicit decorative line wrappers (`——...——`, `===...===`, `---...---`, `──...──`)
    // Require closing wrapper when the entry carries content or trigger keys so normal `## Title` / `-- Note` entries are never misclassified.
    let wrappedMatch = text.match(
        /^(?:[=\-—─━═_*~～✦✧★☆◆◇■□▼▽▲△▸▹#]{2,}|【[\s=\-—─━═_*~～]{1,})\s*(.+?)\s*(?:[=\-—─━═_*~～✦✧★☆◆◇■□▼▽▲△◂◃#]{2,}|[\s=\-—─━═_*~～]{1,}】)$/,
    );
    if (!wrappedMatch && isEmptyBodyAndKeys) {
        wrappedMatch = text.match(
            /^(?:[=\-—─━═_*~～✦✧★☆◆◇■□▼▽▲△▸▹#]{1,}\s*(.+?)\s*[=\-—─━═_*~～✦✧★☆◆◇■□▼▽▲△◂◃#]{1,}|(?:[=\-—─━═_*~～✦✧★☆◆◇■□▼▽▲△▸▹#]{2,}|【[\s=\-—─━═_*~～]{1,})\s*(.+?))$/,
        );
        if (wrappedMatch && !wrappedMatch[1] && wrappedMatch[2]) {
            wrappedMatch[1] = wrappedMatch[2];
        }
    }
    if (wrappedMatch) {
        const label = cleanDividerLabelText(wrappedMatch[1]);
        if (hasUpEndCue && !hasDownStartCue) {
            return { isDivider: true, dividerKind: 'end', label, isPureBanner: isEmptyBodyAndKeys };
        }
        if (label.length >= 1 && label.length <= 28) {
            return {
                isDivider: true,
                dividerKind: hasDownStartCue ? 'start' : 'section',
                label,
                isPureBanner: isEmptyBodyAndKeys,
            };
        }
        if (isEmptyBodyAndKeys) {
            return { isDivider: true, dividerKind: 'section', label: '', isPureBanner: true };
        }
    }

    // 2. Empty-body keyless banner entry (`【以下是世界观】`, `▼ 校园线 ▼`, `▲ 校园线结束 ▲`)
    if (isEmptyBodyAndKeys && (hasDownStartCue || hasUpEndCue)) {
        const label = cleanDividerLabelText(text);
        if (hasUpEndCue && !hasDownStartCue) {
            return { isDivider: true, dividerKind: 'end', label, isPureBanner: true };
        }
        if (label.length >= 2 && label.length <= 24) {
            return { isDivider: true, dividerKind: 'start', label, isPureBanner: true };
        }
    }

    return { isDivider: false, dividerKind: 'none', label: '', isPureBanner: false };
}

/**
 * Extract lightweight entry summaries from a raw worldbook JSON object (supports both standalone
 * SillyTavern worldbook JSON and character-card `character_book` format!).
 * Discards `entry.content` immediately so 200+ entries consume minimal memory on iOS WebViews.
 */
export function extractWorldbookEntrySummaries(payload) {
    const entriesObj = payload?.entries;
    if (!entriesObj || typeof entriesObj !== 'object') return [];

    const pairs = Array.isArray(entriesObj)
        ? entriesObj.map((e, i) => [String(e?.uid ?? e?.id ?? i), e])
        : Object.entries(entriesObj);

    const summaries = [];
    for (let i = 0; i < pairs.length; i += 1) {
        const [fallbackKey, entry] = pairs[i];
        if (!entry || typeof entry !== 'object') continue;

        const uid = String(entry.uid ?? entry.id ?? fallbackKey).trim();
        if (!uid) continue;
        const num = Number(uid);
        const numericUid = Number.isInteger(num) && num >= 0 ? num : null;

        const rawComment = String(entry.comment ?? '').trim();
        const rawKeyArr = Array.isArray(entry.key)
            ? entry.key
            : (Array.isArray(entry.keys) ? entry.keys : []);
        const allKeys = rawKeyArr.map((k) => String(k ?? '').trim()).filter(Boolean);
        const keys = allKeys.slice(0, 6);

        const disabled = 'disable' in entry
            ? Boolean(entry.disable)
            : ('enabled' in entry ? !entry.enabled : false);

        const rawContent = String(entry.content ?? '');
        const hasContent = Boolean(rawContent.trim());
        const dividerInfo = parseDividerComment(rawComment, {
            disabled,
            hasContent,
            keyCount: allKeys.length,
        });

        const title = rawComment || keys.slice(0, 2).join(' / ') || `未命名条目 #${uid}`;
        const order = Number.isFinite(Number(entry.order ?? entry.insertion_order))
            ? Number(entry.order ?? entry.insertion_order)
            : 100;
        const rawDisplayIdx = entry.displayIndex ?? entry.extensions?.display_index;
        const displayIndex = Number.isFinite(Number(rawDisplayIdx))
            ? Number(rawDisplayIdx)
            : (Number.isFinite(Number(entry.order)) ? Number(entry.order) : (numericUid ?? i));

        summaries.push({
            uid,
            numericUid,
            title,
            rawComment,
            keys,
            searchText: rawContent.toLowerCase(),
            disabled,
            constant: Boolean(entry.constant),
            vectorized: Boolean(entry.vectorized ?? entry.extensions?.vectorized),
            selective: Boolean(entry.selective),
            order,
            displayIndex,
            isDivider: dividerInfo.isDivider,
            dividerKind: dividerInfo.dividerKind,
            dividerLabel: dividerInfo.label,
            isPureBanner: dividerInfo.isPureBanner,
        });
    }

    summaries.sort((a, b) => {
        if (a.displayIndex !== b.displayIndex) return a.displayIndex - b.displayIndex;
        if (a.numericUid !== null && b.numericUid !== null) return a.numericUid - b.numericUid;
        return a.uid.localeCompare(b.uid);
    });

    return summaries;
}

export function pruneOrphanAssignments(bookConfig, validUidSet) {
    if (!bookConfig || typeof bookConfig !== 'object' || !(validUidSet instanceof Set)) return 0;
    const groupIds = new Set((bookConfig.groups || []).map((g) => g.id));
    let removed = 0;

    if (bookConfig.assignments && typeof bookConfig.assignments === 'object') {
        for (const [uid, groupId] of Object.entries(bookConfig.assignments)) {
            if (!validUidSet.has(uid) || !groupIds.has(groupId)) {
                delete bookConfig.assignments[uid];
                removed += 1;
            }
        }
    }

    if (Array.isArray(bookConfig.pinnedEntryUids)) {
        const nextPinnedEntries = [];
        const seenUids = new Set();
        for (const rawUid of bookConfig.pinnedEntryUids) {
            const uid = String(rawUid ?? '').trim();
            if (!uid || !validUidSet.has(uid) || seenUids.has(uid)) {
                removed += 1;
                continue;
            }
            seenUids.add(uid);
            nextPinnedEntries.push(uid);
        }
        bookConfig.pinnedEntryUids = nextPinnedEntries;
    }

    if (Array.isArray(bookConfig.pinnedGroupIds)) {
        const nextPinnedGroups = [];
        const seenGroups = new Set();
        for (const rawGid of bookConfig.pinnedGroupIds) {
            const gid = String(rawGid ?? '').trim();
            if (!gid || gid === SPECIAL_GROUP_UNGROUPED || !groupIds.has(gid) || seenGroups.has(gid)) {
                removed += 1;
                continue;
            }
            seenGroups.add(gid);
            nextPinnedGroups.push(gid);
        }
        bookConfig.pinnedGroupIds = nextPinnedGroups;
    }

    return removed;
}

export function setGroupPinned(bookConfig, groupId, forcePinned) {
    if (!bookConfig || typeof bookConfig !== 'object') return { changed: false, pinned: false };
    const gid = String(groupId ?? '').trim();
    if (!gid || gid === SPECIAL_GROUP_UNGROUPED) return { changed: false, pinned: false };
    const existsInGroups = Array.isArray(bookConfig.groups) && bookConfig.groups.some((g) => g.id === gid);
    if (!existsInGroups) return { changed: false, pinned: false };

    const current = [];
    const seen = new Set();
    if (Array.isArray(bookConfig.pinnedGroupIds)) {
        for (const raw of bookConfig.pinnedGroupIds) {
            const item = String(raw ?? '').trim();
            if (item && !seen.has(item)) {
                seen.add(item);
                current.push(item);
            }
        }
    }

    const wasPinned = seen.has(gid);
    const nextPinned = forcePinned !== undefined ? Boolean(forcePinned) : !wasPinned;
    if (nextPinned === wasPinned) {
        bookConfig.pinnedGroupIds = current;
        return { changed: false, pinned: wasPinned };
    }

    bookConfig.pinnedGroupIds = nextPinned
        ? [...current, gid]
        : current.filter((id) => id !== gid);

    return { changed: true, pinned: nextPinned };
}

export function setEntryPinned(bookConfig, uid, forcePinned) {
    if (!bookConfig || typeof bookConfig !== 'object') return { changed: false, pinned: false };
    const cleanUid = String(uid ?? '').trim();
    if (!cleanUid) return { changed: false, pinned: false };

    const current = [];
    const seen = new Set();
    if (Array.isArray(bookConfig.pinnedEntryUids)) {
        for (const raw of bookConfig.pinnedEntryUids) {
            const item = String(raw ?? '').trim();
            if (item && !seen.has(item)) {
                seen.add(item);
                current.push(item);
            }
        }
    }

    const wasPinned = seen.has(cleanUid);
    const nextPinned = forcePinned !== undefined ? Boolean(forcePinned) : !wasPinned;
    if (nextPinned === wasPinned) {
        bookConfig.pinnedEntryUids = current;
        return { changed: false, pinned: wasPinned };
    }

    bookConfig.pinnedEntryUids = nextPinned
        ? [...current, cleanUid]
        : current.filter((u) => u !== cleanUid);

    return { changed: true, pinned: nextPinned };
}

export function removeGroupFromBookConfig(bookConfig, groupId) {
    if (!bookConfig || typeof bookConfig !== 'object') return false;
    const gid = String(groupId ?? '').trim();
    if (!gid) return false;
    const idx = Array.isArray(bookConfig.groups) ? bookConfig.groups.findIndex((g) => g.id === gid) : -1;
    if (idx < 0) return false;

    bookConfig.groups.splice(idx, 1);
    if (bookConfig.assignments && typeof bookConfig.assignments === 'object') {
        for (const [uid, assigned] of Object.entries(bookConfig.assignments)) {
            if (assigned === gid) delete bookConfig.assignments[uid];
        }
    }
    if (Array.isArray(bookConfig.pinnedGroupIds)) {
        bookConfig.pinnedGroupIds = bookConfig.pinnedGroupIds.filter((id) => String(id ?? '').trim() !== gid);
    }
    return true;
}

export function buildGroupedView(entries, rawBookConfig, { sortPinned = true, sortPinnedEntries = sortPinned } = {}) {
    const bookConfig = normalizeBookConfig(rawBookConfig);
    const list = Array.isArray(entries) ? entries : [];
    const validUidSet = new Set(list.map((e) => e.uid));
    const pinnedGroupSet = new Set(bookConfig.pinnedGroupIds);
    const pinnedEntrySet = new Set(bookConfig.pinnedEntryUids);

    const orderEntries = (items) => {
        if (!sortPinnedEntries || pinnedEntrySet.size === 0 || items.length <= 1) return items;
        return [
            ...items.filter((e) => pinnedEntrySet.has(e.uid)),
            ...items.filter((e) => !pinnedEntrySet.has(e.uid)),
        ];
    };

    const bucketMap = new Map();
    for (const grp of bookConfig.groups) {
        bucketMap.set(grp.id, []);
    }
    const ungroupedEntries = [];

    for (const entry of list) {
        const assignedId = bookConfig.assignments[entry.uid];
        if (assignedId && bucketMap.has(assignedId)) {
            bucketMap.get(assignedId).push(entry);
        } else {
            ungroupedEntries.push(entry);
        }
    }

    const customSections = bookConfig.groups.map((grp) => {
        const items = orderEntries(bucketMap.get(grp.id) || []);
        const totalCount = items.length;
        const enabledCount = items.filter((e) => !e.disabled).length;
        return {
            id: grp.id,
            name: grp.name,
            mode: grp.mode,
            collapsed: Boolean(grp.collapsed),
            pinned: pinnedGroupSet.has(grp.id),
            sceneKeywords: grp.sceneKeywords || [],
            cooldownTurns: grp.cooldownTurns || 2,
            isUngrouped: false,
            entries: items,
            totalCount,
            enabledCount,
            allEnabled: totalCount > 0 && enabledCount === totalCount,
            someEnabled: enabledCount > 0 && enabledCount < totalCount,
        };
    });

    const orderedCustomSections = sortPinned && pinnedGroupSet.size > 0
        ? [...customSections.filter((s) => s.pinned), ...customSections.filter((s) => !s.pinned)]
        : customSections;

    const sortedUngrouped = orderEntries(ungroupedEntries);
    const ungroupedEnabledCount = sortedUngrouped.filter((e) => !e.disabled).length;
    const sections = [
        ...orderedCustomSections,
        {
            id: SPECIAL_GROUP_UNGROUPED,
            name: '未分组',
            mode: GROUP_MODES.NORMAL,
            collapsed: Boolean(bookConfig.ungroupedCollapsed),
            pinned: false,
            sceneKeywords: [],
            cooldownTurns: 2,
            isUngrouped: true,
            entries: sortedUngrouped,
            totalCount: sortedUngrouped.length,
            enabledCount: ungroupedEnabledCount,
            allEnabled: sortedUngrouped.length > 0 && ungroupedEnabledCount === sortedUngrouped.length,
            someEnabled: ungroupedEnabledCount > 0 && ungroupedEnabledCount < sortedUngrouped.length,
        },
    ];

    const ifLineSections = sections.filter((s) => !s.isUngrouped && s.mode === GROUP_MODES.IF_LINE);
    const activeIfLineSections = ifLineSections.filter((s) => s.enabledCount > 0);

    let orphanCount = 0;
    for (const uid of Object.keys(bookConfig.assignments)) {
        if (!validUidSet.has(uid)) orphanCount += 1;
    }

    const totalEnabled = list.filter((e) => !e.disabled).length;

    return {
        sections,
        pinnedGroupIds: [...bookConfig.pinnedGroupIds],
        pinnedEntryUids: [...bookConfig.pinnedEntryUids],
        totalEntries: list.length,
        totalEnabled,
        orphanCount,
        ifLineSummary: {
            groupCount: ifLineSections.length,
            activeGroupIds: activeIfLineSections.map((s) => s.id),
            activeGroupNames: activeIfLineSections.map((s) => s.name),
            hasConflict: activeIfLineSections.length > 1,
        },
    };
}

export function countPinnedEntries(entries, rawBookConfig) {
    const list = Array.isArray(entries) ? entries : [];
    const bookConfig = normalizeBookConfig(rawBookConfig);
    const pinnedEntrySet = new Set(bookConfig.pinnedEntryUids);
    const pinnedGroupSet = new Set(bookConfig.pinnedGroupIds);
    let count = 0;
    for (const entry of list) {
        if (!entry) continue;
        const uid = String(entry.uid ?? '').trim();
        if (!uid) continue;
        const gid = bookConfig.assignments[uid];
        if (pinnedEntrySet.has(uid) || (gid && pinnedGroupSet.has(gid))) {
            count += 1;
        }
    }
    return count;
}

export function matchEntries(
    entries,
    query,
    {
        multiTerm = false,
        statusFilter = 'all',
        greetingByUid = null,
        pinnedEntrySet = null,
        pinnedGroupSet = null,
        assignments = null,
    } = {},
) {
    const list = Array.isArray(entries) ? entries : [];
    const rawQ = String(query ?? '').trim().toLowerCase();
    const terms = rawQ
        ? (multiTerm ? rawQ.split(/\s+/).filter(Boolean) : [rawQ])
        : [];
    const pinUidSet = pinnedEntrySet instanceof Set
        ? pinnedEntrySet
        : (Array.isArray(pinnedEntrySet) ? new Set(pinnedEntrySet) : null);
    const pinGrpSet = pinnedGroupSet instanceof Set
        ? pinnedGroupSet
        : (Array.isArray(pinnedGroupSet) ? new Set(pinnedGroupSet) : null);
    const assignMap = assignments && typeof assignments === 'object' ? assignments : null;

    const matched = new Set();
    for (const entry of list) {
        if (statusFilter === 'enabled' && entry.disabled) continue;
        if (statusFilter === 'disabled' && !entry.disabled) continue;
        if (statusFilter === 'pinned') {
            const isEntryPinned = Boolean(pinUidSet?.has(entry.uid));
            const gid = assignMap ? assignMap[entry.uid] : '';
            const isGroupPinned = Boolean(gid && pinGrpSet?.has(gid));
            if (!isEntryPinned && !isGroupPinned) continue;
        }

        if (terms.length === 0) {
            matched.add(entry.uid);
            continue;
        }

        const greetInfo = greetingByUid?.get?.(entry.uid);
        const greetText = greetInfo
            ? [
                ...greetInfo.includeGreetings.map((g) => `${g.label} ${g.title}`),
                ...greetInfo.excludeGreetings.map((g) => `${g.label} ${g.title}`),
            ].join(' ')
            : '';

        const fullContentText = String(entry.searchText ?? entry.content ?? '');
        const haystack = `${entry.uid} ${entry.title} ${(entry.keys || []).join(' ')} ${fullContentText} ${greetText}`.toLowerCase();
        if (terms.every((t) => haystack.includes(t))) {
            matched.add(entry.uid);
        }
    }
    return matched;
}

export function sliceGroupedSectionsForRender(
    sections,
    { limit = 60, alwaysIncludeUids = new Set(), isFiltering = false } = {},
) {
    const list = Array.isArray(sections) ? sections : [];
    const includeSet = alwaysIncludeUids instanceof Set
        ? alwaysIncludeUids
        : new Set(Array.isArray(alwaysIncludeUids) ? alwaysIncludeUids : []);
    let budgetRemaining = limit === Infinity ? Infinity : Math.max(0, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 60);
    let totalCount = 0;
    let shownCount = 0;

    const slicedSections = [];
    for (const sec of list) {
        if (!sec) continue;
        const sourceEntries = Array.isArray(sec.visibleEntries)
            ? sec.visibleEntries
            : (Array.isArray(sec.entries) ? sec.entries : []);
        const isCollapsed = isFiltering ? false : Boolean(sec.effectiveCollapsed ?? sec.collapsed);

        if (isCollapsed) {
            slicedSections.push({
                ...sec,
                effectiveCollapsed: true,
                renderedEntries: [],
                hiddenInSectionCount: 0,
            });
            continue;
        }

        totalCount += sourceEntries.length;
        const renderedEntries = [];
        let hiddenInSectionCount = 0;

        for (const entry of sourceEntries) {
            const forceKeep = includeSet.has(entry.uid);
            if (budgetRemaining > 0) {
                renderedEntries.push(entry);
                if (budgetRemaining !== Infinity) budgetRemaining -= 1;
                shownCount += 1;
            } else if (forceKeep) {
                renderedEntries.push(entry);
                shownCount += 1;
            } else {
                hiddenInSectionCount += 1;
            }
        }

        slicedSections.push({
            ...sec,
            effectiveCollapsed: false,
            renderedEntries,
            hiddenInSectionCount,
        });
    }

    return {
        sections: slicedSections,
        shownCount,
        totalCount,
        hiddenCount: Math.max(0, totalCount - shownCount),
    };
}

export function computeGroupTogglePlan(entries, rawBookConfig, groupId, targetEnabled) {
    const bookConfig = normalizeBookConfig(rawBookConfig);
    const list = Array.isArray(entries) ? entries : [];
    const plan = new Map();

    if (groupId === SPECIAL_GROUP_UNGROUPED) {
        for (const entry of list) {
            const assigned = bookConfig.assignments[entry.uid];
            if (!assigned && !entry.isPureBanner) {
                plan.set(entry.uid, !targetEnabled);
            }
        }
        return plan;
    }

    const targetGroup = bookConfig.groups.find((g) => g.id === groupId);
    if (!targetGroup) return plan;

    const groupEntries = list.filter((e) => bookConfig.assignments[e.uid] === groupId);
    if (groupEntries.length === 0) return plan;

    if (targetGroup.mode === GROUP_MODES.RADIO) {
        if (!targetEnabled) {
            for (const entry of groupEntries) {
                plan.set(entry.uid, true);
            }
        } else {
            const alreadyActive = groupEntries.find((e) => !e.disabled) || groupEntries[0];
            for (const entry of groupEntries) {
                plan.set(entry.uid, entry.uid !== alreadyActive.uid);
            }
        }
        return plan;
    }

    for (const entry of groupEntries) {
        plan.set(entry.uid, !targetEnabled);
    }

    if (targetEnabled && targetGroup.mode === GROUP_MODES.IF_LINE) {
        const siblingIfIds = new Set(
            bookConfig.groups
                .filter((g) => g.mode === GROUP_MODES.IF_LINE && g.id !== groupId)
                .map((g) => g.id),
        );
        if (siblingIfIds.size > 0) {
            for (const entry of list) {
                const assigned = bookConfig.assignments[entry.uid];
                if (assigned && siblingIfIds.has(assigned)) {
                    plan.set(entry.uid, true);
                }
            }
        }
    }

    return plan;
}

export function computeEntryTogglePlan(entries, rawBookConfig, uid, targetEnabled) {
    const bookConfig = normalizeBookConfig(rawBookConfig);
    const list = Array.isArray(entries) ? entries : [];
    const targetUid = String(uid ?? '').trim();
    const plan = new Map();
    if (!targetUid) return plan;

    plan.set(targetUid, !targetEnabled);

    if (!targetEnabled) return plan;

    const groupId = bookConfig.assignments[targetUid];
    if (!groupId) return plan;

    const group = bookConfig.groups.find((g) => g.id === groupId);
    if (!group) return plan;

    if (group.mode === GROUP_MODES.RADIO) {
        for (const entry of list) {
            if (bookConfig.assignments[entry.uid] === groupId && entry.uid !== targetUid) {
                plan.set(entry.uid, true);
            }
        }
    } else if (group.mode === GROUP_MODES.IF_LINE) {
        const siblingIfIds = new Set(
            bookConfig.groups
                .filter((g) => g.mode === GROUP_MODES.IF_LINE && g.id !== groupId)
                .map((g) => g.id),
        );
        if (siblingIfIds.size > 0) {
            for (const entry of list) {
                const assigned = bookConfig.assignments[entry.uid];
                if (assigned && siblingIfIds.has(assigned)) {
                    plan.set(entry.uid, true);
                }
            }
        }
    }

    return plan;
}

/**
 * Compute a single-pass `Map<uid, nextDisabled>` to apply a greeting preset (`<!-- lore / exclude -->`)!
 * Safely handles overlapping common + branch lore (e.g. `#1 灯节重逢` vs `#2 抢婚` vs `#9 神女user`):
 * enables all `loreUids` of that greeting (unless excluded) and disables all other `managedUidSet` entries!
 *
 * @param {Array<any>} entries
 * @param {ReturnType<typeof buildGreetingCoordinationIndex>} greetingIndex
 * @param {number} swipeIndex
 * @returns {{ plan: Map<string, boolean>, routeLabel: string } | null}
 */
export function computeGreetingPresetPlan(entries, greetingIndex, swipeIndex) {
    if (!greetingIndex?.greetings) return null;
    const target = greetingIndex.greetings.find((g) => g.swipeIndex === Number(swipeIndex));
    if (!target || (target.loreUids.length === 0 && target.excludeUids.length === 0)) return null;

    const validUidSet = new Set((entries || []).map((e) => e.uid));
    const activeSet = new Set(target.loreUids);
    const excludeSet = new Set(target.excludeUids);
    const plan = new Map();

    for (const uid of greetingIndex.managedUidSet) {
        if (!validUidSet.has(uid)) continue;
        const shouldEnable = activeSet.has(uid) && !excludeSet.has(uid);
        plan.set(uid, !shouldEnable);
    }
    for (const uid of activeSet) {
        if (validUidSet.has(uid)) plan.set(uid, excludeSet.has(uid));
    }
    for (const uid of excludeSet) {
        if (validUidSet.has(uid)) plan.set(uid, true);
    }

    const routeLabel = target.title
        ? `${target.label} ${target.title}`
        : `开场白 ${target.label}`;
    return { plan, routeLabel };
}

export function evaluateSceneAutoToggle({
    entries,
    bookConfig: rawBookConfig,
    recentText,
    cooldownByGroupId = {},
}) {
    const bookConfig = normalizeBookConfig(rawBookConfig);
    const list = Array.isArray(entries) ? entries : [];
    const togglePlan = new Map();
    const nextCooldownByGroupId = { ...(cooldownByGroupId || {}) };
    const activatedGroups = [];
    const deactivatedGroups = [];

    const sceneGroups = bookConfig.groups.filter((g) => g.mode === GROUP_MODES.SCENE);
    if (sceneGroups.length === 0 || list.length === 0) {
        return { togglePlan, nextCooldownByGroupId, activatedGroups, deactivatedGroups };
    }

    const sample = String(recentText ?? '').slice(-1500).toLowerCase();

    for (const grp of sceneGroups) {
        const groupEntries = list.filter((e) => bookConfig.assignments[e.uid] === grp.id);
        if (groupEntries.length === 0) continue;

        const keywords = grp.sceneKeywords && grp.sceneKeywords.length > 0
            ? grp.sceneKeywords
            : DEFAULT_SCENE_KEYWORDS;

        const isHit = Boolean(sample) && keywords.some((kw) => kw && sample.includes(kw));
        const prevCooldown = Number(nextCooldownByGroupId[grp.id] || 0);

        let shouldBeEnabled = false;
        if (isHit) {
            shouldBeEnabled = true;
            nextCooldownByGroupId[grp.id] = grp.cooldownTurns || 2;
        } else if (prevCooldown > 0) {
            shouldBeEnabled = true;
            nextCooldownByGroupId[grp.id] = prevCooldown - 1;
        } else {
            shouldBeEnabled = false;
            nextCooldownByGroupId[grp.id] = 0;
        }

        const desiredDisabled = !shouldBeEnabled;
        let anyChangedInGroup = false;
        for (const entry of groupEntries) {
            if (Boolean(entry.disabled) !== desiredDisabled) {
                togglePlan.set(entry.uid, desiredDisabled);
                anyChangedInGroup = true;
            }
        }

        if (anyChangedInGroup) {
            if (shouldBeEnabled) activatedGroups.push(grp.name);
            else deactivatedGroups.push(grp.name);
        }
    }

    return {
        togglePlan,
        nextCooldownByGroupId,
        activatedGroups,
        deactivatedGroups,
    };
}

export function applyTogglePlanToPayload(payload, togglePlan) {
    const entriesObj = payload?.entries;
    if (!entriesObj || typeof entriesObj !== 'object' || !(togglePlan instanceof Map) || togglePlan.size === 0) {
        return { changedCount: 0, appliedChanges: [] };
    }

    const appliedChanges = [];
    const entryByUid = new Map();
    if (Array.isArray(entriesObj)) {
        entriesObj.forEach((entry, idx) => {
            if (entry && typeof entry === 'object') {
                entryByUid.set(String(entry.uid ?? entry.id ?? idx), entry);
            }
        });
    } else {
        for (const [k, entry] of Object.entries(entriesObj)) {
            if (entry && typeof entry === 'object') {
                entryByUid.set(String(entry.uid ?? entry.id ?? k), entry);
            }
        }
    }

    for (const [uid, nextDisabled] of togglePlan.entries()) {
        const entry = entryByUid.get(String(uid));
        if (!entry) continue;
        const currentDisabled = 'disable' in entry ? Boolean(entry.disable) : ('enabled' in entry ? !entry.enabled : false);
        if (currentDisabled !== Boolean(nextDisabled)) {
            if ('disable' in entry || !('enabled' in entry)) {
                entry.disable = Boolean(nextDisabled);
            }
            if ('enabled' in entry) {
                entry.enabled = !nextDisabled;
            }
            appliedChanges.push({ uid: String(uid), disabled: Boolean(nextDisabled) });
        }
    }

    return {
        changedCount: appliedChanges.length,
        appliedChanges,
    };
}

/**
 * Parse worldbook trigger keywords (`key` / `keysecondary`) while preserving exact case
 * and avoiding splitting commas inside `/pattern/flags` regex literals.
 *
 * @param {string | Array<any>} raw
 * @returns {string[]}
 */
export function parseEntryKeywordsInput(raw) {
    let rawTokens = [];
    if (Array.isArray(raw)) {
        rawTokens = raw.map((item) => String(item ?? ''));
    } else {
        const text = String(raw ?? '');
        let i = 0;
        const n = text.length;
        let buf = '';
        while (i < n) {
            const ch = text[i];
            if (ch === '/' && buf.trim() === '') {
                let j = i + 1;
                let escaped = false;
                let inCharClass = false;
                let foundEnd = -1;
                while (j < n) {
                    const c = text[j];
                    if (escaped) {
                        escaped = false;
                    } else if (c === '\\') {
                        escaped = true;
                    } else if (c === '[' && !inCharClass) {
                        inCharClass = true;
                    } else if (c === ']' && inCharClass) {
                        inCharClass = false;
                    } else if (c === '/' && !inCharClass) {
                        let k = j + 1;
                        while (k < n && /[gimsuy]/i.test(text[k])) k += 1;
                        let m = k;
                        while (m < n && (text[m] === ' ' || text[m] === '\t')) m += 1;
                        if (m === n || text[m] === ',' || text[m] === '，' || text[m] === '\n' || text[m] === '\r') {
                            foundEnd = k;
                            break;
                        }
                    } else if (c === '\n' || c === '\r') {
                        break;
                    }
                    j += 1;
                }
                if (foundEnd > i) {
                    const candidate = text.slice(i, foundEnd);
                    const slashIdx = candidate.lastIndexOf('/');
                    if (slashIdx > 1) {
                        rawTokens.push(candidate);
                        buf = '';
                        i = foundEnd;
                        while (i < n && (text[i] === ' ' || text[i] === '\t')) i += 1;
                        if (i < n && (text[i] === ',' || text[i] === '，' || text[i] === '\n' || text[i] === '\r')) {
                            i += 1;
                        }
                        continue;
                    }
                }
            }
            if (ch === ',' || ch === '，' || ch === '\n' || ch === '\r') {
                rawTokens.push(buf);
                buf = '';
            } else {
                buf += ch;
            }
            i += 1;
        }
        if (buf) rawTokens.push(buf);
    }

    const seen = new Set();
    const out = [];
    for (const token of rawTokens) {
        const clean = String(token ?? '').trim();
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        out.push(clean);
    }
    return out;
}

export function findRawEntryInPayload(payload, uid) {
    const targetUid = String(uid ?? '').trim();
    const entriesObj = payload?.entries;
    if (!targetUid || !entriesObj || typeof entriesObj !== 'object') return null;

    if (Array.isArray(entriesObj)) {
        for (let i = 0; i < entriesObj.length; i += 1) {
            const entry = entriesObj[i];
            if (!entry || typeof entry !== 'object') continue;
            if (String(entry.uid ?? entry.id ?? i).trim() === targetUid) {
                return { containerType: 'array', keyOrIndex: i, entry };
            }
        }
        return null;
    }

    for (const [k, entry] of Object.entries(entriesObj)) {
        if (!entry || typeof entry !== 'object') continue;
        if (String(entry.uid ?? entry.id ?? k).trim() === targetUid) {
            return { containerType: 'object', keyOrIndex: k, entry };
        }
    }
    return null;
}

function normalizePositionValue(rawPos) {
    if (rawPos === 'before_char') return WORLD_INFO_POSITION.BEFORE;
    if (rawPos === 'after_char') return WORLD_INFO_POSITION.AFTER;
    const parsed = Number.parseInt(String(rawPos ?? 0), 10);
    if (!Number.isInteger(parsed)) return WORLD_INFO_POSITION.BEFORE;
    return Math.max(WORLD_INFO_POSITION.BEFORE, Math.min(WORLD_INFO_POSITION.OUTLET, parsed));
}

function normalizeDepthValue(rawDepth) {
    const parsed = Number.parseInt(String(rawDepth ?? 4), 10);
    if (!Number.isInteger(parsed)) return 4;
    return Math.max(0, Math.min(1000, parsed));
}

function normalizeOrderValue(rawOrder) {
    const num = Number(rawOrder);
    if (!Number.isFinite(num)) return 100;
    return Math.round(num);
}

export function extractEditableEntrySnapshot(rawEntry, fallbackUid = '') {
    const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
    const uid = String(entry.uid ?? entry.id ?? fallbackUid).trim();
    const rawKey = Array.isArray(entry.key) ? entry.key : (Array.isArray(entry.keys) ? entry.keys : []);
    const rawKey2 = Array.isArray(entry.keysecondary)
        ? entry.keysecondary
        : (Array.isArray(entry.secondary_keys) ? entry.secondary_keys : []);

    const enabled = 'disable' in entry
        ? !entry.disable
        : ('enabled' in entry ? Boolean(entry.enabled) : true);

    const isConstant = Boolean(entry.constant);
    const isVectorized = Boolean(entry.vectorized ?? entry.extensions?.vectorized);
    const mode = isConstant
        ? ENTRY_ACTIVATION_MODES.CONSTANT
        : (isVectorized ? ENTRY_ACTIVATION_MODES.VECTORIZED : ENTRY_ACTIVATION_MODES.SELECTIVE);

    return {
        uid,
        comment: String(entry.comment ?? ''),
        enabled,
        mode,
        key: parseEntryKeywordsInput(rawKey),
        keysecondary: parseEntryKeywordsInput(rawKey2),
        position: normalizePositionValue(entry.position ?? entry.extensions?.position),
        depth: normalizeDepthValue(entry.depth ?? entry.extensions?.depth),
        order: normalizeOrderValue(entry.order ?? entry.insertion_order ?? 100),
        content: String(entry.content ?? ''),
    };
}

export function computeEditDirty(initial, draft) {
    if (!initial || !draft) return false;
    if (String(draft.comment ?? '') !== String(initial.comment ?? '')) return true;
    if (Boolean(draft.enabled) !== Boolean(initial.enabled)) return true;
    if (String(draft.mode ?? '') !== String(initial.mode ?? '')) return true;
    if (Number(draft.position) !== Number(initial.position)) return true;
    if (Number(draft.depth) !== Number(initial.depth)) return true;
    if (Number(draft.order) !== Number(initial.order)) return true;
    if (String(draft.content ?? '') !== String(initial.content ?? '')) return true;
    if (JSON.stringify(draft.key || []) !== JSON.stringify(initial.key || [])) return true;
    if (JSON.stringify(draft.keysecondary || []) !== JSON.stringify(initial.keysecondary || [])) return true;
    return false;
}

export function estimateEntryTokens(text) {
    const str = String(text ?? '');
    if (!str) return 0;
    const cjkMatches = str.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/g);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    const spaceMatches = str.match(/\s/g);
    const spaceCount = spaceMatches ? spaceMatches.length : 0;
    const otherCount = Math.max(0, str.length - cjkCount - spaceCount);
    const estimate = cjkCount * 1.5 + otherCount / 4 + spaceCount / 4;
    return Math.max(1, Math.ceil(estimate));
}

export function applyTextareaTabIndent(value, selectionStart, selectionEnd, { shiftKey = false, indentStr = '  ' } = {}) {
    const text = String(value ?? '');
    const start = Math.max(0, Math.min(text.length, Number.isFinite(Number(selectionStart)) ? Number(selectionStart) : 0));
    const end = Math.max(start, Math.min(text.length, Number.isFinite(Number(selectionEnd)) ? Number(selectionEnd) : start));
    const indent = String(indentStr || '  ');

    if (!shiftKey && start === end) {
        const nextVal = text.slice(0, start) + indent + text.slice(end);
        const nextPos = start + indent.length;
        return { value: nextVal, selectionStart: nextPos, selectionEnd: nextPos };
    }

    const firstLineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
    const effectiveEnd = end > start && text[end - 1] === '\n' ? end - 1 : end;
    const lastLineEndIdx = text.indexOf('\n', effectiveEnd);
    const blockEnd = lastLineEndIdx === -1 ? text.length : lastLineEndIdx;

    const prefix = text.slice(0, firstLineStart);
    const block = text.slice(firstLineStart, blockEnd);
    const suffix = text.slice(blockEnd);
    const lines = block.split('\n');

    if (!shiftKey) {
        const indentedLines = lines.map((line) => indent + line);
        const nextBlock = indentedLines.join('\n');
        const nextStart = start === firstLineStart ? firstLineStart : start + indent.length;
        const nextEnd = end + indent.length * lines.length;
        return {
            value: prefix + nextBlock + suffix,
            selectionStart: nextStart,
            selectionEnd: nextEnd,
        };
    }

    let removedFirst = 0;
    let totalRemoved = 0;
    const outdentedLines = lines.map((line, idx) => {
        let removed = 0;
        if (line.startsWith('\t')) {
            removed = 1;
        } else {
            while (removed < indent.length && line[removed] === ' ') {
                removed += 1;
            }
        }
        if (idx === 0) removedFirst = removed;
        totalRemoved += removed;
        return line.slice(removed);
    });

    const nextBlock = outdentedLines.join('\n');
    const nextStart = Math.max(firstLineStart, start - removedFirst);
    const nextEnd = Math.max(nextStart, end - totalRemoved);
    return {
        value: prefix + nextBlock + suffix,
        selectionStart: nextStart,
        selectionEnd: nextEnd,
    };
}

export function createTextareaHistory(
    initialValue = '',
    initialSelectionStart = 0,
    initialSelectionEnd = 0,
    { maxSteps = 80 } = {},
) {
    const cap = Math.max(5, Math.min(300, Number(maxSteps) || 80));
    let undoStack = [];
    let redoStack = [];
    let current = {
        value: String(initialValue ?? ''),
        selectionStart: Math.max(0, Number(initialSelectionStart) || 0),
        selectionEnd: Math.max(0, Number(initialSelectionEnd) || 0),
    };

    return {
        push(nextValue, selStart = 0, selEnd = selStart) {
            const val = String(nextValue ?? '');
            const start = Math.max(0, Math.min(val.length, Number(selStart) || 0));
            const end = Math.max(start, Math.min(val.length, Number(selEnd) || start));
            if (val === current.value) {
                current = { value: val, selectionStart: start, selectionEnd: end };
                return false;
            }
            undoStack.push(current);
            if (undoStack.length > cap) undoStack.shift();
            current = { value: val, selectionStart: start, selectionEnd: end };
            redoStack = [];
            return true;
        },
        undo() {
            if (undoStack.length === 0) return null;
            redoStack.push(current);
            current = undoStack.pop();
            return { ...current };
        },
        redo() {
            if (redoStack.length === 0) return null;
            undoStack.push(current);
            current = redoStack.pop();
            return { ...current };
        },
        reset(nextValue = '', selStart = 0, selEnd = selStart) {
            const val = String(nextValue ?? '');
            const start = Math.max(0, Math.min(val.length, Number(selStart) || 0));
            const end = Math.max(start, Math.min(val.length, Number(selEnd) || start));
            undoStack = [];
            redoStack = [];
            current = { value: val, selectionStart: start, selectionEnd: end };
        },
        canUndo() {
            return undoStack.length > 0;
        },
        canRedo() {
            return redoStack.length > 0;
        },
        getCurrent() {
            return { ...current };
        },
    };
}

export function findNextMatchInText(
    text,
    query,
    fromIndex = 0,
    { direction = 'next', caseSensitive = false } = {},
) {
    const rawText = String(text ?? '');
    const rawQuery = String(query ?? '');
    if (!rawText || !rawQuery) {
        return { found: false, start: -1, end: -1, matchIndex: -1, totalMatches: 0 };
    }

    const haystack = caseSensitive ? rawText : rawText.toLowerCase();
    const needle = caseSensitive ? rawQuery : rawQuery.toLowerCase();
    const matches = [];
    let pos = 0;
    while (pos <= haystack.length - needle.length) {
        const idx = haystack.indexOf(needle, pos);
        if (idx === -1) break;
        matches.push({ start: idx, end: idx + needle.length });
        pos = idx + Math.max(1, needle.length);
    }

    if (matches.length === 0) {
        return { found: false, start: -1, end: -1, matchIndex: -1, totalMatches: 0 };
    }

    const clampedFrom = Math.max(0, Math.min(rawText.length, Number(fromIndex) || 0));
    let chosenIdx = 0;

    if (direction === 'prev') {
        chosenIdx = -1;
        for (let i = matches.length - 1; i >= 0; i -= 1) {
            if (matches[i].start < clampedFrom) {
                chosenIdx = i;
                break;
            }
        }
        if (chosenIdx === -1) chosenIdx = matches.length - 1;
    } else {
        chosenIdx = matches.findIndex((m) => m.start >= clampedFrom);
        if (chosenIdx === -1) chosenIdx = 0;
    }

    const chosen = matches[chosenIdx];
    return {
        found: true,
        start: chosen.start,
        end: chosen.end,
        matchIndex: chosenIdx,
        totalMatches: matches.length,
    };
}

function cloneEditableSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return null;
    return {
        ...snap,
        key: Array.isArray(snap.key) ? [...snap.key] : [],
        keysecondary: Array.isArray(snap.keysecondary) ? [...snap.keysecondary] : [],
    };
}

export function reconcileAccordionDraftOnExternalRefresh(editorState, latestEntrySnapshot) {
    if (!editorState || typeof editorState !== 'object') {
        return { action: 'close', nextInitial: null, nextDraft: null, externalStale: false };
    }
    const isDirty = Boolean(editorState.dirty);
    const prevInitial = editorState.initialSnapshot || null;
    const prevDraft = editorState.draft || null;

    if (!latestEntrySnapshot || typeof latestEntrySnapshot !== 'object') {
        if (!isDirty) {
            return { action: 'close', nextInitial: null, nextDraft: null, externalStale: false };
        }
        return {
            action: 'warn-deleted',
            nextInitial: prevInitial,
            nextDraft: prevDraft,
            externalStale: true,
        };
    }

    const latestClone = cloneEditableSnapshot(latestEntrySnapshot);
    if (!isDirty) {
        return {
            action: 'update-clean',
            nextInitial: latestClone,
            nextDraft: cloneEditableSnapshot(latestClone),
            externalStale: false,
        };
    }

    const externallyChanged = prevInitial
        ? computeEditDirty(prevInitial, latestClone)
        : true;
    if (!externallyChanged) {
        return {
            action: 'keep-dirty-unchanged',
            nextInitial: prevInitial,
            nextDraft: prevDraft,
            externalStale: false,
        };
    }

    return {
        action: 'mark-external-stale',
        nextInitial: latestClone,
        nextDraft: prevDraft,
        externalStale: true,
    };
}

export function collectOrphanedOpenDrafts(openEditors, summaries, currentBook = '') {
    if (!openEditors) return [];
    const pairs = openEditors instanceof Map
        ? [...openEditors.entries()]
        : (typeof openEditors === 'object' ? Object.entries(openEditors) : []);
    const validUidSet = new Set(
        (Array.isArray(summaries) ? summaries : [])
            .map((s) => String(s?.uid ?? '').trim())
            .filter(Boolean),
    );
    const cleanBook = String(currentBook ?? '').trim();
    const orphaned = [];

    for (const [rawUid, state] of pairs) {
        if (!state || typeof state !== 'object') continue;
        const uid = String(state.uid ?? rawUid ?? '').trim();
        if (!uid) continue;
        if (cleanBook && state.worldName && state.worldName !== cleanBook) continue;
        if (validUidSet.has(uid) && !state.externalDeleted) continue;
        if (!state.dirty && !state.externalDeleted) continue;

        const title = String(
            state.draft?.comment
            || state.initialSnapshot?.comment
            || state.draft?.key?.[0]
            || state.initialSnapshot?.key?.[0]
            || '',
        ).trim();

        orphaned.push({
            uid,
            title,
            worldName: String(state.worldName ?? cleanBook),
            dirty: Boolean(state.dirty),
            externalDeleted: true,
        });
    }

    return orphaned;
}

export function formatOrphanedDraftText(state) {
    if (!state || typeof state !== 'object') return '';
    const src = state.draft || state.initialSnapshot || {};
    const parts = [];
    const comment = String(src.comment ?? '').trim();
    const keys = Array.isArray(src.key) ? src.key.filter(Boolean) : [];
    const keys2 = Array.isArray(src.keysecondary) ? src.keysecondary.filter(Boolean) : [];
    if (comment) parts.push(`标题：${comment}`);
    if (keys.length > 0) parts.push(`主触发词：${keys.join(', ')}`);
    if (keys2.length > 0) parts.push(`次触发词：${keys2.join(', ')}`);
    const content = String(src.content ?? '');
    if (parts.length > 0) {
        parts.push('');
    }
    parts.push(content);
    return parts.join('\n');
}

/**
 * Losslessly patch ONLY the edited lightweight fields onto a copy of `rawEntry`,
 * preserving 100% of undisplayed / unknown SillyTavern native fields (`probability`,
 * `selectiveLogic`, `excludeRecursion`, `group`, `role`, `extensions`, custom keys, etc.).
 */
export function applyEntryEditPatchToRawEntry(rawEntry, editPatch = {}) {
    const base = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
    const patch = editPatch && typeof editPatch === 'object' ? editPatch : {};
    const updatedEntry = { ...base };

    const prevDisabled = 'disable' in base
        ? Boolean(base.disable)
        : ('enabled' in base ? !base.enabled : false);

    if ('comment' in patch) {
        updatedEntry.comment = String(patch.comment ?? '');
    }

    if ('enabled' in patch) {
        const nextEnabled = Boolean(patch.enabled);
        updatedEntry.disable = !nextEnabled;
        if ('enabled' in base) {
            updatedEntry.enabled = nextEnabled;
        }
    } else if ('disable' in patch) {
        const nextDisabled = Boolean(patch.disable);
        updatedEntry.disable = nextDisabled;
        if ('enabled' in base) {
            updatedEntry.enabled = !nextDisabled;
        }
    }

    if ('key' in patch) {
        const parsedKeys = parseEntryKeywordsInput(patch.key);
        updatedEntry.key = parsedKeys;
        if ('keys' in base) {
            updatedEntry.keys = parsedKeys;
        }
    }

    if ('keysecondary' in patch) {
        const parsedSec = parseEntryKeywordsInput(patch.keysecondary);
        updatedEntry.keysecondary = parsedSec;
        if ('secondary_keys' in base) {
            updatedEntry.secondary_keys = parsedSec;
        }
    }

    if ('mode' in patch) {
        const rawMode = String(patch.mode ?? '').trim();
        if (rawMode === ENTRY_ACTIVATION_MODES.CONSTANT) {
            updatedEntry.constant = true;
            updatedEntry.vectorized = false;
        } else if (rawMode === ENTRY_ACTIVATION_MODES.VECTORIZED) {
            updatedEntry.constant = false;
            updatedEntry.vectorized = true;
        } else {
            updatedEntry.constant = false;
            updatedEntry.vectorized = false;
            const secArr = Array.isArray(updatedEntry.keysecondary) ? updatedEntry.keysecondary : [];
            if (updatedEntry.selective === undefined || (secArr.length > 0 && updatedEntry.selective === false)) {
                updatedEntry.selective = true;
            }
        }
        if (base.extensions && typeof base.extensions === 'object' && 'vectorized' in base.extensions) {
            updatedEntry.extensions = {
                ...(updatedEntry.extensions && typeof updatedEntry.extensions === 'object' ? updatedEntry.extensions : base.extensions),
                vectorized: Boolean(updatedEntry.vectorized),
            };
        }
    }

    if ('position' in patch) {
        const pos = normalizePositionValue(patch.position);
        updatedEntry.position = pos;
        if (pos === WORLD_INFO_POSITION.AT_DEPTH && updatedEntry.role == null) {
            updatedEntry.role = 0;
        }
        if (base.extensions && typeof base.extensions === 'object' && 'position' in base.extensions) {
            updatedEntry.extensions = {
                ...(updatedEntry.extensions && typeof updatedEntry.extensions === 'object' ? updatedEntry.extensions : base.extensions),
                position: pos,
            };
        }
    }

    if ('depth' in patch) {
        const d = normalizeDepthValue(patch.depth);
        updatedEntry.depth = d;
        if (base.extensions && typeof base.extensions === 'object' && 'depth' in base.extensions) {
            updatedEntry.extensions = {
                ...(updatedEntry.extensions && typeof updatedEntry.extensions === 'object' ? updatedEntry.extensions : base.extensions),
                depth: d,
            };
        }
    }

    if ('order' in patch) {
        const ord = normalizeOrderValue(patch.order);
        updatedEntry.order = ord;
        if ('insertion_order' in base) {
            updatedEntry.insertion_order = ord;
        }
    }

    if ('content' in patch) {
        updatedEntry.content = String(patch.content ?? '');
    }

    const nextDisabled = 'disable' in updatedEntry
        ? Boolean(updatedEntry.disable)
        : ('enabled' in updatedEntry ? !updatedEntry.enabled : false);

    return {
        updatedEntry,
        disabledChanged: prevDisabled !== nextDisabled,
        prevDisabled,
        nextDisabled,
    };
}

export function applyEntryEditToPayload(payload, uid, editPatch = {}) {
    const found = findRawEntryInPayload(payload, uid);
    if (!found) {
        return { ok: false, error: `未找到条目 #${String(uid ?? '').trim()}` };
    }

    const res = applyEntryEditPatchToRawEntry(found.entry, editPatch);
    payload.entries[found.keyOrIndex] = res.updatedEntry;

    if (Array.isArray(payload?.originalData?.entries)) {
        const targetUid = String(uid ?? '').trim();
        const orig = payload.originalData.entries.find((item) => item && String(item.uid ?? item.id ?? '').trim() === targetUid);
        if (orig && typeof orig === 'object') {
            if ('comment' in editPatch) orig.comment = res.updatedEntry.comment;
            if ('enabled' in editPatch || 'disable' in editPatch) orig.enabled = !res.nextDisabled;
            if ('mode' in editPatch) {
                orig.constant = Boolean(res.updatedEntry.constant);
                if (res.updatedEntry.selective !== undefined) orig.selective = Boolean(res.updatedEntry.selective);
                if (orig.extensions && typeof orig.extensions === 'object') {
                    orig.extensions.vectorized = Boolean(res.updatedEntry.vectorized);
                }
            }
            if ('key' in editPatch) orig.keys = [...(res.updatedEntry.key || [])];
            if ('keysecondary' in editPatch) orig.secondary_keys = [...(res.updatedEntry.keysecondary || [])];
            if ('position' in editPatch) {
                if ('position' in orig) {
                    orig.position = res.updatedEntry.position === WORLD_INFO_POSITION.BEFORE
                        ? 'before_char'
                        : (res.updatedEntry.position === WORLD_INFO_POSITION.AFTER ? 'after_char' : res.updatedEntry.position);
                }
                if (orig.extensions && typeof orig.extensions === 'object') {
                    orig.extensions.position = res.updatedEntry.position;
                    if (res.updatedEntry.role != null && orig.extensions.role == null) {
                        orig.extensions.role = res.updatedEntry.role;
                    }
                }
            }
            if ('depth' in editPatch && orig.extensions && typeof orig.extensions === 'object') {
                orig.extensions.depth = res.updatedEntry.depth;
            }
            if ('order' in editPatch) orig.insertion_order = res.updatedEntry.order;
            if ('content' in editPatch) orig.content = res.updatedEntry.content;
        }
    }

    return {
        ok: true,
        updatedEntry: res.updatedEntry,
        disabledChanged: res.disabledChanged,
        prevDisabled: res.prevDisabled,
        nextDisabled: res.nextDisabled,
    };
}

/**
 * Parse greeting HTML comment tags (`<!-- title / desc / lore / exclude / route -->`).
 */
export function parseGreetingCommentTags(rawText) {
    const text = String(rawText ?? '').slice(0, 1200);
    if (!text) return { title: '', desc: '', loreUids: [], excludeUids: [], routeNumber: null };

    const titleMatch = text.match(TITLE_TAG_REGEX);
    const descMatch = text.match(DESC_TAG_REGEX);
    const loreMatch = text.match(LORE_TAG_REGEX);
    const excludeMatch = text.match(EXCLUDE_TAG_REGEX);
    const routeMatch = text.match(ROUTE_INDEX_TAG_REGEX);

    const parseUidList = (matchObj) => {
        if (!matchObj?.[1]) return [];
        const seen = new Set();
        const out = [];
        for (const token of matchObj[1].split(/[,，]/)) {
            const n = Number.parseInt(token.trim(), 10);
            if (!Number.isNaN(n) && n >= 0) {
                const s = String(n);
                if (!seen.has(s)) {
                    seen.add(s);
                    out.push(s);
                }
            }
        }
        return out;
    };

    const routeNum = routeMatch?.[1] ? Number.parseInt(routeMatch[1], 10) : null;

    return {
        title: titleMatch?.[1]?.trim() || '',
        desc: descMatch?.[1]?.trim() || '',
        loreUids: parseUidList(loreMatch),
        excludeUids: parseUidList(excludeMatch),
        routeNumber: Number.isInteger(routeNum) ? routeNum : null,
    };
}

export function buildGreetingCoordinationIndex(source = {}) {
    const cardGreetingsRaw = [];
    const first = String(source.firstMes ?? '');
    const alts = Array.isArray(source.alternateGreetings)
        ? source.alternateGreetings.map((s) => String(s ?? ''))
        : [];
    if (first || alts.length > 0) {
        cardGreetingsRaw.push(first, ...alts);
    }

    const swipeRaw = Array.isArray(source.swipes) && source.swipes.length > 0
        ? source.swipes.map((s) => String(s ?? ''))
        : [];

    const baseList = cardGreetingsRaw.length >= swipeRaw.length && cardGreetingsRaw.length > 0
        ? cardGreetingsRaw
        : swipeRaw;

    const greetings = [];
    const byUid = new Map();
    const managedUidSet = new Set();

    baseList.forEach((raw, swipeIndex) => {
        const parsedCard = parseGreetingCommentTags(raw);
        const parsedSwipe = swipeRaw[swipeIndex] ? parseGreetingCommentTags(swipeRaw[swipeIndex]) : null;
        const parsed = (parsedSwipe && (parsedSwipe.loreUids.length > 0 || parsedSwipe.excludeUids.length > 0 || parsedSwipe.title))
            ? parsedSwipe
            : parsedCard;

        const label = `#${swipeIndex}`;
        const info = {
            swipeIndex,
            label,
            title: parsed.title || parsedCard.title,
            desc: parsed.desc || parsedCard.desc,
            loreUids: parsed.loreUids,
            excludeUids: parsed.excludeUids,
            routeNumber: parsed.routeNumber ?? parsedCard.routeNumber ?? null,
        };
        greetings.push(info);

        for (const uid of info.loreUids) {
            managedUidSet.add(uid);
            if (!byUid.has(uid)) byUid.set(uid, { includeGreetings: [], excludeGreetings: [] });
            byUid.get(uid).includeGreetings.push({ swipeIndex, label, title: info.title });
        }
        for (const uid of info.excludeUids) {
            if (!byUid.has(uid)) byUid.set(uid, { includeGreetings: [], excludeGreetings: [] });
            byUid.get(uid).excludeGreetings.push({ swipeIndex, label, title: info.title });
        }
    });

    const presetGreetings = greetings.filter((g) => g.loreUids.length > 0 || g.excludeUids.length > 0);
    const currentSwipeId = Number.isInteger(source.currentSwipeId) && source.currentSwipeId >= 0
        ? source.currentSwipeId
        : null;
    const activeGreeting = currentSwipeId !== null && greetings[currentSwipeId]
        ? greetings[currentSwipeId]
        : null;

    return {
        hasManagedEntries: managedUidSet.size > 0 || byUid.size > 0,
        greetings,
        presetGreetings,
        byUid,
        managedUidSet,
        currentSwipeId,
        activeGreeting,
    };
}

/**
 * Extract a friendly route label from chat-scoped variables if any author script
 * stored one (e.g. `chatMetadata.variables.zyz_route = { name: '伪骨科' }` or `route_name`),
 * without coupling to any specific character name!
 *
 * @param {any} chatMetadata
 * @returns {string}
 */
export function extractExternalScriptRouteLabel(chatMetadata) {
    const vars = chatMetadata?.variables;
    if (!vars || typeof vars !== 'object') return '';

    for (const [key, val] of Object.entries(vars)) {
        if (!/route|line|branch|stage|路线|线路|分支/i.test(key)) continue;
        if (typeof val === 'string' && val.trim() && val.trim().length <= 32) {
            return val.trim();
        }
        if (val && typeof val === 'object') {
            const candidate = val.name || val.title || val.route || val.label;
            if (typeof candidate === 'string' && candidate.trim() && candidate.trim().length <= 32) {
                return candidate.trim();
            }
        }
    }
    return '';
}

export function buildInitialProfileFromFloorZero({
    worldName,
    floorZeroMes,
    greetingIndex = null,
    bookConfig = null,
}) {
    const cleanWorld = String(worldName ?? '').trim();
    if (!cleanWorld || !floorZeroMes) return null;

    const parsed = parseGreetingCommentTags(floorZeroMes);
    if (parsed.loreUids.length === 0 && parsed.excludeUids.length === 0) return null;

    const normBook = normalizeBookConfig(bookConfig);
    const ifGroups = normBook.groups.filter((g) => g.mode === GROUP_MODES.IF_LINE);
    const allManagedUids = greetingIndex?.managedUidSet || new Set();

    const activeSet = new Set(parsed.loreUids);
    const excludeSet = new Set(parsed.excludeUids);
    const entryDisabledMap = {};

    for (const uid of allManagedUids) {
        entryDisabledMap[uid] = !(activeSet.has(uid) && !excludeSet.has(uid));
    }
    for (const uid of activeSet) {
        entryDisabledMap[uid] = excludeSet.has(uid);
    }
    for (const uid of excludeSet) {
        entryDisabledMap[uid] = true;
    }

    let matchedIfGroup = null;
    let bestOverlap = 0;
    for (const grp of ifGroups) {
        const grpUids = Object.entries(normBook.assignments)
            .filter(([, gid]) => gid === grp.id)
            .map(([u]) => u);
        const overlap = grpUids.filter((u) => activeSet.has(u)).length;
        if (overlap > bestOverlap) {
            bestOverlap = overlap;
            matchedIfGroup = grp;
        }
    }

    const routeLabel = parsed.title || matchedIfGroup?.name || '开场白初始路线';
    return normalizeChatProfile({
        worldName: cleanWorld,
        routeLabel,
        ifGroupId: parsed.title ? '' : (matchedIfGroup?.id || ''),
        entryDisabledMap,
        updatedAt: Date.now(),
    });
}

/**
 * Snapshot the current worldbook's entry states into a per-chat save profile.
 * Records ALL non-scene, non-pure-banner entries so multi-layer presets (e.g. 背景 + 变量 + 支线)
 * switched by external scripts or multi-group combinations are 100% preserved per save!
 */
export function buildChatProfileFromCurrentState(worldName, entries, rawBookConfig, opts = {}) {
    const cleanWorld = String(worldName ?? '').trim();
    const list = Array.isArray(entries) ? entries : [];
    if (!cleanWorld || list.length === 0) return null;

    const bookConfig = normalizeBookConfig(rawBookConfig);
    const sceneGroupIds = new Set(
        bookConfig.groups.filter((g) => g.mode === GROUP_MODES.SCENE).map((g) => g.id),
    );

    let activeIfGroup = null;
    if (opts.preferredIfGroupId) {
        activeIfGroup = bookConfig.groups.find(
            (g) => g.id === opts.preferredIfGroupId && g.mode === GROUP_MODES.IF_LINE,
        ) || null;
    }
    if (!activeIfGroup) {
        const enabledIfGroups = bookConfig.groups.filter((g) => {
            if (g.mode !== GROUP_MODES.IF_LINE) return false;
            return list.some((e) => bookConfig.assignments[e.uid] === g.id && !e.disabled);
        });
        if (enabledIfGroups.length === 1) {
            activeIfGroup = enabledIfGroups[0];
        }
    }

    const entryDisabledMap = {};
    for (const entry of list) {
        if (entry.isPureBanner) continue;
        const gid = bookConfig.assignments[entry.uid];
        // Never lock transient `scene` (NSFW) group states into the save's permanent route profile
        if (gid && sceneGroupIds.has(gid)) continue;
        entryDisabledMap[entry.uid] = Boolean(entry.disabled);
    }

    const enabledCount = list.filter((e) => !e.disabled && !e.isPureBanner).length;
    const routeLabel = String(opts.customLabel ?? '').trim()
        || activeIfGroup?.name
        || String(opts.externalRouteHint ?? '').trim()
        || `本档配置（已开 ${enabledCount} 条）`;

    return normalizeChatProfile({
        worldName: cleanWorld,
        routeLabel,
        ifGroupId: activeIfGroup?.id || '',
        entryDisabledMap,
        updatedAt: Date.now(),
    });
}

export function computeChatProfileRestorePlan(entries, rawBookConfig, rawChatProfile) {
    const profile = normalizeChatProfile(rawChatProfile);
    const list = Array.isArray(entries) ? entries : [];
    const plan = new Map();
    if (!profile || list.length === 0) return plan;

    const bookConfig = normalizeBookConfig(rawBookConfig);
    const sceneGroupIds = new Set(
        bookConfig.groups.filter((g) => g.mode === GROUP_MODES.SCENE).map((g) => g.id),
    );
    const validUidSet = new Set(list.map((e) => e.uid));

    if (profile.ifGroupId && bookConfig.groups.some((g) => g.id === profile.ifGroupId)) {
        const groupPlan = computeGroupTogglePlan(list, bookConfig, profile.ifGroupId, true);
        for (const [uid, nextDisabled] of groupPlan.entries()) {
            plan.set(uid, nextDisabled);
        }
    }

    for (const [uid, nextDisabled] of Object.entries(profile.entryDisabledMap)) {
        if (!validUidSet.has(uid)) continue;
        const gid = bookConfig.assignments[uid];
        if (gid && sceneGroupIds.has(gid)) continue;
        plan.set(uid, Boolean(nextDisabled));
    }

    const currentByUid = new Map(list.map((e) => [e.uid, Boolean(e.disabled)]));
    for (const [uid, nextDisabled] of [...plan.entries()]) {
        if (currentByUid.get(uid) === nextDisabled) {
            plan.delete(uid);
        }
    }

    return plan;
}

export function formatGreetingCommentTag(uids, tagType = 'lore') {
    const nums = [...new Set(
        (uids || [])
            .map((u) => Number.parseInt(String(u).trim(), 10))
            .filter((n) => Number.isInteger(n) && n >= 0),
    )].sort((a, b) => a - b);
    if (nums.length === 0) return '';
    const tag = tagType === 'exclude' ? 'exclude' : 'lore';
    return `<!-- ${tag}: ${nums.join(',')} -->`;
}

/**
 * Determine whether a group name represents a mutually-exclusive IF route,
 * explicitly EXCLUDING common/shared lore groups like `通用线`, `常规线`, `公共设定`!
 */
export function looksLikeIfLineName(groupName) {
    const clean = String(groupName ?? '').trim();
    if (!clean) return false;
    if (COMMON_BASE_NAME_REGEX.test(clean)) return false;
    return IF_NAME_HINT_REGEX.test(clean);
}

export function looksLikeRadioChoiceSection(groupName, memberComments = []) {
    const clean = String(groupName ?? '').trim();
    if (clean && RADIO_SECTION_HINT_REGEX.test(clean)) return true;
    if (memberComments.length >= 2) {
        const choiceHintCount = memberComments.filter((c) => /(?:二选一|多选一|三选一|四选一)/.test(String(c ?? ''))).length;
        if (choiceHintCount >= 2) return true;
    }
    return false;
}

export function looksLikeNsfwEntry(titleOrKeys) {
    const clean = String(titleOrKeys ?? '').trim();
    if (!clean) return false;
    return NSFW_TITLE_HINT_REGEX.test(clean);
}

/**
 * Infer the most natural group mode from a group's name and its member entry titles.
 */
function inferSuggestedGroupMode(label, memberEntries = []) {
    const clean = String(label ?? '').trim();
    if (looksLikeNsfwEntry(clean) && !/人设|优化/.test(clean)) {
        return GROUP_MODES.SCENE;
    }
    if (looksLikeRadioChoiceSection(clean, memberEntries.map((e) => e.rawComment || e.title))) {
        return GROUP_MODES.RADIO;
    }
    if (looksLikeIfLineName(clean)) {
        return GROUP_MODES.IF_LINE;
    }
    return GROUP_MODES.NORMAL;
}

export function extractEntryTitlePrefix(rawTitle) {
    let text = String(rawTitle ?? '').trim();
    if (!text) return null;

    const strippedIndex = text.replace(/^\d{1,3}[.、)\s]+\s*/, '');
    if (strippedIndex.length >= 3) {
        text = strippedIndex;
    }

    const bracketMatch = text.match(/^(?:【([^】]{1,18})】|\[([^\]]{1,18})\]|「([^」]{1,18})」|（([^）]{1,18})）|\(([^)]{1,18})\))\s*(.+)$/);
    if (bracketMatch) {
        let candidate = (bracketMatch[1] || bracketMatch[2] || bracketMatch[3] || bracketMatch[4] || bracketMatch[5] || '').trim();
        // Strip leading card-suit or symbol icons like `♠️权谋` -> `权谋`, `🔴` -> skip if empty
        candidate = candidate.replace(/^[\p{Extended_Pictographic}♠♥♣♦♤♡♧♢\ufe0f\s]+/gu, '').trim();
        if (candidate && !/^\d+$/.test(candidate)) {
            // Note: `【常规·助理线】` / `【常规·小演员线】` have distinct sub-route names inside brackets;
            // normalize `常规·XX线` only if standalone, or group `【常规·...】` under `常规分支` when each bracket is unique!
            return candidate;
        }
    }

    const delimMatch = text.match(/^([^:：\-—_｜|/·]{2,16}?)\s*(?:[:：｜|/]|[-—_]{1,2}|·)\s*(.+)$/);
    if (delimMatch) {
        const candidate = delimMatch[1].trim();
        const rest = delimMatch[2].trim();
        if (candidate && rest && !/^\d+$/.test(candidate)) {
            return candidate;
        }
    }

    return null;
}

/**
 * Detect candidate entry groups automatically across real-world worldbook authoring styles:
 * 1. Bounded paired dividers (`——⬇️⬇️USER身份自选⬇️⬇️——` ... `——⬆️⬆️USER身份自选⬆️⬆️——`)
 *    and single section dividers (`——🐰🐰背景信息选择🦊🦊——`, `=== 基础设定 ===`),
 *    skipping pure empty banner entries from toggle membership!
 * 2. Bracket / delimiter prefixes (`【通用线】`, `【将军线】`, `[18岁线]`) on remaining entries,
 *    never mislabeling `通用线` / `常规线` as mutually-exclusive IF lines!
 * 3. NSFW / intimate entries (`NSFW`, `nfsw`, `R18`, `床笫`, `敏感带`).
 * 4. Optional non-overlapping greeting `<!-- lore -->` branches (when greetings have disjoint UIDs).
 */
export function detectAutoGroups(entries, {
    strategy = 'smart',
    onlyUngrouped = true,
    existingAssignments = {},
    greetingIndex = null,
} = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const assignedObj = existingAssignments && typeof existingAssignments === 'object' ? existingAssignments : {};
    const validEntryMap = new Map(list.map((e) => [e.uid, e]));

    const isEligible = (uid) => !onlyUngrouped || !assignedObj[uid];

    // 1. Divider block detection (supports both `⬇️...⬆️` bounded blocks and `section` headers!)
    const detectFromDividers = (claimedSet, { boundedOnly = false } = {}) => {
        const rawBlocks = [];
        let currentBlock = null;

        for (const entry of list) {
            if (entry.isDivider) {
                if (entry.dividerKind === 'end') {
                    currentBlock = null;
                    continue;
                }
                if (boundedOnly && entry.dividerKind !== 'start') {
                    continue;
                }
                if (entry.dividerLabel) {
                    currentBlock = {
                        label: entry.dividerLabel,
                        kind: entry.dividerKind,
                        entries: [],
                    };
                    // Include divider entry ONLY if it carries actual prompt content or trigger keys!
                    if (!entry.isPureBanner && isEligible(entry.uid) && !claimedSet.has(entry.uid)) {
                        currentBlock.entries.push(entry);
                    }
                    rawBlocks.push(currentBlock);
                }
                continue;
            }

            if (currentBlock && isEligible(entry.uid) && !claimedSet.has(entry.uid)) {
                currentBlock.entries.push(entry);
            }
        }

        const meaningful = rawBlocks.filter((b) => b.entries.length >= 1);
        if (!boundedOnly && meaningful.length < 2) return [];
        if (boundedOnly && meaningful.length < 1) return [];

        const mergedByLabel = new Map();
        for (const b of meaningful) {
            if (!mergedByLabel.has(b.label)) mergedByLabel.set(b.label, []);
            mergedByLabel.get(b.label).push(...b.entries);
        }

        const out = [];
        let idx = 0;
        for (const [label, memberEntries] of mergedByLabel.entries()) {
            if (memberEntries.length === 0) continue;
            // In smart mode, if a bounded block's entries ALREADY share a cleaner `【前缀】` (like `⬇️⬇️神女线⬇️⬇️` containing `【神女线】...`),
            // let prefix clustering handle prefixed ones UNLESS the entries lack prefixes (like `USER身份自选` -> `高门贵女user` / `公主user`)!
            if (boundedOnly) {
                const unprefixed = memberEntries.filter((e) => !extractEntryTitlePrefix(e.rawComment || e.title));
                if (unprefixed.length === 0) continue;
            }

            const uids = memberEntries.map((e) => e.uid);
            for (const uid of uids) claimedSet.add(uid);
            out.push({
                key: `divider_${idx++}_${label}`,
                name: label,
                suggestedMode: inferSuggestedGroupMode(label, memberEntries),
                uids,
                source: 'divider',
            });
        }
        return out;
    };

    // 2. Prefix clustering (`【通用线】`, `【将军线】`, `[18岁线]`, `【常规·...】`)
    const detectFromPrefixes = (claimedSet) => {
        const buckets = new Map();
        for (const entry of list) {
            if (entry.isDivider && entry.isPureBanner) continue;
            if (!isEligible(entry.uid) || claimedSet.has(entry.uid)) continue;
            const prefix = extractEntryTitlePrefix(entry.rawComment || entry.title);
            if (!prefix) continue;
            if (!buckets.has(prefix)) buckets.set(prefix, []);
            buckets.get(prefix).push(entry);
        }

        const out = [];
        let idx = 0;
        for (const [prefix, memberEntries] of buckets.entries()) {
            const isSpecial = looksLikeIfLineName(prefix) || looksLikeNsfwEntry(prefix);
            if (memberEntries.length < 2 && !isSpecial) continue;
            const uids = memberEntries.map((e) => e.uid);
            for (const uid of uids) claimedSet.add(uid);
            out.push({
                key: `prefix_${idx++}_${prefix}`,
                name: prefix,
                suggestedMode: inferSuggestedGroupMode(prefix, memberEntries),
                uids,
                source: 'prefix',
            });
        }
        return out;
    };

    // 3. NSFW / Intimate scene entries
    const detectNsfwSceneGroup = (claimedSet) => {
        const nsfwUids = [];
        for (const entry of list) {
            if (entry.isDivider && entry.isPureBanner) continue;
            if (!isEligible(entry.uid) || claimedSet.has(entry.uid)) continue;
            const probe = `${entry.rawComment || entry.title} ${(entry.keys || []).join(' ')}`;
            if (looksLikeNsfwEntry(probe)) {
                nsfwUids.push(entry.uid);
            }
        }
        if (nsfwUids.length === 0) return [];
        for (const uid of nsfwUids) claimedSet.add(uid);
        return [{
            key: 'scene_nsfw',
            name: '亲密剧情 (NSFW)',
            suggestedMode: GROUP_MODES.SCENE,
            uids: nsfwUids,
            source: 'scene',
        }];
    };

    // 4. Greeting `<!-- lore -->` tags (extracts ONLY unique per-greeting UIDs when greetings share common base UIDs!)
    const detectFromGreetings = (claimedSet) => {
        const greets = (greetingIndex?.greetings || []).filter((g) => Array.isArray(g.loreUids) && g.loreUids.length > 0);
        if (greets.length === 0) return [];

        // Count how many greetings reference each UID: UIDs shared across >50% of greetings (and >=2 greetings) are common base lore!
        const freq = new Map();
        for (const g of greets) {
            for (const u of g.loreUids) {
                freq.set(u, (freq.get(u) || 0) + 1);
            }
        }
        const sharedBaseUids = [];
        const threshold = greets.length >= 3 ? Math.ceil(greets.length * 0.5) : 2;
        for (const [u, count] of freq.entries()) {
            if (greets.length >= 2 && count >= threshold && validEntryMap.has(u) && isEligible(u) && !claimedSet.has(u)) {
                sharedBaseUids.push(u);
            }
        }

        const out = [];
        if (sharedBaseUids.length > 0) {
            for (const u of sharedBaseUids) claimedSet.add(u);
            out.push({
                key: 'greeting_common_base',
                name: '公共基础设定',
                suggestedMode: GROUP_MODES.NORMAL,
                uids: sharedBaseUids,
                source: 'greeting',
            });
        }

        for (const g of greets) {
            const uids = g.loreUids.filter((uid) => validEntryMap.has(uid) && isEligible(uid) && !claimedSet.has(uid));
            if (uids.length === 0) continue;
            for (const uid of uids) claimedSet.add(uid);
            const cleanTitle = g.title ? g.title.slice(0, 24) : `开场白 ${g.label}`;
            out.push({
                key: `greeting_${g.swipeIndex}`,
                name: g.title ? `IF · ${cleanTitle}` : `IF · 开场白 ${g.label}`,
                suggestedMode: GROUP_MODES.IF_LINE,
                uids,
                source: 'greeting',
            });
        }
        return out;
    };

    const claimed = new Set();
    if (strategy === 'scene') return detectNsfwSceneGroup(claimed);
    if (strategy === 'greeting') return detectFromGreetings(claimed);
    if (strategy === 'divider') return detectFromDividers(claimed);
    if (strategy === 'prefix') return detectFromPrefixes(claimed);

    // Smart combined strategy:
    // Check whether the author structured the whole book with section dividers (e.g. `——🐰🐰...🦊🦊——` covering >60% of entries)
    const nonBannerCount = list.filter((e) => !e.isPureBanner).length;
    const trialDividerClaimed = new Set();
    const fullSectionDividers = detectFromDividers(trialDividerClaimed, { boundedOnly: false });
    const hasComprehensiveSectionLayers =
        fullSectionDividers.length >= 3 &&
        nonBannerCount > 0 &&
        trialDividerClaimed.size / nonBannerCount >= 0.65 &&
        !list.some((e) => e.dividerKind === 'end');

    const results = [];
    if (hasComprehensiveSectionLayers) {
        // Book is already cleanly layered top-to-bottom by author section banners! Preserve exact author layers!
        return detectFromDividers(claimed, { boundedOnly: false });
    }

    // Otherwise:
    // 1) Extract standalone NSFW entries first -> 2) Bounded `⬇️...⬆️` unprefixed blocks (like `USER身份自选`)
    // -> 3) Prefix clusters (`【通用线】`, `【将军线】`, `【神女线】`) -> 4) Remaining section dividers / greeting branches
    results.push(...detectNsfwSceneGroup(claimed));
    results.push(...detectFromDividers(claimed, { boundedOnly: true }));
    results.push(...detectFromPrefixes(claimed));
    results.push(...detectFromDividers(claimed, { boundedOnly: false }));
    if (results.length === 0 && greetingIndex?.hasManagedEntries) {
        results.push(...detectFromGreetings(claimed));
    }
    return results;
}

export function applyAutoGroupProposals(rawBookConfig, proposals, { replaceExisting = false } = {}) {
    const cloned = cloneBookConfig(rawBookConfig);
    const next = replaceExisting
        ? {
            groups: [],
            assignments: {},
            ungroupedCollapsed: false,
            pinnedGroupIds: [],
            pinnedEntryUids: [...cloned.pinnedEntryUids],
        }
        : cloned;

    for (const item of proposals || []) {
        const name = String(item?.name ?? '').trim();
        const uids = Array.isArray(item?.uids) ? item.uids.map((u) => String(u).trim()).filter(Boolean) : [];
        if (!name || uids.length === 0) continue;

        const desiredMode = item.mode || item.suggestedMode || GROUP_MODES.NORMAL;
        const validMode = (
            desiredMode === GROUP_MODES.IF_LINE ||
            desiredMode === GROUP_MODES.RADIO ||
            desiredMode === GROUP_MODES.SCENE
        )
            ? desiredMode
            : GROUP_MODES.NORMAL;

        let group = next.groups.find((g) => g.name === name);
        if (!group) {
            group = {
                id: createGroupId('grp'),
                name,
                mode: validMode,
                collapsed: false,
                sceneKeywords: [],
                cooldownTurns: 2,
            };
            next.groups.push(group);
        } else if (group.mode === GROUP_MODES.NORMAL && validMode !== GROUP_MODES.NORMAL) {
            group.mode = validMode;
        }

        for (const uid of uids) {
            next.assignments[uid] = group.id;
        }
    }

    return next;
}

export function migrateSettingsOnWorldRename(settings, oldName, newName) {
    const cleanOld = String(oldName ?? '').trim();
    const cleanNew = String(newName ?? '').trim();
    if (!settings || !cleanOld || !cleanNew || cleanOld === cleanNew) return false;

    let changed = false;
    if (settings.books && typeof settings.books === 'object' && settings.books[cleanOld]) {
        if (!settings.books[cleanNew]) {
            settings.books[cleanNew] = cloneBookConfig(settings.books[cleanOld]);
        } else {
            const merged = cloneBookConfig(settings.books[cleanNew]);
            const oldCfg = normalizeBookConfig(settings.books[cleanOld]);
            const idRemap = new Map();
            for (const g of oldCfg.groups) {
                let target = merged.groups.find((x) => x.name === g.name);
                if (!target) {
                    target = { ...g, id: merged.groups.some((x) => x.id === g.id) ? createGroupId('grp') : g.id };
                    merged.groups.push(target);
                }
                idRemap.set(g.id, target.id);
                for (const [uid, gid] of Object.entries(oldCfg.assignments)) {
                    if (gid === g.id && !merged.assignments[uid]) {
                        merged.assignments[uid] = target.id;
                    }
                }
            }
            const mergedPinnedGroups = new Set(merged.pinnedGroupIds);
            const validNewGroupIds = new Set(merged.groups.map((x) => x.id));
            for (const oldGid of oldCfg.pinnedGroupIds) {
                const mappedId = idRemap.get(oldGid) || oldGid;
                if (validNewGroupIds.has(mappedId)) {
                    mergedPinnedGroups.add(mappedId);
                }
            }
            merged.pinnedGroupIds = [...mergedPinnedGroups];
            merged.pinnedEntryUids = [...new Set([...merged.pinnedEntryUids, ...oldCfg.pinnedEntryUids])];
            settings.books[cleanNew] = merged;
        }
        delete settings.books[cleanOld];
        changed = true;
    }

    if (settings.chatProfiles && typeof settings.chatProfiles === 'object') {
        for (const prof of Object.values(settings.chatProfiles)) {
            if (prof && prof.worldName === cleanOld) {
                prof.worldName = cleanNew;
                changed = true;
            }
        }
    }

    if (settings.lastOpenedBook === cleanOld) {
        settings.lastOpenedBook = cleanNew;
        changed = true;
    }

    return changed;
}

export function removeDeletedWorldsFromSettings(settings, deletedNames) {
    if (!settings || !Array.isArray(deletedNames) || deletedNames.length === 0) return false;
    const delSet = new Set(deletedNames.map((n) => String(n ?? '').trim()).filter(Boolean));
    if (delSet.size === 0) return false;

    let changed = false;
    for (const clean of delSet) {
        if (settings.books && typeof settings.books === 'object' && clean in settings.books) {
            delete settings.books[clean];
            changed = true;
        }
        if (settings.lastOpenedBook === clean) {
            settings.lastOpenedBook = '';
            changed = true;
        }
    }

    if (settings.chatProfiles && typeof settings.chatProfiles === 'object') {
        for (const [chatKey, prof] of Object.entries(settings.chatProfiles)) {
            if (prof && delSet.has(prof.worldName)) {
                delete settings.chatProfiles[chatKey];
                changed = true;
            }
        }
    }

    return changed;
}
