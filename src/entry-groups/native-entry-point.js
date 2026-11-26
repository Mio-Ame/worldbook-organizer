import { getCurrentEditorWorldName, getNativeGroupingPreferences } from './host.js';

const CONTROLS_ID = 'weg-native-entry-controls';
let currentActions = null;

export function revealNativeEntryGroup(worldName, uid) {
    if (getNativeGroupingPreferences().enabled) currentActions?.revealEntryGroup?.(worldName, uid);
}

// Keep the entry point available without importing the native list enhancement.
export function syncNativeEntryPoint(actions) {
    currentActions = actions;
    const { enabled, showButton } = getNativeGroupingPreferences();
    const pagination = document.getElementById('world_info_pagination');
    const list = document.getElementById('world_popup_entries_list');
    const anchor = pagination || list;
    let controls = document.getElementById(CONTROLS_ID);
    if (!anchor || !getCurrentEditorWorldName() || !showButton) {
        controls?.remove();
        return;
    }
    if (!controls?.querySelector('#weg-native-group-manager') || !controls.querySelector('#weg-native-group-enabled > span')) {
        controls?.remove();
        controls = document.createElement('div');
        controls.id = CONTROLS_ID;
        const button = document.createElement('button');
        button.type = 'button';
        button.id = 'weg-native-group-manager';
        button.className = 'menu_button';
        button.title = '条目分组';
        button.setAttribute('aria-label', '打开条目分组面板');
        button.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg><span class="weg-native-entry-label">条目分组</span>';
        button.addEventListener('click', () => void actions.openPanel({ worldName: getCurrentEditorWorldName() }));
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.id = 'weg-native-group-enabled';
        toggle.className = 'menu_button weg-native-entry-switch';
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-label', '在原生编辑器显示条目分组');
        toggle.innerHTML = '<span aria-hidden="true"></span>';
        toggle.addEventListener('click', () => actions.setEnabled(!getNativeGroupingPreferences().enabled));
        controls.append(button, toggle);
        for (const type of ['mousedown', 'touchstart', 'click']) controls.addEventListener(type, (event) => event.stopPropagation());
    }
    const toggle = controls.querySelector('#weg-native-group-enabled');
    const checked = String(enabled);
    if (toggle.getAttribute('aria-checked') !== checked) toggle.setAttribute('aria-checked', checked);
    toggle.title = enabled ? '关闭原生条目分组显示' : '开启原生条目分组显示';
    const size = pagination?.querySelector('select');
    if (size?.offsetHeight) {
        controls.style.setProperty('--weg-native-page-height', `${size.getBoundingClientRect().height}px`);
        controls.style.setProperty('--weg-native-page-font', getComputedStyle(size).fontSize);
    }
    if (pagination) {
        if (pagination.nextElementSibling !== controls) pagination.after(controls);
    } else {
        const pinned = document.getElementById('weg-native-pinned-entries');
        const before = pinned?.nextElementSibling === list ? pinned : list;
        if (before.previousElementSibling !== controls) before.before(controls);
    }
}

export function removeNativeEntryPoint() {
    currentActions = null;
    document.getElementById(CONTROLS_ID)?.remove();
}
