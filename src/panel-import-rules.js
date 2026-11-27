import { addCustomGroup, findSensitiveTargetGroup, findUnscannedShallowCharacters, normalizeImportOrganize } from './core.js';
import { getCharactersInMemory, getCharLoreEntries, showToast } from './host.js';
import { applyImportedWorldbookPlan, findSensitiveImportCandidates } from './import-organizer.js';
import { _callbacks, closeSubModal, createSubModal, esc } from './panel-window.js';
import { findScrollableContent, scrollContentToItem } from './content-scroll.js';

const createGroupChoice = '__create_group__';

function currentSensitiveBooks({ settings, classification }, includeGrouped = false) {
    return findSensitiveImportCandidates({
        settings,
        titles: [...classification.byName.keys()],
        characters: getCharactersInMemory(),
        charLore: getCharLoreEntries(),
        includeGrouped,
    });
}

export function shouldOfferImportRules(state) {
    if (state.settings.importOrganize?.sensitivePromptSeen !== false) return false;
    return currentSensitiveBooks(state, true).length > 0;
}

export async function dismissImportRulesIntro() {
    const current = _callbacks.getState().settings;
    current.importOrganize = { ...current.importOrganize, sensitivePromptSeen: true };
    await _callbacks.onMutation({ save: true });
}

export function openImportRulesModal({ intro = false, stack = false, onResolved } = {}) {
    if (!_callbacks) return;
    const state = _callbacks.getState();
    const { settings } = state;
    const config = normalizeImportOrganize(settings.importOrganize, settings.groups);
    const suggested = findSensitiveTargetGroup(settings.groups);
    const existingBooks = intro ? currentSensitiveBooks(state) : [];
    const scanPending = findUnscannedShallowCharacters(getCharactersInMemory(), settings.cachedCharBindings).length > 0;
    const draftRules = config.rules.map((rule) => ({ ...rule }));
    const groupOptions = settings.groups.map((group) =>
        `<option value="${esc(group.id)}">${esc(group.name)}</option>`,
    ).join('');

    const { overlay, modal } = createSubModal('导入归类', `
        <div class="wbo-step-scroll wbo-import-rules">
            <p class="wbo-subtle-tip">导入时只看世界书文件标题。角色世界书和已有分组的书会跳过。</p>
            <section class="wbo-card">
                <div class="wbo-ai-section-head"><span>疑似敏感世界书</span></div>
                ${intro ? '<p>检测到有疑似敏感的世界书。要按标题把这类书自动归到一个分组吗？</p>' : ''}
                <label class="wbo-import-field">归到
                    <select class="wbo-select" data-import-sensitive-group>
                        <option value="">不自动归类</option>
                        ${groupOptions}
                        <option value="${createGroupChoice}">新建分组…</option>
                    </select>
                </label>
                <label class="wbo-import-field" data-import-create-name hidden>新分组名
                    <input type="text" class="wbo-input" data-import-group-name value="NSFW" maxlength="60" spellcheck="false">
                </label>
                ${existingBooks.length ? `
                    <label class="wbo-check-line">
                        <input type="checkbox" data-import-apply-existing${scanPending ? ' disabled' : ''}>
                        <span>同时归类已有的 ${existingBooks.length} 本未分组世界书</span>
                    </label>
                    ${scanPending ? '<p class="wbo-subtle-tip">先扫描角色卡，再处理已有世界书。</p>' : ''}` : ''}
            </section>
            ${intro ? '<p class="wbo-subtle-tip">之后可在「设置 → 识别与适配 → 导入归类」修改。</p>' : `
                <section class="wbo-card">
                    <div class="wbo-ai-section-head">
                        <span>自定义标题规则</span>
                        <button type="button" class="wbo-btn" data-import-add-rule>添加规则</button>
                    </div>
                    <p class="wbo-subtle-tip">按列表顺序匹配，自定义规则优先。</p>
                    <div class="wbo-import-rule-list" data-import-rule-list></div>
                </section>`}
            <div class="wbo-ai-status" data-import-rule-status role="status" hidden></div>
        </div>
        <div class="wbo-modal-footer wbo-pinned-footer wbo-footer-pair">
            <button type="button" class="wbo-btn wbo-btn-primary" data-import-rules-save>${intro ? '保存选择' : '保存规则'}</button>
            <button type="button" class="wbo-btn" data-import-rules-cancel>${intro ? '跳过' : '取消'}</button>
        </div>
    `, { pinnedLayout: true, stack });

    const sensitiveSelect = modal.querySelector('[data-import-sensitive-group]');
    const newGroupField = modal.querySelector('[data-import-create-name]');
    const groupNameInput = modal.querySelector('[data-import-group-name]');
    const ruleList = modal.querySelector('[data-import-rule-list]');
    const save = modal.querySelector('[data-import-rules-save]');
    const status = modal.querySelector('[data-import-rule-status]');
    let saving = false;

    sensitiveSelect.value = config.sensitiveGroupId || (intro ? suggested?.id || createGroupChoice : '');
    function syncDestination() {
        newGroupField.hidden = sensitiveSelect.value !== createGroupChoice;
    }

    function renderDraftRules() {
        if (!ruleList) return;
        ruleList.innerHTML = draftRules.map(({ keyword }, i) => `
            <div class="wbo-import-rule" data-import-rule="${i}">
                <input type="text" class="wbo-input" data-import-keyword aria-label="标题关键词" placeholder="标题包含…" value="${esc(keyword)}" maxlength="100" spellcheck="false">
                <select class="wbo-select" data-import-rule-target aria-label="归到的分组">
                    <option value="">选择分组</option>
                    ${groupOptions}
                </select>
                <button type="button" class="wbo-icon-btn" data-import-delete-rule aria-label="移除规则" title="移除规则">
                    <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
            </div>
        `).join('');
        ruleList.querySelectorAll('[data-import-rule-target]').forEach((select, i) => {
            select.value = draftRules[i].groupId;
        });
    }

    function reportError(message) {
        status.textContent = message;
        status.hidden = false;
        status.classList.add('is-error');
    }

    const close = () => { if (overlay.isConnected) closeSubModal({ overlay }); };
    const skipIntro = async () => {
        if (!intro || saving) return;
        await dismissImportRulesIntro();
        onResolved?.();
    };
    modal.querySelector('[data-import-rules-cancel]').addEventListener('click', () => {
        if (saving) return;
        close();
        void skipIntro();
    });
    if (intro) modal.querySelector('.wbo-modal-close')?.addEventListener('click', skipIntro);
    sensitiveSelect.addEventListener('change', syncDestination);
    modal.querySelector('[data-import-add-rule]')?.addEventListener('click', () => {
        if (draftRules.length >= 100) return;
        if (!settings.groups.length) {
            reportError('先在管理分组里建一个分组，再添加标题规则。');
            return;
        }
        draftRules.push({ keyword: '', groupId: '' });
        renderDraftRules();
        const row = ruleList.lastElementChild;
        if (row) scrollContentToItem(findScrollableContent(row, modal), row);
    });
    const onRuleInput = (ev) => {
        const row = ev.target.closest('[data-import-rule]');
        if (!row) return;
        const rule = draftRules[Number(row.getAttribute('data-import-rule'))];
        if (ev.target.hasAttribute('data-import-keyword')) rule.keyword = ev.target.value;
        if (ev.target.hasAttribute('data-import-rule-target')) rule.groupId = ev.target.value;
    };
    ruleList?.addEventListener('input', onRuleInput);
    ruleList?.addEventListener('change', onRuleInput);
    ruleList?.addEventListener('click', (ev) => {
        if (!ev.target.closest('[data-import-delete-rule]')) return;
        draftRules.splice(Number(ev.target.closest('[data-import-rule]').getAttribute('data-import-rule')), 1);
        renderDraftRules();
    });

    save.addEventListener('click', async () => {
        if (saving) return;
        const latestState = _callbacks.getState();
        const current = latestState.settings;
        const validGroups = new Set(current.groups.map((group) => group.id));
        const rules = draftRules.filter((rule) => rule.keyword.trim() || rule.groupId);
        const keys = new Set();
        for (const rule of rules) {
            const key = rule.keyword.trim().normalize('NFKC').toLowerCase();
            if (!key || !validGroups.has(rule.groupId)) {
                reportError('每条规则都需要填写关键词并选择分组。');
                return;
            }
            if (keys.has(key)) {
                reportError('同一个关键词只能设置一条规则。');
                return;
            }
            keys.add(key);
        }

        let groupId = sensitiveSelect.value;
        if (groupId === createGroupChoice) {
            const name = groupNameInput.value.trim();
            if (!name) {
                reportError('请填写新分组名。');
                return;
            }
            groupId = (current.groups.find((group) => group.name.toLowerCase() === name.toLowerCase()) || addCustomGroup(current, { name })).id;
        } else if (groupId && !validGroups.has(groupId)) {
            reportError('这个分组已不存在，请重新选择。');
            return;
        }

        const applyExisting = intro && groupId && modal.querySelector('[data-import-apply-existing]')?.checked;
        let moved = 0;
        if (applyExisting && findUnscannedShallowCharacters(getCharactersInMemory(), current.cachedCharBindings).length === 0) {
            moved = applyImportedWorldbookPlan(current, currentSensitiveBooks(latestState).map((title) => ({ title, groupId })));
        }
        current.importOrganize = normalizeImportOrganize({
            sensitivePromptSeen: true,
            sensitiveGroupId: groupId,
            rules,
        }, current.groups);
        saving = true;
        save.disabled = true;
        await _callbacks.onMutation({ save: true });
        close();
        onResolved?.();
        showToast('success', moved ? `已保存规则，并归类 ${moved} 本世界书` : '已保存导入归类规则');
    });

    syncDestination();
    renderDraftRules();
}
