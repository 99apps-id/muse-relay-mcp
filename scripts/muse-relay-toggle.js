// Usage: node muse-relay-toggle.js pause|resume|status
const fs = require('fs'), os = require('os'), path = require('path');
const dir = process.env.MUSE_RELAY_DIR || path.join(os.homedir(), 'muse-relay');
const f = path.join(dir, 'control.json');
const act = process.argv[2];
let c = {};
try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') { console.error('control.json tidak bisa dibaca: ' + e.message); process.exit(1); } }
if (act === 'pause' || act === 'resume') {
  c.paused = act === 'pause';
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n');
} else if (act !== 'status') { console.error('aksi tidak dikenal'); process.exit(1); }
console.log('Relay Muse: ' + (c.paused === true ? 'DIJEDA (paused=true)' : 'AKTIF') + '  [' + f + ']');
