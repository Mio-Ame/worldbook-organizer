// Contract verified against the bundled dropdown script's Storage / optionKey functions.
const SCRIPT_STORAGE_KEY = '[酒馆]酒馆助手脚本-下拉选项框美化';

/** null means unavailable; an empty list is an authoritative unpin. Never writes host storage. */
export function readScriptPinKeys(storage, selectId) {
    try {
        const data = JSON.parse(storage?.getItem(SCRIPT_STORAGE_KEY) || 'null');
        const keys = data?.pinned?.[selectId];
        return Array.isArray(keys) ? keys.filter((key) => typeof key === 'string') : null;
    } catch { return null; }
}

export function matchesScriptPin(keys, { value, text, realName }) {
    const names = new Set([text, realName].filter(Boolean));
    return keys.some((key) => {
        if (key.startsWith('t\0')) return names.has(key.slice(2));
        if (key.startsWith('v\0')) {
            const separator = key.indexOf('\0', 2);
            return separator >= 0 && key.slice(2, separator) === value && names.has(key.slice(separator + 1));
        }
        return key === value || names.has(key);
    });
}
