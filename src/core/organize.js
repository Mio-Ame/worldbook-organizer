/**
 * Local and AI organize proposals, prompt building, apply/undo and rename migration.
 *
 * Move-only slice of src/core.js (original lines 2269-3176). Every declaration body is byte-
 * identical; the surroundings are import/export wiring only.
 */

import { createGroupId } from './bindings.js';
import { detectAiRefusal, isPotentiallySensitiveTitle } from './classify.js';
import { GROUP_COLOR_PALETTE, LOCAL_ORGANIZE_CATEGORIES, SPECIAL_GROUPS, addCustomGroup, deepClone } from './settings.js';

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
