import { bindWorldbookToCharacter, getCharactersInMemory, getWorldNames, inspectCharacterWorldbookBinding, showToast } from './host.js';
import { _callbacks, closeSubModal, createSubModal, esc } from './panel-window.js';

export function openCharacterBindingModal(worldName, { suggestedAvatar, onBound, stack = false } = {}) {
    if (!_callbacks) return;
    if (!getWorldNames().includes(worldName)) {
        showToast('warning', '找不到这本世界书。请回角色的发布处找，导入后再绑定。');
        return;
    }
    const characters = getCharactersInMemory()
        .filter((card) => typeof card?.avatar === 'string' && card.avatar)
        .map((card) => ({ avatar: card.avatar, name: card.name || card.data?.name || card.avatar }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.avatar.localeCompare(b.avatar));
    const renderChoices = (cards, emptyLabel) =>
        `<option value="">${cards.length ? '请选择角色卡' : emptyLabel}</option>`
        + cards.map((card) =>
            `<option value="${esc(card.avatar)}">${esc(card.name)} · ${esc(card.avatar)}</option>`,
        ).join('');

    const { modal, overlay } = createSubModal('绑定世界书到角色', `
        <div class="wbo-bind-content">
            <div class="wbo-bind-heading">
                <strong>${esc(worldName)}</strong>
                <details class="wbo-bind-help">
                    <summary aria-label="查看绑定说明" title="查看绑定说明">ⓘ</summary>
                    <p>这本书会跟着角色走。酒馆角色编辑页的 <i class="fa-solid fa-globe" aria-hidden="true"></i> 小地球也能查看绑定。</p>
                    <p>主世界书只能有一本，导出角色卡时会随卡带走。附加世界书可以有多本，导出角色卡时不会一同带走。</p>
                </details>
            </div>
            <label class="wbo-bind-label">搜索角色名
                <input type="search" class="wbo-input" data-bind-character-search placeholder="输入角色名" autocomplete="off" spellcheck="false">
            </label>
            <label class="wbo-bind-label">选择角色
                <select class="wbo-select" data-bind-character>
                    ${renderChoices(characters, '没有可绑定的角色卡')}
                </select>
            </label>
            <div class="wbo-bind-card" data-bind-card hidden>
                <img data-bind-avatar alt="角色头像" width="68" height="68">
                <div>
                    <strong data-bind-name></strong>
                    <div class="wbo-cov-reason" data-bind-filename></div>
                    <div data-bind-current></div>
                </div>
            </div>
            <fieldset class="wbo-bind-options" data-bind-options disabled>
                <legend>绑定方式</legend>
                <label><input type="radio" name="wbo-bind-kind" value="primary"> 设为主世界书</label>
                <label><input type="radio" name="wbo-bind-kind" value="extra"> 添加为附加世界书</label>
            </fieldset>
            <p class="wbo-cov-missing" data-bind-warning hidden></p>
            <p role="status" data-bind-status hidden></p>
        </div>
        <div class="wbo-modal-footer wbo-pinned-footer wbo-footer-pair">
            <button type="button" class="wbo-btn" data-bind-cancel>取消</button>
            <button type="button" class="wbo-btn wbo-btn-primary" data-bind-confirm disabled>确认绑定</button>
        </div>
    `, { pinnedLayout: true, stack });

    const select = modal.querySelector('[data-bind-character]');
    const search = modal.querySelector('[data-bind-character-search]');
    const cardEl = modal.querySelector('[data-bind-card]');
    const avatarEl = modal.querySelector('[data-bind-avatar]');
    const warning = modal.querySelector('[data-bind-warning]');
    const status = modal.querySelector('[data-bind-status]');
    const options = modal.querySelector('[data-bind-options]');
    const confirmBtn = modal.querySelector('[data-bind-confirm]');
    const close = () => closeSubModal({ overlay });
    let selected = null;
    let busy = false;
    let request = 0;

    function showStatus(message) {
        status.textContent = message;
        status.hidden = !message;
    }

    function syncConfirm() {
        const kind = modal.querySelector('[name="wbo-bind-kind"]:checked')?.value;
        const replacement = kind === 'primary' && selected?.primary && selected.primary !== worldName;
        warning.hidden = !replacement;
        warning.textContent = replacement ? `主世界书只能有一本。继续会将「${selected.primary}」替换为「${worldName}」。` : '';
        confirmBtn.textContent = replacement ? '替换主世界书' : '确认绑定';
        confirmBtn.disabled = busy || !selected || !kind;
        options.disabled = busy || !selected;
        select.disabled = busy || select.options.length <= 1;
        search.disabled = busy || !characters.length;
    }

    async function selectCard() {
        const id = ++request;
        const avatar = select.value;
        const choice = characters.find((card) => card.avatar === avatar);
        selected = null;
        for (const option of options.querySelectorAll('input')) option.checked = false;
        cardEl.hidden = !choice;
        showStatus(choice ? '正在读取角色卡…' : '');
        syncConfirm();
        if (!choice) return;
        avatarEl.src = `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
        modal.querySelector('[data-bind-name]').textContent = choice.name;
        modal.querySelector('[data-bind-filename]').textContent = avatar;
        modal.querySelector('[data-bind-current]').textContent = '';
        const card = await inspectCharacterWorldbookBinding(avatar);
        if (id !== request || !overlay.isConnected) return;
        selected = card;
        modal.querySelector('[data-bind-name]').textContent = card?.name || choice.name;
        modal.querySelector('[data-bind-current]').textContent = card ? `当前主世界书：${card.primary || '无'}` : '';
        showStatus(card ? '' : '读不到这张角色卡，请重新选择。');
        syncConfirm();
    }

    function filterCharacters() {
        const query = search.value.trim().normalize('NFKC').toLowerCase();
        const matches = characters.filter((card) => card.name.normalize('NFKC').toLowerCase().includes(query));
        const avatar = select.value;
        select.innerHTML = renderChoices(matches, '没有匹配的角色卡');
        select.value = matches.some((card) => card.avatar === avatar) ? avatar : '';
        if (select.value !== avatar) void selectCard();
        else syncConfirm();
    }

    search.addEventListener('input', (event) => {
        if (!event.isComposing) filterCharacters();
    });
    search.addEventListener('compositionend', filterCharacters);
    select.addEventListener('change', selectCard);
    options.addEventListener('change', syncConfirm);
    modal.querySelector('[data-bind-cancel]').addEventListener('click', close);
    confirmBtn.addEventListener('click', async () => {
        const kind = modal.querySelector('[name="wbo-bind-kind"]:checked')?.value;
        if (!selected || !kind || busy || selected.avatar !== select.value) return;
        busy = true;
        syncConfirm();
        showStatus('正在保存…');
        const { avatar, name, primary } = selected;
        const result = await bindWorldbookToCharacter(avatar, worldName, {
            kind, expectedPrimary: primary, settings: _callbacks.getState().settings,
        });
        busy = false;
        if (!result.ok) {
            if (!overlay.isConnected) return;
            if (result.stale) await selectCard();
            showStatus(result.error);
            syncConfirm();
            return;
        }
        if (overlay.isConnected) close();
        await _callbacks.onMutation({ save: kind === 'primary' && !result.already });
        onBound?.();
        showToast('success', result.already
            ? `「${name}」已绑定这本世界书`
            : `已为「${name}」${kind === 'primary' ? '设置主世界书' : '添加附加世界书'}`);
    });

    if (suggestedAvatar && characters.some((card) => card.avatar === suggestedAvatar)) {
        select.value = suggestedAvatar;
        void selectCard();
    } else {
        syncConfirm();
    }
}
