# 变更日志

## [1.4.6] - 2026-11-11

去掉汇总行（`成长：任务+1 · 接受+1 · 共+300 积分 · 猫→京都`）。

每个动作本来就有自己那行（`完成任务：xxx +300` / `猫猫：已派往 xxx` / `兑换 14 天档：+50 积分`），
汇总行属于重复播报。一并删掉不再有调用者的 `summarizeGrowth()`。

回程检查同理：现在只有实际动作，没有汇总。

## [1.4.5] - 2026-11-11

措辞：`领取任务：和 AI 聊天 5 次 +100` → **`完成任务：和 AI 聊天 5 次 +100`**。

任务中心里这些条目本来就是"已完成、来领奖"的状态，叫「领取任务」读着像"又接了个新任务"。失败分支相应写「任务领取失败」。

## [1.4.4] - 2026-11-11

汇总行歧义：`成长：任务+1 · 积分+100` 里的 `积分+100` 看不出是"哪个动作给的"，也容易被误认为和签到的 +100 重复。

改为 **`成长：任务+1 · 共+100 积分`** —— 「共」明确表示这是上述动作的合计，明细在上面的动作行里（如 `领取任务：xxx +100`）。

> 顺带核对：`growthCredit` 只有三个来源（任务领取 / 猫猫奖励 / 兑换档位），**不含签到的 +100**，所以不存在重复计分。

## [1.4.3] - 2026-11-11

文案补单位：`+100/天` → **`+100 积分/天`**。上一版为了精简把单位省掉了，读起来像"100 什么"。

## [1.4.2] - 2026-11-11

日志精简；`streak_days` 定名为「累计」。

### 依据

用户对照产品「全年活跃记录」面板（18 天活跃 · 活跃率 5% · 2 周连登）判断：日志里的 17 就是那里的活跃天数。
所以它既不是"连续签到"，也不是成长计划的连登 —— 改称 **累计 N 天**，不再暗示"连续"。

### 改动

- 文案：`签到计数 N 天（服务端 streak_days）` → **`累计 N 天`**；弹窗字段 `签到计数` → `累计`。
- 日志整体瘦身，**去掉所有括注式解释**（解释挪到文档里）：

| 之前 | 现在 |
|---|---|
| 成长计划连登 2 天（活跃地图口径，完成一次对话才计入），距 7 天档（送 1 张补登卡）还差 5 天 | 成长连登 2 天，距 7 天档还差 5 天 |
| 已接受 3 个任务（开始计进度） | 接受任务 3 个 |
| 另有 5 个「去完成」是自动/新手任务，需要你本人去操作，扩展不代劳 | 跳过 5 个自动/新手任务 |
| 猫猫：已安排在 11-11 20:00 检查回程（到点领奖后再派下一趟） | 猫猫：回程检查已排定 11-11 20:00 |
| 已用补登卡补上 2026-11-10（余额 1 → 0） | 补登 2026-11-10 成功，卡余 0 |
| 猫猫：今天的出行额度已用完，明天再来（已停止今日回程检查） | 猫猫：今日额度已用完，停止回程检查 |
| 成长体系：任务 +1 个 · 接受 1 个 · 积分 +300 · 已派猫去京都 | 成长：任务+1 · 接受+1 · 积分+300 · 猫→京都 |

- 失败诊断从 3 行压到 2 行，截断长度收紧（400/300 → 240/180），只在真失败时出现。

### 测试

130 项（断言里的日志文案同步更新）。

## [1.4.1] - 2026-11-11

文案修正：两套「连续」混着说，容易看成自相矛盾。

### 问题

同一条日志里出现：

```
INFO 连登 2 天，距 7 天档（送 1 张补登卡）还差 5 天
INFO 状态：今日已签到 · 连续 17 天 · 每日 +100 · Buddy应用
```

两个数字都对，但都叫「连续/连登」，看起来就是自相矛盾。实际它们是**两个不同活动的计数**：

| 数值 | 真实来源 | 口径 |
|---|---|---|
| 17 | 签到接口的 `streak_days` | 服务端计数，产品自己也不叫"连续"，我们只是原样展示 |
| 2 | `activity/growth/streak` 的 `streak.days` | 成长计划活跃地图：**完成一次对话才计入** |

### 改动

- 签到侧：`连续 N 天` → **`签到计数 N 天（服务端 streak_days）`**，并注明是服务端值，扩展仅展示。
- 成长侧：`连登 N 天` → **`成长计划连登 N 天（活跃地图口径，完成一次对话才计入）`**。
- 弹窗字段 `连续` → `签到计数`；结果摘要同步。
- README 加了一张对照表，说明两者数字对不上是正常的。

### 说明

`streak_days` **不参与任何逻辑判断**（既不决定是否领取，也不影响补登），只是展示，所以改文案不影响行为。

## [1.4.0] - 2026-11-11

猫猫改成**4 小时一轮的循环**（不是一天一趟），按服务端 `arrive_at` 驱动。

### 为什么改

我原以为猫猫一天只有一趟，所以设计成「回程只领奖、不再派」。实测倒计时是 **4 小时**（截图 03:58:48），
说明一天可以跑好几趟 —— 只领不派等于浪费了后面几趟。

### 现在的循环

```
派遣 → 按 arrive_at 排闹钟 → 到点：领奖 → 立刻再派 → 再排下一趟 …
```

- **时间来自服务端**：派遣响应里的 `arrive_at`（秒）→ 加 60 秒余量 → 设 `chrome.alarms`。
  拿不到 `arrive_at` 才退化成「4 小时 + 5 分钟」估算，不写死。
- **回程只跑猫猫**：新增 `travelOnly` 通道，回程那次不重复签到 / 任务中心 / 兑换 / 补登，
  也不写 `last` 记录（免得把 popup 的「今日签到」覆盖成"猫猫回程"）。
- **还在路上就重排**：如果到点时服务端说 `state=traveling`（时间漂移），按最新 `arrive_at` 再排一次。
- **今日已达上限**：`daily_limit_reached=true` 或派遣返回 `daily limit` / `quota` / `已达上限` / `额度`
  → 记为 **info**（不是 warn）、撤掉回程闹钟，今天不再空转。
- **护栏**：同一天最多重排 12 次，防止服务端时间异常导致死循环。
- 新增设置项「猫猫回程后自动再跑一次」（默认开），可单独关掉。

### 测试

130 项（新增：闹钟时间 = `arrive_at + 60s`、回程领奖后立刻再派、回程不碰签到/任务、额度上限撤闹钟且不报警）。

## [1.3.3] - 2026-11-11

猫猫派遣：从「猜一个参数」改成「按候选依次试」。

> **事后结论**：真正的根因在 1.3.2 已经找到并修掉了（数字 id 被转成字符串）。
> 本版不是修复，而是一层**兜底**：万一将来字段改名，能自己试出来而不是直接躺平。日常运行走不到这段逻辑。

### 背景

`locations[].id` 传过去仍然 `400 invalid request`。字段名是对的（前端源码就是 `{location_id: e}`），
所以问题在**取值/类型**，而不是参数名。没有登录态我无法拉真实 config，与其继续猜，不如让程序自己试。

### 改动

- 新增 `departCandidates()`：按 `id` → `location_code` → `code` → `city_id` → `key` 生成候选值，
  保留原始类型（数字发数字），去重后最多试 4 个。
- 派遣时依次尝试；**只有服务端返回 `invalid request` 才换下一个**——额度用完、已在路上这类错误换字段毫无意义，
  直接停（避免无意义请求）。成功后在日志里写明「服务端认的字段是 xxx」。
- 全部失败时打三行诊断（已尝试的值、`config.locations[0]` 完整对象、`travel/status` 原文）。

### 为什么可以放心试

`400 invalid request` 是纯参数校验失败，**没有副作用**：不会扣额度、不会改变 Buddy 状态，试错成本为零。

### 测试

119 项（新增：id 被拒后自动换 `location_code` 并成功、且日志标注字段名）。

## [1.3.2] - 2026-11-11

猫猫派遣还在 400，先把「猜」换成「能查」。

### 改动

- **地点 id 不再强转字符串**（**已在用户环境实测确认，这就是根因**）：之前 `String(l.id)`，
  服务端对 `location_id` 做严格类型校验，`1027` 变成 `"1027"` 就被判 `invalid request`。
  保留原始类型（数字发数字）后派遣成功：`OK 猫猫：已派往 古镇客栈`。
  → 教训写死在这里：**接口参数不要做无谓的类型转换**，前端传什么类型就传什么类型。
- **失败时打三行诊断**（只在派遣失败时出现，不刷屏）：
  1. 实际发送的 `location_id`（含 typeof）与服务端原始响应
  2. `config.locations[0]` 的**完整对象**（截断 400 字）—— 用来核对真正该传的字段是不是 `location_code` / `city_id`
  3. `travel/status` 原始数据 —— 用来确认 `state` / `daily_limit_reached` 是否与前端一致
- 目的很明确：下一次再 400，直接看这三行就能判断是「id 取值不对」「类型不对」还是「字段名不对」，不用再来回猜。

### 测试

116 项（新增：数字 id 必须原样以 number 发出）。

## [1.3.1] - 2026-11-11

说明性修复：明确「不唤起客户端」。

### 改动

- 任务「去完成」只调 `accept` 接口，**不执行任务里的 `jumpUrl`**。
  网页端真实流程是 accept 之后跳 `workbuddy://…` 深链，浏览器会弹「是否打开 WorkBuddy」并要求人工点取消；
  扩展跳过了这一步，所以既不会弹窗，也不会打断你正在做的事。已在代码里写明原因，避免以后被"补全"成跳转。
- 新增一条日志：`另有 N 个「去完成」是自动/新手任务，需要你本人去操作，扩展不代劳`。
  这类任务（`taskType=auto` / `beginner`）前端点了也只是跳转、不调 accept，扩展不会假装把它们做掉，
  免得日志看起来"没干活"。

## [1.3.0] - 2026-11-11

新增**连登兑换**与**补登卡**；顺带修掉一个让任务中心白跑一天的字段名错误。

### 修复（关键）

- **任务状态字段读错了**：任务列表用的是 `acceptStatus`（camelCase），我此前只认 `status` / `task_status` / `state`，
  结果所有任务状态都是空 → 日志永远显示「待接受 0」，「去完成」的任务**一个都没被接受**，任务自然进不了进行中、也领不到奖励。
  现在优先读 `acceptStatus`，并补充 `taskType` / `hasReward`：
  - `taskType=auto` / `beginner`：前端点了「去完成」只是跳转、不调 accept（系统自动接受），这里同样跳过，避免无谓请求。
  - `hasReward=false` 的已完成任务不调领取（没奖励，点了也白点）。

### 新增

- **连登兑换**（`redeem` 开关，默认开）
  - `GET /activity/growth/streak` 读连登天数、`redemption_status.tier_*_status`、补登卡余额。
  - 对「天数够且本月未兑」的档位（7d / 14d / 28d）调 `POST /activity/growth/redeem {tier, client_token}`，
    `client_token` 按前端格式生成 `redeem-<tier>-<uuid>`。
  - 成功记录发放明细（`cards_granted` / `credit_granted` / `energy_granted` / `chances_granted`）；
    `409` 一律视为「已领过」（duplicate 是重放，其余是本月已领），不当失败。
- **补登卡**（`makeup` 开关，默认开）
  - **先兑换再补登**：补登卡只能从 7 天档兑换拿到，所以兑换是补登的前置步骤，顺序写死在流程里。
  - `GET /activity/growth/heatmap` 取 `state=broken` 的日期，只补「当月、非今天、非未来」的**最近一天**（对连续天数最有用）。
  - `POST /activity/growth/makeup-cards/use {target_date}`。
  - 卡余额为 0 时**不请求热力图**，不打扰地图；连登不足 7 天会明确提示还差几天。
  - 错误按前端分类翻成人话：`no makeup card` / `future date` / `cannot makeup history month` / `date not broken` / `already made up`。

### 说明

- 两个「连续」是两套计数：签到的连续天数（17 天）≠ 活跃地图的连登（完成一次对话才记录）。
  补登卡补的是后者 —— 它和签到奖励不是同一个池子。
- 执行顺序：任务 → 猫猫 → 兑换 → 补登；每块独立 try/catch，失败只 warn，不影响签到、不触发重试。

### 测试

`tools/test-extension.mjs` 从 102 项扩到 **115 项**，新增：`acceptStatus` 识别、auto 类型不调 accept、
兑换选档与 client_token 格式、兑换后重读余额再补登、补登只选当月最近断登日、卡为 0 不请求热力图、409 当已领处理。

## [1.2.1] - 2026-11-11

修复猫猫派遣被服务端拒绝（`HTTP 400 {"code":400,"msg":"invalid request"}`）。

### 根因

`travel/config` 的返回结构里，除了 `data.locations[]`（每个地点有自己的 `id`），还有
`intro_slogan_items[].expert_id`、`preview_photos[].id` 等一堆 id。上一版用「递归收集所有带 id 的对象」
来挑地点，等于从所有 id 里随机抽一个，抽到 photo / expert 的 id 就必然 400。

### 修复

- `pickDepartLocation` 改为**严格只读 `data.locations[]`**，用地点自己的 `id`；找不到就返回 null，绝不猜。
- 找不到地点时，日志打印 `config` 的真实字段名（`config 字段：...`），下次字段改名能一眼看出来。
- `parseTravelStatus` 改用前端真实状态机：`state = idle / traveling / arrived` + `daily_limit_reached`。
  - `arrived` → 领奖；`traveling` → 只记日志（带地点名与预计回家时间）；`idle` 且额度未用完 → 派猫；额度用完 → 明确说「今天额度已用完，明天再来」。
- 新增 `explainGrowthError()`：把服务端英文文案翻成人话（`daily limit` / `no active buddy` / `already traveling` / `location not available` / `not arrived yet` / `not completed` / `invalid request`）。
  - 顺带修掉上一版的误导：`400 invalid request` 原来被笼统说成「可能今天额度已用完」，现在会说「请求参数无效」，不再把参数错误指成额度问题。

### 测试

`tools/test-extension.mjs` 从 91 项扩到 **102 项**，新增：
- 派遣时**必须**用 `data.locations[].id`，且不能选中 `photo_1` / `expert_42` 这些诱饵 id（回归用例）
- 额度用完 / 旅行中 → 都不派猫，且日志说明原因
- 派遣被 400 拒绝 → 解释为「请求参数无效」，不再误报额度用完
- `config` 没有 `locations[]` → 不瞎派，日志打印实际字段

## [1.2.0] - 2026-11-11

扩展支持**成长体系**：签到之外，顺带把任务中心和猫猫旅行的奖励也领了。

### 新增

- **任务中心**（一次性奖励，约 1700 分）
  - `GET /v2/activity/growth/tasks` 拉清单，按状态分拣：`completed` 领取、`not_accepted` 接受、`in_progress` 不碰、`claimed` 跳过。
  - `POST /activity/growth/tasks/accept { task_codes }` 批量接受（接受后才开始计进度）。
  - `POST /activity/growth/tasks/{code}/claim` 逐个领取。
- **猫猫旅行**（每天约 7 分）
  - `GET .../buddy/travel/status` 判断状态：`traveling` 只记日志等它回来；有奖（`claim_status=unclaimed` / `arrived`）→ `POST .../buddy/travel/claim`；在家 → 从 `.../travel/config` 随机挑地点后 `POST .../buddy/travel/depart { location_id }`。
- 设置页新增三个开关：成长体系总开关、自动接受任务、猫猫派猫（默认全开）。
- 弹窗「今日积分」改为**签到 + 成长合计**；记录里新增 `growth` 字段，通知与日志会带「成长 +N 积分」。

### 设计约束

- **只领不做**：绝不伪造任务完成状态。服务端会校验，没做完的返回拒绝；该人工做的动作（模板任务、关注满 24 小时等）仍要自己做。这与上游实测结论一致。
- **互不影响**：任务中心 / 猫猫各自独立 try/catch，失败只记 warn，**不影响签到结果，也不触发重试**（重试只针对签到本身的网络/未登录）。
- **前缀不对称**：任务清单带 `/v2`、领取/接受不带 —— 照抄前端，不做"统一"。

### 接口来源

逆向自个人中心前端分包（`assets.workbuddy.cn/web/usercenter/.../GrowthI18nProvider-*.js`），不是主应用包。
所以只看 www.workbuddy.cn/app 的主包会以为没有任务中心 —— 记一笔，避免以后重复判断。

### 未做（已评估）

- **补签卡**（`POST /activity/growth/makeup-cards/use`）：能在断签后补，但补签卡稀缺，需人工决定，不自动用。
- **每日抽奖**（`/activity/growth/lottery/draw`）：会消耗次数，可能抽到实物需填地址，不自动抽。
- **积分兑换**（`/activity/growth/redeem`）：消耗积分，属于消费决策，不碰。

### 测试

`tools/test-extension.mjs` 从 62 项扩到 **91 项**，新增：任务接受+领取、`in_progress` 不误领、猫猫领奖后不再派猫、成长全挂不影响签到、关闭开关后零请求。

## [1.1.0] - 2026-11-11

新增**浏览器扩展**（`extension/`），这是目前最省事的用法：装一次，之后每天自动领，不需要 Node、不需要令牌、不碰命令行。

### 新增

- **MV3 扩展**（`extension/`），权限仅 `storage` / `alarms` / `notifications` + 两个域名的 host 权限，不申请 `cookies` / `tabs` / `webRequest`。
  - 定时：`chrome.alarms`（不用 `setInterval`——service worker 会被回收），可配每天触发时间 + `0~N` 分钟随机延迟（默认 09:00 + 0~10）。
  - 日志：全部落 `chrome.storage.local`；弹窗看最近 10 条，设置页看全部并可**导出 `.log` / 复制 / 清空**。
  - 失败提醒：系统通知。**未登录时立刻提醒**（不等重试），并给「去登录」「已登录，重试」两个按钮；点「已登录，重试」当场补领当天。
  - 两类重试分开：网络/5xx → 2 次 × 30 分钟；未登录 → 4 次 × 30 分钟轮询（用户中途登录后自动接上当天）。
  - 角标：`✓` 已领取 / `!` 失败或未登录。
  - 启动补跑：浏览器启动时若当天已过触发时间且尚未领取，补跑一次。
- `tools/test-extension.mjs`：不装浏览器即可验证扩展逻辑（假 `chrome.*` + 假 `fetch` 驱动 `background.js`），**72 项**，覆盖正常领取、已签、未登录、断网、端点回退、设置改动、两个通道切换等。

### 修复（关键，否则扩展会「明明登录却一直 401」）

- **跨站 Cookie 问题**：扩展 service worker 里的 `fetch` 属于跨站请求，WorkBuddy 的登录 Cookie 是 `SameSite=Lax`，
  浏览器不会把它附加到跨站请求上 → 直连稳定 401，用户会以为「没登录」而反复登录无效。
  - 新增 `extension/page-bridge.js` 内容脚本：直连判定未登录时，**自动开一个不抢焦点的后台标签页**，
    从 `www.workbuddy.cn` 页面里发同源请求再确认一次，用完**立即关闭**该标签页。
  - 后台逻辑 `transport` 抽象为 `direct` / `page` 两种通道，解析与判定逻辑完全复用（都在 `lib.js`，可单测）。
  - 日志会写「切到页面上下文」，避免用户把自救行为看成报错。
- **网络异常被误判为未登录**：所有请求都抛异常（断网）时，原实现会报「未登录」并让用户去登录。现在用「是否收到过任何 HTTP 响应」区分：全部连不上 → `error`（走网络重试），收到过 401 → 才是 `unauthorized`。
  - 该缺陷由测试直接暴露（测试先红后绿）。

### 说明

- 端点与业务码沿用 v1.0.6 的逆向结论：`checkin-activity-status` / `daily-checkin`，候选探测 + `/v2` 回退；`1001` 与 `10001` 都视为「已领取」。
- 扩展的定时只在浏览器运行时触发；浏览器完全退出时不会跑，下次启动补跑当天（已领过则跳过）。
- `tools/*.json`、`logs/`、`~/.workbuddy-checkin/` 均为测试临时产物，已清理。

## [1.0.6] - 2026-11-11

### 新增

- **`tools/token-login.js`：令牌获取页**（`node tools/token-login.js`）
  - 在本机 `127.0.0.1:8777` 起一个零依赖的极小服务，页面带本次启动的随机口令（`?k=...`），进程退出即失效。
  - 页面给出一个「书签脚本」（bookmarklet）：在已登录的 WorkBuddy 网页版上点一下，它会
    1. 调 `/console/accounts` 确认登录态，取 `uid` / 域名；
    2. 从 `document.cookie` 与 `localStorage`/`sessionStorage` 里搜集候选凭据（JWT 形态优先，其次 `token`/`auth`/`session` 类键名）；
    3. **顺手在网页端把当天的签到领掉**（同源 Cookie 请求，不依赖 Bearer）；
    4. 结果 POST 回本机服务 → 直接写入 `~/.workbuddy-checkin/token`（权限 600）。
  - 抓不到可复用令牌时不报错也不写脏数据：明确说明网页版是 httpOnly Cookie 鉴权（JS 读不到），并给出「每天点书签」「桌面端路径」「手动粘贴」三个选项。
  - 回传接口只接受 `*.workbuddy.cn` / `*.workbuddy.ai` 来源，并应答 `Access-Control-Allow-Private-Network`（Chrome 私有网络访问预检）。
- 页面内附带「手动粘贴令牌」入口，保存时自动剥离 `Bearer ` 前缀与空白。

### 修复

- **签到端点写死错了一个**：脚本一直打 `/billing/meter/checkin-status`，而**网页版客户端（www.workbuddy.cn/app）用的是 `/billing/meter/checkin-activity-status`**，Windows 版脚本用的是 `/v2/billing/meter/checkin-status`。现改为按候选依次探测（`checkin-activity-status` → `checkin-status` → `/v2/...`），遇到 404 才换下一个，其余状态码就地判定。领取端点跟随状态端点的 `/v2` 前缀。401 日志同时打印实际请求的完整端点，便于判断是域名问题还是令牌问题。
- **`daily-checkin` 响应解析错层**：网页版客户端读的是顶层 `credit` / `streak_days`（`t.credit`），而脚本读 `data.credit`，因此签到成功也会打出 `credit=None streak_days=None`。改为顶层优先、`data` 兜底。
- `today_checked_in` 同样改为「`data` 内优先、顶层兜底」，兼容两种返回形态。

### 说明

- 端点与字段是**从当前线上前端包静态逆向**得出的（`static.workbuddy.cn/web/agents/*/main-*.js` 里的 `checkinStatus()` / `checkin()`），不是抓包结果；无令牌时三个端点都返回 openresty 的 401，无法用无鉴权请求验证存在性，因此采用「候选探测」而不是硬编码单一端点。

## [1.0.5] - 2026-11-11

### 修复

- **文档里的取令牌路径是错的**：1.0.4 写的是「帮助 → 切换开发人员工具」，但生产构建的 WorkBuddy 桌面端**没有这个菜单项**（`app.asar` 里该项只挂在 `isDev` 分支上，`Ctrl+Shift+I` 也没注册），用户照着做会卡死。已改为两条真正可行的路径：
  - A（推荐）浏览器登录 <https://copilot.tencent.com> → `F12` → Network → 任一请求 → `Authorization: Bearer <值>`。签到接口与网页版同源（`copilot.tencent.com/billing/meter/*`），所以网页端拿到的令牌可直接用。
  - B 桌面端远程调试：完全退出后 `env -u ELECTRON_RUN_AS_NODE "/Applications/WorkBuddy.app/Contents/MacOS/Electron" --remote-debugging-port=9222`，浏览器打开 `http://127.0.0.1:9222` 即完整 DevTools。
    - 注意：应用有单实例锁，**必须真的退出**才能拉起带调试端口的实例；`ELECTRON_RUN_AS_NODE` 未清除时 Electron 会以纯 Node 模式启动并把 Chromium 开关当成 `bad option`。
- 补充结论：**诊断导出的日志里没有令牌**。客户端「诊断工具 → 网络检测」只记录 `authorizationPresent`（布尔）与 `authorizationScheme`，不落具体值；导出包内 grep 到的 `Bearer` 全部来自本仓库 README/对话文本自身。

### 新增

- `setup.sh --from-clipboard`：从剪贴板读取令牌并保存，**避免令牌进入 shell 历史**（`--token <token>` 会留在 `.zsh_history`）。顺带容错：自动去掉首尾空白/换行与误粘贴的 `Bearer ` 前缀，再校验长度与空白字符。
- `setup.ps1` 提示文案同步（Windows 侧仍为 `-Token`，未加剪贴板参数）。

### 修复（顺带发现的真问题：签到接口域名）

- **WorkBuddy 账户的令牌签发域是 `www.workbuddy.cn`，而脚本写死了 `copilot.tencent.com`**。本机登录态里 `auth.domain = www.workbuddy.cn`（旧 CodeBuddy 账户才是 `copilot.tencent.com`）。两个域名下 `POST /billing/meter/checkin-status` 都存在且无令牌时都返回 401，所以「域名写错」会表现成**拿着有效令牌也稳定 401**，极难排查。
- 现在按签发域自动选接口：`WB_CHECKIN_API` > 令牌文件 `DOMAIN=` > 本机登录态 `auth.domain` > 默认 `copilot.tencent.com`。
  - `auth.domain` 是**明文元数据**，即使 `accessToken` 被静态加密也能读；`decrypt-token.js` 在退出码 7 的报错分支和显式令牌分支都会输出 `AUTH_DOMAIN:`（后者用登录态元数据补齐，因为令牌本身不带域名）。
  - `setup.sh` 保存令牌时会把 `DOMAIN=` 一并写进令牌文件，令牌文件因此自带域名，换机器也能用。
  - 401 日志里带上实际请求的「接口」，域名不匹配一眼可见。

## [1.0.4] - 2026-11-11

### 修复

- **脚本 CRLF 行尾导致 bash 连解析都过不去**（`scripts/*.sh`、`scripts/decrypt-token.js`）：Windows 侧回传的文件是 CRLF，`\r` 粘在每行末尾，于是
  - `set -uo pipefail\r` → `bash: set: pipefail: invalid option name`
  - `find_node() {\r` → `bash: syntax error near unexpected token '{'`（函数定义解析失败，后续整段失效）
  - 行号也被回车覆盖：`line 14:` 显示成 `e 14:`
  - **三条报错同源**，不是三个 bug。已全部转 LF（`file` 验证），并新增 `.gitattributes` 固化：`*.sh/*.js/*.mjs` → `eol=lf`，`*.ps1/*.cmd/*.bat` → `eol=crlf`（PowerShell 5.1 对 LF 兼容差，保持 CRLF+BOM）。
- **`$VAR` 紧跟全角标点触发 `unbound variable` 崩溃**（`checkin.sh`，5 处）：bash 3.2 把 `）`的首字节并进了变量名，`set -u` 下直接 `exit 127`。
  - 复现：`bash -c 'set -u; X=401; echo "HTTP $X）"'` → `bash: X\xef: unbound variable`
  - **后果**：`HTTP ${HTTP_CODE}` 所在的所有错误分支（401/403、非 200、空响应）全部崩溃——也就是"令牌过期"这种最需要提示的场景反而什么都不打，日志里连一行都没有。改为 `${VAR}` 形式。

### 变更

- **适配「静态加密登录态」**：新版 WorkBuddy 桌面端把 `auth.accessToken` 从明文字符串换成了 AES-256-GCM 信封 `{ "$wbEncrypted": 1, "envelope": "<base64>" }`。`decrypt-token.js` 原逻辑只认 `typeof token === "string"`，会掉进旧版 `state.vscdb` 分支并**误报「未找到新版明文认证文件」**（真实原因完全不同，会把人带偏）。
  - 新增显式令牌源，优先级最高：`WB_CHECKIN_TOKEN` 环境变量 → 令牌文件（`WB_CHECKIN_TOKEN_FILE`，默认 `~/.workbuddy-checkin/token`，权限 600）。
  - 检出信封时以**独立退出码 7** 结束，并输出可直接照做的指引，不再走 Electron 兜底、不再误报。
  - `setup.sh --token <token>` / `setup.ps1 -Token <token>`：保存令牌（600 / ACL 限当前用户）后立即验证链路。
  - `checkin.sh` / `checkin.ps1` 在静态加密态下给出「执行 setup --token」的针对性提示，而不是笼统的「请确认已登录」。
  - 令牌有效期约 30 天（登录态里 `expiresIn=2592000`），过期后重新提供一次即可。

### 为什么没做「完整解密」（技术结论，避免重复劳动）

排查结论：**在上游不放开的前提下，纯外部脚本解不出来**，不是实现难度问题。

1. 令牌信封：`{suite:1, keyId, nonce, authTag, ciphertext}`，AES-256-GCM；AAD 为 `"WB-AAD\0" + 0x01 + LP("WBEV1") + LP("sym-v1") + u32(suite) + LP(keyId) + 0x01/0x02(framing) + 0x00(sequence) + 0x00(final)`，`LP` = 4 字节大端长度 + UTF-8。
2. 密钥链：`~/.workbuddy/keyblob` 里 32 字节 master key 被 `static-v1` slot 用 protector key 包裹；`auth` 信封的 `keyId`（`9127dea1b44020a7`）**等于** keyblob 的 `protectorKeyId`，说明令牌直接用 protector key 加密，连 keyblob 都不用碰。
3. 但 protector key 的载荷 `{version:1, atRestSecretKey:"<base64 32B>"}` 由桌面端原生模块（`electron.workbuddyStorage`）在运行时注入，磁盘上**没有**明文：`local_storage`、`logs`、`audit-log`、trace 全部查过；构建策略 `fields` 在 `app.asar` 里是硬编码，`WORKBUDDY_AT_REST_ENCRYPTION` 只由主进程**写**给子进程，外部设置无效。
4. 因此要解就得逆向原生模块（`@ban-dal/os-bridge` 一类安全组件），成本/风险都超过收益。**显式令牌 + 30 天有效期**是更合理的工程解；上游若改回明文或开放导出，本脚本无需改动即可恢复自动读取。

### 已知限制

- `setup.ps1` / `checkin.ps1` 的本次改动**未在 Windows 实机验证**（开发机为 macOS，无 PowerShell）。改动限于参数解析与提示分支，未触碰请求签名逻辑。

## [1.0.3] - 2026-08-12

### 修复

- **Windows 读不到新版明文登录态导致持续 401**（#73 / PR #74）：`decrypt-token.js` 的 win32 候选原本只探 `%APPDATA%\CodeBuddyExtension\...`，而当前桌面端实际把明文登录态写在 **`%LOCALAPPDATA%`**。读不到新文件时会回退旧版 `state.vscdb` 分支，取到**过期的历史会话令牌**，表现为「令牌能读出来、但接口一律 401」。现改为 **优先 `%LOCALAPPDATA%`、回退 `%APPDATA%`**。
  - **这是本次唯一修复 401 的改动。**

- **假 401 导致当日签到被跳过、连续签到中断**（`checkin.sh` / `checkin.ps1`，合并 PR #74 时发现）：401 判定原本是**扫响应体子串**（`grep -qi "401\|unauthorized"` / `$Status -match "401|unauthorized"`），而响应体带一个**每次随机的 UUID `requestId`**。UUID 里恰好出现 `401` 时，HTTP 200、`code=0` 的正常响应会被判成「令牌已过期」，脚本在调 `daily-checkin` **之前**就 `exit 1`。
  - **后果**：当日积分未领取；更贵的是**连续签到中断**，第 7 天的 1000 积分奖励作废。
  - **概率**：蒙特卡洛 20 万次实测 **0.566%/次**（理论 22/4096）。按每天跑一次计，**一年内约 87% 概率至少踩中一次**，期望每 177 天一次。
  - **修复**：改用 `curl -w '\n%{http_code}'` 取真实 HTTP 状态码，与响应体分离判定；`000`→网络异常、`401/403`→令牌失效、其他非 `200`→带状态码报错。日志从此能区分「网络异常 / 鉴权失败 / 业务失败」，便于事后诊断。
  - **验证**：4 例离线单测全绿（含「200 + requestId 含 401」这条关键用例，旧实现在此误判、新实现正确放行）；`checkin.sh` 端到端连跑 3 次均 `exit 0` 且幂等正确。

### 改进

- **请求签名对齐桌面端 `buildHeaders`**（`checkin.ps1`）：路径改用 `/v2/billing/meter/*`，并附带 `X-User-Id: <account.uid>`；有 `auth.domain` 时加 `X-Domain`，企业账号另加 `X-Enterprise-Id` / `X-Tenant-Id`。
  - **定位：前向兼容加固，不是 401 的修复项。** 网关当前并不强制这两项（见下方验证矩阵）。对齐上游的意义在于——官方哪天真收紧鉴权时，跟随桌面端的实现不会跟着挂。
- `decrypt-token.js` 在两处成功分支追加输出 `ACCOUNT_UID` / `AUTH_DOMAIN` / `ENTERPRISE_ID` 三行（纯 stdout，不落盘、不写日志），供调用方拼装鉴权头。
  - **调用方契约**：stdout 不再是单行，消费方**必须**按行前缀过滤（`grep '^DECRYPT_RESULT:'` / `Select-String`），不可整段捕获。现有 4 个消费方（`checkin.sh:79,87`、`setup.sh:55,136`、`checkin.ps1`、`setup.ps1:54,124`）均已是前缀过滤写法，无需改动。

### 根因更正（重要）

Issue #73 与 PR #74 原文断言「APISIX 网关只在 `/v2/billing/meter/*` 接受，**缺前缀直接 401**」「网关要求 `X-User-Id`，**缺此项同样 401**」。**这两条经实测证伪，不要据此排查后续 401。**

合并前用真实令牌跑的 2×2 只读验证矩阵（`checkin-status`，个人账号，macOS）：

| 组合 | 结果 |
|---|---|
| 旧 `/billing/meter` + 仅 `Authorization` | HTTP 200 `code=0 msg=OK` |
| 旧 `/billing/meter` + 完整头 | HTTP 200 `code=0` |
| `/v2/billing/meter` + 仅 `Authorization` | HTTP 200 `code=0` |
| `/v2/billing/meter` + 完整头 | HTTP 200 `code=0` |

写接口另行验证：`checkin.sh`（旧路径、不带 `X-User-Id`）实跑 `daily-checkin` 返回业务码 `code=10001`（今日已签到），**非 401**。

原实验之所以得出错误结论，是因为一次同时改动了三个变量（路径、请求头、**令牌来源**），而真正起作用的是第三个——手工 curl 用的是从 `%LOCALAPPDATA%` 现取的新鲜令牌。

**已知验证边界**：矩阵在个人账号（无 `enterpriseId`）、单一区域、单一时间点取得；企业账号或后续网关策略调整下的行为未覆盖。

### 文档

- `SKILL.md`：版本升至 1.0.3；原理章节补充 `/v2/` 与 `buildHeaders` 签名及其"非必要条件"的定位；平台表 Windows 行改为 `%LOCALAPPDATA%`（回退 `%APPDATA%`）；安全说明的网络访问范围补 `/v2/` 路径；排错新增「Windows 已登录却持续 401」条目，明确指向令牌来源而非请求构造。
- `decrypt-token.js`：恢复 PR #74 中被一并删除的维护性注释——跨平台登录态路径清单（并修正 Windows 为 `%LOCALAPPDATA%`）、依赖与运行方式、`emitAndExit` 延迟退出的原因、`app.setName` 必须早于 ready 的警告、python3 回退的信任边界说明。
- `checkin.ps1`：恢复 `today_checked_in` 字段不可靠的说明（它是 `code=10001` 幂等兜底存在的理由）、`ELECTRON_RUN_AS_NODE` 必须移除的原因、`WB_CHECKIN_JITTER` 用法说明。

### 已知限制

- `checkin.sh`（macOS / Linux）仍使用不带 `/v2/` 前缀、仅 `Authorization` 的旧写法。实测可用，故本版未改动；如需与桌面端完全对齐可后续收敛。
- Windows 侧（`%LOCALAPPDATA%` 路径修复、`/v2/` 签名、`checkin.ps1` 的 HTTP 状态码判定）**未在 Windows 实机验证**，本版验证均在 macOS 完成；以 PR #74 提交者与后续使用者反馈为准。

## [1.0.2] - 2026-08-06

### 修复

- **兼容 WorkBuddy 桌面端 v5.3.8 新版登录态存储**（#68）：v5.3.8 不再把当前登录态写入 `state.vscdb`，改用明文 JSON 文件 `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`（Windows/Linux 同构路径）。旧版（≤1.0.1）只认 `state.vscdb`，导致连续报「获取令牌失败（未知原因）」。
  - `decrypt-token.js` 改为**新版明文文件优先、旧版 `state.vscdb` 回退**；新版分支纯 Node 读取 `auth.accessToken`，无需 Electron `safeStorage` 解密。
  - `require("electron")` 包裹 try/catch，脚本可由普通 `node` 直接执行。
  - 统一 `emitAndExit()`（`process.stdout.write` 后延迟 ~200ms 退出），避免 `console.log` 后立即 `app.exit()` 导致 stdout 未 flush。
- **macOS 运行时策略改为 Node 优先**（#68）：直接调用 WorkBuddy.app 的 Electron 二进制会启动主应用而非执行脚本；新版明文文件用纯 Node 即可读取，无需依赖应用内 Electron。`checkin.sh`/`checkin.ps1`/`setup.sh`/`setup.ps1` 均改为 Node 优先、Electron 回退，新增 `WB_CHECKIN_NODE=<path>` 环境变量。
- **`daily-checkin` 的 `code=10001` 识别为已签到**（#68）：v5.3.8 实测 `checkin-status` 的 `today_checked_in` 不可靠（签到成功后仍为 `false`），当日重跑会再次调 `daily-checkin` 并返回 `code=10001`（今天已签到）；旧版将其误报为「签到未成功」，导致幂等分支失效。1.0.2 起正确报告「今日已签到，无需重复领取」。

### 改进

- 文档同步：`SKILL.md` / `references/dependencies.md` 更新原理、平台路径、依赖（Electron 降级为仅旧版可选）、环境变量（新增 `WB_CHECKIN_NODE`）、排错（v5.3.8 专项条目）。
- `setup.sh`/`setup.ps1`：v5.3.8 用户（仅 Node、无 Electron）不再被误判为「未找到 Electron」而失败。

### 合并前代码评审修复

- **`checkin.sh` / `checkin.ps1` Electron 回退条件修正（高）**：原实现仅当 Node 输出为空才回退 Electron；但旧版 `state.vscdb` 账户在装有 Node 的机器上，纯 Node 会输出非空的 `ERR`（无法解 safeStorage），导致 Electron 回退被跳过、误报失败（对 v1.0.1 旧版账户的回归）。改为「空 或 ERR」均回退。
- **`decrypt-token.js` 部分明文文件不再硬失败**：明文文件存在但缺 `auth.accessToken`（如升级中途 / 写入中）或解析失败时，不再 `exit 5`，而是落入旧版 `state.vscdb` 分支兜底。
- **`decrypt-token.js` 旧版读取异常可观测**：`readValue` 抛错（如 `node:sqlite` 不可用且未开 python3 回退）时不再裸抛，统一经 `DECRYPT_RESULT:ERR` 带原因输出，避免「未知原因」式失败。
- **`checkin.sh` `WB_CHECKIN_JITTER=0` / 非数字不再触发除零中止**：改为先 `[ -gt 0 ]` 校验。
- **`checkin.sh` 缺 `python3` 不再误报「签到未成功」**：结果解析为空时改为提示「请求已提交，缺 python3 无法解析」，避免服务端已成功却被报失败。

### 已知限制

### 已知限制

- Windows / Linux 的 `CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` 路径基于 v5.3.8 桌面端约定推导，已在 macOS 实测命中，其他平台待真实环境确认。

## [1.0.1] - 2026-08-05

### 改进

- 凭据安全：解密成功时向 stderr 输出安全提示（不污染 token 管道）；python3 回退默认关闭，需 `WB_CHECKIN_ALLOW_PY_FALLBACK=1` 启用
- 安装安全：`setup.sh`/`setup.ps1` 自动 `npm install electron` 默认关闭，需 `WB_CHECKIN_AUTO_INSTALL_ELECTRON=1` 才下载，默认提示手动指定路径并声明供应链风险
- 文档：SKILL.md 安全说明补强，新增「所需权限」清单与「为何需要这些能力」上下文说明，回应 SkillSpector 审计 findings

### 技术优化

- `checkin.sh`/`checkin.ps1` 头部注释补充凭据安全说明

## [1.0.0] - 2026-08-05

### 新增

- 初始版本：WorkBuddy 每日积分自动签到 skill 正式纳入 legal-skills 仓库
- 跨平台签到脚本：`scripts/checkin.sh`（macOS/Linux/Git Bash）与 `scripts/checkin.ps1`（Windows PowerShell，兼容 PS 5.1）
- 令牌解密脚本 `scripts/decrypt-token.js`：基于 Electron `safeStorage` 解密本地 `state.vscdb` 会话，`node:sqlite` 不可用时自动回退 `python3`
- 一键安装脚本 `scripts/setup.sh` / `scripts/setup.ps1`：自动检测或通过 npm 下载 Electron 运行时，并验证解密链路
- 多 Agent 框架适配（WorkBuddy 自动化任务 / Claude Code / Codex / OpenClaw / 纯终端），定时方式覆盖 crontab / launchd / schtasks / WorkBuddy recurring
- 幂等保护：每次运行先查 `checkin-status`，今日已签到立即跳过，支持一天多时间点补签（默认推荐 09/12/15/18/21 点）
- 随机错峰：`WB_CHECKIN_JITTER=<秒>` 环境变量让脚本启动前随机等待，避免整点风暴
- 兼容旧版应用名 CodeBuddy：`WB_CHECKIN_APP_NAME=CodeBuddy` 覆盖钥匙串绑定名

### 设计要点

- **全本机运行**：不含任何后端服务，令牌仅发往腾讯官方接口 `copilot.tencent.com`，不上传第三方
- **令牌不落盘**：仅在内存中传递；`logs/` 只记录签到结果（积分/连续天数），不含令牌
- **沙箱兼容**：WorkBuddy 等 Agent 沙箱默认设 `ELECTRON_RUN_AS_NODE=1` 会导致 `require('electron')` 拿不到 `safeStorage`，脚本已用 `env -u`（sh）/ `Remove-Item Env:`（ps1）显式处理

### 已知限制

- 签到按自然日结算，若整天未开机则当日无法补签，次日首个运行点自动重新开始（连续天数会重置）
- 令牌过期（401）需打开 WorkBuddy 桌面端刷新登录态，次日自动恢复
- macOS 应用名与钥匙串绑定：新装为 `WorkBuddy`，旧版迁移可能仍是 `CodeBuddy`

### 合规提示

- 本 skill 等价于「每天手动点一次领取今日礼包」，仅操作本机当前登录用户自己的 WorkBuddy 账户
- 请勿用于他人账户、批量注册刷分或任何违反 WorkBuddy 用户协议的用途
- 使用者需自行承担使用风险，确保来源可信
