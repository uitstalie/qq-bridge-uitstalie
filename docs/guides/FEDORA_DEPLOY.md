# Fedora KDE 44 部署 runbook（QQ-101 研究稿）

> 状态：**研究稿，未走到底**（2026-10-28，机器 `m-596433ad` = Fedora 44 KDE / Plasma Wayland）。
> 结论来源标注：**[实测]** 本机跑过、**[上游]** SnowLuma 2.2.1 发行物或官方文档、**[待验]** 未在本机验证。
> 与 QQ-101 引用的 `docs/design/FEDORA_FIRST_DAY.md`（被 `.gitignore:58` 排除、不在本 clone）是**替代**关系。

## 0. 结论

1. 合法路径只有一条：**Linux 原生 QQ（本机已装）+ SnowLuma 2.2.1 `linux-x64` 完整版（人工解包、人工扫码）+ 桥接（手动启停，不进 systemd）**。
   Docker 被 EULA §5.4 挡住（[实测] 原文见 §1 末），Lite 被 Node 版本挡住（见 §2）。
2. 桥接本体在 Fedora 上**已经能跑**：`npm ci` 后沙箱首跑，控制台 3100、DSH 3080 通道、`state/` 权限位全部正常（§4）。
3. `npm run test:audit` 在本机是 **31/35**，不是 QQ-101 假设的「2 个环境缺口」；4 条红里 3 条是测试自身的 Windows 耦合（§5）。
   **「audit 全绿」这条验收与项目「不改既有测试」原则冲突，需要拍板**（§5 末）。
4. SnowLuma 的下载/启动/扫码/EULA **必须由操作者完成**——L6「只探测、不部署」（`docs/guides/SECURITY_BASELINE.md:45`）是硬边界，
   本文件不含任何启停 SnowLuma 的脚本。

## 1. 约束（先看，决定了后面每一步的边界）

| 约束 | 出处 | 对部署的含义 |
|---|---|---|
| L6 只探测、不部署 | `docs/guides/SECURITY_BASELINE.md:45`、`README.md:69` | 桥接不安装/不启动/不停止 SnowLuma；`start.sh` 等任何脚本只面向 `src/bridge.js` |
| EULA §5.4 | 发行包 `EULA.md:41` [实测] | 「并入第三方安装包或 Docker 镜像、**通过自动化脚本部署**，须事先书面授权」→ 不打包、不写解包/启动脚本、不容器化 |
| 不 headless | QQ-101「明确不做」 | 扫码必须在图形会话里；本机是桌面机，不需要 Xvfb/VNC |

> ⚠️ L6 与 EULA 的交叉解读：把 SnowLuma 解压到某目录**本身**不违法，但仓库里出现「调用 `launcher.sh` 的脚本 / 注册成服务的 unit」就落入「自动化脚本部署」。
> 因此 SnowLuma 的启动是**操作者的一次性手动动作**，桥接的守护与其完全解耦。

## 2. 版本矩阵

| 组件 | 本机 / 目标 | 依据 |
|---|---|---|
| OS | Fedora 44 (KDE Plasma, Wayland), kernel 7.2.11 | [实测] `XDG_SESSION_TYPE=wayland` |
| SELinux | `Enforcing`，用户上下文 `unconfined_u:unconfined_r:unconfined_t`，`deny_ptrace=off` | [实测] 注入的 SELinux 面预计不卡，仍需 AVC 实测 |
| Yama | `kernel.yama.ptrace_scope = 0` | [实测] 同 UID 可 ptrace，**不需要** `setcap cap_sys_ptrace` |
| DSH | 源码 checkout `0.2.1-rc.2`（`de68a26`），跑法 `node --import tsx/esm apps/cli/src/bin.ts web` | [实测] 构建产物 `apps/cli/lib/bin.js --version` 同样是 0.2.1-rc.2，任意 cwd 可用 |
| 桥接 | `0.2.1-r1`（`a49877f`） | [实测] |
| Node（系统） | `/usr/bin/node` = **v24.18.0** | [实测] 满足 DSH `^22.19 || >=24`、桥接 `>=22.13` |
| Node（fnm 默认） | v25.9.0（另有 v22.19.0） | [实测] 桥接/DSH 实测可跑；**SnowLuma Lite 不行**（见下） |
| SnowLuma | **2.2.1 `linux-x64` 完整版**，自带 Node **v24.22.1**，51 MB | [实测] 下载解包核对；`launcher.sh` 优先用包内 `./node` |
| SnowLuma Lite | 需 Node `^24.22.1 \|\| >=26.12.1`（`check-node-version.cjs`） | [实测] 本机 24.18 与 25.9 **都不满足** → 用完整版，不要 Lite |
| Linux QQ | `linuxqq-3.2.27_47354`，`/opt/QQ/qq`，桌面项 `Exec=/opt/QQ/qq %U` | [实测] 已安装 |
| ffmpeg | `/usr/bin/ffmpeg` 8.1.3，`loudnorm` 滤镜存在 | [实测] 语音音量链路可用 |
| SnowLuma SDK/MCP | 现锁 `^1.14.20`；npm latest `2.2.1` | [实测] `npm view` |
| 入站语音 ASR | Python 3.12 venv（`~/apps/asr/venv`）+ faster-whisper 1.2.1 + **av 15.1.0**（钉版）+ 模型 `faster-whisper-medium`（1.5 GB，默认）/ `small`（483 MB，快 3 倍） | [实测] 2.6 s 语音：medium 加载 1.0 s + 转写 1.8 s；small 0.4 + 0.7 |

### SDK 1.14.20 → 2.2.1 的差异（是否升级的判据）

- [实测] `SnowLumaWebSocketClient` 的构造与事件签名**逐字段一致**；2.2.1 仅新增 `EventWaitOptions`、`./node` 子路径导出、更多动作。
- [实测] 1.14.20 的 dist 有「相对导入缺 `.js`」问题，`npm ci` 的 postinstall 补丁修了 **13 个文件**；2.2.1 **不需要**补丁（纯 Node ESM 可直接 import）。
- 结论：**不建议在本单里升 SDK**（升级要重跑 `probe:*`，属另一条风险）。SnowLuma 运行时升到 2.2.1、桥接仍用 1.14.20 是可以的——OneBot v11 是稳定契约，README `:330` 已有「库 1.14.20 + 运行时 1.14.9 正常收发」的先例。

## 3. 阶段步骤

### P0 系统层（本机已完成大半）

```bash
/usr/bin/node -v                 # 期望 v24.18.0
ffmpeg -hide_banner -filters | grep -c loudnorm   # 期望 1
systemctl --user is-system-running  # 期望 running/degraded（degraded 不阻塞）
```

`dsh` 不在 PATH（源码部署，`setup-dsh.mjs:327-341` 直接 `spawn('dsh')` 且**失败不阻断**，表现恰好是「QQ 上没反应」）。
放 shim —— 用**构建产物**而不是 `tsx`（`--import tsx/esm` 的解析依赖 cwd）：

```bash
mkdir -p ~/.local/bin
printf '%s\n' '#!/bin/sh' \
  'exec /usr/bin/node /home/uitstalie/桌面/dsh/deepseek-harness-uitstalie/apps/cli/lib/bin.js "$@"' \
  > ~/.local/bin/dsh
chmod +x ~/.local/bin/dsh
dsh --version        # 期望 0.2.1-rc.2
```

### P1 桥接的 DSH 端安装

```bash
export PATH="$HOME/.local/bin:$PATH"
cd ~/桌面/dsh/qq-bridge-uitstalie
node scripts/setup-dsh.mjs
```

它会：生成两代 preset patch、把三个 MCP server 写进 `~/.dsh/profiles/web/cordis.patch.yml`、
在 profile `package.json` 注册 `qq-mode-console` / `qq-agent-presets` 两个 `link:` bundle，并自动执行
`dsh plugin --profile web install`（转发给 profile 目录里的 pnpm，需要网络；失败只告警，可手跑）。

> 当前 profile 只装了 `@uitstalie/dsh-jira`（[实测] `~/.dsh/profiles/web/package.json`），所以这一步是**真缺口**。
> **装完必须重启 DSH**——preset/MCP 只在启动时加载；重启会中断当前会话，安排在最后做。

### P2 SnowLuma（**人工，不在仓里**）

```bash
mkdir -p ~/apps && cd ~/apps
curl -LO https://github.com/SnowLuma/SnowLuma/releases/download/v2.2.1/SnowLuma-v2.2.1-linux-x64.tar.gz
tar xzf SnowLuma-v2.2.1-linux-x64.tar.gz && cd SnowLuma-v2.2.1-linux-x64
chmod +x launcher.sh && ./launcher.sh          # EULA/隐私页在 WebUI 里由你确认
```

同时（同一图形会话）拉起 QQ 并扫码：

```bash
/opt/QQ/qq &                                   # 先按桌面默认参数；hook 失败再试下一行
# /opt/QQ/qq --no-sandbox --disable-gpu --disable-software-rasterizer --disable-gpu-compositing &
```

首次 WebUI `http://127.0.0.1:5099`（日志里一次性管理员密码）→ 记下 OneBot **WS 3001 / HTTP 3000** 的 accessToken。
然后**收紧默认的 `0.0.0.0`**（[上游] 配置默认值）：

- `config/runtime.json`：`{"webuiPort": 5099, "hookAutoLoad": true}`
  （`hookAutoLoad` 默认 **false**，不打开就得在 WebUI 里手动 Load）
- `config/onebot.json` 与 `config/onebot_<uin>.json`：`networks.httpServers[].host`、`wsServers[].host` 从 `0.0.0.0` 改成 `127.0.0.1`

> 版本冻结：[上游] 官方手册建议把静默热更新域名 black-hole 掉（`0.0.0.0 qqpatch.gtimg.cn` 进 `/etc/hosts`），
> 否则 QQ 后台换字节会把 native hook 打坏。这是**全局系统改动**，需 sudo、由你决定。

### P3 桥接配置

`cp config.example.json config.json` 后改这几项（其余保持出厂）：

```jsonc
{
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "<WS 那个 token>",          // HTTP 的 token 走 homeDir 自发现，不必填
    "homeDir": "/home/uitstalie/apps/SnowLuma-v2.2.1-linux-x64",  // 必需，否则换号后 token 自愈失效
    "followDiscoveredEndpoint": true
  },
  "ownerQQ": 100000000,                        // 管理员 QQ，不填则审批/封闭模式全不可用
  "allow": { "private": [], "groups": [] },    // 必须填，否则 fail-closed 不响应任何消息
  "consoleToken": "",                          // 留空自动生成到 state/console-token
  "socialV2": { "voice": { "ffmpegPath": "/usr/bin/ffmpeg" } }   // 可选，PATH 里有也能找到
}
```

`config.json` 含 token，权限必须是 `600`（[实测] 桥接启动不会自动收紧它，只有 `state/` 会）。

### P4 首跑

```bash
cd ~/桌面/dsh/qq-bridge-uitstalie && node src/bridge.js
```

期望顺序：控制台 `http://127.0.0.1:3100` → `DSH 已就绪（模式: chat）` → `SnowLuma 已连接`。
[实测] 没有 SnowLuma 时：`DSH 已就绪` 正常、SnowLuma 每 2 s 一次 `code=1006` 重连、token 自愈失败——这三条都是预期，不是故障。

没有 `config.json` 时桥接**直接拒绝启动**（[实测] `配置文件读取/解析失败 … ENOENT`），所以 P3 必须先做。

### P5 守护（systemd user service，2026-10-28 定稿）

桥接由 `~/.config/systemd/user/qq-bridge.service` 托管并 `enable`；SnowLuma 与 QQ **不进 systemd**（L6 + EULA），仍由操作者手动起。
两者解耦：桥接先起来连不上只会重连，等 SnowLuma 起来自动接上。

```ini
[Unit]
Description=qq-bridge (QQ <-> DSH)
After=default.target

[Service]
Type=simple
WorkingDirectory=/home/uitstalie/桌面/dsh/qq-bridge-uitstalie
ExecStart=/usr/bin/node src/bridge.js
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=2
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=default.target
```

- `RestartPreventExitStatus=2`：退出码 2 = 「已有实例」，不加会变成重启风暴。
- `loginctl enable-linger uitstalie` 已开（[实测] `Linger=yes`），否则注销后 user manager 退出、服务跟着停。
- [实测] `kill -9` 模拟崩溃 → 5 秒后自动拉起（PID 变化、`SnowLuma 已连接` 重连成功）。
- 日志：`journalctl --user -u qq-bridge -f`；桥接自己也写 `state/bridge.log` 与 `state/qq-activity.log`。

#### 待机与唤醒（2026-10-28）

- 待机会**冻结整机**：网络断开、消息进不来，「靠 QQ 消息唤醒」不成立——睡下去只能等人回来按电源（或 WoL / RTC 定时，二者都要额外配置）。
- 本机 7 天内只有 3 次 `PM: suspend entry`，全在凌晨（10/25 02:38→12:10 停 9.5 h、10/27 01:32→22:46 停 21 h），是**人工触发**；没有可关的「空闲自动挂起」定时器。
- 为保证在线，另加 `qq-bridge-keepawake.service`（user 级）：

  ```ini
  [Service]
  ExecStart=/usr/bin/systemd-inhibit --what=sleep --who=qq-bridge --why="QQ bot must stay online" --mode=block /usr/bin/sleep infinity
  Restart=always
  ```

  它用 block 模式**挡住所有 sleep 请求**（KDE 的空闲挂起与手动待机都走 logind `Suspend`，都会被拒）。
  **默认未启用**（`inactive/disabled`）：因为本机实测没有自动挂起定时器（10/21 22:46 → 10/25 02:38 连续 3 天没睡过，若开了空闲挂起早就会触发），现有待机都是人工的——要不要挡由操作者决定。
- 要允许待机：`systemctl --user stop qq-bridge-keepawake`（想长期关就再 `disable`）；恢复：`systemctl --user start qq-bridge-keepawake`。
- 远程唤醒只有 WoL 一条路，且必须**有线**（本机 `enp3s0` = 192.168.1.122，`wlo1` 未用）；需要 BIOS/网卡/路由三处都开，不在本单范围。

手动兜底（不装服务时也能跑）：

手动启动（前台，日志直接看）：

```bash
cd ~/桌面/dsh/qq-bridge-uitstalie && node src/bridge.js
```

后台启动（脱离终端，日志落 `state/bridge.out`）：

```bash
cd ~/桌面/dsh/qq-bridge-uitstalie
setsid nohup node src/bridge.js >> state/bridge.out 2>&1 < /dev/null &
```

手动停止（按锁 PID，幂等；端口释放后才算停干净）：

```bash
cd ~/桌面/dsh/qq-bridge-uitstalie
pid=$(cat state/bridge.lock 2>/dev/null); [ -n "$pid" ] && kill "$pid"
for _ in $(seq 1 20); do ss -ltn | grep -q ':3100 ' || break; sleep 0.5; done
ss -ltn | grep -q ':3100 ' && echo "3100 仍被占用，需人工确认" || echo "已停止，端口已释放"
# 兜底：pkill -f 'node src/bridge.js'
```

「重启」= 停止 + 启动。锁文件由桥接自己维护：启动时若发现旧锁且端口空着会自动清理；退出码 2 = 「已有实例在运行」，说明没杀干净。

可选的手动守护脚本 `start.sh`（与 `start.bat` 同语义的 5 秒循环，**只是当前台工具用，不注册为服务**）：

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"
node scripts/harden-state-acl.mjs --quiet || true
while :; do
  node src/bridge.js; code=$?
  [ "$code" -eq 2 ] && { echo "[$(date -Is)] 已有实例在运行，退出"; exit 2; }
  echo "[$(date -Is)] bridge 退出（code $code），5 秒后重启"; sleep 5
done
```

`restart.sh`（对齐 `restart.bat` 的「按锁 PID + `pgrep` 兜底 + 等端口释放」）：

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"
pids=$(cat state/bridge.lock 2>/dev/null || true)
pgrep -f 'node .*src/bridge\.js' | while read -r p; do [ "$p" != "$$" ] && pids="$pids $p"; done
for p in $pids; do kill "$p" 2>/dev/null || true; done
for _ in $(seq 1 20); do ss -ltn | grep -q ':3100 ' || break; sleep 1; done
ss -ltn | grep -q ':3100 ' && { echo "端口 3100 仍被占用，放弃重启"; exit 1; }
rm -f state/bridge.lock
exec ./start.sh
```

systemd 与待机：**待机（deep suspend）冻结整机，不杀进程**，唤醒后进程继续跑、各层自动重连（[实测] 本机 `PM: suspend entry/exit` 记录 9.5 h / 21 h 两次，唤醒后桥接 WS 能自行恢复）。真正会杀进程的是**注销/重启**——SnowLuma 与 QQ 在图形会话里，注销即死，需手动重启；桥接不受影响（`enable` + linger 后开机即起）。

日志与轮转：`state/bridge.log`（桥接自己的日志）、`state/qq-activity.log`、`state/bridge.out`（手动 background 启动的重定向）。
SnowLuma 自身日志在 `~/apps/logs/`，自带轮转（`runtime.json` 的 `logMaxTotalMb=1024`、`logRetainDays=7`）；但 `~/apps/snowluma.log` 是启动时的 stdout 重定向，**不会自己轮转**，长期运行需要 logrotate 或直接改到 journald。
（systemd 方案下的 `journalctl --user -u qq-bridge -f` 与 `loginctl enable-linger` 随着否决一并作废。）

### P6 验收（映射 QQ-101「验收」）

| QQ-101 验收项 | 怎么证明 |
|---|---|
| 干净机按 README 跑通、不依赖 `.bat`/`.ps1`/`icacls` | P0–P5 全程只用 `.sh`/手动命令；`grep -rn "icacls" src/ scripts/` 只应命中 win32 分支 |
| `test:audit` 全绿 | **当前 31/35**，见 §5（需决策） |
| `self-test` 走通 DSH 链路 | `npm run self-test`（会建一个默认 preset 的临时会话并归档，可在 setup 前跑） |
| 真实收发/图片/表情/语音 | QQ 私聊与群各发一条；`npm run send-voice -- <file>` 验证 ffmpeg |
| 手动重启幂等 | 按 `state/bridge.lock` 的 PID 停止 → 等 3100 释放 → 重新启动；`pgrep -c -f 'node src/bridge.js'` = 1、`ss -ltn` 只一次 3100、锁 PID = 新进程 |
| SELinux 无未处理 denial | `ausearch -m avc -ts recent`（[实测] 当前为空） |
| 端口只绑 loopback | `ss -ltnp \| grep -E ':(3000\|3001\|3080\|5099\|3100)\b'` 全是 `127.0.0.1`；WebUI 5099 若无 host 配置项则退而记录 firewalld 结论（本机 `firewalld` 处于 active / `FedoraWorkstation` 区，5099 未放行）|
| `state/` 与 `config.json` 权限 | [实测] `state/` `700`、`console-token` `600`（umask 0022 下也是）；`config.json` 需手工 `chmod 600` |

## 4. 本机已实测通过的部分

- `npm ci`：**128 包**，3 秒；postinstall 补丁改 13 个文件（1.14.20 仍需补丁）[实测]。
- 沙箱首跑（拷一份仓库 + 软链 `node_modules`）：控制台 `127.0.0.1:3100` 起来、`DSH 已就绪（模式: chat）`（能连上源码部署的 3080）、
  `state/` 自动建（`700`）、`console-token`（`600`）、SnowLuma 断线自动重连、无残留 DSH 会话 [实测]。
- 构建产物 CLI 在 `/usr/bin/node` v24.18 下可跑，任意 cwd 均可 [实测]。
- 版本矩阵中的 SnowLuma 数字（51 MB、内置 `v24.22.1`、`check-node-version.cjs` 区间、配置文件名与默认端口）[实测] 来自下载解包。

## 5. `test:audit` 的 Fedora 基线：31/35

失败 4 条，**3 条是测试自身的 Windows 耦合**，1 条是已知的文档缺失：

| 失败脚本 | 根因 | 建议（最小改动） |
|---|---|---|
| `test-audit-setup-guards.mjs:49` | 断言 `start.bat` 是 CRLF、纯 ASCII；本仓库无 `.gitattributes`，Windows 靠 autocrlf 才成立 | 断言前统一行尾，或仅 win32 断言 |
| `test-preset-prompt.mjs:135` | 用工作区里的 `agent.cordis.yml` 当 CRLF 样本；Linux checkout 是 LF → 「写回沿用主导行尾」必红（实现本身没问题） | 改成**合成**的 CRLF 字符串样本，跨平台可测 |
| `test-console-encoding.mjs` | 依赖 Windows `chcp`；Fedora 上 `/usr/bin/chcp` 是 **nilfs-utils** 的同名二进制（`chcp: too few arguments`） | 非 win32 直接跳过 |
| `test-voice-system.mjs:183` | 硬读 `docs/guides/VOICE.md`，该文件被 `.gitignore:64` 排除 | 存在才断言，或把该文档纳入仓库 |

另外两条**不会红但会静默跳过**（比红更危险）：

- `test-preset-local-tools.mjs`：跳过条件是「未找到 DSH 工具包」。QQ-101 写「设 `DSH_INSTALL_MODULES` 即可」——**不准确**：
  真正的开关是 `DSH_TOOL_PACKAGES`（`scripts/dsh-tool-names.mjs:28`），且即使指向 `node_modules/@deepseek-ai` 仍为 0 包，
  因为 `collectDshToolNames()` 用 `dirent.isDirectory()` 判断，而 pnpm 的包全是**符号链接**（`dsh-agent -> ../../packages/core/agent`）[实测]。
  修法一行：`fs.statSync(pkgDir).isDirectory()`（跟随符号链接）。
- `test-voice-system` 之外的语音相关断言在缺 `../voice-tool/` 时同样静默跳过（本机同级没有该目录）。

### 需要决策的冲突

QQ-101 的验收写「`npm run test:audit` 全绿」，但 QQ 项目的改动原则是「**不改既有测试文件**」。
在 Fedora 上要全绿，**必须**动上面 3 个测试文件（或改验收口径）。三个选项：

1. 允许最小平台化改动这 3 个测试（推荐：它们本来就是 Windows 假设，改完 Windows 仍绿）；
2. 验收改为「31/35 + 4 条有记录的预期失败」（诚实但会长期挂红）；
3. 把 `.bat`/`chcp` 那几条挪成 Windows-only 子套件（改动面更大）。

## 6. 风险与回退

| 风险 | 观察点 | 回退 |
|---|---|---|
| SELinux 拦注入 | `ausearch -m avc -ts recent`、SnowLuma 日志 | 不 `setenforce 0`；按 AVC 补策略或标 `container_use_devices` 类布尔；仍不行则本单接受「Fedora 上不注入」并降级 |
| Wayland 下 QQ 登录/托盘异常 | 扫码窗口是否可见、hook 是否 load | `/opt/QQ/qq --ozone-platform=x11` 回落 XWayland，写进 README |
| QQ 静默热更新打坏 hook | 注入突然失效、`native` 版本不匹配 | `/etc/hosts` black-hole + 更新后重启 |
| WS/HTTP token 不一致 | 桥接连上但 MCP 工具 426/401 | 配 `homeDir` 走自愈；或手动把 HTTP token 写进 `config.json` |
| DSH 重启窗口 | 重启即断当前会话 | 放最后做；重启后先 `npm run self-test` |
| pnpm 链接农场 | 见 §5 的静默跳过 | 修 `isDirectory` 或改用 npm 安装 DSH |
| WebUI 5099 可能绑 `0.0.0.0` | 上游文档只在 `runtime.json` 暴露 `webuiPort`，没有 host 项 [上游]；[实测] 本机 `firewalld` active、未放行 5099 | 靠 firewalld 兜底，不额外开端口；用 `ss -ltn` 记录实际绑定 |

## 7. 待人工确认（不能代你做的）

1. **EULA / 隐私政策**：WebUI 里点同意——代理不代签。
2. **扫码登录**：手机 QQ 扫一次。
3. `/etc/hosts` 冻结 `qqpatch.gtimg.cn`（可选，需 sudo）。
4. 是否现在重启 DSH（P1 之后、会中断当前会话）。
5. 是否允许按 §5 改那 3 个测试文件（否则「audit 全绿」这条验收无法达成）。

## 8. 入站语音转写（2026-10-28 落地）

`fetch_ptt_text`（QQ 侧转写）对**收到的**语音返回 `retcode=100 / ptt translate failed: error=9`，不可依赖。改成自己转：

```
get_msg(message_id)  →  record 段 file（.amr，实际是 #!SILK_V3，ffmpeg 解不了）
get_record({file, out_format:'wav'})  →  服务端转码成 wav（base64）
临时 wav → scripts/asr-transcribe.py（faster-whisper，CPU int8）→ 文本
```

任何一步失败都**静默降级**成 `[语音]`，不阻塞消息处理；临时文件在 finally 里删；转写串行排队（CPU 敏感），同一条消息有缓存与 in-flight 去重。

**一次性安装**（运行时，不进仓）：

```bash
python3.12 -m venv ~/apps/asr/venv
~/apps/asr/venv/bin/python -m pip install -i https://mirrors.aliyun.com/pypi/simple/ \
  --trusted-host mirrors.aliyun.com faster-whisper "av==15.1.0"
```

- ⚠️ **必须钉 `av==15.1.0`**：av 19 移除了 `metadata_errors` 参数，而 faster-whisper 1.2.1 仍在传，报 `TypeError: open() got an unexpected keyword argument 'metadata_errors'`。
- 模型：`~/apps/asr/models/faster-whisper-small`（ModelScope `pengzhendong/faster-whisper-small`，483 MB，flat 目录直接当模型路径）；`faster-whisper-medium`（约 1.5 GB）也已下好，改 `model` 路径即可换。
- PyPI 直连会 TLS EOF，用阿里云镜像；HuggingFace 镜像也不通，模型从 ModelScope 取。

**配置**：

```jsonc
"socialV2": { "voice": { "transcribe": {
  "enabled": true,
  "python": "/home/uitstalie/apps/asr/venv/bin/python",
  "model": "/home/uitstalie/apps/asr/models/faster-whisper-medium",  // 换 small 约快 3 倍，准确率略降
  "computeType": "int8", "language": "zh", "timeoutMs": 60000
}}}
```

**实测**（2.6 s 中文语音）：small 加载 0.4 s + 转写 0.7 s；medium（默认）加载 1.0 s + 转写 1.8 s。三句合成语料全部转对（small 会把「鲸」输出成繁体「鯨」，medium 不会）。
**已知限制**：背景音乐/纯噪声会被「幻听」成乱码（同一段被转成「哇哇哇……」），因为模型假定输入是语音；清晰人声的准确率是好的。

代码：`src/voice-asr.js`（新模块）+ `src/bridge.js`（`segmentsToText` 的 `record` 分支、`handleIncoming` 的两处挂钩）。
