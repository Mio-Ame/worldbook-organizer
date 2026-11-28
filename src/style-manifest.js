/**
 * Authoritative stylesheet injection order.
 *
 * `style.css` is the manifest entry point (`manifest.json#css`) and merely `@import`s these
 * files in this exact order, so an external loader that links `style.css` still gets the whole
 * cascade. `index.js` links the same files directly (one `<link>` per entry, versioned) so the
 * cache-busting query applies per file.
 *
 * The order here IS the cascade order: all of these selectors have equal specificity in the
 * original single file, so swapping two entries would change the result. Do not sort this list.
 */
export const STYLE_SHEETS = [
    'styles/10-base-window.css',
    'styles/20-manager-lists.css',
    'styles/30-dropdown-select2.css',
    'styles/40-organize-ai.css',
    'styles/50-entry-browser.css',
    'styles/60-responsive-media.css',
    'styles/70-accordion-editor.css',
    'styles/80-quick-hub-picker.css',
];
