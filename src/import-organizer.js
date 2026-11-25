import {
    buildCharacterBindingIndex,
    findUnboundCharacterNameMatches,
    isPotentiallySensitiveTitle,
    normalizeImportOrganize,
    pushUndoSnapshot,
} from './core.js';

const importExpiryMs = 5 * 60_000;

function titleKey(value) {
    return value.normalize('NFKC').toLowerCase();
}

function eligibleNonCharacterTitles({ settings, titles, characters = [], charLore = [], includeGrouped = false }) {
    const candidates = [...new Set(titles)].filter((title) =>
        typeof title === 'string' && title &&
        settings.charBookOverrides?.[title] !== 'include_in_char' &&
        (includeGrouped || !Object.hasOwn(settings.assignments || {}, title)),
    );
    if (candidates.length === 0) return candidates;

    const bindings = buildCharacterBindingIndex({
        characters,
        charLore,
        cachedCharBindings: settings.cachedCharBindings,
        worldNamesSet: new Set(candidates),
        includeExtraCharBooks: true,
        includeEmbeddedNameMatch: true,
    });
    const ambiguous = new Set(findUnboundCharacterNameMatches(candidates, characters, bindings, {
        cachedCharBindings: settings.cachedCharBindings,
    }).map((match) => match.worldName));
    return candidates.filter((title) =>
        !ambiguous.has(title) && !bindings.get(title)?.some((owner) => !owner.orphan),
    );
}

export function findSensitiveImportCandidates({ titles, ...options }) {
    return eligibleNonCharacterTitles({ ...options, titles: titles.filter(isPotentiallySensitiveTitle) });
}

export function planImportedWorldbooks({ settings, titles, ...options }) {
    const config = normalizeImportOrganize(settings.importOrganize, settings.groups);
    const rules = config.rules.map((rule) => ({ groupId: rule.groupId, keyword: titleKey(rule.keyword) }));
    if (!rules.length && !config.sensitiveGroupId) return [];

    const matches = new Map();
    for (const title of titles) {
        if (typeof title !== 'string') continue;
        const key = titleKey(title);
        const custom = rules.find((rule) => key.includes(rule.keyword));
        const groupId = custom?.groupId || (config.sensitiveGroupId && isPotentiallySensitiveTitle(title) ? config.sensitiveGroupId : '');
        if (groupId) matches.set(title, groupId);
    }
    return eligibleNonCharacterTitles({ ...options, settings, titles: [...matches.keys()] })
        .map((title) => ({ title, groupId: matches.get(title) }));
}

export function applyImportedWorldbookPlan(settings, plan) {
    const groups = new Set(settings.groups.map((group) => group.id));
    const rows = plan.filter(({ title, groupId }) =>
        groups.has(groupId) && !Object.hasOwn(settings.assignments, title) && settings.charBookOverrides[title] !== 'include_in_char',
    );
    if (!rows.length) return 0;
    pushUndoSnapshot(settings, { count: rows.length, label: '导入归类' });
    for (const { title, groupId } of rows) {
        Object.defineProperty(settings.assignments, title, { value: groupId, configurable: true, enumerable: true, writable: true });
    }
    return rows.length;
}

export function createWorldbookImportTracker() {
    const pending = new Map();
    return {
        capture(fileNames, knownTitles, now = Date.now()) {
            const known = new Set(knownTitles);
            for (const [title, end] of pending) if (end < now) pending.delete(title);
            for (const name of fileNames) {
                const title = typeof name === 'string' ? name.replace(/\.(?:json|png)$/i, '').trim() : '';
                if (!title || title === name || known.has(title)) continue;
                if (pending.size >= 128) pending.delete(pending.keys().next().value);
                pending.set(title, now + importExpiryMs);
            }
        },
        collect(liveTitles, now = Date.now()) {
            if (!pending.size) return [];
            const live = new Set(liveTitles);
            const imported = [];
            for (const [title, end] of pending) {
                if (end < now) pending.delete(title);
                else if (live.has(title)) {
                    pending.delete(title);
                    imported.push(title);
                }
            }
            return imported;
        },
        clear() { pending.clear(); },
    };
}
