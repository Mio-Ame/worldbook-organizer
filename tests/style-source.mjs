/**
 * Reads the whole plugin stylesheet, split or not.
 *
 * The rules used to live in a single `style.css`. They now live in `styles/*.css`, sliced
 * contiguously in `src/style-manifest.js` order; joining the slices with '\n' reproduces the
 * pre-split file byte for byte, so the static guards below keep asserting against exactly the
 * same text they always did.
 */
import { readFileSync } from 'node:fs';
import { STYLE_SHEETS } from '../src/style-manifest.js';

export const STYLE_SOURCE_FILES = STYLE_SHEETS.map((rel) => `../${rel}`);

export function readStyleSource() {
    return STYLE_SHEETS.map((rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')).join('\n');
}
