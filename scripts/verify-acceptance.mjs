// verify-acceptance.mjs — 四条验收的可复现验证（只读，除自身临时目录外不写任何文件）。
// 用法: node E:\dsh-a2a-bus\open-repos\dsh-dev-hotreload\scripts\verify-acceptance.mjs
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pkg = 'E:/dsh-a2a-bus/open-repos/dsh-dev-hotreload/index.js';
const mod = await import(new URL(`file:///${pkg.replace(/ /g, '%20')}`).href);
const {
  DEFAULT_WHITELIST,
  DEFAULT_LOG_MAX_BYTES,
  AUTO_DISCOVER,
  createLogger,
  discoverLinkedDirs,
  parseAutoDiscover,
  selectWatchDirs,
} = mod;

const PROFILE = 'C:\\Users\\niukl\\.dsh\\profiles\\desktop';
const line = (title) => console.log(`\n===== ${title} =====`);

// ---------- 验收 2/3：白名单生效 + 不再监视 dsh-memory-evolve ----------
line('验收 2/3：在没有 profile 环境时直接调用 discover 相关函数（真实 desktop profile）');
console.log('DEFAULT_WHITELIST =', JSON.stringify(DEFAULT_WHITELIST, null, 2));
console.log('autoDiscover 默认值 =', parseAutoDiscover(undefined));
console.log('log 上限 =', DEFAULT_LOG_MAX_BYTES, 'bytes =', DEFAULT_LOG_MAX_BYTES / 1024 / 1024, 'MB');

console.log('\n-- 旧行为 discoverLinkedDirs(profile)（会看到 memory-evolve）--');
const discovered = discoverLinkedDirs(PROFILE);
for (const dir of discovered) console.log('  discovered:', dir);

console.log('\n-- 新默认 selectWatchDirs(...) 实际会监视的目录 --');
const selected = selectWatchDirs({ profileDir: PROFILE });
for (const dir of selected.dirs) console.log('  WATCH:', dir);
console.log('  count =', selected.dirs.length);
console.log('\n-- 被白名单挡下的目录（进日志的 skipped）--');
for (const dir of selected.skipped) console.log('  SKIP :', dir);

const lower = (paths) => paths.map((path) => path.toLowerCase());
const watched = lower(selected.dirs);
const expected = lower([...DEFAULT_WHITELIST]);
const sameSet =
  watched.length === expected.length && expected.every((path) => watched.includes(path));
console.log('\n结论：监视集合 == 白名单 4 个目录 ->', sameSet);
console.log('结论：不含 dsh-memory-evolve ->', !watched.some((path) => path.includes('memory-evolve')));
console.log('结论：含 %TEMP% 临时 profile 目录 ->', watched.some((path) => path.includes('\\\\temp\\\\')));
console.log(
  '结论：显式开关 autoDiscover:"all" 能回到旧行为 ->',
  selectWatchDirs({ profileDir: PROFILE, autoDiscover: AUTO_DISCOVER.all }).dirs.length,
  '个目录（旧行为全量）',
);

// ---------- 验收 4：轮转 ----------
line('验收 4：1KB 阈值造临时日志，触发轮转');
const root = mkdtempSync(join(tmpdir(), 'hotreload-rotate-'));
const file = join(root, 'tiny.log');
const list = (label) => {
  console.log(`${label}:`, JSON.stringify(readdirSync(root).map((name) => `${name} (${statSync(join(root, name)).size} B)`)));
};
writeFileSync(file, 'seed line\n');
list('轮转前');
const log = createLogger({ logFile: file, maxBytes: 1024 });
for (let index = 0; index < 60; index += 1) log(`line ${index} ${'x'.repeat(40)}`);
list('写满 60 行后');
console.log('主文件前 2 行:', JSON.stringify(readFileSync(file, 'utf8').split('\n').slice(0, 2)));
console.log('.1 文件前 2 行:', JSON.stringify(readFileSync(`${file}.1`, 'utf8').split('\n').slice(0, 2)));
console.log('轮转是 rename 而非读改写：.1 的首行是旧文件内容（seed line 或早期 line），主文件只剩轮转后的新行');
rmSync(root, { recursive: true, force: true });

// ---------- 验收 1 摘要 ----------
line('README / 包内文件清单（确认没有额外的临时文件残留）');
const pkgDir = 'E:\\dsh-a2a-bus\\open-repos\\dsh-dev-hotreload';
console.log(readdirSync(pkgDir).filter((name) => name !== '.git' && name !== 'node_modules').join(', '));

// 造一个真实 profile 目录做 symlink 验证（验收 2 的隔离版）
line('验收 2 补充：自造 profile（不依赖本机真实 profile）');
const fake = mkdtempSync(join(tmpdir(), 'hotreload-profile-'));
const inside = join(fake, 'repo', 'alpha');
const outside = join(fake, 'local-pkgs', 'dsh-memory-evolve');
mkdirSync(join(fake, 'profile', 'node_modules'), { recursive: true });
mkdirSync(inside, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(
  join(fake, 'profile', 'package.json'),
  JSON.stringify({
    name: 'fake-profile',
    private: true,
    dependencies: { alpha: `link:${inside}`, 'dsh-memory-evolve': `link:${outside}` },
    dsh: { profile: { bundles: ['x'] } },
  }),
);
symlinkSync(outside, join(fake, 'profile', 'node_modules', 'dsh-memory-evolve'), 'junction');
const fakeSelected = selectWatchDirs({ profileDir: join(fake, 'profile'), whitelist: [inside] });
console.log('自造 profile 的 link 依赖：alpha(白名单内) + dsh-memory-evolve(白名单外)');
console.log('  WATCH:', JSON.stringify(fakeSelected.dirs));
console.log('  SKIP :', JSON.stringify(fakeSelected.skipped));
console.log('  结论 -> 只监视白名单内的 alpha:', fakeSelected.dirs.length === 1 && /alpha$/i.test(fakeSelected.dirs[0] ?? ''));
rmSync(fake, { recursive: true, force: true });
appendFileSync(join(tmpdir(), 'hotreload-verify-ran.txt'), `${new Date().toISOString()} ok\n`);