#!/usr/bin/env node
/**
 * Starts a local MongoDB for development.
 *
 * Reuses the `mongod` binary that mongodb-memory-server already downloaded for
 * the test suite, but points it at a PERSISTENT data directory so seeded data
 * survives restarts (the test helper uses a throwaway directory instead).
 *
 * This is a convenience for local development only — production uses MongoDB
 * Atlas via MONGODB_URI.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CACHE = path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server');
const DATA_DIR = path.resolve(__dirname, '../.mongodb-data');
const PORT = process.env.LOCAL_MONGO_PORT || '27017';

function findMongod() {
  if (!fs.existsSync(CACHE)) return null;
  const entries = fs.readdirSync(CACHE).filter((f) => f.startsWith('mongod'));
  if (entries.length === 0) return null;
  return path.join(CACHE, entries[0]);
}

const mongod = findMongod();

if (!mongod) {
  console.error(
    '\nNo local mongod binary found.\n' +
      'Run `npm test` once (it downloads one), or install MongoDB yourself, or\n' +
      'point MONGODB_URI at MongoDB Atlas instead.\n',
  );
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.chmodSync(mongod, 0o755);

console.log(`Starting MongoDB on port ${PORT}`);
console.log(`  binary: ${path.basename(mongod)}`);
console.log(`  data:   ${DATA_DIR}`);
console.log('\nConnection string for backend/.env:');
console.log(`  MONGODB_URI=mongodb://127.0.0.1:${PORT}/delivery-app\n`);
console.log('Press Ctrl+C to stop.\n');

const child = spawn(mongod, ['--dbpath', DATA_DIR, '--port', PORT, '--bind_ip', '127.0.0.1'], {
  stdio: 'inherit',
});

const stop = () => child.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
