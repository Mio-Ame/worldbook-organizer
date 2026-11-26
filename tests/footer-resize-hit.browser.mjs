import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const suite = process.env.WBO_E2E_SUITE;
if (!suite) throw new Error('Set WBO_E2E_SUITE to the retained browser regression suite');
const load = (name) => import(pathToFileURL(resolve(suite, 'lib', name)).href);
const { createMockStServer } = await load('mock-server.mjs');
const { launchEdgeCdp, VIEWPORTS } = await load('cdp.mjs');
const { resetAndBoot, openManager, waitForCondition } = await load('assert-helpers.mjs');

for (const viewport of [VIEWPORTS.mobile, VIEWPORTS.mobileCompact, VIEWPORTS.desktop]) {
    test(`${viewport.name}: combo footer remains clickable beside the resize corner`, async (t) => {
        const server = createMockStServer();
        let cdp;
        try {
            const baseUrl = await server.start();
            cdp = await launchEdgeCdp();
            await resetAndBoot(cdp, baseUrl, { viewport });
            await openManager(cdp);
            const mainBefore = await cdp.evalFn(() => {
                const modal = document.querySelector('.wbo-manager-modal');
                return { rect: modal.getBoundingClientRect().toJSON(), paddingRight: getComputedStyle(modal).paddingRight,
                    footers: modal.querySelectorAll('.wbo-modal-footer').length };
            });
            assert.equal(mainBefore.footers, 0, 'the manager has no footer to reserve');
            await cdp.clickSelector('#wbo-mgr-combo-btn');
            await waitForCondition(cdp, () => Boolean(document.getElementById('wbo-cmb-close-btn')));
            await cdp.clickSelector('#wbo-cmb-free-new-btn');
            await waitForCondition(cdp, () => !document.getElementById('wbo-cmb-step-edit').hidden);
            await cdp.clickSelector('#wbo-cmb-cancel-edit-btn');
            await waitForCondition(cdp, () => !document.getElementById('wbo-cmb-step-list').hidden);
            const metrics = await cdp.evalFn(() => {
                const button = document.getElementById('wbo-cmb-close-btn');
                const modal = button.closest('.wbo-modal');
                const edge = modal.querySelector('.wbo-resize-se');
                const rect = button.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                const main = document.querySelector('.wbo-manager-modal');
                return { button: rect.toJSON(), corner: edge.getBoundingClientRect().toJSON(),
                    hitClass: hit?.className, hittable: button.contains(hit),
                    footerPaddingRight: parseFloat(getComputedStyle(button.parentElement).paddingRight),
                    main: { rect: main.getBoundingClientRect().toJSON(), paddingRight: getComputedStyle(main).paddingRight,
                        footers: main.querySelectorAll('.wbo-modal-footer').length } };
            });
            t.diagnostic(JSON.stringify(metrics));
            assert.deepEqual(metrics.main, mainBefore, 'footer reservation must not resize or pad the footerless manager');
            assert.equal(metrics.hittable, true, 'the resize corner must not intercept the footer button center');
            if (viewport.mobile) {
                assert.ok(metrics.button.right <= metrics.corner.left, 'the whole footer button must clear the resize area');
            } else {
                assert.ok(metrics.footerPaddingRight < 48, 'desktop footers retain their normal spacing');
            }
            const click = await cdp.clickSelector('#wbo-cmb-close-btn');
            assert.equal(click.hit, true, 'use a physical click with a verified hit target');
            await waitForCondition(cdp, () => !document.getElementById('wbo-submodal-overlay'), 2000);
            assert.deepEqual(cdp.getErrors().runtimeErrors, []);
        } finally {
            await cdp?.close();
            await server.stop();
        }
    });
}
