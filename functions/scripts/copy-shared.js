// Copies the single source of truth for the itinerary (repo root) into functions/shared/
// so it is bundled with the deployed function. functions/shared/ is gitignored.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const functionsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(functionsDir, '..');
const target = join(functionsDir, 'shared');

mkdirSync(target, { recursive: true });
for (const file of ['trip-data.json', 'trip-core.js']) {
  copyFileSync(join(repoRoot, file), join(target, file));
}
console.log('copied trip-data.json + trip-core.js -> functions/shared/');
