import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE');
const fixtures = await import(pathToFileURL(resolve(suite, 'lib/fixtures.mjs')).href);
export const { makeBook, makeEntry } = fixtures;

// Grouping regressions explicitly opt into the beta; default-off tests use raw fixtures.
export function createDefaultSeed(overrides = {}) {
    return fixtures.createDefaultSeed({ ...overrides,
        pluginSettings: { ...overrides.pluginSettings, entryGroupsEnabled: true },
    });
}
