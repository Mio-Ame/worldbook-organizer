/**
 * Worldbook Organizer — Pure core logic (DOM-free, unit-testable).
 *
 * Design guarantees:
 * 1. Never mutates real worldbook filenames on disk -> all character, persona,
 *    chat, preset, and script bindings stay 100% intact.
 * 2. Pure in-memory character binding detection + persistent lazy-load cache
 *    -> zero polling and zero full-disk scanning.
 * 3. Deterministic grouping, character-book hiding, virtual aliasing, search,
 *    and AI organize prompt/response parsing with undo support.
 */

// Re-exported from core/settings.js — same names, same order as before the split.
export { DEFAULT_LOCAL_ORGANIZE_CATEGORY_IDS, DEFAULT_SETTINGS, GROUP_COLOR_PALETTE, LOCAL_ORGANIZE_CATEGORIES, MODULE_NAME, SECTION_ORDER_VERSION, SPECIAL_GROUPS, addCustomGroup, charaFileName, compareZhCn, deepClone, getVisibleSectionMoveBounds, moveSectionOrder, normalizeImportOrganize, normalizeSettings, orderSectionsForExternalDropdown, promoteSectionToTop, reorderBookInGroup, reorderSection } from './core/settings.js';

// Re-exported from core/bindings.js — same names, same order as before the split.
export { computeScanPromptState, createGroupId, extractEmbeddedCharacterBookPreview, findCardsWithUnimportedBooks, findUnboundCharacterNameMatches, findUnscannedShallowCharacters, normalizeMatchName, summarizeCharacterWorldCoverage, summarizePersonaWorldBindings, updateCachedCharBindings } from './core/bindings.js';

// Re-exported from core/classify.js — same names, same order as before the split.
export { buildCharBooksCountMap, buildCharacterBindingIndex, buildPersonaBindingIndex, classifyWorldbooks, cleanupDeletedWorldSettings, createApiChannelId, detectAiRefusal, formatCharacterDisplayTitle, isBookVisibleInCharBindPopup, isBookVisibleInSelector, isPotentiallySensitiveTitle, matchesSearch, pruneStaleWorldbookSettings } from './core/classify.js';

// Re-exported from core/organize.js — same names, same order as before the split.
export { AI_ORGANIZE_CATEGORY_PRESETS, AI_ORGANIZE_NAMING_PRESETS, analyzeSensitiveOrganizeState, applyAiOrganizeProposals, buildAiOrganizePrompt, buildLocalOrganizeProposals, deleteAiOrganizePreset, getEffectiveAiOrganizePresets, migrateSettingsOnWorldRename, moveBooksToNamedGroup, parseAiOrganizeResponse, pushUndoSnapshot, resetAiOrganizePresets, restoreOrganizeSnapshot, undoLastAiOrganize, upsertAiOrganizePreset } from './core/organize.js';

// Re-exported from core/entries.js — same names, same order as before the split.
export { WORLD_ENTRY_POSITIONS, compareWorldbookEntries, computeReorderedEntries, createGlobalPresetId, createNewRawWorldEntry, deleteGlobalPreset, estimateEntryTokens, exportConfigData, extractEntryListItems, extractSingleEntryForEdit, findMatchingGlobalPreset, findSensitiveTargetGroup, importConfigData, isBookPinned, mergeEntryPatchOntoRaw, moveGlobalPreset, normalizeEntryKeywordsInput, parseOptionalFiniteNumber, partitionGroupPickerBooks, reorderEntryUids, resolveEntryDisplayIndex, searchEntriesInPayload, sortEntryListItems, togglePinnedBook, upsertGlobalPreset } from './core/entries.js';
