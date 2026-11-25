import { getHostContext } from '../host.js';
import { MODULE_NAME } from './core.js';

const folder = MODULE_NAME.replaceAll('_', '-');

function matchesLegacyId(id) {
    return String(id ?? '').split('/').at(-1) === folder;
}

function legacyGroupingDisabled(ctx) {
    const disabled = ctx?.extensionSettings?.disabledExtensions;
    return Array.isArray(disabled) && disabled.some(matchesLegacyId);
}

export function isLegacyGroupingMounted(ctx = getHostContext()) {
    if (legacyGroupingDisabled(ctx)) return false;
    if (typeof document === 'undefined') return false;
    return Boolean(
        document.querySelector?.(`link[data-weg-style-ver], link[href*="/${folder}/"], script[src*="/${folder}/"]`) ||
        document.getElementById?.('weg-wand-entry') ||
        document.getElementById?.('weg-native-entry-btn') ||
        document.getElementById?.('weg-extension-settings'),
    );
}

export async function hasEnabledLegacyGrouping(ctx) {
    if (legacyGroupingDisabled(ctx)) return false;
    if (isLegacyGroupingMounted(ctx)) return true;
    try {
        const url = new URL('/scripts/extensions.js', globalThis.location.href).href;
        const { extensionNames } = await import(/* @vite-ignore */ url);
        return Array.isArray(extensionNames) && extensionNames.some(matchesLegacyId);
    } catch {
        return false;
    }
}
