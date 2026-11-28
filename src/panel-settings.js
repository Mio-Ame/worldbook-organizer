/** Organizer settings and configuration import/export. */

import {
    _callbacks,
    closeSubModal,
    createSubModal,
    esc,
    excludeChipAttrs,
    excludeChipInnerHtml,
    excludeCountText,
    syncAllOpenModalsTheme,
    syncExcludeChip,
    THEME_PALETTES,
} from './panel-window.js';
import {
    exportConfigData,
    importConfigData,
    pushUndoSnapshot,
    SPECIAL_GROUPS,
} from './core.js';
import { showToast } from './host.js';
import { detectEnhancedScriptSignals, hasCompatibleDropdownScript, isEnhancedScriptActive } from './native-filter.js';
import { openImportRulesModal } from './panel-import-rules.js';
import { getNativeGroupingPreferences } from './entry-groups/host.js';
import { canConfigureNativeGrouping, setNativeEntryButtonVisible } from './entry-groups/panel.js';
import { isEntryGroupingEnabled, syncEntryGroupingFeatureGate } from './entry-groups/feature-gate.js';

// ==================== Settings Modal & Extension Settings Panel ====================

function triggerConfigExport() {
    if (!_callbacks) return;
    const { settings } = _callbacks.getState();
    const data = exportConfigData(settings);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `worldbook-organizer-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('success', '已导出配置');
}

async function handleConfigImportFile(file) {
    if (!_callbacks || !file) return;
    const { settings } = _callbacks.getState();
    try {
        const text = await file.text();
        const res = importConfigData(settings, text);
        if (!res.ok) {
            showToast('error', res.error || '导入失败');
            return;
        }
        await _callbacks.onMutation({ save: true });
        showToast('success', `导入成功：${res.stats.groups} 个分组、${res.stats.aliases} 条别名`);
    } catch (err) {
        showToast('error', `读取配置失败：${err?.message || err}`);
    }
}

/**
 * Sync live setting values into any container holding `[data-setting]` / `[data-setting-select]`.
 * @param {Element} container
 * @param {Record<string, any>} settings
 */
function syncSettingControlsInPlace(container, settings) {
    container.querySelectorAll('input[data-setting]').forEach((el) => {
        if (!(el instanceof HTMLInputElement)) return;
        const key = el.getAttribute('data-setting');
        if (key) el.checked = key === 'entryGroupsEnabled'
            ? isEntryGroupingEnabled(settings) : Boolean(settings[key]);
    });
    container.querySelectorAll('select[data-setting-select]').forEach((el) => {
        if (!(el instanceof HTMLSelectElement)) return;
        const key = el.getAttribute('data-setting-select');
        if (key && settings[key] !== undefined) el.value = String(settings[key]);
    });
    const nativeOptions = container.querySelector('[data-entry-native-options]');
    if (nativeOptions) nativeOptions.hidden = !isEntryGroupingEnabled(settings) || !canConfigureNativeGrouping();
    const nativeButton = container.querySelector('input[data-entry-native-button]');
    if (nativeButton) {
        nativeButton.disabled = !isEntryGroupingEnabled(settings) || !canConfigureNativeGrouping();
        nativeButton.checked = isEntryGroupingEnabled(settings) && getNativeGroupingPreferences().showButton;
    }
}

/**
 * Bind change listeners for `[data-setting]` and `[data-setting-select]` reading live state.
 * @param {Element} container
 */
const QUICK_ACTION_UI_ONLY_KEYS = new Set([
    'showNativeComboBtn',
    'showNativeExcludeBtn',
    'showNativeEntrySearchBtn',
    'showNativeCharToggleBtn',
]);

function bindSettingControlListeners(container) {
    container.querySelectorAll('input[data-setting]').forEach((el) => {
        el.addEventListener('change', async () => {
            if (!(el instanceof HTMLInputElement) || !_callbacks) return;
            const key = el.getAttribute('data-setting');
            if (!key) return;
            const { settings } = _callbacks.getState();
            settings[key] = el.checked;
            if (key === 'entryGroupsEnabled') {
                el.disabled = true;
                try {
                    await syncEntryGroupingFeatureGate();
                } catch (error) {
                    settings.entryGroupsEnabled = false;
                    await syncEntryGroupingFeatureGate();
                    showToast('error', `条目分组启用失败：${error?.message || error}`);
                } finally {
                    el.disabled = false;
                    syncSettingControlsInPlace(container, settings);
                }
                await _callbacks?.onMutation({ save: true, uiOnly: true });
                return;
            }
            if (key === 'hideCharBooksByDefault') {
                settings.showCharBooks = !el.checked;
                for (const listKey of ['globalHiddenGroupIds', 'editorHiddenGroupIds']) {
                    const curList = Array.isArray(settings[listKey]) ? [...settings[listKey]] : [];
                    if (el.checked) {
                        if (!curList.includes(SPECIAL_GROUPS.CHARACTER)) curList.unshift(SPECIAL_GROUPS.CHARACTER);
                    } else {
                        const idx = curList.indexOf(SPECIAL_GROUPS.CHARACTER);
                        if (idx >= 0) curList.splice(idx, 1);
                    }
                    settings[listKey] = curList;
                }
                container.dispatchEvent(new CustomEvent('wbo:sync-exclude-chips'));
            }
            if (QUICK_ACTION_UI_ONLY_KEYS.has(key)) {
                await _callbacks.onMutation({ save: true, uiOnly: true, quickActionsOnly: true });
                return;
            }
            if (key === 'syncEntryOrderOnDrag') {
                await _callbacks.onMutation({ save: true, uiOnly: true });
                return;
            }
            await _callbacks.onMutation({ save: true });
        });
    });

    container.querySelectorAll('select[data-setting-select]').forEach((el) => {
        el.addEventListener('change', async () => {
            if (!(el instanceof HTMLSelectElement) || !_callbacks) return;
            const key = el.getAttribute('data-setting-select');
            if (!key) return;
            const { settings } = _callbacks.getState();
            settings[key] = el.value;
            await _callbacks.onMutation({ save: true });
        });
    });
}

/**
 * Open the Display & Behavior Settings sub-modal directly inside Group Manager.
 */
function openSettingsModal() {
    if (!_callbacks) return;
    const { settings, classification } = _callbacks.getState();

    const sectionOptions = [
        { id: SPECIAL_GROUPS.CHARACTER, name: '角色世界书', color: '#9b72cf' },
        ...(settings.groups || []).map((g) => ({ id: g.id, name: g.name, color: g.color || '#5b8def' })),
        { id: SPECIAL_GROUPS.UNGROUPED, name: '未分组', color: '#8c99a6' },
    ];
    const renderExcludeChipsHtml = (targetKey, hiddenIds) => {
        const set = new Set(Array.isArray(hiddenIds) ? hiddenIds : []);
        return sectionOptions.map((sec) => `
                <button type="button" ${excludeChipAttrs(sec, set.has(sec.id))}
                    data-exclude-target="${esc(targetKey)}"
                    data-exclude-gid="${esc(sec.id)}">
                    ${excludeChipInnerHtml(sec, set.has(sec.id))}
                </button>
            `).join('');
    };

    const paletteButtonsHtml = THEME_PALETTES.map((p) => `
        <button type="button"
            class="wbo-palette-chip${settings.themePalette === p.id ? ' is-active' : ''}"
            data-theme-palette="${esc(p.id)}">
            <span class="wbo-palette-swatch" style="background:linear-gradient(135deg, ${p.lightBg} 48%, ${p.accent} 52%)"></span>
            <span>${esc(p.label)}</span>
        </button>
    `).join('');

    const modeButtonsHtml = [
        { id: 'auto', label: '跟随酒馆' },
        { id: 'light', label: '浅色' },
        { id: 'dark', label: '深色' },
    ].map((m) => `
        <button type="button"
            class="wbo-mode-chip${(settings.themeMode || 'auto') === m.id ? ' is-active' : ''}"
            data-theme-mode="${esc(m.id)}">${esc(m.label)}</button>
    `).join('');

    const initialSettingsTab = ['appearance', 'display', 'behavior'].includes(settings.settingsLastTab)
        ? settings.settingsLastTab
        : 'appearance';
    const quickModeButtonsHtml = [
        { id: 'merged', label: '三合一按钮' },
        { id: 'split', label: '分开显示' },
        { id: 'off', label: '隐藏顶栏按钮' },
    ].map((m) => `
        <button type="button"
            class="wbo-mode-chip${(settings.nativeQuickActionsMode || 'merged') === m.id ? ' is-active' : ''}"
            data-quick-actions-mode="${esc(m.id)}">${esc(m.label)}</button>
    `).join('');

    const { modal } = createSubModal(
        '显示与行为设置',
        `
            <div class="wbo-pinned-tabs-bar" id="wbo-settings-tabs">
                <div class="wbo-tabs">
                    <button type="button" class="wbo-tab${initialSettingsTab === 'appearance' ? ' is-active' : ''}" data-settings-tab="appearance">外观与入口</button>
                    <button type="button" class="wbo-tab${initialSettingsTab === 'display' ? ' is-active' : ''}" data-settings-tab="display">标题与排除</button>
                    <button type="button" class="wbo-tab${initialSettingsTab === 'behavior' ? ' is-active' : ''}" data-settings-tab="behavior">识别与适配</button>
                </div>
            </div>

            <div class="wbo-step-scroll">
            <div class="wbo-settings-tab-pane" data-settings-pane="appearance"${initialSettingsTab === 'appearance' ? '' : ' hidden'}>
                <div class="wbo-card wbo-entry-settings-card">
                    <div class="wbo-ai-section-head"><span><i class="fa-solid fa-layer-group" aria-hidden="true"></i> 条目分组（测试）</span></div>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="entryGroupsEnabled">
                        <strong>启用条目分组</strong>
                    </label>
                    <div class="wbo-subtle-tip">关闭后隐藏所有入口，保留分组记录。</div>
                    <div data-entry-native-options hidden>
                        <label class="wbo-check-line">
                            <input type="checkbox" data-entry-native-button>
                            <span>在原生编辑器显示条目分组入口</span>
                        </label>
                    </div>
                </div>
                <div class="wbo-card">
                    <div class="wbo-ai-section-head"><span>面板配色</span></div>
                    <div class="wbo-palette-grid">${paletteButtonsHtml}</div>
                    <div class="wbo-setting-inline-row wbo-setting-theme-mode-row">
                        <span class="wbo-setting-subhead">明暗模式</span>
                        <div class="wbo-mode-group">${modeButtonsHtml}</div>
                    </div>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="outsideDropdownFollowHostTheme">
                        <span>插件面板外的下拉筛选框跟随酒馆主题</span>
                    </label>
                </div>

                <div class="wbo-card">
                    <div class="wbo-ai-section-head"><span>世界书原生面板快捷按钮</span></div>
                    <div class="wbo-setting-inline-row">
                        <span>顶栏右侧入口样式</span>
                        <div class="wbo-mode-group">${quickModeButtonsHtml}</div>
                    </div>
                    <div class="wbo-split-quick-checks" id="wbo-split-quick-checks"${(settings.nativeQuickActionsMode || 'merged') === 'split' ? '' : ' hidden'}>
                        <label class="wbo-check-line">
                            <input type="checkbox" data-setting="showNativeComboBtn">
                            <span>显示顶栏右侧「组合」快捷按钮</span>
                        </label>
                        <label class="wbo-check-line">
                            <input type="checkbox" data-setting="showNativeExcludeBtn">
                            <span>显示顶栏右侧「排除」快捷按钮</span>
                        </label>
                        <label class="wbo-check-line">
                            <input type="checkbox" data-setting="showNativeEntrySearchBtn">
                            <span>显示顶栏右侧「搜条目」快捷按钮</span>
                        </label>
                    </div>
                    <div class="wbo-local-divider"></div>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="showNativeCharToggleBtn">
                        <span>显示编辑下拉框旁「角色书显隐」按钮</span>
                    </label>
                    <div class="wbo-subtle-tip">三合一包含组合、排除分组和搜条目。</div>
                </div>
            </div>

            <div class="wbo-settings-tab-pane" data-settings-pane="display"${initialSettingsTab === 'display' ? '' : ' hidden'}>
                <div class="wbo-card">
                    <div class="wbo-ai-section-head"><span>标题显示</span></div>
                    <div class="wbo-setting-inline-row">
                        <span>角色世界书标题</span>
                        <select class="wbo-select" data-setting-select="charBookTitleMode">
                            <option value="char_with_sub">角色名 + 小字原标题</option>
                            <option value="char_only">仅角色名</option>
                            <option value="original">原标题</option>
                        </select>
                    </div>
                    <div class="wbo-setting-inline-row">
                        <span>显示名展示方式</span>
                        <select class="wbo-select" data-setting-select="aliasTitleMode">
                            <option value="alias_with_sub">显示名 + 小字原名</option>
                            <option value="alias_only">仅显示名</option>
                        </select>
                    </div>
                    <div class="wbo-setting-inline-row">
                        <span id="wbo-alias-count-label">当前已自定义 ${Object.keys(settings.aliases || {}).length} 个显示名</span>
                        <button type="button" class="wbo-btn" id="wbo-reset-all-aliases-btn"${Object.keys(settings.aliases || {}).length === 0 ? ' disabled' : ''}>
                            <i class="fa-solid fa-rotate-left"></i> 全部恢复为文件名
                        </button>
                    </div>
                    <div class="wbo-setting-inline-row">
                        <span id="wbo-note-count-label">当前共有 ${Object.keys(settings.notes || {}).length} 条备注说明</span>
                        <button type="button" class="wbo-btn" id="wbo-clear-all-notes-btn"${Object.keys(settings.notes || {}).length === 0 ? ' disabled' : ''}>
                            <i class="fa-regular fa-trash-can"></i> 清空全部说明
                        </button>
                    </div>
                </div>

                <div class="wbo-card">
                    <div class="wbo-ai-section-head"><span>下拉框默认排除分组</span></div>
                    <div class="wbo-exclude-block">
                        <div class="wbo-exclude-head">
                            <span class="wbo-exclude-title-wrap">
                                <span>全局激活框</span>
                                <span class="wbo-exclude-count" data-exclude-count="globalHiddenGroupIds">${excludeCountText(sectionOptions.filter((s) => (settings.globalHiddenGroupIds || []).includes(s.id)).length, sectionOptions.length)}</span>
                            </span>
                            <span class="wbo-ai-quick-picks">
                                <button type="button" class="wbo-link-btn" data-exclude-preset="clear" data-exclude-scope="globalHiddenGroupIds">全部显示</button>
                                <button type="button" class="wbo-link-btn" data-exclude-preset="invert" data-exclude-scope="globalHiddenGroupIds">反选</button>
                                <button type="button" class="wbo-link-btn" data-exclude-preset="char-only" data-exclude-scope="globalHiddenGroupIds">仅排除角色书</button>
                                <button type="button" class="wbo-link-btn" data-exclude-preset="select-all" data-exclude-scope="globalHiddenGroupIds">全部排除</button>
                            </span>
                        </div>
                        <div class="wbo-local-cats wbo-exclude-chips" data-exclude-list="globalHiddenGroupIds">
                            ${renderExcludeChipsHtml('globalHiddenGroupIds', settings.globalHiddenGroupIds)}
                        </div>
                    </div>
                    <div class="wbo-local-divider"></div>
                    <div class="wbo-exclude-block">
                        <div class="wbo-exclude-head">
                            <span class="wbo-exclude-title-wrap">
                                <span>编辑下拉框</span>
                                <span class="wbo-exclude-count" data-exclude-count="editorHiddenGroupIds">${excludeCountText(sectionOptions.filter((s) => (settings.editorHiddenGroupIds || []).includes(s.id)).length, sectionOptions.length)}</span>
                            </span>
                            <span class="wbo-ai-quick-picks">
                                <button type="button" class="wbo-link-btn" data-exclude-preset="copy-global" data-exclude-scope="editorHiddenGroupIds">同全局</button>
                                <button type="button" class="wbo-link-btn" data-exclude-preset="clear" data-exclude-scope="editorHiddenGroupIds">全部显示</button>
                                <button type="button" class="wbo-link-btn" data-exclude-preset="invert" data-exclude-scope="editorHiddenGroupIds">反选</button>
                                <button type="button" class="wbo-link-btn" data-exclude-preset="char-only" data-exclude-scope="editorHiddenGroupIds">仅排除角色书</button>
                                <button type="button" class="wbo-link-btn" data-exclude-preset="select-all" data-exclude-scope="editorHiddenGroupIds">全部排除</button>
                            </span>
                        </div>
                        <div class="wbo-local-cats wbo-exclude-chips" data-exclude-list="editorHiddenGroupIds">
                            ${renderExcludeChipsHtml('editorHiddenGroupIds', settings.editorHiddenGroupIds)}
                        </div>
                    </div>
                    <div class="wbo-subtle-tip">打勾的分组会显示，划掉的分组已排除，点击切换。已全局激活或正在编辑的世界书不会被隐藏。</div>
                    <div class="wbo-local-divider"></div>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="pinCurrentChatCharBookInEditor">
                        <span>聊天中在编辑下拉框置顶当前角色的世界书</span>
                    </label>
                </div>
            </div>

            <div class="wbo-settings-tab-pane" data-settings-pane="behavior"${initialSettingsTab === 'behavior' ? '' : ' hidden'}>
                <div class="wbo-card">
                    <div class="wbo-ai-section-head"><span>识别与默认行为</span></div>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="hideCharBooksByDefault">
                        <span>默认隐藏角色卡绑定的世界书</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="includeExtraCharBooks">
                        <span>将角色附加世界书归入角色世界书</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="includeEmbeddedNameMatch">
                        <span>识别角色卡内嵌同名世界书</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="autoScanNewCharacters">
                        <span>导入新角色卡时自动扫描绑定的世界书</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="autoImportMissingCharBook">
                        <span>打开角色卡时自动导入缺失的卡内世界书</span>
                    </label>
                    <div class="wbo-setting-inline-row">
                        <span>按世界书标题自动归类</span>
                        <button type="button" class="wbo-btn" data-open-import-rules>导入归类</button>
                    </div>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="showNativeOptgroups">
                        <span>编辑器下拉框按分组显示</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="syncEntryOrderOnDrag">
                        <span>拖动调整条目顺序时同步改写插入顺序 (order)</span>
                    </label>
                </div>

                <div class="wbo-card">
                    <div class="wbo-ai-section-head"><span>弹窗适配范围</span></div>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="adaptCharBindPopup">
                        <span>角色卡世界书绑定弹窗</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="autoHideInCharBindPopup">
                        <span>角色卡绑定弹窗默认排除其他角色世界书</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="adaptPersonaBindPopup">
                        <span>User 人设世界书弹窗</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="adaptChatBindPopup">
                        <span>当前聊天世界书弹窗</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="adaptMoveEntryPopup">
                        <span>移动/复制条目目标世界书弹窗</span>
                    </label>
                </div>

                <div class="wbo-card" data-dropdown-script-settings>
                    <div class="wbo-ai-section-head"><span>下拉框美化酒馆脚本适配</span></div>
                    <div class="wbo-setting-inline-row">
                        <span>检测状态</span>
                        <span class="wbo-hint" data-enhanced-script-status></span>
                    </div>
                    <label class="wbo-check-line">
                        <span>这个脚本在用吗</span>
                        <select data-setting-select="enhancedScriptMode">
                            <option value="auto">自动检测（推荐）</option>
                            <option value="on">当作已启用（强制适配）</option>
                            <option value="off">当作未启用</option>
                        </select>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="adaptEnhancedPresetGroups">
                        <span>预设下拉框显示分组切换</span>
                    </label>
                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="overrideEnhancedDropdownStyle">
                        <span>覆盖脚本配色，跟随酒馆主题</span>
                    </label>
                    <div class="wbo-hint" data-enhanced-script-hint></div>
                </div>
            </div>
            </div>

            <div class="wbo-modal-footer wbo-pinned-footer">
                <button type="button" class="wbo-btn" id="wbo-modal-export-btn">
                    <i class="fa-solid fa-download"></i> 导出配置
                </button>
                <button type="button" class="wbo-btn" id="wbo-modal-import-btn">
                    <i class="fa-solid fa-upload"></i> 导入配置
                </button>
                <input type="file" id="wbo-modal-import-file" accept=".json" hidden>
                <button type="button" class="wbo-btn" id="wbo-modal-diag-btn" title="生成问题诊断信息">
                    <i class="fa-solid fa-clipboard-list"></i> 诊断
                </button>
                <span class="wbo-spacer"></span>
                <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-settings-close-btn">完成</button>
            </div>
        `,
        { pinnedLayout: true, floating: true },
    );

    modal.querySelectorAll('[data-settings-tab]').forEach((tabBtn) => {
        tabBtn.addEventListener('click', () => {
            const targetTab = tabBtn.getAttribute('data-settings-tab') || 'appearance';
            if (_callbacks) {
                const cur = _callbacks.getState().settings;
                cur.settingsLastTab = targetTab;
                void _callbacks.onMutation({ save: true, uiOnly: true });
            }
            modal.querySelectorAll('[data-settings-tab]').forEach((b) => {
                b.classList.toggle('is-active', b.getAttribute('data-settings-tab') === targetTab);
            });
            modal.querySelectorAll('[data-settings-pane]').forEach((pane) => {
                if (pane instanceof HTMLElement) {
                    pane.hidden = pane.getAttribute('data-settings-pane') !== targetTab;
                }
            });
            const scrollEl = modal.querySelector('.wbo-step-scroll');
            if (scrollEl) scrollEl.scrollTop = 0;
        });
    });

    const syncQuickActionsModeUi = () => {
        const cur = _callbacks?.getState?.()?.settings || settings;
        const curMode = cur.nativeQuickActionsMode || 'merged';
        modal.querySelectorAll('[data-quick-actions-mode]').forEach((btn) => {
            btn.classList.toggle('is-active', btn.getAttribute('data-quick-actions-mode') === curMode);
        });
        const splitBox = modal.querySelector('#wbo-split-quick-checks');
        if (splitBox instanceof HTMLElement) splitBox.hidden = curMode !== 'split';
    };
    modal.querySelectorAll('[data-quick-actions-mode]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const val = btn.getAttribute('data-quick-actions-mode');
            if (!val || !_callbacks) return;
            const cur = _callbacks.getState().settings;
            cur.nativeQuickActionsMode = val;
            syncQuickActionsModeUi();
            await _callbacks.onMutation({ save: true, uiOnly: true, quickActionsOnly: true });
        });
    });

    syncSettingControlsInPlace(modal, settings);
    bindSettingControlListeners(modal);
    modal.querySelector('input[data-entry-native-button]')?.addEventListener('change', (event) => {
        setNativeEntryButtonVisible(event.target.checked);
    });

    const syncExcludeChips = () => {
        const cur = _callbacks?.getState?.()?.settings || settings;
        for (const targetKey of ['globalHiddenGroupIds', 'editorHiddenGroupIds']) {
            const set = new Set(Array.isArray(cur[targetKey]) ? cur[targetKey] : []);
            modal.querySelectorAll(`[data-exclude-target="${targetKey}"]`).forEach((btn) => {
                const gid = btn.getAttribute('data-exclude-gid') || '';
                const sec = sectionOptions.find((s) => s.id === gid);
                if (sec) syncExcludeChip(btn, sec, set.has(gid));
            });
            const hiddenCnt = sectionOptions.filter((s) => set.has(s.id)).length;
            const cntEl = modal.querySelector(`[data-exclude-count="${targetKey}"]`);
            if (cntEl) cntEl.textContent = excludeCountText(hiddenCnt, sectionOptions.length);
        }
        const hideCharCb = modal.querySelector('input[data-setting="hideCharBooksByDefault"]');
        if (hideCharCb instanceof HTMLInputElement) {
            const charHiddenAnywhere =
                (Array.isArray(cur.globalHiddenGroupIds) && cur.globalHiddenGroupIds.includes(SPECIAL_GROUPS.CHARACTER)) ||
                (Array.isArray(cur.editorHiddenGroupIds) && cur.editorHiddenGroupIds.includes(SPECIAL_GROUPS.CHARACTER));
            hideCharCb.checked = charHiddenAnywhere;
            cur.hideCharBooksByDefault = charHiddenAnywhere;
        }
    };
    modal.addEventListener('wbo:sync-exclude-chips', syncExcludeChips);

    modal.querySelectorAll('[data-exclude-target]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!_callbacks) return;
            const targetKey = btn.getAttribute('data-exclude-target');
            const gid = btn.getAttribute('data-exclude-gid');
            if (!targetKey || !gid) return;
            const cur = _callbacks.getState().settings;
            const set = new Set(Array.isArray(cur[targetKey]) ? cur[targetKey] : []);
            if (set.has(gid)) set.delete(gid);
            else set.add(gid);
            cur[targetKey] = [...set];
            // If user just excluded a group while reveal toggle was OFF, apply immediately;
            // if user had toggled reveal ON earlier, keep reveal state untouched or switch to hidden when excluding?
            // Keeping `showCharBooks = false` when user actively configures default exclusions ensures instant visible effect!
            if (set.size > 0 && cur.showCharBooks) {
                cur.showCharBooks = false;
            }
            syncExcludeChips();
            await _callbacks.onMutation({ save: true });
        });
    });

    modal.querySelectorAll('[data-exclude-preset]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!_callbacks) return;
            const preset = btn.getAttribute('data-exclude-preset');
            const scopeKey = btn.getAttribute('data-exclude-scope');
            if (!preset || !scopeKey) return;
            const cur = _callbacks.getState().settings;
            if (preset === 'clear') {
                cur[scopeKey] = [];
            } else if (preset === 'select-all') {
                cur[scopeKey] = sectionOptions.map((s) => s.id);
                if (cur[scopeKey].length > 0) cur.showCharBooks = false;
            } else if (preset === 'invert') {
                const prev = new Set(Array.isArray(cur[scopeKey]) ? cur[scopeKey] : []);
                cur[scopeKey] = sectionOptions.map((s) => s.id).filter((id) => !prev.has(id));
                if (cur[scopeKey].length > 0) cur.showCharBooks = false;
            } else if (preset === 'char-only') {
                cur[scopeKey] = [SPECIAL_GROUPS.CHARACTER];
                cur.showCharBooks = false;
            } else if (preset === 'copy-global') {
                cur[scopeKey] = Array.isArray(cur.globalHiddenGroupIds) ? [...cur.globalHiddenGroupIds] : [];
                if (cur[scopeKey].length > 0) cur.showCharBooks = false;
            }
            syncExcludeChips();
            await _callbacks.onMutation({ save: true });
        });
    });

    const syncThemeChips = () => {
        const cur = _callbacks?.getState?.()?.settings || settings;
        modal.querySelectorAll('[data-theme-palette]').forEach((btn) => {
            btn.classList.toggle('is-active', btn.getAttribute('data-theme-palette') === (cur.themePalette || 'classic'));
        });
        modal.querySelectorAll('[data-theme-mode]').forEach((btn) => {
            btn.classList.toggle('is-active', btn.getAttribute('data-theme-mode') === (cur.themeMode || 'auto'));
        });
    };

    modal.querySelectorAll('[data-theme-palette]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const val = btn.getAttribute('data-theme-palette');
            if (!val || !_callbacks) return;
            const cur = _callbacks.getState().settings;
            cur.themePalette = val;
            syncThemeChips();
            syncAllOpenModalsTheme();
            await _callbacks.onMutation({ save: true, uiOnly: true });
        });
    });

    modal.querySelectorAll('[data-theme-mode]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const val = btn.getAttribute('data-theme-mode');
            if (!val || !_callbacks) return;
            const cur = _callbacks.getState().settings;
            cur.themeMode = val;
            syncThemeChips();
            syncAllOpenModalsTheme();
            await _callbacks.onMutation({ save: true, uiOnly: true });
        });
    });

    modal.querySelector('#wbo-reset-all-aliases-btn')?.addEventListener('click', async () => {
        if (!_callbacks) return;
        const cur = _callbacks.getState().settings;
        const count = Object.keys(cur.aliases || {}).length;
        if (count === 0) return;
        if (!globalThis.confirm(`确认清除全部 ${count} 个自定义显示名，一键恢复为世界书原文件名？\n（不会影响已有分组，且可在历史版本中回退）`)) return;
        pushUndoSnapshot(cur, { count, label: '恢复原文件名' });
        cur.aliases = {};
        await _callbacks.onMutation({ save: true });
        const lbl = modal.querySelector('#wbo-alias-count-label');
        const btn = modal.querySelector('#wbo-reset-all-aliases-btn');
        if (lbl) lbl.textContent = '当前已自定义 0 个显示名';
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        showToast('success', `已将 ${count} 本世界书恢复为原文件名`);
    });

    modal.querySelector('#wbo-clear-all-notes-btn')?.addEventListener('click', async () => {
        if (!_callbacks) return;
        const cur = _callbacks.getState().settings;
        const count = Object.keys(cur.notes || {}).length;
        if (count === 0) return;
        if (!globalThis.confirm(`确认清空全部 ${count} 条世界书备注说明？\n（不会影响已有分组与名称，且可在历史版本中回退）`)) return;
        pushUndoSnapshot(cur, { count, label: '清空全部说明' });
        cur.notes = {};
        await _callbacks.onMutation({ save: true });
        const lbl = modal.querySelector('#wbo-note-count-label');
        const btn = modal.querySelector('#wbo-clear-all-notes-btn');
        if (lbl) lbl.textContent = '当前共有 0 条备注说明';
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        showToast('success', `已清空 ${count} 条备注说明`);
    });

    modal.querySelector('#wbo-modal-export-btn')?.addEventListener('click', triggerConfigExport);
    // One footer button that opens a two-choice sheet, so touch devices work without hover:
    // 「复制简要诊断」 (Discord-friendly text) or 「下载详细诊断」 (a .txt file).
    // Both are structure-only — no book, character or group name ever leaves the user's machine.
    const closeDiagMenu = () => {
        const menu = document.getElementById('wbo-diag-menu');
        menu?.remove();
        document.removeEventListener('pointerdown', onDiagOutside, true);
    };
    const onDiagOutside = (event) => {
        const menu = document.getElementById('wbo-diag-menu');
        if (menu && event.target instanceof Node && menu.contains(event.target)) return;
        closeDiagMenu();
    };
    const copyShortDiagnostics = async () => {
        const text = (() => {
            try { return globalThis.window?.wboBuildDiagnostic?.('short') || ''; } catch { return ''; }
        })();
        if (!text) {
            showToast('warning', '诊断尚未就绪，请先打开一次世界书下拉再试');
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            showToast('success', '已复制简要诊断（约 10 行，不含任何书名）');
        } catch {
            console.log('[worldbook-organizer] 诊断\n' + text);
            showToast('warning', '自动复制失败，已打印到控制台');
        }
    };
    const downloadDetailedDiagnostics = () => {
        const text = (() => {
            try { return globalThis.window?.wboBuildDiagnostic?.('dev') || ''; } catch { return ''; }
        })();
        if (!text) {
            showToast('warning', '诊断尚未就绪，请先打开一次世界书下拉再试');
            return;
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `wbo-diagnostic-${stamp}.txt`;
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        showToast('success', '已生成详细诊断文件');
    };
    modal.querySelector('#wbo-modal-diag-btn')?.addEventListener('click', (event) => {
        const existing = document.getElementById('wbo-diag-menu');
        if (existing) {
            closeDiagMenu();
            return;
        }
        const anchor = event.currentTarget;
        if (!(anchor instanceof HTMLElement)) return;
        const rect = anchor.getBoundingClientRect();
        const menu = document.createElement('div');
        menu.id = 'wbo-diag-menu';
        menu.className = 'wbo-diag-menu';
        menu.innerHTML = `
            <button type="button" data-diag="dev" class="is-primary"><i class="fa-solid fa-file-arrow-down"></i> 下载详细诊断<span>推荐：生成 .txt，含完整运行环境与操作记录</span></button>
            <button type="button" data-diag="short"><i class="fa-solid fa-clipboard"></i> 复制简要诊断<span>约 10 行，可直接贴到 Discord</span></button>
            <div class="wbo-diag-menu-note">反馈请发到 Discord 帖子，或私聊 <b>niviskitten</b>；诊断不含任何书名 / 角色名</div>
        `;
        const maxLeft = Math.max(8, (globalThis.innerWidth || 1024) - 260);
        menu.style.left = `${Math.min(Math.max(8, rect.left), maxLeft)}px`;
        menu.style.bottom = `${Math.max(8, (globalThis.innerHeight || 768) - rect.top + 6)}px`;
        // The menu lives on <body>, outside the modal that defines the theme variables, so copy
        // the modal's own colours or it renders dark-on-dark in a light theme.
        const modalStyle = globalThis.getComputedStyle(modal);
        const surface = modalStyle.getPropertyValue('--wbo-surface').trim();
        const foreground = modalStyle.getPropertyValue('--wbo-fg').trim();
        const borderStrong = modalStyle.getPropertyValue('--wbo-border-strong').trim();
        if (surface) menu.style.background = surface;
        if (foreground) menu.style.color = foreground;
        if (borderStrong) menu.style.borderColor = borderStrong;
        document.body.append(menu);
        menu.addEventListener('click', (ev) => {
            const btn = ev.target instanceof Element ? ev.target.closest('[data-diag]') : null;
            if (!btn) return;
            ev.preventDefault();
            const kind = btn.getAttribute('data-diag');
            closeDiagMenu();
            if (kind === 'dev') downloadDetailedDiagnostics();
            else copyShortDiagnostics();
        });
        document.addEventListener('pointerdown', onDiagOutside, true);
    });
    modal.addEventListener('close', closeDiagMenu);
    const importInput = modal.querySelector('#wbo-modal-import-file');
    modal.querySelector('#wbo-modal-import-btn')?.addEventListener('click', () => {
        if (importInput instanceof HTMLInputElement) {
            importInput.value = '';
            importInput.click();
        }
    });
    importInput?.addEventListener('change', async () => {
        if (!(importInput instanceof HTMLInputElement) || !importInput.files?.[0]) return;
        await handleConfigImportFile(importInput.files[0]);
        if (_callbacks) {
            syncSettingControlsInPlace(modal, _callbacks.getState().settings);
            syncExcludeChips();
            syncThemeChips();
            syncQuickActionsModeUi();
            syncAllOpenModalsTheme();
        }
    });
    modal.querySelector('[data-open-import-rules]')?.addEventListener('click', () => openImportRulesModal({ stack: true }));

    // Explain the dropdown-beautify detection instead of silently hiding/showing the card.
    const renderEnhancedScriptStatus = () => {
        const signals = detectEnhancedScriptSignals();
        const mode = _callbacks?.getState?.().settings?.enhancedScriptMode || 'auto';
        const active = isEnhancedScriptActive();
        const statusEl = modal.querySelector('[data-enhanced-script-status]');
        const hintEl = modal.querySelector('[data-enhanced-script-hint]');
        const matched = [
            signals.scriptTree ? '脚本树' : '',
            signals.styleMarker ? '样式标记' : '',
            signals.runtimeDom ? '运行中的下拉' : '',
        ].filter(Boolean);
        if (statusEl) {
            statusEl.textContent = active
                ? `已识别（${mode === 'on' ? '手动指定' : matched.join(' + ') || '自动'}）`
                : '未识别';
        }
        if (hintEl) {
            hintEl.textContent = active
                ? '下面两项只在装了该脚本时才有意义；已识别的功能会按它自动适配。'
                : '没检测到该脚本。如果你确实装了但它较新、标记不同，可把「这个脚本在用吗」改成「当作已启用」强制适配。';
        }
    };
    renderEnhancedScriptStatus();
    modal.querySelector('select[data-setting-select="enhancedScriptMode"]')?.addEventListener('change', () => {
        setTimeout(renderEnhancedScriptStatus, 0);
    });
    modal.querySelector('#wbo-settings-close-btn')?.addEventListener('click', closeSubModal);
}

export { openSettingsModal };
