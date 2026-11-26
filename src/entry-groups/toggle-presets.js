const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;

function normalizeKey(value) {
    const key = typeof value === 'string' ? value.trim()
        : Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
    return key && !UNSAFE_KEYS.has(key) ? key : '';
}

function normalizeStates(raw) {
    const states = {};
    for (const [key, disabled] of isRecord(raw) ? Object.entries(raw) : []) {
        const uid = normalizeKey(key);
        if (uid && typeof disabled === 'boolean' && !Object.hasOwn(states, uid)) states[uid] = disabled;
    }
    return states;
}

function normalizePreset(raw) {
    const rawId = own(raw, 'id');
    const rawName = own(raw, 'name');
    const id = typeof rawId === 'string' ? normalizeKey(rawId) : '';
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    return id && name ? { id, name, states: normalizeStates(own(raw, 'states')) } : null;
}

// Accept entry summaries only; no worldbook body, author greeting or chat data is read.
function entryStates(entries) {
    const states = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (own(entry, 'isPureBanner') === true) continue;
        const uid = normalizeKey(own(entry, 'uid'));
        const disabled = own(entry, 'disabled');
        if (uid && typeof disabled === 'boolean' && !states.has(uid)) states.set(uid, disabled);
    }
    return states;
}

/** Return detached user presets, keeping the first valid occurrence of each ID. */
export function normalizeTogglePresets(raw) {
    const presets = [];
    const seen = new Set();
    for (const value of Array.isArray(raw) ? raw : []) {
        const preset = normalizePreset(value);
        if (!preset || seen.has(preset.id)) continue;
        seen.add(preset.id);
        presets.push(preset);
    }
    return presets;
}

/** Capture only switch states. Invalid metadata returns null; empty snapshots are valid. */
export function captureTogglePreset(id, name, entries) {
    return normalizePreset({ id, name, states: Object.fromEntries(entryStates(entries)) });
}

/** Explicit user choices override current switches; unrecorded entries remain untouched. */
export function computeTogglePresetPlan(entries, preset) {
    const saved = normalizeStates(own(preset, 'states'));
    const plan = new Map();
    for (const [uid, disabled] of entryStates(entries)) {
        if (Object.hasOwn(saved, uid) && saved[uid] !== disabled) plan.set(uid, saved[uid]);
    }
    return plan;
}

/** Replace in place or append. The caller enforces the fifty-preset creation limit. */
export function upsertTogglePreset(presets, preset) {
    const result = normalizeTogglePresets(presets);
    const candidate = normalizePreset(preset);
    if (!candidate) return result;
    const index = result.findIndex(item => item.id === candidate.id);
    if (index < 0) result.push(candidate);
    else result[index] = candidate;
    return result;
}
