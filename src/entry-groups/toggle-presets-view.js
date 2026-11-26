const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderTogglePresetResult(result, { undoHtml, expanded = false, filter = 'enabled', limit = 60 } = {}) {
    if (!result) return '';
    const enabled = result.changes.filter((change) => !change.disabled);
    const disabled = result.changes.filter((change) => change.disabled);
    const shown = filter === 'disabled' ? disabled : enabled;
    return `<section class="weg-preset-card weg-preset-result" id="weg-preset-result" aria-label="本次切换结果">
        <div class="weg-preset-result-head"><strong>${result.undone ? '已撤回切换' : `已切换「${esc(result.name)}」`}</strong>${undoHtml || ''}</div>
        <p class="weg-preset-counts" role="status">${result.changes.length ? `开启 ${enabled.length} 条 · 关闭 ${disabled.length} 条` : '条目开关没有变化'}</p>
        ${result.changes.length ? `<details${expanded ? ' open' : ''}><summary>查看变动 <i class="fa-solid fa-chevron-down" aria-hidden="true"></i></summary>
            <div class="weg-preset-diff-tabs" aria-label="变动类型">
                <button type="button" class="weg-filter-pill${filter === 'enabled' ? ' is-active' : ''}" data-weg-change-filter="enabled" aria-pressed="${filter === 'enabled'}">开启 ${enabled.length} 条</button>
                <button type="button" class="weg-filter-pill${filter === 'disabled' ? ' is-active' : ''}" data-weg-change-filter="disabled" aria-pressed="${filter === 'disabled'}">关闭 ${disabled.length} 条</button>
            </div>
            <ul class="weg-preset-change-list" data-weg-change-list>${shown.slice(0, limit).map((change) => `<li><i class="fa-solid ${change.disabled ? 'fa-minus' : 'fa-check'}" aria-hidden="true"></i><span>${esc(change.title)}</span></li>`).join('') || '<li>没有这类变动</li>'}</ul>
            ${shown.length > limit ? '<button type="button" class="weg-btn weg-btn-subtle" data-weg-preset-action="more-changes">继续显示</button>' : ''}
        </details>` : ''}
    </section>`;
}

export function renderTogglePresetsPage({ presets, greetings, chatHint, profile, chatAvailable, busy, ready, nameDraft, editingId, resultHtml, undoHtml, backup }) {
    return `${resultHtml || ''}
        <section class="weg-preset-card" aria-label="我的方案">
            <div class="weg-preset-result-head"><h3>我的方案</h3>${!resultHtml ? undoHtml : ''}</div>
            <p>保存当前条目开关方案，用于这本世界书。</p>
            <div class="weg-preset-actions">
                <input type="text" class="weg-input" id="weg-preset-name" aria-label="方案名称" placeholder="方案名称" maxlength="80" spellcheck="false" autocomplete="off" value="${esc(nameDraft)}" ${busy ? 'disabled' : ''}>
                <button type="button" class="weg-btn weg-btn-primary" data-weg-preset-action="save-new" ${!ready || busy ? 'disabled' : ''}>${editingId ? '保存名称' : '保存当前方案'}</button>
                ${editingId ? '<button type="button" class="weg-btn weg-btn-subtle" data-weg-preset-action="cancel-rename">取消</button>' : ''}
            </div>
            <div class="weg-preset-list">${presets.map((preset) => {
                const states = Object.values(preset.states);
                return `<div class="weg-preset-row"><div class="weg-preset-row-name"><strong>${esc(preset.name)}</strong><span>开启 ${states.filter((disabled) => !disabled).length} 条 · 关闭 ${states.filter(Boolean).length} 条</span></div>
                    <button type="button" class="weg-btn weg-btn-subtle" data-weg-preset-action="apply" data-preset-id="${esc(preset.id)}" ${!ready || busy ? 'disabled' : ''}>切换</button>
                    <button type="button" class="weg-more-btn" data-weg-preset-action="menu" data-preset-id="${esc(preset.id)}" aria-label="${esc(preset.name)}的操作" aria-expanded="false" ${busy ? 'disabled' : ''}>···</button></div>`;
            }).join('') || '<p class="weg-preset-empty">尚未保存方案</p>'}</div>
        </section>
        ${backup ? `<section class="weg-preset-card" aria-label="操作前备份"><h3>操作前备份</h3><p>保存于 ${esc(new Date(backup.createdAt).toLocaleString())}，反复开关不会覆盖。</p>
            <div class="weg-preset-actions"><button type="button" class="weg-btn weg-btn-subtle" data-weg-preset-action="restore-backup" ${busy || !ready ? 'disabled' : ''}>恢复操作前状态</button>
            <button type="button" class="weg-btn weg-btn-subtle" data-weg-preset-action="replace-backup" ${busy || !ready ? 'disabled' : ''}>更新备份</button></div></section>` : ''}
        <section class="weg-preset-card" aria-label="作者开场方案"><h3>作者开场方案</h3>
            <p>按开场白中的条目标记切换开关，不切换开场白。</p>
            ${greetings.length ? `<select class="weg-mini-select weg-greeting-preset-select" id="weg-preset-greeting-select" aria-label="套用开场方案" title="点击展开并选择开场方案" ${!ready || busy ? 'disabled' : ''}>
                <option value="">套用开场方案（${greetings.length}）</option>${greetings.map((g) => `<option value="${g.swipeIndex}">${esc(g.title ? `${g.label} · ${g.title}` : g.label)}（开启 ${g.loreUids.length} 条）</option>`).join('')}</select>` : '<p class="weg-preset-empty">作者未提供开场方案</p>'}
        </section>
        <section class="weg-preset-card" aria-label="当前聊天快照"><h3>当前聊天快照</h3>
            <p>${esc(chatHint || '保存当前条目开关方案，仅用于当前聊天。')}</p>
            ${chatAvailable ? `<div class="weg-preset-actions"><button type="button" class="weg-btn weg-btn-subtle" data-weg-save-action="bind-current" ${!ready || busy ? 'disabled' : ''}>${profile ? '更新快照' : '保存快照'}</button>
                ${profile ? '<button type="button" class="weg-btn weg-btn-subtle" data-weg-save-action="unbind-current">清除快照</button>' : ''}</div>
                <p class="weg-preset-empty">情境自动开关组不计入聊天快照。自动恢复：设置 → 聊天联动。</p>` : ''}
        </section>`;
}
