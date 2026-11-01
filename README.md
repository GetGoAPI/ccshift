# ccshift

一键配置 **Claude Code** 和 **Codex** 的桌面工具，支持 Windows 和 macOS（Apple 芯片 / Intel）。

## 功能

- **一键全部安装**：自动检测并安装 Node.js、Git（Windows）、Claude Code、Codex。从国内镜像下载，不需要管理员权限；自动处理 npm 镜像、PowerShell 脚本限制、npm 权限等新电脑常见问题。
- **快速配置**：填入 API 地址和 Key，测试连接后一键写入 Claude Code 和 Codex，地址格式自动修正。
- **多个供应商一键切换**，VS Code / Cursor / JetBrains 里的插件同步生效。
- 托盘菜单快速切换，开机自启。

## 使用

1. 下载并安装 ccshift
2. 打开后进入「快速配置」，点「一键全部安装」
3. 填入 API 地址和 Key，点「一键配置」
4. 打开终端，输入 `claude` 或 `codex` 开始使用

## 开发

```bash
pnpm install
pnpm dev      # 开发模式运行
pnpm build    # 打包安装包
```

需要 Node.js 20+、pnpm 10、Rust。定制说明见 [CCSHIFT.md](CCSHIFT.md)。

## 许可

MIT。本项目基于 [CC Switch](https://github.com/farion1231/cc-switch)（Copyright (c) 2025 Jason Young，MIT 协议）修改，原版权声明保留在 [LICENSE](LICENSE) 中。
