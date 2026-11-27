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
    PINNED: '__pinned__',
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

const _zhCollator = typeof Intl !== 'undefined' && typeof Intl.Collator === 'function'
    ? new Intl.Collator('zh-CN')
    : null;

/**
 * Fast cached zh-CN string comparator (10x–30x faster than per-call `localeCompare` on iOS WebKit).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareZhCn(a, b) {
    const sa = String(a ?? '');
    const sb = String(b ?? '');
    if (sa === sb) return 0;
    return _zhCollator ? _zhCollator.compare(sa, sb) : sa.localeCompare(sb, 'zh-CN');
}

export const LOCAL_ORGANIZE_CATEGORIES = Object.freeze([
    {
        id: 'user_persona',
        group: 'User 人设',
        defaultEnabled: true,
        prefixRegex: /^(?:人设|user|用户|主角|自设|我方|user人设)$/i,
        test: (s) => /(?:人设|user|自设|主角设定|我方设定|穿搭|外貌|性格设定|软萌)/i.test(s),
    },
    {
        id: 'style',
        group: '文风',
        defaultEnabled: true,
        prefixRegex: /^(?:文风|写法|风格|润色|文笔|叙事)$/i,
        test: (s) => /(?:文风|去八股|去ai味|叙事|文笔|描写|对话风格|散文|古风写作|网文风|小说风|节奏控制|遣词|写作风格|笔触)/i.test(s),
    },
    {
        id: 'nsfw',
        group: 'NSFW',
        defaultEnabled: true,
        prefixRegex: /^(?:nsfw|18\+|r-?18g?|成人|敏感|肉|车)$/i,
        test: (s) => isPotentiallySensitiveTitle(s),
    },
    {
        id: 'stitch',
        group: '缝合',
        defaultEnabled: false,
        prefixRegex: /^(?:缝|缝合|规则|预设|指令|系统|功能|补丁|防抢话)$/i,
        test: (s) => /(?:缝合|防抢话|不抢话|输出格式|记忆增强|防复读|防重复|规则指令|系统指令|提示词|模板|补丁|预设插件)/i.test(s),
    },
    {
        id: 'worldview',
        group: '世界观',
        defaultEnabled: false,
        prefixRegex: /^(?:世界观|背景|设定|世界)$/i,
        test: (s) => /(?:世界观|设定集|历史|地理|势力|魔法体系|时代背景|朝代|社会结构|物价|货币|年表|同人库|赛博|修仙|末世|古代|现代都市|校园|电竞|奇幻|克苏鲁|abo)/i.test(s),
    },
    {
        id: 'scene',
        group: '剧情与互动',
        defaultEnabled: false,
        prefixRegex: /^(?:场景|剧情|事件|互动|日常|跑团|副本)$/i,
        test: (s) => /(?:剧情|互动|日常|情景|场景|事件|流程|指南|攻略|跑团|副本|相处|约会|恋爱|剧情推进)/i.test(s),
    },
    {
        id: 'theater',
        group: '小剧场',
        defaultEnabled: false,
        prefixRegex: /^(?:小剧场|剧场|彩蛋|随机|玩法|扩展|番外)$/i,
        test: (s) => /(?:小剧场|随机事件|彩蛋|抽卡|盲盒|论坛体|微博体|朋友圈|短信|直播|弹幕|番外|热搜)/i.test(s),
    },
    {
        id: 'ui_status',
        group: '状态栏与美化',
        defaultEnabled: false,
        prefixRegex: /^(?:状态栏|前端|美化|界面|ui|mvu)$/i,
        test: (s) => /(?:状态栏|前端|美化|界面|css|mvu|变量|面板|卡片|手机界面|聊天框|播放器|html)/i.test(s),
    },
    {
        id: 'cot_jb',
        group: '破限与思维链',
        defaultEnabled: false,
        prefixRegex: /^(?:破限|思维链|cot|越狱)$/i,
        test: (s) => /(?:破限|思维链|思考链|推理链|越狱|防拒答|(?<![a-z])cot(?![a-z]))/i.test(s),
    },
    {
        id: 'npc',
        group: 'NPC 与角色群',
        defaultEnabled: false,
        prefixRegex: /^(?:npc|配角|路人|群像|家族|关系)$/i,
        test: (s) => /(?:配角|路人|群像|家族|亲友|关系网|同事|同学|室友|(?<![a-z])npc(?![a-z]))/i.test(s),
    },
    {
        id: 'language',
        group: '方言与词库',
        defaultEnabled: false,
        prefixRegex: /^(?:方言|粤语|词库|语料|台词|口癖)$/i,
        test: (s) => /(?:粤语|方言|东北话|川渝|台词|口癖|词库|语料|成语|俗语|对话库|称呼)/i.test(s),
    },
    {
        id: 'reference',
        group: '补充素材',
        defaultEnabled: false,
        prefixRegex: /^(?:补充|素材|通用|常识|百科|生活)$/i,
        test: (s) => /(?:职业|食谱|美食|常识|百科|补充|生活|医学|法律|职场|品牌|护肤|时尚|礼仪|资料)/i.test(s),
    },
]);

export const DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS = Object.freeze(
    LOCAL_ORGANIZE_CATEGORIES.filter((c) => c.defaultEnabled).map((c) => c.id),
);

export const SECTION_ORDER_VERSION = 3;

export const DEFAULT_SETTINGS = Object.freeze({
    version: 1,
    sectionOrderVersion: SECTION_ORDER_VERSION,
    hasDoneInitialAutoScan: false,
    hideCharBooksByDefault: true,
    showCharBooks: false,
    charBookTitleMode: 'char_with_sub', // 'char_with_sub' | 'char_only' | 'original'
    aliasTitleMode: 'alias_with_sub',   // 'alias_with_sub' | 'alias_only'
    themePalette: 'classic',            // 'classic' | 'ink' | 'warm' | 'sakura' | 'host'
    themeMode: 'auto',                  // 'auto' | 'light' | 'dark'
    outsideDropdownFollowHostTheme: true,
    includeExtraCharBooks: true,
    includeEmbeddedNameMatch: true,
    autoScanNewCharacters: true,
    autoImportMissingCharBook: false,
    importOrganize: { sensitivePromptSeen: false, sensitiveGroupId: '', rules: [] },
    autoHideInCharBindPopup: true,
    adaptCharBindPopup: true,
    adaptPersonaBindPopup: true,
    adaptChatBindPopup: true,
    adaptMoveEntryPopup: true,
    adaptEnhancedPresetGroups: false,
    overrideEnhancedDropdownStyle: false,
    showNativeOptgroups: true,
    pinCurrentChatCharBookInEditor: true,
    showNativeCharToggleBtn: true,
    nativeQuickActionsMode: 'merged', // 'merged' | 'split' | 'off'
    showNativeComboBtn: true,
    showNativeExcludeBtn: true,
    showNativeEntrySearchBtn: true,
    quickHubLastTab: 'presets',       // 'presets' | 'exclude'
    settingsLastTab: 'appearance',    // 'appearance' | 'display' | 'behavior'
    globalHiddenGroupIds: [SPECIAL_GROUPS.CHARACTER],
    editorHiddenGroupIds: [SPECIAL_GROUPS.CHARACTER],
    localOrganizeCategories: ['user_persona', 'style', 'nsfw'],
    localOrganizeScope: 'ungrouped',  // 'ungrouped' | 'nonchar'
    localOrganizeUseAnyPrefix: false,
    localOrganizeCleanTitles: false,
    localOrganizeCustomRules: [],     // Array<{ kw: string, group: string }>
    organizeLastTab: 'local',         // 'local' | 'organize'
    aiOrganizeScope: 'ungrouped',     // 'ungrouped' | 'nonchar'
    aiOrganizePresets: null,          // null (use built-in defaults) | Array<{ id, label, cat, text }>
    aiOrganizePresetIds: [],
    aiOrganizeCustomRule: '',
    aiOrganizeIncludeClues: false,
    aiOrganizeClueCount: 5,
    aiOrganizeSnippetLen: 50,
    entrySearchHistory: [],
    entrySearchScope: '__nonchar__',
    entrySearchInTitle: true,
    entrySearchInContent: true,
    entrySearchIncludeDisabled: true,
    mgrSearchInBookName: true,
    mgrSearchInCharName: true,
    mgrSearchInEntries: false,
    mgrSearchSplitSpaces: false,
    entryEditorMonoFont: false,
    entryEditorTall: false,
    syncEntryOrderOnDrag: false,
    groupPanelExpanded: false,
    charGroupCollapsed: true,
    currentCharGroupCollapsed: false,
    ungroupedCollapsed: false,
    dropdownCollapsed: {},
    activeFilterGroupId: SPECIAL_GROUPS.DEFAULT,
    sectionOrder: [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED],
    apiProvider: 'host', // 'host' | 'custom'
    activeApiChannelId: '',
    apiChannels: [], // Array<{ id, name, baseUrl, apiKey, model }>
    groups: [],
    globalPresets: [], // Array<{ id: string, name: string, books: string[], updatedAt: number }>
    bookOrders: {}, // Record<groupId, string[]> custom intra-group drag-order
    assignments: {},
    aliases: {},
    notes: {},
    charBookOverrides: {},
    cachedCharBindings: {},
    pinnedBooks: [],
    undoSnapshots: [],
    initialSnapshot: null,
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

    merged.importOrganize = normalizeImportOrganize(merged.importOrganize, merged.groups);

    for (const dictKey of ['assignments', 'aliases', 'notes', 'charBookOverrides', 'cachedCharBindings', 'dropdownCollapsed', 'bookOrders']) {
        if (!merged[dictKey] || typeof merged[dictKey] !== 'object' || Array.isArray(merged[dictKey])) {
            merged[dictKey] = {};
        }
    }

    if (!Array.isArray(merged.undoSnapshots)) {
        merged.undoSnapshots = [];
    }
    if (merged.initialSnapshot && typeof merged.initialSnapshot !== 'object') {
        merged.initialSnapshot = null;
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

    const validLocalCatIds = new Set(LOCAL_ORGANIZE_CATEGORIES.map((c) => c.id));
    if (!Array.isArray(merged.localOrganizeCategories)) {
        merged.localOrganizeCategories = [...DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS];
    } else {
        merged.localOrganizeCategories = [...new Set(
            merged.localOrganizeCategories.filter((id) => typeof id === 'string' && validLocalCatIds.has(id)),
        )];
    }

    if (!Array.isArray(merged.entrySearchHistory)) {
        merged.entrySearchHistory = [];
    } else {
        merged.entrySearchHistory = [...new Set(
            merged.entrySearchHistory.map((s) => String(s ?? '').trim()).filter(Boolean),
        )].slice(0, 10);
    }

    if (!Array.isArray(merged.pinnedBooks)) {
        merged.pinnedBooks = [];
    } else {
        merged.pinnedBooks = [...new Set(
            merged.pinnedBooks.map((s) => String(s ?? '').trim()).filter(Boolean),
        )];
    }

    merged.entryEditorMonoFont = Boolean(merged.entryEditorMonoFont);
    merged.entryEditorTall = Boolean(merged.entryEditorTall);
    merged.syncEntryOrderOnDrag = Boolean(merged.syncEntryOrderOnDrag);
    merged.groupPanelExpanded = Boolean(merged.groupPanelExpanded);
    merged.showNativeComboBtn = merged.showNativeComboBtn !== false;
    merged.entrySearchInTitle = merged.entrySearchInTitle !== false;
    merged.entrySearchInContent = merged.entrySearchInContent !== false;
    merged.entrySearchIncludeDisabled = merged.entrySearchIncludeDisabled !== false;
    merged.localOrganizeUseAnyPrefix = Boolean(merged.localOrganizeUseAnyPrefix);
    merged.localOrganizeCleanTitles = Boolean(merged.localOrganizeCleanTitles);
    merged.aiOrganizeIncludeClues = Boolean(merged.aiOrganizeIncludeClues);

    if (
        !Object.hasOwn(source, 'nativeQuickActionsMode') &&
        source.showNativeExcludeBtn === false &&
        source.showNativeEntrySearchBtn === false
    ) {
        merged.nativeQuickActionsMode = 'off';
    } else if (!['merged', 'split', 'off'].includes(merged.nativeQuickActionsMode)) {
        merged.nativeQuickActionsMode = DEFAULT_SETTINGS.nativeQuickActionsMode;
    }

    if (!['presets', 'exclude'].includes(merged.quickHubLastTab)) {
        merged.quickHubLastTab = DEFAULT_SETTINGS.quickHubLastTab;
    }
    if (!['appearance', 'display', 'behavior'].includes(merged.settingsLastTab)) {
        merged.settingsLastTab = DEFAULT_SETTINGS.settingsLastTab;
    }
    if (!['local', 'organize'].includes(merged.organizeLastTab)) {
        merged.organizeLastTab = DEFAULT_SETTINGS.organizeLastTab;
    }
    if (!['ungrouped', 'nonchar'].includes(merged.localOrganizeScope)) {
        merged.localOrganizeScope = DEFAULT_SETTINGS.localOrganizeScope;
    }
    if (!['ungrouped', 'nonchar'].includes(merged.aiOrganizeScope)) {
        merged.aiOrganizeScope = DEFAULT_SETTINGS.aiOrganizeScope;
    }

    const rawEsScope = String(merged.entrySearchScope ?? '').trim();
    merged.entrySearchScope = rawEsScope || '__nonchar__';

    if (!Array.isArray(merged.localOrganizeCustomRules)) {
        merged.localOrganizeCustomRules = [];
    } else {
        merged.localOrganizeCustomRules = merged.localOrganizeCustomRules
            .filter((r) => r && typeof r === 'object')
            .map((r) => ({
                kw: String(r.kw ?? '').trim(),
                group: String(r.group ?? '').trim(),
            }))
            .filter((r) => r.kw && r.group)
            .slice(0, 100);
    }

    const clueCnt = Number(merged.aiOrganizeClueCount);
    merged.aiOrganizeClueCount = Number.isFinite(clueCnt)
        ? Math.max(1, Math.min(15, Math.round(clueCnt)))
        : DEFAULT_SETTINGS.aiOrganizeClueCount;

    const snipLen = Number(merged.aiOrganizeSnippetLen);
    merged.aiOrganizeSnippetLen = [0, 50, 120].includes(snipLen)
        ? snipLen
        : DEFAULT_SETTINGS.aiOrganizeSnippetLen;

    merged.aiOrganizeCustomRule = typeof merged.aiOrganizeCustomRule === 'string'
        ? merged.aiOrganizeCustomRule.slice(0, 2000)
        : '';

    if (!Array.isArray(merged.aiOrganizePresetIds)) {
        merged.aiOrganizePresetIds = [];
    } else {
        merged.aiOrganizePresetIds = [
            ...new Set(merged.aiOrganizePresetIds.map((id) => String(id ?? '').trim()).filter(Boolean)),
        ].slice(0, 24);
    }

    if (Array.isArray(source.aiOrganizePresets)) {
        const validPresetCats = new Set(['group', 'name', 'ver', 'author', 'custom']);
        const seenPresetIds = new Set();
        merged.aiOrganizePresets = source.aiOrganizePresets
            .filter((p) => p && typeof p === 'object')
            .map((p, idx) => {
                let id = String(p.id ?? '').trim() || `aip_${idx + 1}`;
                while (seenPresetIds.has(id)) id = `${id}_${idx + 1}`;
                seenPresetIds.add(id);
                const cat = validPresetCats.has(p.cat) ? p.cat : 'custom';
                return {
                    id,
                    label: String(p.label ?? '').trim(),
                    cat,
                    text: String(p.text ?? '').trim(),
                };
            })
            .filter((p) => p.label && p.text);
    } else {
        merged.aiOrganizePresets = null;
    }

    if (!Array.isArray(merged.globalPresets)) {
        merged.globalPresets = [];
    } else {
        const seenComboIds = new Set();
        merged.globalPresets = merged.globalPresets
            .filter((c) => c && typeof c === 'object')
            .map((c, idx) => {
                let id = String(c.id ?? '').trim() || `cmb_${idx + 1}`;
                while (seenComboIds.has(id)) id = `${id}_${idx + 1}`;
                seenComboIds.add(id);
                const books = Array.isArray(c.books)
                    ? [...new Set(c.books.map((b) => String(b ?? '').trim()).filter(Boolean))]
                    : [];
                const updatedAt = Number.isFinite(Number(c.updatedAt)) ? Number(c.updatedAt) : 0;
                return {
                    id,
                    name: String(c.name ?? '未命名组合').trim() || '未命名组合',
                    books,
                    updatedAt,
                };
            });
    }

    const validGroupIds = new Set(merged.groups.map((g) => g.id));
    const specialSet = new Set(Object.values(SPECIAL_GROUPS));
    if (!specialSet.has(merged.activeFilterGroupId) && !validGroupIds.has(merged.activeFilterGroupId)) {
        merged.activeFilterGroupId = SPECIAL_GROUPS.DEFAULT;
    }

    // Normalize unified sectionOrder containing all custom groups + __char__ + __ungrouped__
    // Default main-panel order places character worldbooks first, ungrouped next, and custom groups after.
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

    const baseOrder = [...cleanedOrder];
    for (const builtin of [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED]) {
        if (!seenOrder.has(builtin)) {
            baseOrder.push(builtin);
        }
    }

    // Migrate legacy v1/v2 default patterns to v3 (`[__char__, __ungrouped__, ...custom]`)
    // BEFORE appending newly missing custom groups, while preserving explicit user custom orders.
    const rawPrevVer = Number(source.sectionOrderVersion);
    const prevOrderVer = Number.isFinite(rawPrevVer) && rawPrevVer > 0 ? rawPrevVer : 1;
    const hasExplicitSourceOrder = Object.hasOwn(source, 'sectionOrder') && Array.isArray(source.sectionOrder);
    const customSet = new Set(merged.groups.map((g) => g.id));
    let finalOrder = [...baseOrder];

    if (hasExplicitSourceOrder && prevOrderVer < SECTION_ORDER_VERSION && finalOrder.length >= 2) {
        const last = finalOrder[finalOrder.length - 1];
        const secondLast = finalOrder[finalOrder.length - 2];
        const headCustomAll = finalOrder.slice(0, -2).every((id) => customSet.has(id));
        const isV2TrailingDefault =
            headCustomAll &&
            secondLast === SPECIAL_GROUPS.UNGROUPED &&
            last === SPECIAL_GROUPS.CHARACTER;
        const isV1TrailingDefault =
            prevOrderVer < 2 &&
            headCustomAll &&
            secondLast === SPECIAL_GROUPS.CHARACTER &&
            last === SPECIAL_GROUPS.UNGROUPED;
        const isV2PromotedCharDefault =
            finalOrder.length >= 3 &&
            finalOrder[0] === SPECIAL_GROUPS.CHARACTER &&
            finalOrder[finalOrder.length - 1] === SPECIAL_GROUPS.UNGROUPED &&
            finalOrder.slice(1, -1).every((id) => customSet.has(id));

        if (isV2TrailingDefault || isV1TrailingDefault || isV2PromotedCharDefault) {
            const customInOrder = finalOrder.filter((id) => customSet.has(id));
            finalOrder = [SPECIAL_GROUPS.CHARACTER, SPECIAL_GROUPS.UNGROUPED, ...customInOrder];
        }
    }

    const finalSeen = new Set(finalOrder);
    const missingCustom = merged.groups.map((g) => g.id).filter((id) => !finalSeen.has(id));
    if (missingCustom.length > 0) {
        finalOrder.push(...missingCustom);
    }

    merged.sectionOrderVersion = SECTION_ORDER_VERSION;
    merged.sectionOrder = finalOrder;

    // Normalize per-selector custom hidden group lists (defaulting smoothly from legacy `hideCharBooksByDefault`)
    const defaultHiddenList = merged.hideCharBooksByDefault ? [SPECIAL_GROUPS.CHARACTER] : [];
    for (const key of ['globalHiddenGroupIds', 'editorHiddenGroupIds']) {
        const rawList = Object.hasOwn(source, key) ? source[key] : defaultHiddenList;
        merged[key] = Array.isArray(rawList)
            ? [...new Set(rawList.filter((id) => typeof id === 'string' && allowedSectionIds.has(id)))]
            : [...defaultHiddenList];
    }

    const cleanedBookOrders = {};
    for (const [gid, arr] of Object.entries(merged.bookOrders || {})) {
        if (!allowedSectionIds.has(gid) || !Array.isArray(arr)) continue;
        const cleanArr = [...new Set(arr.map((n) => String(n ?? '').trim()).filter(Boolean))];
        if (cleanArr.length > 0) {
            cleanedBookOrders[gid] = cleanArr;
        }
    }
    merged.bookOrders = cleanedBookOrders;

    return merged;
}

/**
 * Reorder a section ID up (-1) or down (+1) in `settings.sectionOrder`,
 * keeping `settings.groups` order synchronized for custom groups.
 * When `visibleSectionIds` is supplied, moves 1 step in the visible list
 * (skipping hidden sections such as `__char__` or `__ungrouped__`).
 *
 * @param {Record<string, any>} settings
 * @param {string} sectionId
 * @param {-1 | 1} delta
 * @param {string[] | null} [visibleSectionIds=null]
 * @returns {boolean}
 */
export function moveSectionOrder(settings, sectionId, delta, visibleSectionIds = null) {
    if (!settings || !sectionId || (delta !== -1 && delta !== 1)) return false;
    const normalized = normalizeSettings(settings);
    const order = [...normalized.sectionOrder];

    if (Array.isArray(visibleSectionIds)) {
        const orderSet = new Set(order);
        const visible = [];
        const seenVis = new Set();
        for (const rawId of visibleSectionIds) {
            const id = String(rawId ?? '').trim();
            if (id && orderSet.has(id) && !seenVis.has(id)) {
                seenVis.add(id);
                visible.push(id);
            }
        }
        const visIdx = visible.indexOf(sectionId);
        const targetVisIdx = visIdx + delta;
        if (visIdx < 0 || targetVisIdx < 0 || targetVisIdx >= visible.length) return false;
        const targetId = visible[targetVisIdx];
        const fromIdx = order.indexOf(sectionId);
        if (fromIdx < 0) return false;
        order.splice(fromIdx, 1);
        const newTargetIdx = order.indexOf(targetId);
        if (newTargetIdx < 0) return false;
        const insertIdx = delta > 0 ? newTargetIdx + 1 : newTargetIdx;
        order.splice(insertIdx, 0, sectionId);
    } else {
        const idx = order.indexOf(sectionId);
        const targetIdx = idx + delta;
        if (idx < 0 || targetIdx < 0 || targetIdx >= order.length) return false;
        [order[idx], order[targetIdx]] = [order[targetIdx], order[idx]];
    }

    settings.sectionOrder = order;

    // Keep custom groups array in the same relative order
    const groupById = new Map((settings.groups || []).map((g) => [g.id, g]));
    settings.groups = order.filter((id) => groupById.has(id)).map((id) => groupById.get(id));
    return true;
}

/**
 * Compute visible move-up / move-down boundary flags for an ordered list of
 * currently displayed section IDs so disabled states always match visible rows.
 * @param {string[]} [visibleSectionIds=[]]
 * @returns {Map<string, { index: number, canMoveUp: boolean, canMoveDown: boolean }>}
 */
export function getVisibleSectionMoveBounds(visibleSectionIds = []) {
    const clean = [];
    const seen = new Set();
    for (const raw of visibleSectionIds || []) {
        const id = String(raw ?? '').trim();
        if (id && !seen.has(id)) {
            seen.add(id);
            clean.push(id);
        }
    }
    const bounds = new Map();
    clean.forEach((id, index) => {
        bounds.set(id, {
            index,
            canMoveUp: index > 0,
            canMoveDown: index < clean.length - 1,
        });
    });
    return bounds;
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
 * Reorder a worldbook within a group (`settings.bookOrders[groupId]`),
 * seeding from `currentOrderedNames` when no custom order exists yet.
 *
 * @param {Record<string, any>} settings
 * @param {string} groupId
 * @param {string} draggedBookName
 * @param {string} targetBookName
 * @param {'before' | 'after'} [position='before']
 * @param {string[] | null} [currentOrderedNames=null]
 * @returns {boolean}
 */
export function reorderBookInGroup(
    settings,
    groupId,
    draggedBookName,
    targetBookName,
    position = 'before',
    currentOrderedNames = null,
) {
    const cleanGid = String(groupId ?? '').trim();
    const cleanDragged = String(draggedBookName ?? '').trim();
    const cleanTarget = String(targetBookName ?? '').trim();
    if (!settings || !cleanGid || !cleanDragged || !cleanTarget || cleanDragged === cleanTarget) {
        return false;
    }

    if (!settings.bookOrders || typeof settings.bookOrders !== 'object' || Array.isArray(settings.bookOrders)) {
        settings.bookOrders = {};
    }

    const existing = Array.isArray(settings.bookOrders[cleanGid])
        ? [...new Set(settings.bookOrders[cleanGid].map((n) => String(n ?? '').trim()).filter(Boolean))]
        : [];
    const baseSet = new Set(existing);
    const seed = Array.isArray(currentOrderedNames)
        ? currentOrderedNames.map((n) => String(n ?? '').trim()).filter(Boolean)
        : [];
    const order = [...existing];
    for (const name of seed) {
        if (!baseSet.has(name)) {
            baseSet.add(name);
            order.push(name);
        }
    }
    if (!baseSet.has(cleanDragged)) {
        baseSet.add(cleanDragged);
        order.push(cleanDragged);
    }
    if (!baseSet.has(cleanTarget)) {
        baseSet.add(cleanTarget);
        order.push(cleanTarget);
    }

    const prevSnapshot = [...order];
    const fromIdx = order.indexOf(cleanDragged);
    if (fromIdx < 0) return false;
    order.splice(fromIdx, 1);
    const targetIdx = order.indexOf(cleanTarget);
    if (targetIdx < 0) return false;
    const insertIdx = position === 'after' ? targetIdx + 1 : targetIdx;
    order.splice(insertIdx, 0, cleanDragged);

    const unchanged = order.length === prevSnapshot.length && order.every((n, i) => n === prevSnapshot[i]);
    if (unchanged) return false;

    for (const [otherGid, list] of Object.entries(settings.bookOrders)) {
        if (otherGid === cleanGid || !Array.isArray(list)) continue;
        const filtered = list.filter((n) => String(n ?? '').trim() !== cleanDragged);
        if (filtered.length !== list.length) {
            if (filtered.length > 0) settings.bookOrders[otherGid] = filtered;
            else delete settings.bookOrders[otherGid];
        }
    }

    settings.bookOrders[cleanGid] = order;
    return true;
}

export function normalizeImportOrganize(raw, groups = []) {
    const ids = new Set(groups.map((group) => group.id));
    const seen = new Set();
    const rules = [];
    for (const rule of Array.isArray(raw?.rules) ? raw.rules : []) {
        const keyword = typeof rule?.keyword === 'string' ? rule.keyword.trim().slice(0, 100) : '';
        if (!keyword || !ids.has(rule.groupId)) continue;
        const key = keyword.normalize('NFKC').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        rules.push({ keyword, groupId: rule.groupId });
        if (rules.length >= 100) break;
    }
    return {
        sensitivePromptSeen: raw?.sensitivePromptSeen === true,
        sensitiveGroupId: ids.has(raw?.sensitiveGroupId) ? raw.sensitiveGroupId : '',
        rules,
    };
}

/**
 * Append a new custom group after existing sections in chronological creation order.
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
    nextOrder.push(group.id);
    settings.sectionOrder = nextOrder;
    return group;
}

/**
 * Reorder sections for external SillyTavern dropdowns/popovers so `未分组`
 * (`SPECIAL_GROUPS.UNGROUPED`) is always placed last (after custom groups),
 * without mutating the input array.
 * @param {Array<any>} [orderedSections=[]]
 * @returns {Array<any>}
 */
export function orderSectionsForExternalDropdown(orderedSections = []) {
    if (!Array.isArray(orderedSections) || orderedSections.length === 0) return [];
    const rest = [];
    const ungrouped = [];
    for (const sec of orderedSections) {
        if (!sec) continue;
        const isUngrouped = typeof sec === 'string'
            ? sec === SPECIAL_GROUPS.UNGROUPED
            : (sec.id === SPECIAL_GROUPS.UNGROUPED || sec.kind === 'ungrouped');
        if (isUngrouped) ungrouped.push(sec);
        else rest.push(sec);
    }
    return [...rest, ...ungrouped];
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
export function buildLocalOrganizeProposals({
    books = [],
    usePrefix = true,
    useAnyBracketPrefix = false,
    useKeywords = true,
    cleanTitles = false,
    enabledCategoryIds = null,
    customRulesText = '',
}) {
    // Parse optional user custom rules: one per line, e.g. "穿搭|服装 => User 人设"
    /** @type {Array<{ keywords: string[], group: string }>} */
    const customRules = [];
    for (const rawLine of String(customRulesText ?? '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const m = line.match(/^(.+?)\s*(?:=>|->|→|=|：|:)\s*(.+)$/);
        if (!m) continue;
        const keywords = m[1]
            .split(/[|,，、/\s]+/)
            .map((k) => k.trim().toLowerCase())
            .filter(Boolean);
        const group = m[2].trim();
        if (keywords.length > 0 && group) {
            customRules.push({ keywords, group });
        }
    }

    const enabledSet = enabledCategoryIds == null
        ? null
        : new Set(Array.isArray(enabledCategoryIds) ? enabledCategoryIds : enabledCategoryIds);
    const activeCategories = enabledSet
        ? LOCAL_ORGANIZE_CATEGORIES.filter((c) => enabledSet.has(c.id))
        : LOCAL_ORGANIZE_CATEGORIES;

    // Evaluate NSFW before generic keywords so sensitive titles are not swallowed by broader tags
    const orderedKeywordCategories = [...activeCategories].sort((a, b) => {
        if (a.id === 'nsfw' && b.id !== 'nsfw') return -1;
        if (b.id === 'nsfw' && a.id !== 'nsfw') return 1;
        return 0;
    });

    const cleanDisplayTitle = (raw) => {
        let t = String(raw ?? '').trim();
        t = t.replace(/^[-–—·•\s]+/, '');
        t = t.replace(/\s*\(\d+\)\s*$/, '');
        t = t.replace(/\s*[-_ ]?(?:副本|copy|final|最终版|修正版)\s*$/i, '');
        t = t.replace(/\s*(?:by|BY|作者[：:]?)\s*[\u4e00-\u9fa5A-Za-z0-9_·-]{1,16}\s*$/u, '');
        t = t.replace(/\s+/g, ' ').trim();
        return t || String(raw ?? '').trim();
    };

    return (books || []).map((b) => {
        const realName = String(b?.realName ?? '').trim();
        const lower = realName.toLowerCase();
        let group = '';

        // 1. User custom rules (highest priority)
        for (const rule of customRules) {
            if (rule.keywords.some((kw) => lower.includes(kw))) {
                group = rule.group;
                break;
            }
        }

        // 2. Leading bracket prefix (e.g. [人设] xxx / [文风] xxx / 【NSFW】xxx)
        if (!group && usePrefix) {
            const pm = realName.match(/^[\s\-–—·]*[\[【(（「『]\s*([^\[\]【】()（）「」『』]{1,10})\s*[\]】)）」』]/);
            if (pm && pm[1]) {
                const rawTag = pm[1].trim();
                const matchedCat = activeCategories.find((c) => c.prefixRegex.test(rawTag));
                if (matchedCat) {
                    group = matchedCat.group;
                } else if (useAnyBracketPrefix || enabledSet === null) {
                    group = rawTag;
                }
            }
        }

        // 3. Built-in ST keyword rules (strictly limited to user-selected categories)
        if (!group && useKeywords) {
            for (const cat of orderedKeywordCategories) {
                if (cat.test(realName)) {
                    group = cat.group;
                    break;
                }
            }
        }

        if (!group) {
            group = (b.currentGroup && b.currentGroup !== '未分组' && b.currentGroup !== '非角色世界书')
                ? b.currentGroup
                : '未分组';
        }

        const alias = cleanTitles ? cleanDisplayTitle(realName) : (b.currentAlias || realName);
        // Never pollute book `note` with internal rule-match labels!
        return { realName, alias, group, note: '' };
    });
}

export const AI_ORGANIZE_CATEGORY_PRESETS = Object.freeze([
    {
        id: 'smart_free',
        label: '智能自由分类',
        cat: 'group',
        text: '根据每本世界书的实际内容自然归纳为 4~7 个清晰分组，名称简洁直观，不强行套用固定模板。',
    },
    {
        id: 'by_st_purpose',
        label: '按功能用途',
        cat: 'group',
        text: '优先按在酒馆中的实际功能归类（如文风叙事、规则补丁/缝合、世界观背景、剧情与玩法、状态栏/前端、人设与素材），只建当前实际用得到的分组。',
    },
    {
        id: 'compact_3_5',
        label: '精简 3~5 大类',
        cat: 'group',
        text: '尽量合并同类项，总分组数量控制在 3~5 个高频大类内，减少翻找层级。',
    },
    {
        id: 'reuse_existing',
        label: '优先复用旧分组',
        cat: 'group',
        text: '尽量归入我当前已有的分组中，除非完全无法归类否则少建新分组。',
    },
    {
        id: 'by_genre',
        label: '按题材背景',
        cat: 'group',
        text: '优先按故事题材与世界观背景归纳（如现代都市、古风仙侠、西幻魔法、未来科幻、悬疑规则、通用日常），便于按剧本题材成组取用。',
    },
    {
        id: 'by_mount',
        label: '按挂载方式',
        cat: 'group',
        text: '优先按在酒馆中的挂载方式归纳（如常驻全局、随人设绑定、按剧情关键词触发、通用规则补丁），方便区分常驻书与按需开启书。',
    },
]);

export const AI_ORGANIZE_NAMING_PRESETS = Object.freeze([
    {
        id: 'bracket_square',
        label: '[分类] 名称',
        cat: 'name',
        text: '名称统一按 [分类] 核心主题 格式包裹，去掉多余符号。',
    },
    {
        id: 'bracket_cn',
        label: '【分类】名称',
        cat: 'name',
        text: '名称统一按 【分类】核心主题 格式包裹，去掉多余符号。',
    },
    {
        id: 'dash_sep',
        label: '分类 - 名称',
        cat: 'name',
        text: '名称统一按 分类 - 核心主题 格式书写，分隔清晰易读。',
    },
    {
        id: 'pure_zh',
        label: '极简纯中文',
        cat: 'name',
        text: '名称不加任何括号前缀，只保留简洁直观的纯中文核心主题名。',
    },
    {
        id: 'keep_version',
        label: '保留版本号',
        cat: 'ver',
        text: '清理冗余装饰词但保留如 v2.0 等关键版本号。',
    },
    {
        id: 'keep_author',
        label: '保留作者署名',
        cat: 'author',
        text: '清理冗余装饰词但保留原作者署名标识，方便日后溯源。',
    },
]);

/**
 * Resolve the effective AI Organize presets (user-customized list if saved, otherwise built-in defaults).
 * @param {Record<string, any> | null | undefined} settings
 */
export function getEffectiveAiOrganizePresets(settings) {
    const isCustomized = Array.isArray(settings?.aiOrganizePresets);
    const all = isCustomized
        ? settings.aiOrganizePresets.map((p) => ({ ...p }))
        : [...AI_ORGANIZE_CATEGORY_PRESETS, ...AI_ORGANIZE_NAMING_PRESETS].map((p) => ({ ...p }));
    return {
        isCustomized,
        all,
        categoryPresets: all.filter((p) => p.cat === 'group'),
        namingPresets: all.filter((p) => p.cat !== 'group'),
    };
}

/**
 * Create or update a user-customizable AI Organize preset in `settings.aiOrganizePresets`.
 * @param {Record<string, any>} settings
 * @param {{ id?: string | null, label: string, cat?: string, text: string }} input
 */
export function upsertAiOrganizePreset(settings, { id = null, label, cat = 'group', text } = {}) {
    if (!settings) return { ok: false, error: '配置未就绪' };
    const cleanLabel = String(label ?? '').trim();
    const cleanText = String(text ?? '').trim();
    if (!cleanLabel) return { ok: false, error: '请输入预设名称' };
    if (!cleanText) return { ok: false, error: '请输入预设提示词内容' };

    const validCats = new Set(['group', 'name', 'ver', 'author', 'custom']);
    const cleanCat = validCats.has(cat) ? cat : 'custom';
    const current = getEffectiveAiOrganizePresets(settings).all;
    const targetId = id ? String(id).trim() : '';

    const dup = current.find(
        (p) => p.id !== targetId && p.label.trim().toLowerCase() === cleanLabel.toLowerCase(),
    );
    if (dup) {
        return { ok: false, error: `已存在同名预设「${cleanLabel}」` };
    }

    if (targetId) {
        const idx = current.findIndex((p) => p.id === targetId);
        if (idx >= 0) {
            current[idx] = { ...current[idx], label: cleanLabel, cat: cleanCat, text: cleanText };
            settings.aiOrganizePresets = current;
            return { ok: true, created: false, preset: current[idx] };
        }
    }

    const taken = new Set(current.map((p) => p.id));
    let newId = '';
    do {
        newId = `aip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    } while (taken.has(newId));

    const created = { id: newId, label: cleanLabel, cat: cleanCat, text: cleanText };
    current.push(created);
    settings.aiOrganizePresets = current;
    return { ok: true, created: true, preset: created };
}

/**
 * Delete an AI Organize preset by ID.
 * @param {Record<string, any>} settings
 * @param {string} presetId
 * @returns {boolean}
 */
export function deleteAiOrganizePreset(settings, presetId) {
    const cleanId = String(presetId ?? '').trim();
    if (!settings || !cleanId) return false;
    const current = getEffectiveAiOrganizePresets(settings).all;
    const next = current.filter((p) => p.id !== cleanId);
    if (next.length === current.length) return false;
    settings.aiOrganizePresets = next;
    if (Array.isArray(settings.aiOrganizePresetIds)) {
        settings.aiOrganizePresetIds = settings.aiOrganizePresetIds.filter((id) => id !== cleanId);
    }
    return true;
}

/**
 * Restore AI Organize presets back to the built-in universal defaults.
 * @param {Record<string, any>} settings
 */
export function resetAiOrganizePresets(settings) {
    if (!settings) return;
    settings.aiOrganizePresets = null;
}

/**
 * Build a compact, strict JSON-only prompt for AI worldbook naming & grouping.
 * Uses neutral file-cataloging framing, universal SillyTavern domain terminology,
 * and optional user feedback for partial re-organization of dissatisfied items.
 *
 * @param {object} params
 * @param {Array<{ realName: string, currentAlias?: string, currentGroup?: string, sampleEntries?: string[] }>} params.books
 * @param {string[]} params.existingGroups
 * @param {string} [params.customInstruction='']
 * @param {string} [params.categoryPreset='']
 * @param {string} [params.namingPreset='']
 * @param {Array<{ id: string, label: string, text: string }> | null} [params.presetsPool=null]
 * @param {{
 *   reason?: string,
 *   previousProposals?: Array<{ realName: string, alias?: string, group?: string, note?: string }>,
 *   acceptedGroups?: string[],
 * } | null} [params.feedback=null]
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export function buildAiOrganizePrompt({
    books,
    existingGroups = [],
    customInstruction = '',
    categoryPreset = '',
    namingPreset = '',
    presetsPool = null,
    feedback = null,
}) {
    const systemPrompt = [
        '你是本地文档资料库（SillyTavern 世界书）的文件目录归类助手。',
        '请仅做客观的文件名规范化与目录归类，不要展开或评价任何文件内容。',
        '根据输入的 realName 以及可选的条目摘要（clues），为每本资料建议：',
        '1. alias：更干净、简洁、统一风格的中文显示名（虚拟别名，不会修改原文件名，去掉冗余版本号/装饰符号/广告词，保留核心主题与必要区分）。',
        '2. group：简短清晰的分类分组名（优先服从用户的额外偏好与已有分组习惯，不生搬硬套无关分类，总分组数尽量精简在 3~8 个内）。',
        '3. note：可选，极简用途说明（不超过 20 字）；只写实际用途，禁止写“分组分析来自…”“根据书名归类”“归入某分组”等元分析废话；若标题本身已足够明确可直接留空 ""。',
        '',
        '酒馆世界书常见术语理解参考（仅用于辅助读懂书名与摘要，请按当前书单的实际构成自然建组，勿强套不需要的组名）：',
        '- 文风与叙事：行文笔触、叙事视角、描写质感、去 AI 味、对话风格与节奏规范等。',
        '- 规则补丁 / 缝合：用于配合系统预设生效的指令模块与功能补丁（如防抢话、思维链、输出格式、检定/系统机制等）。',
        '- 世界观与背景：时代历史、地理势力、力量/科技体系、副本背景等设定集。',
        '- 剧情、事件与玩法：特定场景事件、日常或关系推进、跑团/养成机制、随机小剧场等。',
        '- 状态栏与前端：状态面板、变量规则、界面美化组件等。',
        '- 人设与通用素材：User 自设、NPC 群像、职业常识百科、台词词库等参考资料。',
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
    const lookupPool = Array.isArray(presetsPool) && presetsPool.length > 0
        ? presetsPool
        : [...AI_ORGANIZE_CATEGORY_PRESETS, ...AI_ORGANIZE_NAMING_PRESETS];
    const presetParts = [];
    if (categoryPreset) {
        const foundCat = lookupPool.find((p) => p.id === categoryPreset || p.label === categoryPreset);
        if (foundCat) presetParts.push(foundCat.text);
    }
    if (namingPreset) {
        const foundName = lookupPool.find((p) => p.id === namingPreset || p.label === namingPreset);
        if (foundName) presetParts.push(foundName.text);
    }
    const mergedInstruction = [
        ...presetParts.filter((t) => !String(customInstruction || '').includes(t)),
        String(customInstruction || '').trim(),
    ].filter(Boolean).join('\n');
    if (mergedInstruction) {
        lines.push(`用户额外偏好：${mergedInstruction}`);
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
                ? 'AI 触发了内容安全策略并拒绝回复（常见于包含敏感/18+词的世界书或条目摘要）。建议排除敏感书后重试（敏感书可直接手动拖拽分组），或切换内容限制较宽松的模型 / 仅按书名整理。'
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
        const rawNote = String(item.note ?? item.description ?? item.summary ?? '').trim();
        const note = /^(?:(?:分组|归类|分类)(?:分析|依据|说明|原因)(?:来自|源于|基于)?[:：]?|根据.{0,14}(?:归入|归类|分类|判定))/i.test(rawNote)
            ? ''
            : rawNote;
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
 * Capture an undo snapshot (keeping up to 8 history steps + immutable initial state before first organize).
 * @param {Record<string, any>} settings
 * @param {{ count?: number, label?: string }} [meta]
 */
export function pushUndoSnapshot(settings, { count = 0, label = '整理' } = {}) {
    if (!settings) return;
    const makeSnap = (snapLabel, snapCount) => ({
        at: Date.now(),
        count: snapCount,
        label: snapLabel,
        groupCount: Array.isArray(settings.groups) ? settings.groups.length : 0,
        groups: deepClone(settings.groups || []),
        assignments: deepClone(settings.assignments || {}),
        aliases: deepClone(settings.aliases || {}),
        notes: deepClone(settings.notes || {}),
        charBookOverrides: deepClone(settings.charBookOverrides || {}),
        sectionOrder: deepClone(settings.sectionOrder || []),
    });

    if (!settings.initialSnapshot) {
        settings.initialSnapshot = makeSnap('最初状态', 0);
    }
    const snapshot = makeSnap(label, count);
    settings.undoSnapshots = [snapshot, ...(settings.undoSnapshots || [])].slice(0, 8);
}

/**
 * Apply confirmed AI/local organize proposals to settings (non-destructive virtual aliases & groups).
 * Saves an undo snapshot beforehand.
 *
 * @param {Record<string, any>} settings
 * @param {Array<{ realName: string, alias?: string, group?: string, note?: string, applyAlias?: boolean, applyGroup?: boolean, applyNote?: boolean }>} proposals
 * @param {{ label?: string, isCharBoundFn?: ((name: string) => boolean) | null } | ((name: string) => boolean) | null} [optionsOrFn={}]
 * @param {((name: string) => boolean) | null} [maybeFn=null]
 * @returns {{ appliedCount: number, createdGroups: string[] }}
 */
export function applyAiOrganizeProposals(settings, proposals, optionsOrFn = {}, maybeFn = null) {
    if (!Array.isArray(proposals) || proposals.length === 0) {
        return { appliedCount: 0, createdGroups: [] };
    }

    const opts = typeof optionsOrFn === 'function'
        ? { isCharBoundFn: optionsOrFn }
        : (optionsOrFn && typeof optionsOrFn === 'object' ? optionsOrFn : {});
    const label = typeof opts.label === 'string' && opts.label ? opts.label : '整理';
    const isCharBoundFn = typeof opts.isCharBoundFn === 'function'
        ? opts.isCharBoundFn
        : (typeof maybeFn === 'function' ? maybeFn : null);

    pushUndoSnapshot(settings, { count: proposals.length, label });

    if (!Array.isArray(settings.groups)) settings.groups = [];
    if (!settings.assignments || typeof settings.assignments !== 'object') settings.assignments = {};
    if (!settings.aliases || typeof settings.aliases !== 'object') settings.aliases = {};
    if (!settings.notes || typeof settings.notes !== 'object') settings.notes = {};
    if (!settings.charBookOverrides || typeof settings.charBookOverrides !== 'object') settings.charBookOverrides = {};

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
                if (settings.charBookOverrides?.[p.realName] === 'include_in_char') {
                    delete settings.charBookOverrides[p.realName];
                }
                touched = true;
            } else if (cleanGroup === '角色世界书') {
                delete settings.assignments[p.realName];
                const knownCharBound = typeof isCharBoundFn === 'function'
                    ? Boolean(isCharBoundFn(p.realName))
                    : settings.charBookOverrides[p.realName] === 'exclude_from_char';
                if (knownCharBound) {
                    delete settings.charBookOverrides[p.realName];
                } else {
                    settings.charBookOverrides[p.realName] = 'include_in_char';
                }
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
                if (settings.charBookOverrides?.[p.realName] === 'include_in_char') {
                    delete settings.charBookOverrides[p.realName];
                }
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

    if (Array.isArray(settings.pinnedBooks)) {
        settings.pinnedBooks = [...new Set(
            settings.pinnedBooks
                .map((b) => {
                    const clean = String(b ?? '').trim();
                    return clean === cleanOld ? cleanNew : clean;
                })
                .filter(Boolean),
        )];
    }

    if (Array.isArray(settings.globalPresets)) {
        for (const preset of settings.globalPresets) {
            if (!preset || !Array.isArray(preset.books)) continue;
            preset.books = [
                ...new Set(
                    preset.books
                        .map((b) => {
                            const clean = String(b ?? '').trim();
                            return clean === cleanOld ? cleanNew : clean;
                        })
                        .filter(Boolean),
                ),
            ];
        }
    }

    if (settings.bookOrders && typeof settings.bookOrders === 'object') {
        for (const [gid, arr] of Object.entries(settings.bookOrders)) {
            if (!Array.isArray(arr)) continue;
            settings.bookOrders[gid] = [
                ...new Set(
                    arr
                        .map((b) => {
                            const clean = String(b ?? '').trim();
                            return clean === cleanOld ? cleanNew : clean;
                        })
                        .filter(Boolean),
                ),
            ];
        }
    }
}

/**
 * Restore a specific historical snapshot (`0` = latest, `1` = second-latest, ..., or `'initial'` = pre-first-organize state).
 * @param {Record<string, any>} settings
 * @param {number | 'initial'} [target=0]
 * @returns {boolean}
 */
export function restoreOrganizeSnapshot(settings, target = 0) {
    if (!settings) return false;
    let snap = null;
    if (target === 'initial') {
        snap = settings.initialSnapshot || null;
        if (!snap) return false;
        settings.undoSnapshots = [];
    } else {
        const idx = Number(target);
        if (!Array.isArray(settings.undoSnapshots) || !Number.isInteger(idx) || idx < 0 || idx >= settings.undoSnapshots.length) {
            return false;
        }
        snap = settings.undoSnapshots[idx];
        settings.undoSnapshots = settings.undoSnapshots.slice(idx + 1);
    }

    settings.groups = deepClone(snap.groups || []);
    settings.assignments = deepClone(snap.assignments || {});
    settings.aliases = deepClone(snap.aliases || {});
    settings.notes = deepClone(snap.notes || {});
    settings.charBookOverrides = deepClone(snap.charBookOverrides || {});
    if (Array.isArray(snap.sectionOrder) && snap.sectionOrder.length > 0) {
        settings.sectionOrder = deepClone(snap.sectionOrder);
    }
    return true;
}

/**
 * Undo the most recent organize batch (backward-compatible wrapper).
 * @param {Record<string, any>} settings
 * @returns {boolean}
 */
export function undoLastAiOrganize(settings) {
    return restoreOrganizeSnapshot(settings, 0);
}

/**
 * Partition AI Organize candidate books by sensitive-title status and active candidate scope
 * so already-grouped unselected sensitive books never trigger false-alarm warning banners
 * and "Include/Exclude Sensitive" only toggles books in the active scope.
 *
 * @param {object} params
 * @param {Array<any>} params.allBooks
 * @param {'ungrouped' | 'nonchar' | 'all'} [params.scope='ungrouped']
 * @param {Iterable<string>} [params.checkedNames=[]]
 */
export function analyzeSensitiveOrganizeState({
    allBooks = [],
    scope = 'ungrouped',
    checkedNames = [],
}) {
    const checkedSet = new Set(checkedNames || []);
    const normalBooks = [];
    const sensitiveBooks = [];
    const ungroupedSensitive = [];
    const groupedSensitive = [];
    const charSensitive = [];

    for (const b of allBooks || []) {
        if (!b?.realName) continue;
        // Books living in the character group are never sensitive candidates: their titles often
        // carry in-world wording ("肉", "敏感"…) that would otherwise pull them into an NSFW group.
        // Books explicitly excluded from the character group keep the normal treatment.
        const isCharacterBook = Boolean(b.isInCharGroup);
        if (!isCharacterBook && isPotentiallySensitiveTitle(b.realName)) {
            sensitiveBooks.push(b);
            if (b.groupId === SPECIAL_GROUPS.UNGROUPED) {
                ungroupedSensitive.push(b);
            } else {
                groupedSensitive.push(b);
            }
        } else {
            normalBooks.push(b);
        }
    }

    // Active candidate scope for "Include Sensitive":
    // - 'ungrouped': ONLY ungrouped sensitive books (never already-grouped or character books)
    // - 'nonchar': ungrouped sensitive books first; if none ungrouped, non-char grouped sensitive books (never character books)
    // - 'all': all sensitive books
    const scopeSensitive = scope === 'all'
        ? sensitiveBooks
        : scope === 'nonchar'
            ? (ungroupedSensitive.length > 0 ? ungroupedSensitive : [...ungroupedSensitive, ...groupedSensitive])
            : ungroupedSensitive;

    const checkedSensitive = sensitiveBooks.filter((b) => checkedSet.has(b.realName));
    let bannerMode = 'hidden';
    if (checkedSensitive.length > 0) {
        bannerMode = 'danger';
    } else if (ungroupedSensitive.length > 0 && scope !== 'custom_none') {
        bannerMode = 'warn';
    }

    return {
        normalBooks,
        sensitiveBooks,
        ungroupedSensitive,
        groupedSensitive,
        charSensitive,
        scopeSensitive,
        checkedSensitive,
        bannerMode,
    };
}

/**
 * Move a list of worldbooks into a named custom group (creating the group if absent),
 * saving an undo snapshot beforehand.
 *
 * @param {Record<string, any>} settings
 * @param {string[]} bookNames
 * @param {string} [targetGroupName='NSFW']
 * @param {{ label?: string, isCharBoundFn?: (name: string) => boolean }} [opts]
 * @returns {{ movedCount: number, groupId: string, groupName: string, createdGroup: boolean }}
 */
export function moveBooksToNamedGroup(
    settings,
    bookNames = [],
    targetGroupName = 'NSFW',
    { targetGroupId = null, label = '一键归入 NSFW 分组', isCharBoundFn = null } = {},
) {
    if (!settings) {
        return { movedCount: 0, groupId: '', groupName: targetGroupName, createdGroup: false };
    }
    const cleanGroupName = String(targetGroupName || '').trim() || 'NSFW';
    const cleanTargets = [...new Set((bookNames || []).map((n) => String(n ?? '').trim()).filter(Boolean))];
    if (cleanTargets.length === 0) {
        return { movedCount: 0, groupId: '', groupName: cleanGroupName, createdGroup: false };
    }

    if (!Array.isArray(settings.groups)) settings.groups = [];
    if (!settings.assignments || typeof settings.assignments !== 'object') settings.assignments = {};
    if (!settings.charBookOverrides || typeof settings.charBookOverrides !== 'object') settings.charBookOverrides = {};

    const key = cleanGroupName.toLowerCase();
    let targetGroup = (targetGroupId
        ? settings.groups.find((g) => g?.id === targetGroupId)
        : null) || settings.groups.find((g) => String(g?.name ?? '').trim().toLowerCase() === key) || null;
    const toMove = cleanTargets.filter((name) => !targetGroup || settings.assignments[name] !== targetGroup.id);
    if (toMove.length === 0) {
        return {
            movedCount: 0,
            groupId: targetGroup?.id || '',
            groupName: targetGroup?.name || cleanGroupName,
            createdGroup: false,
        };
    }

    pushUndoSnapshot(settings, { count: toMove.length, label });

    let createdGroup = false;
    if (!targetGroup) {
        targetGroup = addCustomGroup(settings, { name: cleanGroupName });
        createdGroup = true;
    }

    for (const name of toMove) {
        settings.assignments[name] = targetGroup.id;
        if (typeof isCharBoundFn === 'function' && isCharBoundFn(name)) {
            settings.charBookOverrides[name] = 'exclude_from_char';
        } else if (settings.charBookOverrides?.[name] === 'include_in_char') {
            delete settings.charBookOverrides[name];
        }
    }

    return {
        movedCount: toMove.length,
        groupId: targetGroup.id,
        groupName: targetGroup.name,
        createdGroup,
    };
}

/**
 * Compare two worldbooks' entries by normalized title/keys so users can inspect
 * why a character has multiple bound books and decide which one to keep or unbind.
 * @param {Array<{ title: string, keys?: string[], content?: string }>} entriesA
 * @param {Array<{ title: string, keys?: string[], content?: string }>} entriesB
 */
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
