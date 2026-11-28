import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readStyleSource } from './style-source.mjs';

const manager = readFileSync(new URL('../src/panel-manager.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/manager-touch-drag.js', import.meta.url), 'utf8');
const css = readStyleSource();

test('touch users get a visible drag handle and a pointer-driven group drop path', () => {
    const coarsePointerRule = css.match(/@media\s*\(max-width:\s*680px\),\s*\(pointer:\s*coarse\)\s*\{\s*\.wbo-drag-handle,\s*\.wbo-group-drag-handle\s*\{([^}]+)\}/);
    assert.ok(coarsePointerRule, 'coarse-pointer styles should remain explicit');
    assert.match(coarsePointerRule[1], /display:\s*inline-flex\s*!important/,
        'mobile must show the dedicated drag affordance');
    assert.ok(/\.wbo-drag-handle[\s\S]{0,260}touch-action:\s*none/.test(css),
        'touch drag must opt the handle out of browser text selection and scroll gestures');
    assert.match(manager, /pointerType\s*===?\s*['"]touch['"]/,
        'manager must provide an explicit touch-pointer drag route');
    assert.match(manager, /elementFromPoint\(/,
        'touch drop must resolve the destination under the finger, not the captured source');
});
