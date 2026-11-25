/** Character scan, worldbook coverage and embedded-book import. */

import { openCharacterBindingModal } from './panel-binding.js';

import {
    _callbacks,
    _previewCache,
    closeSubModal,
    createSubModal,
    esc,
} from './panel-window.js';
import {
    fetchFullCharacterOnDemand,
    fetchWorldbookPreviewEntries,
    flushWorldInfoListRefresh,
    getCharLoreEntries,
    getCharactersInMemory,
    getPowerUserSettings,
    getWorldNames,
    importEmbeddedWorldbookForCharacter,
    openCharacterByAvatar,
    saveSettings,
    scanShallowCharactersInBatches,
    showToast,
    unbindExtraWorldbookFromChar,
    unbindPrimaryWorldbookFromChar,
    unbindWorldbookFromPersona,
} from './host.js';
import {
    buildCharacterBindingIndex,
    compareWorldbookEntries,
    extractEmbeddedCharacterBookPreview,
    findCardsWithUnimportedBooks,
    findUnscannedShallowCharacters,
    summarizeCharacterWorldCoverage,
    summarizePersonaWorldBindings,
    updateCachedCharBindings,
} from './core.js';
import {
    closeManagerModal,
    confirmAndDeleteWorldbooks,
    setPreviewCache,
} from './panel-manager.js';
import { openBookEntryBrowserModal } from './panel-search.js';
import { openWorldInNativeEditor } from './native-filter.js';

function renderModifiedEntriesTable(rows, leftLabel, rightLabel) {
    if (!rows.length) return '';
    return `
        <div class="wbo-diff-mod">
            <div class="wbo-diff-col-head">同名但内容不同（${rows.length} 条）</div>
            <table class="wbo-diff-table">
                <thead><tr><th scope="col">条目名</th><th scope="col">${esc(leftLabel)}</th><th scope="col">${esc(rightLabel)}</th></tr></thead>
                <tbody>${rows.map(({ title, lenA, lenB }) => `
                    <tr><th scope="row">${esc(title)}</th><td>${lenA} 字</td><td>${lenB} 字</td></tr>
                `).join('')}</tbody>
            </table>
        </div>`;
}

function renderWorldbookDiff(drawer, diff, leftLabel, rightLabel) {
    const renderUnique = (label, entries) => `
        <div class="wbo-diff-col">
            <div class="wbo-diff-col-head">${esc(label)}独有（${entries.length} 条）</div>
            <div class="wbo-diff-chips">
                ${entries.length ? entries.map((entry, i) => `<span class="wbo-tag"${i >= 16 ? ' data-diff-extra hidden' : ''}>${esc(entry.title)}</span>`).join('') : '<span class="wbo-subtle-tip">无独有条目</span>'}
                ${entries.length > 16 ? `<button type="button" class="wbo-link-btn wbo-diff-more-btn" data-expand-diff-chips>展开其余 ${entries.length - 16} 条</button>` : ''}
            </div>
        </div>
    `;
    drawer.innerHTML = `
        <div class="wbo-preview-head wbo-cov-drawer-head">
            <b>对比结果</b>
            <button type="button" class="wbo-link-btn" data-close-cov-drawer>收起</button>
        </div>
        <div class="wbo-diff-summary">
            <span>条目相同 ${diff.sameCount} 条</span>
            <span>${esc(leftLabel)}独有 ${diff.onlyA.length} 条</span>
            <span>${esc(rightLabel)}独有 ${diff.onlyB.length} 条</span>
            <span>同名但内容不同 ${diff.modified.length} 条</span>
        </div>
        <div class="wbo-diff-grid">
            ${renderUnique(leftLabel, diff.onlyA)}
            ${renderUnique(rightLabel, diff.onlyB)}
        </div>
        ${renderModifiedEntriesTable(diff.modified, leftLabel, rightLabel)}
    `;
    drawer.querySelectorAll('[data-expand-diff-chips]').forEach((button) => {
        button.addEventListener('click', () => {
            button.closest('.wbo-diff-chips')?.querySelectorAll('[data-diff-extra]').forEach((entry) => { entry.hidden = false; });
            button.remove();
        });
    });
    drawer.querySelector('[data-close-cov-drawer]')?.addEventListener('click', () => {
        drawer.hidden = true;
        drawer.removeAttribute('data-drawer-key');
    });
    requestAnimationFrame(() => { try { drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch { /* ignore */ } });
}

/**
 * Unified Character Worldbook Scan modal with complete accounting for BOTH
 * fewer books (unbound / missing / shared) AND extra books (multi-book chars / orphan extra books).
 */
function openScanAndImportModal({ initialTab = '' } = {}) {
    if (!_callbacks) return;
    document.getElementById('wbo-mgr-scan-btn')?.blur?.();

    const sourceLabel = (s) => {
        if (s === 'primary') return '当前主绑';
        if (s === 'extra') return '额外附加（可能为通用书或旧版残留）';
        return '本地同名';
    };

    const matchReasonLabel = (m) => {
        if (m.reason === 'exact_name') return `与角色「${m.charName}」同名，但角色卡未绑定`;
        if (m.reason === 'unscanned_card_name') return `与未扫描角色卡「${m.charName}」同名`;
        return `与角色「${m.charName}」近似同名，但角色卡未绑定`;
    };

    const renderModalBody = () => {
        const { settings, classification } = _callbacks.getState();
        const characters = getCharactersInMemory();
        const worldNamesSet = new Set(getWorldNames([...classification.byName.keys()]));
        const bindingMap = buildCharacterBindingIndex({
            characters,
            charLore: getCharLoreEntries(),
            cachedCharBindings: settings.cachedCharBindings,
            worldNamesSet,
            includeExtraCharBooks: true,
            includeEmbeddedNameMatch: true,
        });
        const unscannedShallow = findUnscannedShallowCharacters(characters, settings.cachedCharBindings);
        const unimported = findCardsWithUnimportedBooks({
            characters,
            worldNamesSet,
            cachedCharBindings: settings.cachedCharBindings,
        });
        const coverage = summarizeCharacterWorldCoverage({
            characters,
            bindingMap: bindingMap || new Map(),
            worldNamesSet,
            cachedCharBindings: settings.cachedCharBindings,
            settings,
        });
        const personaSummary = summarizePersonaWorldBindings({
            powerUserSettings: getPowerUserSettings(),
            worldNamesSet,
            bindingMap: bindingMap || new Map(),
        });

        const scanBtnLabel = unscannedShallow.length > 0
            ? `开始扫描角色卡（含 ${unscannedShallow.length} 张未加载）`
            : '重新扫描角色卡';

        const charJumpBtn = (avatar, name) =>
            `<button type="button" class="wbo-jump-link" data-jump-char="${esc(avatar)}" title="跳转到角色卡「${esc(name)}」">${esc(name)}</button>`;
        const worldChipHtml = (worldName, {
            suffix = '',
            unbindExtraKey = '',
            unbindExtraLabel = '',
            roleText = '',
            unbindKind = '',
            unbindTarget = '',
        } = {}) => `
            <span class="wbo-cov-chip-group">
                <button type="button" class="wbo-jump-link is-world" data-jump-world="${esc(worldName)}" data-cov-role-text="${esc(roleText)}" data-cov-unbind-kind="${esc(unbindKind)}" data-cov-unbind-target="${esc(unbindTarget)}" title="点击查看此世界书的操作选项">${esc(worldName)}${suffix ? `<small>${esc(suffix)}</small>` : ''}</button>
                <button type="button" class="wbo-cov-mini-btn" data-cov-preview="${esc(worldName)}" title="原地预览此世界书条目"><i class="fa-regular fa-eye"></i></button>
                ${unbindExtraKey ? `<button type="button" class="wbo-cov-mini-btn is-danger" data-cov-unbind-extra="${esc(unbindExtraKey)}" data-cov-world="${esc(worldName)}" title="${esc(unbindExtraLabel || '解除此附加世界书绑定')}"><i class="fa-solid fa-xmark"></i></button>` : ''}
            </span>
        `;

        /** @type {Array<{ key: string, label: string, count: number, rowsHtml: string }>} */
        const covTabs = [];

        const renderCovTable = (rowsHtml, subjectColLabel = '角色名') => `
            <div class="wbo-cov-table-head">
                <span>${esc(subjectColLabel)}</span>
                <span>世界书</span>
            </div>
            <div class="wbo-cov-table-body">${rowsHtml}</div>
        `;

        const overrides = settings.charBookOverrides || {};
        const unboundMatches = coverage.unboundNameMatches || [];
        const embeddedMatches = (coverage.embeddedNameMatches || []).filter((m) => {
            const ov = overrides[m?.worldName];
            return ov !== 'include_in_char' && ov !== 'exclude_from_char';
        });
        const unboundChars = coverage.unboundChars.filter((character) => !character.shallow);
        const totalSameNameCount = new Set([...unboundMatches, ...embeddedMatches].map((match) => match.worldName)).size;

        if (totalSameNameCount > 0) {
            const primaryByAvatar = new Map();
            for (const [world, owners] of bindingMap) {
                for (const owner of owners) if (owner.source === 'primary' && !owner.orphan) primaryByAvatar.set(owner.avatar, world);
            }
            const rows = [
                ...unboundMatches.map((match) => ({ ...match, kind: 'unbound' })),
                ...embeddedMatches.map((match) => ({ ...match, kind: 'embedded' })),
            ].sort((a, b) => a.charName.localeCompare(b.charName, 'zh-CN') || a.avatar.localeCompare(b.avatar) || a.worldName.localeCompare(b.worldName, 'zh-CN'));
            const rowsHtml = rows.map((m) => {
                const embedded = m.kind === 'embedded';
                const primary = primaryByAvatar.get(m.avatar);
                const reason = embedded ? '本地同名' : matchReasonLabel(m);
                const compareButton = primary
                    ? `<button type="button" class="wbo-cov-action-pill" data-cov-diff="${esc(JSON.stringify([primary, m.worldName]))}" data-cov-same-compare>对比差异</button>`
                    : embedded
                        ? `<button type="button" class="wbo-cov-action-pill" data-cov-emb-diff="${esc(m.avatar)}" data-cov-emb-world="${esc(m.worldName)}">对比差异</button>`
                        : '';
                return `
                <div class="wbo-cov-row-wrap wbo-cov-match-card">
                    <div class="wbo-cov-row">
                        <div class="wbo-cov-subject">
                            ${charJumpBtn(m.avatar, m.charName)}
                        </div>
                        <div class="wbo-cov-targets">
                            ${worldChipHtml(m.worldName, { roleText: reason })}
                        </div>
                    </div>
                    <div class="wbo-cov-match-actions">
                        <button type="button" class="wbo-cov-action-pill is-primary" data-cov-assign-char="${esc(m.worldName)}" data-cov-match-kind="${m.kind}">归入角色世界书</button>
                        <button type="button" class="wbo-cov-action-pill" data-cov-bind-avatar="${esc(m.avatar)}" data-cov-bind-book="${esc(m.worldName)}">去绑定</button>
                        ${compareButton}
                        <button type="button" class="wbo-cov-action-pill is-danger" data-cov-delete-book="${esc(m.worldName)}">删除</button>
                    </div>
                    <div class="wbo-cov-drawer" hidden></div>
                </div>
                `;
            }).join('');

            covTabs.push({
                key: 'same_name',
                label: '同名待归类',
                count: totalSameNameCount,
                rowsHtml: `
                    <div class="wbo-cov-same-name-alert">
                        <p>以下 <b>${totalSameNameCount}</b> 本世界书与角色卡绑定的世界书同名或相近，但没有绑定到角色卡。</p>
                        <p>原因可能是角色的旧版本世界书、角色卡未扫描，或需要手动绑定到对应角色。</p>
                        <p>目前暂未自动归入「角色世界书」，确认属于角色时可一键归类。</p>
                    </div>
                    ${renderCovTable(rowsHtml, '角色名')}
                `,
            });
        }

        if (coverage.multiBookChars.length > 0) {
            covTabs.push({
                key: 'multi',
                label: '多本书角色',
                count: coverage.multiBookChars.length,
                rowsHtml: renderCovTable(coverage.multiBookChars.map((c) => {
                    const bookNamesJson = JSON.stringify(c.books.map((b) => b.worldName));
                    const primaryBook = c.books.find((b) => b.source === 'primary')?.worldName || '';
                    return `
                        <div class="wbo-cov-row-wrap">
                            <div class="wbo-cov-row">
                                <div class="wbo-cov-subject">
                                    ${charJumpBtn(c.avatar, c.charName)}
                                    ${c.books.length >= 2 ? `<button type="button" class="wbo-cov-action-pill" data-cov-diff="${esc(bookNamesJson)}" title="对比这些世界书的条目差异">对比差异</button>` : ''}
                                </div>
                                <div class="wbo-cov-targets">
                                    ${c.books.map((b) => {
                                        const roleText = b.source === 'primary'
                                            ? `此书为角色「${c.charName}」的当前主绑世界书`
                                            : `此书为角色「${c.charName}」的额外附加绑定${primaryBook ? `（该角色另有主绑书「${primaryBook}」）` : ''}`;
                                        return worldChipHtml(b.worldName, {
                                            suffix: sourceLabel(b.source),
                                            unbindExtraKey: b.source === 'extra' ? c.avatar : '',
                                            unbindExtraLabel: `解除「${c.charName}」的附加世界书「${b.worldName}」`,
                                            roleText,
                                            unbindKind: b.source === 'extra' ? 'extra' : '',
                                            unbindTarget: b.source === 'extra' ? c.avatar : '',
                                        });
                                    }).join('')}
                                </div>
                            </div>
                            <div class="wbo-cov-drawer" hidden></div>
                        </div>
                    `;
                }).join(''), '角色名'),
            });
        }
        if (coverage.sharedBooks.length > 0) {
            const rowsHtml = coverage.sharedBooks.map((s) => `
                <div class="wbo-cov-row-wrap">
                    <div class="wbo-cov-row">
                        <div class="wbo-cov-subject">
                            ${(s.owners || []).map((o) => charJumpBtn(o.avatar, o.charName)).join('')}
                        </div>
                        <div class="wbo-cov-targets">
                            ${worldChipHtml(s.worldName, {
                                suffix: `${(s.owners || []).length}卡共用`,
                                roleText: `此书被 ${(s.owners || []).map((o) => `「${o.charName}」`).join('、')} 共用`,
                            })}
                        </div>
                    </div>
                    <div class="wbo-cov-drawer" hidden></div>
                </div>
            `).join('');
            covTabs.push({
                key: 'shared',
                label: '多卡共用书',
                count: coverage.sharedBooks.length,
                rowsHtml: `
                    <p class="wbo-cov-pane-note">多张角色卡共用了同一本世界书。</p>
                    ${renderCovTable(rowsHtml, '角色名')}
                `,
            });
        }
        if (unboundChars.length > 0) {
            covTabs.push({
                key: 'unbound',
                label: '未绑定世界书的角色',
                count: unboundChars.length,
                rowsHtml: `
                    <table class="wbo-cov-unbound-table">
                        <thead><tr><th scope="col">角色名</th><th scope="col">状态</th></tr></thead>
                        <tbody>${unboundChars.map((character) => `
                            <tr><th scope="row">${charJumpBtn(character.avatar, character.charName)}</th><td>未绑定</td></tr>
                        `).join('')}</tbody>
                    </table>`,
            });
        }
        if (personaSummary.totalBoundCount > 0) {
            covTabs.push({
                key: 'persona',
                label: 'User 人设绑定',
                count: personaSummary.totalBoundCount,
                rowsHtml: `
                    ${personaSummary.anomalyCount > 0 ? `
                        <div class="wbo-cov-orphan-bar">
                            <span>发现 ${personaSummary.missingPersonaBindings.length} 项人设缺失世界书、${personaSummary.personaCharCrossBindings.length} 项与角色卡交叉绑定，请核对是否需要清理。</span>
                        </div>
                    ` : ''}
                    ${renderCovTable(personaSummary.personaBindings.map((pb) => {
                        const charCrossBadge = pb.charOwners.length > 0
                            ? `<span class="wbo-cov-subject-badge is-char">交叉角色：${esc(pb.charOwners.map((o) => o.charName).join('、'))}</span>`
                            : '';
                        const roleText = pb.charOwners.length > 0
                            ? `此书被 User 人设「${pb.personaName}」绑定，同时也被角色卡「${pb.charOwners.map((o) => o.charName).join('、')}」绑定`
                            : `此书为 User 人设「${pb.personaName}」的当前绑定世界书`;
                        return `
                            <div class="wbo-cov-row-wrap">
                                <div class="wbo-cov-row">
                                    <div class="wbo-cov-subject">
                                        <span class="wbo-cov-persona-name">${esc(pb.personaName)}</span>
                                    </div>
                                    <div class="wbo-cov-targets">
                                        ${pb.missing ? `
                                            <span class="wbo-cov-missing">缺失：${esc(pb.worldName)}</span>
                                            <button type="button" class="wbo-cov-action-pill is-danger" data-cov-clear-persona="${esc(pb.pid)}" data-cov-persona-world="${esc(pb.worldName)}" data-cov-persona-name="${esc(pb.personaName)}" title="清除人设上已失效的世界书引用">清除失效绑定</button>
                                        ` : `
                                            ${worldChipHtml(pb.worldName, {
                                                suffix: pb.charOwners.length > 0 ? '人设+角色交叉' : '',
                                                roleText,
                                                unbindKind: 'persona',
                                                unbindTarget: pb.pid,
                                            })}
                                            ${charCrossBadge}
                                        `}
                                    </div>
                                </div>
                                <div class="wbo-cov-drawer" hidden></div>
                            </div>
                        `;
                    }).join(''), '人设名称')}
                `,
            });
        }
        if (coverage.missingFileChars.length > 0) {
            covTabs.push({
                key: 'missing',
                label: '文件缺失',
                count: coverage.missingFileChars.length,
                rowsHtml: renderCovTable(coverage.missingFileChars.map((c) => `
                    <div class="wbo-cov-row">
                        <div class="wbo-cov-subject">
                            ${charJumpBtn(c.avatar, c.charName)}
                        </div>
                        <div class="wbo-cov-targets">
                            <span class="wbo-cov-missing">缺失：${esc(c.missingWorld)}</span>
                            <span class="wbo-cov-reason">请回角色的发布处找，导入后再绑定。</span>
                            <button type="button" class="wbo-cov-action-pill is-danger" data-cov-clear-missing="${esc(c.avatar)}" data-cov-char-name="${esc(c.charName)}" title="清除角色卡上已失效的主世界书引用">清除失效绑定</button>
                        </div>
                    </div>
                `).join(''), '角色名'),
            });
        }
        if (coverage.orphanExtraBooks.length > 0) {
            covTabs.push({
                key: 'orphan',
                label: '残留附加书',
                count: coverage.orphanExtraBooks.length,
                rowsHtml: `
                    <div class="wbo-cov-orphan-bar">
                        <span>这些附加绑定对应的角色卡已删除，可直接解除残留绑定（不会删除世界书本体）。</span>
                        <button type="button" class="wbo-cov-action-pill is-danger" id="wbo-cov-clear-all-orphans">一键清理全部 (${coverage.orphanExtraBooks.length})</button>
                    </div>
                    ${renderCovTable(coverage.orphanExtraBooks.map((o) => `
                        <div class="wbo-cov-row-wrap">
                            <div class="wbo-cov-row">
                                <div class="wbo-cov-subject">
                                    <span class="wbo-cov-missing">${esc(o.charName)}（已删）</span>
                                </div>
                                <div class="wbo-cov-targets">
                                    ${worldChipHtml(o.worldName, {
                                        suffix: '额外附加（旧版残留）',
                                        unbindExtraKey: o.charKey || o.charName,
                                        unbindExtraLabel: `清理已删角色「${o.charName}」对「${o.worldName}」的残留绑定`,
                                        roleText: `此书为已删除角色「${o.charName}」的残留附加绑定，可安全解除`,
                                        unbindKind: 'extra',
                                        unbindTarget: o.charKey || o.charName,
                                    })}
                                </div>
                            </div>
                            <div class="wbo-cov-drawer" hidden></div>
                        </div>
                    `).join(''), '角色名')}
                `,
            });
        }
        const totalDiffItems = covTabs.reduce((acc, t) => acc + t.count, 0);
        const firstTabKey = (initialTab && covTabs.some((t) => t.key === initialTab))
            ? initialTab
            : (covTabs[0]?.key || '');
        const overviewSummary = covTabs.length > 0
            ? covTabs.map((t) => `${t.label} ${t.count}`).join(' · ')
            : '所有角色卡与世界书一一对应，未发现异常。';

        const coverageHtml = covTabs.length > 0
            ? `
                <div class="wbo-card wbo-cov-panel">
                    <div class="wbo-ai-section-head">
                        <span>对应明细 · 共 ${totalDiffItems} 项记录</span>
                        <span class="wbo-subtle-tip">点击世界书查看操作选项</span>
                    </div>
                    <div class="wbo-cov-tab-bar">
                        ${covTabs.map((t) => `
                            <button type="button" class="wbo-pill${t.key === firstTabKey ? ' is-active' : ''}" data-cov-tab="${esc(t.key)}">
                                <span>${esc(t.label)}</span><span class="wbo-pill-count">${t.count}</span>
                            </button>
                        `).join('')}
                    </div>
                    <div class="wbo-cov-panes">
                        ${covTabs.map((t) => `
                            <div class="wbo-cov-pane" data-cov-pane="${esc(t.key)}"${t.key === firstTabKey ? '' : ' hidden'}>
                                ${t.rowsHtml}
                            </div>
                        `).join('')}
                    </div>
                </div>
            `
            : `<div class="wbo-cov-overview">${esc(overviewSummary)}</div>`;

        const unimportedSection = unimported.length > 0
            ? `
                <div class="wbo-field">
                    <div class="wbo-ai-section-head">
                        <span>发现 ${unimported.length} 本尚未导入的卡内世界书</span>
                    </div>
                    <div class="wbo-ai-book-list">
                        ${unimported.map((item) => `
                            <label class="wbo-ai-pick-row">
                                <input type="checkbox" class="wbo-import-book-check" value="${esc(item.avatar)}" checked>
                                <span class="wbo-ai-pick-name">
                                    <b>${esc(item.charName)}</b>
                                    <small>→ ${esc(item.importName)} · ${item.entryCount} 条</small>
                                </span>
                            </label>
                        `).join('')}
                    </div>
                    <div class="wbo-ai-actions-row">
                        <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-import-selected-books-btn">
                            <i class="fa-solid fa-file-import"></i> 导入选中世界书
                        </button>
                    </div>
                </div>
            `
            : '';

        return `
            <div class="wbo-step-scroll">
            <div class="wbo-scan-summary">
                <span>角色卡：<b>${characters.length}</b> 张</span>
                <span>已识别角色世界书：<b>${classification.charCount}</b> 本</span>
                ${unboundChars.length > 0 ? `<button type="button" class="wbo-link-btn" data-cov-open-unbound>未绑定世界书的角色：<b>${unboundChars.length}</b> 张</button>` : ''}
                <span>User 人设绑定：<b>${personaSummary.totalBoundCount}</b> 项${personaSummary.anomalyCount > 0 ? `（异常 ${personaSummary.anomalyCount}）` : ''}</span>
                ${unscannedShallow.length > 0 ? `<span>待扫描：<b>${unscannedShallow.length}</b> 张</span>` : ''}
            </div>

            <div class="wbo-ai-actions-row">
                <button type="button" class="wbo-btn wbo-btn-primary" id="wbo-scan-all-btn">
                    <i class="fa-solid fa-magnifying-glass"></i> ${esc(scanBtnLabel)}
                </button>
            </div>
            <div class="wbo-ai-status wbo-scan-top-status" id="wbo-scan-status" hidden></div>

            ${coverageHtml}
            ${unimportedSection}
            </div>

            <div class="wbo-modal-footer wbo-pinned-footer">
                <button type="button" class="wbo-btn" id="wbo-scan-close-btn">关闭</button>
            </div>
        `;
    };

    const { modal } = createSubModal('扫描角色世界书', renderModalBody(), { wide: true, pinnedLayout: true });
    const cancelSignal = { cancelled: false };

    const bindHandlers = () => {
        const statusEl = modal.querySelector('#wbo-scan-status');
        const setStatus = (msg, state = false) => {
            const kind = state === true ? 'error' : (state === 'error' || state === 'success' ? state : 'info');
            const cls = `wbo-ai-status wbo-scan-top-status${kind === 'error' ? ' is-error' : (kind === 'success' ? ' is-success' : '')}`;
            if (statusEl instanceof HTMLElement) {
                statusEl.textContent = msg;
                statusEl.className = cls;
                statusEl.hidden = !msg;
            }
        };

        const rerenderScanBody = (activeTabKey = '', statusMsg = '', statusKind = 'success') => {
            const body = modal.querySelector('.wbo-modal-body');
            if (!body) return;
            body.innerHTML = renderModalBody();
            bindHandlers();
            if (activeTabKey) {
                const tabBtn = modal.querySelector(`[data-cov-tab="${CSS.escape(activeTabKey)}"]`);
                if (tabBtn instanceof HTMLElement) tabBtn.click();
            }
            if (statusMsg) {
                const kind = statusKind === true ? 'error' : (statusKind === 'error' || statusKind === 'success' ? statusKind : 'info');
                const cls = `wbo-ai-status wbo-scan-top-status${kind === 'error' ? ' is-error' : (kind === 'success' ? ' is-success' : '')}`;
                const nextStatus = modal.querySelector('#wbo-scan-status');
                if (nextStatus instanceof HTMLElement) {
                    nextStatus.textContent = statusMsg;
                    nextStatus.className = cls;
                    nextStatus.hidden = false;
                }
            }
        };

        const getActiveCovTabKey = () =>
            modal.querySelector('[data-cov-tab].is-active')?.getAttribute('data-cov-tab') || '';

        modal.querySelector('[data-cov-open-unbound]')?.addEventListener('click', () => {
            const tab = modal.querySelector('[data-cov-tab="unbound"]');
            tab?.click();
            tab?.scrollIntoView?.({ block: 'nearest' });
        });

        modal.querySelector('#wbo-scan-close-btn')?.addEventListener('click', () => {
            cancelSignal.cancelled = true;
            closeSubModal();
        });

        modal.querySelectorAll('[data-cov-tab]').forEach((tabBtn) => {
            tabBtn.addEventListener('click', () => {
                const key = tabBtn.getAttribute('data-cov-tab');
                if (!key) return;
                modal.querySelectorAll('[data-cov-tab]').forEach((b) => {
                    b.classList.toggle('is-active', b.getAttribute('data-cov-tab') === key);
                });
                modal.querySelectorAll('[data-cov-pane]').forEach((pane) => {
                    if (pane instanceof HTMLElement) {
                        pane.hidden = pane.getAttribute('data-cov-pane') !== key;
                    }
                });
            });
        });

        // On-demand inline entry preview inside Scan coverage rows
        modal.querySelectorAll('[data-cov-preview]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const worldName = btn.getAttribute('data-cov-preview');
                const wrap = btn.closest('.wbo-cov-row-wrap');
                const drawer = wrap?.querySelector('.wbo-cov-drawer');
                if (!worldName || !(drawer instanceof HTMLElement)) return;
                const key = `preview:${worldName}`;
                if (!drawer.hidden && drawer.getAttribute('data-drawer-key') === key) {
                    drawer.hidden = true;
                    drawer.removeAttribute('data-drawer-key');
                    return;
                }
                drawer.setAttribute('data-drawer-key', key);
                drawer.hidden = false;
                drawer.innerHTML = `<div class="wbo-preview-loading">正在读取「${esc(worldName)}」条目...</div>`;
                try {
                    const data = _previewCache.has(worldName)
                        ? _previewCache.get(worldName)
                        : await fetchWorldbookPreviewEntries(worldName);
                    setPreviewCache(worldName, data);
                    if (!drawer.isConnected || drawer.getAttribute('data-drawer-key') !== key) return;
                    const shown = (data?.entries || []).slice(0, 20);
                    const itemsHtml = shown.length > 0
                        ? shown.map((e) => `
                            <details class="wbo-preview-entry${e.disabled ? ' is-disabled' : ''}">
                                <summary class="wbo-preview-entry-head">
                                    <i class="fa-solid fa-chevron-right wbo-details-chev"></i>
                                    <span class="wbo-preview-entry-title">${esc(e.title)}</span>
                                    <span class="wbo-preview-entry-badges">${e.constant ? '<span class="wbo-entry-badge is-const">常驻</span>' : ''}${e.disabled ? '<span class="wbo-entry-badge is-off">禁用</span>' : ''}</span>
                                </summary>
                                <div class="wbo-preview-entry-content${e.content ? '' : ' is-empty'}">${esc(e.content || '正文为空')}</div>
                            </details>
                        `).join('')
                        : '<div class="wbo-preview-loading">该世界书暂无条目</div>';
                    drawer.innerHTML = `
                        <div class="wbo-preview-head">
                            <span><b>${esc(worldName)}</b> · 共 ${data?.total || 0} 条（启用 ${data?.enabledCount || 0} 条）</span>
                            <button type="button" class="wbo-link-btn" data-close-cov-drawer>收起</button>
                        </div>
                        <div class="wbo-preview-list">${itemsHtml}</div>
                        ${(data?.total || 0) > shown.length ? `<div class="wbo-preview-more">仅展示前 ${shown.length} 条，点书名可在编辑器查看全部</div>` : ''}
                    `;
                    drawer.querySelector('[data-close-cov-drawer]')?.addEventListener('click', () => {
                        drawer.hidden = true;
                        drawer.removeAttribute('data-drawer-key');
                    });
                } catch (err) {
                    drawer.innerHTML = `<div class="wbo-preview-loading">读取失败：${esc(err?.message || err)}</div>`;
                }
            });
        });

        // On-demand 2-book entry diff inside Multi-book character rows
        modal.querySelectorAll('[data-cov-diff]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const rawJson = btn.getAttribute('data-cov-diff');
                const wrap = btn.closest('.wbo-cov-row-wrap');
                const drawer = wrap?.querySelector('.wbo-cov-drawer');
                if (!rawJson || !(drawer instanceof HTMLElement)) return;
                let names = [];
                try { names = JSON.parse(rawJson); } catch { return; }
                if (!Array.isArray(names) || names.length < 2) return;
                const [bookA, bookB] = names;
                const sameNameComparison = btn.hasAttribute('data-cov-same-compare');
                const key = `diff:${bookA}||${bookB}`;
                if (!drawer.hidden && drawer.getAttribute('data-drawer-key') === key) {
                    drawer.hidden = true;
                    drawer.removeAttribute('data-drawer-key');
                    return;
                }
                drawer.setAttribute('data-drawer-key', key);
                drawer.hidden = false;
                drawer.innerHTML = `<div class="wbo-preview-loading">正在对比「${esc(bookA)}」与「${esc(bookB)}」...</div>`;
                try {
                    const [dataA, dataB] = await Promise.all([
                        fetchWorldbookPreviewEntries(bookA, { forComparison: true }),
                        fetchWorldbookPreviewEntries(bookB, { forComparison: true }),
                    ]);
                    if (!drawer.isConnected || drawer.getAttribute('data-drawer-key') !== key) return;
                    const diff = compareWorldbookEntries(dataA?.entries || [], dataB?.entries || []);
                    renderWorldbookDiff(
                        drawer,
                        diff,
                        sameNameComparison ? '角色卡绑定的世界书' : `「${bookA}」`,
                        sameNameComparison ? '同名未绑定的世界书' : `「${bookB}」`,
                    );
                } catch (err) {
                    drawer.innerHTML = `<div class="wbo-preview-loading">对比失败：${esc(err?.message || err)}</div>`;
                }
            });
        });

        // On-demand embedded character_book vs local worldbook diff inside Embedded Name Matches rows
        modal.querySelectorAll('[data-cov-emb-diff]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const avatar = btn.getAttribute('data-cov-emb-diff') || '';
                const embWorld = btn.getAttribute('data-cov-emb-world') || '';
                const wrap = btn.closest('.wbo-cov-row-wrap');
                const drawer = wrap?.querySelector('.wbo-cov-drawer');
                if (!avatar || !embWorld || !(drawer instanceof HTMLElement)) return;
                const key = `embdiff:${avatar}||${embWorld}`;
                if (!drawer.hidden && drawer.getAttribute('data-drawer-key') === key) {
                    drawer.hidden = true;
                    drawer.removeAttribute('data-drawer-key');
                    return;
                }
                drawer.setAttribute('data-drawer-key', key);
                drawer.hidden = false;
                drawer.innerHTML = `<div class="wbo-preview-loading">正在对比卡内世界书与本地「${esc(embWorld)}」...</div>`;
                try {
                    const [charObj, localData] = await Promise.all([
                        fetchFullCharacterOnDemand(avatar, { allowUnshallow: false }),
                        fetchWorldbookPreviewEntries(embWorld, { forComparison: true }),
                    ]);
                    if (!drawer.isConnected || drawer.getAttribute('data-drawer-key') !== key) return;
                    const embPreview = extractEmbeddedCharacterBookPreview(charObj, Infinity);
                    if (!embPreview) {
                        drawer.innerHTML = '<div class="wbo-preview-loading">未能读取该角色卡的内嵌世界书条目</div>';
                        return;
                    }
                    const diff = compareWorldbookEntries(embPreview.entries || [], localData?.entries || []);
                    renderWorldbookDiff(drawer, diff, '角色卡内嵌世界书', '同名未绑定的世界书');
                } catch (err) {
                    drawer.innerHTML = `<div class="wbo-preview-loading">对比失败：${esc(err?.message || err)}</div>`;
                }
            });
        });

        // Direct 1-click clear broken User Persona worldbook reference (missing file)
        modal.querySelectorAll('[data-cov-clear-persona]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const pid = btn.getAttribute('data-cov-clear-persona') || '';
                const worldName = btn.getAttribute('data-cov-persona-world') || '';
                const personaName = btn.getAttribute('data-cov-persona-name') || pid;
                if (!pid) return;
                if (!globalThis.confirm(`确认清除 User 人设「${personaName}」对已缺失世界书「${worldName}」的绑定？`)) return;
                const tabKey = getActiveCovTabKey();
                const res = await unbindWorldbookFromPersona(pid, worldName);
                if (!res.ok) {
                    setStatus(`清除失败：${res.error || '未知错误'}`, 'error');
                    return;
                }
                await _callbacks.onRescan();
                showToast('success', `已清除 User 人设「${personaName}」的失效世界书绑定`);
                rerenderScanBody(tabKey, `已清除 User 人设「${personaName}」的失效世界书绑定`, 'success');
            });
        });

        // Direct 1-click unbind extra worldbook (works for both Multi-book chars AND Orphan extras!)
        modal.querySelectorAll('[data-cov-unbind-extra]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const charKey = btn.getAttribute('data-cov-unbind-extra') || '';
                const worldName = btn.getAttribute('data-cov-world') || '';
                if (!charKey || !worldName) return;
                if (!globalThis.confirm(`确认解除附加世界书「${worldName}」的绑定？\n（仅解除绑定，世界书文件不会被删除）`)) return;
                const tabKey = getActiveCovTabKey();
                const res = await unbindExtraWorldbookFromChar(charKey, worldName);
                if (!res.ok) {
                    setStatus(`解除失败：${res.error || '未知错误'}`, 'error');
                    return;
                }
                await _callbacks.onRescan();
                showToast('success', `已解除附加世界书「${worldName}」的绑定`);
                rerenderScanBody(tabKey, `已解除附加世界书「${worldName}」的绑定`, 'success');
            });
        });

        // Batch clear all orphan extra bindings
        modal.querySelector('#wbo-cov-clear-all-orphans')?.addEventListener('click', async () => {
            const buttons = Array.from(modal.querySelectorAll('[data-cov-pane="orphan"] [data-cov-unbind-extra]'));
            if (buttons.length === 0) return;
            if (!globalThis.confirm(`确认清理全部 ${buttons.length} 条已删角色的残留附加绑定？\n（仅解除绑定，世界书文件不会被删除）`)) return;
            let cleared = 0;
            for (const b of buttons) {
                const charKey = b.getAttribute('data-cov-unbind-extra') || '';
                const worldName = b.getAttribute('data-cov-world') || '';
                const res = await unbindExtraWorldbookFromChar(charKey, worldName, { deferSave: true });
                if (res.ok) cleared += 1;
            }
            if (cleared > 0) {
                saveSettings();
            }
            await _callbacks.onRescan();
            showToast('success', `已清理 ${cleared} 条残留附加绑定`);
            rerenderScanBody('orphan', `已清理 ${cleared} 条残留附加绑定`, 'success');
        });

        // Direct 1-click clear broken primary worldbook reference (missing file)
        modal.querySelectorAll('[data-cov-clear-missing]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const avatar = btn.getAttribute('data-cov-clear-missing') || '';
                const charName = btn.getAttribute('data-cov-char-name') || avatar;
                if (!avatar) return;
                if (!globalThis.confirm(`确认清除角色「${charName}」上已失效的主世界书引用？`)) return;
                const tabKey = getActiveCovTabKey();
                const { settings } = _callbacks.getState();
                const res = await unbindPrimaryWorldbookFromChar(avatar, settings);
                if (!res.ok) {
                    setStatus(`清除失败：${res.error || '未知错误'}`, 'error');
                    return;
                }
                await _callbacks.onRescan();
                showToast('success', `已清除「${charName}」的失效世界书绑定`);
                rerenderScanBody(tabKey, `已清除「${charName}」的失效世界书绑定`, 'success');
            });
        });

        modal.querySelectorAll('[data-cov-bind-avatar]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const worldName = btn.getAttribute('data-cov-bind-book');
                if (!worldName) return;
                const tabKey = getActiveCovTabKey();
                openCharacterBindingModal(worldName, {
                    suggestedAvatar: btn.getAttribute('data-cov-bind-avatar'),
                    onBound: () => { if (modal.isConnected) rerenderScanBody(tabKey); },
                    stack: true,
                });
            });
        });

        modal.querySelectorAll('[data-cov-delete-book]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const worldName = btn.getAttribute('data-cov-delete-book');
                if (!worldName) return;
                const tabKey = getActiveCovTabKey();
                void confirmAndDeleteWorldbooks([worldName], {
                    stack: true,
                    onComplete: ({ deleted }) => {
                        if (modal.isConnected && deleted.includes(worldName)) rerenderScanBody(tabKey, `已删除「${worldName}」`);
                    },
                });
            });
        });

        modal.querySelectorAll('[data-cov-assign-char]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const worldName = btn.getAttribute('data-cov-assign-char') || '';
                if (!worldName || !_callbacks) return;
                const matchKind = btn.getAttribute('data-cov-match-kind') || '';
                const tabKey = getActiveCovTabKey();
                const { settings: curSettings, classification: curCls } = _callbacks.getState();
                const meta = curCls.byName.get(worldName);
                const hasRealBinding = Boolean(
                    (meta?.charOwners || []).some((o) => o && o.source !== 'embedded'),
                );
                curSettings.charBookOverrides ||= {};
                if (matchKind !== 'embedded' && hasRealBinding) {
                    delete curSettings.charBookOverrides[worldName];
                } else {
                    curSettings.charBookOverrides[worldName] = 'include_in_char';
                }
                delete curSettings.assignments[worldName];
                await _callbacks.onMutation({ save: true });
                showToast('success', `已将「${worldName}」归入「角色世界书」`);
                rerenderScanBody(tabKey, `已将「${worldName}」归入「角色世界书」`, 'success');
            });
        });

        modal.querySelectorAll('[data-jump-char]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const avatar = btn.getAttribute('data-jump-char');
                if (!avatar) return;
                cancelSignal.cancelled = true;
                closeSubModal({ all: true });
                closeManagerModal();
                const ok = await openCharacterByAvatar(avatar);
                if (!ok) showToast('warning', '未能定位该角色卡');
            });
        });

        modal.querySelectorAll('[data-jump-world]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const worldName = btn.getAttribute('data-jump-world');
                if (!worldName) return;
                const wrap = btn.closest('.wbo-cov-row-wrap');
                const drawer = wrap?.querySelector('.wbo-cov-drawer');
                if (!(drawer instanceof HTMLElement)) {
                    openBookEntryBrowserModal(worldName, { stack: true });
                    return;
                }
                const key = `actions:${worldName}`;
                if (!drawer.hidden && drawer.getAttribute('data-drawer-key') === key) {
                    drawer.hidden = true;
                    drawer.removeAttribute('data-drawer-key');
                    return;
                }
                const roleText = btn.getAttribute('data-cov-role-text') || `世界书「${worldName}」`;
                const unbindKind = btn.getAttribute('data-cov-unbind-kind') || '';
                const unbindTarget = btn.getAttribute('data-cov-unbind-target') || '';
                const canUnbind = (unbindKind === 'extra' || unbindKind === 'persona') && unbindTarget;

                drawer.setAttribute('data-drawer-key', key);
                drawer.hidden = false;
                drawer.innerHTML = `
                    <div class="wbo-cov-action-strip">
                        <div class="wbo-cov-action-head">
                            <span class="wbo-cov-role-note">${esc(roleText)}</span>
                            <button type="button" class="wbo-link-btn" data-close-cov-drawer>收起</button>
                        </div>
                        <div class="wbo-cov-action-btns">
                            <button type="button" class="wbo-btn wbo-btn-primary" data-cov-inplugin-edit="${esc(worldName)}">
                                <i class="fa-regular fa-pen-to-square"></i> 插件内查看/编辑条目
                            </button>
                            <button type="button" class="wbo-btn" data-cov-native-edit="${esc(worldName)}">
                                <i class="fa-solid fa-arrow-up-right-from-square"></i> 跳去原生编辑器
                            </button>
                            ${canUnbind ? `
                                <button type="button" class="wbo-btn wbo-btn-danger" data-cov-strip-unbind="${esc(unbindKind)}" data-cov-strip-target="${esc(unbindTarget)}" data-cov-world="${esc(worldName)}">
                                    <i class="fa-solid fa-link-slash"></i> 直接解除此绑定
                                </button>
                            ` : ''}
                        </div>
                    </div>
                `;

                drawer.querySelector('[data-close-cov-drawer]')?.addEventListener('click', () => {
                    drawer.hidden = true;
                    drawer.removeAttribute('data-drawer-key');
                });
                drawer.querySelector('[data-cov-inplugin-edit]')?.addEventListener('click', () => {
                    const meta = _callbacks?.getState?.()?.classification?.byName?.get(worldName)
                        || { realName: worldName, primaryTitle: worldName };
                    openBookEntryBrowserModal(meta, { stack: true });
                });
                drawer.querySelector('[data-cov-native-edit]')?.addEventListener('click', () => {
                    cancelSignal.cancelled = true;
                    closeSubModal({ all: true });
                    closeManagerModal();
                    if (!openWorldInNativeEditor(worldName)) {
                        showToast('warning', `未能打开世界书「${worldName}」`);
                    }
                });
                drawer.querySelector('[data-cov-strip-unbind]')?.addEventListener('click', async (ev) => {
                    const stripBtn = ev.currentTarget;
                    const kind = stripBtn?.getAttribute?.('data-cov-strip-unbind') || '';
                    const targetKey = stripBtn?.getAttribute?.('data-cov-strip-target') || '';
                    if (!kind || !targetKey) return;
                    const label = kind === 'persona' ? 'User 人设世界书绑定' : '附加世界书绑定';
                    if (!globalThis.confirm(`确认直接解除「${worldName}」的${label}？\n（仅解除绑定，世界书文件不会被删除）`)) return;
                    const tabKey = getActiveCovTabKey();
                    const res = kind === 'persona'
                        ? await unbindWorldbookFromPersona(targetKey, worldName)
                        : await unbindExtraWorldbookFromChar(targetKey, worldName);
                    if (!res.ok) {
                        setStatus(`解除失败：${res.error || '未知错误'}`, 'error');
                        return;
                    }
                    await _callbacks.onRescan();
                    showToast('success', `已解除「${worldName}」的${label}`);
                    rerenderScanBody(tabKey, `已解除「${worldName}」的${label}`, 'success');
                });
            });
        });

        modal.querySelector('#wbo-scan-all-btn')?.addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            if (btn instanceof HTMLButtonElement) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-arrows-rotate fa-spin"></i> <span>正在扫描...</span>';
            }
            cancelSignal.cancelled = false;

            const prevState = _callbacks.getState();
            const prevChars = getCharactersInMemory();
            const prevWorldSet = new Set(getWorldNames([...prevState.classification.byName.keys()]));
            const prevCov = summarizeCharacterWorldCoverage({
                characters: prevChars,
                bindingMap: prevState.bindingMap || new Map(),
                worldNamesSet: prevWorldSet,
                cachedCharBindings: prevState.settings.cachedCharBindings,
                settings: prevState.settings,
            });
            const prevUnimported = findCardsWithUnimportedBooks({
                characters: prevChars,
                worldNamesSet: prevWorldSet,
                cachedCharBindings: prevState.settings.cachedCharBindings,
            });
            const prevSig = JSON.stringify([
                prevChars.length,
                prevState.classification.charCount,
                prevUnimported.length,
                prevCov.multiBookChars.length,
                prevCov.missingFileChars.length,
                prevCov.orphanExtraBooks.length,
                prevCov.sharedBooks.length,
                prevCov.embeddedNameMatches.length,
                (prevCov.unboundNameMatches || []).length,
                prevCov.unboundChars.length,
            ]);

            const { settings } = prevState;
            const targets = findUnscannedShallowCharacters(prevChars, settings.cachedCharBindings);
            let scannedNewCount = 0;

            if (targets.length > 0) {
                setStatus(`正在扫描 ${targets.length} 张未加载角色卡...`);
                const res = await scanShallowCharactersInBatches(targets, {
                    signal: cancelSignal,
                    onProgress: (done, total, currentName) => {
                        setStatus(`正在扫描 (${done}/${total})：${currentName}`);
                    },
                });
                scannedNewCount = res.scanned.length;
                if (res.scanned.length > 0) {
                    const { cached } = updateCachedCharBindings({}, res.scanned);
                    Object.assign(settings.cachedCharBindings, cached);
                }
            } else {
                setStatus('正在刷新角色绑定与附加世界书...');
            }

            await _callbacks.onRescan();
            const body = modal.querySelector('.wbo-modal-body');
            if (body && !cancelSignal.cancelled) {
                body.innerHTML = renderModalBody();
                bindHandlers();
                const latest = _callbacks.getState();
                const latestChars = getCharactersInMemory();
                const latestWorldSet = new Set(getWorldNames([...latest.classification.byName.keys()]));
                const latestCov = summarizeCharacterWorldCoverage({
                    characters: latestChars,
                    bindingMap: latest.bindingMap || new Map(),
                    worldNamesSet: latestWorldSet,
                    cachedCharBindings: latest.settings.cachedCharBindings,
                    settings: latest.settings,
                });
                const latestPersona = summarizePersonaWorldBindings({
                    powerUserSettings: getPowerUserSettings(),
                    worldNamesSet: latestWorldSet,
                    bindingMap: latest.bindingMap || new Map(),
                });
                const latestUnimported = findCardsWithUnimportedBooks({
                    characters: latestChars,
                    worldNamesSet: latestWorldSet,
                    cachedCharBindings: latest.settings.cachedCharBindings,
                });
                const nextSig = JSON.stringify([
                    latestChars.length,
                    latest.classification.charCount,
                    latestUnimported.length,
                    latestCov.multiBookChars.length,
                    latestCov.missingFileChars.length,
                    latestCov.orphanExtraBooks.length,
                    latestCov.sharedBooks.length,
                    latestCov.embeddedNameMatches.length,
                    (latestCov.unboundNameMatches || []).length,
                    latestCov.unboundChars.length,
                ]);
                const hasChanges = scannedNewCount > 0 || prevSig !== nextSig;
                const personaCount = Object.keys(getPowerUserSettings()?.personas || {}).length;
                const anomalyCount = latestCov.multiBookChars.length
                    + latestCov.missingFileChars.length
                    + latestCov.orphanExtraBooks.length
                    + latestCov.sharedBooks.length
                    + latestPersona.anomalyCount;
                const now = new Date();
                const hhmmss = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
                const summaryMsg = hasChanges
                    ? `${hhmmss} 扫描完成：共 ${latestChars.length} 张角色卡、${latest.classification.charCount} 本绑定书（待处理 ${anomalyCount} 项）`
                    : `${hhmmss} 已重新扫描，暂无新增变动（共 ${latestChars.length} 张角色卡、${latest.classification.charCount} 本绑定书）`;

                const nextStatus = modal.querySelector('#wbo-scan-status');
                const nextScanBtn = modal.querySelector('#wbo-scan-all-btn');
                if (nextStatus instanceof HTMLElement) {
                    nextStatus.textContent = summaryMsg;
                    nextStatus.className = 'wbo-ai-status is-success wbo-scan-top-status';
                    nextStatus.hidden = false;
                }
                if (nextScanBtn instanceof HTMLButtonElement) {
                    const restoreLabel = nextScanBtn.textContent || '重新扫描角色卡';
                    nextScanBtn.textContent = hasChanges ? '✓ 扫描完成' : '✓ 无新增变动';
                    setTimeout(() => {
                        if (nextScanBtn.isConnected) {
                            nextScanBtn.textContent = restoreLabel;
                        }
                    }, 2200);
                }
                showToast(
                    'success',
                    hasChanges
                        ? `扫描完成：已更新 ${latestChars.length} 张角色卡绑定状态`
                        : '✓ 已重新扫描，未发现新增变动',
                );
            }
        });

        modal.querySelector('#wbo-import-selected-books-btn')?.addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            if (btn instanceof HTMLButtonElement) btn.disabled = true;

            const avatars = Array.from(modal.querySelectorAll('.wbo-import-book-check:checked')).map((el) => el.value);
            if (avatars.length === 0) {
                setStatus('请先勾选要导入的世界书', true);
                if (btn instanceof HTMLButtonElement) btn.disabled = false;
                return;
            }

            let imported = 0;
            let skipped = 0;
            let failed = 0;
            const knownNames = new Set(getWorldNames());

            for (let i = 0; i < avatars.length; i += 1) {
                setStatus(`正在导入 (${i + 1}/${avatars.length})...`);
                const res = await importEmbeddedWorldbookForCharacter(avatars[i], {
                    worldNamesSet: knownNames,
                    deferRefresh: true,
                });
                if (res.status === 'imported') {
                    imported += 1;
                    if (res.name) knownNames.add(res.name);
                } else if (res.status === 'exists' || res.status === 'nobook') {
                    skipped += 1;
                } else {
                    failed += 1;
                }
            }

            if (imported > 0) {
                await flushWorldInfoListRefresh();
            }
            await _callbacks.onRescan();
            const body = modal.querySelector('.wbo-modal-body');
            if (body) {
                body.innerHTML = renderModalBody();
                bindHandlers();
                const nextStatus = modal.querySelector('#wbo-scan-status');
                if (nextStatus) {
                    nextStatus.textContent = `导入完成：成功 ${imported} 本，跳过 ${skipped} 本${failed > 0 ? `，失败 ${failed} 本` : ''}。`;
                }
            }
            if (imported > 0) {
                showToast('success', `已导入 ${imported} 本角色世界书`);
            }
        });
    };

    bindHandlers();
}

export { openScanAndImportModal };
