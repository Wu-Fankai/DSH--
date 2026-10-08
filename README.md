# dsh-plugin-profile-sync

跨 Profile 对齐**用户自己安装的** DSH 插件，解决「装一次、两边都能用」的问题。

[English](#english) | 中文

---

## 为什么需要它

DSH 的每个 profile（`web`、`desktop`、以及你自己建的任何 profile）都有**自己的** `package.json`：插件装进哪个 profile，就只对那个 profile 生效。官方文档对此是明确的：

> 切换 profile 不会把旧 profile 的插件偷偷复制到新 profile。

所以从 DSH Desktop 默认的 `desktop` profile 切到浏览器用的 `web` profile 时，你会发现插件全没了，得再装一遍。

而**重复安装 `desktop` 这一边是装不了的**——DSH CLI 会直接拒绝：

```
$ dsh plugin --profile desktop add dshmarket
error: profile "desktop" is managed exclusively by the Electron application
```

`dsh-desktop.syncProfiles` 那个「启动时自动同步」的开关属于 [未合并的 PR #212](https://github.com/anywhere-labs/dsh-desktop/pull/212)，目前不存在。这个插件就是它的替代品，并且能在今天真正跑起来。

## 它做什么

1. 读取源 profile（默认 `web`）的 manifest，找出其中的**用户插件**；
2. 算出目标 profile（默认 `desktop`）缺哪些；
3. 默认只**打印计划**，不写任何东西；
4. `--apply` 时才改 manifest（原子写 + 备份），然后调用 pnpm 把包装上。

**它绝不复制产品 bundle。** `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 这类由 DSH 安装自带的 bundle，以及 DSH Desktop 自己的 launcher bundle，都会被明确识别并跳过——把桌面壳的 bundle 塞进普通 profile 是搞坏 profile 的经典方式。

## 三条硬规则

| 规则 | 原因 |
|---|---|
| 只同步**声明了依赖版本**的 bundle | 一个在 `dsh.profile.bundles` 里但不在 `dependencies` 里的名字，来源不明。默认拒绝，只报告，不复制。 |
| 产品 bundle / Desktop 自有 bundle 永不同步 | `desktop` 与 `web` 的产品组合本就不同，互抄必然启动失败。 |
| 默认 dry-run | 写 manifest 会改变 profile 组合，必须是显式动作。`--apply` 是唯一会写盘的开关。 |

## 用法

```sh
# 1. 先看计划（不写任何东西）
node bin/dsh-profile-sync.js

# 2. 确认无误后执行：先写 manifest，再 pnpm install
node bin/dsh-profile-sync.js --apply

# 3. 重启 DSH / DSH Desktop，让新的 bundle 层进入 Loader 组合
```

### 常用参数

| 参数 | 说明 |
|---|---|
| `--from <a,b>` | 源 profile，可多个（默认 `web`） |
| `--to <a,b>` | 目标 profile，可多个（默认 `desktop`） |
| `--all` | 以所有已发现的 profile 为源和目标，强制全局一致 |
| `--prune` | 反向也同步：源里没有的用户插件从目标移除 |
| `--allow-conflicts` | 多个源对同一插件声明不同版本时，取第一个源的版本。**默认拒绝**，因为静默取一个并不等于做了选择 |
| `--apply` | 真正写盘（默认 dry-run） |
| `--no-install` | 只改 manifest，不跑包管理器 |
| `--no-backup` | 不保留 `.bak` 备份 |
| `--check` | CI 用：目标未对齐、或声明了但没装上都退出 1，不写盘 |
| `--json` | 输出机器可读的 plan / result |
| `--dsh-home <path>` | 指定 DSH home（默认 `$DSH_HOME` 或 `~/.dsh`） |

### 示例

```sh
# 让 desktop 和 web 双向对齐（web 也会补上 desktop 独有的）
node bin/dsh-profile-sync.js --from web,desktop --to web,desktop --apply

# 三个 profile 全局一致，并清掉多余的
node bin/dsh-profile-sync.js --all --prune --apply

# 只准备另一个 profile，先不激活
node bin/dsh-profile-sync.js --from web --to work --apply
```

### 退出码

| 码 | 含义 |
|---|---|
| `0` | 成功（dry-run 也算成功） |
| `1` | `--check` 发现目标不可用（未对齐，**或声明了但包没装上**）；或 apply 时写盘/安装/校验失败 |
| `2` | 参数错误、DSH home 无法确定、源 profile 不存在、**多个源版本冲突（默认拒绝）** |

> `--check` 的语义是「这个 profile 现在能不能用」，不是「manifest 对不对」。所以 manifest 写对但 `node_modules` 里没有包时它**也会失败** —— 这种状态启动时是会出问题的。加了 `--no-install` 时才只校验 manifest 声明。

## 作为 DSH 插件安装

这个包同时是一个标准 DSH host 插件，会发布 `ctx.dshProfileSync` 服务：

```js
// plan() 不写盘，sync() 才写
const plan = ctx.dshProfileSync.plan({ sources: ['web'], targets: ['desktop'] })
const result = await ctx.dshProfileSync.sync({ install: true })
```

服务名带包前缀而不是裸 `profileSync`，因为 `ctx.provide` 在**服务名重复时会同步抛错**；万一真的撞名，插件会捕获它、降级为直接挂在 `ctx` 上，**绝不因此让 profile 启动失败**。

安装进 profile（`desktop` 需要在 DSH Desktop 终端里操作，或先同步到 `web`）：

```sh
dsh plugin --profile web add /path/to/dsh-plugin-profile-sync
```

插件在 `cordis.patch.yml` 里以 row 形式插桩，可以带上自己的配置：

```yaml
- insert:
    - id: dsh-plugin-profile-sync
      name: 'dsh-plugin-profile-sync'
      config:
        from: web
        to: desktop
```

未配置时，插件会尝试问 launcher 要当前 profile（`profileContext`）；两条路都拿不到时它会**拒绝执行**而不是猜一个 profile。

## 它不做什么

- **不改 `cordis.patch.yml`。** 如果某个插件依赖 profile 里的 patch row 做配置，同步只会带来包本身，patch 需要你自己搬。计划输出里的 `Deliberately not synced` 会提示被跳过的项。
- **不自动重启。** 组合变更在下次启动才生效，工具只提醒你重启。
- **不处理凭据 / 环境变量 / workspace。** 只碰 `profiles/<name>/package.json` 里的 `dependencies` 与 `dsh.profile.bundles`。
- **不联网解析版本。** 版本号原样搬运；具体能不能装由 pnpm 决定。

## 安全性

- 写盘前先取 `<manifest>.profilesync.lock` 排他锁，并对 manifest 做完整校验；锁超时会回收，不会因为一次被杀死的进程永久卡住。
- 原子替换：临时文件 fsync 后 rename，原文件先复制成 `.profilesync.bak`。**进程崩溃只会留下旧 manifest 或新 manifest，不会留下半截文件。**
- 包管理器调用先解析成真实文件：Windows 上优先原生 `.exe`（真正可执行的二进制），其次 `.cmd`/`.bat`，最后才是无扩展名的 POSIX 脚本；`.ps1` 永不选用。命令脚本必须经 `cmd.exe` 才能启动（Node 直接 spawn 会 `EINVAL`），此时交给 Node 自己的转义实现，而不是手工拼命令行——`cmd.exe` 与 `CommandLineToArgvW` 不是同一个解析器，手拼必然出错。
- 该 shell 通道**从不接触外部数据**：命令行上的每个参数都是本文件的字面量（`install`、`--no-frozen-lockfile`）或固定的候选项（`pnpm`），可执行文件是从 PATH 解析出的路径。**包名、profile 名、manifest 内容永远不会进入 shell**，因此不存在注入面。
- manifest 结构做「结构性保留」：`version`、`packageManager`、未知的顶层键和 `dsh.*` 同级键都保持原值与原位置，只动 `dependencies` 与 `dsh.profile.bundles`。
- 容忍 UTF-8 BOM：PowerShell 的 `Set-Content -Encoding utf8` 和不少 Windows 编辑器会写入 BOM，而 DSH 自身的 manifest 读取器接受它，所以本工具也接受，避免与 DSH 对「哪些 profile 可读」产生分歧。
- 每次同步会在 manifest 里写 `dsh.profileSyncLedger`，记录**本工具**同步过哪些 bundle，便于人工审计。

## 开发

```sh
node tests/sync.test.js     # 36 个测试，全部离线，不碰真实 profile
```

测试覆盖：分类（product / user / desktop-owned / unknown）、并集与版本冲突（默认拒绝 + 无法绕过写盘）、本地 `file:` spec 告警、幂等（apply 后再 plan 应为空）、剪枝、原子写失败后原文件字节不变、锁的排他性与超时回收、可执行文件解析优先级、shell 只用于命令脚本、包管理器不可用与安装失败、BOM 容忍、「manifest 对但没装包」必须判失败、CLI 退出码、以及插件在 `ctx.provide` 不可用/撞名时的降级。

端到端（真实 pnpm 安装）可以这样复现，全部在临时目录里完成：

```sh
# 造一个只有 web 装了插件的临时 DSH home，然后 --apply
node bin/dsh-profile-sync.js --dsh-home <临时目录> --apply
```

测试拆成 4 个文件，`node --test tests/*.test.mjs` 一次跑完（CI 用这个）。如果所在环境禁止子进程管道（某些沙箱），用 `npm run test:direct` 逐个文件直接执行。

---

## 发布流程

### 一次性准备

```sh
cp .release-target.example.json .release-target.json   # 填入真实仓库地址
npm run release:stamp                                   # 把地址写进 package.json
```

`.release-target.json` 在 `.gitignore` 里，不会进仓库；仓库地址是发布元数据的一部分，写错了会永久留在 npm 上，所以改成显式一条命令，而不是留个占位符侥幸通过。

### 发布前检查（必须全绿）

```sh
npm run release:check
```

它依次做三件事：

| 步骤 | 检查内容 |
|---|---|
| `node --test tests/*.test.mjs` | 44 个测试（Linux/macOS/Windows × Node 22.19/24 由 CI 覆盖） |
| `scripts/check-pack.mjs` | 复刻 npm 的文件筛选规则；断言发布元数据、bin/patch/类型声明都在包里、测试与脚本不在包里；真的打出一个 tarball |
| `scripts/check-install.mjs` | 把 tarball **解包**成 `node_modules/<name>`，验证每个 manifest 引用都存在、bin 能跑、宿主导出可加载、每个子路径导出可解析 |

两个脚本都不依赖 npm 和网络——所以它们在任何机器上都能跑，结果也一致。

### 常见失败与处理

| 失败项 | 原因 | 处理 |
|---|---|---|
| `repository url is stamped with a real target` | 还没填 `.release-target.json` | 见上面「一次性准备」 |
| `every files entry matches something` | `package.json` 的 `files` 里有不存在的路径 | 补文件或删该条 |
| `every manifest-referenced file exists` | `main`/`exports` 指向的文件没进包 | 检查 `files` 是否覆盖 |
| `tests are not shipped` | `files` 误包含了 `tests/` | 从 `files` 移除 |

### 发布

```sh
npm publish            # 或 npm publish --dry-run 先看清单
```

> **本机注意**：这台机器的 PowerShell 执行策略会拦住 `npm.ps1`。用 `npm.cmd`，或在受信任的 shell 里执行。发布本身需要联网，也可能需要 `npm login`。

### 首发前仍未完成的验证

这些不影响发布资格，但会影响"能不能算稳定版"的判断，**如实列出**：

1. **未在 Linux/macOS 实机跑过**：CI 已配置这两个平台，首次 CI 通过才算真正覆盖。
2. **Host 插件未被第二个插件实际注入使用**：`ctx.dshProfileSync` 的加载路径已验证，但没有真实消费者。
3. **没有第三方安全审计**：结论来自作者自查（源码扫描 + 逐条核实误报）。

### 已完成的端到端验证

`web` → `desktop` 的完整链路已在真实 DSH 环境跑通（Windows，DSH `0.1.5-rc.2`）：

```sh
node bin/dsh-profile-sync.js                    # 计划：4 个用户插件，2 个产品 bundle 被排除
node bin/dsh-profile-sync.js --apply            # exit 0：写 manifest + pnpm 装 7 个包
node bin/dsh-profile-sync.js --check            # exit 0：already aligned
```

然后重启 **DSH Desktop**，其「设置 → 内置插件 → 已安装插件」列出了同步过去的 4 个第三方插件，状态均为 `已启用 / 已加载`；`profiles/desktop/.dsh-market/state.json` 由 `dshmarket` 在 Desktop 进程内写入，是该 profile 真实启动过插件的直接证据。

一个已知偏差：源里 `dshmarket` 声明为 `^1.54.0`，目标侧 pnpm 解析成更新的版本（web `1.54.0`，desktop `1.66.9`）。工具搬运的是**版本声明**而非锁定版本，这是设计如此。

一个已知副作用：`pnpm install` 会自己往目标 profile 的 `pnpm-workspace.yaml` 追加 `minimumReleaseAgeExclude` 条目（本工具不写这个文件）。如需恢复，从备份复制该文件即可。

---

## English

`dsh-plugin-profile-sync` aligns **user-installed** DSH plugins across profiles.

Every DSH profile owns its own plugin list, and DSH Desktop's `desktop` profile is
explicitly refused by the CLI (`profile "desktop" is managed exclusively by the
Electron application`). The `dsh-desktop.syncProfiles` startup switch seen in
[PR #212](https://github.com/anywhere-labs/dsh-desktop/pull/212) is not merged, so
this package does the job today.

```sh
node bin/dsh-profile-sync.js            # dry run: print the plan, write nothing
node bin/dsh-profile-sync.js --apply    # write manifests, then pnpm install
node bin/dsh-profile-sync.js --all --prune --apply
node bin/dsh-profile-sync.js --check    # CI gate, exit 1 when unaligned
```

Three hard rules: only bundles with a declared dependency specifier are synced;
product and Desktop-owned bundles are never copied between profiles; and nothing
is written without `--apply`. Writes are lock-protected, atomic, and backed up.
The package manager is resolved to a real file before spawning (native `.exe`
first, then `.cmd`; `.ps1` never), and the shell channel that a Windows command
shim requires only ever carries this package's own literals — no package name,
profile name, or manifest value reaches a shell.

MIT licensed.
