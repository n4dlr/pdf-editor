import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const publicOcrDir = join(projectRoot, 'src', 'public', 'ocr');
const publicTessdataDir = join(publicOcrDir, 'tessdata');

const tesseractWorker = require.resolve('tesseract.js/dist/worker.min.js');
const tesseractCoreDir = dirname(require.resolve('tesseract.js-core/package.json'));
const englishModel = require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz');

mkdirSync(publicOcrDir, { recursive: true });
mkdirSync(publicTessdataDir, { recursive: true });
copyFileSync(tesseractWorker, join(publicOcrDir, 'worker.min.js'));
for (const fileName of readdirSync(tesseractCoreDir)) {
  copyFileSync(join(tesseractCoreDir, fileName), join(publicOcrDir, fileName));
}
copyFileSync(englishModel, join(publicTessdataDir, 'eng.traineddata.gz'));

console.log('Prepared local Tesseract.js worker, WASM core, and English language model.');
