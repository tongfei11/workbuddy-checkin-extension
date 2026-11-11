// ============================================================
// background.js —— WorkBuddy 每日签到（MV3 service worker）
//
// 关键点：
// 1. 用浏览器自带的 Cookie 调官方接口（credentials: "include"），
//    不需要令牌，也不碰 httpOnly Cookie 的值。
// 2. 定时用 chrome.alarms（不是 setInterval）—— service worker 会被回收，
//    只有 alarms 能唤醒它。
// 3. 日志、上次结果全部落 chrome.storage.local，可在设置页导出。
// ============================================================

import {
  normalizeSettings,
  domainCandidates,
  endpointCandidates,
  ACCOUNTS_PATH,
  STATUS_PATH,
  CHECKIN_PATH,
  nextRunAt,
  retryAt,
  retryPolicy,
  fmtDateTime,
  todayKey,
  parseTimeOfDay,
  parseStatusResponse,
  parseCheckinResponse,
  trimLogs,
  formatLogLine,
  describeResult,
  // 成长体系（任务中心 / 猫猫旅行）
  TASKS_PATH,
  TASK_ACCEPT_PATH,
  taskClaimPath,
  TRAVEL_STATUS_PATH,
  TRAVEL_CONFIG_PATH,
  TRAVEL_DEPART_PATH,
  TRAVEL_CLAIM_PATH,
  parseTasksResponse,
  parseTravelStatus,
  parseClaimResult,
  pickDepartLocation,
  departCandidates,
  explainGrowthError,
  STREAK_PATH,
  REDEEM_PATH,
  HEATMAP_PATH,
  MAKEUP_PATH,
  parseStreak,
  redeemCandidates,
  parseRedeemResult,
  parseHeatmap,
  pickMakeupDate,
  explainMakeupError,
} from "./lib.js";

const ALARM_DAILY = "wb-checkin-daily";
const ALARM_RETRY = "wb-checkin-retry";
const ALARM_TRAVEL = "wb-checkin-travel";
const K = { settings: "settings", last: "last", logs: "logs", retry: "retryState", travel: "travelState" };
const FETCH_TIMEOUT_MS = 15000;

let running = false;

// ---------- 传输通道：direct（service worker 直连） / page（页面上下文） ----------
// 直连是跨站请求，SameSite 登录 Cookie 可能不带 → 401；
// 这时切到 page：在 www.workbuddy.cn 的标签页里用内容脚本发同源请求。
let transport = "direct";
let pageTabId = null;
// 本轮流程里的成长体系结果，由 finish() 收进记录后清空
let pendingGrowth = null;
let pageTabOwned = false; // 这个标签页是不是我们自己开的（是才关）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensurePageTab() {
  if (pageTabId != null) {
    try {
      await chrome.tabs.get(pageTabId);
      return pageTabId;
    } catch {
      pageTabId = null;
      pageTabOwned = false;
    }
  }
  const tab = await chrome.tabs.create({ url: LOGIN_URL, active: false });
  pageTabId = tab.id;
  pageTabOwned = true;

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(300);
    try {
      const r = await chrome.tabs.sendMessage(pageTabId, { type: "wb-ping" });
      if (r && r.ok) return pageTabId;
    } catch {
      // 内容脚本还没注入，继续等
    }
  }
  throw new Error("页面上下文未就绪（内容脚本没加载，可能页面未加载完成）");
}

async function closePageTab() {
  if (pageTabId != null && pageTabOwned) {
    try {
      await chrome.tabs.remove(pageTabId);
    } catch {
      /* 标签页可能已被用户关掉 */
    }
  }
  pageTabId = null;
  pageTabOwned = false;
}

async function apiViaPage(url, { method = "POST", body } = {}) {
  const tabId = await ensurePageTab();
  const r = await chrome.tabs.sendMessage(tabId, { type: "wb-http", url, method, body });
  if (!r || r.ok !== true) {
    const e = new Error(r && r.error ? r.error : "页面内请求失败");
    e.name = "PageBridgeError";
    throw e;
  }
  return { status: r.status, ok: r.resOk, json: r.json, text: r.text || "" };
}

// 切到页面上下文重试；返回是否切换成功
async function switchToPageMode() {
  if (transport === "page") return false;
  try {
    await ensurePageTab();
    transport = "page";
    await log("info", "直连请求未通过（常见原因：跨站 Cookie 限制），切到页面上下文再确认一次");
    return true;
  } catch (e) {
    await log("warn", `页面上下文不可用：${errText(e)}`);
    await closePageTab();
    return false;
  }
}

// ---------- 存储读写 ----------
async function getSettings() {
  const got = await chrome.storage.local.get(K.settings);
  return normalizeSettings(got[K.settings]);
}

async function log(lvl, msg) {
  const got = await chrome.storage.local.get([K.logs, K.settings]);
  const list = Array.isArray(got[K.logs]) ? got[K.logs] : [];
  const settings = normalizeSettings(got[K.settings]);
  const entry = { t: Date.now(), lvl, msg: String(msg == null ? "" : msg).slice(0, 400) };
  await chrome.storage.local.set({ [K.logs]: trimLogs([...list, entry], settings.logRetain) });
  const line = formatLogLine(entry);
  if (lvl === "err") console.error(line);
  else console.log(line);
}

// ---------- HTTP ----------
function errText(e) {
  if (!e) return "未知错误";
  if (e.name === "AbortError") return `请求超时（${FETCH_TIMEOUT_MS / 1000}s）`;
  return e.message || String(e);
}

async function api(url, { method = "POST", body } = {}) {
  if (transport === "page") return apiViaPage(url, { method, body });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const init = {
      method,
      credentials: "include", // 关键：带上浏览器里已登录的 Cookie
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    };
    if (method !== "GET" && method !== "HEAD") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body || {});
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // 网关错误页/空响应，保留原文供日志
    }
    return { status: res.status, ok: res.ok, json, text: text.slice(0, 240) };
  } finally {
    clearTimeout(timer);
  }
}

// 登录态检查：网页端就是靠这个接口判断的（status() 里用的同一个）
async function sessionCheck(base) {
  const r = await api(base + ACCOUNTS_PATH, { method: "GET" });
  if (r.status === 401 || r.status === 403) return { loggedIn: false, status: r.status };
  if (!r.ok) return { loggedIn: false, status: r.status, note: r.text };
  const accounts = r.json && r.json.data && r.json.data.accounts;
  if (Array.isArray(accounts) && accounts.length) {
    const a = accounts[0] || {};
    const uid = a.uid != null ? a.uid : a.uin != null ? a.uin : a.id;
    const name = a.nickname || a.name || a.email || a.account_name || "";
    return { loggedIn: true, status: r.status, uid: uid == null ? "" : String(uid), name: String(name) };
  }
  return { loggedIn: Boolean(r.json), status: r.status };
}

// 端点探测：先打无前缀（网页版），404 再打 /v2（桌面端旧路径）
async function postWithFallback(base, path, body) {
  let last = null;
  for (const c of endpointCandidates(base, path)) {
    const res = await api(c.url, { method: "POST", body });
    last = { url: c.url, path: c.path, prefix: c.prefix, res };
    if (res.status === 404) continue;
    return last;
  }
  return last;
}

// ---------- 定时 ----------
async function scheduleDaily(settings, withLog = true) {
  await chrome.alarms.clear(ALARM_DAILY);
  if (!settings.enabled) {
    if (withLog) await log("info", "定时签到已关闭，不再安排下次运行");
    return null;
  }
  const at = nextRunAt(settings);
  await chrome.alarms.create(ALARM_DAILY, { when: at });
  if (withLog) {
    await log(
      "info",
      `下次运行：${fmtDateTime(at)}（每天 ${settings.time}${settings.jitterMin ? ` +0~${settings.jitterMin} 分钟随机` : ""}）`
    );
  }
  return at;
}

// 猫猫回程检查：按服务端返回的 arrive_at 排一次，到点只领奖、不再派猫。
// 为什么需要它：每天只跑一次的话，猫 4 小时后回来要等到明天那次运行才领得到奖励。
async function scheduleTravelFollowUp(settings, arriveAtSec) {
  await chrome.alarms.clear(ALARM_TRAVEL);
  if (!settings.travel || !settings.travelFollowUp) return null;

  // arrive_at 是秒级时间戳；留 60 秒余量，避免刚好卡在边界上又判定「还在路上」
  const target = arriveAtSec ? arriveAtSec * 1000 + 60000 : Date.now() + 4 * 3600 * 1000 + 5 * 60000;
  const when = Math.max(target, Date.now() + 120000); // 别排到过去

  // 次数护栏：服务端时间可能漂移，避免无限重排
  const got = await chrome.storage.local.get(K.travel);
  const st = got[K.travel] || {};
  const day = todayKey();
  const n = st.day === day ? Number(st.n) || 0 : 0;
  if (n >= 12) {
    await log("warn", "猫猫：今天已重排 12 次回程检查，先停手（明天照常）");
    return null;
  }
  await chrome.storage.local.set({ [K.travel]: { day, n: n + 1 } });

  await chrome.alarms.create(ALARM_TRAVEL, { when });
  await log("info", `猫猫：回程检查已排定 ${fmtDateTime(when).slice(5, 16)}`);
  return when;
}

// 失败重试：网络问题短间隔重试几次；未登录则长间隔轮询——
// 用户中途登录后，下一次轮询会自动接上并把当天领掉，不用他一直守着。
async function planRetry(settings, record) {
  const policy = retryPolicy(settings, record.status);
  const got = await chrome.storage.local.get(K.retry);
  const st = got[K.retry] || {};
  const day = todayKey();
  const sameKind = st.day === day && st.kind === (policy ? policy.kind : st.kind);
  let n = sameKind ? Number(st.n) || 0 : 0;

  if (!policy || n >= policy.max) {
    await chrome.storage.local.set({ [K.retry]: { day, n: 0, kind: policy ? policy.kind : "" } });
    await chrome.alarms.clear(ALARM_RETRY);
    return null;
  }

  n += 1;
  const at = retryAt(settings, record.status);
  await chrome.storage.local.set({ [K.retry]: { day, n, kind: policy.kind } });
  await chrome.alarms.create(ALARM_RETRY, { when: at });
  return { at, n, max: policy.max, label: policy.label, kind: policy.kind };
}

// ---------- 通知 / 角标 ----------
const LOGIN_URL = "https://www.workbuddy.cn/app";

function notifIdFor(record) {
  return `wb-checkin-${record.status}-${record.at}`;
}

function notifStatusOf(id) {
  const m = /^wb-checkin-([a-z]+)-/.exec(String(id || ""));
  return m ? m[1] : "";
}

async function notify(record, opts = {}) {
  const d = describeResult(record);
  const unauth = record.status === "unauthorized";
  const failed = unauth || record.status === "error";
  const recovered = opts.recovered === true;

  const title = recovered
    ? `WorkBuddy 已恢复签到 · ${d.title}`
    : failed
    ? `WorkBuddy 签到失败 · ${d.title}`
    : `WorkBuddy 签到成功 · ${d.title}`;

  const message = [
    d.detail,
    unauth ? "登录后点下面「已登录，重试」立刻领取，不用等到明天。" : "",
    fmtDateTime(record.at),
  ]
    .filter(Boolean)
    .join("\n");

  // 未登录 → 给「去登录 / 已登录重试」两个按钮；其他失败 → 一个立即重试
  const buttons = unauth
    ? [{ title: "去登录" }, { title: "已登录，重试" }]
    : record.status === "error"
    ? [{ title: "立即重试" }]
    : [];

  try {
    await chrome.notifications.create(notifIdFor(record), {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
      priority: failed ? 2 : 1,
      requireInteraction: failed,
      buttons,
    });
  } catch (e) {
    console.warn("通知创建失败：", e);
  }
}

async function updateBadge(record) {
  const map = { claimed: "✓", already: "✓", unauthorized: "!", error: "!" };
  const text = map[record.status] || "·";
  const color =
    record.status === "claimed" || record.status === "already"
      ? "#16a34a"
      : record.status === "unauthorized" || record.status === "error"
      ? "#dc2626"
      : "#6b7280";
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    /* 某些环境没有 action API，忽略 */
  }
}

// ---------- 收尾 ----------
async function finish(result, settings) {
  const s = settings || (await getSettings());
  const got = await chrome.storage.local.get(K.last);
  const prev = got[K.last];

  const record = { ...result, at: Date.now() };
  record.dayKey = todayKey(record.at);
  // 成长体系结果挂在同一条记录上，弹窗/通知/日志都能看到一个完整的"今天干了什么"
  if (pendingGrowth) {
    record.growth = pendingGrowth;
    pendingGrowth = null;
  }

  await chrome.storage.local.set({ [K.last]: record });
  await updateBadge(record);

  const retry = await planRetry(s, record);
  if (retry) {
    await log("warn", `${retry.label}：将在 ${fmtDateTime(retry.at)} 自动重试（第 ${retry.n}/${retry.max} 次）`);
  }

  // 上一次失败、这一次成功 → 无论成功通知是否开启都要告诉用户「已恢复」
  const recovered =
    Boolean(prev) &&
    (prev.status === "error" || prev.status === "unauthorized") &&
    (record.status === "claimed" || record.status === "already");
  const okNow = record.status === "claimed" || record.status === "already";

  const shouldNotify =
    (record.status === "unauthorized" && s.notifyOnFailure) || // 未登录：立刻喊人，不等重试
    (record.status === "error" && !retry && s.notifyOnFailure) || // 网络类：重试都失败了才喊
    (okNow && (s.notifyOnSuccess || recovered));

  if (shouldNotify) await notify(record, { recovered });

  await scheduleDaily(s, true);
  return record;
}

// ---------- 主流程 ----------
// runFlow = 一次完整流程（页面上下文模式会重入一次）；runCheckin = 并发保护 + 通道收尾
async function runFlow(trigger, settings, opts = {}) {
  try {
    await log(
      "info",
      opts.travelOnly
        ? `开始猫猫回程检查（${trigger}${transport === "page" ? " · 页面上下文" : ""}）`
        : `开始签到（${trigger}${transport === "page" ? " · 页面上下文" : ""}）`
    );

    // 1) 找有登录态的站点
    let base = null;
    let account = null;
    let sawHttp = false; // 有没有任何一个站点给出 HTTP 响应（用于区分「断网」和「未登录」）
    let lastNetErr = "";
    for (const b of domainCandidates(settings.domain)) {
      let sc;
      try {
        sc = await sessionCheck(b);
      } catch (e) {
        lastNetErr = errText(e);
        await log("warn", `连接 ${b} 失败：${lastNetErr}`);
        continue;
      }
      sawHttp = true;
      if (sc.loggedIn) {
        base = b;
        account = sc;
        await log("info", `登录态正常：${b}${sc.uid ? `（UID ${sc.uid}）` : ""}`);
        break;
      }
      await log("warn", `${b} 未登录（HTTP ${sc.status}）`);
    }

    if (!base) {
      // 一个都没连上 → 网络问题，按可重试的失败处理（别误导用户去登录）
      if (!sawHttp) {
        await log("err", `网络不可达：${lastNetErr || "所有站点均无法连接"}`);
        return await finish(
          { status: "error", trigger, msg: `网络不可达：${lastNetErr || "无法连接任何站点"}`, account: null },
          settings
        );
      }
      // 直连全部 401：优先怀疑「跨站没带 Cookie」而不是「没登录」，
      // 切到页面上下文（同源）再走一遍，能连通就说明是 Cookie 限制而非未登录。
      if (transport === "direct" && (await switchToPageMode())) {
        return await runFlow(trigger, settings, opts);
      }
      await log("err", "浏览器里没有 WorkBuddy 登录态：请先在 https://www.workbuddy.cn/app 登录一次");
      return await finish(
        { status: "unauthorized", trigger, msg: "浏览器未登录 www.workbuddy.cn", account: null },
        settings
      );
    }

    // 0.5) 回程定时任务：只跑猫猫（领奖 → 再派 → 排下一趟）
    //      不重复签到/任务/兑换/补登，也不写 last 记录，免得把 popup 的「今日签到」覆盖掉。
    if (opts.travelOnly) {
      await runGrowth(base, settings, { travelOnly: true });
      return null;
    }

    // 1.5) 成长体系（任务中心 + 猫猫）：独立于签到，任何失败都不影响签到结果
    if (settings.growth) {
      pendingGrowth = await runGrowth(base, settings, opts);
    }

    // 2) 查今日状态（先查再领：能拿到连续天数，也避免多余请求）
    let todayCheckedIn = false;
    let streak = null;
    let totalCredits = null;
    try {
      const r = await postWithFallback(base, STATUS_PATH, {});
      if (r.res.status === 401 || r.res.status === 403) {
        await log("err", `状态接口返回 ${r.res.status}（${r.path}）：登录态已失效，请重新登录`);
        return await finish(
          { status: "unauthorized", trigger, endpoint: r.path, httpCode: r.res.status, msg: "登录态失效" },
          settings
        );
      }
      const st = parseStatusResponse(r.res.json);
      if (st.ok) {
        todayCheckedIn = st.todayCheckedIn;
        streak = st.streakDays;
        totalCredits = st.totalCredits;
        await log(
          "info",
          `状态：今日${todayCheckedIn ? "已" : "未"}签到 · 累计 ${streak} 天` +
            (st.dailyCredit ? ` · +${st.dailyCredit} 积分/天` : "") +
            (st.activityName ? ` · ${st.activityName}` : "")
        );
      } else {
        await log("warn", `状态接口异常：code=${st.code} ${st.msg}（HTTP ${r.res.status}，${r.path}）`);
      }
    } catch (e) {
      await log("warn", `状态查询失败：${errText(e)}`);
    }

    if (todayCheckedIn) {
      await log("ok", "今日已签到，无需重复领取");
      return await finish(
        { status: "already", trigger, streakDays: streak, totalCredits, account, msg: "今日已签到" },
        settings
      );
    }

    // 3) 领取
    let r2;
    try {
      r2 = await postWithFallback(base, CHECKIN_PATH, {});
    } catch (e) {
      await log("err", `领取请求失败：${errText(e)}`);
      return await finish({ status: "error", trigger, msg: errText(e), account }, settings);
    }

    if (r2.res.status === 401 || r2.res.status === 403) {
      await log("err", `领取接口返回 ${r2.res.status}（${r2.path}）：登录态已失效，请重新登录`);
      return await finish(
        { status: "unauthorized", trigger, endpoint: r2.path, httpCode: r2.res.status, msg: "登录态失效", account },
        settings
      );
    }
    if (!r2.res.ok) {
      const msg = `HTTP ${r2.res.status}${r2.res.text ? `：${r2.res.text.slice(0, 120)}` : ""}`;
      await log("err", `领取失败：${msg}（${r2.path}）`);
      return await finish({ status: "error", trigger, endpoint: r2.path, httpCode: r2.res.status, msg, account }, settings);
    }

    const cr = parseCheckinResponse(r2.res.json);
    if (cr.status === "claimed") {
      await log(
        "ok",
        `领取成功：+${cr.credit == null ? "?" : cr.credit} 积分` +
          (cr.streakDays != null ? ` · 累计 ${cr.streakDays} 天` : "") +
          (cr.isStreakDay ? " · 连签奖励" : "")
      );
      return await finish(
        { status: "claimed", trigger, credit: cr.credit, streakDays: cr.streakDays, isStreakDay: cr.isStreakDay, totalCredits, endpoint: r2.path, account },
        settings
      );
    }
    if (cr.status === "already") {
      await log("ok", `今日已领过（code=${cr.code}）：${cr.msg}`);
      return await finish({ status: "already", trigger, streakDays: streak, totalCredits, endpoint: r2.path, msg: cr.msg, account }, settings);
    }
    if (cr.status === "notEligible" || cr.status === "ended") {
      await log("warn", `${cr.msg}（code=${cr.code}）`);
      return await finish({ status: cr.status, trigger, endpoint: r2.path, msg: cr.msg, account }, settings);
    }

    await log("err", `领取失败：${cr.msg}（code=${cr.code}，${r2.path}）`);
    return await finish({ status: "error", trigger, endpoint: r2.path, code: cr.code, msg: cr.msg, account }, settings);
  } catch (e) {
    await log("err", `未预期错误：${errText(e)}`);
    return await finish({ status: "error", trigger, msg: errText(e) }, settings);
  } finally {
    // 页面上下文用完就关掉我们开的标签页，别在用户标签栏里留东西
    if (transport === "page") {
      await closePageTab();
      transport = "direct";
    }
  }
}

async function runCheckin(trigger = "定时", opts = {}) {
  if (running) {
    await log("warn", `上一次签到还没结束，本次（${trigger}）跳过`);
    return null;
  }
  running = true;
  try {
    const settings = await getSettings();
    return await runFlow(trigger, settings, opts);
  } catch (e) {
    await log("err", `未预期错误：${errText(e)}`);
    return null;
  } finally {
    running = false;
  }
}

// ---------- 成长体系：任务中心 + 猫猫旅行 ----------
// 设计原则：
// 1) 和签到解耦——任何一步失败都只记日志，不影响签到结果，也不触发重试；
// 2) 只做「领」和「接受」，绝不伪造完成状态（服务端会校验，硬刷只会白费）；
// 3) 每一步都幂等：已领过的任务重复领由服务端拒绝，这里按「已领取」处理，不报错。
async function runGrowth(base, settings, opts = {}) {
  // travelOnly：回程定时任务专用——只跑猫猫（领奖 + 再派），不重复任务/兑换/补登
  const travelOnly = opts.travelOnly === true;
  const out = {
    tasksClaimed: 0,
    tasksAccepted: 0,
    growthCredit: 0,
    travelClaimed: false,
    travelDeparted: false,
    redeemedTiers: [],
    cardsGained: 0,
    madeUpDate: "",
    notes: [],
  };

  // 连登天数 / 补登卡余额：兑换与补登都要用，取一次缓存起来
  let streak = null;
  try {
    const sr = await api(base + STREAK_PATH, { method: "GET" });
    if (sr.ok) streak = parseStreak(sr.json);
  } catch (e) {
    await log("warn", `连登状态读取失败：${errText(e)}`);
  }

  // ---- 1. 任务中心 ----
  if (!travelOnly) try {
    const r = await api(base + TASKS_PATH, { method: "GET" });
    if (r.status === 401 || r.status === 403) {
      out.notes.push("任务中心：登录态失效");
      await log("warn", "任务中心接口返回 401，跳过（签到结果不受影响）");
    } else if (!r.ok) {
      out.notes.push(`任务中心：HTTP ${r.status}`);
      await log("warn", `任务中心接口 HTTP ${r.status}，跳过`);
    } else {
      const parsed = parseTasksResponse(r.json);
      if (!parsed.ok) {
        out.notes.push(`任务中心：${parsed.msg}`);
        await log("warn", `任务中心返回异常：${parsed.msg}`);
      } else {
        await log(
          "info",
          `任务中心：共 ${parsed.tasks.length} 个 · 可领 ${parsed.claimable.length} · 待接受 ${parsed.acceptable.length}`
        );

        // 接受未接受的任务（接受后才开始记进度）
        //
        // 刻意不执行任务里的 jumpUrl：网页端点「去完成」会在 accept 之后跳深链
        // （workbuddy://…），浏览器随即弹「是否打开 WorkBuddy」，需要人工点取消。
        // 我们只调接口、不开深链，所以不会有这个弹窗，也不会打断用户。
        if (settings.autoAccept && parsed.acceptable.length) {
          const codes = parsed.acceptable.map((t) => t.taskCode);
          const ar = await api(base + TASK_ACCEPT_PATH, { method: "POST", body: { task_codes: codes } });
          const okAccept = ar.ok && (!ar.json || typeof ar.json.code !== "number" || ar.json.code === 0);
          if (okAccept) {
            out.tasksAccepted = codes.length;
            await log("ok", `接受任务 ${codes.length} 个`);
          } else {
            out.notes.push("接受任务失败");
            await log("warn", `接受任务失败：HTTP ${ar.status}${ar.text ? ` ${ar.text.slice(0, 80)}` : ""}`);
          }
        }

        // auto / beginner 类型的「去完成」需要真人去做（前端点它只是跳转，不调 accept）
        if (parsed.autoAccepted.length) {
          await log("info", `跳过 ${parsed.autoAccepted.length} 个自动/新手任务`);
        }

        // 领取已完成的任务
        for (const t of parsed.claimable) {
          const cr = await api(base + taskClaimPath(t.taskCode), { method: "POST", body: {} });
          const p = typeof cr.json === "object" && cr.json ? parseClaimResult(cr.json) : { status: "error", msg: `HTTP ${cr.status}` };
          if (p.status === "claimed") {
            out.tasksClaimed += 1;
            if (p.credit) out.growthCredit += p.credit;
            await log("ok", `完成任务：${t.title}${p.credit ? ` +${p.credit}` : ""}`);
          } else {
            out.notes.push(`${t.title} 未领到`);
            await log("warn", `任务领取失败：${t.title}（${p.msg}）`);
          }
        }
      }
    }
  } catch (e) {
    out.notes.push(`任务中心异常：${errText(e)}`);
    await log("warn", `任务中心异常：${errText(e)}`);
  }

  // ---- 2. 猫猫旅行 ----
  if (settings.travel) {
    try {
      const sr = await api(base + TRAVEL_STATUS_PATH, { method: "GET" });
      if (!sr.ok) {
        if (sr.status !== 404) await log("warn", `猫猫状态接口 HTTP ${sr.status}，跳过`);
      } else {
        const st = parseTravelStatus(sr.json);
        if (!st.ok) {
          await log("warn", `猫猫状态返回异常：${st.msg}`);
        } else {
          // ---- ① 到家了先领奖 ----
          if (st.canClaim) {
            const cr = await api(base + TRAVEL_CLAIM_PATH, { method: "POST", body: {} });
            const p = typeof cr.json === "object" && cr.json ? parseClaimResult(cr.json) : { status: "error", msg: `HTTP ${cr.status}` };
            if (p.status === "claimed") {
              out.travelClaimed = true;
              if (p.credit) out.growthCredit += p.credit;
              await log("ok", `猫猫：已领取旅行奖励${p.credit ? ` +${p.credit}` : ""}`);
              // 领完就回到"在家"，接着走②再派一趟 —— 4 小时一轮，不是一天一趟
              st.traveling = false;
              st.canDepart = true;
            } else {
              const why = explainGrowthError(p.msg);
              await log("warn", `猫猫：领取旅行奖励失败（${why || p.msg}）`);
            }
          }

          // ---- ② 在路上：记一下预计回来时间，并按服务端 arrive_at 重排 ----
          if (st.traveling) {
            const eta = st.arriveAt ? `，预计 ${fmtDateTime(st.arriveAt * 1000)} 回来` : "";
            await log("info", `猫猫：正在${st.locationName ? ` ${st.locationName} ` : ""}旅行中${eta}`);
            if (st.arriveAt) await scheduleTravelFollowUp(settings, st.arriveAt);
          } else if (st.dailyLimitReached) {
            // ---- ③ 今日已达上限：今天没有下一趟了，撤掉闹钟别空转 ----
            await chrome.alarms.clear(ALARM_TRAVEL);
            await log("info", "猫猫：今日额度已用完，停止回程检查");
          } else if (st.canDepart) {
            // ---- ④ 在家且额度够：派一趟 ----
            let loc = null;
            let cfgKeys = "";
            let cfgSample = "";
            try {
              const cf = await api(base + TRAVEL_CONFIG_PATH, { method: "GET" });
              loc = pickDepartLocation(cf.json);
              const d = cf.json && cf.json.data && typeof cf.json.data === "object" ? cf.json.data : {};
              const arr = Array.isArray(d.locations) ? d.locations : [];
              // 整条地点对象原样留一份（截断），用来核对字段名：
              // 万一真正要传的不是 id 而是 location_code / city_id，一眼就能看出来。
              if (arr.length) cfgSample = JSON.stringify(arr[0]).slice(0, 240);
              if (!loc) cfgKeys = Object.keys(d).slice(0, 12).join(", ");
            } catch (e) {
              await log("warn", `猫猫：读取地点配置失败（${errText(e)}）`);
            }

            if (!loc) {
              out.notes.push("猫猫：拿不到可派地点");
              await log("warn", `猫猫：配置里没有 locations[].id，跳过派遣${cfgKeys ? `（config 字段：${cfgKeys}）` : ""}`);
            } else {
              // 依次尝试 id / location_code / code / city_id：
              // 400 invalid request 无副作用，试错成本为零；成功后记住用的是哪个字段。
              let dr = null;
              let usedField = "";
              const cands = departCandidates(loc);
              const tried = [];
              for (const c of cands) {
                const r = await api(base + TRAVEL_DEPART_PATH, { method: "POST", body: { location_id: c.value } });
                const ok = r.ok && (!r.json || typeof r.json.code !== "number" || r.json.code === 0);
                tried.push(`${c.field}=${JSON.stringify(c.value)}`);
                dr = r;
                if (ok) {
                  usedField = c.field;
                  break;
                }
                const msg = (r.json && (r.json.msg || r.json.message)) || "";
                // 只有「参数无效」才值得换字段；额度用完/已在路上换什么字段都没用
                if (!/invalid request/i.test(msg)) break;
              }

              const okDepart = dr && dr.ok && (!dr.json || typeof dr.json.code !== "number" || dr.json.code === 0);
              if (okDepart) {
                out.travelDeparted = true;
                out.travelLocation = loc.name || "";
                await log(
                  "ok",
                  `猫猫：已派往${loc.name ? ` ${loc.name}` : "新地点"}` +
                    (usedField && usedField !== "id" ? `（服务端认的字段是 ${usedField}）` : "")
                );
                // 用派遣响应里的 arrive_at 排回程检查（拿不到就按 4 小时估）
                const dep = parseTravelStatus(dr.json);
                out.travelArriveAt = dep.ok && dep.arriveAt ? dep.arriveAt : 0;
                await scheduleTravelFollowUp(settings, out.travelArriveAt);
              } else {
                const raw = (dr && dr.json && (dr.json.msg || dr.json.message)) || (dr && dr.text) || "";
                const why = explainGrowthError(raw) || `HTTP ${dr && dr.status}`;
                out.notes.push(`猫猫：派遣失败（${why}）`);
                // 额度用完这类不算故障：今天没有下一趟了，撤掉回程闹钟，别空转
                if (/daily.?limit|quota|上限|额度/i.test(String(raw))) {
                  await chrome.alarms.clear(ALARM_TRAVEL);
                  await log("info", `猫猫：${why}（已停止今日回程检查）`);
                } else {
                  await log("warn", `猫猫：派遣失败（${why}）`);
                  await log("warn", `诊断：试过 ${tried.join(" ") || "无候选"} | ${JSON.stringify((dr && dr.json) || (dr && dr.text) || "").slice(0, 140)}`);
                  await log("warn", `诊断：location=${cfgSample || "空"} | status=${JSON.stringify(st.raw || {}).slice(0, 180)}`);
                }
              }
            }
          } else {
            // 在家但还没到派遣条件（理论上不出现），留个痕便于排查
            await log("info", `猫猫：状态 ${st.state || "未知"}，本轮不动作`);
          }
        }
      }
    } catch (e) {
      out.notes.push(`猫猫异常：${errText(e)}`);
      await log("warn", `猫猫异常：${errText(e)}`);
    }
  }

  // ---- 3. 连登兑换（补登卡就来自这里，必须先做）----
  if (!travelOnly && settings.redeem && streak && streak.ok) {
    const cands = redeemCandidates(streak);
    if (cands.length) {
      for (const { tier, days } of cands) {
        // 前端用 `redeem-<tier>-<uuid>` 作幂等 token
        const clientToken = `redeem-${tier}-${crypto.randomUUID()}`;
        const rr = await api(base + REDEEM_PATH, { method: "POST", body: { tier, client_token: clientToken } });
        const pr = parseRedeemResult(rr.json, rr.status);
        if (pr.status === "claimed") {
          out.redeemedTiers.push(tier);
          out.cardsGained += pr.cardsGranted || 0;
          out.growthCredit += pr.creditGranted || 0;
          const bits = [
            pr.creditGranted ? `+${pr.creditGranted} 积分` : "",
            pr.cardsGranted ? `补登卡 +${pr.cardsGranted}` : "",
            pr.energyGranted ? `能量 +${pr.energyGranted}` : "",
            pr.chancesGranted ? `抽奖次数 +${pr.chancesGranted}` : "",
          ].filter(Boolean);
          await log("ok", `兑换 ${days} 天档${bits.length ? `：${bits.join(" · ")}` : ""}`);
          if (pr.cardsOverflow) await log("info", `补登卡已满，本次溢出 ${pr.cardsOverflow} 张`);
        } else if (pr.status === "already") {
          await log("info", `兑换 ${days} 天档：${pr.msg}`);
        } else {
          out.notes.push(`兑换 ${tier} 失败`);
          await log("warn", `兑换 ${days} 天档失败（${pr.msg}）`);
        }
      }
    } else if (streak.days > 0 && streak.days < 7) {
      // 一档都还不够：说清还差几天，免得以为功能没生效
      await log(
        "info",
        `成长连登 ${streak.days} 天，距 7 天档还差 ${7 - streak.days} 天`
      );
    }
  }

  // ---- 4. 补登卡：有卡 + 当月有断登 → 补掉 ----
  if (!travelOnly && settings.makeup) {
    try {
      // 重新读一次余额：刚兑换到的补登卡要算进去
      let balance = streak && streak.ok ? streak.makeupBalance : 0;
      if (out.cardsGained > 0) {
        try {
          const s2 = await api(base + STREAK_PATH, { method: "GET" });
          if (s2.ok) {
            const parsed = parseStreak(s2.json);
            if (parsed.ok) {
              streak = parsed;
              balance = parsed.makeupBalance;
            }
          }
        } catch {
          balance += out.cardsGained; // 读不到就按发放数估算
        }
      }

      if (!balance) {
        // 没卡就不请求热力图，省一次调用
      } else {
        const hr = await api(base + HEATMAP_PATH, { method: "GET" });
        if (!hr.ok) {
          await log("warn", `活跃地图接口 HTTP ${hr.status}，跳过补登`);
        } else {
          const hm = parseHeatmap(hr.json);
          const target = pickMakeupDate(hm.brokenDates);
          if (!hm.ok) {
            await log("warn", `活跃地图返回异常：${hm.msg}`);
          } else if (!target) {
            await log("info", "补登：本月没有可补的断登日");
          } else {
            const mr = await api(base + MAKEUP_PATH, { method: "POST", body: { target_date: target } });
            if (mr.ok && (!mr.json || typeof mr.json.code !== "number" || mr.json.code === 0)) {
              out.madeUpDate = target;
              await log("ok", `补登 ${target} 成功，卡余 ${Math.max(0, balance - 1)}`);
            } else {
              const raw = (mr.json && (mr.json.msg || mr.json.message)) || mr.text || "";
              const why = explainMakeupError(raw) || `HTTP ${mr.status}`;
              out.notes.push(`补登 ${target} 失败`);
              await log("warn", `补登 ${target} 失败（${why}）`);
            }
          }
        }
      }
    } catch (e) {
      out.notes.push(`补登异常：${errText(e)}`);
      await log("warn", `补登异常：${errText(e)}`);
    }
  }

  return out;
}

// ---------- 启动补跑 ----------
async function catchUp() {
  const s = await getSettings();
  await scheduleDaily(s, false);
  if (!s.enabled) return;

  const got = await chrome.storage.local.get(K.last);
  const last = got[K.last];
  const now = Date.now();

  // 刚跑过就别重复（Chrome 启动时会补发错过的 alarm）
  if (last && last.at && now - last.at < 5 * 60000) return;
  if (last && last.dayKey === todayKey() && (last.status === "claimed" || last.status === "already")) return;

  const { h, m } = parseTimeOfDay(s.time);
  const d = new Date();
  const due = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
  if (now >= due) await runCheckin("启动补跑");
}

// ---------- 事件注册（必须同步注册） ----------
chrome.runtime.onInstalled.addListener(async (details) => {
  const s = await getSettings();
  await chrome.storage.local.set({ [K.settings]: s });
  await log("info", details.reason === "install" ? "扩展已安装" : `扩展已更新（${details.reason}）`);
  await scheduleDaily(s, true);
  if (details.reason === "install") {
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      /* 忽略 */
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  catchUp().catch((e) => console.error("启动检查失败", e));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_DAILY) {
    runCheckin("定时").catch((e) => console.error(e));
  } else if (alarm.name === ALARM_RETRY) {
    runCheckin("失败重试").catch((e) => console.error(e));
  } else if (alarm.name === ALARM_TRAVEL) {
    // 只跑猫猫：领奖 → 再派 → 排下一趟，不重复签到/任务
    runCheckin("猫猫回程", { travelOnly: true }).catch((e) => console.error(e));
  }
});

// 通知按钮：未登录给「去登录」「已登录，重试」；其他失败给「立即重试」
chrome.notifications.onButtonClicked.addListener((id, idx) => {
  const status = notifStatusOf(id);
  chrome.notifications.clear(id);
  if (status === "unauthorized" && idx === 0) {
    openLogin();
    return;
  }
  runCheckin("通知重试").catch((e) => console.error(e));
});

chrome.notifications.onClicked.addListener((id) => {
  const status = notifStatusOf(id);
  chrome.notifications.clear(id);
  if (status === "unauthorized") {
    openLogin();
    return;
  }
  runCheckin("通知重试").catch((e) => console.error(e));
});

function openLogin() {
  try {
    chrome.tabs.create({ url: LOGIN_URL });
  } catch (e) {
    console.warn("打开登录页失败：", e);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.type === "run-now") {
        sendResponse({ ok: true, record: await runCheckin("手动") });
      } else if (msg && msg.type === "settings-changed") {
        const s = await getSettings();
        const next = await scheduleDaily(s, true);
        sendResponse({ ok: true, next });
      } else if (msg && msg.type === "clear-logs") {
        await chrome.storage.local.set({ [K.logs]: [] });
        await log("info", "日志已清空");
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: errText(e) });
    }
  })();
  return true; // 异步响应
});
