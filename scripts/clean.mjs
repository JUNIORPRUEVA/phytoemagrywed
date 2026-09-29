/** Borra el directorio `dist/`. */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
await rm(path.join(root, 'dist'), { recursive: true, force: true });
console.log('🧹 dist/ eliminado');
