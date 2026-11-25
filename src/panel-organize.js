/** Local and AI-assisted worldbook organization. */

import {
    _callbacks,
    bindImeSafeEnter,
    closeSubModal,
    createSubModal,
    esc,
    isDesktopAutoFocusAllowed,
    openInlineTextPrompt,
    UNDO_SVG,
} from './panel-window.js';
import {
    callCustomApiForOrganize,
    callHostAiForOrganize,
    discardPendingRenamedEventsForRollback,
    fetchCustomApiModels,
    fetchWorldbookCluesOnDemand,
    flushWorldInfoListRefresh,
    getWorldNames,
    realRenameWorldbook,
    showToast,
} from './host.js';
import {
    analyzeSensitiveOrganizeState,
    applyAiOrganizeProposals,
    buildAiOrganizePrompt,
    buildLocalOrganizeProposals,
    createApiChannelId,
    deepClone,
    DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS,
    deleteAiOrganizePreset,
    findSensitiveTargetGroup,
    getEffectiveAiOrganizePresets,
    isPotentiallySensitiveTitle,
    LOCAL_ORGANIZE_CATEGORIES,
    migrateSettingsOnWorldRename,
    moveBooksToNamedGroup,
    parseAiOrganizeResponse,
    resetAiOrganizePresets,
    restoreOrganizeSnapshot,
    SPECIAL_GROUPS,
    undoLastAiOrganize,
    upsertAiOrganizePreset,
} from './core.js';
import { dismissImportRulesIntro, openImportRulesModal, shouldOfferImportRules } from './panel-import-rules.js';

const sensitiveSendWarning = '有疑似敏感世界书，发送可能会触发AI拒绝回答';

/**
 * AI Smart Worldbook Organizer modal:
 * - Collapsible saved multi-channel API config (cross-device via extensionSettings)
 * - Supports optional real filename normalization when user allows it
 */
function openAiOrganizeModal({ initialTab = null } = {}) {
    if (!_callbacks) return;
    let { settings, classification } = _callbacks.getState();

    const buildBookPool = (cls) => {
        const nonChar = [
            ...cls.ungroupedBooks,
            ...cls.customGroups.flatMap((g) => g.books),
        ];
        return {
            nonCharBooks: nonChar,
            allBooks: [...nonChar, ...cls.characterBooks],
        };
    };
    let { nonCharBooks, allBooks } = buildBookPool(classification);

    if (allBooks.length === 0) {
        showToast('warning', '当前没有可整理的世界书');
        return;
    }

    const initialOrganizeScope = classification.ungroupedBooks.length === 0
        ? 'nonchar'
        : (settings.aiOrganizeScope === 'nonchar' ? 'nonchar' : 'ungrouped');
    const defaultChecked = new Set(
        (initialOrganizeScope === 'ungrouped' ? classification.ungroupedBooks : nonCharBooks).map((b) => b.realName),
    );

    const getUndoHistoryCount = () =>
        (Array.isArray(settings.undoSnapshots) ? settings.undoSnapshots.length : 0) + (settings.initialSnapshot ? 1 : 0);

    const getUndoButtonLabel = () => {
        const snaps = Array.isArray(settings.undoSnapshots) ? settings.undoSnapshots : [];
        const total = getUndoHistoryCount();
        if (total === 0) return '暂无可回退版本';
        if (snaps.length === 0 && settings.initialSnapshot) return '恢复最初状态';
        return total > 1 ? `撤销 / 历史回退 (${total})` : '撤销上次整理';
    };
    const hasUndo = getUndoHistoryCount() > 0;

    const getActiveChannel = () =>
        settings.apiChannels.find((c) => c.id === settings.activeApiChannelId) || settings.apiChannels[0] || null;

    const getApiSummaryText = () => {
        if (settings.apiProvider !== 'custom') return '酒馆当前 API';
        const ch = getActiveChannel();
        if (!ch) return '自定义 API（未配置）';
        return ch.model ? `${ch.name} · ${ch.model}` : ch.name;
    };

    const sensitiveSet = new Set(
        allBooks.filter((b) => isPotentiallySensitiveTitle(b.realName)).map((b) => b.realName),
    );
    // Protect users from wasting API quota on safety refusals: uncheck likely-sensitive books by default
    for (const sName of sensitiveSet) {
        defaultChecked.delete(sName);
    }

    const renderBookPickRow = (b, checkedSet, isSens) => {
        const checked = checkedSet.has(b.realName) ? 'checked' : '';
        const sensTag = isSens ? '<span class="wbo-tag is-warn" title="含疑似敏感词，部分模型可能拒答">敏感</span>' : '';
        const tag = b.isInCharGroup ? '<span class="wbo-tag">角色书</span>' : `<span class="wbo-tag">${esc(b.groupName)}</span>`;
        return `
            <label class="wbo-ai-pick-row" data-ai-group="${esc(b.groupId)}" data-ai-search="${esc(b.searchableText || b.realName.toLowerCase())}">
                <input type="checkbox" class="wbo-ai-book-check" value="${esc(b.realName)}" ${checked}>
                <span class="wbo-ai-pick-name" title="${esc(b.realName)}">${esc(b.primaryTitle)}${b.subtitle ? ` <small>${esc(b.subtitle)}</small>` : ''}</span>
                ${sensTag}
                ${tag}
            </label>
        `;
    };

    const initialSensState = analyzeSensitiveOrganizeState({ allBooks });
    let activeBookTab = initialSensState.normalBooks.length ? 'normal' : 'sensitive';
    const bookGroupByTab = { normal: SPECIAL_GROUPS.UNGROUPED, sensitive: SPECIAL_GROUPS.UNGROUPED };
    const renderAiBookListHtml = (checkedSet, { normalBooks, sensitiveBooks }) => {
        return `
            <div class="wbo-ai-pick-section" data-ai-section="normal"${activeBookTab === 'normal' ? '' : ' hidden'}>
                ${normalBooks.map((b) => renderBookPickRow(b, checkedSet, false)).join('')}
            </div>
            <div class="wbo-ai-pick-section" data-ai-section="sensitive"${activeBookTab === 'sensitive' ? '' : ' hidden'}>
                ${sensitiveBooks.map((b) => renderBookPickRow(b, checkedSet, true)).join('')}
            </div>
            <div class="wbo-empty-hint" id="wbo-ai-pick-empty" hidden>无匹配世界书</div>
        `;
    };

    const bookChecksHtml = renderAiBookListHtml(defaultChecked, initialSensState);

    const activeCh = getActiveChannel();
    const startTab = initialTab || (settings.organizeLastTab === 'organize' ? 'organize' : 'local');
    const initialLocalScope = classification.ungroupedBooks.length === 0
        ? 'nonchar'
        : (settings.localOrganizeScope === 'nonchar' ? 'nonchar' : 'ungrouped');
    const initialSavedRules = Array.isArray(settings.localOrganizeCustomRules)
        ? settings.localOrganizeCustomRules
        : [];
    const effectiveAiPresets = getEffectiveAiOrganizePresets(settings);
    const savedPresetIdSet = new Set(Array.isArray(settings.aiOrganizePresetIds) ? settings.aiOrganizePresetIds : []);
    const renderAiPresetChipsGroupHtml = (list) => list.map((p) => {
        const active = savedPresetIdSet.has(p.id);
        return `<button type="button" class="wbo-preset-chip${active ? ' is-active' : ''}" data-preset-cat="${esc(p.cat)}" data-preset-id="${esc(p.id)}" data-preset-text="${esc(p.text)}">${esc(p.label)}</button>`;
    }).join('');
    const selectedLocalCatSet = new Set(
        Array.isArray(settings.localOrganizeCategories)
            ? settings.localOrganizeCategories
            : DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS,
    );
    const localCatChipsHtml = LOCAL_ORGANIZE_CATEGORIES.map((cat) => {
        const active = selectedLocalCatSet.has(cat.id);
        return `
            <button type="button" class="wbo-local-cat-btn${active ? ' is-selected' : ''}" data-local-cat="${esc(cat.id)}" aria-pressed="${active ? 'true' : 'false'}">
                <span class="wbo-local-cat-mark">${active ? '<i class="fa-solid fa-check"></i>' : ''}</span>
                <span>${esc(cat.group)}</span>
            </button>
        `;
    }).join('');

    const { modal } = createSubModal(
        '整理世界书',
        `
            <div class="wbo-pinned-tabs-bar" id="wbo-ai-tabs">
                <div class="wbo-tabs">
                    <button type="button" class="wbo-tab${startTab === 'local' ? ' is-active' : ''}" data-ai-tab="local">免 AI 整理</button>
                    <button type="button" class="wbo-tab${startTab === 'organize' ? ' is-active' : ''}" data-ai-tab="organize">AI 整理</button>
                </div>
            </div>

            <div class="wbo-ai-step wbo-local-step" id="wbo-ai-step-local"${startTab === 'local' ? '' : ' hidden'}>
                <div class="wbo-step-scroll">
                <div class="wbo-card wbo-local-card">
                    <div class="wbo-ai-section-head">
                        <span>1. 选择整理范围</span>
                    </div>
                    <div class="wbo-scope-grid">
                        <label class="wbo-scope-card">
                            <input type="radio" name="wbo-local-scope" value="ungrouped"${initialLocalScope === 'ungrouped' ? ' checked' : ''}>
                            <span class="wbo-scope-body">
                                <span class="wbo-scope-title">仅整理未分组 <span class="wbo-tag" data-local-scope-count="ungrouped">${classification.ungroupedBooks.length} 本</span></span>
                                <span class="wbo-scope-desc">保持已有分组不变</span>
                            </span>
                        </label>
                        <label class="wbo-scope-card">
                            <input type="radio" name="wbo-local-scope" value="nonchar"${initialLocalScope === 'nonchar' ? ' checked' : ''}>
                            <span class="wbo-scope-body">
                                <span class="wbo-scope-title">全部非角色书 <span class="wbo-tag" data-local-scope-count="nonchar">${classification.nonCharCount} 本</span></span>
                                <span class="wbo-scope-desc">按所选规则重新归类</span>
                            </span>
                        </label>
                    </div>
                </div>

                <div class="wbo-card wbo-local-card">
                    <div class="wbo-ai-section-head">
                        <span>2. 选择自动归类分组</span>
                        <span class="wbo-ai-quick-picks">
                            <button type="button" class="wbo-link-btn" id="wbo-local-cats-default">默认</button>
                            <button type="button" class="wbo-link-btn" id="wbo-local-cats-all">全选</button>
                            <button type="button" class="wbo-link-btn" id="wbo-local-cats-none">清空</button>
                        </span>
                    </div>
                    <div class="wbo-local-cats" id="wbo-local-cats">${localCatChipsHtml}</div>
                    <div class="wbo-subtle-tip">点击选中要自动归纳的分组，按书名前缀与关键词匹配，不修改原文件。</div>
                    <div class="wbo-local-divider"></div>
                    <label class="wbo-check-line">
                        <input type="checkbox" id="wbo-local-any-prefix"${settings.localOrganizeUseAnyPrefix ? ' checked' : ''}>
                        <span>同时按书名开头的 [分类] / 【分类】 前缀自动建组</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" id="wbo-local-clean-titles"${settings.localOrganizeCleanTitles ? ' checked' : ''}>
                        <span>顺手清理显示名末尾的 (1)、副本、作者署名</span>
                    </label>
                </div>

                <details class="wbo-collapse-box" id="wbo-local-rules-details"${initialSavedRules.length > 0 ? ' open' : ''}>
                    <summary class="wbo-collapse-summary">
                        <span class="wbo-summary-left"><i class="fa-solid fa-chevron-right wbo-details-chev"></i><span>自定义归类关键词</span></span>
                        <span class="wbo-collapse-hint" id="wbo-local-rules-count">可选</span>
                    </summary>
                    <div class="wbo-collapse-body">
                        <div class="wbo-rule-builder-row">
                            <div class="wbo-rule-field">
                                <span class="wbo-rule-field-label">书名关键词</span>
                                <input type="text" class="wbo-input" id="wbo-local-rule-kw" placeholder="如：穿搭、现代" spellcheck="false">
                            </div>
                            <div class="wbo-rule-field">
                                <span class="wbo-rule-field-label">归入分组</span>
                                <input type="text" class="wbo-input" id="wbo-local-rule-grp" list="wbo-existing-groups-datalist" placeholder="如：User 人设" spellcheck="false">
                            </div>
                            <button type="button" class="wbo-btn wbo-rule-add-btn" id="wbo-local-rule-add-btn">添加</button>
                        </div>
                        <div class="wbo-subtle-tip">支持一次填多个关键词，用逗号或空格隔开。</div>
                        <datalist id="wbo-existing-groups-datalist">
                            ${settings.groups.map((g) => `<option value="${esc(g.name)}"></option>`).join('')}
                        </datalist>
                        <div class="wbo-rule-chips" id="wbo-local-rule-chips"></div>
                    </div>
                </details>

                <div class="wbo-ai-status" id="wbo-local-status"></div>
                </div>
                <div class="wbo-modal-footer wbo-ai-footer wbo-ai-footer-single wbo-pinned-footer">
                    <div class="wbo-ai-footer-left">
                        <button type="button" class="wbo-btn" id="wbo-local-undo-btn" ${hasUndo ? '' : 'hidden'}>
                            ${UNDO_SVG} <span id="wbo-local-undo-label">${esc(getUndoButtonLabel())}</span>
                        </button>
                    </div>
                    <div class="wbo-ai-footer-right">
                        <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-local-run-btn">
                            <i class="fa-solid fa-bolt"></i> 一键自动归类
                        </button>
                    </div>
                </div>
            </div>

            <div class="wbo-ai-step" id="wbo-ai-step-select"${startTab === 'organize' ? '' : ' hidden'}>
                <div class="wbo-step-scroll">
                <div class="wbo-card wbo-ai-card">
                    <div class="wbo-ai-section-head">
                        <span class="wbo-ai-quick-picks">
                            <span>1. 选择世界书</span>
                            <span class="wbo-tag" id="wbo-ai-selected-count" role="status">已勾选 ${defaultChecked.size} 本世界书</span>
                        </span>
                        <span class="wbo-ai-quick-picks">
                            <button type="button" class="wbo-link-btn" id="wbo-pick-ungrouped">仅未分组</button>
                            <button type="button" class="wbo-link-btn" id="wbo-pick-nonchar">全部非角色书</button>
                            <button type="button" class="wbo-link-btn" id="wbo-pick-none">全选</button>
                        </span>
                    </div>
                    <div class="wbo-gp-pills" id="wbo-ai-book-tabs" role="group" aria-label="世界书类别">
                        <button type="button" class="wbo-pill" data-ai-book-tab="normal">正常世界书 <span class="wbo-pill-count"></span></button>
                        <button type="button" class="wbo-pill" data-ai-book-tab="sensitive">疑似敏感世界书 <span class="wbo-pill-count"></span></button>
                    </div>
                    <div class="wbo-sens-banner" id="wbo-sens-banner">
                        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                        <span id="wbo-sens-banner-text" aria-live="polite">${sensitiveSendWarning}，因此已默认移除选中。</span>
                    </div>
                    <input type="search" class="wbo-input wbo-ai-book-filter" id="wbo-ai-book-filter" placeholder="搜索筛选世界书..." autocomplete="off" spellcheck="false">
                    <div class="wbo-gp-pills wbo-book-group-switcher" id="wbo-ai-book-groups" role="group" aria-label="世界书分组" hidden></div>
                    <div class="wbo-sens-banner-actions" id="wbo-ai-sensitive-actions" hidden>
                        <button type="button" class="wbo-link-btn" id="wbo-pick-toggle-sens">全选敏感书</button>
                        <div class="wbo-sens-assign">
                            <select class="wbo-select" id="wbo-sens-target-group" aria-label="归入的分组"></select>
                            <button type="button" class="wbo-link-btn" id="wbo-sens-move-nsfw-btn" data-action-move-nsfw="1" disabled>归入分组</button>
                        </div>
                    </div>
                    <div class="wbo-sens-confirm-bar" id="wbo-sens-confirm-bar" hidden>
                        <span class="wbo-sens-confirm-text" id="wbo-sens-confirm-text"></span>
                        <span class="wbo-sens-confirm-actions">
                            <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-sens-confirm-ok">确认归入</button>
                            <button type="button" class="wbo-btn" id="wbo-sens-confirm-cancel">取消</button>
                        </span>
                    </div>
                    <div class="wbo-sens-result-bar" id="wbo-sens-result-bar" hidden>
                        <span class="wbo-sens-result-text" id="wbo-sens-result-text"></span>
                        <button type="button" class="wbo-btn wbo-sens-undo-btn" id="wbo-sens-inline-undo">${UNDO_SVG}<span>撤回</span></button>
                    </div>
                    <div class="wbo-ai-book-list" id="wbo-ai-book-list">${bookChecksHtml}</div>
                    <div class="wbo-ai-import-prompt" id="wbo-ai-import-prompt" hidden>
                        <span>以后导入的疑似敏感世界书可以按标题自动归组。</span>
                        <div class="wbo-ai-quick-picks">
                            <button type="button" class="wbo-link-btn" data-open-import-rules-intro>设置导入归类</button>
                            <button type="button" class="wbo-link-btn" data-skip-import-rules-intro>跳过</button>
                        </div>
                    </div>
                </div>

                <div class="wbo-card wbo-ai-card">
                    <div class="wbo-ai-section-head">
                        <span>2. 选择风格</span>
                        <span class="wbo-ai-quick-picks">
                            <button type="button" class="wbo-link-btn" id="wbo-ai-save-as-preset-btn">+ 存为预设</button>
                            <button type="button" class="wbo-link-btn" id="wbo-ai-manage-presets-btn">修改/管理预设</button>
                        </span>
                    </div>
                    <div class="wbo-ai-options">
                        <div class="wbo-preset-rows" id="wbo-ai-preset-rows">
                            <div class="wbo-preset-group">
                                <span class="wbo-preset-label">分类方式</span>
                                <div class="wbo-preset-chips-grid" id="wbo-ai-cat-presets-grid">
                                    ${renderAiPresetChipsGroupHtml(effectiveAiPresets.categoryPresets)}
                                </div>
                            </div>
                            <div class="wbo-preset-group">
                                <span class="wbo-preset-label">命名与自定义</span>
                                <div class="wbo-preset-chips-grid" id="wbo-ai-name-presets-grid">
                                    ${renderAiPresetChipsGroupHtml(effectiveAiPresets.namingPresets)}
                                </div>
                            </div>
                        </div>
                        <textarea class="wbo-textarea wbo-rule-textarea" id="wbo-ai-custom-rule" rows="2" placeholder="可选：点上方预设自动填入，也可直接修改文案并点右上角「+ 存为预设」..." spellcheck="false">${esc(settings.aiOrganizeCustomRule || '')}</textarea>
                        <div class="wbo-ai-save-preset-bar" id="wbo-ai-save-preset-bar" hidden>
                            <input type="text" class="wbo-input" id="wbo-ai-new-preset-label" placeholder="预设名称，例如：我的跑团分类法" spellcheck="false">
                            <select class="wbo-select wbo-inline-select" id="wbo-ai-new-preset-cat">
                                <option value="group">归入「分类方式」</option>
                                <option value="custom">归入「命名与自定义」</option>
                            </select>
                            <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-confirm-save-preset">保存预设</button>
                            <button type="button" class="wbo-btn" id="wbo-ai-cancel-save-preset">取消</button>
                        </div>

                        <details class="wbo-collapse-box"${settings.aiOrganizeIncludeClues ? ' open' : ''}>
                            <summary class="wbo-collapse-summary">
                                <span class="wbo-summary-left"><i class="fa-solid fa-chevron-right wbo-details-chev"></i><span>高级选项（读取条目摘要 / 修改真实文件名）</span></span>
                            </summary>
                            <div class="wbo-collapse-body">
                                <div class="wbo-clue-block">
                                    <label class="wbo-check-line">
                                        <input type="checkbox" id="wbo-ai-include-clues"${settings.aiOrganizeIncludeClues ? ' checked' : ''}>
                                        <span>附带书内条目摘要辅助归类</span>
                                    </label>
                                    <div class="wbo-clue-subrow${settings.aiOrganizeIncludeClues ? '' : ' is-disabled'}" id="wbo-ai-clue-subrow">
                                        <span class="wbo-clue-field">
                                            <span>读取条数</span>
                                            <input type="number" class="wbo-input wbo-inline-num" id="wbo-ai-clue-count" value="${Number(settings.aiOrganizeClueCount || 5)}" min="1" max="15"${settings.aiOrganizeIncludeClues ? '' : ' disabled'}>
                                            <span>条</span>
                                        </span>
                                        <span class="wbo-clue-field">
                                            <span>摘要内容</span>
                                            <select class="wbo-select wbo-inline-select" id="wbo-ai-snippet-len"${settings.aiOrganizeIncludeClues ? '' : ' disabled'}>
                                                <option value="50"${Number(settings.aiOrganizeSnippetLen ?? 50) === 50 ? ' selected' : ''}>标题 + 50字摘要</option>
                                                <option value="120"${Number(settings.aiOrganizeSnippetLen) === 120 ? ' selected' : ''}>标题 + 120字摘要</option>
                                                <option value="0"${Number(settings.aiOrganizeSnippetLen) === 0 ? ' selected' : ''}>仅标题与关键词</option>
                                            </select>
                                        </span>
                                    </div>
                                </div>
                                <div class="wbo-subtle-tip">摘要在本地直接截取，不额外消耗 AI 额度。</div>
                                <label class="wbo-check-line">
                                    <input type="checkbox" id="wbo-ai-allow-real-rename">
                                    <span>允许同步修改世界书真实文件名，并自动更新角色卡与人设绑定</span>
                                </label>
                            </div>
                        </details>
                    </div>
                </div>

                <div class="wbo-refusal-box" id="wbo-ai-refusal-box" hidden></div>
                <div class="wbo-ai-status" id="wbo-ai-status"></div>
                </div>

                <div class="wbo-modal-footer wbo-ai-footer wbo-pinned-footer">
                    <div class="wbo-ai-footer-left">
                        <button type="button" class="wbo-btn" id="wbo-ai-undo-btn" ${hasUndo ? '' : 'hidden'} title="恢复到上一次整理前的分组与显示名">
                            ${UNDO_SVG} <span id="wbo-ai-undo-label">${esc(getUndoButtonLabel())}</span>
                        </button>
                        <span class="wbo-api-inline-info">
                            <b id="wbo-api-summary-text">${esc(getApiSummaryText())}</b>
                            <button type="button" class="wbo-link-btn" id="wbo-goto-api-tab">配置 API</button>
                        </span>
                    </div>
                    <div class="wbo-ai-footer-right">
                        <button type="button" class="wbo-btn" id="wbo-toggle-external-ai-btn" title="不使用 API，复制提示词给外部 AI 后粘贴 JSON">
                            <i class="fa-regular fa-copy"></i> 外部 AI 整理
                        </button>
                        <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-run-btn">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> 开始 AI 整理
                        </button>
                    </div>
                </div>
            </div>

            <div class="wbo-ai-step" id="wbo-ai-step-external" hidden>
                <div class="wbo-pinned-top">
                    <div class="wbo-eb-topbar">
                        <button type="button" class="wbo-btn" id="wbo-external-back-btn">
                            <i class="fa-solid fa-arrow-left"></i> 返回 AI 整理
                        </button>
                        <span class="wbo-ai-subview-title">外部 AI 整理（免 API 额度）</span>
                    </div>
                </div>
                <div class="wbo-step-scroll">
                    <div class="wbo-card">
                        <div class="wbo-ai-section-head">
                            <span>两步完成外部 AI 归类</span>
                        </div>
                        <div class="wbo-subtle-tip">1. 点击下方「复制提示词」发给任意外部 AI；<br>2. 把 AI 返回的 JSON 粘贴到下方文本框，点击「解析并预览」。</div>
                        <textarea class="wbo-textarea wbo-external-json-textarea" id="wbo-ai-json-input" rows="10" placeholder='在此粘贴外部 AI 返回的 JSON 结果...' spellcheck="false"></textarea>
                    </div>
                    <div class="wbo-refusal-box" id="wbo-external-refusal-box" hidden></div>
                    <div class="wbo-ai-status" id="wbo-external-status"></div>
                </div>
                <div class="wbo-modal-footer wbo-pinned-footer wbo-footer-pair">
                    <button type="button" class="wbo-btn" id="wbo-ai-copy-prompt-btn">
                        <i class="fa-regular fa-copy"></i> 复制提示词
                    </button>
                    <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-parse-paste-btn">解析并预览</button>
                </div>
            </div>

            <div class="wbo-ai-step" id="wbo-ai-step-api" hidden>
                <div class="wbo-step-scroll">
                <div class="wbo-card">
                    <div class="wbo-ai-section-head">
                        <span>选择调用渠道</span>
                    </div>
                    <div class="wbo-radio-row">
                        <label class="wbo-radio-opt">
                            <input type="radio" name="wbo-api-provider" value="host" ${settings.apiProvider === 'host' ? 'checked' : ''}>
                            <span>酒馆当前 API</span>
                        </label>
                        <label class="wbo-radio-opt">
                            <input type="radio" name="wbo-api-provider" value="custom" ${settings.apiProvider === 'custom' ? 'checked' : ''}>
                            <span>自定义 OpenAI 兼容 API</span>
                        </label>
                    </div>

                    <div class="wbo-custom-api-box" id="wbo-custom-api-box" ${settings.apiProvider === 'custom' ? '' : 'hidden'}>
                        <div class="wbo-channel-bar">
                            <select class="wbo-select" id="wbo-channel-select"></select>
                            <button type="button" class="wbo-btn" id="wbo-ch-new-btn">新建</button>
                            <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ch-save-btn">保存</button>
                            <button type="button" class="wbo-btn" id="wbo-ch-del-btn">删除</button>
                        </div>
                        <input type="text" class="wbo-input" id="wbo-api-name" value="${esc(activeCh?.name || '')}" placeholder="配置名称，例如：常用通道 1" spellcheck="false">
                        <input type="text" class="wbo-input" id="wbo-api-base-url" value="${esc(activeCh?.baseUrl || 'https://api.openai.com/v1')}" placeholder="Base URL，例如 https://api.openai.com/v1" spellcheck="false">
                        <div class="wbo-api-model-row">
                            <input type="password" class="wbo-input" id="wbo-api-key" value="${esc(activeCh?.apiKey || '')}" placeholder="API Key" autocomplete="off" spellcheck="false">
                            <button type="button" class="wbo-btn" id="wbo-toggle-key-btn" title="显示或隐藏密钥">
                                <i class="fa-regular fa-eye"></i>
                            </button>
                        </div>
                        <div class="wbo-api-model-row">
                            <input type="text" class="wbo-input" id="wbo-api-model" value="${esc(activeCh?.model || '')}" list="wbo-api-models-datalist" placeholder="模型名称" spellcheck="false">
                            <datalist id="wbo-api-models-datalist"></datalist>
                            <button type="button" class="wbo-btn" id="wbo-fetch-models-btn">拉取模型</button>
                        </div>
                        <div class="wbo-ai-status" id="wbo-api-channel-status"></div>
                    </div>
                </div>
                </div>
                <div class="wbo-modal-footer wbo-pinned-footer">
                    <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-back-to-organize-btn">返回整理</button>
                </div>
            </div>

            <div class="wbo-ai-step" id="wbo-ai-step-presets" hidden>
                <div class="wbo-pinned-top">
                    <div class="wbo-eb-topbar">
                        <button type="button" class="wbo-btn" id="wbo-presets-back-btn">
                            <i class="fa-solid fa-arrow-left"></i> 返回 AI 整理
                        </button>
                        <span class="wbo-ai-subview-title">管理与自定义 AI 整理预设</span>
                        <span class="wbo-spacer"></span>
                        <button type="button" class="wbo-btn" id="wbo-presets-add-blank-btn">
                            <i class="fa-solid fa-plus"></i> 新增预设
                        </button>
                    </div>
                </div>
                <div class="wbo-step-scroll">
                    <div class="wbo-subtle-tip">可直接修改任意预设的按钮名称与提示词，保存后永久生效；不满意随时可恢复默认预设。</div>
                    <div class="wbo-ai-presets-mgr-list" id="wbo-ai-presets-mgr-list"></div>
                    <div class="wbo-ai-status" id="wbo-ai-presets-status"></div>
                </div>
                <div class="wbo-modal-footer wbo-pinned-footer wbo-ai-footer wbo-ai-footer-single">
                    <div class="wbo-ai-footer-left">
                        <button type="button" class="wbo-btn" id="wbo-presets-reset-btn">
                            <i class="fa-solid fa-rotate-left"></i> 恢复默认预设
                        </button>
                    </div>
                    <div class="wbo-ai-footer-right">
                        <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-presets-done-btn">完成返回</button>
                    </div>
                </div>
            </div>

            <div class="wbo-ai-step" id="wbo-ai-step-preview" hidden>
                <div class="wbo-step-scroll">
                <div class="wbo-ai-section-head">
                    <span>预览分组结果</span>
                    <button type="button" class="wbo-link-btn" id="wbo-ai-back-btn">返回重选</button>
                </div>
                <div class="wbo-radio-row" id="wbo-preview-apply-mode-row">
                    <label class="wbo-radio-opt">
                        <input type="radio" name="wbo-ai-apply-mode" value="alias" checked>
                        <span>仅改显示名</span>
                    </label>
                    <label class="wbo-radio-opt">
                        <input type="radio" name="wbo-ai-apply-mode" value="real">
                        <span>真实规范改名并同步绑定</span>
                    </label>
                </div>
                <div class="wbo-real-hint" id="wbo-ai-real-hint" hidden>
                    将按修改后的名称真实重命名世界书文件，并同步更新角色卡主/附绑定、User 人设绑定、当前聊天与全局激活。
                </div>
                <div class="wbo-preview-toolbar">
                    <div class="wbo-preview-group-pills" id="wbo-preview-group-pills"></div>
                    <div class="wbo-preview-select-tools">
                        <span class="wbo-preview-sel-count" id="wbo-preview-sel-count">已选 0/0</span>
                        <button type="button" class="wbo-link-btn" id="wbo-preview-clear-notes" hidden>清空说明</button>
                        <button type="button" class="wbo-link-btn" id="wbo-preview-toggle-all">取消全选</button>
                    </div>
                </div>
                <datalist id="wbo-preview-groups-datalist"></datalist>
                <div class="wbo-ai-preview-list" id="wbo-ai-preview-list"></div>

                <details class="wbo-collapse-box" id="wbo-preview-redo-details">
                    <summary class="wbo-collapse-summary">
                        <span class="wbo-summary-left"><i class="fa-solid fa-chevron-right wbo-details-chev"></i><span id="wbo-redo-summary">不满意部分分组？点此选组让 AI 重排</span></span>
                        <button type="button" class="wbo-link-btn" id="wbo-redo-clear-btn" hidden>清除重排</button>
                    </summary>
                    <div class="wbo-collapse-body">
                        <div class="wbo-redo-group-chips" id="wbo-redo-group-chips"></div>
                        <textarea class="wbo-textarea wbo-rule-textarea" id="wbo-ai-redo-reason" rows="2" placeholder="可选：说明调整期望（例如：把规则补丁单独建组，或合并相近的小分组）" spellcheck="false"></textarea>
                        <div class="wbo-ai-actions-row">
                            <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-redo-run-btn" disabled>
                                <i class="fa-solid fa-rotate"></i> 重新发送给 AI
                            </button>
                            <button type="button" class="wbo-btn" id="wbo-ai-redo-copy-btn" disabled>
                                <i class="fa-regular fa-copy"></i> 复制重排提示词
                            </button>
                        </div>
                        <div class="wbo-redo-paste-box" id="wbo-redo-paste-box" hidden>
                            <textarea class="wbo-textarea" id="wbo-ai-redo-json-input" rows="3" placeholder="将外部 AI 返回的重排 JSON 粘贴到此处，仅更新已选中的重排项" spellcheck="false"></textarea>
                            <div class="wbo-ai-actions-row">
                                <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-redo-merge-btn">解析并合并重排结果</button>
                            </div>
                        </div>
                    </div>
                </details>

                <div class="wbo-apply-progress-box" id="wbo-apply-progress-box" hidden></div>
                <div class="wbo-ai-status" id="wbo-ai-preview-status"></div>
                </div>
                <div class="wbo-modal-footer wbo-pinned-footer wbo-footer-pair">
                    <button type="button" class="wbo-btn" id="wbo-ai-cancel-btn">取消</button>
                    <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-ai-apply-btn">确认应用</button>
                </div>
            </div>
        `,
        { wide: true, pinnedLayout: true },
    );

    const statusEl = modal.querySelector('#wbo-ai-status');
    const refusalBox = modal.querySelector('#wbo-ai-refusal-box');
    const externalStatusEl = modal.querySelector('#wbo-external-status');
    const externalRefusalBox = modal.querySelector('#wbo-external-refusal-box');
    const previewStatusEl = modal.querySelector('#wbo-ai-preview-status');
    const channelStatusEl = modal.querySelector('#wbo-api-channel-status');
    const stepLocal = modal.querySelector('#wbo-ai-step-local');
    const stepSelect = modal.querySelector('#wbo-ai-step-select');
    const stepExternal = modal.querySelector('#wbo-ai-step-external');
    const stepApi = modal.querySelector('#wbo-ai-step-api');
    const stepPresets = modal.querySelector('#wbo-ai-step-presets');
    const stepPreview = modal.querySelector('#wbo-ai-step-preview');
    const localStatusEl = modal.querySelector('#wbo-local-status');
    const tabsBar = modal.querySelector('#wbo-ai-tabs');
    const previewList = modal.querySelector('#wbo-ai-preview-list');
    const customApiBox = modal.querySelector('#wbo-custom-api-box');
    const summaryTextEl = modal.querySelector('#wbo-api-summary-text');
    const tabBadgeEl = modal.querySelector('#wbo-api-tab-badge');
    const channelSelect = modal.querySelector('#wbo-channel-select');
    const nameInput = modal.querySelector('#wbo-api-name');
    const urlInput = modal.querySelector('#wbo-api-base-url');
    const keyInput = modal.querySelector('#wbo-api-key');
    const modelInput = modal.querySelector('#wbo-api-model');

    let editingChannelId = activeCh?.id || null;
    let lastOrganizeSourceTab = startTab === 'organize' ? 'organize' : 'local';

    const switchAiTab = (tabName) => {
        if (tabName === 'local' || tabName === 'organize') {
            lastOrganizeSourceTab = tabName;
            if (settings.organizeLastTab !== tabName) {
                settings.organizeLastTab = tabName;
                void _callbacks?.onMutation({ save: true, uiOnly: true });
            }
        }
        if (stepLocal instanceof HTMLElement) stepLocal.hidden = tabName !== 'local';
        if (stepSelect instanceof HTMLElement) stepSelect.hidden = tabName !== 'organize';
        if (stepExternal instanceof HTMLElement) stepExternal.hidden = tabName !== 'external';
        if (stepApi instanceof HTMLElement) stepApi.hidden = tabName !== 'api';
        if (stepPresets instanceof HTMLElement) stepPresets.hidden = tabName !== 'presets';
        if (stepPreview instanceof HTMLElement) stepPreview.hidden = true;
        // Hide the 2-way top bar while inside dedicated sub-views (`api` / `external` / `presets`)
        if (tabsBar instanceof HTMLElement) tabsBar.hidden = tabName === 'api' || tabName === 'external' || tabName === 'presets';
        modal.querySelectorAll('.wbo-tab').forEach((t) => {
            t.classList.toggle('is-active', t.getAttribute('data-ai-tab') === tabName);
        });
    };

    modal.querySelectorAll('.wbo-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
            const tab = btn.getAttribute('data-ai-tab') || 'local';
            switchAiTab(tab);
        });
    });
    modal.querySelector('#wbo-goto-api-tab')?.addEventListener('click', () => switchAiTab('api'));
    modal.querySelector('#wbo-back-to-organize-btn')?.addEventListener('click', () => switchAiTab('organize'));
    modal.querySelector('#wbo-external-back-btn')?.addEventListener('click', () => switchAiTab('organize'));
    modal.querySelectorAll('details.wbo-collapse-box').forEach((detailsEl) => {
        detailsEl.addEventListener('toggle', () => {
            if (!detailsEl.open) return;
            requestAnimationFrame(() => {
                try {
                    detailsEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                } catch {
                    detailsEl.scrollIntoView(false);
                }
            });
        });
    });

    // Interactive built-in category chips for 免 AI 整理 (persisted in settings.localOrganizeCategories)
    const localCatsEl = modal.querySelector('#wbo-local-cats');
    const syncLocalCatChips = () => {
        settings.localOrganizeCategories = LOCAL_ORGANIZE_CATEGORIES
            .filter((c) => selectedLocalCatSet.has(c.id))
            .map((c) => c.id);
        localCatsEl?.querySelectorAll('[data-local-cat]').forEach((btn) => {
            const id = btn.getAttribute('data-local-cat') || '';
            const active = selectedLocalCatSet.has(id);
            btn.classList.toggle('is-selected', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            const mark = btn.querySelector('.wbo-local-cat-mark');
            if (mark) mark.innerHTML = active ? '<i class="fa-solid fa-check"></i>' : '';
        });
        void _callbacks?.onMutation({ save: true, uiOnly: true });
    };
    localCatsEl?.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-local-cat]') : null;
        if (!btn) return;
        const id = btn.getAttribute('data-local-cat') || '';
        if (!id) return;
        if (selectedLocalCatSet.has(id)) selectedLocalCatSet.delete(id);
        else selectedLocalCatSet.add(id);
        syncLocalCatChips();
    });
    modal.querySelector('#wbo-local-cats-default')?.addEventListener('click', () => {
        selectedLocalCatSet.clear();
        for (const id of DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS) selectedLocalCatSet.add(id);
        syncLocalCatChips();
    });
    modal.querySelector('#wbo-local-cats-all')?.addEventListener('click', () => {
        selectedLocalCatSet.clear();
        for (const c of LOCAL_ORGANIZE_CATEGORIES) selectedLocalCatSet.add(c.id);
        syncLocalCatChips();
    });
    modal.querySelector('#wbo-local-cats-none')?.addEventListener('click', () => {
        selectedLocalCatSet.clear();
        syncLocalCatChips();
    });

    // Persist Local Organize scope & checkboxes across restarts
    modal.querySelectorAll('input[name="wbo-local-scope"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            const val = modal.querySelector('input[name="wbo-local-scope"]:checked')?.value;
            if (val === 'ungrouped' || val === 'nonchar') {
                settings.localOrganizeScope = val;
                void _callbacks?.onMutation({ save: true, uiOnly: true });
            }
        });
    });
    modal.querySelector('#wbo-local-any-prefix')?.addEventListener('change', (ev) => {
        if (ev.currentTarget instanceof HTMLInputElement) {
            settings.localOrganizeUseAnyPrefix = ev.currentTarget.checked;
            void _callbacks?.onMutation({ save: true, uiOnly: true });
        }
    });
    modal.querySelector('#wbo-local-clean-titles')?.addEventListener('change', (ev) => {
        if (ev.currentTarget instanceof HTMLInputElement) {
            settings.localOrganizeCleanTitles = ev.currentTarget.checked;
            void _callbacks?.onMutation({ save: true, uiOnly: true });
        }
    });

    // Visual 2-box custom rule builder for 免 AI 整理 (persisted in settings.localOrganizeCustomRules!)
    /** @type {Array<{ kw: string, group: string }>} */
    const localCustomRules = deepClone(initialSavedRules);
    const persistLocalCustomRules = () => {
        settings.localOrganizeCustomRules = deepClone(localCustomRules);
        void _callbacks?.onMutation({ save: true, uiOnly: true });
    };
    const ruleKwInput = modal.querySelector('#wbo-local-rule-kw');
    const ruleGrpInput = modal.querySelector('#wbo-local-rule-grp');
    const ruleChipsEl = modal.querySelector('#wbo-local-rule-chips');
    const ruleCountEl = modal.querySelector('#wbo-local-rules-count');

    const renderLocalRuleChips = () => {
        if (ruleCountEl) {
            ruleCountEl.textContent = localCustomRules.length > 0 ? `已保存 ${localCustomRules.length} 条` : '点击展开';
        }
        if (!ruleChipsEl) return;
        if (localCustomRules.length === 0) {
            ruleChipsEl.innerHTML = '<span class="wbo-subtle-tip">暂未添加自定义规则</span>';
            return;
        }
        ruleChipsEl.innerHTML = localCustomRules.map((r, idx) => `
            <span class="wbo-rule-chip">
                <span>含「${esc(r.kw)}」→ <b>${esc(r.group)}</b></span>
                <button type="button" class="wbo-rule-chip-del" data-del-rule-idx="${idx}" aria-label="删除">×</button>
            </span>
        `).join('');
    };
    renderLocalRuleChips();

    const addLocalRuleFromInputs = () => {
        const kw = ruleKwInput instanceof HTMLInputElement ? ruleKwInput.value.trim() : '';
        const group = ruleGrpInput instanceof HTMLInputElement ? ruleGrpInput.value.trim() : '';
        if (!kw || !group) {
            if (localStatusEl) {
                localStatusEl.textContent = '请同时填写「书名包含词」和「分组名」后再点添加';
                localStatusEl.className = 'wbo-ai-status is-error';
            }
            return;
        }
        localCustomRules.push({ kw, group });
        if (ruleKwInput instanceof HTMLInputElement) ruleKwInput.value = '';
        if (ruleGrpInput instanceof HTMLInputElement) ruleGrpInput.value = '';
        if (localStatusEl) localStatusEl.textContent = '';
        renderLocalRuleChips();
        persistLocalCustomRules();
    };
    modal.querySelector('#wbo-local-rule-add-btn')?.addEventListener('click', addLocalRuleFromInputs);
    bindImeSafeEnter(ruleGrpInput, addLocalRuleFromInputs);
    ruleChipsEl?.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-del-rule-idx]') : null;
        if (!btn) return;
        const idx = Number(btn.getAttribute('data-del-rule-idx'));
        if (Number.isInteger(idx) && idx >= 0 && idx < localCustomRules.length) {
            localCustomRules.splice(idx, 1);
            renderLocalRuleChips();
            persistLocalCustomRules();
        }
    });

    modal.querySelector('#wbo-local-run-btn')?.addEventListener('click', () => {
        // Also pick up any rule typed in the boxes even if user forgot to click "添加"!
        const pendingKw = ruleKwInput instanceof HTMLInputElement ? ruleKwInput.value.trim() : '';
        const pendingGrp = ruleGrpInput instanceof HTMLInputElement ? ruleGrpInput.value.trim() : '';
        if (pendingKw && pendingGrp) {
            localCustomRules.push({ kw: pendingKw, group: pendingGrp });
            if (ruleKwInput instanceof HTMLInputElement) ruleKwInput.value = '';
            if (ruleGrpInput instanceof HTMLInputElement) ruleGrpInput.value = '';
            renderLocalRuleChips();
            persistLocalCustomRules();
        }

        const scope = modal.querySelector('input[name="wbo-local-scope"]:checked')?.value || 'ungrouped';
        const targetBooks = scope === 'ungrouped'
            ? classification.ungroupedBooks
            : allBooks.filter((b) => !b.isInCharGroup);
        if (targetBooks.length === 0) {
            if (localStatusEl) {
                localStatusEl.textContent = '当前范围内没有需要整理的世界书，可切换为「整理全部非角色书」。';
                localStatusEl.className = 'wbo-ai-status is-error';
            }
            return;
        }
        const cleanTitles = Boolean(modal.querySelector('#wbo-local-clean-titles')?.checked);
        const useAnyBracketPrefix = Boolean(modal.querySelector('#wbo-local-any-prefix')?.checked);
        const customRulesText = localCustomRules.map((r) => `${r.kw} => ${r.group}`).join('\n');
        if (selectedLocalCatSet.size === 0 && !useAnyBracketPrefix && localCustomRules.length === 0 && !cleanTitles) {
            if (localStatusEl) {
                localStatusEl.textContent = '请至少选中一个自动归类分组，或添加自定义归类关键词。';
                localStatusEl.className = 'wbo-ai-status is-error';
            }
            return;
        }
        const proposals = buildLocalOrganizeProposals({
            books: targetBooks.map((b) => ({
                realName: b.realName,
                currentAlias: b.alias || '',
                currentGroup: b.groupName || '',
            })),
            usePrefix: true,
            useAnyBracketPrefix,
            useKeywords: true,
            cleanTitles,
            enabledCategoryIds: [...selectedLocalCatSet],
            customRulesText,
        });
        if (localStatusEl) localStatusEl.textContent = '';
        lastOrganizeSourceTab = 'local';
        showPreview(proposals, 0, { fromLocal: true });
    });

    const includeCluesCb = modal.querySelector('#wbo-ai-include-clues');
    const clueSubrowEl = modal.querySelector('#wbo-ai-clue-subrow');
    const clueCountInput = modal.querySelector('#wbo-ai-clue-count');
    const snippetLenSelect = modal.querySelector('#wbo-ai-snippet-len');
    const syncClueControlsState = (shouldSave = false) => {
        const enabled = Boolean(includeCluesCb instanceof HTMLInputElement && includeCluesCb.checked);
        if (clueSubrowEl instanceof HTMLElement) clueSubrowEl.classList.toggle('is-disabled', !enabled);
        if (clueCountInput instanceof HTMLInputElement) clueCountInput.disabled = !enabled;
        if (snippetLenSelect instanceof HTMLSelectElement) snippetLenSelect.disabled = !enabled;
        if (shouldSave) {
            settings.aiOrganizeIncludeClues = enabled;
            if (clueCountInput instanceof HTMLInputElement) {
                const rawN = Number(clueCountInput.value);
                if (Number.isFinite(rawN)) {
                    settings.aiOrganizeClueCount = Math.max(1, Math.min(15, Math.round(rawN)));
                }
            }
            if (snippetLenSelect instanceof HTMLSelectElement) {
                const rawLen = Number(snippetLenSelect.value);
                if ([0, 50, 120].includes(rawLen)) settings.aiOrganizeSnippetLen = rawLen;
            }
            void _callbacks?.onMutation({ save: true, uiOnly: true });
        }
    };
    includeCluesCb?.addEventListener('change', () => syncClueControlsState(true));
    clueCountInput?.addEventListener('change', () => syncClueControlsState(true));
    snippetLenSelect?.addEventListener('change', () => syncClueControlsState(true));
    syncClueControlsState(false);

    modal.querySelector('#wbo-toggle-external-ai-btn')?.addEventListener('click', () => {
        switchAiTab('external');
    });

    // Interactive & customizable AI Organize Preset chips + persistent rule text
    const customRuleInput = modal.querySelector('#wbo-ai-custom-rule');
    const presetRowsEl = modal.querySelector('#wbo-ai-preset-rows');
    const catPresetsGridEl = modal.querySelector('#wbo-ai-cat-presets-grid');
    const namePresetsGridEl = modal.querySelector('#wbo-ai-name-presets-grid');
    const savePresetBar = modal.querySelector('#wbo-ai-save-preset-bar');
    const newPresetLabelInput = modal.querySelector('#wbo-ai-new-preset-label');
    const newPresetCatSelect = modal.querySelector('#wbo-ai-new-preset-cat');
    const presetsMgrListEl = modal.querySelector('#wbo-ai-presets-mgr-list');
    const presetsStatusEl = modal.querySelector('#wbo-ai-presets-status');
    let ruleSaveTimer = null;

    const persistAiStyleSettings = () => {
        settings.aiOrganizePresetIds = Array.from(modal.querySelectorAll('.wbo-preset-chip.is-active'))
            .map((btn) => btn.getAttribute('data-preset-id') || '')
            .filter(Boolean);
        settings.aiOrganizeCustomRule = customRuleInput instanceof HTMLTextAreaElement ? customRuleInput.value : '';
        void _callbacks?.onMutation({ save: true, uiOnly: true });
    };

    const rebuildAiPresetChipsDom = () => {
        const eff = getEffectiveAiOrganizePresets(settings);
        const activeIds = new Set(Array.isArray(settings.aiOrganizePresetIds) ? settings.aiOrganizePresetIds : []);
        const buildHtml = (list) => list.map((p) => {
            const active = activeIds.has(p.id);
            return `<button type="button" class="wbo-preset-chip${active ? ' is-active' : ''}" data-preset-cat="${esc(p.cat)}" data-preset-id="${esc(p.id)}" data-preset-text="${esc(p.text)}">${esc(p.label)}</button>`;
        }).join('');
        if (catPresetsGridEl) catPresetsGridEl.innerHTML = buildHtml(eff.categoryPresets);
        if (namePresetsGridEl) namePresetsGridEl.innerHTML = buildHtml(eff.namingPresets);
    };

    const syncPresetRuleTextPreservingExtra = () => {
        if (!(customRuleInput instanceof HTMLTextAreaElement)) return;
        const allKnownTexts = new Set(
            getEffectiveAiOrganizePresets(settings).all.map((p) => p.text.trim()).filter(Boolean),
        );
        const manualLines = customRuleInput.value
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !allKnownTexts.has(l));
        const activeTexts = Array.from(modal.querySelectorAll('.wbo-preset-chip.is-active'))
            .map((btn) => (btn.getAttribute('data-preset-text') || '').trim())
            .filter(Boolean);
        customRuleInput.value = [...activeTexts, ...manualLines].join('\n');
        persistAiStyleSettings();
    };

    presetRowsEl?.addEventListener('click', (ev) => {
        const chip = ev.target instanceof Element ? ev.target.closest('.wbo-preset-chip') : null;
        if (!chip) return;
        const cat = chip.getAttribute('data-preset-cat');
        const willActivate = !chip.classList.contains('is-active');
        if (cat && (cat === 'group' || cat === 'name') && willActivate) {
            modal.querySelectorAll(`.wbo-preset-chip[data-preset-cat="${cat}"]`).forEach((other) => {
                other.classList.remove('is-active');
            });
        }
        chip.classList.toggle('is-active', willActivate);
        syncPresetRuleTextPreservingExtra();
    });

    customRuleInput?.addEventListener('input', () => {
        clearTimeout(ruleSaveTimer);
        ruleSaveTimer = setTimeout(() => { persistAiStyleSettings(); }, 180);
    });

    // Quick "+ 存为预设" inline bar
    modal.querySelector('#wbo-ai-save-as-preset-btn')?.addEventListener('click', () => {
        if (!(savePresetBar instanceof HTMLElement)) return;
        const willShow = savePresetBar.hidden;
        savePresetBar.hidden = !willShow;
        if (willShow && newPresetLabelInput instanceof HTMLInputElement && isDesktopAutoFocusAllowed()) {
            newPresetLabelInput.focus();
        }
    });
    modal.querySelector('#wbo-ai-cancel-save-preset')?.addEventListener('click', () => {
        if (savePresetBar instanceof HTMLElement) savePresetBar.hidden = true;
    });
    const confirmSaveQuickPreset = () => {
        const label = newPresetLabelInput instanceof HTMLInputElement ? newPresetLabelInput.value.trim() : '';
        const cat = newPresetCatSelect instanceof HTMLSelectElement ? newPresetCatSelect.value : 'group';
        const text = customRuleInput instanceof HTMLTextAreaElement ? customRuleInput.value.trim() : '';
        if (!text) {
            setStatus('请先在文本框中填写或编辑要保存为预设的提示词', true);
            return;
        }
        const res = upsertAiOrganizePreset(settings, { label, cat, text });
        if (!res.ok) {
            setStatus(res.error || '保存预设失败', true);
            return;
        }
        if (res.preset) {
            if (cat === 'group') {
                const effAll = getEffectiveAiOrganizePresets(settings).all;
                const groupIds = new Set(effAll.filter((p) => p.cat === 'group').map((p) => p.id));
                settings.aiOrganizePresetIds = [
                    ...(settings.aiOrganizePresetIds || []).filter((id) => !groupIds.has(id)),
                    res.preset.id,
                ];
            } else {
                settings.aiOrganizePresetIds = [...new Set([...(settings.aiOrganizePresetIds || []), res.preset.id])];
            }
        }
        if (newPresetLabelInput instanceof HTMLInputElement) newPresetLabelInput.value = '';
        if (savePresetBar instanceof HTMLElement) savePresetBar.hidden = true;
        rebuildAiPresetChipsDom();
        persistAiStyleSettings();
        setStatus(`已保存自定义预设「${res.preset?.label}」`, 'success');
    };
    modal.querySelector('#wbo-ai-confirm-save-preset')?.addEventListener('click', confirmSaveQuickPreset);
    bindImeSafeEnter(newPresetLabelInput, confirmSaveQuickPreset);

    // Full Preset Management sub-view (`#wbo-ai-step-presets`)
    const setPresetsStatus = (msg, kind = 'info') => {
        if (!presetsStatusEl) return;
        presetsStatusEl.textContent = msg;
        presetsStatusEl.className = `wbo-ai-status${kind === 'error' ? ' is-error' : (kind === 'success' ? ' is-success' : '')}`;
    };
    const renderPresetsManagerList = () => {
        if (!presetsMgrListEl) return;
        const eff = getEffectiveAiOrganizePresets(settings);
        const resetBtn = modal.querySelector('#wbo-presets-reset-btn');
        if (resetBtn instanceof HTMLButtonElement) resetBtn.disabled = !eff.isCustomized;

        presetsMgrListEl.innerHTML = eff.all.map((p) => `
            <div class="wbo-card wbo-preset-mgr-card" data-pm-id="${esc(p.id)}">
                <div class="wbo-preset-mgr-top">
                    <input type="text" class="wbo-input wbo-pm-label" value="${esc(p.label)}" placeholder="按钮名称" spellcheck="false">
                    <select class="wbo-select wbo-inline-select wbo-pm-cat">
                        <option value="group"${p.cat === 'group' ? ' selected' : ''}>分类方式（单选）</option>
                        <option value="name"${p.cat === 'name' ? ' selected' : ''}>命名格式（单选）</option>
                        <option value="custom"${p.cat !== 'group' && p.cat !== 'name' ? ' selected' : ''}>附加要求（可多选）</option>
                    </select>
                    <button type="button" class="wbo-btn wbo-btn-primary" data-pm-act="save">保存</button>
                    <button type="button" class="wbo-btn wbo-btn-danger" data-pm-act="delete" title="删除此预设">删除</button>
                </div>
                <textarea class="wbo-textarea wbo-pm-text" rows="2" placeholder="发送给 AI 的归类或命名要求..." spellcheck="false">${esc(p.text)}</textarea>
            </div>
        `).join('');
    };

    modal.querySelector('#wbo-ai-manage-presets-btn')?.addEventListener('click', () => {
        setPresetsStatus('');
        renderPresetsManagerList();
        switchAiTab('presets');
    });
    const exitPresetsSubView = () => {
        rebuildAiPresetChipsDom();
        switchAiTab('organize');
    };
    modal.querySelector('#wbo-presets-back-btn')?.addEventListener('click', exitPresetsSubView);
    modal.querySelector('#wbo-presets-done-btn')?.addEventListener('click', exitPresetsSubView);

    modal.querySelector('#wbo-presets-add-blank-btn')?.addEventListener('click', () => {
        const eff = getEffectiveAiOrganizePresets(settings);
        let idx = eff.all.length + 1;
        let defaultName = `自定义预设 ${idx}`;
        while (eff.all.some((p) => p.label === defaultName)) {
            idx += 1;
            defaultName = `自定义预设 ${idx}`;
        }
        const res = upsertAiOrganizePreset(settings, {
            label: defaultName,
            cat: 'group',
            text: '请按我常用的分类习惯归纳分组，保持组名简短直观。',
        });
        if (res.ok) {
            void _callbacks?.onMutation({ save: true, uiOnly: true });
            renderPresetsManagerList();
            setPresetsStatus(`已新增「${defaultName}」，修改文字后点击保存即可`, 'success');
            const scrollEl = stepPresets?.querySelector('.wbo-step-scroll');
            if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
        }
    });

    modal.querySelector('#wbo-presets-reset-btn')?.addEventListener('click', () => {
        if (!globalThis.confirm('确认将 AI 整理预设恢复为默认方案？（你新增或修改过的预设将被重置）')) return;
        resetAiOrganizePresets(settings);
        settings.aiOrganizePresetIds = [];
        void _callbacks?.onMutation({ save: true, uiOnly: true });
        renderPresetsManagerList();
        rebuildAiPresetChipsDom();
        setPresetsStatus('已恢复默认预设方案', 'success');
    });

    presetsMgrListEl?.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-pm-act]') : null;
        if (!btn) return;
        const card = btn.closest('.wbo-preset-mgr-card');
        if (!(card instanceof HTMLElement)) return;
        const id = card.getAttribute('data-pm-id') || '';
        const act = btn.getAttribute('data-pm-act') || '';
        if (act === 'save') {
            const label = card.querySelector('.wbo-pm-label')?.value?.trim() || '';
            const cat = card.querySelector('.wbo-pm-cat')?.value || 'group';
            const text = card.querySelector('.wbo-pm-text')?.value?.trim() || '';
            const prevText = getEffectiveAiOrganizePresets(settings).all.find((p) => p.id === id)?.text || '';
            const res = upsertAiOrganizePreset(settings, { id, label, cat, text });
            if (!res.ok) {
                setPresetsStatus(res.error || '保存失败', 'error');
                return;
            }
            if (prevText && prevText !== text && customRuleInput instanceof HTMLTextAreaElement && customRuleInput.value.includes(prevText)) {
                customRuleInput.value = customRuleInput.value.replace(prevText, text);
                settings.aiOrganizeCustomRule = customRuleInput.value;
            }
            void _callbacks?.onMutation({ save: true, uiOnly: true });
            renderPresetsManagerList();
            rebuildAiPresetChipsDom();
            setPresetsStatus(`已保存预设「${label}」`, 'success');
        } else if (act === 'delete') {
            const curName = card.querySelector('.wbo-pm-label')?.value?.trim() || '该预设';
            if (!globalThis.confirm(`确认删除预设「${curName}」？`)) return;
            if (deleteAiOrganizePreset(settings, id)) {
                void _callbacks?.onMutation({ save: true, uiOnly: true });
                renderPresetsManagerList();
                rebuildAiPresetChipsDom();
                setPresetsStatus(`已删除预设「${curName}」`, 'info');
            }
        }
    });

    // IME-safe filter inside AI book list
    const aiBookFilter = modal.querySelector('#wbo-ai-book-filter');
    const bookGroupTabs = modal.querySelector('#wbo-ai-book-groups');
    const renderBookGroupTabs = () => {
        if (!bookGroupTabs) return;
        const books = allBooks.filter((book) => sensitiveSet.has(book.realName) === (activeBookTab === 'sensitive'));
        const counts = new Map();
        for (const book of books) counts.set(book.groupId, (counts.get(book.groupId) || 0) + 1);
        bookGroupTabs.hidden = counts.size < 2;
        const current = bookGroupByTab[activeBookTab];
        if (!counts.has(current) || counts.size < 2) bookGroupByTab[activeBookTab] = '';
        const tabs = [{ id: '', name: '全部', count: books.length }];
        for (const group of classification.orderedSections || []) {
            if (counts.has(group.id)) tabs.push({ id: group.id, name: group.name, count: counts.get(group.id) });
        }
        bookGroupTabs.innerHTML = tabs.map(({ id, name, count }) => {
            const active = id === bookGroupByTab[activeBookTab];
            return `<button type="button" class="wbo-pill${active ? ' is-active' : ''}" data-ai-group-tab="${esc(id)}" aria-pressed="${active}">${esc(name)} <span class="wbo-pill-count">${count}</span></button>`;
        }).join('');
    };
    const applyAiFilter = () => {
        if (!(aiBookFilter instanceof HTMLInputElement)) return;
        const q = aiBookFilter.value.trim().toLowerCase();
        const group = bookGroupByTab[activeBookTab];
        let hasVisibleRow = false;
        modal.querySelectorAll('#wbo-ai-book-list .wbo-ai-pick-row').forEach((row) => {
            if (!(row instanceof HTMLElement)) return;
            const hay = row.getAttribute('data-ai-search') || '';
            row.hidden = Boolean((q && !hay.includes(q)) || (group && row.getAttribute('data-ai-group') !== group));
        });
        modal.querySelectorAll('#wbo-ai-book-list .wbo-ai-pick-section').forEach((sec) => {
            if (!(sec instanceof HTMLElement)) return;
            sec.hidden = sec.getAttribute('data-ai-section') !== activeBookTab;
            if (!sec.hidden) hasVisibleRow = Array.from(sec.querySelectorAll('.wbo-ai-pick-row')).some((row) => !row.hidden);
        });
        const empty = modal.querySelector('#wbo-ai-pick-empty');
        if (empty) empty.hidden = hasVisibleRow;
    };
    bookGroupTabs?.addEventListener('click', (ev) => {
        const pill = ev.target instanceof Element ? ev.target.closest('[data-ai-group-tab]') : null;
        if (!pill) return;
        bookGroupByTab[activeBookTab] = pill.getAttribute('data-ai-group-tab') || '';
        bookGroupTabs.querySelectorAll('[data-ai-group-tab]').forEach((button) => {
            button.classList.toggle('is-active', button === pill);
            button.setAttribute('aria-pressed', String(button === pill));
        });
        applyAiFilter();
    });
    if (aiBookFilter instanceof HTMLInputElement) {
        let composing = false;
        aiBookFilter.addEventListener('compositionstart', () => { composing = true; });
        aiBookFilter.addEventListener('compositionend', () => { composing = false; applyAiFilter(); });
        aiBookFilter.addEventListener('input', () => { if (!composing) applyAiFilter(); });
    }

    const setStatus = (msg, state = false, target = 'main') => {
        const el = target === 'preview'
            ? previewStatusEl
            : (target === 'channel' ? channelStatusEl : (target === 'external' ? externalStatusEl : statusEl));
        if (!el) return;
        const kind = state === true ? 'error' : (state === 'error' || state === 'success' ? state : 'info');
        el.textContent = msg;
        el.className = `wbo-ai-status${kind === 'error' ? ' is-error' : (kind === 'success' ? ' is-success' : '')}`;
        if (msg && kind === 'error' && el instanceof HTMLElement) {
            try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
        }
    };

    const showRefusalAlert = (parsed, target = 'main') => {
        const box = target === 'external' ? externalRefusalBox : refusalBox;
        if (!(box instanceof HTMLElement)) return;
        const snippet = parsed.refusalSnippet ? `<div class="wbo-refusal-quote">AI 回复原文：${esc(parsed.refusalSnippet)}</div>` : '';
        const uncheckBtn = sensitiveSet.size > 0
            ? `<div style="margin-top:6px;"><button type="button" class="wbo-btn" data-refusal-uncheck-sens="1">一键取消勾选疑似敏感书</button></div>`
            : '';
        box.innerHTML = `
            <div><b>AI 拒绝了本次整理请求</b></div>
            <div style="margin-top:4px;">${esc(parsed.error)}</div>
            ${snippet}
            ${uncheckBtn}
        `;
        box.hidden = false;
        box.querySelector('[data-refusal-uncheck-sens]')?.addEventListener('click', () => {
            modal.querySelectorAll('.wbo-ai-book-check').forEach((el) => {
                if (el instanceof HTMLInputElement && sensitiveSet.has(el.value)) {
                    el.checked = false;
                }
            });
            box.hidden = true;
            syncSensBannerUi();
            setStatus('已取消勾选疑似敏感世界书。', false, target);
        });
    };

    const refreshSummary = () => {
        const text = getApiSummaryText();
        if (summaryTextEl) summaryTextEl.textContent = text;
        if (tabBadgeEl) tabBadgeEl.textContent = text;
    };

    const populateChannelSelect = () => {
        if (!(channelSelect instanceof HTMLSelectElement)) return;
        if (settings.apiChannels.length === 0) {
            channelSelect.innerHTML = '<option value="">新建配置</option>';
            return;
        }
        channelSelect.innerHTML = settings.apiChannels
            .map((c) => `<option value="${esc(c.id)}"${c.id === editingChannelId ? ' selected' : ''}>${esc(c.name)}</option>`)
            .join('');
    };

    const loadChannelIntoForm = (ch) => {
        editingChannelId = ch?.id || null;
        if (nameInput instanceof HTMLInputElement) nameInput.value = ch?.name || '';
        if (urlInput instanceof HTMLInputElement) urlInput.value = ch?.baseUrl || 'https://api.openai.com/v1';
        if (keyInput instanceof HTMLInputElement) {
            keyInput.value = ch?.apiKey || '';
            keyInput.type = 'password';
        }
        if (modelInput instanceof HTMLInputElement) modelInput.value = ch?.model || '';
        populateChannelSelect();
    };

    const readFormDraft = () => ({
        name: (nameInput instanceof HTMLInputElement ? nameInput.value.trim() : '') ||
            (modelInput instanceof HTMLInputElement && modelInput.value.trim() ? modelInput.value.trim() : '自定义 API'),
        baseUrl: urlInput instanceof HTMLInputElement ? urlInput.value.trim() : '',
        apiKey: keyInput instanceof HTMLInputElement ? keyInput.value.trim() : '',
        model: modelInput instanceof HTMLInputElement ? modelInput.value.trim() : '',
    });

    populateChannelSelect();

    modal.querySelectorAll('input[name="wbo-api-provider"]').forEach((radio) => {
        radio.addEventListener('change', async () => {
            settings.apiProvider = modal.querySelector('input[name="wbo-api-provider"]:checked')?.value === 'custom' ? 'custom' : 'host';
            if (customApiBox instanceof HTMLElement) customApiBox.hidden = settings.apiProvider !== 'custom';
            refreshSummary();
            await _callbacks.onMutation({ save: true, uiOnly: true });
        });
    });

    channelSelect?.addEventListener('change', async () => {
        if (!(channelSelect instanceof HTMLSelectElement)) return;
        const found = settings.apiChannels.find((c) => c.id === channelSelect.value) || null;
        if (found) {
            settings.activeApiChannelId = found.id;
            loadChannelIntoForm(found);
            refreshSummary();
            await _callbacks.onMutation({ save: true, uiOnly: true });
        }
    });

    modal.querySelector('#wbo-ch-new-btn')?.addEventListener('click', () => {
        loadChannelIntoForm(null);
        setStatus('填写下方参数后点击「保存」创建新配置', false, 'channel');
    });

    modal.querySelector('#wbo-ch-save-btn')?.addEventListener('click', async () => {
        const draft = readFormDraft();
        if (!draft.baseUrl) {
            setStatus('请先填写 Base URL', true, 'channel');
            return;
        }
        const existing = editingChannelId ? settings.apiChannels.find((c) => c.id === editingChannelId) : null;
        if (existing) {
            Object.assign(existing, draft);
            settings.activeApiChannelId = existing.id;
        } else {
            const newCh = { id: createApiChannelId(settings.apiChannels), ...draft };
            settings.apiChannels.push(newCh);
            editingChannelId = newCh.id;
            settings.activeApiChannelId = newCh.id;
        }
        settings.apiProvider = 'custom';
        populateChannelSelect();
        refreshSummary();
        await _callbacks.onMutation({ save: true, uiOnly: true });
        setStatus(`已保存配置「${draft.name}」`, 'success', 'channel');
    });

    modal.querySelector('#wbo-ch-del-btn')?.addEventListener('click', async () => {
        if (!editingChannelId) return;
        const idx = settings.apiChannels.findIndex((c) => c.id === editingChannelId);
        if (idx < 0) return;
        const removed = settings.apiChannels.splice(idx, 1)[0];
        const next = settings.apiChannels[0] || null;
        settings.activeApiChannelId = next?.id || '';
        loadChannelIntoForm(next);
        refreshSummary();
        await _callbacks.onMutation({ save: true, uiOnly: true });
        setStatus(`已删除配置「${removed.name}」`, false, 'channel');
    });

    const formatSnapTime = (ts) => {
        if (!ts) return '';
        const dt = new Date(ts);
        return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    };

    const syncUndoButtons = () => {
        const stillHas = getUndoHistoryCount() > 0;
        for (const id of ['#wbo-ai-undo-btn', '#wbo-local-undo-btn']) {
            const btn = modal.querySelector(id);
            if (btn instanceof HTMLElement) btn.hidden = !stillHas;
        }
        for (const id of ['#wbo-ai-undo-label', '#wbo-local-undo-label']) {
            const lbl = modal.querySelector(id);
            if (lbl) lbl.textContent = getUndoButtonLabel();
        }
    };

    const openUndoHistoryPicker = () => {
        const snaps = Array.isArray(settings.undoSnapshots) ? settings.undoSnapshots : [];
        const initSnap = settings.initialSnapshot || null;
        if (snaps.length === 0 && !initSnap) return;

        const stepLabel = (idx) => (idx === 0 ? '上一次整理前' : (idx === 1 ? '上上次整理前' : `${idx + 1} 次整理前`));
        const rowsHtml = [
            ...snaps.map((s, idx) => `
                <div class="wbo-undo-row">
                    <div class="wbo-undo-info">
                        <div class="wbo-undo-title">${esc(stepLabel(idx))} <span class="wbo-tag">${esc(s.label || '整理')}</span></div>
                        <div class="wbo-undo-meta">${esc(formatSnapTime(s.at))} · ${Array.isArray(s.groups) ? s.groups.length : 0} 个分组 · 涉及 ${s.count || 0} 本</div>
                    </div>
                    <button type="button" class="wbo-btn" data-restore-target="${idx}">回退到此版本</button>
                </div>
            `),
            ...(initSnap ? [`
                <div class="wbo-undo-row is-initial">
                    <div class="wbo-undo-info">
                        <div class="wbo-undo-title">最初状态 <span class="wbo-tag">首次整理前</span></div>
                        <div class="wbo-undo-meta">${esc(formatSnapTime(initSnap.at))} · ${Array.isArray(initSnap.groups) ? initSnap.groups.length : 0} 个分组</div>
                    </div>
                    <button type="button" class="wbo-btn wbo-btn-danger" data-restore-target="initial">恢复最初</button>
                </div>
            `] : []),
        ].join('');

        const { modal: histModal } = createSubModal(
            '历史版本回退',
            `
                <div class="wbo-subtle-tip">选择任一历史节点即可回退分组、显示名与备注（不改动硬盘世界书文件）。</div>
                <div class="wbo-undo-history-list">${rowsHtml}</div>
                <div class="wbo-modal-footer">
                    <button type="button" class="wbo-btn" id="wbo-undo-hist-back">返回整理</button>
                </div>
            `,
        );

        histModal.querySelectorAll('[data-restore-target]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const raw = btn.getAttribute('data-restore-target');
                const target = raw === 'initial' ? 'initial' : Number(raw);
                const desc = target === 'initial' ? '首次整理前的最初状态' : stepLabel(target);
                if (!globalThis.confirm(`确认回退到「${desc}」？`)) return;
                if (restoreOrganizeSnapshot(settings, target)) {
                    await _callbacks.onMutation({ save: true });
                    showToast('success', `已回退到${desc}`);
                    openAiOrganizeModal({ initialTab: lastOrganizeSourceTab });
                }
            });
        });
        histModal.querySelector('#wbo-undo-hist-back')?.addEventListener('click', () => {
            openAiOrganizeModal({ initialTab: lastOrganizeSourceTab });
        });
    };

    const performUndoAction = async () => {
        if (getUndoHistoryCount() > 1 || (settings.initialSnapshot && (settings.undoSnapshots?.length || 0) === 0)) {
            openUndoHistoryPicker();
            return;
        }
        if (!undoLastAiOrganize(settings)) return;
        await _callbacks.onMutation({ save: true });
        ({ settings, classification } = _callbacks.getState());
        ({ nonCharBooks, allBooks } = buildBookPool(classification));

        const prevChecked = new Set(getSelectedBookNames());
        refreshAiBookPicker(prevChecked);
        syncUndoButtons();
        setStatus('已撤销上一次整理，恢复为整理前的分组与显示名。', 'success');
        if (localStatusEl) {
            localStatusEl.textContent = '已撤销上一次整理，恢复为整理前的分组与显示名。';
            localStatusEl.className = 'wbo-ai-status is-success';
        }
        showToast('success', '已撤销上一次整理');
    };
    modal.querySelector('#wbo-ai-undo-btn')?.addEventListener('click', performUndoAction);
    modal.querySelector('#wbo-local-undo-btn')?.addEventListener('click', performUndoAction);

    modal.querySelector('#wbo-toggle-key-btn')?.addEventListener('click', (ev) => {
        if (!(keyInput instanceof HTMLInputElement)) return;
        const show = keyInput.type === 'password';
        keyInput.type = show ? 'text' : 'password';
        const icon = ev.currentTarget?.querySelector?.('i');
        if (icon) icon.className = show ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
    });

    modal.querySelector('#wbo-fetch-models-btn')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        try {
            const draft = readFormDraft();
            setStatus('正在拉取模型列表...', false, 'channel');
            const models = await fetchCustomApiModels({ baseUrl: draft.baseUrl, apiKey: draft.apiKey });
            const datalist = modal.querySelector('#wbo-api-models-datalist');
            if (datalist) {
                datalist.innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join('');
            }
            if (modelInput instanceof HTMLInputElement && !modelInput.value.trim() && models.length > 0) {
                modelInput.value = models[0];
            }
            setStatus(`已拉取 ${models.length} 个模型`, 'success', 'channel');
        } catch (err) {
            setStatus(String(err?.message || err), true, 'channel');
        } finally {
            if (btn instanceof HTMLButtonElement) btn.disabled = false;
        }
    });

    const syncRealHint = () => {
        const isReal = modal.querySelector('input[name="wbo-ai-apply-mode"]:checked')?.value === 'real';
        const hint = modal.querySelector('#wbo-ai-real-hint');
        if (hint instanceof HTMLElement) hint.hidden = !isReal;
    };

    modal.querySelectorAll('input[name="wbo-ai-apply-mode"]').forEach((radio) => {
        radio.addEventListener('change', syncRealHint);
    });

    const getSelectedBookNames = () =>
        Array.from(modal.querySelectorAll('.wbo-ai-book-check:checked')).map((el) => el.value);

    const setCheckedByPredicate = (pred) => {
        modal.querySelectorAll('.wbo-ai-book-check').forEach((el) => {
            if (el instanceof HTMLInputElement) {
                const meta = classification.byName.get(el.value);
                el.checked = Boolean(meta && pred(meta));
            }
        });
    };

    const sensConfirmBar = modal.querySelector('#wbo-sens-confirm-bar');
    const sensConfirmText = modal.querySelector('#wbo-sens-confirm-text');
    const sensResultBar = modal.querySelector('#wbo-sens-result-bar');
    const sensResultText = modal.querySelector('#wbo-sens-result-text');
    const importPrompt = modal.querySelector('#wbo-ai-import-prompt');

    const syncImportPrompt = () => {
        if (importPrompt) importPrompt.hidden = activeBookTab !== 'sensitive' || !shouldOfferImportRules({ settings, classification });
    };

    const targetSelect = modal.querySelector('#wbo-sens-target-group');
    const sensitiveChecks = () => Array.from(modal.querySelectorAll('[data-ai-section="sensitive"] .wbo-ai-book-check'));
    const allChecks = () => Array.from(modal.querySelectorAll('.wbo-ai-book-check'));
    const newSensitiveGroup = '__new_nsfw__';
    let pendingSensitiveMove = null;

    const clearSensitiveConfirm = () => {
        pendingSensitiveMove = null;
        if (sensConfirmBar) sensConfirmBar.hidden = true;
    };

    const renderSensitiveTargets = () => {
        if (!targetSelect) return;
        const groups = settings.groups || [];
        const current = targetSelect.value;
        const recommended = findSensitiveTargetGroup(groups);
        targetSelect.innerHTML = groups
            .map((group) => '<option value="' + esc(group.id) + '">' + esc(group.name) + '</option>')
            .join('') + (recommended ? '' : '<option value="' + newSensitiveGroup + '">新建 NSFW 分组</option>');
        targetSelect.value = groups.some((group) => group.id === current) ? current : (recommended?.id || newSensitiveGroup);
    };

    const syncSensBannerUi = () => {
        const normalCount = modal.querySelectorAll('[data-ai-section="normal"] .wbo-ai-book-check').length;
        const sensChecks = sensitiveChecks();
        const tabs = modal.querySelector('#wbo-ai-book-tabs');
        if (tabs) tabs.hidden = sensChecks.length === 0;
        if (!sensChecks.length) activeBookTab = 'normal';
        for (const button of modal.querySelectorAll('[data-ai-book-tab]')) {
            const tab = button.getAttribute('data-ai-book-tab');
            const isActive = tab === activeBookTab;
            const count = tab === 'sensitive' ? sensChecks.length : normalCount;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
            const badge = button.querySelector('.wbo-pill-count');
            if (badge) badge.textContent = String(count);
        }
        const selectedCount = sensChecks.filter((box) => box.checked).length;
        const banner = modal.querySelector('#wbo-sens-banner');
        if (banner) {
            banner.hidden = sensChecks.length === 0;
            banner.classList.toggle('is-danger', selectedCount > 0);
            const text = banner.querySelector('#wbo-sens-banner-text');
            const message = selectedCount > 0 ? `${sensitiveSendWarning}。` : `${sensitiveSendWarning}，因此已默认移除选中。`;
            if (text && text.textContent !== message) text.textContent = message;
        }
        if (sensResultBar) sensResultBar.hidden = activeBookTab !== 'sensitive' || !sensResultText?.textContent;
        const actions = modal.querySelector('#wbo-ai-sensitive-actions');
        if (actions) actions.hidden = activeBookTab !== 'sensitive' || sensChecks.length === 0;
        const sensButton = modal.querySelector('#wbo-pick-toggle-sens');
        if (sensButton) sensButton.textContent = sensChecks.length && selectedCount === sensChecks.length ? '取消敏感书全选' : '全选敏感书';
        const moveButton = modal.querySelector('#wbo-sens-move-nsfw-btn');
        if (moveButton) {
            moveButton.disabled = selectedCount === 0 || !targetSelect?.value;
            moveButton.textContent = selectedCount ? '归入分组（' + selectedCount + ' 本）' : '归入分组';
        }
        const boxes = allChecks();
        const checkedCount = boxes.filter((box) => box.checked).length;
        const countLabel = modal.querySelector('#wbo-ai-selected-count');
        const countText = `已勾选 ${checkedCount} 本世界书`;
        if (countLabel && countLabel.textContent !== countText) countLabel.textContent = countText;
        const toggleAllButton = modal.querySelector('#wbo-pick-none');
        if (toggleAllButton) {
            toggleAllButton.textContent = boxes.length && checkedCount === boxes.length ? '取消全选' : '全选';
            toggleAllButton.disabled = boxes.length === 0;
        }
    };

    const refreshAiBookPicker = (checked) => {
        const list = modal.querySelector('#wbo-ai-book-list');
        if (list) list.innerHTML = renderAiBookListHtml(checked, analyzeSensitiveOrganizeState({ allBooks }));
        renderSensitiveTargets();
        syncSensBannerUi();
        syncImportPrompt();
        renderBookGroupTabs();
        applyAiFilter();
        const ungroupedCntEl = modal.querySelector('[data-local-scope-count="ungrouped"]');
        const noncharCntEl = modal.querySelector('[data-local-scope-count="nonchar"]');
        if (ungroupedCntEl) ungroupedCntEl.textContent = `${classification.ungroupedBooks.length} 本`;
        if (noncharCntEl) noncharCntEl.textContent = `${classification.nonCharCount} 本`;
    };

    const showSensitiveMoveConfirmation = () => {
        const books = sensitiveChecks().filter((box) => box.checked).map((box) => box.value);
        const targetId = targetSelect?.value;
        const target = settings.groups.find((group) => group.id === targetId);
        if (!books.length || (!target && targetId !== newSensitiveGroup)) return;
        const name = target?.name || 'NSFW';
        const preview = books.slice(0, 3).map((book) => '「' + (classification.byName.get(book)?.displayName || book) + '」').join('、');
        const remaining = books.length > 3 ? ' 等 ' + books.length + ' 本' : '';
        pendingSensitiveMove = { books, targetId, name };
        sensConfirmText.textContent = '将 ' + preview + remaining + ' 归入' + (target ? '「' + name + '」' : '新建分组「NSFW」') + '？';
        sensConfirmBar.hidden = false;
    };

    const applySensitiveMove = async () => {
        const pending = pendingSensitiveMove;
        clearSensitiveConfirm();
        if (!pending) return;
        ({ settings, classification } = _callbacks.getState());
        const { books, targetId, name } = pending;
        if (targetId !== newSensitiveGroup && !settings.groups.some((group) => group.id === targetId && group.name === name)) {
            renderSensitiveTargets();
            syncSensBannerUi();
            setStatus('分组已变化，请重新选择。', 'error');
            return;
        }
        const targets = books.filter((book) => classification.byName.has(book));
        const checked = new Set(getSelectedBookNames());
        const result = moveBooksToNamedGroup(settings, targets, name, {
            targetGroupId: targetId === newSensitiveGroup ? null : targetId,
            label: '归入「' + name + '」',
            isCharBoundFn: (book) => Boolean(classification.byName.get(book)?.isCharBound),
        });
        if (!result.movedCount) {
            setStatus('所选世界书已在该分组，或已不存在。');
            return;
        }
        for (const book of targets) checked.delete(book);
        await _callbacks.onMutation({ save: true });
        ({ settings, classification } = _callbacks.getState());
        ({ nonCharBooks, allBooks } = buildBookPool(classification));
        refreshAiBookPicker(checked);
        syncUndoButtons();
        const message = '已将 ' + result.movedCount + ' 本疑似敏感世界书归入「' + result.groupName + '」';
        if (sensResultText && sensResultBar) {
            sensResultText.textContent = message;
            modal.querySelector('#wbo-sens-inline-undo').hidden = false;
            sensResultBar.hidden = false;
        }
        setStatus(message, 'success');
    };

    const handleSelectionChange = () => {
        clearSensitiveConfirm();
        syncSensBannerUi();
    };
    modal.querySelector('#wbo-ai-book-list')?.addEventListener('change', handleSelectionChange);
    targetSelect?.addEventListener('change', handleSelectionChange);
    modal.querySelector('#wbo-ai-book-tabs')?.addEventListener('click', (ev) => {
        const button = ev.target instanceof Element ? ev.target.closest('[data-ai-book-tab]') : null;
        if (!button) return;
        activeBookTab = button.getAttribute('data-ai-book-tab');
        handleSelectionChange();
        syncImportPrompt();
        renderBookGroupTabs();
        applyAiFilter();
    });
    importPrompt?.querySelector('[data-open-import-rules-intro]')?.addEventListener('click', () => {
        openImportRulesModal({
            intro: true,
            stack: true,
            onResolved: () => {
                if (!modal.isConnected) return;
                ({ settings, classification } = _callbacks.getState());
                ({ nonCharBooks, allBooks } = buildBookPool(classification));
                refreshAiBookPicker(new Set(getSelectedBookNames()));
            },
        });
    });
    importPrompt?.querySelector('[data-skip-import-rules-intro]')?.addEventListener('click', () => {
        void dismissImportRulesIntro();
        syncImportPrompt();
    });
    modal.querySelector('#wbo-sens-move-nsfw-btn')?.addEventListener('click', showSensitiveMoveConfirmation);
    modal.querySelector('#wbo-sens-confirm-ok')?.addEventListener('click', () => { void applySensitiveMove(); });
    modal.querySelector('#wbo-sens-confirm-cancel')?.addEventListener('click', clearSensitiveConfirm);
    modal.querySelector('#wbo-sens-inline-undo')?.addEventListener('click', async () => {
        if (!undoLastAiOrganize(settings)) return;
        await _callbacks.onMutation({ save: true });
        ({ settings, classification } = _callbacks.getState());
        ({ nonCharBooks, allBooks } = buildBookPool(classification));
        refreshAiBookPicker(new Set(getSelectedBookNames()));
        syncUndoButtons();
        if (sensResultText && sensResultBar) {
            sensResultText.textContent = '已撤回归组。';
            modal.querySelector('#wbo-sens-inline-undo').hidden = true;
        }
        setStatus('已撤回归组。', 'success');
    });

    modal.querySelector('#wbo-pick-ungrouped')?.addEventListener('click', () => {
        settings.aiOrganizeScope = 'ungrouped';
        void _callbacks?.onMutation({ save: true, uiOnly: true });
        setCheckedByPredicate((meta) => meta.groupId === SPECIAL_GROUPS.UNGROUPED && !sensitiveSet.has(meta.realName));
        handleSelectionChange();
    });
    modal.querySelector('#wbo-pick-nonchar')?.addEventListener('click', () => {
        settings.aiOrganizeScope = 'nonchar';
        void _callbacks?.onMutation({ save: true, uiOnly: true });
        setCheckedByPredicate((meta) => !meta.isInCharGroup && !sensitiveSet.has(meta.realName));
        handleSelectionChange();
    });
    const toggleChecks = (boxes) => {
        const next = !boxes.every((box) => box.checked);
        for (const box of boxes) box.checked = next;
        handleSelectionChange();
    };
    modal.querySelector('#wbo-pick-toggle-sens')?.addEventListener('click', () => toggleChecks(sensitiveChecks()));
    modal.querySelector('#wbo-pick-none')?.addEventListener('click', () => toggleChecks(allChecks()));
    renderSensitiveTargets();
    syncSensBannerUi();
    syncImportPrompt();
    renderBookGroupTabs();
    applyAiFilter();

    /** @type {Map<string, string[]>} */
    const cachedCluesByBook = new Map();

    const buildCustomInstruction = () => {
        const allowRealRename = Boolean(modal.querySelector('#wbo-ai-allow-real-rename')?.checked);
        const customRule = modal.querySelector('#wbo-ai-custom-rule')?.value?.trim() || '';
        const filenameRule = allowRealRename
            ? '建议的新名称将直接作为规范化的世界书文件名，请勿包含 \\ / : * ? " < > | 等非法文件名字符。'
            : '';
        return [customRule, filenameRule].filter(Boolean).join(' ');
    };

    const preparePromptPayload = async ({ targetNames = null, feedback = null, statusTarget = 'main' } = {}) => {
        if (refusalBox instanceof HTMLElement) refusalBox.hidden = true;
        const selectedNames = Array.isArray(targetNames) ? targetNames : getSelectedBookNames();
        if (selectedNames.length === 0) {
            setStatus('请至少勾选一本世界书', true, statusTarget);
            return null;
        }
        const includeClues = Boolean(modal.querySelector('#wbo-ai-include-clues')?.checked);
        const clueCountRaw = Number(modal.querySelector('#wbo-ai-clue-count')?.value || 5);
        const clueCount = Math.max(1, Math.min(15, Number.isFinite(clueCountRaw) ? Math.round(clueCountRaw) : 5));
        const snippetLenRaw = Number(modal.querySelector('#wbo-ai-snippet-len')?.value ?? 50);
        const snippetChars = Number.isFinite(snippetLenRaw) ? Math.max(0, Math.min(200, snippetLenRaw)) : 50;

        const clueStats = { skippedEntries: 0 };
        const booksPayload = [];
        for (let i = 0; i < selectedNames.length; i += 1) {
            const name = selectedNames[i];
            const meta = classification.byName.get(name);
            let sampleEntries = [];
            if (includeClues) {
                if (feedback && cachedCluesByBook.has(name)) {
                    sampleEntries = cachedCluesByBook.get(name) || [];
                } else {
                    setStatus(`读取条目摘要 (${i + 1}/${selectedNames.length})...`, false, statusTarget);
                    sampleEntries = await fetchWorldbookCluesOnDemand(name, clueCount, {
                        snippetChars,
                        filterSensitive: true,
                        statsOut: clueStats,
                    });
                    cachedCluesByBook.set(name, sampleEntries);
                }
            }
            booksPayload.push({
                realName: name,
                currentAlias: meta?.alias || '',
                currentGroup: meta?.groupName || '',
                sampleEntries,
            });
        }

        if (clueStats.skippedEntries > 0) {
            setStatus(`已自动过滤 ${clueStats.skippedEntries} 条疑似含敏感词的条目摘要，正在准备请求...`, false, statusTarget);
        }

        return buildAiOrganizePrompt({
            books: booksPayload,
            existingGroups: settings.groups.map((g) => g.name),
            customInstruction: buildCustomInstruction(),
            presetsPool: getEffectiveAiOrganizePresets(settings).all,
            feedback,
        });
    };

    /** @type {Array<{ realName: string, alias: string, group: string, note: string, selected: boolean, redo: boolean, editing: boolean }>} */
    let currentProposals = [];
    let activePreviewGroupFilter = '__all__';
    let previewFromLocal = false;

    const previewPillsEl = modal.querySelector('#wbo-preview-group-pills');
    const previewSelCountEl = modal.querySelector('#wbo-preview-sel-count');
    const previewGroupsDatalist = modal.querySelector('#wbo-preview-groups-datalist');
    const previewApplyModeRow = modal.querySelector('#wbo-preview-apply-mode-row');
    const previewRedoDetails = modal.querySelector('#wbo-preview-redo-details');
    const redoSummaryEl = modal.querySelector('#wbo-redo-summary');
    const redoChipsEl = modal.querySelector('#wbo-redo-group-chips');
    const redoClearBtn = modal.querySelector('#wbo-redo-clear-btn');
    const redoRunBtn = modal.querySelector('#wbo-ai-redo-run-btn');
    const redoCopyBtn = modal.querySelector('#wbo-ai-redo-copy-btn');
    const redoPasteBox = modal.querySelector('#wbo-redo-paste-box');
    const redoReasonInput = modal.querySelector('#wbo-ai-redo-reason');

    const getOrderedPreviewGroups = () => {
        /** @type {Map<string, Array<{ item: any, idx: number }>>} */
        const map = new Map();
        currentProposals.forEach((item, idx) => {
            const gname = (item.group || '').trim() || '未分组';
            if (!map.has(gname)) map.set(gname, []);
            map.get(gname).push({ item, idx });
        });
        return map;
    };

    const syncRedoBarUi = () => {
        if (previewRedoDetails instanceof HTMLElement) {
            previewRedoDetails.hidden = previewFromLocal;
        }
        if (previewFromLocal) return;
        const grouped = getOrderedPreviewGroups();
        const redoItems = currentProposals.filter((p) => p.redo);
        const count = redoItems.length;
        if (redoSummaryEl) {
            redoSummaryEl.textContent = count > 0
                ? `已选 ${count} 本待 AI 重新分组`
                : '不满意部分分组？点此选组让 AI 重排';
        }
        if (redoChipsEl) {
            redoChipsEl.innerHTML = [...grouped.entries()].map(([gname, entries]) => {
                const selectedInGroup = entries.filter((e) => e.item.redo).length;
                const isAll = selectedInGroup === entries.length && entries.length > 0;
                const isPartial = selectedInGroup > 0 && selectedInGroup < entries.length;
                const countLabel = isPartial ? `${selectedInGroup}/${entries.length}` : `${entries.length}`;
                return `
                    <button type="button"
                        class="wbo-redo-chip${isAll ? ' is-active' : (isPartial ? ' is-partial' : '')}"
                        data-redo-group-chip="${esc(gname)}">
                        <span>${esc(gname)}</span><small>${esc(countLabel)}</small>
                    </button>
                `;
            }).join('');
        }
        if (redoClearBtn instanceof HTMLElement) redoClearBtn.hidden = count === 0;
        if (redoRunBtn instanceof HTMLButtonElement) redoRunBtn.disabled = count === 0;
        if (redoCopyBtn instanceof HTMLButtonElement) redoCopyBtn.disabled = count === 0;
    };

    const syncPreviewSelectCount = () => {
        const selectedCount = currentProposals.filter((p) => p.selected).length;
        if (previewSelCountEl) {
            previewSelCountEl.textContent = `已选 ${selectedCount}/${currentProposals.length}`;
        }
        const toggleBtn = modal.querySelector('#wbo-preview-toggle-all');
        if (toggleBtn) {
            const allSelected = currentProposals.length > 0 && selectedCount === currentProposals.length;
            toggleBtn.textContent = allSelected ? '取消全选' : '全选全部';
        }
        const clearNotesBtn = modal.querySelector('#wbo-preview-clear-notes');
        if (clearNotesBtn instanceof HTMLElement) {
            clearNotesBtn.hidden = !currentProposals.some((p) => (p.note || '').trim().length > 0);
        }
    };

    const renderPreviewContent = () => {
        if (!previewList) return;
        const grouped = getOrderedPreviewGroups();
        const groupNames = [...grouped.keys()];
        const allGroupChoices = [...new Set([...groupNames, ...settings.groups.map((g) => g.name), '未分组'])];

        if (activePreviewGroupFilter !== '__all__' && !grouped.has(activePreviewGroupFilter)) {
            activePreviewGroupFilter = '__all__';
        }

        if (previewGroupsDatalist) {
            previewGroupsDatalist.innerHTML = allGroupChoices.map((g) => `<option value="${esc(g)}"></option>`).join('');
        }

        if (previewPillsEl) {
            const pills = [
                { key: '__all__', label: `全部 ${currentProposals.length}` },
                ...groupNames.map((g) => ({ key: g, label: `${g} ${grouped.get(g).length}` })),
            ];
            previewPillsEl.innerHTML = pills
                .map((p) => `
                    <button type="button"
                        class="wbo-pill${activePreviewGroupFilter === p.key ? ' is-active' : ''}"
                        data-preview-filter="${esc(p.key)}">
                        <span>${esc(p.label)}</span>
                    </button>
                `)
                .join('');
        }

        const sectionsToRender = activePreviewGroupFilter === '__all__'
            ? groupNames
            : [activePreviewGroupFilter];

        const prevScroll = previewList.scrollTop;
        previewList.innerHTML = sectionsToRender.map((gname) => {
            const entries = grouped.get(gname) || [];
            const selInGroup = entries.filter((e) => e.item.selected).length;
            const allSel = entries.length > 0 && selInGroup === entries.length;
            const rowsHtml = entries.map(({ item, idx }) => {
                const curGroup = (item.group || '').trim() || '未分组';
                const renamed = Boolean(item.alias && item.alias !== item.realName);
                const titleHtml = renamed
                    ? `<span class="wbo-prop-name-new">${esc(item.alias)}</span><span class="wbo-prop-name-old" title="${esc(item.realName)}">${esc(item.realName)}</span>`
                    : `<span class="wbo-prop-name-new" title="${esc(item.realName)}">${esc(item.realName)}</span>`;
                const noteHint = item.note ? `<div class="wbo-prop-note-sub">${esc(item.note)}</div>` : '';
                const groupOptsHtml = allGroupChoices
                    .map((gc) => `<option value="${esc(gc)}"${gc === curGroup ? ' selected' : ''}>${esc(gc)}</option>`)
                    .join('') + '<option value="__new__">+ 新建分组...</option>';

                const editBlockHtml = item.editing
                    ? `
                        <div class="wbo-prop-edit-drawer">
                            <label class="wbo-prop-field">
                                <span class="wbo-prop-label">新名称</span>
                                <input type="text" class="wbo-input wbo-prop-alias" value="${esc(item.alias)}" placeholder="规范后的显示名" spellcheck="false">
                            </label>
                            <label class="wbo-prop-field">
                                <span class="wbo-prop-label">说明</span>
                                <input type="text" class="wbo-input wbo-prop-note" value="${esc(item.note)}" placeholder="可选：一句话用途说明" spellcheck="false">
                            </label>
                        </div>
                    `
                    : '';

                return `
                    <div class="wbo-ai-prop-row is-compact${item.redo ? ' is-redo' : ''}" data-idx="${idx}">
                        <div class="wbo-prop-compact-line">
                            <label class="wbo-ai-prop-check" title="勾选以应用此项">
                                <input type="checkbox" class="wbo-prop-selected"${item.selected ? ' checked' : ''}>
                            </label>
                            <div class="wbo-prop-compact-text">
                                <div class="wbo-prop-compact-title">${titleHtml}</div>
                                ${noteHint}
                            </div>
                            <select class="wbo-select wbo-prop-group-select" title="快速更换分组">${groupOptsHtml}</select>
                            <button type="button" class="wbo-icon-btn wbo-prop-edit-btn${item.editing ? ' is-active' : ''}" data-action="toggle-edit-item" data-idx="${idx}" title="微调名称或说明">
                                <i class="fa-solid fa-pen"></i>
                            </button>
                        </div>
                        ${editBlockHtml}
                    </div>
                `;
            }).join('');

            const mergeTargetOpts = allGroupChoices
                .filter((gc) => gc !== gname)
                .map((gc) => `<option value="${esc(gc)}">${esc(gc)}</option>`)
                .join('') + '<option value="__new__">+ 新建分组...</option>';

            return `
                <div class="wbo-preview-group-sec" data-preview-group="${esc(gname)}">
                    <div class="wbo-preview-group-head">
                        <label class="wbo-preview-group-select-label" title="全选或取消本组">
                            <input type="checkbox" class="wbo-preview-group-check" data-group-name="${esc(gname)}"${allSel ? ' checked' : ''}>
                            <span class="wbo-preview-group-title">${esc(gname)} <small>${selInGroup}/${entries.length}</small></span>
                        </label>
                        <div class="wbo-preview-group-actions">
                            ${gname !== '未分组' ? `<button type="button" class="wbo-link-btn" data-action="rename-preview-group" data-group-name="${esc(gname)}" title="重命名此分组">改组名</button>` : ''}
                            <select class="wbo-select wbo-preview-merge-select" data-merge-from="${esc(gname)}" title="将本组全部世界书归入另一个分组">
                                <option value="" selected>整组归入...</option>
                                ${mergeTargetOpts}
                            </select>
                        </div>
                    </div>
                    <div class="wbo-preview-group-body">${rowsHtml}</div>
                </div>
            `;
        }).join('');

        previewList.querySelectorAll('.wbo-preview-group-check').forEach((cb) => {
            if (!(cb instanceof HTMLInputElement)) return;
            const gname = cb.getAttribute('data-group-name') || '';
            const entries = grouped.get(gname) || [];
            const selInGroup = entries.filter((e) => e.item.selected).length;
            cb.indeterminate = selInGroup > 0 && selInGroup < entries.length;
        });

        previewList.scrollTop = prevScroll;
        syncPreviewSelectCount();
        syncRedoBarUi();
    };

    const showPreview = (proposals, ignoredCount, { fromLocal = false } = {}) => {
        previewFromLocal = Boolean(fromLocal);
        currentProposals = proposals.map((p) => ({
            ...p,
            selected: true,
            redo: false,
            editing: false,
        }));
        activePreviewGroupFilter = '__all__';
        if (!previewList || !(stepSelect instanceof HTMLElement) || !(stepPreview instanceof HTMLElement)) return;
        if (redoPasteBox instanceof HTMLElement) redoPasteBox.hidden = true;
        if (previewRedoDetails instanceof HTMLDetailsElement) previewRedoDetails.open = false;

        // Hide rename-mode radios for pure local grouping when no names changed
        const hasAnyRename = currentProposals.some((p) => p.alias && p.alias !== p.realName);
        if (previewApplyModeRow instanceof HTMLElement) {
            previewApplyModeRow.hidden = previewFromLocal && !hasAnyRename;
        }

        const allowReal = !previewFromLocal && Boolean(modal.querySelector('#wbo-ai-allow-real-rename')?.checked);
        const targetRadio = modal.querySelector(`input[name="wbo-ai-apply-mode"][value="${allowReal ? 'real' : 'alias'}"]`);
        if (targetRadio instanceof HTMLInputElement) targetRadio.checked = true;
        syncRealHint();

        renderPreviewContent();

        if (stepLocal instanceof HTMLElement) stepLocal.hidden = true;
        stepSelect.hidden = true;
        if (stepExternal instanceof HTMLElement) stepExternal.hidden = true;
        if (stepApi instanceof HTMLElement) stepApi.hidden = true;
        if (stepPresets instanceof HTMLElement) stepPresets.hidden = true;
        if (tabsBar instanceof HTMLElement) tabsBar.hidden = true;
        stepPreview.hidden = false;
        const groupCount = getOrderedPreviewGroups().size;
        setStatus(
            `解析完成：共 ${proposals.length} 本世界书，分为 ${groupCount} 组${ignoredCount > 0 ? `（忽略 ${ignoredCount} 项无效条目）` : ''}`,
            'success',
            'preview',
        );
    };

    // Delegate preview group filter pill clicks
    previewPillsEl?.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-preview-filter]') : null;
        if (!btn) return;
        activePreviewGroupFilter = btn.getAttribute('data-preview-filter') || '__all__';
        renderPreviewContent();
    });

    // Sync live edits & redo marks directly onto `currentProposals` so switching group tabs never loses changes
    previewList?.addEventListener('input', (ev) => {
        const target = ev.target;
        if (!(target instanceof HTMLInputElement)) return;
        const row = target.closest('.wbo-ai-prop-row[data-idx]');
        if (!row) return;
        const idx = Number(row.getAttribute('data-idx'));
        const item = currentProposals[idx];
        if (!item) return;
        if (target.classList.contains('wbo-prop-alias')) item.alias = target.value;
        else if (target.classList.contains('wbo-prop-group')) item.group = target.value;
        else if (target.classList.contains('wbo-prop-note')) item.note = target.value;
    });

    // Preview single smart select-all / clear-all toggle
    modal.querySelector('#wbo-preview-toggle-all')?.addEventListener('click', () => {
        const allSelected = currentProposals.length > 0 && currentProposals.every((p) => p.selected);
        currentProposals.forEach((p) => { p.selected = !allSelected; });
        renderPreviewContent();
    });
    modal.querySelector('#wbo-preview-clear-notes')?.addEventListener('click', () => {
        currentProposals.forEach((p) => { p.note = ''; });
        renderPreviewContent();
    });

    // Direct 1-click group redo chips inside the bottom feedback card
    redoChipsEl?.addEventListener('click', (ev) => {
        const chip = ev.target instanceof Element ? ev.target.closest('[data-redo-group-chip]') : null;
        if (!chip) return;
        const gname = chip.getAttribute('data-redo-group-chip') || '';
        const matching = currentProposals.filter((p) => ((p.group || '').trim() || '未分组') === gname);
        if (matching.length === 0) return;
        const nextState = !matching.every((p) => p.redo);
        matching.forEach((p) => { p.redo = nextState; });
        renderPreviewContent();
    });

    previewList?.addEventListener('change', async (ev) => {
        const target = ev.target;
        if (target instanceof HTMLSelectElement && target.classList.contains('wbo-preview-merge-select')) {
            const fromGroup = target.getAttribute('data-merge-from') || '';
            let destGroup = target.value;
            if (!fromGroup || !destGroup) return;
            if (destGroup === '__new__') {
                const customName = await openInlineTextPrompt({
                    title: '整组归入新分组',
                    label: `将「${fromGroup}」整组归入新分组`,
                    placeholder: '输入新分组名',
                    confirmText: '确定',
                });
                if (!customName) {
                    target.value = '';
                    return;
                }
                destGroup = customName;
            }
            let moved = 0;
            currentProposals.forEach((p) => {
                if (((p.group || '').trim() || '未分组') === fromGroup) {
                    p.group = destGroup;
                    moved += 1;
                }
            });
            if (activePreviewGroupFilter === fromGroup) {
                activePreviewGroupFilter = destGroup;
            }
            renderPreviewContent();
            setStatus(`已将「${fromGroup}」的 ${moved} 本世界书全部归入「${destGroup}」`, 'success', 'preview');
            return;
        }
        if (target instanceof HTMLSelectElement && target.classList.contains('wbo-prop-group-select')) {
            const row = target.closest('.wbo-ai-prop-row[data-idx]');
            if (!row) return;
            const idx = Number(row.getAttribute('data-idx'));
            const item = currentProposals[idx];
            if (!item) return;
            if (target.value === '__new__') {
                const customName = await openInlineTextPrompt({
                    title: '新建分组',
                    label: '新分组名称',
                    placeholder: '输入新分组名称',
                    confirmText: '确定',
                });
                if (customName) item.group = customName;
            } else {
                item.group = target.value;
            }
            renderPreviewContent();
            return;
        }
        if (!(target instanceof HTMLInputElement)) return;
        if (target.classList.contains('wbo-preview-group-check')) {
            const gname = target.getAttribute('data-group-name') || '';
            const nextChecked = target.checked;
            currentProposals.forEach((p) => {
                if (((p.group || '').trim() || '未分组') === gname) {
                    p.selected = nextChecked;
                }
            });
            renderPreviewContent();
            return;
        }
        const row = target.closest('.wbo-ai-prop-row[data-idx]');
        if (!row) return;
        const idx = Number(row.getAttribute('data-idx'));
        const item = currentProposals[idx];
        if (!item) return;
        if (target.classList.contains('wbo-prop-selected')) {
            item.selected = target.checked;
            renderPreviewContent();
        } else if (target.classList.contains('wbo-prop-group')) {
            item.group = target.value.trim();
            renderPreviewContent();
        }
    });

    previewList?.addEventListener('click', async (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-action]') : null;
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        if (action === 'rename-preview-group') {
            const oldName = btn.getAttribute('data-group-name') || '';
            if (!oldName) return;
            const nextName = await openInlineTextPrompt({
                title: '修改分组名称',
                label: `将分组「${oldName}」改名为`,
                initialValue: oldName,
                placeholder: '输入新分组名称',
                confirmText: '确定',
            });
            if (!nextName || nextName === oldName) return;
            let changed = 0;
            currentProposals.forEach((p) => {
                if (((p.group || '').trim() || '未分组') === oldName) {
                    p.group = nextName;
                    changed += 1;
                }
            });
            if (activePreviewGroupFilter === oldName) {
                activePreviewGroupFilter = nextName;
            }
            renderPreviewContent();
            setStatus(`已将分组「${oldName}」改名为「${nextName}」（共 ${changed} 本）`, 'success', 'preview');
        } else if (action === 'toggle-edit-item') {
            const idx = Number(btn.getAttribute('data-idx'));
            if (currentProposals[idx]) {
                currentProposals[idx].editing = !currentProposals[idx].editing;
                renderPreviewContent();
            }
        } else if (action === 'toggle-redo-item') {
            const idx = Number(btn.getAttribute('data-idx'));
            if (currentProposals[idx]) {
                currentProposals[idx].redo = !currentProposals[idx].redo;
                renderPreviewContent();
            }
        } else if (action === 'toggle-redo-group') {
            const gname = btn.getAttribute('data-group-name') || '';
            const matching = currentProposals.filter((p) => ((p.group || '').trim() || '未分组') === gname);
            const nextState = !matching.every((p) => p.redo);
            matching.forEach((p) => { p.redo = nextState; });
            renderPreviewContent();
        }
    });

    redoClearBtn?.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        currentProposals.forEach((p) => { p.redo = false; });
        renderPreviewContent();
    });

    const mergeRedoResponseIntoPreview = (rawText) => {
        const redoItems = currentProposals.filter((p) => p.redo);
        const validRedoNames = new Set(redoItems.map((p) => p.realName));
        const parsed = parseAiOrganizeResponse(rawText, validRedoNames.size > 0 ? validRedoNames : new Set(classification.byName.keys()));
        if (!parsed.ok) {
            setStatus(parsed.error || '重排结果解析失败', true, 'preview');
            return false;
        }
        const byName = new Map(currentProposals.map((p) => [p.realName, p]));
        let updatedCount = 0;
        for (const nextItem of parsed.proposals) {
            const target = byName.get(nextItem.realName);
            if (!target) continue;
            if (nextItem.alias) target.alias = nextItem.alias;
            if (nextItem.group) target.group = nextItem.group;
            if (nextItem.note) target.note = nextItem.note;
            target.redo = false;
            updatedCount += 1;
        }
        if (redoPasteBox instanceof HTMLElement) redoPasteBox.hidden = true;
        renderPreviewContent();
        setStatus(`已根据反馈更新 ${updatedCount} 本世界书的分组与名称`, false, 'preview');
        showToast('success', `已更新 ${updatedCount} 本世界书的分组建议`);
        return true;
    };

    const prepareRedoPromptPayload = async () => {
        const redoItems = currentProposals.filter((p) => p.redo);
        if (redoItems.length === 0) {
            setStatus('请先标记至少一本需要重新分组的世界书', true, 'preview');
            return null;
        }
        const acceptedGroups = [...new Set(
            currentProposals
                .filter((p) => !p.redo)
                .map((p) => (p.group || '').trim())
                .filter((g) => g && g !== '未分组'),
        )];
        const reason = (redoReasonInput instanceof HTMLTextAreaElement || redoReasonInput instanceof HTMLInputElement)
            ? redoReasonInput.value.trim()
            : '';
        return preparePromptPayload({
            targetNames: redoItems.map((p) => p.realName),
            feedback: {
                reason,
                previousProposals: redoItems.map((p) => ({
                    realName: p.realName,
                    alias: p.alias,
                    group: p.group,
                    note: p.note,
                })),
                acceptedGroups,
            },
            statusTarget: 'preview',
        });
    };

    redoRunBtn?.addEventListener('click', async () => {
        if (redoRunBtn instanceof HTMLButtonElement) redoRunBtn.disabled = true;
        try {
            const prompts = await prepareRedoPromptPayload();
            if (!prompts) return;
            if (settings.apiProvider === 'custom') {
                const draft = readFormDraft();
                setStatus('正在将不满意项重新发送给自定义 API...', false, 'preview');
                const raw = await callCustomApiForOrganize({
                    baseUrl: draft.baseUrl,
                    apiKey: draft.apiKey,
                    model: draft.model,
                    systemPrompt: prompts.systemPrompt,
                    userPrompt: prompts.userPrompt,
                });
                mergeRedoResponseIntoPreview(raw);
            } else {
                setStatus('正在将不满意项重新发送给酒馆当前 API...', false, 'preview');
                const raw = await callHostAiForOrganize(prompts);
                mergeRedoResponseIntoPreview(raw);
            }
        } catch (err) {
            setStatus(`重排调用失败：${err?.message || err}`, true, 'preview');
        } finally {
            syncRedoBarUi();
        }
    });

    redoCopyBtn?.addEventListener('click', async () => {
        const prompts = await prepareRedoPromptPayload();
        if (!prompts) return;
        const fullPrompt = `${prompts.systemPrompt}\n\n---\n\n${prompts.userPrompt}`;
        if (redoPasteBox instanceof HTMLElement) redoPasteBox.hidden = false;
        try {
            await navigator.clipboard.writeText(fullPrompt);
            setStatus('已复制重排提示词，请将外部 AI 返回的 JSON 粘贴到下方合并。', false, 'preview');
        } catch {
            const ta = modal.querySelector('#wbo-ai-redo-json-input');
            if (ta instanceof HTMLTextAreaElement) {
                ta.value = fullPrompt;
                ta.select();
            }
            setStatus('剪贴板受限，已将重排提示词填入下方文本框。', false, 'preview');
        }
    });

    modal.querySelector('#wbo-ai-redo-merge-btn')?.addEventListener('click', () => {
        const ta = modal.querySelector('#wbo-ai-redo-json-input');
        const raw = ta instanceof HTMLTextAreaElement ? ta.value : '';
        if (mergeRedoResponseIntoPreview(raw) && ta instanceof HTMLTextAreaElement) {
            ta.value = '';
        }
    });

    const parseAndOpenPreview = (rawText, statusTarget = 'main') => {
        const validSet = new Set(classification.byName.keys());
        const parsed = parseAiOrganizeResponse(rawText, validSet);
        const box = statusTarget === 'external' ? externalRefusalBox : refusalBox;
        if (!parsed.ok) {
            if (parsed.isRefusal) {
                showRefusalAlert(parsed, statusTarget);
                setStatus('', false, statusTarget);
            } else {
                if (box instanceof HTMLElement) box.hidden = true;
                setStatus(parsed.error || '解析失败', true, statusTarget);
            }
            return;
        }
        if (box instanceof HTMLElement) box.hidden = true;
        setStatus('', false, statusTarget);
        showPreview(parsed.proposals, parsed.ignoredCount);
    };

    modal.querySelector('#wbo-ai-run-btn')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        try {
            const prompts = await preparePromptPayload();
            if (!prompts) return;
            if (settings.apiProvider === 'custom') {
                const draft = readFormDraft();
                setStatus('正在调用自定义 API...');
                const raw = await callCustomApiForOrganize({
                    baseUrl: draft.baseUrl,
                    apiKey: draft.apiKey,
                    model: draft.model,
                    systemPrompt: prompts.systemPrompt,
                    userPrompt: prompts.userPrompt,
                });
                parseAndOpenPreview(raw);
            } else {
                setStatus('正在调用酒馆当前 API...');
                const raw = await callHostAiForOrganize(prompts);
                parseAndOpenPreview(raw);
            }
        } catch (err) {
            const msg = `调用失败：${err?.message || err}`;
            setStatus(msg, 'error');
            showToast('error', msg);
        } finally {
            if (btn instanceof HTMLButtonElement) btn.disabled = false;
        }
    });

    modal.querySelector('#wbo-ai-copy-prompt-btn')?.addEventListener('click', async () => {
        const prompts = await preparePromptPayload({ statusTarget: 'external' });
        if (!prompts) return;
        const fullPrompt = `${prompts.systemPrompt}\n\n---\n\n${prompts.userPrompt}`;
        try {
            await navigator.clipboard.writeText(fullPrompt);
            setStatus('已复制提示词，可将外部 AI 返回的 JSON 粘贴到上方输入框后点「解析并预览」。', 'success', 'external');
        } catch {
            const textarea = modal.querySelector('#wbo-ai-json-input');
            if (textarea instanceof HTMLTextAreaElement) {
                textarea.value = fullPrompt;
                textarea.select();
            }
            setStatus('剪贴板受限，已将提示词填入输入框。', false, 'external');
        }
    });

    modal.querySelector('#wbo-ai-parse-paste-btn')?.addEventListener('click', () => {
        const raw = modal.querySelector('#wbo-ai-json-input')?.value || '';
        parseAndOpenPreview(raw, 'external');
    });

    modal.querySelector('#wbo-ai-back-btn')?.addEventListener('click', () => {
        switchAiTab(lastOrganizeSourceTab);
    });

    modal.querySelector('#wbo-ai-cancel-btn')?.addEventListener('click', closeSubModal);

    const applyProgressBox = modal.querySelector('#wbo-apply-progress-box');
    const applyCancelBtn = modal.querySelector('#wbo-ai-cancel-btn');

    const rollbackRealRenames = async (completedRenames, preSnapshot, activeLiveNamesSet = null) => {
        if (applyProgressBox instanceof HTMLElement) {
            applyProgressBox.hidden = false;
            applyProgressBox.innerHTML = `<div class="wbo-progress-head"><span>正在撤回已修改的 ${completedRenames.length} 本世界书，请稍候...</span></div>`;
        }
        const liveNames = activeLiveNamesSet instanceof Set ? activeLiveNamesSet : new Set(getWorldNames());
        let rolledBack = 0;
        const rolledBackPairs = [];
        const unrolledPairs = [];
        const rollbackErrors = [];
        for (let i = completedRenames.length - 1; i >= 0; i -= 1) {
            const pair = completedRenames[i];
            const res = await realRenameWorldbook(pair.newName, pair.oldName, settings, {
                deferRefresh: true,
                existingNamesSet: liveNames,
            });
            if (res.ok) {
                rolledBack += 1;
                rolledBackPairs.push(pair);
            } else {
                unrolledPairs.push(pair);
                rollbackErrors.push(`${pair.newName} → ${pair.oldName}：${res.error || '未知错误'}`);
            }
        }
        discardPendingRenamedEventsForRollback(rolledBackPairs);
        // Restore pre-apply settings metadata cleanly (including pinnedBooks!)
        if (preSnapshot) {
            settings.groups = deepClone(preSnapshot.groups);
            settings.assignments = deepClone(preSnapshot.assignments);
            settings.aliases = deepClone(preSnapshot.aliases);
            settings.notes = deepClone(preSnapshot.notes);
            settings.charBookOverrides = deepClone(preSnapshot.charBookOverrides);
            settings.cachedCharBindings = deepClone(preSnapshot.cachedCharBindings);
            settings.sectionOrder = deepClone(preSnapshot.sectionOrder);
            settings.undoSnapshots = deepClone(preSnapshot.undoSnapshots);
            settings.pinnedBooks = deepClone(preSnapshot.pinnedBooks || []);
            for (const pair of unrolledPairs) {
                migrateSettingsOnWorldRename(settings, pair.oldName, pair.newName);
            }
        }
        await flushWorldInfoListRefresh();
        await _callbacks.onRescan();
        return { rolledBack, rollbackErrors };
    };

    const applyOutboundCharExclusions = (targetSettings, appliedProposals, resolveIsCharBound) => {
        if (!targetSettings || !Array.isArray(appliedProposals) || appliedProposals.length === 0) return;
        targetSettings.charBookOverrides ||= {};
        for (const p of appliedProposals) {
            if (!p?.realName) continue;
            if (p.applyGroup === false) continue;
            const cleanGroup = typeof p.group === 'string' ? p.group.trim() : '';
            if (!cleanGroup || cleanGroup === '角色世界书') continue;
            if (cleanGroup !== '未分组' && !targetSettings.assignments?.[p.realName]) continue;
            if (resolveIsCharBound(p.realName)) {
                targetSettings.charBookOverrides[p.realName] = 'exclude_from_char';
            }
        }
    };

    modal.querySelector('#wbo-ai-apply-btn')?.addEventListener('click', async (ev) => {
        const applyBtn = ev.currentTarget;
        const applyMode = modal.querySelector('input[name="wbo-ai-apply-mode"]:checked')?.value || 'alias';
        // Read directly from live `currentProposals` so items currently filtered out by a preview group pill are STILL applied!
        const chosen = currentProposals
            .filter((p) => p.selected)
            .map((p) => ({
                realName: p.realName,
                alias: (p.alias || '').trim(),
                group: (p.group || '').trim(),
                note: (p.note || '').trim(),
            }));

        if (chosen.length === 0) {
            showToast('warning', '请至少勾选一项');
            return;
        }

        if (applyMode === 'real') {
            if (!globalThis.confirm(`确定对选中的 ${chosen.length} 本世界书执行真实规范改名并同步绑定吗？\n执行过程中随时可点「取消并撤回」。`)) {
                return;
            }
            if (applyBtn instanceof HTMLButtonElement) applyBtn.disabled = true;
            if (applyCancelBtn instanceof HTMLButtonElement) applyCancelBtn.disabled = true;

            const preSnapshot = {
                groups: deepClone(settings.groups || []),
                assignments: deepClone(settings.assignments || {}),
                aliases: deepClone(settings.aliases || {}),
                notes: deepClone(settings.notes || {}),
                charBookOverrides: deepClone(settings.charBookOverrides || {}),
                cachedCharBindings: deepClone(settings.cachedCharBindings || {}),
                sectionOrder: deepClone(settings.sectionOrder || []),
                undoSnapshots: deepClone(settings.undoSnapshots || []),
                pinnedBooks: deepClone(settings.pinnedBooks || []),
            };

            let cancelled = false;
            const liveNamesSet = new Set(getWorldNames());
            /** @type {Array<{ oldName: string, newName: string }>} */
            const completedRenames = [];
            /** @type {Array<{ oldName: string, newName: string, error: string }>} */
            const failedItems = [];
            const adjustedProposals = [];
            const origNameByFinalName = new Map();

            const renderRunningProgress = (idx, label) => {
                if (!(applyProgressBox instanceof HTMLElement)) return;
                const pct = Math.round(((idx) / Math.max(1, chosen.length)) * 100);
                applyProgressBox.hidden = false;
                applyProgressBox.innerHTML = `
                    <div class="wbo-progress-head">
                        <span>正在规范改名 (${idx}/${chosen.length})：${esc(label)}</span>
                        <button type="button" class="wbo-btn wbo-btn-danger wbo-progress-cancel-btn" id="wbo-apply-abort-btn">取消并撤回</button>
                    </div>
                    <div class="wbo-progress-track"><div class="wbo-progress-fill" style="width:${pct}%"></div></div>
                `;
                applyProgressBox.querySelector('#wbo-apply-abort-btn')?.addEventListener('click', (e) => {
                    cancelled = true;
                    const b = e.currentTarget;
                    if (b instanceof HTMLButtonElement) {
                        b.disabled = true;
                        b.textContent = '正在取消并撤回...';
                    }
                });
            };

            setStatus('', false, 'preview');

            for (let i = 0; i < chosen.length; i += 1) {
                if (cancelled) break;
                const item = chosen[i];
                let finalRealName = item.realName;
                if (item.alias && item.alias !== item.realName) {
                    renderRunningProgress(i + 1, `${item.realName} → ${item.alias}`);
                    const res = await realRenameWorldbook(item.realName, item.alias, settings, {
                        deferRefresh: true,
                        existingNamesSet: liveNamesSet,
                    });
                    if (res.ok) {
                        finalRealName = item.alias;
                        completedRenames.push({ oldName: item.realName, newName: item.alias });
                    } else {
                        failedItems.push({
                            oldName: item.realName,
                            newName: item.alias,
                            error: res.error || '未知错误',
                        });
                    }
                }
                origNameByFinalName.set(finalRealName, item.realName);
                adjustedProposals.push({
                    realName: finalRealName,
                    alias: '',
                    group: item.group,
                    note: item.note,
                    applyAlias: false,
                });
            }

            if (cancelled) {
                const { rolledBack, rollbackErrors } = await rollbackRealRenames(completedRenames, preSnapshot, liveNamesSet);
                if (applyBtn instanceof HTMLButtonElement) applyBtn.disabled = false;
                if (applyCancelBtn instanceof HTMLButtonElement) applyCancelBtn.disabled = false;
                if (applyProgressBox instanceof HTMLElement) {
                    applyProgressBox.innerHTML = rollbackErrors.length > 0
                        ? `<div class="wbo-refusal-box"><b>已取消，但有 ${rollbackErrors.length} 项撤回失败：</b><br>${rollbackErrors.map((e) => esc(e)).join('<br>')}</div>`
                        : `<div class="wbo-progress-done">已取消并撤回全部 ${rolledBack} 本已修改的世界书，文件与绑定已恢复原状。</div>`;
                }
                showToast('info', `已取消并撤回 ${rolledBack} 本世界书`);
                return;
            }

            // Commit groups/notes & flush host world list ONCE for the whole batch!
            applyAiOrganizeProposals(settings, adjustedProposals, {
                label: previewFromLocal ? '免 AI 整理' : 'AI 整理',
                isCharBoundFn: (name) => {
                    const origName = origNameByFinalName.get(name) || name;
                    return Boolean((classification.byName.get(origName)?.charOwners || []).some((o) => o && o.source !== 'embedded'));
                },
            });
            applyOutboundCharExclusions(settings, adjustedProposals, (name) => {
                const origName = origNameByFinalName.get(name) || name;
                return Boolean(classification.byName.get(origName)?.isCharBound);
            });
            await flushWorldInfoListRefresh();
            await _callbacks.onRescan();

            if (failedItems.length === 0) {
                closeSubModal();
                showToast('success', `真实改名完成：成功 ${completedRenames.length} 本`);
                return;
            }

            // Keep modal open on partial/full failure so user sees EVERY exact error and can fix or roll back!
            if (applyBtn instanceof HTMLButtonElement) applyBtn.disabled = false;
            if (applyCancelBtn instanceof HTMLButtonElement) applyCancelBtn.disabled = false;

            const failedNameSet = new Set(failedItems.map((f) => f.oldName));
            currentProposals.forEach((p) => {
                p.selected = failedNameSet.has(p.realName);
            });
            renderPreviewContent();

            if (applyProgressBox instanceof HTMLElement) {
                applyProgressBox.hidden = false;
                applyProgressBox.innerHTML = `
                    <div class="wbo-refusal-box">
                        <div><b>改名完成：成功 ${completedRenames.length} 本，失败 ${failedItems.length} 本</b>（已自动勾选失败项，可直接修改新名称后重试）</div>
                        <ul class="wbo-fail-list">
                            ${failedItems.map((f) => `<li><b>${esc(f.oldName)}</b> → ${esc(f.newName)}：${esc(f.error)}</li>`).join('')}
                        </ul>
                        <div class="wbo-ai-actions-row" style="margin-top:8px;">
                            ${completedRenames.length > 0 ? `<button type="button" class="wbo-btn wbo-btn-danger" id="wbo-apply-rollback-btn">撤回已改的 ${completedRenames.length} 本</button>` : ''}
                            <button type="button" class="wbo-btn" id="wbo-apply-keep-close-btn">保留成功项并关闭</button>
                        </div>
                    </div>
                `;
                applyProgressBox.querySelector('#wbo-apply-rollback-btn')?.addEventListener('click', async (e) => {
                    const rbBtn = e.currentTarget;
                    if (rbBtn instanceof HTMLButtonElement) rbBtn.disabled = true;
                    const { rolledBack, rollbackErrors } = await rollbackRealRenames(completedRenames, preSnapshot, liveNamesSet);
                    if (applyProgressBox instanceof HTMLElement) {
                        applyProgressBox.innerHTML = rollbackErrors.length > 0
                            ? `<div class="wbo-refusal-box"><b>撤回部分失败：</b><br>${rollbackErrors.map((err) => esc(err)).join('<br>')}</div>`
                            : `<div class="wbo-progress-done">已撤回本次成功修改的 ${rolledBack} 本世界书，已全部恢复原状。</div>`;
                    }
                    showToast('info', `已撤回 ${rolledBack} 本世界书`);
                });
                applyProgressBox.querySelector('#wbo-apply-keep-close-btn')?.addEventListener('click', closeSubModal);
            }
            return;
        }

        const { appliedCount, createdGroups } = applyAiOrganizeProposals(settings, chosen, {
            label: previewFromLocal ? '免 AI 整理' : 'AI 整理',
            isCharBoundFn: (name) => Boolean((classification.byName.get(name)?.charOwners || []).some((o) => o && o.source !== 'embedded')),
        });
        applyOutboundCharExclusions(
            settings,
            chosen,
            (name) => Boolean(classification.byName.get(name)?.isCharBound),
        );
        closeSubModal();
        await _callbacks.onMutation({ save: true });
        const extra = createdGroups.length > 0 ? `，新建分组：${createdGroups.join('、')}` : '';
        showToast('success', `已应用 ${appliedCount} 本世界书的显示名与分组${extra}`);
    });
}

export { openAiOrganizeModal };
