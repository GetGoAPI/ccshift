//! ccshift：新手向导用的运行环境检测与一键安装。
//!
//! 全新电脑上小白最常卡在这几处，这里逐个处理：
//! - 没有 Node.js：从国内镜像（npmmirror）下载官方压缩包，解压到用户目录并加进用户 PATH。
//!   不依赖 winget / Homebrew，不需要管理员权限，国内外都能下。
//! - Windows 没有 Git（Claude Code 依赖 Git Bash）：同样从镜像下载便携版 Git 解压到用户目录。
//! - npm 下载慢：切换到国内镜像。
//! - Windows PowerShell 默认禁止运行脚本：npm 装的 `claude.ps1` / `codex.ps1` 一敲就报错，
//!   把当前用户的执行策略改成 RemoteSigned。
//! - macOS / Linux 上 npm 全局目录属于 root（官网 pkg 安装的 Node）：`npm i -g` 报 EACCES，
//!   把全局目录改到 `~/.npm-global`。
//!
//! 执行沿用工具安装的 PATH 补全（`effective_path_string` / `login_shell_path`），
//! 刚装好的 Node 不用重启 ccshift 也能被看到。

use super::{decode_command_output, run_tool_lifecycle_silently};
#[cfg(not(target_os = "windows"))]
use super::{login_shell_path, merge_path_segments};

#[cfg(target_os = "windows")]
use super::{effective_path_string, powershell_encoded_command, CREATE_NO_WINDOW};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevEnvironmentStatus {
    pub platform: &'static str,
    pub node_version: Option<String>,
    pub npm_version: Option<String>,
    pub git_version: Option<String>,
    pub npm_registry: Option<String>,
    /// Windows：PowerShell 当前生效的执行策略（Restricted / RemoteSigned …）
    pub powershell_policy: Option<String>,
    /// macOS / Linux：npm 全局目录当前用户能不能写；没装 npm 时为 None
    pub npm_global_writable: Option<bool>,
}

/// 探测和安装脚本共用的 PATH：Windows 合并注册表里的用户 / 系统 PATH，
/// 其他平台取登录 shell 的 PATH（GUI 应用继承的 PATH 往往缺 nvm / Homebrew）。
fn probe_path() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        Some(effective_path_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let inherited = std::env::var("PATH").unwrap_or_default();
        login_shell_path(None).map(|login| merge_path_segments(&login, &inherited))
    }
}

/// 跑一条短命令取 stdout 第一行；起不来或退出码非 0 时返回 None。
fn probe(command_line: &str, path: Option<&str>) -> Option<String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C")
            .arg(command_line)
            .creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut cmd = std::process::Command::new("bash");
        cmd.arg("-c").arg(command_line);
        cmd
    };
    if let Some(path) = path {
        cmd.env("PATH", path);
    }
    let output = cmd.stdin(std::process::Stdio::null()).output().ok()?;
    if !output.status.success() {
        return None;
    }
    decode_command_output(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

#[tauri::command]
pub async fn check_dev_environment() -> Result<DevEnvironmentStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = probe_path();
        let path = path.as_deref();
        let npm_version = probe("npm --version", path);
        let npm_registry = npm_version
            .as_ref()
            .and_then(|_| probe("npm config get registry", path));
        #[cfg(target_os = "windows")]
        let (powershell_policy, npm_global_writable) = (
            probe(
                "powershell -NoProfile -NonInteractive -Command Get-ExecutionPolicy",
                path,
            ),
            None,
        );
        #[cfg(not(target_os = "windows"))]
        let (powershell_policy, npm_global_writable) = (
            None,
            npm_version
                .as_ref()
                .and_then(|_| probe(NPM_GLOBAL_WRITABLE_PROBE, path))
                .map(|answer| answer == "yes"),
        );
        DevEnvironmentStatus {
            platform: current_platform(),
            node_version: probe("node --version", path),
            npm_version,
            git_version: probe("git --version", path),
            npm_registry,
            powershell_policy,
            npm_global_writable,
        }
    })
    .await
    .map_err(|e| format!("environment check task join error: {e}"))
}

// ─── Windows 脚本 ──────────────────────────────────────────────────────────

/// PowerShell 公共开头：出错即停、关掉拖慢下载的进度条、强制 TLS 1.2（Windows 10 旧版默认不开），
/// 以及把目录加到用户 PATH 的函数。`SetEnvironmentVariable(..., 'User')` 会广播
/// WM_SETTINGCHANGE，之后新开的终端直接能用。
#[cfg(target_os = "windows")]
const PS_PRELUDE: &str = r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
function Add-UserPath([string]$dir) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @(($current -split ';') | Where-Object { $_ -and ($_ -ne $dir) })
  [Environment]::SetEnvironmentVariable('Path', ((@($dir) + $parts) -join ';'), 'User')
}
"#;

/// 装 / 升级 Node.js（都从国内镜像下载最新 LTS）：
/// - nvm-windows 管理的：不动，提示客户用 nvm 升级（覆盖会弄坏 nvm 的软链接）。
/// - 装在系统 PATH 里的旧版（官网 MSI 装在 Program Files）：系统 PATH 排在用户 PATH 前面，
///   另装一份到用户目录会被它挡住，只能用官方 MSI 覆盖升级（会弹管理员确认）。
/// - 其余（没装、ccshift 自己装的、其他用户目录）：zip 解压到 %LOCALAPPDATA%\Programs\nodejs，
///   加进用户 PATH 最前面。npm 全局包默认装在 node.exe 同目录；旧版 npm 的内置 npmrc 指向
///   %APPDATA%\npm，这个目录也一并加进 PATH。都在用户目录下，全局安装不需要管理员。
#[cfg(target_os = "windows")]
const PS_INSTALL_NODE: &str = r#"
try {
  $mirror = 'https://cdn.npmmirror.com/binaries/node'
  $programs = Join-Path $env:LOCALAPPDATA 'Programs'
  $dest = Join-Path $programs 'nodejs'
  $existing = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  $existingDir = if ($existing) { Split-Path $existing.Source } else { $null }
  $nvm = [Environment]::GetEnvironmentVariable('NVM_HOME', 'User'), [Environment]::GetEnvironmentVariable('NVM_HOME', 'Machine'), $env:NVM_HOME | Where-Object { $_ } | Select-Object -First 1
  $nvmLink = [Environment]::GetEnvironmentVariable('NVM_SYMLINK', 'Machine'), [Environment]::GetEnvironmentVariable('NVM_SYMLINK', 'User'), $env:NVM_SYMLINK | Where-Object { $_ } | Select-Object -First 1
  if ($existingDir -and $nvm -and (-not $nvmLink -or ($existingDir -eq $nvmLink))) {
    throw '检测到 Node.js 由 nvm 管理，请打开终端执行：nvm install lts，然后执行：nvm use lts'
  }
  $machinePath = @(([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';') | ForEach-Object { $_.TrimEnd('\') })
  $useMsi = $existingDir -and ($existingDir -ne $dest) -and ($machinePath -contains $existingDir.TrimEnd('\'))
  $kind = if ($useMsi) { 'msi' } else { 'zip' }
  $version = $null
  try {
    $index = Invoke-RestMethod "$mirror/index.json" -TimeoutSec 30
    $version = ($index | Where-Object { $_.lts -and ($_.files -contains "win-$arch-$kind") } | Select-Object -First 1).version
  } catch {}
  if (-not $version) { $version = 'v24.11.1' }
  if ($useMsi) {
    $msi = Join-Path $env:TEMP "node-$version-$arch.msi"
    Invoke-WebRequest "$mirror/$version/node-$version-$arch.msi" -OutFile $msi -UseBasicParsing
    $proc = Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/passive', '/norestart' -Wait -PassThru
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
    if ($proc.ExitCode -eq 1602) { throw '已取消升级（需要在弹出的窗口里点「是」允许安装）' }
    if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) { throw "安装程序退出码 $($proc.ExitCode)" }
    exit 0
  }
  $name = "node-$version-win-$arch"
  $staging = Join-Path $programs '.ccshift-node'
  New-Item -ItemType Directory -Force $staging | Out-Null
  $zip = Join-Path $staging "$name.zip"
  Invoke-WebRequest "$mirror/$version/$name.zip" -OutFile $zip -UseBasicParsing
  Expand-Archive $zip -DestinationPath $staging -Force
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Move-Item (Join-Path $staging $name) $dest
  Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
  # 标记：一键还原只删带这个文件的目录，客户自己装的不碰
  Set-Content (Join-Path $dest '.ccshift-installed') 'installed by ccshift'
  $npmGlobal = Join-Path $env:APPDATA 'npm'
  New-Item -ItemType Directory -Force $npmGlobal | Out-Null
  Add-UserPath $npmGlobal
  Add-UserPath $dest
} catch {
  [Console]::Error.WriteLine("Node.js 安装失败：" + $_.Exception.Message)
  exit 1
}
"#;

/// 从镜像装便携版 Git（自解压 7z，不用管理员权限），解压到 %LOCALAPPDATA%\Programs\Git。
/// 加 `cmd` 目录进 PATH，并设 CLAUDE_CODE_GIT_BASH_PATH，Claude Code 直接找到 bash.exe。
#[cfg(target_os = "windows")]
const PS_INSTALL_GIT: &str = r#"
try {
  $api = 'https://registry.npmmirror.com/-/binary/git-for-windows/'
  $release = (Invoke-RestMethod $api -TimeoutSec 30) |
    Where-Object { $_.name -match '^v(\d+\.\d+\.\d+)\.windows\.(\d+)/$' } |
    Sort-Object { [version]("$($_.name -replace '^v(\d+\.\d+\.\d+)\.windows\.(\d+)/$', '$1.$2')") } -Descending |
    Select-Object -First 1
  if (-not $release) { throw '镜像上没有找到 Git 版本' }
  $suffix = if ($arch -eq 'arm64') { 'arm64.7z.exe' } else { '64-bit.7z.exe' }
  $file = (Invoke-RestMethod $release.url -TimeoutSec 30) |
    Where-Object { $_.name -like "PortableGit-*-$suffix" } | Select-Object -First 1
  if (-not $file) { throw '镜像上没有找到便携版 Git' }
  $programs = Join-Path $env:LOCALAPPDATA 'Programs'
  $dest = Join-Path $programs 'Git'
  New-Item -ItemType Directory -Force $programs | Out-Null
  $exe = Join-Path $env:TEMP $file.name
  Invoke-WebRequest $file.url -OutFile $exe -UseBasicParsing
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  $proc = Start-Process -FilePath $exe -ArgumentList '-y', "-o`"$dest`"" -Wait -PassThru -WindowStyle Hidden
  Remove-Item $exe -Force -ErrorAction SilentlyContinue
  if ($proc.ExitCode -ne 0 -or -not (Test-Path (Join-Path $dest 'bin\bash.exe'))) { throw "解压失败（退出码 $($proc.ExitCode)）" }
  Set-Content (Join-Path $dest '.ccshift-installed') 'installed by ccshift'
  Add-UserPath (Join-Path $dest 'cmd')
  [Environment]::SetEnvironmentVariable('CLAUDE_CODE_GIT_BASH_PATH', (Join-Path $dest 'bin\bash.exe'), 'User')
} catch {
  [Console]::Error.WriteLine("Git 安装失败：" + $_.Exception.Message)
  exit 1
}
"#;

/// 只改当前用户：不需要管理员；被组策略锁住时 Set-ExecutionPolicy 报错，原样回给前端。
#[cfg(target_os = "windows")]
const PS_FIX_POLICY: &str = r#"
try {
  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
} catch {
  [Console]::Error.WriteLine("修改 PowerShell 执行策略失败：" + $_.Exception.Message)
  exit 1
}
"#;

/// 包成 .bat 内容交给 `run_tool_lifecycle_silently`（它写临时 .bat、用 `cmd /C` 无窗口执行）。
///
/// 脚本本体写进临时 .ps1：整段塞进 -EncodedCommand 会超过 cmd 单行 8191 字符的上限。
/// 命令行上只放一小段编码过的引导：读入脚本、删掉文件、执行。路径在编码内容里，
/// 用户名带中文也不经过 cmd 的代码页解析；脚本里的 `exit n` 就是进程退出码。
#[cfg(target_os = "windows")]
fn powershell_batch(script: &str) -> Result<String, String> {
    let path = std::env::temp_dir().join(format!("ccshift_{}.ps1", uuid::Uuid::new_v4()));
    std::fs::write(&path, format!("{PS_PRELUDE}{script}"))
        .map_err(|e| format!("写入脚本失败: {e}"))?;
    let quoted = path.to_string_lossy().replace('\'', "''");
    let bootstrap = format!(
        "$ProgressPreference = 'SilentlyContinue'; $p = '{quoted}'; \
         $s = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8); \
         Remove-Item -LiteralPath $p -Force; & ([ScriptBlock]::Create($s))"
    );
    Ok(format!(
        "@echo off\r\nchcp 65001 >nul\r\npowershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {}\r\n",
        powershell_encoded_command(&bootstrap)
    ))
}

// ─── macOS / Linux 脚本 ────────────────────────────────────────────────────

/// npm 全局目录能写就打印 yes。`lib/node_modules` 还不存在时看 prefix 本身。
#[cfg(not(target_os = "windows"))]
const NPM_GLOBAL_WRITABLE_PROBE: &str = r#"p=$(npm config get prefix) && { [ -w "$p/lib/node_modules" ] || { [ ! -e "$p/lib/node_modules" ] && [ -w "$p" ]; }; } && echo yes || echo no"#;

/// bash 公共开头：把一行 `export PATH=...` 写进 zsh / bash 的启动文件（已有就跳过）。
/// macOS 默认 zsh，没有 .zshrc 时也建一个。
#[cfg(not(target_os = "windows"))]
const SH_PRELUDE: &str = r#"
set -e
add_path() {
  line="export PATH=\"$1:\$PATH\" # added by ccshift"
  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    if [ -f "$rc" ] || { [ "$rc" = "$HOME/.zshrc" ] && [ "$(uname -s)" = "Darwin" ]; }; then
      grep -qsF "$1" "$rc" || printf '\n%s\n' "$line" >> "$rc"
    fi
  done
}
"#;

/// 从镜像装 Node.js：最新 LTS 的 tar.gz 解压到 ~/.ccshift/node。装在用户目录里，
/// npm 全局安装也落在这里，天然没有 EACCES。
#[cfg(not(target_os = "windows"))]
const SH_INSTALL_NODE: &str = r#"
mirror=https://cdn.npmmirror.com/binaries/node
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "不支持的系统" >&2; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo "不支持的 CPU 架构：$(uname -m)" >&2; exit 1 ;; esac
version=$(curl -fsSL --max-time 30 "$mirror/index.json" 2>/dev/null | tr '{' '\n' | grep '"lts":"' | head -1 | sed -E 's/.*"version":"(v[0-9.]+)".*/\1/' || true)
case "$version" in v[0-9]*) ;; *) version=v24.11.1 ;; esac
name="node-$version-$os-$arch"
dest="$HOME/.ccshift/node"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fSL --retry 2 --max-time 600 "$mirror/$version/$name.tar.gz" -o "$tmp/node.tar.gz" || { echo "Node.js 下载失败" >&2; exit 1; }
tar -xzf "$tmp/node.tar.gz" -C "$tmp"
rm -rf "$dest"
mkdir -p "$(dirname "$dest")"
mv "$tmp/$name" "$dest"
echo "installed by ccshift" > "$dest/.ccshift-installed"
add_path "$HOME/.ccshift/node/bin"
"#;

/// npm 全局目录不可写时改到 ~/.npm-global（写进 ~/.npmrc），并加进 PATH
#[cfg(not(target_os = "windows"))]
const SH_FIX_NPM_PREFIX: &str = r#"
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
add_path "$HOME/.npm-global/bin"
"#;

/// 一键还原：只撤销 ccshift 做过的改动。目录凭 `.ccshift-installed` 标记认；
/// npm 源 / 执行策略按 env-changes.json 里的记录还原；客户自己装的东西不碰。
/// 官网 MSI 也会把 %APPDATA%\npm 加进用户 PATH，所以这一项不删。
#[cfg(target_os = "windows")]
const PS_CLEANUP: &str = r#"
function Remove-UserPath([string]$dir) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @(($current -split ';') | Where-Object { $_ -and ($_.TrimEnd('\') -ne $dir.TrimEnd('\')) })
  [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
}
$errors = @()
$programs = Join-Path $env:LOCALAPPDATA 'Programs'
if ($resetRegistry) { try { & npm.cmd config delete registry | Out-Null } catch {} }
$node = Join-Path $programs 'nodejs'
if (Test-Path (Join-Path $node '.ccshift-installed')) {
  try { Remove-Item $node -Recurse -Force } catch { $errors += 'Node.js：' + $_.Exception.Message }
  Remove-UserPath $node
}
$git = Join-Path $programs 'Git'
if (Test-Path (Join-Path $git '.ccshift-installed')) {
  try { Remove-Item $git -Recurse -Force } catch { $errors += 'Git：' + $_.Exception.Message }
  Remove-UserPath (Join-Path $git 'cmd')
  $bash = [Environment]::GetEnvironmentVariable('CLAUDE_CODE_GIT_BASH_PATH', 'User')
  if ($bash -and $bash.StartsWith($git)) { [Environment]::SetEnvironmentVariable('CLAUDE_CODE_GIT_BASH_PATH', $null, 'User') }
}
if ($resetPolicy) {
  try { Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy Undefined -Force } catch { $errors += 'PowerShell：' + $_.Exception.Message }
}
if ($errors.Count -gt 0) { [Console]::Error.WriteLine(($errors -join "`n")); exit 1 }
"#;

/// ~/.ccshift/node 只可能是 ccshift 装的，直接删；启动文件里带 "# added by ccshift" 的行删掉。
/// 用 cat 覆盖而不是 mv：保留原文件的权限和软链接。
#[cfg(not(target_os = "windows"))]
const SH_CLEANUP: &str = r##"
if [ "$reset_registry" = 1 ]; then npm config delete registry >/dev/null 2>&1 || true; fi
if [ "$reset_prefix" = 1 ]; then npm config delete prefix >/dev/null 2>&1 || true; fi
rm -rf "$HOME/.ccshift/node"
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  if [ -f "$rc" ] && grep -q "# added by ccshift" "$rc"; then
    grep -v "# added by ccshift" "$rc" > "$rc.ccshift.tmp" && cat "$rc.ccshift.tmp" > "$rc"
    rm -f "$rc.ccshift.tmp"
  fi
done
"##;

// ─── 改动记录 ──────────────────────────────────────────────────────────────

/// ccshift 改过的全局设置，一键还原时据此撤销（目录类改动靠目录里的标记文件认）
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EnvChanges {
    pub npm_registry: bool,
    pub powershell_policy: bool,
    pub npm_prefix: bool,
}

fn changes_path() -> std::path::PathBuf {
    crate::config::get_home_dir()
        .join(".ccshift")
        .join("env-changes.json")
}

fn read_changes() -> EnvChanges {
    std::fs::read_to_string(changes_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// 记录失败不影响操作本身：最多是还原时少还原一项
fn update_changes(update: impl FnOnce(&mut EnvChanges)) {
    let mut changes = read_changes();
    update(&mut changes);
    let path = changes_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(&changes) {
        if let Err(e) = std::fs::write(&path, text) {
            log::warn!("记录 ccshift 环境改动失败: {e}");
        }
    }
}

/// ccshift 自己装的 Node.js / Git 目录（带标记文件的才算）
fn installed_dirs() -> (Option<std::path::PathBuf>, Option<std::path::PathBuf>) {
    #[cfg(target_os = "windows")]
    {
        let programs = dirs::data_local_dir().map(|dir| dir.join("Programs"));
        let marked = |name: &str| {
            programs
                .as_ref()
                .map(|dir| dir.join(name))
                .filter(|dir| dir.join(".ccshift-installed").is_file())
        };
        (marked("nodejs"), marked("Git"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let node = crate::config::get_home_dir().join(".ccshift").join("node");
        (node.is_dir().then_some(node), None)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevCleanupPreview {
    pub node_dir: Option<String>,
    pub git_dir: Option<String>,
    #[serde(flatten)]
    pub changes: EnvChanges,
}

#[tauri::command]
pub async fn preview_dev_cleanup() -> Result<DevCleanupPreview, String> {
    let (node, git) = installed_dirs();
    Ok(DevCleanupPreview {
        node_dir: node.map(|dir| dir.to_string_lossy().into_owned()),
        git_dir: git.map(|dir| dir.to_string_lossy().into_owned()),
        changes: read_changes(),
    })
}

/// 撤销 ccshift 对运行环境的改动（npm 源、执行策略、npm 目录、装的 Node.js / Git）。
/// 先卸载 Claude Code / Codex 再调这个：npm 装的 CLI 要靠 Node 卸载。
#[tauri::command]
pub async fn cleanup_dev_environment() -> Result<(), String> {
    let changes = read_changes();
    #[cfg(target_os = "windows")]
    let command_line = powershell_batch(&format!(
        "$resetRegistry = ${}\n$resetPolicy = ${}\n{PS_CLEANUP}",
        changes.npm_registry, changes.powershell_policy
    ))?;
    #[cfg(not(target_os = "windows"))]
    let command_line = format!(
        "reset_registry={}\nreset_prefix={}\n{SH_CLEANUP}",
        u8::from(changes.npm_registry),
        u8::from(changes.npm_prefix)
    );
    tauri::async_runtime::spawn_blocking(move || {
        run_script(command_line, "ccshift_env_cleanup")?;
        let _ = std::fs::remove_file(changes_path());
        Ok(())
    })
    .await
    .map_err(|e| format!("environment cleanup task join error: {e}"))?
}

// ─── 命令 ──────────────────────────────────────────────────────────────────

fn run_script(command_line: String, label: &'static str) -> Result<(), String> {
    run_tool_lifecycle_silently(&command_line, label)
}

fn dev_dependency_install_command(name: &str) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        match name {
            "node" => powershell_batch(PS_INSTALL_NODE),
            "git" => powershell_batch(PS_INSTALL_GIT),
            _ => Err(format!("不支持安装：{name}")),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        match name {
            "node" => Ok(format!("{SH_PRELUDE}{SH_INSTALL_NODE}")),
            _ => Err(format!("不支持安装：{name}")),
        }
    }
}

#[tauri::command]
pub async fn install_dev_dependency(name: String) -> Result<(), String> {
    let command_line = dev_dependency_install_command(&name)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_script(command_line, "ccshift_dependency_install")
    })
    .await
    .map_err(|e| format!("dependency install task join error: {e}"))?
}

/// Windows：放开 PowerShell 脚本限制；macOS / Linux：把 npm 全局目录改到用户目录
#[tauri::command]
pub async fn fix_dev_environment(issue: String) -> Result<(), String> {
    let command_line = match issue.as_str() {
        #[cfg(target_os = "windows")]
        "powershellPolicy" => powershell_batch(PS_FIX_POLICY)?,
        #[cfg(not(target_os = "windows"))]
        "npmPrefix" => format!("{SH_PRELUDE}{SH_FIX_NPM_PREFIX}"),
        _ => return Err(format!("不支持的修复项：{issue}")),
    };
    tauri::async_runtime::spawn_blocking(move || {
        run_script(command_line, "ccshift_env_fix")?;
        update_changes(|changes| match issue.as_str() {
            "powershellPolicy" => changes.powershell_policy = true,
            _ => changes.npm_prefix = true,
        });
        Ok(())
    })
    .await
    .map_err(|e| format!("environment fix task join error: {e}"))?
}

/// 只接受 http(s) 地址、不含空白与 shell 元字符：地址会原样拼进命令行
fn validate_registry_url(url: &str) -> Result<&str, String> {
    let url = url.trim();
    let valid_scheme = url.starts_with("https://") || url.starts_with("http://");
    let safe = url
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-._~:/?#[]@+,=%".contains(c));
    if valid_scheme && safe {
        Ok(url)
    } else {
        Err(format!("无效的 npm 源地址：{url}"))
    }
}

#[tauri::command]
pub async fn set_npm_registry(registry: String) -> Result<(), String> {
    let url = validate_registry_url(&registry)?.to_string();
    #[cfg(target_os = "windows")]
    let command_line = format!("@echo off\r\ncall npm config set registry {url}\r\n");
    #[cfg(not(target_os = "windows"))]
    let command_line = format!("npm config set registry {url}");
    let is_mirror = url.contains("npmmirror.com");
    tauri::async_runtime::spawn_blocking(move || {
        run_script(command_line, "ccshift_npm_registry")?;
        update_changes(|changes| changes.npm_registry = is_mirror);
        Ok(())
    })
    .await
    .map_err(|e| format!("npm registry task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::validate_registry_url;

    #[test]
    fn registry_url_validation() {
        assert!(validate_registry_url("https://registry.npmmirror.com").is_ok());
        assert!(validate_registry_url(" https://registry.npmjs.org/ ").is_ok());
        assert!(validate_registry_url("ftp://example.com").is_err());
        assert!(validate_registry_url("https://a.com && calc").is_err());
        assert!(validate_registry_url("https://a.com;rm").is_err());
        assert!(validate_registry_url("https://a.com|x").is_err());
    }
}
