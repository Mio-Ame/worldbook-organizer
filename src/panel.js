/**
 * Worldbook Organizer — Embedded grouped browser panel, AI Organize modal,
 * quick alias/group editors, and Extension Settings drawer.
 */

import {
    GROUP_COLOR_PALETTE,
    SPECIAL_GROUPS,
    addCustomGroup,
    applyAiOrganizeProposals,
    buildAiOrganizePrompt,
    exportConfigData,
    findCardsWithUnimportedBooks,
    findUnscannedShallowCharacters,
    importConfigData,
    matchesSearch,
    moveSectionOrder,
    parseAiOrganizeResponse,
    undoLastAiOrganize,
    updateCachedCharBindings,
} from './core.js';
import {
    applyTauriSurface,
    callHostAiForOrganize,
    fetchWorldbookCluesOnDemand,
    getActiveGlobalWorldSet,
    getCharactersInMemory,
    getCurrentEditorWorldName,
    getWorldNames,
    importEmbeddedWorldbookForCharacter,
    scanShallowCharactersInBatches,
    showToast,
} from './host.js';
import {
    openWorldInNativeEditor,
    setGlobalWorldActive,
} from './native-filter.js';

const PANEL_ROOT_ID = 'wbo-panel-root';
const SETTINGS_ROOT_ID = 'wbo-extension-settings';
const MODAL_OVERLAY_ID = 'wbo-modal-overlay';

let _searchQuery = '';
let _panelMounted = false;
let _settingsMounted = false;
let _callbacks = null;

/**
 * Escape HTML special characters safely.
 * @param {string} str
 * @returns {string}
 */
function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Configure host/controller callbacks used by UI actions.
 * @param {{
 *   getState: () => { settings: any, classification: any },
 *   onMutation: (opts?: { rescan?: boolean, save?: boolean }) => void | Promise<void>,
 *   onRescan: () => Promise<void>,
 * }} callbacks
 */
export function bindPanelCallbacks(callbacks) {
    _callbacks = callbacks;
}

/**
 * Ensure the embedded grouped panel root exists inside `#WorldInfo`.
 * Placed directly between `#wiTopBlock` and `#world_popup` so it sits right
 * alongside both global selection and the world editor selector.
 * @returns {HTMLElement | null}
 */
function ensurePanelRoot() {
    let root = document.getElementById(PANEL_ROOT_ID);
    if (root) return root;

    const holder = document.getElementById('wi-holder');
    const worldPopup = document.getElementById('world_popup');
    if (!holder) return null;

    root = document.createElement('section');
    root.id = PANEL_ROOT_ID;
    root.className = 'wbo-panel';

    if (worldPopup && worldPopup.parentElement === holder) {
        holder.insertBefore(root, worldPopup);
    } else {
        holder.appendChild(root);
    }

    bindPanelDelegatedEvents(root);
    _panelMounted = true;
    return root;
}

/**
 * Build HTML for a single worldbook row inside a group section.
 * @param {any} book
 * @param {Set<string>} activeGlobals
 * @param {string | null} currentEditor
 */
function renderBookRowHtml(book, activeGlobals, currentEditor) {
    const isActive = activeGlobals.has(book.realName);
    const isEditing = currentEditor === book.realName;
    const ownerHint = book.isCharBound && !book.isInCharGroup
        ? `<span class="wbo-tag wbo-tag-char" title="此书同时绑定了角色卡：${esc(book.charOwners.map((o) => o.charName).join('、'))}">角色：${esc(book.charOwners[0]?.charName || '')}</span>`
        : '';
    const personaHint = book.personaOwners?.length
        ? `<span class="wbo-tag wbo-tag-persona" title="已绑定 User 人设：${esc(book.personaOwners.join('、'))}（不改原文件名，绑定安全）">人设</span>`
        : '';
    const subHtml = book.subtitle
        ? `<span class="wbo-book-sub" title="原文件名：${esc(book.realName)}">${esc(book.subtitle)}</span>`
        : '';
    const noteHtml = book.note
        ? `<div class="wbo-book-note">${esc(book.note)}</div>`
        : '';

    return `
        <div class="wbo-book-row${isActive ? ' is-active' : ''}${isEditing ? ' is-editing' : ''}" data-book="${esc(book.realName)}">
            <label class="wbo-book-toggle" title="${isActive ? '取消全局激活' : '全局激活此世界书'}">
                <input type="checkbox" class="wbo-global-check" ${isActive ? 'checked' : ''} aria-label="全局激活 ${esc(book.primaryTitle)}">
            </label>
            <button type="button" class="wbo-book-main" data-action="edit-book" title="点击打开编辑&#10;真实文件名：${esc(book.realName)}">
                <div class="wbo-book-title-line">
                    <span class="wbo-book-title">${esc(book.primaryTitle)}</span>
                    ${subHtml}
                    ${ownerHint}
                    ${personaHint}
                </div>
                ${noteHtml}
            </button>
            <div class="wbo-book-actions">
                <button type="button" class="wbo-icon-btn" data-action="rename-alias" title="设置显示别名 / 备注（不改原文件名）">
                    <i class="fa-solid fa-tag"></i>
                </button>
                <button type="button" class="wbo-icon-btn" data-action="move-group" title="移动到分组">
                    <i class="fa-solid fa-folder-open"></i>
                </button>
            </div>
        </div>
    `;
}

/**
 * Build HTML for one collapsible group accordion section.
 * @param {object} params
 * @param {string} params.id
 * @param {string} params.name
 * @param {string} params.color
 * @param {boolean} params.collapsed
 * @param {boolean} params.isCustom
 * @param {boolean} params.isCharGroup
 * @param {any[]} params.books
 * @param {Set<string>} params.activeGlobals
 * @param {string | null} params.currentEditor
 */
function renderGroupSectionHtml({
    id,
    name,
    color,
    collapsed,
    isCustom,
    isCharGroup,
    canMoveUp,
    canMoveDown,
    books,
    activeGlobals,
    currentEditor,
}) {
    const activeCount = books.filter((b) => activeGlobals.has(b.realName)).length;
    const countLabel = activeCount > 0 ? `${activeCount}/${books.length}` : `${books.length}`;
    const orderActions = `
        <button type="button" class="wbo-icon-btn" data-action="move-section-up" data-group-id="${esc(id)}" ${canMoveUp ? '' : 'disabled'} title="上移分组顺序">
            <i class="fa-solid fa-arrow-up"></i>
        </button>
        <button type="button" class="wbo-icon-btn" data-action="move-section-down" data-group-id="${esc(id)}" ${canMoveDown ? '' : 'disabled'} title="下移分组顺序">
            <i class="fa-solid fa-arrow-down"></i>
        </button>
    `;
    const customActions = isCustom
        ? `
            <button type="button" class="wbo-icon-btn" data-action="rename-group" data-group-id="${esc(id)}" title="重命名分组">
                <i class="fa-solid fa-pen"></i>
            </button>
            <button type="button" class="wbo-icon-btn wbo-danger" data-action="delete-group" data-group-id="${esc(id)}" title="删除分组（不会删除世界书）">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        `
        : '';

    const rowsHtml = collapsed
        ? ''
        : (books.length > 0
            ? `<div class="wbo-group-body">${books.map((b) => renderBookRowHtml(b, activeGlobals, currentEditor)).join('')}</div>`
            : `<div class="wbo-group-body wbo-empty-hint">此分组暂无世界书</div>`);

    return `
        <div class="wbo-group${collapsed ? ' is-collapsed' : ''}${isCharGroup ? ' is-char-group' : ''}" data-group-id="${esc(id)}">
            <div class="wbo-group-header">
                <button type="button" class="wbo-group-toggle" data-action="toggle-group-collapse" data-group-id="${esc(id)}" aria-expanded="${!collapsed}">
                    <i class="fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'} wbo-chevron"></i>
                    <span class="wbo-group-dot" style="background:${esc(color)}"></span>
                    <span class="wbo-group-name">${esc(name)}</span>
                    <span class="wbo-group-count">${esc(countLabel)}</span>
                </button>
                <div class="wbo-group-actions">
                    ${orderActions}
                    ${customActions}
                </div>
            </div>
            ${rowsHtml}
        </div>
    `;
}

/**
 * Re-render the embedded grouped worldbook panel inside `#WorldInfo`.
 */
export function renderEmbeddedPanel() {
    if (!_callbacks) return;
    const root = ensurePanelRoot();
    if (!root) return;

    const { settings, classification } = _callbacks.getState();
    const activeGlobals = getActiveGlobalWorldSet();
    const currentEditor = getCurrentEditorWorldName();
    const q = _searchQuery.trim();

    const hasCustomGroups = classification.customGroups.length > 0;
    const orderedSections = classification.orderedSections || [];

    // Filter pills follow user's custom section order; hide redundant "未分组" when no custom groups exist!
    const pills = [
        {
            id: SPECIAL_GROUPS.DEFAULT,
            label: settings.showCharBooks ? '全部世界书' : '通用世界书',
            count: settings.showCharBooks ? classification.totalCount : classification.nonCharCount,
        },
        ...orderedSections
            .filter((sec) => {
                if (sec.kind === 'ungrouped' && !hasCustomGroups) return false;
                return true;
            })
            .map((sec) => ({
                id: sec.id,
                label: sec.name,
                color: sec.kind === 'custom' ? sec.color : undefined,
                count: sec.books.length,
                isChar: sec.kind === 'character',
            })),
    ];

    const pillsHtml = pills
        .map((p) => {
            const active = settings.activeFilterGroupId === p.id;
            const dot = p.color ? `<span class="wbo-pill-dot" style="background:${esc(p.color)}"></span>` : '';
            return `
                <button type="button"
                    class="wbo-pill${active ? ' is-active' : ''}${p.isChar ? ' is-char' : ''}"
                    data-action="select-filter"
                    data-group-id="${esc(p.id)}">
                    ${dot}<span>${esc(p.label)}</span><span class="wbo-pill-count">${p.count}</span>
                </button>
            `;
        })
        .join('');

    // Build visible sections in unified user `sectionOrder` when panel is expanded
    let bodyHtml = '';
    if (settings.groupPanelExpanded) {
        const sections = [];
        const filterId = settings.activeFilterGroupId;
        const includeCharExplicitly =
            filterId === SPECIAL_GROUPS.CHARACTER ||
            filterId === SPECIAL_GROUPS.ALL ||
            (filterId === SPECIAL_GROUPS.DEFAULT && settings.showCharBooks);

        orderedSections.forEach((sec, idx) => {
            const canMoveUp = idx > 0;
            const canMoveDown = idx < orderedSections.length - 1;

            if (sec.kind === 'custom') {
                if (filterId !== SPECIAL_GROUPS.DEFAULT && filterId !== SPECIAL_GROUPS.ALL && filterId !== sec.id) {
                    return;
                }
                const books = q ? sec.books.filter((b) => matchesSearch(b, q)) : sec.books;
                if (q && books.length === 0) return;
                sections.push(
                    renderGroupSectionHtml({
                        id: sec.id,
                        name: sec.name,
                        color: sec.color,
                        collapsed: q ? false : Boolean(sec.collapsed),
                        isCustom: true,
                        isCharGroup: false,
                        canMoveUp,
                        canMoveDown,
                        books,
                        activeGlobals,
                        currentEditor,
                    }),
                );
                return;
            }

            if (sec.kind === 'ungrouped') {
                if (
                    filterId !== SPECIAL_GROUPS.DEFAULT &&
                    filterId !== SPECIAL_GROUPS.ALL &&
                    filterId !== SPECIAL_GROUPS.UNGROUPED
                ) {
                    return;
                }
                const books = q ? sec.books.filter((b) => matchesSearch(b, q)) : sec.books;
                if (q && books.length === 0) return;
                sections.push(
                    renderGroupSectionHtml({
                        id: SPECIAL_GROUPS.UNGROUPED,
                        name: hasCustomGroups ? '未分组' : '通用世界书',
                        color: '#8c99a6',
                        collapsed: q ? false : Boolean(settings.ungroupedCollapsed),
                        isCustom: false,
                        isCharGroup: false,
                        canMoveUp,
                        canMoveDown,
                        books,
                        activeGlobals,
                        currentEditor,
                    }),
                );
                return;
            }

            if (sec.kind === 'character' && classification.charCount > 0) {
                const matchedCharBooks = q ? sec.books.filter((b) => matchesSearch(b, q)) : sec.books;
                if (includeCharExplicitly) {
                    if (q && matchedCharBooks.length === 0) return;
                    sections.push(
                        renderGroupSectionHtml({
                            id: SPECIAL_GROUPS.CHARACTER,
                            name: '角色世界书（自动归组）',
                            color: '#9b72cf',
                            collapsed: q ? false : Boolean(settings.charGroupCollapsed),
                            isCustom: false,
                            isCharGroup: true,
                            canMoveUp,
                            canMoveDown,
                            books: matchedCharBooks,
                            activeGlobals,
                            currentEditor,
                        }),
                    );
                } else if (filterId === SPECIAL_GROUPS.DEFAULT) {
                    const noticeText = q
                        ? (matchedCharBooks.length > 0
                            ? `已隐藏的角色世界书中匹配到 ${matchedCharBooks.length} 本`
                            : `已自动隐藏 ${classification.charCount} 本角色卡世界书`)
                        : `已自动隐藏 ${classification.charCount} 本角色卡世界书`;
                    sections.push(`
                        <div class="wbo-char-hidden-bar">
                            <span class="wbo-char-hidden-text">
                                <i class="fa-solid fa-eye-slash"></i>
                                ${esc(noticeText)}
                            </span>
                            <button type="button" class="menu_button wbo-btn-compact" data-action="reveal-char-books">
                                展开查看
                            </button>
                        </div>
                    `);
                }
            }
        });

        bodyHtml = `
            <div class="wbo-groups-list">
                ${sections.length > 0 ? sections.join('') : '<div class="wbo-empty-hint">没有匹配的世界书</div>'}
            </div>
        `;
    }

    const filterBarHtml = `
        <div class="wbo-filter-row">
            <div class="wbo-pills">${pillsHtml}</div>
            ${settings.groupPanelExpanded ? `
            <div class="wbo-search-wrap">
                <i class="fa-solid fa-magnifying-glass"></i>
                <input type="search" class="text_pole wbo-search-input" value="${esc(_searchQuery)}" placeholder="搜世界书 / 别名 / 角色名..." aria-label="搜索世界书">
            </div>` : ''}
        </div>
    `;

    const undoVisible = Array.isArray(settings.undoSnapshots) && settings.undoSnapshots.length > 0;
    const characters = getCharactersInMemory();
    const unscannedShallowCount = findUnscannedShallowCharacters(characters, settings.cachedCharBindings).length;
    const unimportedBookCount = findCardsWithUnimportedBooks({
        characters,
        worldNamesSet: new Set(classification.byName.keys()),
        cachedCharBindings: settings.cachedCharBindings,
    }).length;
    const scanBadgeCount = unscannedShallowCount + unimportedBookCount;
    const hideBtnLabel = settings.showCharBooks
        ? `显示角色书 (${classification.charCount})`
        : `隐藏角色书 (${classification.charCount})`;

    // Preserve search input focus & caret across re-renders
    const prevSearch = root.querySelector('.wbo-search-input');
    const hadSearchFocus = document.activeElement === prevSearch;
    const prevSelStart = hadSearchFocus && prevSearch ? prevSearch.selectionStart : null;

    root.innerHTML = `
        <div class="wbo-toolbar">
            <button type="button" class="wbo-toolbar-title" data-action="toggle-panel-expand" title="展开/收起世界书分组管理列表">
                <i class="fa-solid ${settings.groupPanelExpanded ? 'fa-chevron-down' : 'fa-chevron-right'}"></i>
                <span>分组列表</span>
                <span class="wbo-stat-badge">${classification.nonCharCount} 通用 · ${classification.charCount} 角色</span>
            </button>
            <div class="wbo-toolbar-actions">
                <label class="wbo-switch-toggle" title="关闭 = 默认隐藏角色卡世界书；开启 = 在下拉框和列表中显示角色卡世界书">
                    <input type="checkbox" class="wbo-show-char-checkbox" ${settings.showCharBooks ? 'checked' : ''}>
                    <span class="wbo-switch-track"></span>
                    <span class="wbo-switch-label">显示角色书 (${classification.charCount})</span>
                </label>
                <button type="button" class="menu_button wbo-btn-compact wbo-btn-ai" data-action="open-ai-organize" title="由 AI 整理显示名与分组（不改底层真实文件名）">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>AI整理</span>
                </button>
                <button type="button" class="menu_button wbo-btn-compact" data-action="create-group" title="新建自定义分组（新分组自动排在最前面）">
                    <i class="fa-solid fa-folder-plus"></i>
                </button>
                ${undoVisible ? `
                <button type="button" class="menu_button wbo-btn-compact" data-action="undo-ai" title="撤销最近一次 AI 整理">
                    <i class="fa-solid fa-rotate-left"></i>
                </button>` : ''}
                <button type="button" class="menu_button wbo-btn-compact${scanBadgeCount > 0 ? ' wbo-btn-active' : ''}" data-action="open-scan-modal" title="扫描角色卡绑定 / 导入未导入的角色内嵌世界书（按需触发，平时不扫盘）">
                    <i class="fa-solid fa-arrows-rotate"></i>
                    <span>扫描${scanBadgeCount > 0 ? ` (${scanBadgeCount})` : ''}</span>
                </button>
            </div>
        </div>
        ${filterBarHtml}
        ${bodyHtml}
    `;

    if (hadSearchFocus) {
        const nextSearch = root.querySelector('.wbo-search-input');
        if (nextSearch instanceof HTMLInputElement) {
            nextSearch.focus();
            if (typeof prevSelStart === 'number') {
                nextSearch.setSelectionRange(prevSelStart, prevSelStart);
            }
        }
    }
}

/**
 * Bind delegated click & input handlers once on the panel root.
 * @param {HTMLElement} root
 */
function bindPanelDelegatedEvents(root) {
    root.addEventListener('input', (ev) => {
        const target = ev.target;
        if (target instanceof HTMLInputElement && target.classList.contains('wbo-search-input')) {
            _searchQuery = target.value;
            renderEmbeddedPanel();
        }
    });

    root.addEventListener('change', async (ev) => {
        const target = ev.target;
        if (target instanceof HTMLInputElement && target.classList.contains('wbo-show-char-checkbox')) {
            if (!_callbacks) return;
            const { settings } = _callbacks.getState();
            settings.showCharBooks = target.checked;
            if (!settings.showCharBooks && settings.activeFilterGroupId === SPECIAL_GROUPS.CHARACTER) {
                settings.activeFilterGroupId = SPECIAL_GROUPS.DEFAULT;
            }
            if (settings.showCharBooks) {
                settings.charGroupCollapsed = false;
            }
            await _callbacks.onMutation({ save: true });
            return;
        }
        if (target instanceof HTMLInputElement && target.classList.contains('wbo-global-check')) {
            const row = target.closest('.wbo-book-row');
            const bookName = row?.getAttribute('data-book');
            if (!bookName) return;
            setGlobalWorldActive(bookName, target.checked);
            setTimeout(() => renderEmbeddedPanel(), 30);
        }
    });

    root.addEventListener('click', async (ev) => {
        const target = ev.target instanceof Element ? ev.target.closest('[data-action]') : null;
        if (!target || !_callbacks) return;

        const action = target.getAttribute('data-action');
        const { settings, classification } = _callbacks.getState();

        switch (action) {
            case 'toggle-panel-expand': {
                settings.groupPanelExpanded = !settings.groupPanelExpanded;
                renderEmbeddedPanel();
                await _callbacks.onMutation({ save: true, uiOnly: true });
                break;
            }
            case 'toggle-show-char': {
                settings.showCharBooks = !settings.showCharBooks;
                if (!settings.showCharBooks && settings.activeFilterGroupId === SPECIAL_GROUPS.CHARACTER) {
                    settings.activeFilterGroupId = SPECIAL_GROUPS.DEFAULT;
                }
                if (settings.showCharBooks) {
                    settings.charGroupCollapsed = false;
                }
                await _callbacks.onMutation({ save: true });
                break;
            }
            case 'reveal-char-books': {
                settings.showCharBooks = true;
                settings.charGroupCollapsed = false;
                await _callbacks.onMutation({ save: true });
                break;
            }
            case 'select-filter': {
                const gid = target.getAttribute('data-group-id') || SPECIAL_GROUPS.DEFAULT;
                settings.activeFilterGroupId = gid;
                if (gid === SPECIAL_GROUPS.CHARACTER) {
                    settings.charGroupCollapsed = false;
                }
                await _callbacks.onMutation({ save: true });
                break;
            }
            case 'toggle-group-collapse': {
                const gid = target.getAttribute('data-group-id');
                if (gid === SPECIAL_GROUPS.CHARACTER) {
                    settings.charGroupCollapsed = !settings.charGroupCollapsed;
                } else if (gid === SPECIAL_GROUPS.UNGROUPED) {
                    settings.ungroupedCollapsed = !settings.ungroupedCollapsed;
                } else {
                    const grp = settings.groups.find((g) => g.id === gid);
                    if (grp) grp.collapsed = !grp.collapsed;
                }
                renderEmbeddedPanel();
                await _callbacks.onMutation({ save: true, uiOnly: true });
                break;
            }
            case 'move-section-up': {
                const gid = target.getAttribute('data-group-id');
                if (gid && moveSectionOrder(settings, gid, -1)) {
                    await _callbacks.onMutation({ save: true });
                }
                break;
            }
            case 'move-section-down': {
                const gid = target.getAttribute('data-group-id');
                if (gid && moveSectionOrder(settings, gid, 1)) {
                    await _callbacks.onMutation({ save: true });
                }
                break;
            }
            case 'create-group': {
                openCreateOrRenameGroupModal(null);
                break;
            }
            case 'rename-group': {
                const gid = target.getAttribute('data-group-id');
                const grp = settings.groups.find((g) => g.id === gid);
                if (grp) openCreateOrRenameGroupModal(grp);
                break;
            }
            case 'delete-group': {
                const gid = target.getAttribute('data-group-id');
                const grp = settings.groups.find((g) => g.id === gid);
                if (!grp) return;
                if (!globalThis.confirm(`删除分组「${grp.name}」？\n分组内的世界书不会被删除，而是回到未分组（或角色世界书）。`)) {
                    return;
                }
                settings.groups = settings.groups.filter((g) => g.id !== gid);
                for (const [book, assigned] of Object.entries(settings.assignments)) {
                    if (assigned === gid) delete settings.assignments[book];
                }
                if (settings.activeFilterGroupId === gid) {
                    settings.activeFilterGroupId = SPECIAL_GROUPS.DEFAULT;
                }
                await _callbacks.onMutation({ save: true });
                showToast('info', `已删除分组「${grp.name}」`);
                break;
            }
            case 'edit-book': {
                const row = target.closest('.wbo-book-row');
                const bookName = row?.getAttribute('data-book');
                if (bookName) {
                    openWorldInNativeEditor(bookName);
                    setTimeout(() => renderEmbeddedPanel(), 80);
                }
                break;
            }
            case 'rename-alias': {
                const row = target.closest('.wbo-book-row');
                const bookName = row?.getAttribute('data-book');
                const meta = bookName ? classification.byName.get(bookName) : null;
                if (meta) openAliasNoteModal(meta);
                break;
            }
            case 'move-group': {
                const row = target.closest('.wbo-book-row');
                const bookName = row?.getAttribute('data-book');
                const meta = bookName ? classification.byName.get(bookName) : null;
                if (meta) openMoveGroupModal(meta);
                break;
            }
            case 'open-ai-organize': {
                openAiOrganizeModal();
                break;
            }
            case 'undo-ai': {
                if (undoLastAiOrganize(settings)) {
                    await _callbacks.onMutation({ save: true });
                    showToast('success', '已撤销上一次 AI 整理');
                }
                break;
            }
            case 'open-scan-modal': {
                openScanAndImportModal();
                break;
            }
            case 'rescan-bindings': {
                await _callbacks.onRescan();
                showToast('success', '已完成角色绑定扫描并更新缓存');
                break;
            }
        }
    });
}

// ==================== Modals ====================

function closeModal() {
    const existing = document.getElementById(MODAL_OVERLAY_ID);
    if (existing) existing.remove();
}

/**
 * Create a clean, responsive modal overlay with TauriTavern safe-area support.
 * @param {string} title
 * @param {string} bodyHtml
 * @param {{ wide?: boolean }} [opts]
 * @returns {{ overlay: HTMLElement, modal: HTMLElement }}
 */
function createModal(title, bodyHtml, { wide = false } = {}) {
    closeModal();
    const overlay = document.createElement('div');
    overlay.id = MODAL_OVERLAY_ID;
    overlay.className = 'wbo-modal-overlay';
    applyTauriSurface(overlay, 'backdrop');

    const modal = document.createElement('div');
    modal.className = `wbo-modal${wide ? ' is-wide' : ''}`;
    applyTauriSurface(modal, 'fullscreen-window');

    modal.innerHTML = `
        <div class="wbo-modal-header">
            <span class="wbo-modal-title">${esc(title)}</span>
            <button type="button" class="wbo-icon-btn wbo-modal-close" aria-label="关闭">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <div class="wbo-modal-body">${bodyHtml}</div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // CRITICAL: stop mouse/touch/click propagation from modal overlay so SillyTavern's
    // global document click handler NEVER interprets modal interactions as "click outside #WorldInfo"
    // and accidentally closes the World Info drawer!
    const stopAll = (ev) => ev.stopPropagation();
    for (const evtName of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend']) {
        overlay.addEventListener(evtName, stopAll);
    }

    overlay.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target === overlay) closeModal();
    });
    modal.querySelector('.wbo-modal-close')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeModal();
    });

    return { overlay, modal };
}

/**
 * Create or rename a custom group.
 * @param {{ id: string, name: string, color: string } | null} group
 */
function openCreateOrRenameGroupModal(group) {
    if (!_callbacks) return;
    const { settings } = _callbacks.getState();
    const isEdit = Boolean(group);
    const initialColor = group?.color || GROUP_COLOR_PALETTE[settings.groups.length % GROUP_COLOR_PALETTE.length];

    const swatches = GROUP_COLOR_PALETTE.map(
        (c) => `<button type="button" class="wbo-swatch${c === initialColor ? ' is-selected' : ''}" data-color="${c}" style="background:${c}" aria-label="颜色 ${c}"></button>`,
    ).join('');

    const { modal } = createModal(
        isEdit ? '编辑分组' : '新建世界书分组',
        `
            <div class="wbo-field">
                <label class="wbo-label">分组名称</label>
                <input type="text" class="text_pole wbo-input" id="wbo-group-name-input" value="${esc(group?.name || '')}" placeholder="例如：文风与写法、世界观设定、系统规则">
            </div>
            <div class="wbo-field">
                <label class="wbo-label">标识颜色</label>
                <div class="wbo-swatches">${swatches}</div>
            </div>
            <div class="wbo-modal-footer">
                <button type="button" class="menu_button" id="wbo-cancel-btn">取消</button>
                <button type="button" class="menu_button wbo-btn-primary" id="wbo-save-group-btn">保存</button>
            </div>
        `,
    );

    let chosenColor = initialColor;
    modal.querySelectorAll('.wbo-swatch').forEach((btn) => {
        btn.addEventListener('click', () => {
            chosenColor = btn.getAttribute('data-color') || initialColor;
            modal.querySelectorAll('.wbo-swatch').forEach((b) => b.classList.remove('is-selected'));
            btn.classList.add('is-selected');
        });
    });

    const input = modal.querySelector('#wbo-group-name-input');
    if (input instanceof HTMLInputElement) {
        input.focus();
        input.select();
    }

    const submit = async () => {
        const name = input instanceof HTMLInputElement ? input.value.trim() : '';
        if (!name) {
            showToast('warning', '请输入分组名称');
            return;
        }
        if (isEdit && group) {
            group.name = name;
            group.color = chosenColor;
        } else {
            addCustomGroup(settings, { name, color: chosenColor });
        }
        closeModal();
        await _callbacks.onMutation({ save: true });
        showToast('success', isEdit ? `已更新分组「${name}」` : `已新建分组「${name}」`);
    };

    modal.querySelector('#wbo-cancel-btn')?.addEventListener('click', closeModal);
    modal.querySelector('#wbo-save-group-btn')?.addEventListener('click', submit);
    input?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') submit();
    });
}

/**
 * Edit virtual display alias & note for a worldbook (never renames real file).
 * @param {any} bookMeta
 */
function openAliasNoteModal(bookMeta) {
    if (!_callbacks) return;
    const { settings } = _callbacks.getState();

    const { modal } = createModal(
        '设置显示名与备注（不改原文件名）',
        `
            <div class="wbo-safe-note">
                <i class="fa-solid fa-shield-halved"></i>
                仅修改插件内的显示名称，底层真实文件 <code>${esc(bookMeta.realName)}</code> 保持不变，不会破坏任何角色卡、User 人设或聊天绑定。
            </div>
            <div class="wbo-field">
                <label class="wbo-label">虚拟显示名（留空则恢复默认${bookMeta.isInCharGroup ? '角色名' : '原名'}）</label>
                <input type="text" class="text_pole wbo-input" id="wbo-alias-input" value="${esc(bookMeta.alias || '')}" placeholder="${esc(bookMeta.primaryTitle)}">
            </div>
            <div class="wbo-field">
                <label class="wbo-label">备注 / 用途简介</label>
                <input type="text" class="text_pole wbo-input" id="wbo-note-input" value="${esc(bookMeta.note || '')}" placeholder="例如：现代都市通用文风、防八股规则">
            </div>
            <div class="wbo-modal-footer">
                <button type="button" class="menu_button" id="wbo-clear-alias-btn">恢复默认名</button>
                <span class="wbo-spacer"></span>
                <button type="button" class="menu_button" id="wbo-cancel-btn">取消</button>
                <button type="button" class="menu_button wbo-btn-primary" id="wbo-save-alias-btn">保存</button>
            </div>
        `,
    );

    const aliasInput = modal.querySelector('#wbo-alias-input');
    const noteInput = modal.querySelector('#wbo-note-input');
    if (aliasInput instanceof HTMLInputElement) aliasInput.focus();

    const save = async () => {
        const alias = aliasInput instanceof HTMLInputElement ? aliasInput.value.trim() : '';
        const note = noteInput instanceof HTMLInputElement ? noteInput.value.trim() : '';

        if (alias && alias !== bookMeta.realName) {
            settings.aliases[bookMeta.realName] = alias;
        } else {
            delete settings.aliases[bookMeta.realName];
        }

        if (note) {
            settings.notes[bookMeta.realName] = note;
        } else {
            delete settings.notes[bookMeta.realName];
        }

        closeModal();
        await _callbacks.onMutation({ save: true });
    };

    modal.querySelector('#wbo-clear-alias-btn')?.addEventListener('click', () => {
        if (aliasInput instanceof HTMLInputElement) aliasInput.value = '';
    });
    modal.querySelector('#wbo-cancel-btn')?.addEventListener('click', closeModal);
    modal.querySelector('#wbo-save-alias-btn')?.addEventListener('click', save);
    aliasInput?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
    noteInput?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
}

/**
 * Move a worldbook into a custom group, ungrouped, or back to character group.
 * @param {any} bookMeta
 */
function openMoveGroupModal(bookMeta) {
    if (!_callbacks) return;
    const { settings } = _callbacks.getState();

    const options = [
        ...settings.groups.map((g) => ({
            id: g.id,
            label: g.name,
            color: g.color,
            desc: '自定义分组',
        })),
        {
            id: SPECIAL_GROUPS.UNGROUPED,
            label: bookMeta.isCharBound ? '移出角色分组（作为普通未分组显示）' : '未分组',
            color: '#8c99a6',
            desc: bookMeta.isCharBound ? '不再自动隐藏' : '默认列表',
        },
        ...(bookMeta.isCharBound
            ? [{
                id: SPECIAL_GROUPS.CHARACTER,
                label: '归回角色世界书（自动按角色名归组隐藏）',
                color: '#9b72cf',
                desc: `绑定角色：${bookMeta.charOwners.map((o) => o.charName).join('、')}`,
            }]
            : []),
    ];

    const listHtml = options
        .map(
            (opt) => `
            <button type="button" class="wbo-move-option${bookMeta.groupId === opt.id ? ' is-current' : ''}" data-target-group="${esc(opt.id)}">
                <span class="wbo-group-dot" style="background:${esc(opt.color)}"></span>
                <span class="wbo-move-label">${esc(opt.label)}</span>
                <span class="wbo-move-desc">${esc(opt.desc)}</span>
            </button>
        `,
        )
        .join('');

    const { modal } = createModal(
        `移动「${bookMeta.primaryTitle}」到分组`,
        `
            <div class="wbo-move-list">${listHtml}</div>
            <div class="wbo-modal-footer">
                <button type="button" class="menu_button" id="wbo-move-new-group">+ 新建分组</button>
                <span class="wbo-spacer"></span>
                <button type="button" class="menu_button" id="wbo-cancel-btn">关闭</button>
            </div>
        `,
    );

    modal.querySelectorAll('.wbo-move-option').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const targetId = btn.getAttribute('data-target-group');
            if (!targetId) return;

            if (targetId === SPECIAL_GROUPS.CHARACTER) {
                delete settings.assignments[bookMeta.realName];
                delete settings.charBookOverrides[bookMeta.realName];
            } else if (targetId === SPECIAL_GROUPS.UNGROUPED) {
                delete settings.assignments[bookMeta.realName];
                if (bookMeta.isCharBound) {
                    settings.charBookOverrides[bookMeta.realName] = 'exclude_from_char';
                }
            } else {
                settings.assignments[bookMeta.realName] = targetId;
                if (bookMeta.isCharBound) {
                    settings.charBookOverrides[bookMeta.realName] = 'exclude_from_char';
                }
            }

            closeModal();
            await _callbacks.onMutation({ save: true });
        });
    });

    modal.querySelector('#wbo-move-new-group')?.addEventListener('click', () => {
        openCreateOrRenameGroupModal(null);
    });
    modal.querySelector('#wbo-cancel-btn')?.addEventListener('click', closeModal);
}

/**
 * AI Smart Worldbook Organizer modal:
 * - Zero disk filename changes (virtual aliases + groups only -> safe for Persona/Chat/Card links)
 * - Zero background scanning (reads entry clues ONLY if user opts in)
 * - Supports BOTH direct host AI (`generateRaw`/`generateQuietPrompt`) AND offline Copy-Prompt / Paste-JSON
 * - Interactive preview table with checkboxes, inline edits, and undo snapshot
 */
function openAiOrganizeModal() {
    if (!_callbacks) return;
    const { settings, classification } = _callbacks.getState();

    // Default selection: non-character worldbooks (ungrouped first, plus all non-char books available)
    const nonCharBooks = [
        ...classification.ungroupedBooks,
        ...classification.customGroups.flatMap((g) => g.books),
    ];
    const allBooks = [...nonCharBooks, ...classification.characterBooks];

    if (allBooks.length === 0) {
        showToast('warning', '当前没有可整理的世界书');
        return;
    }

    const defaultChecked = new Set(
        (classification.ungroupedBooks.length > 0 ? classification.ungroupedBooks : nonCharBooks).map((b) => b.realName),
    );

    const bookChecksHtml = allBooks
        .map((b) => {
            const checked = defaultChecked.has(b.realName) ? 'checked' : '';
            const tag = b.isInCharGroup ? '<span class="wbo-tag wbo-tag-char">角色书</span>' : `<span class="wbo-tag">${esc(b.groupName)}</span>`;
            return `
                <label class="wbo-ai-pick-row">
                    <input type="checkbox" class="wbo-ai-book-check" value="${esc(b.realName)}" ${checked}>
                    <span class="wbo-ai-pick-name" title="${esc(b.realName)}">${esc(b.primaryTitle)}${b.subtitle ? ` <small>(${esc(b.subtitle)})</small>` : ''}</span>
                    ${tag}
                </label>
            `;
        })
        .join('');

    const { modal } = createModal(
        'AI 智能整理世界书命名与分类',
        `
            <div class="wbo-safe-note">
                <i class="fa-solid fa-shield-halved"></i>
                <b>零破坏安全模式</b>：仅生成插件内的「虚拟显示名 + 分组 + 备注」，<b>不会修改任何世界书真实文件名</b>，User 人设、角色卡与聊天绑定 100% 完好。
            </div>

            <div class="wbo-ai-step" id="wbo-ai-step-select">
                <div class="wbo-ai-section-head">
                    <span>1. 选择要整理的世界书（默认仅选未分组非角色书）</span>
                    <span class="wbo-ai-quick-picks">
                        <button type="button" class="wbo-link-btn" id="wbo-pick-ungrouped">仅未分组</button>
                        <button type="button" class="wbo-link-btn" id="wbo-pick-nonchar">全部非角色</button>
                        <button type="button" class="wbo-link-btn" id="wbo-pick-none">清空</button>
                    </span>
                </div>
                <div class="wbo-ai-book-list">${bookChecksHtml}</div>

                <div class="wbo-ai-options">
                    <label class="wbo-check-line">
                        <input type="checkbox" id="wbo-ai-include-clues">
                        <span>附带前 5 条条目关键词摘要（更精准；取消勾选则 0 读盘、手机端最快）</span>
                    </label>
                    <input type="text" class="text_pole wbo-input" id="wbo-ai-custom-rule" placeholder="可选偏好：例如「按文风/世界观/规则/小剧场分类，去掉版本号和作者后缀」">
                </div>

                <div class="wbo-ai-actions-row">
                    <button type="button" class="menu_button wbo-btn-primary" id="wbo-ai-run-btn">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> 直接调用当前酒馆 AI 整理
                    </button>
                    <button type="button" class="menu_button" id="wbo-ai-copy-prompt-btn" title="复制整理提示词发给外部 AI，再把 JSON 粘回下方">
                        <i class="fa-regular fa-copy"></i> 复制提示词（外部 AI）
                    </button>
                </div>

                <details class="wbo-ai-paste-box" id="wbo-ai-paste-details">
                    <summary>粘贴外部 AI 返回的 JSON 结果</summary>
                    <textarea class="text_pole wbo-textarea" id="wbo-ai-json-input" rows="5" placeholder='粘贴 JSON，例如：{"原世界书名": {"alias": "干净名字", "group": "文风设定", "note": "一句话说明"}}'></textarea>
                    <button type="button" class="menu_button" id="wbo-ai-parse-paste-btn">解析并预览</button>
                </details>

                <div class="wbo-ai-status" id="wbo-ai-status"></div>
            </div>

            <div class="wbo-ai-step" id="wbo-ai-step-preview" style="display:none;">
                <div class="wbo-ai-section-head">
                    <span>2. 预览与微调（勾选要应用的项目）</span>
                    <button type="button" class="wbo-link-btn" id="wbo-ai-back-btn">← 返回重选</button>
                </div>
                <div class="wbo-ai-preview-list" id="wbo-ai-preview-list"></div>
                <div class="wbo-modal-footer">
                    <button type="button" class="menu_button" id="wbo-ai-cancel-btn">取消</button>
                    <button type="button" class="menu_button wbo-btn-primary" id="wbo-ai-apply-btn">
                        <i class="fa-solid fa-check"></i> 确认应用选中项
                    </button>
                </div>
            </div>
        `,
        { wide: true },
    );

    const statusEl = modal.querySelector('#wbo-ai-status');
    const stepSelect = modal.querySelector('#wbo-ai-step-select');
    const stepPreview = modal.querySelector('#wbo-ai-step-preview');
    const previewList = modal.querySelector('#wbo-ai-preview-list');

    const setStatus = (msg, isError = false) => {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.className = `wbo-ai-status${isError ? ' is-error' : ''}`;
    };

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

    modal.querySelector('#wbo-pick-ungrouped')?.addEventListener('click', () =>
        setCheckedByPredicate((m) => m.groupId === SPECIAL_GROUPS.UNGROUPED),
    );
    modal.querySelector('#wbo-pick-nonchar')?.addEventListener('click', () =>
        setCheckedByPredicate((m) => !m.isInCharGroup),
    );
    modal.querySelector('#wbo-pick-none')?.addEventListener('click', () =>
        setCheckedByPredicate(() => false),
    );

    const preparePromptPayload = async () => {
        const selectedNames = getSelectedBookNames();
        if (selectedNames.length === 0) {
            setStatus('请至少勾选一本世界书', true);
            return null;
        }
        const includeClues = Boolean(modal.querySelector('#wbo-ai-include-clues')?.checked);
        const customInstruction = modal.querySelector('#wbo-ai-custom-rule')?.value || '';

        const booksPayload = [];
        for (let i = 0; i < selectedNames.length; i += 1) {
            const name = selectedNames[i];
            const meta = classification.byName.get(name);
            let sampleEntries = [];
            if (includeClues) {
                setStatus(`正在按需读取条目摘要 (${i + 1}/${selectedNames.length})...`);
                sampleEntries = await fetchWorldbookCluesOnDemand(name, 5);
            }
            booksPayload.push({
                realName: name,
                currentAlias: meta?.alias || '',
                currentGroup: meta?.groupName || '',
                sampleEntries,
            });
        }

        const existingGroups = settings.groups.map((g) => g.name);
        return buildAiOrganizePrompt({
            books: booksPayload,
            existingGroups,
            customInstruction,
        });
    };

    let currentProposals = [];

    const showPreview = (proposals, ignoredCount) => {
        currentProposals = proposals;
        if (!previewList || !stepSelect || !stepPreview) return;

        previewList.innerHTML = proposals
            .map(
                (p, idx) => `
                <div class="wbo-ai-prop-row" data-idx="${idx}">
                    <label class="wbo-ai-prop-check">
                        <input type="checkbox" class="wbo-prop-selected" checked>
                    </label>
                    <div class="wbo-ai-prop-fields">
                        <div class="wbo-ai-prop-orig" title="${esc(p.realName)}">原名：${esc(p.realName)}</div>
                        <div class="wbo-ai-prop-inputs">
                            <input type="text" class="text_pole wbo-prop-alias" value="${esc(p.alias)}" placeholder="虚拟显示名">
                            <input type="text" class="text_pole wbo-prop-group" value="${esc(p.group)}" placeholder="分组名">
                        </div>
                        <input type="text" class="text_pole wbo-prop-note" value="${esc(p.note)}" placeholder="一句话备注（可选）">
                    </div>
                </div>
            `,
            )
            .join('');

        stepSelect.style.display = 'none';
        stepPreview.style.display = 'block';
        if (ignoredCount > 0) {
            showToast('info', `已解析 ${proposals.length} 条建议（自动忽略 ${ignoredCount} 条无效项）`);
        }
    };

    const parseAndOpenPreview = (rawText) => {
        const validSet = new Set(classification.byName.keys());
        const parsed = parseAiOrganizeResponse(rawText, validSet);
        if (!parsed.ok) {
            setStatus(parsed.error || '解析失败', true);
            return;
        }
        setStatus('');
        showPreview(parsed.proposals, parsed.ignoredCount);
    };

    modal.querySelector('#wbo-ai-run-btn')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        if (btn instanceof HTMLButtonElement) btn.disabled = true;
        try {
            const prompts = await preparePromptPayload();
            if (!prompts) return;
            setStatus('正在请求当前酒馆 AI 生成整理方案（不消耗聊天上下文）...');
            const raw = await callHostAiForOrganize(prompts);
            parseAndOpenPreview(raw);
        } catch (err) {
            setStatus(`调用失败：${err?.message || err}（可改用「复制提示词」发给外部 AI）`, true);
        } finally {
            if (btn instanceof HTMLButtonElement) btn.disabled = false;
        }
    });

    modal.querySelector('#wbo-ai-copy-prompt-btn')?.addEventListener('click', async () => {
        const prompts = await preparePromptPayload();
        if (!prompts) return;
        const fullPrompt = `${prompts.systemPrompt}\n\n---\n\n${prompts.userPrompt}`;
        try {
            await navigator.clipboard.writeText(fullPrompt);
            setStatus('已复制整理提示词！发给任意 AI 后，把返回的 JSON 粘贴到下方即可预览。');
        } catch {
            // Fallback for WebViews restricting clipboard API
            const details = modal.querySelector('#wbo-ai-paste-details');
            const textarea = modal.querySelector('#wbo-ai-json-input');
            if (details instanceof HTMLDetailsElement) details.open = true;
            if (textarea instanceof HTMLTextAreaElement) {
                textarea.value = fullPrompt;
                textarea.select();
            }
            setStatus('剪贴板受限，已将提示词填入下方文本框，请全选复制。');
        }
    });

    modal.querySelector('#wbo-ai-parse-paste-btn')?.addEventListener('click', () => {
        const raw = modal.querySelector('#wbo-ai-json-input')?.value || '';
        parseAndOpenPreview(raw);
    });

    modal.querySelector('#wbo-ai-back-btn')?.addEventListener('click', () => {
        if (stepSelect) stepSelect.style.display = 'block';
        if (stepPreview) stepPreview.style.display = 'none';
    });

    modal.querySelector('#wbo-ai-cancel-btn')?.addEventListener('click', closeModal);

    modal.querySelector('#wbo-ai-apply-btn')?.addEventListener('click', async () => {
        const chosen = [];
        modal.querySelectorAll('.wbo-ai-prop-row').forEach((row) => {
            const checked = row.querySelector('.wbo-prop-selected')?.checked;
            if (!checked) return;
            const idx = Number(row.getAttribute('data-idx'));
            const orig = currentProposals[idx];
            if (!orig) return;
            chosen.push({
                realName: orig.realName,
                alias: row.querySelector('.wbo-prop-alias')?.value?.trim() || '',
                group: row.querySelector('.wbo-prop-group')?.value?.trim() || '',
                note: row.querySelector('.wbo-prop-note')?.value?.trim() || '',
            });
        });

        if (chosen.length === 0) {
            showToast('warning', '请至少勾选一项要应用的整理建议');
            return;
        }

        const { appliedCount, createdGroups } = applyAiOrganizeProposals(settings, chosen);
        closeModal();
        await _callbacks.onMutation({ save: true });
        const extra = createdGroups.length > 0 ? `，新建分组：${createdGroups.join('、')}` : '';
        showToast('success', `已应用 ${appliedCount} 本世界书的虚拟显示名与分组${extra}（支持一键撤销）`);
    });
}

/**
 * On-demand Character Binding Scan & Embedded Lorebook Import modal.
 * Inspired by RedBird Tools: handles both `lazyLoadCharacters: true` (shallow cards)
 * and characters carrying an embedded `character_book` that has not been imported yet.
 * Never runs automatically in a background loop!
 */
function openScanAndImportModal() {
    if (!_callbacks) return;

    const renderModalBody = () => {
        const { settings, classification } = _callbacks.getState();
        const characters = getCharactersInMemory();
        const worldNamesSet = new Set(getWorldNames([...classification.byName.keys()]));
        const unscannedShallow = findUnscannedShallowCharacters(characters, settings.cachedCharBindings);
        const unimported = findCardsWithUnimportedBooks({
            characters,
            worldNamesSet,
            cachedCharBindings: settings.cachedCharBindings,
        });

        const unimportedListHtml = unimported.length === 0
            ? '<div class="wbo-empty-hint">所有已加载角色卡的内嵌世界书均已导入或无内嵌世界书。</div>'
            : unimported
                .map(
                    (item) => `
                    <label class="wbo-ai-pick-row">
                        <input type="checkbox" class="wbo-import-book-check" value="${esc(item.avatar)}" checked>
                        <span class="wbo-ai-pick-name">
                            <b>${esc(item.charName)}</b>
                            <small>→ ${esc(item.importName)}（${item.entryCount} 条）</small>
                        </span>
                        <span class="wbo-tag">${item.reason === 'missing' ? '缺失' : '未导入'}</span>
                    </label>
                `,
                )
                .join('');

        return `
            <div class="wbo-safe-note">
                <i class="fa-solid fa-bolt"></i>
                <b>按需扫描，平时 0 扫盘</b>：日常使用只读内存与本地缓存，绝不持续扫盘。首次安装或批量新导入角色卡后，可在此手动扫描一次。
            </div>

            <div class="wbo-field">
                <div class="wbo-ai-section-head">
                    <span>1. 角色绑定索引（当前共 ${characters.length} 张卡，已识别 ${classification.charCount} 本角色世界书）</span>
                </div>
                <div class="wbo-ai-actions-row">
                    <button type="button" class="menu_button" id="wbo-scan-memory-btn">
                        <i class="fa-solid fa-arrows-rotate"></i> 刷新绑定缓存（极速）
                    </button>
                    ${unscannedShallow.length > 0 ? `
                    <button type="button" class="menu_button wbo-btn-primary" id="wbo-scan-shallow-btn">
                        <i class="fa-solid fa-magnifying-glass"></i> 深度扫描未加载角色卡 (${unscannedShallow.length} 张)
                    </button>` : ''}
                </div>
                ${unscannedShallow.length > 0
                    ? `<small class="wbo-label">检测到开启了懒加载（lazyLoadCharacters），以上 ${unscannedShallow.length} 张卡尚未打开过，点一次深度扫描后会自动永久记住绑定。</small>`
                    : `<small class="wbo-label">所有角色卡绑定均已在内存或缓存中就绪。</small>`}
            </div>

            <div class="wbo-field">
                <div class="wbo-ai-section-head">
                    <span>2. 卡内自带但尚未导入的世界书（${unimported.length} 本，绝不覆盖同名文件）</span>
                </div>
                <div class="wbo-ai-book-list">${unimportedListHtml}</div>
                ${unimported.length > 0 ? `
                <div class="wbo-ai-actions-row">
                    <button type="button" class="menu_button wbo-btn-primary" id="wbo-import-selected-books-btn">
                        <i class="fa-solid fa-file-import"></i> 一键导入选中世界书并自动归组隐藏
                    </button>
                </div>` : ''}
            </div>

            <div class="wbo-ai-status" id="wbo-scan-status"></div>

            <div class="wbo-modal-footer">
                <button type="button" class="menu_button" id="wbo-scan-close-btn">关闭</button>
            </div>
        `;
    };

    const { modal } = createModal('扫描角色卡与内嵌世界书', renderModalBody(), { wide: true });
    const cancelSignal = { cancelled: false };

    const bindHandlers = () => {
        const statusEl = modal.querySelector('#wbo-scan-status');
        const setStatus = (msg, isError = false) => {
            if (!statusEl) return;
            statusEl.textContent = msg;
            statusEl.className = `wbo-ai-status${isError ? ' is-error' : ''}`;
        };

        modal.querySelector('#wbo-scan-close-btn')?.addEventListener('click', () => {
            cancelSignal.cancelled = true;
            closeModal();
        });

        modal.querySelector('#wbo-scan-memory-btn')?.addEventListener('click', async () => {
            setStatus('正在刷新绑定缓存...');
            await _callbacks.onRescan();
            const body = modal.querySelector('.wbo-modal-body');
            if (body) {
                body.innerHTML = renderModalBody();
                bindHandlers();
                const nextStatus = modal.querySelector('#wbo-scan-status');
                if (nextStatus) nextStatus.textContent = '已完成绑定刷新并更新缓存。';
            }
        });

        modal.querySelector('#wbo-scan-shallow-btn')?.addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            if (btn instanceof HTMLButtonElement) btn.disabled = true;
            cancelSignal.cancelled = false;

            const { settings } = _callbacks.getState();
            const targets = findUnscannedShallowCharacters(getCharactersInMemory(), settings.cachedCharBindings);
            setStatus(`开始分批扫描 ${targets.length} 张未加载角色卡...`);

            const res = await scanShallowCharactersInBatches(targets, {
                signal: cancelSignal,
                onProgress: (done, total, currentName) => {
                    setStatus(`正在扫描 (${done}/${total})：${currentName}`);
                },
            });

            if (res.scanned.length > 0) {
                const { cached } = updateCachedCharBindings({}, res.scanned);
                Object.assign(settings.cachedCharBindings, cached);
            }

            await _callbacks.onMutation({ save: true });
            const body = modal.querySelector('.wbo-modal-body');
            if (body && !cancelSignal.cancelled) {
                body.innerHTML = renderModalBody();
                bindHandlers();
                const nextStatus = modal.querySelector('#wbo-scan-status');
                if (nextStatus) {
                    nextStatus.textContent = `已完成 ${res.done} 张角色卡扫描并写入持久化缓存！`;
                }
            }
        });

        modal.querySelector('#wbo-import-selected-books-btn')?.addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            if (btn instanceof HTMLButtonElement) btn.disabled = true;

            const avatars = Array.from(modal.querySelectorAll('.wbo-import-book-check:checked')).map((el) => el.value);
            if (avatars.length === 0) {
                setStatus('请先勾选要导入的角色世界书', true);
                if (btn instanceof HTMLButtonElement) btn.disabled = false;
                return;
            }

            let imported = 0;
            let skipped = 0;
            let failed = 0;
            const knownNames = new Set(getWorldNames());

            for (let i = 0; i < avatars.length; i += 1) {
                setStatus(`正在导入内嵌世界书 (${i + 1}/${avatars.length})...`);
                const res = await importEmbeddedWorldbookForCharacter(avatars[i], { worldNamesSet: knownNames });
                if (res.status === 'imported') {
                    imported += 1;
                    if (res.name) knownNames.add(res.name);
                } else if (res.status === 'exists' || res.status === 'nobook') {
                    skipped += 1;
                } else {
                    failed += 1;
                }
            }

            await _callbacks.onRescan();
            const body = modal.querySelector('.wbo-modal-body');
            if (body) {
                body.innerHTML = renderModalBody();
                bindHandlers();
                const nextStatus = modal.querySelector('#wbo-scan-status');
                if (nextStatus) {
                    nextStatus.textContent = `导入完成：成功 ${imported} 本，跳过 ${skipped} 本${failed > 0 ? `，失败 ${failed} 本` : ''}，已自动归入「角色世界书」分组。`;
                }
            }
            if (imported > 0) {
                showToast('success', `已导入 ${imported} 本角色内嵌世界书并归入角色分组`);
            }
        });
    };

    bindHandlers();
}

// ==================== Extension Settings Panel ====================

/**
 * Mount the extension settings accordion inside `#extensions_settings2` (or `#extensions_settings`).
 */
export function renderExtensionSettingsPanel() {
    if (!_callbacks) return;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) return;

    let root = document.getElementById(SETTINGS_ROOT_ID);
    if (!root) {
        root = document.createElement('div');
        root.id = SETTINGS_ROOT_ID;
        root.className = 'wbo-ext-settings';
        container.appendChild(root);
        _settingsMounted = true;
    }

    const { settings, classification } = _callbacks.getState();

    root.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>世界书分组管理 (Worldbook Organizer)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="wbo-settings-body">
                    <div class="wbo-settings-summary">
                        已识别 ${classification.totalCount} 本世界书：<b>${classification.nonCharCount}</b> 本通用/分组，<b>${classification.charCount}</b> 本角色卡绑定。
                    </div>

                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="hideCharBooksByDefault" ${settings.hideCharBooksByDefault ? 'checked' : ''}>
                        <span>打开酒馆时默认隐藏角色卡绑定的世界书</span>
                    </label>

                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="includeExtraCharBooks" ${settings.includeExtraCharBooks ? 'checked' : ''}>
                        <span>将角色卡「附加世界书」也归入角色世界书分组</span>
                    </label>

                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="includeEmbeddedNameMatch" ${settings.includeEmbeddedNameMatch ? 'checked' : ''}>
                        <span>识别角色卡内嵌同名世界书（character_book）</span>
                    </label>

                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="autoImportMissingCharBook" ${settings.autoImportMissingCharBook ? 'checked' : ''}>
                        <span>打开角色卡时自动导入缺失的卡内世界书（绝不覆盖同名文件）</span>
                    </label>

                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="autoHideInCharBindPopup" ${settings.autoHideInCharBindPopup ? 'checked' : ''}>
                        <span>角色卡「连接到世界书」弹窗默认隐藏其他角色的世界书</span>
                    </label>

                    <label class="wbo-check-line">
                        <input type="checkbox" data-setting="showNativeOptgroups" ${settings.showNativeOptgroups ? 'checked' : ''}>
                        <span>原生世界书编辑器下拉框按分组（optgroup）显示</span>
                    </label>

                    <div class="wbo-setting-row">
                        <span>角色世界书标题显示方式</span>
                        <select class="text_pole" data-setting-select="charBookTitleMode">
                            <option value="char_with_sub" ${settings.charBookTitleMode === 'char_with_sub' ? 'selected' : ''}>按角色名显示 + 小字标注作者原标题</option>
                            <option value="char_only" ${settings.charBookTitleMode === 'char_only' ? 'selected' : ''}>仅按角色名显示（隐藏作者原标题）</option>
                            <option value="original" ${settings.charBookTitleMode === 'original' ? 'selected' : ''}>保留作者原标题</option>
                        </select>
                    </div>

                    <div class="wbo-setting-row">
                        <span>AI/自定义虚拟别名显示方式</span>
                        <select class="text_pole" data-setting-select="aliasTitleMode">
                            <option value="alias_with_sub" ${settings.aliasTitleMode === 'alias_with_sub' ? 'selected' : ''}>显示虚拟别名 + 小字标注原文件名</option>
                            <option value="alias_only" ${settings.aliasTitleMode === 'alias_only' ? 'selected' : ''}>仅显示虚拟别名（隐藏原文件名）</option>
                        </select>
                    </div>

                    <div class="wbo-settings-actions">
                        <button type="button" class="menu_button" data-settings-action="rescan">
                            <i class="fa-solid fa-arrows-rotate"></i> 重新扫描角色绑定
                        </button>
                        <button type="button" class="menu_button" data-settings-action="export">
                            <i class="fa-solid fa-download"></i> 导出分组配置
                        </button>
                        <button type="button" class="menu_button" data-settings-action="import">
                            <i class="fa-solid fa-upload"></i> 导入分组配置
                        </button>
                        <input type="file" id="wbo-import-config-file" accept=".json" hidden>
                    </div>
                </div>
            </div>
        </div>
    `;

    root.querySelectorAll('input[data-setting]').forEach((el) => {
        el.addEventListener('change', async () => {
            if (!(el instanceof HTMLInputElement)) return;
            const key = el.getAttribute('data-setting');
            if (!key) return;
            settings[key] = el.checked;
            if (key === 'hideCharBooksByDefault') {
                settings.showCharBooks = !el.checked;
            }
            await _callbacks.onMutation({ save: true });
        });
    });

    root.querySelectorAll('select[data-setting-select]').forEach((el) => {
        el.addEventListener('change', async () => {
            if (!(el instanceof HTMLSelectElement)) return;
            const key = el.getAttribute('data-setting-select');
            if (!key) return;
            settings[key] = el.value;
            await _callbacks.onMutation({ save: true });
        });
    });

    root.querySelector('[data-settings-action="rescan"]')?.addEventListener('click', async () => {
        await _callbacks.onRescan();
        showToast('success', '已完成角色绑定扫描');
    });

    root.querySelector('[data-settings-action="export"]')?.addEventListener('click', () => {
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
        showToast('success', '已导出分组与别名配置');
    });

    const importFileInput = root.querySelector('#wbo-import-config-file');
    root.querySelector('[data-settings-action="import"]')?.addEventListener('click', () => {
        if (importFileInput instanceof HTMLInputElement) {
            importFileInput.value = '';
            importFileInput.click();
        }
    });

    importFileInput?.addEventListener('change', async () => {
        if (!(importFileInput instanceof HTMLInputElement) || !importFileInput.files?.[0]) return;
        try {
            const text = await importFileInput.files[0].text();
            const res = importConfigData(settings, text);
            if (!res.ok) {
                showToast('error', res.error || '导入失败');
                return;
            }
            await _callbacks.onMutation({ save: true });
            showToast(
                'success',
                `导入成功：${res.stats.groups} 个分组、${res.stats.assignments} 条归组、${res.stats.aliases} 条显示别名`,
            );
        } catch (err) {
            showToast('error', `读取配置文件失败：${err?.message || err}`);
        }
    });
}

/**
 * Remove all DOM nodes mounted by this panel module cleanly.
 */
export function teardownPanels() {
    closeModal();
    document.getElementById(PANEL_ROOT_ID)?.remove();
    document.getElementById(SETTINGS_ROOT_ID)?.remove();
    _panelMounted = false;
    _settingsMounted = false;
}
