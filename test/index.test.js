import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AUTO_DISCOVER,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_WHITELIST,
  apply,
  createLogger,
  discoverLinkedDirs,
  looksLikeProfile,
  normalizePath,
  parseAutoDiscover,
  resolveProfileDir,
  rotateLog,
  selectWatchDirs,
  shouldRotate,
  stripLongPathPrefix,
} from '../index.js';

function profile(dir, dependencies = {}) {
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-test', private: true, dependencies, dsh: { profile: { bundles: ['x'] } } }),
  );
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dev-hotreload-'));
}

const lower = (paths) => paths.map((path) => path.toLowerCase());

test('looksLikeProfile 认出带 bundles 的 profile', () => {
  const root = tempRoot();
  try {
    const dir = join(root, 'profile');
    profile(dir);
    assert.equal(looksLikeProfile(dir), true);
    assert.equal(looksLikeProfile(join(root, 'missing')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverLinkedDirs 收集 link:/file: 依赖与 node_modules 里的 symlink', () => {
  const root = tempRoot();
  try {
    const dir = join(root, 'profile');
    const linked = join(root, 'packages', 'alpha');
    const scoped = join(root, 'packages', 'beta');
    mkdirSync(linked, { recursive: true });
    mkdirSync(scoped, { recursive: true });
    profile(dir, {
      alpha: 'link:../packages/alpha',
      beta: `file:${scoped.replace(/\\/g, '/')}`,
      plain: '1.0.0',
    });
    symlinkSync(linked, join(dir, 'node_modules', 'alpha'), 'junction');
    mkdirSync(join(dir, 'node_modules', '@scope'), { recursive: true });
    symlinkSync(scoped, join(dir, 'node_modules', '@scope', 'beta'), 'junction');

    const found = lower(discoverLinkedDirs(dir));
    assert.ok(found.includes(linked.toLowerCase()), 'link: 依赖应被发现');
    assert.ok(found.includes(scoped.toLowerCase()), 'file: 依赖与 symlink 应被发现');
    assert.equal(new Set(found).size, found.length, '结果不应重复');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveProfileDir 优先用 profileContext.dir', () => {
  const root = tempRoot();
  try {
    const dir = join(root, 'profile');
    profile(dir);
    const ctx = { get: (name) => (name === 'profileContext' ? { dir } : undefined) };
    assert.equal(resolveProfileDir(ctx).toLowerCase(), dir.toLowerCase());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveProfileDir 在真实 profile 上返回当前安装目录', () => {
  const ctx = { get: () => undefined };
  const found = resolveProfileDir(ctx);
  if (found === undefined) return; // 非 profile 组合环境（例如独立 CLI 测试）跳过
  assert.equal(looksLikeProfile(found), true);
  assert.match(found.toLowerCase(), /profiles[\\/]desktop$/);
});

// ---- 白名单 ----

test('normalizePath 去掉零宽字符、统一斜杠并小写', () => {
  assert.equal(normalizePath('E:\\dsh-a2a-bus\\dsh-a2a\\'), 'e:\\dsh-a2a-bus\\dsh-a2a');
  assert.equal(normalizePath('E:/DSH-A2A-BUS/dsh-a2a'), 'e:\\dsh-a2a-bus\\dsh-a2a');
  // U+200B 零宽空格 + BOM 都要被清掉，否则白名单比较会失败
  assert.equal(normalizePath('E:\\\u200Bdsh-a2a-bus\uFEFF\\dsh-a2a'), 'e:\\dsh-a2a-bus\\dsh-a2a');
});

test('parseAutoDiscover 兼容布尔与字符串写法', () => {
  assert.equal(parseAutoDiscover(undefined), AUTO_DISCOVER.whitelist);
  assert.equal(parseAutoDiscover(true), AUTO_DISCOVER.whitelist);
  assert.equal(parseAutoDiscover(false), AUTO_DISCOVER.off);
  assert.equal(parseAutoDiscover('all'), AUTO_DISCOVER.all);
  assert.equal(parseAutoDiscover('LEGACY'), AUTO_DISCOVER.all);
  assert.equal(parseAutoDiscover('off'), AUTO_DISCOVER.off);
});

test('selectWatchDirs 默认模式下白名单就是上界：白名单外的 link: 包被挡下', () => {
  const root = tempRoot();
  try {
    const dir = join(root, 'profile');
    const inside = join(root, 'repo', 'alpha');
    const outside = join(root, 'local-pkgs', 'dsh-memory-evolve');
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    profile(dir, { alpha: `link:${inside}`, 'dsh-memory-evolve': `link:${outside}` });
    symlinkSync(outside, join(dir, 'node_modules', 'dsh-memory-evolve'), 'junction');

    const { dirs, skipped } = selectWatchDirs({
      profileDir: dir,
      whitelist: [inside, join(root, 'repo', 'not-linked')],
      autoDiscover: AUTO_DISCOVER.whitelist,
    });

    assert.deepEqual(lower(dirs), [inside.toLowerCase()], '只应监视白名单内的那个被 link 的包');
    assert.ok(
      lower(skipped).includes(outside.toLowerCase()),
      '白名单外的 link: 包应出现在 skipped（日志里可见，不静默）',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selectWatchDirs 显式 dirs 也受白名单约束（白名单外丢弃并记入 skipped）', () => {
  const root = tempRoot();
  try {
    const inside = join(root, 'repo', 'alpha');
    const outside = join(root, 'elsewhere', 'beta');
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });

    const { dirs, skipped } = selectWatchDirs({
      explicit: [inside, outside],
      whitelist: [inside],
      autoDiscover: AUTO_DISCOVER.off,
    });
    assert.deepEqual(lower(dirs), [inside.toLowerCase()]);
    assert.deepEqual(lower(skipped), [outside.toLowerCase()]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("autoDiscover:'all' 是回到旧行为的显式开关，绕过白名单", () => {
  const root = tempRoot();
  try {
    const dir = join(root, 'profile');
    const outside = join(root, 'local-pkgs', 'dsh-memory-evolve');
    mkdirSync(outside, { recursive: true });
    profile(dir, { 'dsh-memory-evolve': `link:${outside}` });

    const { dirs } = selectWatchDirs({ profileDir: dir, whitelist: [], autoDiscover: AUTO_DISCOVER.all });
    assert.ok(lower(dirs).includes(outside.toLowerCase()), 'all 模式应重新发现白名单外的包');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEFAULT_WHITELIST 正好是我们自己的 4 个开发目录', () => {
  assert.deepEqual(DEFAULT_WHITELIST.map(normalizePath), [
    'e:\\dsh-a2a-bus\\dsh-a2a',
    'e:\\dsh-a2a-bus\\dsh-collab-secretary',
    'e:\\dsh-a2a-bus\\.worktrees\\switchboard\\dsh-tool-switchboard',
    'e:\\dsh-a2a-bus\\open-repos\\dsh-dev-hotreload',
  ]);
});

// 白名单里的目录一旦消失，watcher 句柄会变僵尸且**重建救不回来**（2026-11-13 两度踩中，
// 只能重启宿主）。所以分支专属的包必须放在常驻 worktree（.worktrees/<x>）里，
// 不能放在主工作树 —— 主树的 checkout 会让这类目录随分支切换而消失。
test('白名单不指向会随分支切换消失的路径', () => {
  const mainTree = 'e:\\dsh-a2a-bus';
  for (const dir of DEFAULT_WHITELIST.map(normalizePath)) {
    assert.ok(dir.startsWith(`${mainTree}\\`), `白名单项必须在主仓库下：${dir}`);
    const relative = dir.slice(mainTree.length + 1);
    const top = relative.split('\\')[0];
    // 主树顶层目录只允许两类：长期存在的包目录、或 open-repos/.worktrees 这类容器。
    // 禁止的是「只在一个分支里存在的包目录」——那种会在 checkout 时整个消失。
    assert.ok(
      !top.startsWith('dsh-tool-switchboard'),
      `分支专属包不得放在主树顶层（切分支会消失）：${dir}`,
    );
  }
});

// ---- 日志轮转 ----

test('shouldRotate 只在超限时返回 true，且文件不存在时不报错', () => {
  const root = tempRoot();
  try {
    const file = join(root, 'a.log');
    assert.equal(shouldRotate(file, 10), false, '文件不存在');
    writeFileSync(file, 'x'.repeat(20));
    assert.equal(shouldRotate(file, 10), true);
    assert.equal(shouldRotate(file, 100), false);
    assert.equal(shouldRotate(file, 0), false, '阈值为 0 表示不轮转');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rotateLog 用 rename 轮转，只保留一份 .1，不读取文件内容', () => {
  const root = tempRoot();
  try {
    const file = join(root, 'b.log');
    writeFileSync(file, 'first\n');
    assert.equal(rotateLog(file), true);
    assert.equal(existsSync(file), false, '轮转后主文件应不存在（下次 append 重建）');
    assert.equal(readFileSync(`${file}.1`, 'utf8'), 'first\n');

    writeFileSync(file, 'second\n');
    assert.equal(rotateLog(file), true);
    assert.equal(readFileSync(`${file}.1`, 'utf8'), 'second\n', '.1 被覆盖，只保留最近一份');
    assert.equal(
      readdirSync(root).filter((name) => name.startsWith('b.log')).length,
      1,
      '只应存在一份轮转文件',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createLogger 在超过上限时自动轮转，主文件随之从零重建', () => {
  const root = tempRoot();
  try {
    const file = join(root, 'c.log');
    let clock = 0;
    const log = createLogger({
      logFile: file,
      maxBytes: 1024,
      now: () => new Date(2026, 0, 1, 0, 0, clock++),
    });
    for (let index = 0; index < 40; index += 1) log('x'.repeat(64));
    assert.ok(existsSync(`${file}.1`), '应产生轮转文件');
    assert.ok(statSync(`${file}.1`).size <= 2048, `.1 不应无限增长（实测 ${statSync(`${file}.1`).size}）`);
    const names = readdirSync(root).sort();
    assert.deepEqual(names, ['c.log', 'c.log.1']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createLogger 在 log:false 时什么都不写', () => {
  const root = tempRoot();
  try {
    const file = join(root, 'd.log');
    const log = createLogger({ logFile: undefined });
    log('should go nowhere');
    assert.equal(existsSync(file), false);
    assert.equal(log('x'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEFAULT_LOG_MAX_BYTES 是 50 MB', () => {
  assert.equal(DEFAULT_LOG_MAX_BYTES, 50 * 1024 * 1024);
});

test('appendFileSync 轮转后 append 会重建主文件（行为锁定）', () => {
  const root = tempRoot();
  try {
    const file = join(root, 'e.log');
    writeFileSync(file, 'a'.repeat(64));
    rotateLog(file);
    appendFileSync(file, 'new\n');
    assert.equal(readFileSync(file, 'utf8'), 'new\n');
    assert.equal(readFileSync(`${file}.1`, 'utf8'), 'a'.repeat(64));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
// ── 事故回归：2026-11-13 两度踩坑的「监视目录被删」──────────────────────
// 旧实现：目录被删 → watcher 句柄成僵尸 → 每 ~300μs 刷 change →
//         每次 clearTimeout 重排 debounce → tick 永远排不上 → 热重载全失效，
//         日志一天涨到 12.65 GB，且重建目录救不回来（只能重启宿主）。
// 新实现在四层防线下必须：①不刷屏 ②tick 不被饿死 ③目录回来能自愈。
test('监视目录被删除：不刷屏、不饿死 tick、目录回来能自愈', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hr-zombie-'));
  const watched = join(root, 'watched');
  const profileDir = join(root, 'profile');
  const patch = join(profileDir, 'cordis.patch.yml');
  const logFile = join(root, 'hr.log');
  mkdirSync(watched, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(watched, 'src.js'), 'export const a = 1;\n');
  writeFileSync(patch, 'sections: []\n');

  const disposers = [];
  const ctx = {
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return d;
    },
    get() {},
    baseUrl: undefined,
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const logText = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');
  const countTicks = () => (logText().match(/ticked cordis\.patch\.yml/g) ?? []).length;
  const countChange = () => (logText().match(/change:|coalesced /g) ?? []).length;

  try {
    apply(ctx, {
      profile: profileDir, patch, log: logFile, logMaxBytes: 1e7,
      dirs: [watched], autoDiscover: 'off', whitelist: [watched], debounce: 50,
    });

    // 正常写入要能 tick（自检：确保后面失败不是"压根没工作"）
    writeFileSync(join(watched, 'src.js'), 'export const a = 2;\n');
    await sleep(400);
    assert.ok(countTicks() >= 1, '前提：正常改动应产生 tick');

    // 删掉被监视的目录 —— 旧实现在这里开始刷屏
    const changeBefore = countChange();
    rmSync(watched, { recursive: true, force: true });
    await sleep(1200);
    const fanout = countChange() - changeBefore;
    assert.ok(fanout < 100, `删除后不得刷屏，实际 change 行 ${fanout} 条`);

    // 目录回来 —— 必须自愈重绑
    mkdirSync(watched, { recursive: true });
    writeFileSync(join(watched, 'src.js'), 'export const a = 3;\n');
    await sleep(2000);
    const watchingLines = (logText().match(/watching .*watched/g) ?? []).length;
    assert.ok(watchingLines >= 2, `重建后应自动重绑 watcher，实际 watching 行 ${watchingLines}`);

    // 自愈后热重载仍要能工作
    const ticksBefore = countTicks();
    writeFileSync(join(watched, 'another.js'), 'export const b = 1;\n');
    await sleep(500);
    assert.ok(countTicks() > ticksBefore, '自愈后新改动仍应触发 tick');
  } finally {
    disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
    rmSync(root, { recursive: true, force: true });
  }
});

test('stripLongPathPrefix 去掉 Windows 长路径前缀', () => {
  assert.equal(stripLongPathPrefix('\\\\?\\E:\\a\\b'), 'E:\\a\\b');
  assert.equal(stripLongPathPrefix('\\\\?\\UNC\\srv\\share\\x'), '\\\\srv\\share\\x');
  assert.equal(stripLongPathPrefix('E:\\a\\b'), 'E:\\a\\b');
  assert.equal(stripLongPathPrefix('E:\\a\u200B\\b'), 'E:\\a\\b');
});
