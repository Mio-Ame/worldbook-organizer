import { detectAutoGroups } from './core.js';
import { loadWorldbookSummariesUncached, resolveGreetingCoordinationForBook } from './host.js';

function yieldScanTurn(signal) {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            resolve();
        };
        const timer = setTimeout(finish, 16);
        signal?.addEventListener('abort', finish, { once: true });
    });
}

export async function scanWorldbooksForEntryGroups(worldNames, {
    bookConfigs, strategy, customRules, onlyUngrouped, signal, onProgress,
    startIndex = 0, batchSize = Infinity,
}) {
    const plans = new Map();
    const failed = [];
    const start = Math.max(0, Math.min(worldNames.length, Math.floor(Number(startIndex) || 0)));
    const size = batchSize === Infinity ? worldNames.length : Math.max(1, Math.min(50, Math.floor(Number(batchSize) || 20)));
    const end = Math.min(worldNames.length, start + size);
    let nextIndex = start;
    while (nextIndex < end) {
        if (signal?.aborted) break;
        const world = worldNames[nextIndex];
        try {
            const result = await loadWorldbookSummariesUncached(world, { signal });
            if (signal?.aborted) break;
            if (result.ok) {
                const greeting = strategy === 'smart' || strategy === 'greeting'
                    ? await resolveGreetingCoordinationForBook(world)
                    : null;
                if (signal?.aborted) break;
                const proposals = detectAutoGroups(result.summaries, {
                    strategy, customRules, onlyUngrouped,
                    existingAssignments: bookConfigs[world]?.assignments,
                    greetingIndex: greeting?.greetingIndex,
                });
                if (proposals.length) {
                    const titles = new Map(result.summaries.map(({ uid, title }) => [uid, title]));
                    plans.set(world, proposals.map((proposal) => ({
                        ...proposal, checked: true, mode: proposal.suggestedMode,
                        examples: proposal.uids.slice(0, 3).map((uid) => ({ uid, title: titles.get(uid) || `条目 #${uid}` })),
                    })));
                }
            } else {
                failed.push(world);
            }
        } catch {
            if (signal?.aborted) break;
            failed.push(world);
        }
        nextIndex++;
        onProgress?.(nextIndex);
        // Let input, painting and collection run even when host reads resolve immediately.
        await yieldScanTurn(signal);
    }
    return { plans, failed, nextIndex, processed: nextIndex - start, total: worldNames.length };
}
