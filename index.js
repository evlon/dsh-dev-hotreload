// dsh-dev-hotreload — 本地源码「保存即热重载」桥。
//
// 为什么需要它（dsh-hmr 0.2.1-rc.3 实测结论）：
// - `link:` / `file:` 安装的本地包，模块在 ESM 缓存里是
//   `<profile>/node_modules/<pkg>` 的 symlink URL，而模块监听的 dispatch 用
//   realpath 得到的真实路径做键匹配，`esmHas(url)` 恒为 false —— 所以
//   `hmr.config.root` 的“模块监听”对本地链接包永远不生效。
// - 官方真正有效的路径是「profile 重新组合（reconciliation）」：profile 的
//   cordis.patch.yml / package.json 发生变化时，dsh-hmr 会比对已加载模块的
//   文件身份（mtime + size），把发生变化的插件停掉、清缓存、重新 import。
//   README 明确说明 linked 包在下次重组合时生效。
//
// 本插件的做法：递归监视本地源码目录，保存后防抖一段时间，然后轻触 profile
// 的 cordis.patch.yml 里那行 tick 注释，用官方配置监视触发同一套重组合：
//   保存源码 → tick → 重组合 → 插件热替换（工具 schema 同步更新）
//   → client-hmr 把前端 bundle 更新推给页面。
//
// v1.1.0 起**默认只监视白名单目录**（DEFAULT_WHITELIST），不再「发现全部
// link: 包就全量递归监视」：那样会把每轮对话都在写盘的 dsh-memory-evolve
// 也算进去，日志一天涨到 GB 级（实测 12.65 GB / 1.95 亿行）。autoDiscover
// 的语义因此改为「在白名单范围内再挑出真的被 link 的包」，只有显式写
// `autoDiscover: 'all'` / `autoDiscover: 'legacy'` 才回到旧的「发现什么盯
// 什么」行为。日志也有 50 MB 上限 + 单份轮转。
//
// 零配置即可用；配置项见 README.md。
import { appendFileSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-dev-hotreload';
export const inject = [];

// 目录排除 + 编辑器/写盘工具的临时文件排除（它们会在一次保存里产生大量重复事件）。
const IGNORED =
  /(^|[\\/])(node_modules|\.git|\.hg|\.svn|dist|build|out|coverage|cache|\.cache|\.turbo)([\\/]|$)|\.tmpdir([\\/]|$)|~RF[0-9a-f]+\.TMP$|\.tmp$/i;
const TICK = /^# hot-reload-tick:/;
const LINK_SPEC = /^(link|file):/i;

// 零配置时的默认白名单：本机自己的开发目录。
// 这就是「不再监视所有 link: 包」的收敛点。**别人的机器上这些路径不存在，
// 会被 selectWatchDirs 静默跳过**（不存在的目录不报错），不会造成故障；
// 想改成自己的目录，在 profile 的 cordis.patch.yml 里给 dev-hotreload 写
// config.whitelist 或 config.dirs 覆盖即可。
//
// ⚠️ 白名单里的目录**绝不能被删除后重建**（2026-11-13 两度踩中）：
//    watcher 的句柄绑在目录对象上，目录一消失句柄就成僵尸，
//    之后即使把目录重建回来也救不回——v1.2.0 起加了自愈（检测到连续大量
//    「路径不存在」就关掉旧 watcher 重开），但**老版本只能重启宿主**。
//    僵尸句柄的表现：每 ~300μs 刷一次 `change: \\?\<abs-path>`，
//    把 debounce 无限重置、tick 再也排不上，热重载整体失效。
//    要换位置就改配置，不要动目录本身。
//
// 路径要指向**稳定位置**：分支专属的包（如 dsh-tool-switchboard）放在常驻
// worktree 里（.worktrees/<name>），而不是主工作树 —— 主树的 checkout 行为
// 会让这类目录随分支切换而消失，正好触发上面那个坑。
export const DEFAULT_WHITELIST = Object.freeze([
  'E:\\dsh-a2a-bus\\dsh-a2a',
  'E:\\dsh-a2a-bus\\dsh-collab-secretary',
  'E:\\dsh-a2a-bus\\.worktrees\\switchboard\\dsh-tool-switchboard',
  'E:\\dsh-a2a-bus\\open-repos\\dsh-dev-hotreload',
]);

// 日志轮转：默认上限 50 MB，只保留一份 .1。
export const DEFAULT_LOG_MAX_BYTES = 50 * 1024 * 1024;

/** autoDiscover 的三种取值：白名单内挑 link 包（默认）/ 关闭 / 旧的「发现什么盯什么」。 */
export const AUTO_DISCOVER = Object.freeze({ whitelist: 'whitelist', off: 'off', all: 'all' });

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * 去掉不可见字符（%TEMP% 下见过 U+200B 零宽空格、BOM、双向控制符等），
 * 统一斜杠、去掉尾随分隔符，并小写化 —— Windows 路径大小写不敏感，
 * 所有比较都用这里的输出。
 */
export function normalizePath(path) {
  if (typeof path !== 'string') return '';
  return path
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

/** watch() 回来的路径常带 Windows 长路径前缀 `\\?\`，statSync 前要去掉。 */
export function stripLongPathPrefix(path) {
  if (typeof path !== 'string') return '';
  // 去掉不可见字符，否则 statSync 会 ENOENT 而报错路径看起来完全正常
  const clean = path.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD]/g, '');
  if (clean.startsWith('\\\\?\\UNC\\')) return `\\\\${clean.slice(8)}`;
  if (clean.startsWith('\\\\?\\')) return clean.slice(4);
  return clean;
}

/** 一个目录像不像 DSH profile：有 package.json，且声明了 dsh.profile.bundles 或带 node_modules。 */
export function looksLikeProfile(dir) {
  if (!isDirectory(dir)) return false;
  const manifest = readJson(join(dir, 'package.json'));
  if (!manifest) return false;
  const bundles = manifest.dsh?.profile?.bundles;
  return (Array.isArray(bundles) && bundles.length > 0) || isDirectory(join(dir, 'node_modules'));
}

/**
 * 定位当前 profile 目录。优先问宿主拿 profileContext.dir（最权威），
 * 再退回组合根（ctx.baseUrl）、宿主进程参数里的 profile 路径
 * （桌面端 host 命令行形如 `... <dsh.js> <profileDir> ...`），
 * 最后用 $DSH_HOME/profiles/desktop。
 */
export function resolveProfileDir(ctx) {
  const candidates = [];
  try {
    const dir = ctx?.get?.('profileContext')?.dir;
    if (typeof dir === 'string' && dir) candidates.push(dir);
  } catch {
    /* service unavailable: fall through to heuristics */
  }
  const baseUrl = ctx?.baseUrl;
  if (typeof baseUrl === 'string' && baseUrl) {
    try {
      candidates.push(fileURLToPath(new URL('./', baseUrl)));
    } catch {
      /* ignore malformed baseUrl */
    }
  }
  for (const arg of process.argv) {
    if (typeof arg === 'string' && isAbsolute(arg) && isDirectory(arg)) candidates.push(arg);
  }
  const home = process.env.DSH_HOME;
  if (home) candidates.push(join(home, 'profiles', 'desktop'));
  for (const candidate of candidates) {
    const dir = resolve(candidate);
    if (looksLikeProfile(dir)) return dir;
  }
  return undefined;
}

/**
 * 自动发现本地源码目录：profile 的 package.json 里 `link:` / `file:` 依赖指向的
 * 真实目录，加上 node_modules 顶层所有 symlink 的真实目录（pnpm link 的落点）。
 *
 * 这是**旧的、不受限的**发现逻辑。apply() 默认不会直接用它，只在
 * autoDiscover:'all'（回到 v1.0 行为）或白名单为空时才全量使用；默认路径是
 * 用它去*过滤*白名单（见 selectWatchDirs）。
 */
export function discoverLinkedDirs(profileDir) {
  const found = new Map();
  const add = (path) => {
    if (!path || !isDirectory(path)) return;
    const real = canonical(path);
    found.set(normalizePath(real), real);
  };

  const manifest = readJson(join(profileDir, 'package.json'));
  for (const spec of Object.values(manifest?.dependencies ?? {})) {
    if (typeof spec !== 'string') continue;
    const match = LINK_SPEC.exec(spec);
    if (!match) continue;
    let target = spec.slice(match[0].length).trim();
    if (/^file:/i.test(spec)) {
      try {
        target = fileURLToPath(spec);
      } catch {
        /* keep raw */
      }
    }
    target = target.replace(/^\/+([A-Za-z]:)/, '$1');
    add(isAbsolute(target) ? target : resolve(profileDir, target));
  }

  const modules = join(profileDir, 'node_modules');
  let entries = [];
  try {
    entries = readdirSync(modules, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(modules, entry.name);
    if (entry.isSymbolicLink()) {
      add(path);
      continue;
    }
    // scoped: @scope/pkg 也可能是 symlink
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      try {
        for (const inner of readdirSync(path, { withFileTypes: true })) {
          const scoped = join(path, inner.name);
          if (inner.isSymbolicLink()) add(scoped);
        }
      } catch {
        /* ignore unreadable scope dir */
      }
    }
  }
  return [...found.values()];
}

/** 把 autoDiscover 配置值收敛成三态，容忍 YAML 里的字符串/布尔/数字写法。 */
export function parseAutoDiscover(value) {
  if (value === undefined || value === null) return AUTO_DISCOVER.whitelist;
  if (value === false) return AUTO_DISCOVER.off;
  if (value === true) return AUTO_DISCOVER.whitelist;
  const text = String(value).trim().toLowerCase();
  if (text === 'off' || text === 'false' || text === 'none' || text === '0') return AUTO_DISCOVER.off;
  if (text === 'all' || text === 'legacy' || text === 'unrestricted') return AUTO_DISCOVER.all;
  return AUTO_DISCOVER.whitelist;
}

/**
 * 算出真正要监视的目录。纯函数（只读文件系统，不 watch）：
 *
 * - autoDiscover:'all'  → 旧行为：discoverLinkedDirs 全量 + dirs（不受白名单限制）
 * - autoDiscover:'off'  → 只监视 dirs
 * - autoDiscover:'whitelist'（默认）→ **白名单就是上界**：dirs 和自动发现结果
 *   都必须在白名单内才会被监视；autoDiscover 只负责在白名单里挑出真的被
 *   link 进去的包，不会自行扩大范围。
 *
 * 返回 { dirs, skipped }：skipped 是被白名单挡下来的自动发现目录（用于日志）。
 */
export function selectWatchDirs({ profileDir, explicit = [], whitelist = DEFAULT_WHITELIST, autoDiscover = AUTO_DISCOVER.whitelist } = {}) {
  const allowed = new Set(
    (Array.isArray(whitelist) ? whitelist : [])
      .filter((dir) => typeof dir === 'string' && dir.trim())
      .map((dir) => normalizePath(dir)),
  );
  const dirs = new Map(); // normalized -> 真实路径
  const skipped = [];
  const addDir = (path) => {
    if (!path || !isDirectory(path)) return false;
    const real = canonical(path);
    dirs.set(normalizePath(real), real);
    return true;
  };

  if (autoDiscover === AUTO_DISCOVER.all) {
    if (profileDir) for (const dir of discoverLinkedDirs(profileDir)) addDir(dir);
    for (const dir of explicit) addDir(dir);
    return { dirs: [...dirs.values()], skipped };
  }

  // 显式目录：白名单是上界，白名单外的显式目录被丢弃（不是静默 —— 会进日志）。
  const candidates = [...explicit];
  if (autoDiscover === AUTO_DISCOVER.whitelist && profileDir) candidates.push(...discoverLinkedDirs(profileDir));
  for (const dir of candidates) {
    let real;
    try {
      real = canonical(isAbsolute(dir) ? dir : resolve(dir));
    } catch {
      /* ignore malformed path */
    }
    const key = normalizePath(real ?? dir);
    if (key && allowed.size > 0 && !allowed.has(key)) {
      skipped.push(real ?? dir);
      continue;
    }
    addDir(real ?? dir);
  }
  return { dirs: [...dirs.values()], skipped };
}

/**
 * 需要在写日志之前判断轮转吗？
 * 只 stat，不读内容 —— 12 GB 的文件绝不能整个读进内存再重写。
 */
export function shouldRotate(logFile, maxBytes = DEFAULT_LOG_MAX_BYTES) {
  if (!logFile || !(maxBytes > 0)) return false;
  try {
    return statSync(logFile).size >= maxBytes;
  } catch {
    return false; // 文件还不存在
  }
}

/**
 * 轮转日志：rename 成 `.1`（覆盖旧的那份），下次 append 会重建主文件。
 * 只用 rename/unlink，绝不读写文件内容。
 */
export function rotateLog(logFile) {
  if (!logFile) return false;
  const rotated = `${logFile}.1`;
  try {
    unlinkSync(rotated);
  } catch {
    /* 没有旧的那份 */
  }
  try {
    renameSync(logFile, rotated);
    return true;
  } catch {
    return false;
  }
}

/**
 * 造一个带轮转的 logger。
 *
 * 每次写之前都 stat 一次（statSync 是微秒级的 syscall，相对 append 本身可以忽略），
 * 不做时间节流：节流的代价是「风暴里 stat 恰好落在节流窗口内」→ 日志越过上限继续涨，
 * 而我们要的正是「无论写得多快都封顶」。
 */
export function createLogger({ logFile, maxBytes = DEFAULT_LOG_MAX_BYTES, now = () => new Date() } = {}) {
  return (message) => {
    try {
      if (!logFile) return;
      if (shouldRotate(logFile, maxBytes)) rotateLog(logFile);
      appendFileSync(logFile, `${now().toISOString()} ${message}\n`);
    } catch {
      /* logging must never break the host */
    }
  };
}

export function apply(ctx, config) {
  const options = config ?? {};
  const debounce = Number.isFinite(options.debounce) ? options.debounce : 400;
  const autoDiscover = parseAutoDiscover(options.autoDiscover);
  const profileDir = options.profile ?? resolveProfileDir(ctx);
  const patch = options.patch ?? (profileDir ? join(profileDir, 'cordis.patch.yml') : undefined);
  const logFile = options.log === false ? undefined : (options.log ?? join(tmpdir(), 'dsh-dev-hotreload.log'));
  const logMaxBytes = Number.isFinite(options.logMaxBytes) && options.logMaxBytes > 0 ? options.logMaxBytes : DEFAULT_LOG_MAX_BYTES;

  const log = createLogger({ logFile, maxBytes: logMaxBytes });
  // 诊断开关（临时）：只把关键事件打到宿主 stdout，不写日志文件。
  const diag = options.diag === true;

  if (!patch) {
    if (diag) console.log('[dev-hotreload] disabled: no patch');
    else log('disabled: profile directory not found, no cordis.patch.yml to tick');
    return;
  }

  const explicit = Array.isArray(options.dirs)
    ? options.dirs.filter((dir) => typeof dir === 'string' && dir && !/^#/.test(dir.trim()))
    : [];
  const whitelist = Array.isArray(options.whitelist) ? options.whitelist : DEFAULT_WHITELIST;
  const { dirs, skipped } = selectWatchDirs({ profileDir, explicit, whitelist, autoDiscover });

  if (dirs.length === 0) {
    if (diag) console.log('[dev-hotreload] disabled: no dirs');
    else log(`disabled: no source directory to watch (profile=${profileDir ?? 'unknown'}, patch=${patch})`);
    return;
  }

  if (diag) {
    console.log(`[dev-hotreload] apply dirs=${JSON.stringify(dirs)} skipped=${JSON.stringify(skipped)} autoDiscover=${autoDiscover}`);
  } else {
    log(
      `apply: profile=${profileDir ?? 'unknown'} dirs=${dirs.length} debounce=${debounce} autoDiscover=${autoDiscover} ` +
        `logMax=${
          logMaxBytes
        } whitelist=${autoDiscover === AUTO_DISCOVER.all ? '(bypassed)' : whitelist.length}`,
    );
    for (const dir of skipped) log(`skip (not in whitelist): ${dir}`);
    if (dirs.length > 20) log(`warning: watching ${dirs.length} directories, this is likely too many`);
  }

  let disposed = false;
  let pending = null;
  let busy = false;

  const tick = () => {
    if (disposed || busy) return;
    busy = true;
    try {
      const source = readFileSync(patch, 'utf8');
      const kept = source
        .split(/\r?\n/)
        .filter((line) => !TICK.test(line.trim()))
        .join('\n')
        .replace(/\n+$/, '');
      writeFileSync(patch, `${kept}\n# hot-reload-tick: ${new Date().toISOString()}\n`);
      log('ticked cordis.patch.yml');
    } catch (error) {
      log(`tick failed: ${error?.message ?? error}`);
    } finally {
      busy = false;
    }
  };

  // ── 四层防线（2026-11-13 两度踩坑后的根治）────────────────────────────
  // 事故原貌：被监视的目录被删 → watcher 句柄成僵尸 → 每 ~300μs 刷一次
  // `change: \\?\<abs>` → 旧 schedule() 每次都 clearTimeout 重排 →
  // debounce 永远到不了期 → tick 再也排不上 → 热重载整体失效，
  // 且日志一天涨到 12.65 GB。重建目录救不回来（实测），只能重启宿主。
  //
  // 四道防线彼此独立，任何一道生效都能避免上面的结局：
  //   ① 事件过滤   : 路径不存在就丢弃，僵尸句柄刷的是已消失的路径
  //   ② tick 节流  : 首次触发后固定 debounce 到期，中途事件只记录不重排
  //                  → 即使狂刷，tick 也按固定节拍发生，永不被饿死
  //   ③ 自愈       : 判定坏掉的 watcher 关掉重开；目录不在就先等它回来
  //   ④ 日志限速   : 同一路径每秒最多一条，其余合并计数
  const RATE_LIMIT_PER_SECOND = 1;
  const ZOMBIE_STREAK = 200; // 连续丢弃这么多次就认为句柄坏了

  let pendingSince = 0;   // 这一拍从何时开始算
  let suppressed = 0;     // 本拍内被合并的事件数
  const logBudget = new Map(); // ④ 路径 → { second, count, suppressed }

  const logChange = (reason) => {
    // ④ 同一路径每秒最多写一条；超出只累计，下次允许写时合并报告
    const nowSec = Math.floor(Date.now() / 1000);
    const entry = logBudget.get(reason);
    if (entry && entry.second === nowSec) {
      entry.count++;
      return;
    }
    if (entry && entry.count > 1) {
      log(`change: ${reason} (suppressed ${entry.count - 1})`);
    } else {
      log(`change: ${reason}`);
    }
    logBudget.set(reason, { second: nowSec, count: 1 });
    if (logBudget.size > 512) logBudget.clear();
  };

  const schedule = (reason, isReal) => {
    if (disposed) return;
    // ② 节流：已经排定就不再重排。旧实现每次 clearTimeout 是本次事故的直接成因。
    if (pending !== null) {
      suppressed++;
      return;
    }
    if (isReal) logChange(reason);
    pendingSince = Date.now();
    pending = setTimeout(() => {
      pending = null;
      const merged = suppressed;
      suppressed = 0;
      void pendingSince;
      if (merged > 0) log(`coalesced ${merged} suppressed event(s)`);
      tick();
    }, debounce);
    if (pending.unref) pending.unref();
  };

  ctx.effect(() => {
    const watchers = new Map(); // dir → watcher
    let telegramStreak = 0;     // ① 连续被丢弃的事件数
    let disposedHere = false;

    const attach = (dir) => {
      try {
        const watcher = watch(dir, { recursive: true }, (event, filename) => {
          const file = typeof filename === 'string' ? filename : (filename?.toString?.() ?? '');
          if (!file || IGNORED.test(file)) return;

          // ① 过滤：僵尸句柄报的是已消失的路径。
          //    filename 可能是相对名，也可能已是 `\\?\` 绝对路径，两种都要判。
          const isAbsolutePath = /^[A-Za-z]:[\\/]|^\\\\/.test(file);
          const target = isAbsolutePath ? file : join(dir, file);
          let exists = false;
          try {
            exists = statSync(stripLongPathPrefix(target)) !== undefined;
          } catch {
            exists = false;
          }
          if (!exists) {
            telegramStreak++;
            // ③ 自愈：连续大量「不存在」说明句柄已经绑死在已消失的目录上
            if (telegramStreak >= ZOMBIE_STREAK) {
              telegramStreak = 0;
              log(`watcher looks dead, rebinding ${dir}`);
              rebind(dir);
            }
            return;
          }
          telegramStreak = 0;
          schedule(diag ? `${event} ${file}` : file, true);
        });
        watcher.on('error', (error) => {
          const message = `watcher error ${dir}: ${error?.code ?? ''} ${error?.message ?? error}`;
          if (diag) console.log(`[dev-hotreload] ${message}`);
          else log(message);
          rebind(dir); // ③
        });
        watchers.set(dir, watcher);
        if (diag) console.log(`[dev-hotreload] watching ${dir}`);
        else log(`watching ${dir}`);
      } catch (error) {
        const message = `watch failed ${dir}: ${error?.code ?? ''} ${error?.message ?? error}`;
        if (diag) console.log(`[dev-hotreload] ${message}`);
        else log(message);
      }
    };

    const rebind = (dir) => {
      if (disposedHere) return;
      const old = watchers.get(dir);
      if (old) {
        try {
          old.close();
        } catch {
          /* already closed */
        }
        watchers.delete(dir);
      }
      // 目录本身不存在时不立刻重试（会立刻失败），交给下一拍 tick 之后再试
      if (!isDirectory(dir)) {
        log(`rebind deferred, directory missing: ${dir}`);
        return;
      }
      attach(dir);
    };

    for (const dir of dirs) attach(dir);

    // ③ 补上「被延迟的自愈」：每拍 tick 之后顺带把缺失目录补回来
    // ③ 补上「被延迟的自愈」：目录回来就重绑。
    // 目录被删/重建是**开发者的一瞬间动作**，恢复必须在秒级内完成，
    // 否则使用者会以为热重载坏了（实测第一版 4.6s、第二版 2.6s 都太慢）。
    // 策略：起步就用固定的小间隔（默认 100ms）快速探，最多探 30 秒；
    // 30 秒还没回来说明目录是长时间缺失，转成 2s 的慢速对账，避免长期空转。
    const RETRY_FAST = 100;
    const RETRY_SLOW = 2000;
    const RETRY_FAST_MS = 30_000;
    const retryStart = Date.now();
    let retryTimer = null;
    const tickRetry = () => {
      if (disposedHere) return;
      let missing = 0;
      for (const dir of dirs) {
        if (!watchers.has(dir)) {
          if (isDirectory(dir)) attach(dir);
          else missing++;
        }
      }
      const elapsed = Date.now() - retryStart;
      let delay = RETRY_FAST;
      if (missing > 0 && elapsed > RETRY_FAST_MS) delay = RETRY_SLOW;
      retryTimer = setTimeout(tickRetry, delay);
      if (retryTimer.unref) retryTimer.unref();
    };
    retryTimer = setTimeout(tickRetry, RETRY_FAST);
    if (retryTimer.unref) retryTimer.unref();

    return () => {
      disposedHere = true;
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (pending !== null) clearTimeout(pending);
      pending = null;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      log('stopped watching dev directories');
    };
  });
}