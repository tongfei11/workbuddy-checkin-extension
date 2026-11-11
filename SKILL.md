---
name: workbuddy-checkin
description: WorkBuddy 每日积分自动签到。自动解密本地登录令牌，调用官方签到 API 完成每日积分领取（100 积分/天，连续第 7 天 1000 积分），并支持配置定时任务。触发词：WorkBuddy 签到、每日积分、check-in、credits。
version: "1.4.6"
license: MIT
---

# WorkBuddy 每日积分签到

自动领取 WorkBuddy 每日积分（100 积分/天，连续第 7 天 1000 积分）。
全流程在本机完成：读取本地登录态 → 调用腾讯官方签到接口。无后端服务。

## 原理

1. WorkBuddy 桌面端登录后，会在本地保存登录态。**v5.3.8+ 的新版桌面端**改为 JSON 文件：
   - macOS：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`
   - 结构 `{ account, auth: { accessToken, refreshToken, expiresAt, ... }, accounts }`，桌面端临近过期会自动刷新，纯 Node 即可读取 `auth.accessToken`。
2. **更新版桌面端已启用「静态加密登录态」**：同一文件其实还在，但 `auth.accessToken` 不再是字符串，而是 AES-256-GCM 信封 `{ "$wbEncrypted": 1, "envelope": "<base64>" }`。
   - 密钥由桌面端原生模块在运行时注入（`~/.workbuddy/keyblob` 里只存被 protector key 包裹的 master key，protector key 载荷磁盘上无明文），**外部脚本无法解出令牌**——这是上游有意为之。
   - 处理方式：脚本检出该形态后以退出码 7 明确报错，并改用**显式令牌源**（`WB_CHECKIN_TOKEN` 环境变量 / `~/.workbuddy-checkin/token`，见下）。令牌有效期约 30 天（`expiresIn=2592000`），过期后重新提供一次。
   - 若上游将来改回明文或开放导出，本脚本无需改动即可恢复自动读取（明文分支始终优先探测，显式令牌源始终最高优先）。
3. **旧版 WorkBuddy/CodeBuddy** 仍把 auth session 用 Electron `safeStorage` 加密存于 `state.vscdb`；新版明文文件缺失时回退到此路径，用 Electron 运行时执行 `safeStorage.decryptString()` 解密（macOS 命中钥匙串；Windows/Linux 走 DPAPI/keyring）。
4. 运行时策略：**Node 优先**（读新版明文文件，无需 Electron），缺失时回退 Electron（解旧版 `state.vscdb`）。
5. 调用腾讯官方签到 API：
   - 查状态：`POST https://copilot.tencent.com/v2/billing/meter/checkin-status`
   - 执行签到：`POST https://copilot.tencent.com/v2/billing/meter/daily-checkin`
   - 认证：`Authorization: Bearer <accessToken>`，并按桌面端 `buildHeaders` 附带 `X-User-Id: <account.uid>`；有 `auth.domain` 时加 `X-Domain`，企业账号另加 `X-Enterprise-Id` / `X-Tenant-Id`
   - 兼容说明：`checkin.ps1` 走上述 `/v2/` 全量签名（对齐桌面端）；`checkin.sh` 仍走不带 `/v2/` 前缀、仅 `Authorization` 的旧写法。**两种写法实测均返回 200**（见 CHANGELOG 1.0.3 的验证矩阵），网关当前未强制 `/v2/` 或 `X-User-Id`；对齐桌面端属前向兼容加固，不是修复 401 的必要条件
6. 脚本幂等：先查状态（命中即跳过）；`daily-checkin` 返回 `code=10001`（今天已签到）同样视为成功，避免重复请求被误报为失败。

> ⚠️ v5.3.8 实测 `checkin-status` 的 `today_checked_in` 字段不可靠（签到成功后仍可能为 `false`）。因此幂等性主要靠 `daily-checkin` 的 `code=10001` 兜底。

兼容旧版应用名 `CodeBuddy`（仅旧版 `state.vscdb` 分支需要，macOS 需设环境变量 `WB_CHECKIN_APP_NAME=CodeBuddy`）。

## 文件结构

```
workbuddy-checkin/
├── SKILL.md
├── references/
│   └── dependencies.md         # 依赖清单与平台差异
├── extension/                  # 浏览器扩展（MV3，推荐用法，见下）
│   ├── manifest.json
│   ├── background.js           # 定时 / 端点探测 / 重试 / 通知 / 日志
│   ├── lib.js                  # 纯逻辑（可 Node 单测）
│   ├── page-bridge.js          # 页面上下文通道（跨站 Cookie 兜底）
│   ├── popup.*  options.*
│   └── icons/
├── tools/
│   ├── token-login.js          # 令牌获取页（127.0.0.1 + 书签脚本，走网页端登录）
│   └── test-extension.mjs      # 扩展逻辑测试（72 项，无需浏览器）
└── scripts/
    ├── decrypt-token.js        # 解密令牌（跨平台）
    ├── checkin.sh              # macOS / Linux / Git Bash
    ├── checkin.ps1             # Windows PowerShell
    ├── setup.sh                # macOS / Linux 一键安装
    └── setup.ps1               # Windows 一键安装
```

`logs/` 目录运行后自动创建，存放签到日志。

## 依赖

### 系统依赖

| 依赖 | 用途 | 安装方式 |
|------|------|----------|
| WorkBuddy 桌面端（已登录） | 提供本地登录态（v5.3.8+ 明文文件 / 旧版 `state.vscdb`） | 官网下载，必须登录过至少一次 |
| Node.js（推荐 20+，v5.3.8+ 主路径必需） | 读取新版明文登录态、解析 JSON | nodejs.org 下载，或系统包管理器 |
| curl（macOS/Linux 自带）/ curl.exe | 调用签到 API | Windows 10 1803+ 自带 |
| Electron 运行时（≥ 30，推荐 37） | **仅旧版** `state.vscdb` 分支解密令牌用 | 仅旧版账户需要，运行 `scripts/setup.sh` 或 `setup.ps1` |

> v5.3.8+ 用户：装好 Node.js 并登录桌面端即可直接签到，**无需安装 Electron**。Electron 仅用于尚未迁移到新版明文存储的旧版 WorkBuddy/CodeBuddy 账户。

### 开箱即用 vs 需安装

- **开箱即用（v5.3.8+）**：已装 WorkBuddy 桌面端并登录 + 系统已有 Node.js → 直接运行签到脚本。
- **需安装 Node.js**：提示「未找到 Node」时，到 nodejs.org 安装，或用 `WB_CHECKIN_NODE=<path>` 指定。
- **旧版账户需 Electron**：使用旧版 WorkBuddy/CodeBuddy（`state.vscdb`）且提示「未找到 Electron」时，执行：

  ```bash
  # macOS / Linux
  bash scripts/setup.sh
  # Windows（PowerShell）
  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
  ```

### 可选 / 回退依赖

| 依赖 | 缺失时行为 |
|------|------------|
| Electron 运行时 | 仅旧版 `state.vscdb` 账户需要；v5.3.8+ 新版明文路径不需要 |
| Node.js 内置 `node:sqlite`（Electron 37 / Node 22+ 自带） | 旧版分支自动回退到 `python3` 读取 sqlite |
| `python3` | sh 版 JSON 解析降级为 `unknown`，签到请求仍会执行 |
| `npm`（仅旧版 setup 首次安装 Electron 用） | 手动放置 Electron 后用 `WB_CHECKIN_ELECTRON=<path>`（sh）/ `-ElectronPath <path>`（ps1）指定 |

完整依赖说明见 `references/dependencies.md`。

## 浏览器扩展（v1.1.0+，最省事的用法）

`extension/` 是标准 MV3 扩展，**不需要 Node、不需要令牌、不需要命令行**——直接复用浏览器里
已登录的 WorkBuddy 网页版登录态。

安装：`chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选 `extension/`。

| 能力 | 说明 |
|---|---|
| 定时 | `chrome.alarms`，可配每天触发时间 + 0~N 分钟随机延迟（默认 09:00 + 0~10） |
| 日志 | 全部落 `chrome.storage.local`，弹窗看最近 10 条，设置页可导出 `.log` / 复制 / 清空 |
| 失败提醒 | 系统通知；未登录时立刻提醒并给「去登录」「已登录，重试」两个按钮 |
| 重试 | 网络/5xx：2 次 × 30 分钟；未登录：4 次 × 30 分钟轮询（登录后自动接上当天） |
| 角标 | `✓` 已领取 / `!` 失败或未登录 |
| 通道 | 直连 → 若 401 则自动切「页面上下文」（开一个后台标签页发同源请求，用完立即关闭） |
| 任务中心（v1.2.0+） | 只调接口，**不执行任务里的 `jumpUrl` 深链**（否则浏览器会弹「是否打开 WorkBuddy」，需人工取消）； `GET /v2/activity/growth/tasks` 拉清单；`POST /activity/growth/tasks/accept {task_codes}` 接受；`POST /activity/growth/tasks/{code}/claim` 领取已完成任务。状态字段是 **`acceptStatus`**（camelCase）；`taskType=auto/beginner` 的前端不调 accept |
| 连登兑换（v1.3.0+） | `GET /activity/growth/streak` → 连登天数 / 补登卡余额 / `tier_7d_status`；`POST /activity/growth/redeem {tier, client_token}`（7d/14d/28d，补登卡来自 7 天档） |
| 补登卡（v1.3.0+） | `GET /activity/growth/heatmap` 找 `state=broken` 的当月日期 → `POST /activity/growth/makeup-cards/use {target_date}`；**必须先兑换拿卡**，卡为 0 不请求地图 |
| 猫猫循环（v1.4.0+） | 猫猫是**4 小时一轮**（可反复派），所以派出去后按服务端返回的 `arrive_at` 排一次回程检查；到点领奖→立刻再派→再排下一趟。`daily_limit_reached` 或「已达上限」= 今日到此为止，撤掉闹钟 |
| 猫猫旅行（v1.2.0+） | 派遣参数 `{location_id}` 必须**保留原始类型**（id 是数字就发数字；转成字符串会被判 `invalid request`——实测踩过）； `GET .../buddy/travel/status` → 有奖 `POST .../buddy/travel/claim`，在家 `POST .../buddy/travel/depart {location_id}`（地点取自 `.../travel/config`） |

为什么需要页面上下文兜底：扩展后台的 `fetch` 是**跨站请求**，WorkBuddy 登录 Cookie 为 `SameSite=Lax`，
浏览器不会带给跨站请求，直连会稳定 401。`page-bridge.js` 注入到 `www.workbuddy.cn` 页面里发同源请求解决此问题。

**两套计数别混**：签到接口的 `streak_days`（**全年活跃天数口径**，仅展示、不参与任何判断）与成长计划的 `streak.days`（活跃地图口径，完成一次对话才计入）是两个活动，数字对不上是正常的。

**日志风格**：短、无括注。解释性说明放文档，不塞进日志行。

**成长体系的顺序**：任务 → 猫猫 → 兑换 → 补登。补登卡只能从「连登兑换」的 7 天档拿到，所以兑换一定在补登之前。

**成长体系的边界**：只做「领取」与「接受」，**不伪造完成状态**（服务端校验任务是否真完成，没做完一律拒绝）；因此任务本身仍要人工做一次。任务中心/猫猫任何失败只记 warn，不影响签到，也不触发重试。

接口前缀不对称，照抄前端即可：任务清单 `/v2/activity/growth/tasks`，领取 `/activity/growth/tasks/{code}/claim`（无 `/v2`）。

局限：定时只在浏览器运行时触发；浏览器完全退出后不会跑（下次启动补跑当天）。

## 快速开始

macOS / Linux：
```bash
bash scripts/setup.sh     # 检测运行时并验证令牌链路（v5.3.8+ 用 Node，旧版才需 Electron）
bash scripts/checkin.sh   # 立即签到一次（验证）
```

Windows（PowerShell）：
```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
powershell -ExecutionPolicy Bypass -File scripts\checkin.ps1
```

前提：本机已安装并**登录** WorkBuddy 桌面端；系统已安装 Node.js（v5.3.8+ 主路径）。

> **新版桌面端（静态加密登录态）必须显式提供一次令牌**，推荐用令牌获取页：
> ```bash
> node tools/token-login.js
> ```
> 本机打开 `http://127.0.0.1:8777` 页面 → 点开 <https://www.workbuddy.cn/app> 登录 → 把「WB 取令牌」拖到书签栏 → 回 WorkBuddy 页面点该书签。
> 书签会确认登录态、**顺手领掉当日签到**，并把凭据写入 `~/.workbuddy-checkin/token`（权限 600，约 30 天有效）。
> 拿不到可复用令牌时（网页版可能用 httpOnly Cookie），页面会说明，可退回手动：
> `bash scripts/setup.sh --from-clipboard`（或 `--token <accessToken>`；Windows：`setup.ps1 -Token <accessToken>`）。
> **桌面端没有「开发者工具」菜单**，手动取令牌要在网页版 <https://www.workbuddy.cn/app> 按 F12，详见下方「排错」。

## 设置定时任务

电脑非全天开机时，建议配置多个时间点补签（脚本幂等，重复运行无副作用）。推荐 `09:00 / 12:00 / 15:00 / 18:00 / 21:00` 各尝试一次，只要电脑在任一时间点开机就能签上。

### macOS / Linux（crontab）
```bash
crontab -e
0 9,12,15,18,21 * * * /path/to/scripts/checkin.sh >> /path/to/logs/checkin.log 2>&1
```

### Windows（任务计划程序）
```powershell
schtasks /Create /TN WorkBuddyDailyCheckin /TR "powershell -ExecutionPolicy Bypass -File C:\path\checkin.ps1" /SC DAILY /ST 09:00 /F
schtasks /Create /TN WorkBuddyDailyCheckin2 /TR "powershell -ExecutionPolicy Bypass -File C:\path\checkin.ps1" /SC DAILY /ST 12:00 /F
# （schtasks 单任务只支持一个 /ST，多时间点需建多个任务）
```

### macOS launchd（长期后台）

创建 `~/Library/LaunchAgents/com.user.workbuddy-checkin.plist`，`StartCalendarInterval` 用数组配置多时间点：
```xml
<key>StartCalendarInterval</key>
<array>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict>
  <dict><key>Hour</key><integer>15</integer><key>Minute</key><integer>0</integer></dict>
  <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
  <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>0</integer></dict>
</array>
```
然后 `launchctl load ~/Library/LaunchAgents/com.user.workbuddy-checkin.plist`。

### 在 WorkBuddy 内（Agent 自动化）

WorkBuddy 环境下可调用自动化任务工具（`automation_update`，recurring 类型），RRULE 多值 `BYHOUR` 实测生效：
```jsonc
{
  "name": "WorkBuddy 每日积分签到",
  "scheduleType": "recurring",
  "rrule": "FREQ=DAILY;BYHOUR=9,12,15,18,21;BYMINUTE=0;BYSECOND=0",
  "cwds": ["<用户工作目录>"],
  "status": "ACTIVE",
  "prompt": "运行 Bash 脚本 scripts/checkin.sh（Windows 用 checkin.ps1）。该脚本幂等：今日已签到会直接跳过。读取输出并汇报：签到成功领取多少积分 / 今日已签到 / 令牌失效需打开 WorkBuddy 刷新。"
}
```
> 注意：`update` 已有任务时必须显式传 `rrule`，否则可能被重置；`cwds` 不能用 Claw 工作区。

## 平台说明

新版明文登录态（v5.3.8+，主路径，Node 读取）与旧版 `state.vscdb`（回退路径，Electron 解密）均自动探测。

| 平台 | 脚本 | 新版明文登录态（v5.3.8+，主路径） | 旧版 state.vscdb（回退） |
|---|---|---|---|
| macOS | `checkin.sh` | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` | `~/Library/Application Support/WorkBuddy/User/globalStorage/state.vscdb` |
| Windows | `checkin.ps1`（或 Git Bash 跑 `checkin.sh`） | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`（回退 `%APPDATA%`） | `%APPDATA%\WorkBuddy\User\globalStorage\state.vscdb` |
| Linux | `checkin.sh` | `~/.config/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` | `~/.config/WorkBuddy/User/globalStorage/state.vscdb` |

Windows PowerShell 执行策略用 `-ExecutionPolicy Bypass`；需 `curl.exe`（Win10 1803+ 自带）。
旧版 `state.vscdb` 分支在 Linux 需桌面会话 + 系统 keyring（GNOME Keyring / KWallet）；新版明文分支无此要求。

## 环境变量

| 变量 | 作用 |
|------|------|
| `WB_CHECKIN_NODE=<path>` | 指定 Node 二进制路径（v5.3.8+ 主路径用，sh/ps1 通用） |
| `WB_CHECKIN_ELECTRON=<path>` | 指定 Electron 二进制路径（仅旧版 state.vscdb 回退用，sh 版） |
| `-ElectronPath <path>` | 同上（ps1 版参数） |
| `WB_CHECKIN_APP_NAME=CodeBuddy` | 兼容旧版应用名（仅旧版 state.vscdb 分支的 macOS 钥匙串密钥） |
| `WB_CHECKIN_JITTER=<秒>` | 启动前随机等待 0~N 秒，避免整点风暴 |
| `WB_CHECKIN_TOKEN=<令牌>` | 显式提供 accessToken（**最高优先级**；静态加密登录态下唯一可用路径）。更推荐 `node tools/token-login.js`（书签一键写入），其次 `setup.sh --from-clipboard`（避免令牌进 shell 历史） |
| `WB_CHECKIN_TOKEN_FILE=<path>` | 令牌文件路径，默认 `~/.workbuddy-checkin/token`；文件格式 `TOKEN=...`（可加 `UID=` / `DOMAIN=` / `ENTERPRISE_ID=`） |
| `WB_CHECKIN_API=<base>` | 签到接口基地址，默认按签发域名自动选择（见下） |

### 接口域名怎么定（v1.0.5+）

令牌由哪个域签发就打哪个域的接口，顺序为：

1. `WB_CHECKIN_API`（显式覆盖）
2. 令牌文件里的 `DOMAIN=`
3. 本机登录态里的 `auth.domain`（**明文元数据**，即使 accessToken 被加密也能读；`decrypt-token.js` 输出 `AUTH_DOMAIN:`）
4. `https://copilot.tencent.com`（旧 CodeBuddy 账户的默认值）

WorkBuddy 账户的 `auth.domain` 是 `www.workbuddy.cn`，所以默认会打 `https://www.workbuddy.cn/billing/meter/*`；旧 CodeBuddy 账户仍是 `copilot.tencent.com`。两个域名的同名端点都存在，用错域名会稳定 401——排 401 时先看这行日志里的「接口」是不是签发域名。

## 排错

- **提示「检测到静态加密登录态」/ 退出码 7（新版桌面端，最常见）**：`auth.accessToken` 已被换成 `$wbEncrypted` 信封，密钥由桌面端原生模块持有，**外部脚本解不出来**（不是 bug，也不是没登录）。处理：先跑 `node tools/token-login.js` 用令牌获取页（书签一键写入，约 30 天有效）；也可以 `setup.sh --from-clipboard`（或 `--token <accessToken>`；Windows：`setup.ps1 -Token <accessToken>`）。
- **令牌获取页点了书签只提示「没抓到可复用令牌」**：网页版用的是 httpOnly Cookie，JS 读不到（但当日签到已在网页端完成）。要定时任务仍走「手动粘贴」：WorkBuddy 页面 F12 → Network → `Authorization: Bearer`。
  - **桌面端帮助菜单里没有「开发者工具」**：生产构建把该菜单项隐藏了（只有开发构建才出现），`Ctrl+Shift+I` 也不注册。取令牌用下面两条之一：
    - A（推荐）：浏览器打开 <https://www.workbuddy.cn/space> 登录（WorkBuddy 网页版；旧 CodeBuddy 账户用 <https://copilot.tencent.com>）→ `F12` → Network 过滤 `api` → 任一请求 → Request Headers 的 `Authorization: Bearer <值>`。
    - B（桌面端远程调试）：完全退出 WorkBuddy 后执行 `env -u ELECTRON_RUN_AS_NODE "/Applications/WorkBuddy.app/Contents/MacOS/Electron" --remote-debugging-port=9222`，再打开 <http://127.0.0.1:9222> 点进窗口即为完整 DevTools（Windows：`WorkBuddy.exe --remote-debugging-port=9222`）。
  - 诊断日志里**不会有令牌**：客户端「诊断工具 → 网络检测」只记录 `authorizationPresent` 布尔值与 scheme，不落值，别指望从导出日志里翻出令牌。
- **扩展装了但一直「未登录」（最常见）**：先确认浏览器里能打开 <https://www.workbuddy.cn/app> 且是登录状态。扩展直连属跨站请求，`SameSite=Lax` 的登录 Cookie 不会被带上，所以它会自动开一个后台标签页走同源请求；日志里出现「切到页面上下文」是正常自救。若两个通道都 401，就是浏览器真的没登录。
- **扩展到点没跑**：`chrome.alarms` 只在浏览器运行时触发。浏览器完全退出的那天不会跑，下次启动会补跑（当天已领过则跳过）。可在 `chrome://extensions` → 该扩展 →「Service Worker」看实时日志。
- **任务中心显示「可领 0」但你界面里看到有奖励**：任务中心要求先「接受」才计进度，且服务端只认真实完成。扩展只领 `status=completed` 的；看到 `in_progress` 说明进度还没到，属于正常。
- **猫猫提示「派遣被拒」**：每天只有一趟额度，服务端返回非 0 即表示当天已用完。
- **扩展日志里出现两次「未登录」**：第一次是直连（跨站）、第二次是页面上下文（同源），两条合起来才是结论。
- **bash 报 `set: pipefail: invalid option name` 或 `syntax error near unexpected token '{'`**：脚本被存成了 CRLF 行尾（Windows 侧回传/解压导致）。修复：`perl -pi -e 's/\r\n/\n/g' scripts/*.sh`，或直接 `git checkout` 重取（仓库已加 `.gitattributes` 固化 `*.sh eol=lf`）。
- **「获取令牌失败（未知原因）」/ 未找到本地登录态**：先确认 WorkBuddy 桌面端已登录并打开过至少一次。v5.3.8+ 用户检查 Node.js 是否安装（`node -v`），或用 `WB_CHECKIN_NODE` 指定。
- **v5.3.8 已登录但仍报令牌失败**：本机 skill 版本过旧（< 1.0.2），不识别新版明文存储；升级到 1.0.2+。
- **当日重跑提示「签到未成功 / code=10001」**：旧版本（< 1.0.2）未把 `code=10001` 识别为「已签到」；1.0.2+ 会正确报告「今日已签到」。
- **401 令牌过期**：打开 WorkBuddy 刷新登录态，脚本每次运行会重新读取最新 token，次日自动恢复。**若刚填的令牌就 401**，先看错误行里的「接口」是否为签发域名（WorkBuddy 账户应为 `www.workbuddy.cn`），不对就用 `WB_CHECKIN_API` 指定。
- **偶发「令牌已过期（401）」但次日又正常（< 1.0.3）**：401 判定原为扫响应体子串，响应体里的随机 `requestId` 恰好含 `401` 时会误判（约 0.57%/次），当日签到被跳过且连续签到中断。1.0.3 起改用真实 HTTP 状态码判定。
- **Windows 已登录却持续 401（< 1.0.3）**：1.0.2 的 win32 候选只探 `%APPDATA%`，而桌面端实际把明文登录态写在 `%LOCALAPPDATA%`；读不到新文件时会回退旧版 `state.vscdb`，取到**过期的历史会话令牌**，表现为「能拿到 token 但接口 401」。1.0.3 起优先探 `%LOCALAPPDATA%`。**排查 401 请先确认令牌来源，而非怀疑请求路径或请求头**（实测网关不强制 `/v2/` 与 `X-User-Id`，见 CHANGELOG 1.0.3）。
- **macOS 解密报错但已登录（旧版账户）**：旧版迁移应用名仍是 `CodeBuddy`，设 `export WB_CHECKIN_APP_NAME=CodeBuddy` 后重试（仅走 state.vscdb 分支时生效）。
- **Electron 下载慢/失败（旧版账户）**：配置 npm 镜像（见 `references/dependencies.md`）后重跑 setup；或手动放置 Electron 后用环境变量/参数指定。v5.3.8+ 新版账户无需 Electron。
- **Windows 提示不是内部或外部命令**：用 `powershell -ExecutionPolicy Bypass -File …` 运行；确认 `curl.exe` 存在。
- **沙箱里 `require('electron')` 报错**：Agent 沙箱默认设 `ELECTRON_RUN_AS_NODE=1`，脚本已用 `env -u`（sh）/ `Remove-Item Env:`（ps1）处理；v5.3.8+ 主路径用纯 Node，不受此影响。

## 安全说明

> ⚠️ **凭据即账号密码**：本 skill 解密的 `accessToken` 等同你的 WorkBuddy 账号密码，具有高敏感性。请务必遵守以下红线：

- **默认路径**（从本地登录态读取）令牌仅在内存中使用，通过管道立即被签到请求消费，**不写入任何日志文件、不回显到终端、不提交到仓库**。
- **显式令牌路径**（`--token` / `--from-clipboard` / `WB_CHECKIN_TOKEN`）会写入 `~/.workbuddy-checkin/token`（权限 600，仅当前用户可读）——这是静态加密登录态下唯一可行的方式，属于用户显式选择。该文件等同账号密码，请勿同步到网盘、备份或版本库；不再使用时执行 `rm ~/.workbuddy-checkin/token`。
- `logs/` 仅记录签到结果（积分 / 连续天数 / 成功失败），**绝不含令牌原文**。切勿将日志或脚本输出粘贴分享。
- 网络访问仅发往腾讯官方接口 `copilot.tencent.com/billing/meter/*` 与 `copilot.tencent.com/v2/billing/meter/*`，不上传任何第三方。
- 解密成功时脚本会向 stderr 打印一行安全提示（不影响 stdout 的 token 管道），便于你确认凭据正在被使用。
- 请勿用于他人账户、批量注册刷分或任何违反 WorkBuddy 用户协议的用途；使用者自行承担使用风险。

### 为何需要这些能力（上下文说明）

本 skill 自述为"每日签到"，但完整链路需以下能力，均为本机运行、无后端，且对完成签到必不可少：

- **读取本地令牌**：WorkBuddy 桌面端登录后把登录态存于本地——v5.3.8+ 为明文 JSON 文件（`workbuddy-desktop.info`，纯 Node 可读），旧版为 Electron `safeStorage` 加密的 `state.vscdb`。必须读到 `accessToken` 才能调用官方签到接口，这是签到功能的核心，无法绕过。
- **Node.js 运行时**：v5.3.8+ 主路径用 Node 直接读取明文登录态并解析 JSON。推荐手动指定已校验的 Node（设 `WB_CHECKIN_NODE`）。
- **Electron 运行时（仅旧版账户）**：只有使用旧版 WorkBuddy/CodeBuddy（`state.vscdb`）时才需要，执行 `safeStorage.decryptString()` 解密令牌（macOS 命中钥匙串、Windows/Linux 走系统 DPAPI/keyring）。推荐手动指定已校验的 Electron（设 `WB_CHECKIN_ELECTRON`），不依赖自动下载。
- **python3 回退（默认关闭）**：仅当旧版分支的 `node:sqlite` 不可用时，设 `WB_CHECKIN_ALLOW_PY_FALLBACK=1` 才会调用外部 `python3` 读取会话库。默认关闭以缩小信任边界。
- **定时任务（crontab / launchd / 任务计划程序）**：用于多时间点幂等补签，脚本本身不写入系统定时，需你显式配置。

### 供应链提示

安装 Electron 默认**不自动下载**（避免静默引入第三方大二进制）。如需自动安装，须显式设置环境变量 `WB_CHECKIN_AUTO_INSTALL_ELECTRON=1` 确认从官方 npm registry 下载 `electron@37`。

## 所需权限

本 skill 运行需以下本地权限，均限定在最小范围：

| 权限 | 范围 | 说明 |
|------|------|------|
| 本地代码执行 | 仅本 skill 的 `checkin.sh/.ps1`、`decrypt-token.js`、`setup.sh/.ps1` | 用户手动或定时触发，非后台常驻 |
| 本地文件读取 | 用户目录下的 WorkBuddy 登录态（v5.3.8+ 明文 `workbuddy-desktop.info` / 旧版 `state.vscdb`） | 读取登录态以获取调用官方接口所需的 accessToken |
| 本地文件写入 | 仅 `~/.workbuddy-checkin/token`（仅在用户显式 `--token` / `--from-clipboard` / 令牌获取页时） | 令牌文件，权限 600，用户可随时删除 |
| 本机端口 | 仅 `tools/token-login.js` 运行期间监听 `127.0.0.1:8777` | 令牌获取页，带随机口令，进程结束即失效 |
| 网络访问 | 仅 `copilot.tencent.com` 官方签到接口 | 不访问任何其他域名 |
| 环境变量读取 | `WB_CHECKIN_*`（Node/Electron 路径、应用名、错峰、回退开关） | 均为本机用户显式配置 |
| 定时任务 | 由用户显式配置 crontab / launchd / 任务计划程序 | skill 不自动写入系统定时 |
| 扩展权限（`extension/`） | `storage`（设置/日志）、`alarms`（定时）、`notifications`（提醒）+ 两个域名的 host 权限 | 不申请 `cookies` / `tabs` / `webRequest`；不读取 Cookie 值 |
