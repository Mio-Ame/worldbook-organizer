import { bindWorldbookToCharacter, getCharactersInMemory, getWorldNames, inspectCharacterWorldbookBinding, showToast } from './host.js';
import { _callbacks, closeSubModal, createSubModal, esc } from './panel-window.js';
let bindingPickerSerial = 0;

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
    const listId = `wbo-bind-character-list-${++bindingPickerSerial}`;

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
            <div class="wbo-bind-picker">
                <label class="wbo-bind-label">角色卡
                    <span class="wbo-bind-combo">
                        <input type="search" class="wbo-input" data-bind-character-search placeholder="选择角色卡或输入角色名搜索" autocomplete="off" spellcheck="false"
                            role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${listId}">
                        <button type="button" class="wbo-icon-btn" data-bind-picker-toggle aria-label="展开角色卡列表" aria-controls="${listId}" aria-expanded="false"><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button>
                    </span>
                </label>
                <div class="wbo-bind-choices" id="${listId}" role="listbox" aria-label="角色卡" data-bind-choices hidden></div>
                <select data-bind-character hidden aria-hidden="true" tabindex="-1">
                    ${renderChoices(characters, '没有可绑定的角色卡')}
                </select>
            </div>
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
            <button type="button" class="wbo-btn wbo-btn-primary" data-bind-confirm disabled>确认绑定</button>
            <button type="button" class="wbo-btn" data-bind-cancel>取消</button>
        </div>
    `, { pinnedLayout: true, stack });

    const select = modal.querySelector('[data-bind-character]');
    const search = modal.querySelector('[data-bind-character-search]');
    const choices = modal.querySelector('[data-bind-choices]');
    const pickerToggle = modal.querySelector('[data-bind-picker-toggle]');
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
    let matchedCharacters = characters;
    let activeChoice = -1;

    function setPickerOpen(open) {
        choices.hidden = !open;
        search.setAttribute('aria-expanded', String(open));
        pickerToggle.setAttribute('aria-expanded', String(open));
        pickerToggle.setAttribute('aria-label', open ? '收起角色卡列表' : '展开角色卡列表');
        if (!open) search.removeAttribute('aria-activedescendant');
    }

    function renderPicker() {
        activeChoice = -1;
        search.removeAttribute('aria-activedescendant');
        choices.innerHTML = matchedCharacters.length ? matchedCharacters.map((card, index) => `
            <button type="button" role="option" tabindex="-1" id="${listId}-${index}" data-bind-avatar-choice="${esc(card.avatar)}" aria-selected="${card.avatar === select.value}">
                <span>${esc(card.name)}</span><small>${esc(card.avatar)}</small>
            </button>`).join('') : '<p class="wbo-subtle-tip">没有匹配的角色卡</p>';
    }

    function chooseCard(avatar) {
        select.value = avatar;
        setPickerOpen(false);
        void selectCard();
    }

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
        pickerToggle.disabled = search.disabled;
    }

    async function selectCard() {
        const id = ++request;
        const avatar = select.value;
        const choice = characters.find((card) => card.avatar === avatar);
        if (choice) search.value = choice.name;
        setPickerOpen(false);
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
        matchedCharacters = matches;
        const avatar = select.value;
        select.innerHTML = renderChoices(matches, '没有匹配的角色卡');
        select.value = matches.some((card) => card.avatar === avatar && card.name === search.value) ? avatar : '';
        if (select.value !== avatar) void selectCard();
        else syncConfirm();
        renderPicker();
        setPickerOpen(true);
    }

    search.addEventListener('input', (event) => {
        if (!event.isComposing) filterCharacters();
    });
    search.addEventListener('compositionend', filterCharacters);
    search.addEventListener('click', () => {
        if (busy || !characters.length) return;
        if (selected && search.value === selected.name) {
            matchedCharacters = characters;
            select.innerHTML = renderChoices(characters, '没有可绑定的角色卡');
            select.value = selected.avatar;
        }
        renderPicker();
        setPickerOpen(true);
    });
    pickerToggle.addEventListener('click', () => {
        if (!choices.hidden) setPickerOpen(false);
        else {
            matchedCharacters = characters;
            const avatar = select.value;
            select.innerHTML = renderChoices(characters, '没有可绑定的角色卡');
            select.value = avatar;
            renderPicker();
            setPickerOpen(true);
        }
    });
    choices.addEventListener('click', (event) => {
        const choice = event.target.closest('[data-bind-avatar-choice]');
        if (choice) chooseCard(choice.dataset.bindAvatarChoice);
    });
    modal.addEventListener('click', (event) => {
        if (!event.target.closest('.wbo-bind-picker')) setPickerOpen(false);
    });
    const picker = modal.querySelector('.wbo-bind-picker');
    picker.addEventListener('focusout', (event) => {
        if (!picker.contains(event.relatedTarget)) setPickerOpen(false);
    });
    picker.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || choices.hidden || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        setPickerOpen(false);
    });
    search.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Escape' && !choices.hidden) {
            event.preventDefault();
            event.stopPropagation();
            setPickerOpen(false);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setPickerOpen(true);
            const buttons = [...choices.querySelectorAll('[role="option"]')];
            if (!buttons.length) return;
            activeChoice = (activeChoice + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
            buttons.forEach((button, index) => button.classList.toggle('is-active', index === activeChoice));
            const target = buttons[activeChoice];
            search.setAttribute('aria-activedescendant', target.id);
            const top = target.offsetTop - choices.offsetTop;
            if (top < choices.scrollTop) choices.scrollTop = top;
            else if (top + target.offsetHeight > choices.scrollTop + choices.clientHeight) choices.scrollTop = top + target.offsetHeight - choices.clientHeight;
        } else if (event.key === 'Enter' && !choices.hidden && activeChoice >= 0) {
            event.preventDefault();
            chooseCard(matchedCharacters[activeChoice].avatar);
        }
    });
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

    renderPicker();
    if (suggestedAvatar && characters.some((card) => card.avatar === suggestedAvatar)) {
        select.value = suggestedAvatar;
        void selectCard();
    } else {
        syncConfirm();
    }
}
