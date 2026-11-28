import { readFileSync, writeFileSync } from 'node:fs';

const bump = (p, from, to) => writeFileSync(p, readFileSync(p, 'utf8').split(from).join(to), 'utf8');
bump('manifest.json', '2.35.32', '2.35.33');
bump('index.js', "'2.35.32'", "'2.35.33'");
const note = [
    '### Bind popup grouping and titles (2026-11-28 v2.35.33)',
    '- Build optgroups whenever any group or bare book exists (drop the two-group early return).',
    '- Read the real name from state.element.dataset.wboRealName before the meta lookup so primaryTitle applies.',
    '- Tests: unit 245/245; native-picker-window 24/24.',
    '',
    '',
].join('\n');
writeFileSync('NEXT.md', note + readFileSync('NEXT.md', 'utf8'), 'utf8');
console.log('bumped');
