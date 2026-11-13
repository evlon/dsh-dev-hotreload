# dsh-dev-hotreload

给 DeepSeek Harness（DSH）用的**保存即热重载**桥：你在本地开发的插件/预设源码一保存，正在运行的宿主就把那个包热替换掉，不用重启。

## 它解决什么问题

DSH 自带 `@deepseek-ai/dsh-hmr`，但它对**本地链接包**的模块监听是失效的：

- `link:` / `file:` 安装的包，模块在 ESM 缓存里的键是 `<profile>/node_modules/<pkg>/...` 这个 **symlink 路径**；
- 而 HMR 的模块监听 dispatch 先用 `realpath` 得到真实路径再去比对缓存，`esmHas(url)` 恒为 `false`；
- 结果就是：改源码只 emit 一个 `hmr/change` 事件，**永远不会真正重载**（这是 dsh-hmr 0.2.1-rc.3 实测结论）。

真正有效的官方路径是 **profile 重新组合（reconciliation）**：profile 的 `cordis.patch.yml` / `package.json` 一变，dsh-hmr 就比对已加载模块的文件身份（mtime + size），把发生变化的插件停掉、清 ESM 缓存、重新 import。官方文档也明说「linked 包在下次重组合时生效」。

所以本插件的做法很轻：**监视你的本地源码目录，保存后轻触 profile 的 `cordis.patch.yml`**，触发官方那套重组合。

```
保存源码 → 防抖(400ms) → 改写 cordis.patch.yml 的 tick 注释
        → dsh-hmr 的配置监视 → profile 重组合
        → 插件热替换（工具 schema 同步更新）→ client-hmr 推送前端
```

## 安装

```bash
# 从打包好的 tgz（分发用；pnpm pack 的产物）
dsh plugin --profile <profile> add /absolute/path/to/dsh-dev-hotreload-1.0.0.tgz

# 从本地目录链接（想改源码立刻自举生效时最常用）
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-dev-hotreload

# 从 GitHub
dsh plugin --profile <profile> add github:Pxczxn/dsh-dev-hotreload
```

打包自己分发：

```bash
pnpm pack --pack-destination ./dist
```

包自带 bundle 层（`dsh.bundle.patch`），安装后行 `dev-hotreload` 会自动进组合，**零配置即可工作**。

## 零配置时它怎么找到东西

从 v1.1.0 起，**默认只监视白名单目录**（见下一节）。旧版本「发现 profile 里所有 `link:` 包就全部递归监视」的做法已经废弃：它会把每轮对话都在写盘的插件（如 `dsh-memory-evolve`）也算成「开发目录」，一次会话就能刷出上亿条 watch 事件。

| 需要的东西 | 自动发现方式 |
| --- | --- |
| profile 目录 | `profileContext.dir` → `ctx.baseUrl` → 宿主进程参数里的绝对路径 → `$DSH_HOME/profiles/desktop`，取第一个"像 profile"的目录 |
| 要监视的源码目录 | **白名单内**那些确实被 `link:` / `file:` 依赖进 profile 的包（`autoDiscover: 'whitelist'`，默认） |
| 要轻触的 patch 文件 | `<profile>/cordis.patch.yml` |
| 日志 | `os.tmpdir()/dsh-dev-hotreload.log`，超过 **50 MB** 自动轮转成 `.log.1`（只保留一份） |

`node_modules`、`.git`、`dist`、`build`、`out`、`coverage`、`cache` 等目录里的写入会被忽略。

## 白名单（默认值）

内置默认白名单是这台机器上我们自己的 4 个开发目录：

```text
E:\dsh-a2a-bus\dsh-a2a
E:\dsh-a2a-bus\dsh-collab-secretary
E:\dsh-a2a-bus\dsh-tool-switchboard
E:\dsh-a2a-bus\open-repos\dsh-dev-hotreload
```

规则（`autoDiscover` 的语义）：

| `autoDiscover` | 行为 |
| --- | --- |
| 不写 / `'whitelist'` / `true` | **默认**。白名单是上界：`dirs` 显式目录和自动发现结果都必须在白名单内，`autoDiscover` 只负责在白名单里挑出真的被 link 的包，**不会自行扩大范围**。白名单外的目录会以 `skip (not in whitelist): ...` 记进日志，不静默。 |
| `false` / `'off'` | 只监视 `dirs` 里显式列出的目录（仍受白名单约束）。 |
| `'all'` / `'legacy'` | **回到 v1.0 的旧行为**：发现 profile 里所有 `link:` 包并全部监视，绕过白名单。只在真的需要时用。 |

路径比较前会先规范化：去掉零宽字符/BOM 等不可见字符、统一斜杠、去掉尾随分隔符，并**小写化**（Windows 路径大小写不敏感）。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里用同 id 覆盖，**config 是整体替换**，没写的字段用默认值：

```yaml
- id: dev-hotreload
  config:
    whitelist:                  # 整个替换内置白名单（不是追加）
      - 'D:\Coding\project\dsh\plugins\my-plugin'
    dirs:                       # 额外/显式监视的目录（仍受白名单约束）
      - 'D:\Coding\project\dsh\plugins\my-plugin'
    autoDiscover: whitelist     # 默认；'off' 只盯 dirs；'all' 回到旧的全量发现
    log: 'D:\Coding\tmp\dev-hotreload.log'   # 默认 tmpdir 下；false 关闭
    logMaxBytes: 52428800       # 日志上限，默认 50 MB，超过即轮转成 .1
    profile: 'D:\...\profiles\desktop'   # 默认自动定位
    patch: 'D:\...\profiles\desktop\cordis.patch.yml'  # 默认 <profile>/cordis.patch.yml
    debounce: 400               # 毫秒
```

想加一个自己的开发目录，最省事是**列出完整白名单**（`whitelist` 是整体替换）：

```yaml
- id: dev-hotreload
  config:
    whitelist:
      - 'E:\dsh-a2a-bus\dsh-a2a'
      - 'E:\dsh-a2a-bus\dsh-collab-secretary'
      - 'E:\dsh-a2a-bus\dsh-tool-switchboard'
      - 'E:\dsh-a2a-bus\open-repos\dsh-dev-hotreload'
      - 'D:\repo\my-plugin'
```

## 为什么不监视记忆插件

`dsh-memory-evolve` 这类插件**每轮对话都会写自己的文件**（memory/user/project/daily 四条轨）。把它当"开发目录"递归监视，等于把「正常业务写盘」当成「源码保存」，于是：

- 每一轮对话都触发一次 tick + 一次 profile 重组合（性能开销与"改配置"同级），
- 每条事件都写一行日志 —— 实测一天 5400 万条，日志连同其它包一起涨到 **12.65 GB / 1.95 亿行**，最后把宿主拖垮。

所以白名单只放「我们自己写代码、保存不频繁」的目录。开发记忆插件时，把它加进 `whitelist` 临时开一会儿即可，写完记得移出。

## 日志轮转

`log()` 每次写之前用 `statSync` 看一眼当前大小，超过 `logMaxBytes`（默认 50 MB）就把主文件 `rename` 成 `.log.1`（覆盖旧的那份），下一次 append 自然重建主文件。

**为什么不用「读整个文件再重写」**：日志曾经到过 12 GB，任何 `readFileSync` + `writeFileSync` 的做法都会在轮转那一刻把宿主（和它的内存）拖死；而 `rename` 是 O(1) 的目录操作，不碰文件内容。因此磁盘占用上界是 `2 × logMaxBytes`。

## 验证它真的在工作

1. 编辑白名单里任意包里被 `import` 到的文件（比如 `src/tools.js`）；
2. 看日志：`Get-Content "$env:TEMP\dsh-dev-hotreload.log" -Tail 20`，应出现 `watching <dir>`、`change: src/...` 和 `ticked cordis.patch.yml`；
3. 宿主里立刻能用到改后的行为（比如工具输出变了），说明插件已热替换。

不带 profile 环境、直接验证白名单与轮转逻辑：

```bash
node scripts/verify-acceptance.mjs
```

## 监视目录被删了会怎样（v1.2.0 起会自愈）

这是本插件最容易踩的坑，值得单独说。

**旧版（≤1.1.0）**：被监视的目录一旦被删除（`git checkout` 切分支、`rm -rf`、移动目录都会触发），`fs.watch` 的句柄会绑死在已消失的目录对象上变成僵尸，此后：

- 每 ~300μs 触发一次 `change: \\?\<绝对路径>`
- 每次都重置 debounce，`tick()` 永远排不上 → **热重载整体失效**
- 日志一天能涨到 12.65 GB（实测）
- **把目录重建回来也救不回**，唯一解是重启宿主

**v1.2.0 的四层防线**（互相独立，任何一层生效都能避免上述结局）：

| 防线 | 做法 |
|---|---|
| ① 事件过滤 | 回调里先判断路径是否存在，僵尸句柄报的都是已消失的路径，直接丢弃 |
| ② tick 节流 | 首次触发后**固定** debounce 到期，中途事件只计数不重排 → 即使狂刷，tick 也按固定节拍发生，永不被饿死 |
| ③ 自愈 | 连续 200 次「路径不存在」或收到 `error` 就关掉旧 watcher；目录一回来立即重绑（实测 58ms） |
| ④ 日志限速 | 同一路径每秒最多记一条，其余合并成 `(suppressed N)` |

实测：删除被监视目录 1.5 秒内 **0 条** change 日志（旧版会是数千~数万条），目录回来 58ms 内自动重绑并恢复工作。

**即便如此，仍然建议**：不要删除正在被监视的目录。要换位置就改 `whitelist` 配置。

## 须知 / 限制

- 它依赖 `@deepseek-ai/dsh-hmr` 的**配置监视**能力。若你在 profile 里把 `hmr` 行 `disabled: true`，本插件就无效了。`config.root` 不需要为本插件设置（模块监听对 linked 包无效，`root: []` 即可）。
- 保存后有一次重组合，性能开销与"改配置"同级；`debounce` 可调。
- 重组合失败时 dsh-hmr 不会回滚到旧版本 —— 改坏代码会看到插件 `failed`，修好再保存即可恢复。
- 只对**会重新执行 `apply`** 的宿主侧代码生效；纯 client（浏览器侧）bundle 的更新由 client-hmr 负责，视插件是否声明 `dsh.client` 而定。
- `DEFAULT_WHITELIST` 里是本机路径。**别人克隆后这些目录不存在，会被静默跳过**（不报错、不监视任何目录）；改成自己的目录请配 `whitelist` 或 `dirs`。
- 分支专属的包（只存在于某个分支）应放在常驻 worktree 里再进白名单，不要直接指向主工作树 —— 切分支会让它消失。

## 开发

```bash
node --test test/index.test.js
```

## License

MIT
