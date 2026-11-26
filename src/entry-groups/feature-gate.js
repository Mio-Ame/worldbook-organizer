/** Explicit opt-in for the experimental entry grouping feature. */
export const ENTRY_GROUPING_STATE_CHANGED = 'wbo:entry-grouping-state-changed';

export function isEntryGroupingEnabled(settings) {
    return settings?.entryGroupsEnabled === true;
}

let _gate = null;

function notifyStateChanged(enabled) {
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
        try { window.dispatchEvent(new CustomEvent(ENTRY_GROUPING_STATE_CHANGED, { detail: { enabled } })); }
        catch { /* Notification support must not prevent lifecycle cleanup. */ }
    }
}

/** The lifecycle owns cancellation and cleanup; this gate rejects stale completion notices. */
export function configureEntryGroupingFeatureGate({
    getSettings, start, stop, styleVersion, onRevealNativeEditor,
    onStateChanged = notifyStateChanged,
}) {
    _gate?.dispose();
    let epoch = 0;
    let disposed = false;
    const gate = {
        async sync() {
            if (disposed) return;
            const current = ++epoch;
            if (!isEntryGroupingEnabled(getSettings())) {
                stop();
                onStateChanged(false);
                return;
            }
            try {
                await start(styleVersion, { onRevealNativeEditor });
            } catch (error) {
                if (!disposed && current === epoch) {
                    stop();
                    onStateChanged(false);
                }
                throw error;
            }
            if (!disposed && current === epoch && isEntryGroupingEnabled(getSettings())) {
                onStateChanged(true);
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            epoch++;
            stop();
            if (_gate === gate) _gate = null;
        },
    };
    _gate = gate;
    return gate;
}

export async function syncEntryGroupingFeatureGate() {
    await _gate?.sync();
}
