---
name: workbuddy-checkin
description: WorkBuddy（腾讯 AI 办公工作台）每日积分自动领取。以浏览器扩展形式运行：定时签到、任务中心领奖、猫猫旅行循环、连登兑换与补登卡，带日志与失败通知。触发词：WorkBuddy 签到、每日积分、加油站、猫猫旅行、check-in、credits。
version: "1.5.0"
license: MIT
---

# WorkBuddy 每日积分签到

自动领取 WorkBuddy 的每日积分，并把「Buddy 加油站」下其他能领的奖励一并处理。
实现形式是**浏览器扩展**（`extension/`，Manifest V3），不在本机常驻进程、不需要令牌、不需要 Node。

## 覆盖范围

| 能力 | 说明 |
|---|---|
| 每日签到 | `POST /billing/meter/daily-checkin`，每日 +100 积分；`checkin-activity-status` 先查后领，幂等 |
| 任务中心 | `GET /v2/activity/growth/tasks` 拉清单；`POST /activity/growth/tasks/accept` 接受；`POST /activity/growth/tasks/{code}/claim` 领取已完成任务 |
| 猫猫旅行 | `buddy/travel/status` → `claim` 领奖 → `depart` 再派；按 `arrive_at` 排下一趟（4 小时一轮） |
| 连登兑换 | `GET /activity/growth/streak` → `POST /activity/growth/redeem {tier, client_token}`；补登卡来自 7 天档 |
| 补登卡 | `GET /activity/growth/heatmap` 找当月 `state=broken` → `POST /activity/growth/makeup-cards/use {target_date}` |

顺序固定为 **任务 → 猫猫 → 兑换 → 补登**：补登卡只能从兑换拿到，所以兑换必须在补登之前。

## 关键实现约束（改动前务必读）

- **走接口，不做 DOM 点击**。点界面会触发 `workbuddy://` 深链弹窗（要人工点取消），且界面改版即失效。
- **参数不要做无谓类型转换**。`location_id` 是数字就发数字；`String()` 之后服务端判 `invalid request`（实测踩过）。
- **跨站 Cookie 问题**：扩展后台的 `fetch` 属跨站，`SameSite=Lax` 的登录 Cookie 带不上 → 直连稳定 401。
  `page-bridge.js` 负责兜底：判定未登录时开一个后台标签页发同源请求，用完立即关闭。
- **只领不做**：不伪造任务完成状态（服务端校验）。`taskType=auto/beginner` 的任务前端也不调 accept。
- **每块独立 try/catch**：任务/猫猫/兑换/补登任何一块失败只记 warn，不影响签到、不触发重试。
- **额度用完就停**：`daily_limit_reached` 或返回文案含 daily limit/quota/上限/额度 → 记 info + 撤掉当天回程闹钟。

## 安装

1. `chrome://extensions`（Edge：`edge://extensions`）→ 开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选 `extension/`
3. 设置页填每天触发时间（默认 09:00）

前提：浏览器已登录 <https://www.workbuddy.cn/app>。

## 排错

| 现象 | 处理 |
|---|---|
| 一直「未登录」 | 确认浏览器能打开并登录 workbuddy.cn/app；日志出现「切到页面上下文」是自救流程，不是错误 |
| 猫猫派遣失败 | 看日志里的「诊断：」两行（已试过的字段值、`config.locations[0]`、`travel/status` 原文） |
| 任务「可领 0」 | 任务要真做完才能领，服务端会校验 |
| 到点没跑 | `chrome.alarms` 只在浏览器运行时触发；完全退出当天不跑，下次启动补跑 |

两套计数不要混：签到接口的 `streak_days`（对应产品「全年活跃记录」天数，仅展示）与成长计划的 `streak.days`（活跃地图口径，完成对话才计入）。

## 权限

| 权限 | 用途 |
|---|---|
| `storage` | 设置、日志、上次结果（全部本地） |
| `alarms` | 每日定时 + 猫猫回程检查 + 失败重试 |
| `notifications` | 失败/未登录提醒 |
| `host_permissions` | 仅 `www.workbuddy.cn`、`copilot.tencent.com` |

不申请 `cookies` / `tabs` / `webRequest`；不读取 Cookie 值、不上传任何数据。

## 开发

```bash
node tools/test-extension.mjs   # 130 项，假 chrome.* + 假 fetch 驱动真实 background.js
```
