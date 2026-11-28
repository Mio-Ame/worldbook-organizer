/**
 * Settings shape, defaults and section/group ordering helpers.
 *
 * Move-only slice of src/core.js (original lines 13-841). Every declaration body is byte-
 * identical; the surroundings are import/export wiring only.
 */

import { createGroupId } from './bindings.js';
import { isPotentiallySensitiveTitle } from './classify.js';

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
    // How to decide whether the compatible dropdown-beautify script is in use:
    // 'auto' = detect it, 'on' = user forces it, 'off' = ignore it.
    enhancedScriptMode: 'auto',
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
    activeGlobalGroupCollapsed: false,
    ungroupedCollapsed: false,
    comboGroupCollapsed: {},
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

    if (!['auto', 'on', 'off'].includes(merged.enhancedScriptMode)) {
        merged.enhancedScriptMode = 'auto';
    }

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
