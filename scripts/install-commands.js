#!/usr/bin/env node
// Installs /muse-pause, /muse-resume, /muse-status into coding agents.
// Usage: node scripts/install-commands.js <claude|cursor|gemini|windsurf|codex|agy|muse|termixgo|all> [--dry-run]
// Dependency-free. Commands call scripts/muse-relay-toggle.js by absolute path.
const fs = require('fs'), os = require('os'), path = require('path');

const toggle = path.resolve(__dirname, 'muse-relay-toggle.js');
const run = (a) => `node "${toggle}" ${a}`;
const DESC = { pause: 'Pause the Muse relay (paused=true)', resume: 'Resume the Muse relay (paused=false)', status: 'Show Muse relay status' };
const ACTIONS = Object.keys(DESC);
const home = os.homedir();
const FENCE = '```';

// Command-file targets: <dir>/muse-<action><ext>
const targets = {
  claude: { dir: path.join(home, '.claude', 'commands'), ext: '.md',
    body: (a) => `---\ndescription: ${DESC[a]}\nallowed-tools: Bash(node:*)\ndisable-model-invocation: true\n---\n!\`${run(a)}\`\n\nReport the result above in one sentence. Take no other action.\n` },
  cursor: { dir: path.join(home, '.cursor', 'commands'), ext: '.md',
    body: (a) => `${DESC[a]}.\n\nRun exactly this command in the terminal, then report its output in one sentence:\n\n\`${run(a)}\`\n` },
  windsurf: { dir: path.join(home, '.codeium', 'windsurf', 'global_workflows'), ext: '.md',
    body: (a) => `---\ndescription: ${DESC[a]}\n---\n1. Run this command and report its output in one sentence:\n\n${FENCE}\n${run(a)}\n${FENCE}\n` },
  gemini: { dir: path.join(home, '.gemini', 'commands'), ext: '.toml',
    body: (a) => `description = "${DESC[a]}"\nprompt = """\n!{${run(a)}}\n\nReport the result above in one sentence.\n"""\n` },
};

// Skill targets (SKILL.md format): <dir>/muse-<action>/SKILL.md
const skillBody = (a) =>
  `---\nname: muse-${a}\ndescription: ${DESC[a]}. Use ONLY when the user explicitly invokes /muse-${a}, @muse-${a} or $muse-${a}. Never run on your own initiative.\n---\n\n# muse-${a}\n\nRun exactly this command, then report its output in one sentence. Take no other action:\n\n${FENCE}\n${run(a)}\n${FENCE}\n`;
const skillDirs = {
  codex: path.join(home, '.agents', 'skills'),               // Codex CLI + VS Code extension
  agy: [path.join(home, '.gemini', 'config', 'skills'), path.join(home, '.gemini', 'antigravity', 'skills')], // Antigravity CLI / IDE (new + legacy dir)
  muse: path.join(home, '.config', 'muse', 'skills'),        // Muse CLI
  termixgo: path.join(home, '.termixgo', 'skills'),          // Termixgo
};
for (const [name, dirs] of Object.entries(skillDirs)) targets[name] = { dirs: [].concat(dirs), skill: true, body: skillBody };

const args = process.argv.slice(2), dry = args.includes('--dry-run');
const want = args.filter((a) => !a.startsWith('--'));
const list = want.includes('all') ? Object.keys(targets) : want;
if (!list.length || list.some((t) => !targets[t])) {
  console.error('Usage: node scripts/install-commands.js <' + Object.keys(targets).join('|') + '|all> [--dry-run]');
  process.exit(1);
}
for (const t of list) {
  const { dir, dirs, ext, body, skill } = targets[t];
  for (const d of dirs || [dir]) for (const a of ACTIONS) {
    const file = skill ? path.join(d, `muse-${a}`, 'SKILL.md') : path.join(d, `muse-${a}${ext}`);
    if (!dry) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body(a)); }
    console.log(`${dry ? '[dry-run] ' : ''}${t}: ${file}`);
  }
}
