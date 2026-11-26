import { detectAutoGroups } from './core.js';
import { loadWorldbookSummariesUncached, resolveGreetingCoordinationForBook } from './host.js';

export async function scanWorldbooksForEntryGroups(worldNames, { bookConfigs, strategy, customRules, onlyUngrouped, signal, onProgress }) {
    const plans = new Map();
    const failed = [];
    let scanned = 0;
    for (const world of worldNames) {
        if (signal.aborted) break;
        try {
            const result = await loadWorldbookSummariesUncached(world, { signal });
            if (signal.aborted) break;
            if (result.ok) {
                const greeting = strategy === 'smart' || strategy === 'greeting'
                    ? await resolveGreetingCoordinationForBook(world)
                    : null;
                const proposals = detectAutoGroups(result.summaries, {
                    strategy, customRules, onlyUngrouped,
                    existingAssignments: bookConfigs[world]?.assignments,
                    greetingIndex: greeting?.greetingIndex,
                });
                if (proposals.length) {
                    plans.set(world, proposals.map((proposal) => ({ ...proposal, checked: true, mode: proposal.suggestedMode })));
                }
            } else {
                failed.push(world);
            }
        } catch {
            if (signal.aborted) break;
            failed.push(world);
        }
        onProgress(++scanned);
    }
    return { plans, failed };
}
