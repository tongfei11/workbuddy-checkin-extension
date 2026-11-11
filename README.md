# workbuddy-checkin

> WorkBuddy（原 CodeBuddy）每日积分自动签到 Skill —— 全本机运行，无后端，令牌不落盘。

每天自动领取 WorkBuddy「Buddy 加油站」的 100 积分（连续第 7 天 1000 积分），再也不怕忘记签到断连。

## 它做了什么

1. 读取本机 WorkBuddy 桌面端的登录态（明文 JSON / 显式令牌 / 旧版 state.vscdb 自动探测）
   - 新版桌面端已把 `accessToken` 改成 `$wbEncrypted` 静态加密信封，密钥在原生模块里、磁盘无明文，外部脚本解不出来 → 用 `--token` 显式提供一次（30 天有效）
2. 调用腾讯官方签到接口 `copilot.tencent.com/billing/meter/daily-checkin`
3. 幂等：今日已签到自动跳过，支持一天多时间点补签

**不做什么**：不点 GUI 按钮（Electron `isTrusted` 过滤使模拟点击无效）、不上传令牌给第三方、不写入日志。

**三种用法**，按省事程度：

| 方式 | 适合谁 | 需要什么 |
|---|---|---|
| **① 浏览器扩展**（[`extension/`](extension/)，推荐） | 想让电脑自己搞定，不想碰命令行 | Chrome/Edge + 网页版登录一次 |
| ② 命令行 + 定时任务（[`scripts/`](scripts/)） | 已有 Node 环境、要跑在服务器/无 GUI 机器 | Node.js + 令牌（新版桌面端 30 天换一次） |
| ③ WorkBuddy 内置 Skill（下方「最简方式」） | 只用 WorkBuddy，不想另装东西 | 已登录的 WorkBuddy 桌面端 |

## 方式一：浏览器扩展（最省事，推荐）

装一次，之后每天自动领；失败会在系统通知里告诉你，不用记着来看。

### 安装（Chrome / Edge，约 1 分钟）

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本仓库的 **`extension/`** 目录
4. 安装完成会自动打开设置页

> 没装过开发环境也不需要 npm / Node —— 扩展是纯静态文件，浏览器直接加载。
> 要把扩展给别的机器用，打成一个 zip 传过去解压再「加载已解压的扩展程序」即可。

### 前提

浏览器里已登录 <https://www.workbuddy.cn/app>（和桌面端同一账号）。扩展用的就是这份登录态，
**不需要令牌、不需要 Node、不需要命令行**。

### 设置项

| 项 | 默认 | 说明 |
|---|---|---|
| 启用每日自动签到 | 开 | 关掉后只保留「立即签到」按钮 |
| 每天触发时间 | 09:00 | 本地时区；保存后立刻重排定时 |
| 随机延迟 | 0~10 分钟 | 避免整点扎堆 |
| 网络失败重试 | 2 次，每次间隔 30 分钟 | 断网、5xx 走这条 |
| 未登录轮询 | 4 次，每次间隔 30 分钟 | 见下方「关于未登录」 |
| 通知 | 仅失败时 | 可改成成功也弹 |
| 站点 | 自动 | 依次尝试 www.workbuddy.cn、copilot.tencent.com |
| 成长体系 | 开 | 签到后顺带处理任务中心与猫猫 |
| 自动接受任务 | 开 | 把「未接受」的任务接受掉（接受后才计进度） |
| 猫猫派猫 | 开 | 有奖励就领，在家就派它出门 |
| 猫猫回程检查 | 开 | 按服务端 `arrive_at` 到点再跑一次：领奖 → 立刻再派 → 排下一趟（4 小时一轮） |
| 连登兑换 | 开 | 到 7 / 14 / 28 天领档位奖励（**补登卡就来自 7 天档**） |
| 断登补登 | 开 | 当月有断登且卡够时，自动补最近的一天 |

### 成长体系：任务中心 + 猫猫旅行（v1.2.0+）

签到只是每天 100 分。「Buddy 加油站」下面还有两块：

- **任务中心**（一次性，约 1700 分）：扩展会拉任务清单，把**已完成**的逐个领掉；「未接受」的任务按你的设置自动接受。
- **猫猫旅行**：4 小时一轮，可以反复跑。派出去后按服务端返回的 `arrive_at` 排一次回程检查，到点领奖（约 +7）后**立刻再派一趟**，形成循环，不用等到第二天。
- **连登兑换**（7 / 14 / 28 天各一次）：档位奖励里有补登卡、积分、能量、抽奖次数。
- **补登卡**：当月有断登时，自动用卡补上最近的一天，保住连续天数。

**边界很清楚**：只做「领取」和「接受」，**不会伪造完成状态**。服务端会校验任务是否真的完成，没做完的一律拒绝；所以该你做的动作（用模板发一次任务、关注公众号满 24 小时、接受后再去做）仍然要自己来。扩展能省掉的是「每天点进任务中心、逐个点领取」这些重复点击。

猫猫的循环是「派遣 → 到点领奖 → 再派 → 再排」，时间取自服务端 `arrive_at`（秒级），拿不到才按 4 小时估。
若服务端返回「今日已达上限」（`daily_limit_reached` 或 `daily limit` 之类），扩展会记一条 info 并撤掉当天剩余的回程检查，不再空转。

执行顺序是 **任务 → 猫猫 → 兑换 → 补登**。补登必须在兑换之后 —— 补登卡只能从 7 天档兑换里拿到，所以「先兑换、再补登」是硬顺序，不是随手排的。

每块都独立于签到：任何一块挂了只记一条 warn，签到照常完成，也不会因此触发重试。

> **注意：产品里有两套完全不同的计数，别看串了。**
>
> | 日志里的说法 | 来源 | 口径 |
> |---|---|---|
> | 累计 N 天 | 签到接口的 `streak_days` | 实测对应「全年活跃记录」的天数（如 18 天活跃那种）；只展示，**不参与任何判断** |
> | 成长连登 N 天 | `activity/growth/streak` | 活跃地图口径，**完成一次对话才计入** |
>
> 补登卡补的是后者（活跃地图），不是签到。两者数字对不上是正常的。

### 关于未登录（这条最影响体验）

定时跑的时候如果浏览器没登录，扩展会**立刻弹通知**，带两个按钮：

- **「去登录」** → 打开网页版登录
- **「已登录，重试」** → 登录完点它，立刻把当天领掉，不用等明天

同时后台按「未登录轮询」继续尝试（默认每 30 分钟、共 4 次）。你在这段时间内登录了，
下一次轮询会自动接上，把当天签到补掉。

### 日志与排查

- 弹窗：状态、连续天数、今日积分、下次/上次运行时间、最近日志
- 设置页：全部日志，可「导出 .log」或「复制」「清空」
- 图标角标：`✓` 已领取 / `!` 失败或未登录 / 空 未运行

### 为什么它偶尔会开一个标签页（技术说明）

扩展后台发起的 `fetch` 属于**跨站请求**，而 WorkBuddy 的登录 Cookie 是 `SameSite=Lax`，
浏览器不会把它附加到跨站请求上 —— 直接请求的结果就是「明明登录着却一直 401」。

所以扩展先直连试一次；一旦判定未登录，会**自动开一个后台标签页**（不抢焦点），
从页面里用同源请求再确认一次，确认完**立即关闭**该标签页。日志里会写明「切到页面上下文」，
所以看到这条不是报错，是它在自救。

### 局限

- **依赖浏览器运行**：定时只在浏览器开着时触发；浏览器完全退出的那天不会跑，下次启动会补跑（当天已领过则跳过）。
- 定时精度：`chrome.alarms` 在系统休眠/浏览器长时间未活动后可能延后，恢复后会尽快补。
- 扩展只访问 `www.workbuddy.cn` / `copilot.tencent.com`，**不读取 Cookie 值、不收集任何数据**。

---

## 最简方式：WorkBuddy 内置 Skill 目录（推荐小白）

不需要敲命令，直接把本仓库当成本地 skill 目录，让 WorkBuddy 自己每天执行。

### 1. 准备本地 skill 目录

在电脑上新建一个文件夹（例如 `D:\workspace\workbuddy\签到自动任务`），把本仓库的 `SKILL.md` 复制进去。

![步骤1：新建本地 skill 目录](images/step1.png)

```
签到自动任务/
└── SKILL.md
```

### 2. 在 WorkBuddy 里新建任务

打开 WorkBuddy 桌面端 → 左侧「新建任务」→ 工作目录选择刚才创建的文件夹。

![步骤2：WorkBuddy 新建任务并选择目录](images/step2.png)

### 3. 粘贴提示词并启动

在对话里粘贴以下内容（可以直接复制）：

```
学习 SKILL.md，并实现每日签到，需要返回执行结果成功还是失败。
```

![步骤3：粘贴提示词](images/step3.png)

WorkBuddy 会读取目录里的 `SKILL.md`，理解签到逻辑，并自动创建定时任务。

### 4. 查看自动任务

创建成功后，进入左侧「自动化」→ 即可看到「每日领取 Buddy 加油站积分」定时任务。

![步骤4：在自动化列表查看任务](images/step4.png)

### 5. 等它执行，看结果

任务运行后，WorkBuddy 会返回类似结果：

![步骤5：签到成功返回结果](images/step5.png)

```
✅ Buddy 加油站每日积分领取成功
- 领取结果：credit=100，连续签到 streak_days=5（连续第 5 天）
- 空闲检测：空闲 18 秒、CPU 15.1%、无媒体播放 → 通过
- 幂等保障：若返回 code=10001（今日已签到）会自动跳过
```

> 如果当天已经手动领取过，它会返回「今日已签到，无需重复领取」，不会重复扣分/加分。

## 快速开始（命令行方式）

如果你更喜欢用脚本/命令行，或者想先手动验证一次：

### 前提

- 已安装并**登录** WorkBuddy 桌面端（[官网下载](https://www.codebuddy.cn/work/)）
- 系统已安装 Node.js 20+（[nodejs.org](https://nodejs.org)）
- **新版桌面端需提供一次令牌**（见下方「令牌怎么来」），旧版/明文登录态无需此步

### Windows（PowerShell）

```powershell
# 1. 克隆仓库
git clone https://github.com/Coco-katarina/workbuddy-checkin.git
cd workbuddy-checkin

# 2. 环境检查（若提示「静态加密登录态」，改用下一行带 -Token 的写法；
#    取令牌可先跑 `node tools/token-login.js`，页面里拖书签即可）
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Token <accessToken>

# 3. 立即签到
powershell -ExecutionPolicy Bypass -File scripts\checkin.ps1
```

### macOS / Linux

```bash
# 1. 克隆仓库
git clone https://github.com/Coco-katarina/workbuddy-checkin.git
cd workbuddy-checkin

# 2. 环境检查（若提示「静态加密登录态」，用上一行的令牌获取页处理，见「令牌怎么来」）
bash scripts/setup.sh

# 令牌获取页（需要时）：打开本机页面 → 网页版登录 → 点书签
node tools/token-login.js

# 3. 立即签到
bash scripts/checkin.sh
```

预期输出：
- `签到成功！领取 OK credit=100 streak_days=N` → 当日领取成功
- `今日已签到，无需重复领取` → 已领过，幂等结束

### 令牌怎么来（新版桌面端）

> 桌面端「帮助」菜单里**没有**「开发者工具」——生产构建把它隐藏了（菜单项只在开发构建里出现）。所以要绕开它。

**方式 A：令牌获取页（推荐，点几下就好）**

```bash
node tools/token-login.js
```

它会打开一个本机页面（只监听 `127.0.0.1`，关掉进程即失效），按页面三步走：

1. 页面里点开 <https://www.workbuddy.cn/app> 登录（和桌面端同一账号）
2. 把页面上的「WB 取令牌」拖到浏览器书签栏
3. 回到 WorkBuddy 页面点这个书签 —— 它会确认登录态、**顺手把今天的签到领掉**，并把凭据回传写入 `~/.workbuddy-checkin/token`

如果书签抓不到可复用令牌（网页版可能用 httpOnly Cookie，JS 读不到），页面会直接说明，并保留下面两种手动方式 —— 这时你至少在网页端已经把当天积分领到了。

**方式 B：网页版 F12 手动复制**

1. 浏览器打开 <https://www.workbuddy.cn/app> 并登录（旧 CodeBuddy 账户用 <https://copilot.tencent.com>）
2. `F12` → Network → 过滤 `api` → 随便点一个请求 → Request Headers 里找到 `Authorization: Bearer <这一串>`
3. 复制 `<这一串>`，然后：`bash scripts/setup.sh --from-clipboard`
   （直接复制到剪贴板再用这个参数，令牌不会留在 shell 历史里）

**方式 C：桌面端开远程调试（网页端登不上时用）**

```bash
# 1) 完全退出 WorkBuddy（Cmd+Q，确认 Dock 里没有进程）
# 2) 带调试端口启动（浏览器打开 http://127.0.0.1:9222 即为完整 DevTools）
env -u ELECTRON_RUN_AS_NODE "/Applications/WorkBuddy.app/Contents/MacOS/Electron" --remote-debugging-port=9222
```

Windows 对应：`WorkBuddy.exe --remote-debugging-port=9222`。

令牌存到 `~/.workbuddy-checkin/token`（权限 600），**有效期约 30 天**，过期后重新提供一次即可。

> 签到接口域名自动跟随令牌签发域：WorkBuddy 账户是 `https://www.workbuddy.cn/billing/meter/*`，旧 CodeBuddy 账户是 `copilot.tencent.com`。两者端点都存在，但用错会稳定 401。需要手动指定时设 `WB_CHECKIN_API=https://...`。
> 也支持 `bash scripts/setup.sh --token <这一串>`（Windows：`setup.ps1 -Token <这一串>`），但令牌会进 shell 历史。

## 设置定时任务

电脑非全天开机时，建议配置多个时间点补签（脚本幂等，重复运行无副作用）。推荐 `09:00 / 12:00 / 15:00 / 18:00 / 21:00` 各尝试一次。

### Windows（任务计划程序）

```powershell
schtasks /Create /TN WorkBuddyCheckin_09 /TR "powershell -ExecutionPolicy Bypass -File C:\path\to\checkin.ps1" /SC DAILY /ST 09:00 /F
schtasks /Create /TN WorkBuddyCheckin_12 /TR "powershell -ExecutionPolicy Bypass -File C:\path\to\checkin.ps1" /SC DAILY /ST 12:00 /F
```

### macOS / Linux（crontab）

```bash
crontab -e
# 添加（替换实际路径）
0 9,12,15,18,21 * * * /path/to/checkin.sh >> /path/to/logs/checkin.log 2>&1
```

### macOS launchd（长期后台）

创建 `~/Library/LaunchAgents/com.user.workbuddy-checkin.plist`，`StartCalendarInterval` 用数组配置多时间点，详见 [SKILL.md](SKILL.md)。

## 安全说明

| 项目 | 说明 |
|------|------|
| 令牌存储 | 默认仅内存使用、管道即时消费、不写日志；**显式提供令牌时**写入 `~/.workbuddy-checkin/token`（权限 600，仅当前用户可读，可随时 `rm`） |
| 网络访问 | 仅 `copilot.tencent.com` 官方接口，**不访问任何第三方** |
| 日志内容 | 仅积分 / 连续天数 / 成功失败，**绝不含令牌** |
| 系统修改 | 只读登录态文件，**不修改 WorkBuddy 本体** |
| 令牌获取页 | 只监听 `127.0.0.1`，带本次启动的随机口令，进程结束即失效；只接收 `*.workbuddy.cn` 来源的回传 |
| 自动安装 | Electron 下载默认关闭，需显式 `WB_CHECKIN_AUTO_INSTALL_ELECTRON=1` |

> **凭据即账号密码**：解密的 `accessToken` 等同你的 WorkBuddy 账号密码。切勿将日志、脚本输出粘贴分享或提交到仓库。

## 文件结构

```
workbuddy-checkin/
├── SKILL.md                      # Skill 规范文档
├── CHANGELOG.md                  # 变更日志
├── .gitattributes                # 行尾策略（sh/js=LF，ps1/cmd=CRLF，防 CRLF 复发）
├── scripts/
│   ├── decrypt-token.js          # 令牌读取（新版明文 Node / 旧版 Electron safeStorage）
│   ├── checkin.sh                # macOS / Linux / Git Bash
│   ├── checkin.ps1               # Windows PowerShell
│   ├── setup.sh                  # macOS / Linux 环境检查
│   └── setup.ps1                 # Windows 环境检查
├── extension/                    # 浏览器扩展（MV3，推荐用法）
│   ├── manifest.json             # 权限最小化：storage/alarms/notifications
│   ├── background.js             # 定时、端点探测、重试、通知、日志
│   ├── lib.js                    # 纯逻辑（可 Node 单测，不依赖 chrome.*）
│   ├── page-bridge.js            # 页面上下文通道（解决跨站 Cookie 不带导致 401）
│   ├── lib.js                    # 含任务中心/猫猫的解析逻辑（可单测）
│   ├── popup.*                   # 弹窗：状态 / 立即签到 / 最近日志
│   ├── options.*                 # 设置：时间 / 重试 / 通知 / 日志导出
│   └── icons/                    # 16/32/48/128 图标（脚本生成）
├── tools/
│   ├── token-login.js            # 令牌获取页（本机 127.0.0.1 + 书签脚本，走网页端登录）
│   └── test-extension.mjs        # 扩展逻辑测试（72 项，不需要浏览器）
└── references/
    └── dependencies.md           # 依赖清单与平台差异
```

## 排错速查

| 现象 | 原因 | 处理 |
|------|------|------|
| PS 解析报错（字符串缺少终止符） | 无 BOM 被 GBK 误读 | 给 ps1 加 UTF-8 BOM（本仓库已含） |
| HTTP 401 | 令牌过期 / 读到旧版 state.vscdb | 打开 WorkBuddy 刷新登录态；确认用 v1.0.3+ |
| 幂等场景报 PARSE_ERR | ConvertFrom-Json 解析 400 响应失败 | 加 code=10001 前置判断（本仓库已修复） |
| 找不到登录态 | WorkBuddy 未登录 | 打开桌面端登录一次 |
| 提示「静态加密登录态」/ 退出码 7 | 新版桌面端把令牌加密了，外部脚本解不出来 | `setup.sh --token <accessToken>`（30 天一次） |
| `set: pipefail: invalid option name` / `syntax error near unexpected token '{'` | 脚本是 CRLF 行尾 | `perl -pi -e 's/\r\n/\n/g' scripts/*.sh`（仓库已加 `.gitattributes` 防复发） |
| Windows 持续 401 | 旧版只探 %APPDATA%，实际在 %LOCALAPPDATA% | 用 v1.0.3+（本仓库已修复） |

## 致谢

- 原作者：[cat-xierluo](https://github.com/cat-xierluo/legal-skills) —— 原始 skill v1.0.3
- 本仓库在原版基础上的改动：
  1. `checkin.ps1` / `setup.ps1` 添加 UTF-8 BOM（解决 PowerShell 5.1 中文 GBK 误读）
  2. `checkin.ps1` 幂等场景 `code=10001` 前置判断（修复 ConvertFrom-Json 解析 400 响应的 PARSE_ERR bug）
  3. v1.0.4：修掉 CRLF 行尾导致的 bash 语法错误（`set: pipefail: invalid option name`），新增 `.gitattributes` 固化 `*.sh eol=lf`
  4. v1.0.4：修掉 `$VAR` 紧跟全角标点导致的 `unbound variable` 崩溃（401 等错误分支原本会直接崩、日志空白）
  5. v1.0.4：适配 `$wbEncrypted` 静态加密登录态——显式令牌源（`--token` / `WB_CHECKIN_TOKEN`）+ 退出码 7 精确报错
  6. v1.0.5：修正取令牌路径（桌面端**没有**「开发者工具」菜单，改用网页版 F12 / `--remote-debugging-port`），新增 `setup.sh --from-clipboard`
  15. v1.4.2：日志精简（去掉括注）、`streak_days` 改称「累计」——实测它对应「全年活跃记录」
  14. v1.4.1：把「连续」措辞拆开 —— 签到侧改称「签到计数（服务端 streak_days）」，成长侧明确「活跃地图口径」，两套计数不再混为一谈
  13. v1.4.0：猫猫改为 **4 小时一轮的循环**（按服务端 `arrive_at` 排闹钟，到点领奖后再派）；回程那次只跑猫猫，不动签到/任务；「今日已达上限」按 info 处理并撤闹钟
  12. v1.3.2：修好猫猫派遣 —— 服务端对 `location_id` 做严格类型校验，数字 id 被 `String()` 后变成字符串即 `invalid request`；**参数不要做无谓类型转换**
  11. v1.3.0：扩展支持**连登兑换**与**补登卡**（先兑换拿卡、再补当月断登日）；修正任务状态字段为 `acceptStatus`（此前「待接受」恒为 0，「去完成」的任务从未被接受）
  10. v1.2.1：修复猫猫派遣 400 —— `travel/config` 里 `locations[].id` 与 `preview_photos[].id` / `intro_slogan_items[].expert_id` 混在一起，必须只取地点自己的 id；状态改用前端状态机 `idle/traveling/arrived`
  9. v1.2.0：扩展支持**任务中心自动接受/领取**与**猫猫旅行派猫/领奖**（`/v2/activity/growth/tasks` 等，逆向自个人中心前端分包）；三者解耦，成长体系失败不影响签到
  8. v1.1.0：新增**浏览器扩展**（`extension/`）——可配置触发时间、日志、失败通知与两类重试；直连 401 时自动切页面上下文
  7. v1.0.6：新增 `tools/token-login.js` 令牌获取页（网页端登录 + 书签一键回传/签到）；修正签到端点（网页版用 `checkin-activity-status`，Windows 版用 `/v2` 前缀，改为按候选探测）；修正 `daily-checkin` 响应解析（`credit`/`streak_days` 在顶层，原代码取 `data.credit` 会得到 `None`）

## License

MIT

## 免责声明

本工具等价于「每天手动点一次领取今日礼包」，仅操作本机当前登录用户自己的 WorkBuddy 账户。请勿用于他人账户、批量注册刷分或任何违反 WorkBuddy 用户协议的用途。使用者自行承担风险。
