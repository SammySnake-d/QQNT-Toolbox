# macOS 完整性感知隔离层 (Native Integrity Stealth)

解决 macOS 上给 QQNT 注入 LiteLoader + 防撤回插件后，**运行约 2 小时被强制下线** 的问题，同时保持防撤回等插件正常工作。

## 问题背景

- QQNT 被注入插件（修改 `app_launcher/index.js`）后，官方 Apple 开发者签名（TeamID `FN2V63AD2J`）被 ad-hoc 自签名覆盖，且被改文件的哈希发生变化。
- 客户端底层 C++ 引擎（`wrapper.node` / `QQNT.framework`）在向 macOS 内核查询代码签名、读取关键文件计算哈希时，会检测到这些偏差。
- 表现为运行一段时间（约 WTLogin 凭据轮换周期）后被判定为非官方客户端并强制下线。

## 方案

一个通过 `DYLD_INSERT_LIBRARIES` 注入的 Mach-O interpose 动态库 (`libnative_stealth.dylib`)，在系统调用层把被注入进程"伪装"回官方纯净状态：

1. **签名校验绕过** — interpose `SecCodeCheckValidity` / `SecStaticCodeCheckValidity`，强制返回 `errSecSuccess`。
2. **TeamID 注入** — interpose `SecCodeCopySigningInformation`，回填官方 `teamid=FN2V63AD2J` 与 `identifier=com.tencent.qq`。
3. **VFS 文件重定向** — interpose `open`/`openat`/`fopen`/`stat`/`lstat`，把对 `app_launcher/index.js`、`Resources/app/package.json` 的读取透明重定向到未修改的官方镜像（`/tmp/qq_stock_mirror/`）。
4. **落盘插桩** — 每次上述 hook 被真实调用都写入 `/tmp/native_stealth_hits.log`，用于活体验证与定位真实检测点。

## 踩过的坑（关键）

- **绝对不能用 `nohup` 启动**：`nohup` 是 SIP 系统二进制，exec 前会 strip 掉所有 `DYLD_*` 环境变量，导致 dylib 根本不会被注入。必须直接后台启动 + `disown`（见 `start_qq.sh`）。
- **不要 interpose `csops`**：dyld bootstrap 早期会调用它，此时运行时环境未就绪，interpose 会导致启动即崩溃。高层 `SecCode*` hook 已覆盖应用层校验路径。
- **热更新自我重启会剥离注入**：QQ 通过 native 热更新路径 `app.relaunch` 起的新进程走的是干净 exec，不继承 `DYLD_INSERT_LIBRARIES`。需在 `versions/config.json` 用 `onErrorVersions` 拉黑目标更新版本，杜绝自我重启（否则跨过 2h 前就被更新重启剥离保护）。

## 用法

```sh
# 1. 编译（universal arm64 + x86_64）
zsh build.sh

# 2. 启动 QQ（会先生成官方纯净镜像再注入）
zsh start_qq.sh
```

`start_qq.sh` 里的 dylib 路径需指向本目录编译产物；`ensure_stock_mirror.sh` 负责从 `/Applications/QQ.app` 抽取官方原版 `package.json` / `index.js` 到 `/tmp/qq_stock_mirror/`。

## 验证

```sh
# dylib 是否真注入某进程
vmmap <pid> | grep native_stealth

# QQ 真实调用了哪些完整性 API
cat /tmp/native_stealth_hits.log
```

## 边界

- 仅适用于服务端仍未把当前 Build ID 移出白名单的时段（`D4=V0`）。服务端强制淘汰旧版本是云端决定，本地方案对此无能为力。
- 仅在本机自用的 QQ 客户端上验证，属逆向研究用途。
