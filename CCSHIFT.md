# ccshift 定制说明

ccshift 基于 [CC Switch](https://github.com/farion1231/cc-switch)（MIT 协议）改造，面向小白用户，只管理 **Claude Code** 和 **Codex**。

## 和原版的区别

| 项目 | 原版 CC Switch | ccshift |
| --- | --- | --- |
| 支持的应用 | 14 个（Gemini、OpenCode、Kimi…） | Claude Code、Claude 桌面版、Codex（Codex 桌面版读同一份配置，自动生效） |
| 首次打开 | 供应商列表 | **快速配置向导** |
| 环境安装 | 只装 CLI | 「一键全部安装」：Node.js、Git（仅 Windows）从国内镜像 npmmirror 下载到用户目录，不需要管理员、不依赖 winget / Homebrew；国内时区自动切 npm 国内镜像；Windows 自动放开 PowerShell 脚本限制；macOS / Linux 自动修复 npm 全局目录权限 |
| 配置第三方 API | 选预设 / 手填 JSON | 填「地址 + Key」→ 测试连接 → 一键写入两个工具，地址格式（`/v1`）自动修正 |
| 侧栏 | MCP、Skills、提示词、会话、授权、用量 | 默认隐藏，设置 → 通用 → **高级模式** 打开后出现 |
| 自动更新 | 指向原作者 | **已关闭**（见下文） |
| 深链接协议 | `ccswitch://` | `ccshift://`（`ccswitch://` 链接也能导入） |
| 广告 | 赞助商置顶、推广语、返利链接、Star 推广 | **全部去掉**：聚合站 / 第三方中转站预设隐藏（竞品），合作伙伴标记和推广语删除，官方厂商链接里的返利参数（aff、ref、track_id…）清掉 |
| 原项目链接 | GitHub、ccswitch.io、更新日志 | 去掉；官网 / 下载链接改成你自己配置，留空就不显示 |

## 常改的地方

所有发行版开关集中在 [src/config/edition.ts](src/config/edition.ts)：

- `BRAND_NAME`：界面上显示的名字
- `WEBSITE_URL`：关于页「官网」按钮（填你的店铺 / 教程页，留空不显示）
- `DOWNLOAD_URL`：下载新版本的页面（留空不显示）
- `UPDATE_CHECK_ENABLED`：是否检查更新
- `EDITION_APPS`：管理哪些应用

托盘菜单的「打开官方网站」和「检查更新」在 [src-tauri/src/edition.rs](src-tauri/src/edition.rs)，填同样的地址。

预设清理规则在 [src/config/slimPresets.ts](src/config/slimPresets.ts)：想重新显示某类预设，改 `HIDDEN_CATEGORIES`。

其他需要手动改的：

- **应用图标**：替换 `src-tauri/icons/` 下的图标（可用 `pnpm tauri icon 你的图标.png` 一次生成全部尺寸），侧栏 / 关于页的 logo 在 `src/assets/icons/logo.svg`
- **安装包名 / 标识**：`src-tauri/tauri.conf.json` 的 `productName`、`identifier`（已改为 `ccshift` / `com.ccshift.desktop`，可以和原版 CC Switch 同时安装）

## 自动更新（重要）

已开启。ccshift 启动时读取 `https://github.com/GetGoAPI/ccshift/releases/latest/download/latest.json`，有新版本就提示，客户在「设置 → 关于」里一键更新。

- **发新版**：推一个 `v` 开头的标签（如 `git tag v1.0.2 && git push origin v1.0.2`）。`release.yml` 会打包、签名、生成 `latest.json`，一起发布到 GitHub Releases。版本号只能往上加。
- **签名密钥**：私钥在本机 `~/.tauri/ccshift.key`，同时存在 GitHub 仓库 Settings → Secrets 的 `KEY`（也认 `TAURI_SIGNING_PRIVATE_KEY`）（`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 留空）；公钥在 `tauri.conf.json` 的 `plugins.updater.pubkey`。
- **私钥务必备份**。丢了就再也发不出已安装用户能自动安装的更新，只能让所有人手动重装。
- **v1.0.1 及更早的版本没有更新功能**，这些用户需要手动下载一次新版，之后才能自动更新。
- 本机打包（`pnpm build`）也要签名：先设置环境变量 `TAURI_SIGNING_PRIVATE_KEY` 为私钥文件内容，否则打包会失败。

## 数据目录

ccshift 和原版共用 `~/.cc-switch` 数据目录（供应商列表、设置）。好处是用过原版的客户打开 ccshift 就能看到原来的配置；如果客户同时装了更新版本的原版 CC Switch，数据库版本可能更高，ccshift 会提示需要升级。

## 各种客户情况怎么处理

| 情况 | ccshift 的处理 |
| --- | --- |
| 已经装好环境 | 检测到的直接打勾，不重复安装；原有 Claude Code / Codex 配置首次启动时备份成「default」供应商 |
| Node.js 低于 22 | 标红「版本过低」，一键升级：用户目录 / 没装 → 镜像 zip 安装；装在系统目录的旧版 → 镜像官方 MSI 覆盖（会弹管理员确认）；nvm 管理的 → 不动，提示 `nvm install lts` |
| 自己设过环境变量（ANTHROPIC_* / OPENAI_*） | 向导第 1 步显示「环境变量冲突」可一键清除；点「一键配置」前再查一次，有冲突先提醒。清除前自动备份 |
| 用 Claude 桌面版 | 快速配置可勾选，只支持 Anthropic 格式接口；没装桌面版时选项置灰 |
| 不再使用 | 设置 → 通用 →「一键还原」：只还原配置，或彻底清理（卸载 CLI、删除 ccshift 装的 Node / Git、恢复 npm 源和 PowerShell 策略）。只删带 `.ccshift-installed` 标记的目录，客户自己装的不碰；改动记录在 `~/.ccshift/env-changes.json` |
| 配置后「没生效」 | 完成页提醒：已打开的终端和 VS Code 要关掉重开 |

## 一键安装装到了哪里（售后排查用）

| 内容 | Windows | macOS / Linux |
| --- | --- | --- |
| Node.js | `%LOCALAPPDATA%\Programs\nodejs`（已加入用户 PATH） | `~/.ccshift/node`（PATH 写进 `~/.zshrc` 等启动文件） |
| npm 全局包（Codex 等） | Node.js 同目录 | Node 同目录；修复权限后为 `~/.npm-global` |
| Git | `%LOCALAPPDATA%\Programs\Git`（便携版，已设 `CLAUDE_CODE_GIT_BASH_PATH`） | 不安装 |
| PowerShell 执行策略 | 当前用户改为 `RemoteSigned` | — |

装完后**已经打开的**终端和 VS Code 看不到新的 PATH，要关掉重开。

## 开发与打包

```bash
pnpm install
pnpm dev            # 开发模式运行
pnpm build          # 打包安装包（产物在 src-tauri/target/release/bundle/）
pnpm typecheck      # 类型检查
pnpm test:unit      # 前端单测
```

需要 Node.js 20+、pnpm 10、Rust（见 `rust-toolchain.toml`）。

## 新增的代码

- `src/config/edition.ts`、`src-tauri/src/edition.rs`：发行版配置、高级模式开关
- `src/config/slimPresets.ts`：去广告、隐藏竞品预设
- `src/components/setup/`：快速配置向导
- `src/lib/api/devEnvironment.ts` + `src-tauri/src/commands/ccshift_env.rs`：环境检测、Node.js / Git 安装、npm 源切换
- `tests/setupUtils.test.ts`、`tests/edition/`：向导的地址规整、配置生成、精简版开关、去广告的测试

原项目的文档、截图、赞助商素材、多语言 README、社区文件和 CI 都已删除。

上游的测试按完整版 CC Switch 写，`tests/setupTests.ts` 里把发行版开关 mock 成了完整版，让它们继续覆盖底层共用的代码。上游本身有 8 个用例在 Windows 上不稳定（PiProviderForm、IconPicker、App 集成测试超时等），和 ccshift 的改动无关。

改动尽量集中在上面这些新文件，原有文件只做了小幅接入，方便以后合并 CC Switch 上游的更新。
