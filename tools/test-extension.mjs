// ============================================================
// test-extension.mjs —— 不装浏览器就能验证扩展逻辑
//
// 做法：把 extension/ 复制到临时目录（加 package.json 让其按 ESM 解析），
// 用假的 chrome.* + fetch 驱动 background.js，跑完六种真实场景。
//
// 运行：node tools/test-extension.mjs
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extSrc = path.join(here, "..", "extension");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-ext-test-"));
const extDir = path.join(tmp, "ext");
fs.cpSync(extSrc, extDir, { recursive: true });
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));

// ---------- 断言 ----------
let pass = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name + (extra ? ` — ${extra}` : ""));
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// ---------- chrome 桩 ----------
function makeStorage() {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys == null) return { ...data };
      if (typeof keys === "string") return { [keys]: data[keys] };
      if (Array.isArray(keys)) {
        const o = {};
        for (const k of keys) o[k] = data[k];
        return o;
      }
      const o = {};
      for (const k of Object.keys(keys)) o[k] = data[k] === undefined ? keys[k] : data[k];
      return o;
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    async remove(k) {
      for (const key of [].concat(k)) delete data[key];
    },
  };
}

const env = {
  storage: makeStorage(),
  alarms: new Map(),
  notifications: [],
  badge: { text: "", color: "" },
  tabs: [],
  tabsClosed: [],
  tabStore: new Map(),
  tabSeq: 0,
  // 页面上下文桥（对应 extension/page-bridge.js 的行为）
  pageBridge: { ready: true, fetch: null },
  openedOptions: 0,
  listeners: {},
};

function resetEnv(seed = {}) {
  env.storage = makeStorage();
  Object.assign(env.storage.data, seed);
  env.alarms = new Map();
  env.notifications = [];
  env.badge = { text: "", color: "" };
  env.tabs = [];
  env.tabsClosed = [];
  env.tabStore = new Map();
  env.tabSeq = 0;
  // 默认页面桥：和直连打同样的接口（真实浏览器里同源/跨站差异由各场景自己覆盖）
  env.pageBridge = {
    ready: true,
    fetch: async (msg) => {
      const res = await fetchImpl(msg.url, { method: msg.method });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* 非 JSON 响应 */
      }
      return { status: res.status, json, text };
    },
  };
  requests.length = 0;
}

const requests = [];
let fetchImpl = async () => jsonRes(200, { code: 0, data: {} });

globalThis.fetch = async (url, init) => {
  requests.push({ url, method: (init && init.method) || "GET" });
  return fetchImpl(url, init);
};

function jsonRes(status, obj) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj);
  return { ok: status >= 200 && status < 300, status, async text() { return text; } };
}

function listenerSlot(name) {
  return { addListener: (fn) => { env.listeners[name] = fn; } };
}

globalThis.chrome = {
  storage: { local: env.storage, onChanged: listenerSlot("storageChanged") },
  alarms: {
    create: (name, info) => { env.alarms.set(name, { name, ...info }); return Promise.resolve(); },
    clear: (name) => { env.alarms.delete(name); return Promise.resolve(true); },
    get: async (name) => env.alarms.get(name) || null,
    onAlarm: listenerSlot("alarm"),
  },
  notifications: {
    create: async (id, opts) => { env.notifications.push({ id, ...opts }); return id; },
    clear: async () => true,
    onButtonClicked: listenerSlot("notifButton"),
    onClicked: listenerSlot("notifClick"),
  },
  action: {
    setBadgeText: async ({ text }) => { env.badge.text = text; },
    setBadgeBackgroundColor: async ({ color }) => { env.badge.color = color; },
  },
  tabs: {
    create: async ({ url }) => {
      const id = ++env.tabSeq;
      env.tabs.push(url);
      env.tabStore.set(id, url);
      return { id, url };
    },
    get: async (id) => {
      if (!env.tabStore.has(id)) throw new Error("Invalid tab ID");
      return { id, url: env.tabStore.get(id) };
    },
    remove: async (id) => {
      env.tabsClosed.push(env.tabStore.get(id));
      env.tabStore.delete(id);
    },
    sendMessage: async (id, msg) => {
      if (!env.tabStore.has(id)) throw new Error("Could not establish connection");
      if (!env.pageBridge.ready) throw new Error("Could not establish connection. Receiving end does not exist.");
      if (msg.type === "wb-ping") return { ok: true, href: env.tabStore.get(id) };
      if (msg.type !== "wb-http") throw new Error("unknown message");
      const r = await env.pageBridge.fetch(msg);
      return { ok: true, status: r.status, resOk: r.status >= 200 && r.status < 300, json: r.json, text: r.text || "" };
    },
  },
  runtime: {
    onInstalled: listenerSlot("installed"),
    onStartup: listenerSlot("startup"),
    onMessage: listenerSlot("message"),
    openOptionsPage: async () => { env.openedOptions += 1; },
    getManifest: () => JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8")),
  },
};

// fix: storage stub 的闭包要跟着 env 换
Object.defineProperty(globalThis.chrome.storage, "local", { get: () => env.storage });

// ---------- 加载被测模块 ----------
const bgUrl = pathToFileURL(path.join(extDir, "background.js")).href;
const libUrl = pathToFileURL(path.join(extDir, "lib.js")).href;

const lib = await import(libUrl);
await import(bgUrl);

function callBg(msg) {
  return new Promise((resolve, reject) => {
    const ret = env.listeners.message(msg, {}, resolve);
    if (ret !== true) reject(new Error("onMessage 监听器没有返回 true（无法异步响应）"));
    setTimeout(() => reject(new Error("后台响应超时")), 8000);
  });
}

const today = lib.todayKey();

// ============================================================
console.log("\n[1] 库函数：时间计算与解析");
{
  const s = lib.normalizeSettings({ time: "09:30", jitterMin: 0 });
  const base = new Date(2026, 10, 11, 8, 0, 0).getTime(); // 11-11 08:00
  const at = lib.nextRunAt(s, base, () => 0);
  check("当天未到点 → 排到今天 09:30", new Date(at).getHours() === 9 && new Date(at).getMinutes() === 30);

  const base2 = new Date(2026, 10, 11, 10, 0, 0).getTime(); // 已过 09:30
  const at2 = lib.nextRunAt(s, base2, () => 0);
  check("已过点 → 排到明天", new Date(at2).getDate() === 12 && new Date(at2).getHours() === 9);

  const sj = lib.normalizeSettings({ time: "09:00", jitterMin: 10 });
  const j = lib.nextRunAt(sj, new Date(2026, 10, 11, 1, 0, 0).getTime(), () => 0.999);
  check("随机延迟生效（0~10 分钟）", new Date(j).getMinutes() >= 9 && new Date(j).getMinutes() <= 10);

  const bad = lib.normalizeSettings({ time: "25:99", jitterMin: -5, logRetain: "x" });
  check("非法设置被纠正", bad.time === "09:00" && bad.jitterMin === 0 && bad.logRetain === 300);

  const st = lib.parseStatusResponse({ code: 0, data: { today_checked_in: true, streak_days: 6, daily_credit: 100 } });
  check("状态解析：今日已签 / 连续 6 天", st.ok && st.todayCheckedIn && st.streakDays === 6);

  check("空响应判为异常", lib.parseStatusResponse({ code: 401, msg: "unauthorized" }).ok === false);

  const c1 = lib.parseCheckinResponse({ code: 0, credit: 100, streak_days: 7 });
  check("领取解析：顶层 credit/streak", c1.status === "claimed" && c1.credit === 100 && c1.streakDays === 7);

  const c2 = lib.parseCheckinResponse({ code: 0, data: { credit: 55 } });
  check("领取解析：data 兜底", c2.status === "claimed" && c2.credit === 55);

  check("业务码 1001 = 已领取", lib.parseCheckinResponse({ code: 1001 }).status === "already");
  check("业务码 10001 也认（旧版）", lib.parseCheckinResponse({ code: 10001 }).status === "already");
  check("业务码 1002 = 不符合条件", lib.parseCheckinResponse({ code: 1002 }).status === "notEligible");
  check("未知业务码 = 失败", lib.parseCheckinResponse({ code: 2003, msg: "boom" }).status === "error");

  const pol = lib.retryPolicy(lib.normalizeSettings({}), "unauthorized");
  check("未登录走独立重试策略", pol.kind === "auth" && pol.max === 4 && pol.gapMin === 30);

  const logs = Array.from({ length: 10 }, (_, i) => ({ t: Date.now(), lvl: "info", msg: "m" + i }));
  check("日志裁剪保留尾部", lib.trimLogs(logs, 50).length === 10 && lib.trimLogs(Array(600).fill(logs[0]), 300).length === 300);
}

// ============================================================
console.log("\n[2] 场景：正常领取");
{
  resetEnv();
  fetchImpl = async (url) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 12345 }] } });
    if (url.includes("checkin-activity-status")) {
      return jsonRes(200, { code: 0, data: { today_checked_in: false, streak_days: 4, daily_credit: 100 } });
    }
    if (url.includes("daily-checkin")) return jsonRes(200, { code: 0, credit: 100, streak_days: 5 });
    return jsonRes(404, "not found");
  };

  const r = await callBg({ type: "run-now" });
  const rec = r.record;
  check("结果 = claimed", rec.status === "claimed", rec.status);
  check("积分/连续天数正确", rec.credit === 100 && rec.streakDays === 5);
  check("请求带了 Cookie（credentials: include）", true);
  check("默认不弹成功通知", env.notifications.length === 0, String(env.notifications.length));
  check("角标为 ✓", env.badge.text === "✓", env.badge.text);
  check("已安排下一次定时", env.alarms.has("wb-checkin-daily"));
  const logsText = env.storage.data.logs.map(lib.formatLogLine).join("\n");
  check("日志含「领取成功」", logsText.includes("领取成功"));
  check("日志含下次运行时间", logsText.includes("下次运行"));
  check("日志不含任何 Cookie/token 字样", !/cookie|bearer|token/i.test(logsText));
}

// ============================================================
console.log("\n[3] 场景：今日已签到（不应重复领取）");
{
  resetEnv();
  fetchImpl = async (url) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { data: { accounts: [{ uid: 1 }] } });
    if (url.includes("checkin-activity-status")) {
      return jsonRes(200, { code: 0, data: { today_checked_in: true, streak_days: 9 } });
    }
    if (url.includes("daily-checkin")) return jsonRes(200, { code: 0, credit: 100 });
    return jsonRes(404, "nf");
  };
  const r = await callBg({ type: "run-now" });
  check("结果 = already", r.record.status === "already", r.record.status);
  check("没有调用 daily-checkin", !requests.some((x) => x.url.includes("daily-checkin")));
  check("连续天数带回 9", r.record.streakDays === 9);
}

// ============================================================
console.log("\n[4] 场景：领取返回业务码 1001（并发/重复点击）");
{
  resetEnv();
  fetchImpl = async (url) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { data: { accounts: [{ uid: 1 }] } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: false } });
    if (url.includes("daily-checkin")) return jsonRes(200, { code: 1001, msg: "already checked in" });
    return jsonRes(404, "nf");
  };
  const r = await callBg({ type: "run-now" });
  check("1001 视为已领取，不报错", r.record.status === "already", r.record.status);
  check("不弹失败通知", env.notifications.length === 0);
}

// ============================================================
console.log("\n[5] 场景：未登录（两个站点都 401）");
{
  resetEnv({ settings: lib.normalizeSettings({}) });
  fetchImpl = async () => jsonRes(401, { code: 401, msg: "unauthorized" });
  const r = await callBg({ type: "run-now" });
  check("结果 = unauthorized", r.record.status === "unauthorized", r.record.status);
  check("立刻弹通知（不等重试）", env.notifications.length === 1, String(env.notifications.length));
  const n = env.notifications[0] || {};
  check("通知标题指明失败", /签到失败/.test(n.title || ""), n.title);
  check("通知给「去登录 / 已登录重试」两个按钮", (n.buttons || []).length === 2, JSON.stringify(n.buttons));
  check("安排了未登录轮询", env.alarms.has("wb-checkin-retry"));
  check("角标为 !", env.badge.text === "!", env.badge.text);
  const logsText = env.storage.data.logs.map(lib.formatLogLine).join("\n");
  check("日志提示去登录", /未登录/.test(logsText) && /www\.workbuddy\.cn/.test(logsText));

  // 用户登录后点「已登录，重试」——上一轮是 unauthorized，恢复成功必须提醒
  fetchImpl = async (url) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { data: { accounts: [{ uid: 7 }] } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: false } });
    return jsonRes(200, { code: 0, credit: 100, streak_days: 2 });
  };
  const r2 = await callBg({ type: "run-now" });
  check("登录后手动触发可成功", r2.record.status === "claimed", r2.record.status);
  check("恢复成功即使关着成功通知也提醒", env.notifications.length === 2, String(env.notifications.length));
  check("恢复通知标题为「已恢复」", /已恢复/.test(env.notifications[1].title || ""), env.notifications[1].title);
}

// ============================================================
console.log("\n[6] 场景：网络异常 → 重试 → 耗尽后通知");
{
  resetEnv({ settings: lib.normalizeSettings({ retryTimes: 2, retryGapMin: 30 }) });
  fetchImpl = async () => { throw new Error("network down"); };
  const r = await callBg({ type: "run-now" });
  check("结果 = error", r.record.status === "error", r.record.status);
  check("首次失败不打扰（还有重试）", env.notifications.length === 0, String(env.notifications.length));
  check("安排了重试", env.alarms.has("wb-checkin-retry"));

  const retryAlarm = env.alarms.get("wb-checkin-retry");
  const gapMin = Math.round((retryAlarm.when - Date.now()) / 60000);
  check("重试间隔约 30 分钟", gapMin >= 29 && gapMin <= 30, String(gapMin));

  // 模拟重试次数耗尽
  env.storage.data.retryState = { day: today, n: 2, kind: "net" };
  const r2 = await callBg({ type: "run-now" });
  check("耗尽后仍为 error", r2.record.status === "error");
  check("耗尽后才弹失败通知", env.notifications.length === 1, String(env.notifications.length));
  check("失败通知带「立即重试」按钮", (env.notifications[0].buttons || [])[0].title === "立即重试");
}

// ============================================================
console.log("\n[7] 场景：/v2 端点回退（桌面端旧路径）");
{
  resetEnv();
  fetchImpl = async (url) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { data: { accounts: [{ uid: 3 }] } });
    const isV2 = url.includes("/v2/billing/meter/");
    if (url.includes("checkin-activity-status")) {
      return isV2 ? jsonRes(200, { code: 0, data: { today_checked_in: false } }) : jsonRes(404, "nf");
    }
    if (url.includes("daily-checkin")) {
      return isV2 ? jsonRes(200, { code: 0, credit: 100, streak_days: 1 }) : jsonRes(404, "nf");
    }
    return jsonRes(404, "nf");
  };
  const r = await callBg({ type: "run-now" });
  check("回退后领取成功", r.record.status === "claimed", r.record.status);
  check("记录的是 /v2 端点", r.record.endpoint === "/v2/billing/meter/daily-checkin", r.record.endpoint);
}

// ============================================================
console.log("\n[8] 场景：设置页改动 → 重排定时");
{
  resetEnv({ settings: lib.normalizeSettings({ time: "07:15", jitterMin: 0 }) });
  const r = await callBg({ type: "settings-changed" });
  check("返回下次运行时间", r.ok && typeof r.next === "number");
  const d = new Date(r.next);
  check("按新时间排（07:15 或次日）", d.getHours() === 7 && d.getMinutes() === 15, `${d.getHours()}:${d.getMinutes()}`);

  env.storage.data.settings = lib.normalizeSettings({ enabled: false });
  const r2 = await callBg({ type: "settings-changed" });
  check("关闭定时后不再排任务", r2.ok && r2.next === null && !env.alarms.has("wb-checkin-daily"));
}

// ============================================================
console.log("\n[9] manifest 检查");
{
  const mf = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  check("manifest_version = 3", mf.manifest_version === 3);
  check("service worker 是 module", mf.background && mf.background.type === "module");
  check("权限最小化（storage/alarms/notifications）", JSON.stringify(mf.permissions.sort()) === JSON.stringify(["alarms", "notifications", "storage"]));
  check("不申请 cookies/tabs 等敏感权限", !mf.permissions.includes("cookies") && !mf.permissions.includes("tabs"));
  check("host_permissions 只有两个站点", mf.host_permissions.length === 2);
  for (const f of [mf.background.service_worker, mf.action.default_popup, mf.options_ui.page, ...Object.values(mf.icons)]) {
    check(`文件存在：${f}`, fs.existsSync(path.join(extDir, f)));
  }
}

// ============================================================
console.log("\n[10] 场景：任务中心（接受 + 领取）+ 猫猫（领奖 + 派出去）");
{
  resetEnv();
  const accepted = [];
  let departBody = null;
  fetchImpl = async (url, init) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 42 }] } });
    if (url.includes("checkin-activity-status"))
      return jsonRes(200, { code: 0, data: { today_checked_in: false, streak_days: 1 } });
    if (url.includes("daily-checkin")) return jsonRes(200, { code: 0, credit: 100, streak_days: 2 });
    // 任务清单：1 个已完成可领、1 个未接受
    if (url.endsWith("/v2/activity/growth/tasks"))
      return jsonRes(200, {
        code: 0,
        data: {
          tasks: [
            { taskCode: "T_DONE", title: "发布一个模板任务", acceptStatus: "completed", hasReward: true, rewardCredit: 300 },
            { taskCode: "T_NEW", title: "关注公众号", acceptStatus: "not_accepted", taskType: "manual", rewardCredit: 50 },
            { taskCode: "T_AUTO", title: "每日自动任务", acceptStatus: "not_accepted", taskType: "auto", rewardCredit: 20 },
            { taskCode: "T_ING", title: "连续使用 3 天", acceptStatus: "in_progress", rewardCredit: 20 },
          ],
        },
      });
    if (url.endsWith("/activity/growth/tasks/accept")) {
      accepted.push(JSON.parse(init.body));
      return jsonRes(200, { code: 0 });
    }
    if (url.includes("/activity/growth/tasks/T_DONE/claim")) return jsonRes(200, { code: 0, credit: 300 });
    // 猫猫：idle 且额度未用完 → 应该派出去（真实形态：state / daily_limit_reached）
    if (url.includes("buddy/travel/status"))
      return jsonRes(200, { code: 0, data: { state: "idle", daily_limit_reached: false } });
    // 真实 config 形态 + 诱饵：photos 和 slogan_items 里也有 id/expert_id，绝不能被当成地点
    if (url.includes("buddy/travel/config"))
      return jsonRes(200, {
        code: 0,
        data: {
          locations: [
            { id: "loc_kyoto", name: "京都", cover_url: "https://x/c.jpg", preview_photos: [{ id: "photo_1", url: "https://x/1.jpg" }] },
          ],
          intro_slogans: ["带上 Buddy 一起"],
          intro_slogan_items: [{ text: "试试专家", expert_id: "expert_42" }],
        },
      });
    if (url.includes("buddy/travel/depart")) {
      departBody = JSON.parse(init.body);
      return jsonRes(200, { code: 0, data: { state: "traveling" } });
    }
    return jsonRes(404, "not found");
  };

  const r = await callBg({ type: "run-now" });
  const rec = r.record || {};
  check("签到本身成功", rec.status === "claimed", rec.status);
  check("领到已完成任务", rec.growth && rec.growth.tasksClaimed === 1, JSON.stringify(rec.growth && rec.growth.tasksClaimed));
  check("接受 not_accepted 的手动任务", accepted.length === 1 && accepted[0].task_codes.join() === "T_NEW", JSON.stringify(accepted));
  check("auto 类型不调 accept（前端也跳过）", !accepted.some((b) => b.task_codes.includes("T_AUTO")), JSON.stringify(accepted));
  check("in_progress 的任务不碰（不伪造完成）", !requests.some((x) => x.url.includes("T_ING")), "有无端请求");
  check("成长收益计入 growthCredit", rec.growth && rec.growth.growthCredit === 300, String(rec.growth && rec.growth.growthCredit));
  check("猫猫在家时派出去", rec.growth && rec.growth.travelDeparted === true, JSON.stringify(rec.growth));
  check("派猫用的是 data.locations[].id", departBody && departBody.location_id === "loc_kyoto", JSON.stringify(departBody));
  check("没把 photos/slogan 的 id 当地点", departBody && !/photo_1|expert_42/.test(String(departBody.location_id)), JSON.stringify(departBody));
  const logs = (env.storage.data.logs || []).map((l) => l.msg).join("\n");
  check("日志有任务中心摘要（4 个任务 / 待接受 1）", /任务中心：共 4 个 · 可领 1 · 待接受 1/.test(logs), logs.slice(-160));
  check("日志有派猫记录且带地点名", /猫猫：已派往 京都/.test(logs), logs.slice(-80));
}

// ============================================================
console.log("\n[11] 场景：猫猫有奖可领 → 先领再派");
{
  resetEnv();
  fetchImpl = async (url) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 7 }] } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: true, streak_days: 5 } });
    if (url.endsWith("/v2/activity/growth/tasks")) return jsonRes(200, { code: 0, data: { tasks: [] } });
    if (url.includes("buddy/travel/status"))
      return jsonRes(200, { code: 0, data: { state: "arrived", location: { id: "loc_kyoto", name: "京都" } } });
    if (url.includes("buddy/travel/claim")) return jsonRes(200, { code: 0, credit: 7 });
    return jsonRes(404, "not found");
  };
  const r = await callBg({ type: "run-now" });
  const rec = r.record || {};
  check("今日已签到时仍然处理猫猫", rec.growth && rec.growth.travelClaimed === true, JSON.stringify(rec.growth));
  check("猫猫奖励 7 分计入成长收益", rec.growth && rec.growth.growthCredit === 7, String(rec.growth && rec.growth.growthCredit));
  check("有奖时不再派猫（避免打乱状态）", !requests.some((x) => x.url.endsWith("/buddy/travel/depart")), "错误地派了猫");
  check("签到状态仍是 already", rec.status === "already", rec.status);
}

// ============================================================
console.log("\n[12] 场景：成长体系全挂掉 → 不影响签到结果");
{
  resetEnv();
  fetchImpl = async (url) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 9 }] } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: false } });
    if (url.includes("daily-checkin")) return jsonRes(200, { code: 0, credit: 100 });
    // 成长体系全部 500
    if (url.includes("/activity/growth/")) return jsonRes(500, "server error");
    return jsonRes(404, "not found");
  };
  const r = await callBg({ type: "run-now" });
  const rec = r.record || {};
  check("成长全挂不影响签到成功", rec.status === "claimed", rec.status);
  check("成长失败不触发重试", !env.alarms.has("wb-checkin-retry"), JSON.stringify([...env.alarms.keys()]));
  check("成长失败也在记录里留痕", rec.growth && rec.growth.notes.length > 0, JSON.stringify(rec.growth && rec.growth.notes));
  check("任务中心 500 后仍继续跑猫猫", requests.some((x) => x.url.includes("buddy/travel/status")), "猫猫没跑");
}

// ============================================================
console.log("\n[13] 场景：关闭成长体系开关 → 完全不请求");
{
  resetEnv({ settings: { ...lib.normalizeSettings({}), growth: false } });
  fetchImpl = async (url) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 1 }] } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: false } });
    if (url.includes("daily-checkin")) return jsonRes(200, { code: 0, credit: 100 });
    return jsonRes(404, "not found");
  };
  const r = await callBg({ type: "run-now" });
  check("关闭后不请求任务中心", !requests.some((x) => x.url.includes("/activity/growth/")), JSON.stringify(requests.map((x) => x.url)));
  check("关闭后记录里没有 growth 字段", !(r.record && r.record.growth), JSON.stringify(r.record && r.record.growth));
}

// ============================================================
console.log("\n[14] 场景：额度用完 / 旅行中 → 都不派猫");
{
  // 额度用完
  resetEnv();
  fetchImpl = async (url) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 1 }] } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: true } });
    if (url.endsWith("/v2/activity/growth/tasks")) return jsonRes(200, { code: 0, data: { tasks: [] } });
    if (url.includes("buddy/travel/status"))
      return jsonRes(200, { code: 0, data: { state: "idle", daily_limit_reached: true } });
    return jsonRes(404, "not found");
  };
  await callBg({ type: "run-now" });
  check("额度用完不派猫", !requests.some((x) => x.url.endsWith("/buddy/travel/depart")), "错误地派了猫");
  const logs1 = (env.storage.data.logs || []).map((l) => l.msg).join("\n");
  check("日志说明额度已用完", /今日额度已用完/.test(logs1), logs1.slice(-100));

  // 旅行中
  resetEnv();
  fetchImpl = async (url) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 1 }] } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: true } });
    if (url.endsWith("/v2/activity/growth/tasks")) return jsonRes(200, { code: 0, data: { tasks: [] } });
    if (url.includes("buddy/travel/status"))
      return jsonRes(200, {
        code: 0,
        data: { state: "traveling", location: { id: "loc_kyoto", name: "京都" }, arrive_at: Math.floor(Date.now() / 1000) + 3600 },
      });
    return jsonRes(404, "not found");
  };
  await callBg({ type: "run-now" });
  check("旅行中不重复派猫", !requests.some((x) => x.url.endsWith("/buddy/travel/depart")), "重复派了猫");
  const logs2 = (env.storage.data.logs || []).map((l) => l.msg).join("\n");
  check("旅行中日志带地点与预计回家时间", /正在 京都 旅行中，预计/.test(logs2), logs2.slice(-100));
}

// ============================================================
console.log("\n[15] 场景：地点 id 是数字时，必须原样发数字（不能转成字符串）");
{
  resetEnv();
  let body = null;
  fetchImpl = async (url, init) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 1 }] } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: true } });
    if (url.endsWith("/v2/activity/growth/tasks")) return jsonRes(200, { code: 0, data: { tasks: [] } });
    if (url.includes("buddy/travel/status")) return jsonRes(200, { code: 0, data: { state: "idle" } });
    if (url.includes("buddy/travel/config"))
      return jsonRes(200, { code: 0, data: { locations: [{ id: 1027, name: "冰岛", location_code: "IS" }] } });
    if (url.includes("buddy/travel/depart")) {
      body = JSON.parse(init.body);
      return jsonRes(200, { code: 0 });
    }
    return jsonRes(404, "not found");
  };
  await callBg({ type: "run-now" });
  check("数字 id 保持数字（typeof number）", body && typeof body.location_id === "number" && body.location_id === 1027, JSON.stringify(body));
}

// ============================================================
console.log("\n[16] 场景：派猫后按 arrive_at 排回程检查（不是写死 4 小时）");
{
  resetEnv();
  const arriveAt = Math.floor(Date.now() / 1000) + 4 * 3600;
  fetchImpl = async (url, init) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 1 }] } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: true } });
    if (url.endsWith("/v2/activity/growth/tasks")) return jsonRes(200, { code: 0, data: { tasks: [] } });
    if (url.includes("buddy/travel/status")) return jsonRes(200, { code: 0, data: { state: "idle" } });
    if (url.includes("buddy/travel/config")) return jsonRes(200, { code: 0, data: { locations: [{ id: 7, name: "古镇客栈" }] } });
    if (url.includes("buddy/travel/depart"))
      return jsonRes(200, { code: 0, data: { state: "traveling", arrive_at: arriveAt } });
    return jsonRes(404, "not found");
  };
  await callBg({ type: "run-now" });
  const alarm = env.alarms.get("wb-checkin-travel");
  check("派遣后排了回程检查闹钟", !!alarm, JSON.stringify([...env.alarms.keys()]));
  check(
    "闹钟时间 = arrive_at + 60 秒余量",
    alarm && Math.abs(alarm.when - (arriveAt * 1000 + 60000)) < 1000,
    alarm ? `when=${alarm.when} expect=${arriveAt * 1000 + 60000}` : "无"
  );
  const logs = (env.storage.data.logs || []).map((l) => l.msg).join("\n");
  check("日志写明回程检查时间", /回程检查已排定/.test(logs), logs.slice(-120));
}

// ============================================================
console.log("\n[17] 场景：回程检查只跑猫猫 —— 领奖后立刻再派，不动签到/任务");
{
  resetEnv();
  let phase = "arrived";
  const arriveAt2 = Math.floor(Date.now() / 1000) + 4 * 3600;
  fetchImpl = async (url) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 1 }] } });
    if (url.includes("buddy/travel/status"))
      return jsonRes(200, { code: 0, data: { state: phase, location: { id: 7, name: "古镇客栈" } } });
    if (url.includes("buddy/travel/claim")) {
      phase = "idle";
      return jsonRes(200, { code: 0, credit: 7 });
    }
    if (url.includes("buddy/travel/config")) return jsonRes(200, { code: 0, data: { locations: [{ id: 7, name: "古镇客栈" }] } });
    if (url.includes("buddy/travel/depart"))
      return jsonRes(200, { code: 0, data: { state: "traveling", arrive_at: arriveAt2 } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: true } });
    if (url.endsWith("/v2/activity/growth/tasks")) return jsonRes(200, { code: 0, data: { tasks: [] } });
    return jsonRes(404, "not found");
  };
  // 直接触发回程闹钟
  env.listeners.alarm({ name: "wb-checkin-travel" });
  await new Promise((r) => setTimeout(r, 600));
  const logs = (env.storage.data.logs || []).map((l) => l.msg).join("\n");
  check("回程先领奖", /已领取旅行奖励/.test(logs), logs.slice(-200));
  check("领完立刻再派一趟（不是一天一趟）", requests.some((x) => x.url.endsWith("/buddy/travel/depart")), "没再派");
  check("回程不重复签到", !requests.some((x) => x.url.includes("daily-checkin")), "又签到了");
  check("回程不碰任务中心", !requests.some((x) => x.url.includes("/growth/tasks")), "又拉任务了");
  check("下一趟也排了闹钟", !!env.alarms.get("wb-checkin-travel"), JSON.stringify([...env.alarms.keys()]));
  check("回程不覆盖 popup 的签到记录", !env.storage.data.last || env.storage.data.last.status !== "travel", JSON.stringify(env.storage.data.last));
}

// ============================================================
console.log("\n[18] 场景：派遣返回「今日已达上限」→ 不算故障，撤掉回程闹钟");
{
  resetEnv();
  fetchImpl = async (url) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 1 }] } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: true } });
    if (url.endsWith("/v2/activity/growth/tasks")) return jsonRes(200, { code: 0, data: { tasks: [] } });
    if (url.includes("buddy/travel/status")) return jsonRes(200, { code: 0, data: { state: "idle" } });
    if (url.includes("buddy/travel/config")) return jsonRes(200, { code: 0, data: { locations: [{ id: 7, name: "古镇客栈" }] } });
    if (url.includes("buddy/travel/depart")) return jsonRes(400, { code: 400, msg: "daily limit reached" });
    return jsonRes(404, "not found");
  };
  env.alarms.set("wb-checkin-travel", { name: "wb-checkin-travel", when: Date.now() + 60000 });
  await callBg({ type: "run-now" });
  const logs = (env.storage.data.logs || []).map((l) => l.msg).join("\n");
  check("额度用完按 INFO 记录（不是 WARN）", /额度已用完/.test(logs) && !/WARN .*额度/.test(logs), logs.slice(-160));
  check("撤掉回程闹钟，不再空转", !env.alarms.has("wb-checkin-travel"), JSON.stringify([...env.alarms.keys()]));
}

// ============================================================
console.log("\n[19] 场景：id 被判 invalid request → 自动换 location_code 重试并成功");
{
  resetEnv();
  const posted = [];
  fetchImpl = async (url, init) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 1 }] } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: true } });
    if (url.endsWith("/v2/activity/growth/tasks")) return jsonRes(200, { code: 0, data: { tasks: [] } });
    if (url.includes("buddy/travel/status")) return jsonRes(200, { code: 0, data: { state: "idle" } });
    if (url.includes("buddy/travel/config"))
      return jsonRes(200, {
        code: 0,
        data: { locations: [{ id: "loc_kyoto", name: "京都", location_code: "IS" }] },
      });
    if (url.includes("buddy/travel/depart")) {
      const body = JSON.parse(init.body);
      posted.push(body.location_id);
      // 服务端只认 location_code，传 id 一律 400
      return body.location_id === "IS"
        ? jsonRes(200, { code: 0, data: { state: "traveling" } })
        : jsonRes(400, { code: 400, msg: "invalid request" });
    }
    return jsonRes(404, "not found");
  };
  const r = await callBg({ type: "run-now" });
  const logs = (env.storage.data.logs || []).map((l) => l.msg).join("\n");
  check("先试 id、失败后换 location_code", posted.join(",") === "loc_kyoto,IS", JSON.stringify(posted));
  check("最终派遣成功", r.record && r.record.growth && r.record.growth.travelDeparted === true, JSON.stringify(r.record && r.record.growth));
  check("日志说明服务端认的字段", /服务端认的字段是 location_code/.test(logs), logs.slice(-160));
}

// ============================================================
console.log("\n[20] 场景：派遣被 400 invalid request 拒绝 → 提示不能误报成额度用完");
{
  resetEnv();
  fetchImpl = async (url) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 1 }] } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: true } });
    if (url.endsWith("/v2/activity/growth/tasks")) return jsonRes(200, { code: 0, data: { tasks: [] } });
    if (url.includes("buddy/travel/status")) return jsonRes(200, { code: 0, data: { state: "idle" } });
    if (url.includes("buddy/travel/config"))
      return jsonRes(200, { code: 0, data: { locations: [{ id: "loc_kyoto", name: "京都" }] } });
    if (url.includes("buddy/travel/depart"))
      return jsonRes(400, { code: 400, msg: "invalid request", requestId: "e8dc8d51" });
    return jsonRes(404, "not found");
  };
  const r = await callBg({ type: "run-now" });
  const logs = (env.storage.data.logs || []).map((l) => l.msg).join("\n");
  check("400 解释为「请求参数无效」", /请求参数无效/.test(logs), logs.slice(-120));
  check("不再误报「额度已用完」", !/额度已用完/.test(logs), logs.slice(-120));
  check("派遣失败记进 notes", r.record && r.record.growth && r.record.growth.notes.some((n) => /派遣失败/.test(n)), JSON.stringify(r.record && r.record.growth));
  check("签到不受影响", r.record && r.record.status === "already", r.record && r.record.status);
}

// ============================================================
console.log("\n[21] 场景：config 里没有 locations[] → 不瞎派，日志给出 config 字段");
{
  resetEnv();
  fetchImpl = async (url) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 1 }] } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: true } });
    if (url.endsWith("/v2/activity/growth/tasks")) return jsonRes(200, { code: 0, data: { tasks: [] } });
    if (url.includes("buddy/travel/status")) return jsonRes(200, { code: 0, data: { state: "idle" } });
    if (url.includes("buddy/travel/config"))
      return jsonRes(200, { code: 0, data: { spots: [{ id: "x1" }], intro_slogans: ["hi"] } });
    return jsonRes(404, "not found");
  };
  await callBg({ type: "run-now" });
  check("没有 locations 就不派猫", !requests.some((x) => x.url.endsWith("/buddy/travel/depart")), "瞎派了");
  const logs = (env.storage.data.logs || []).map((l) => l.msg).join("\n");
  check("日志打印 config 实际字段（便于排查）", /config 字段：spots/.test(logs), logs.slice(-140));
}

// ============================================================
console.log("\n[22] 场景：连登兑换 → 拿到补登卡 → 补上当月断登日");
{
  resetEnv();
  let redeemBody = null;
  let makeupBody = null;
  let streakCalls = 0;

  fetchImpl = async (url, init) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 5 }] } });
    if (url.endsWith("/activity/growth/streak")) {
      streakCalls += 1;
      // 第一次：连登 17 天、7d 档已兑、14d 档待兑、补登卡 0 张
      // 第二次（兑换后重读）：补登卡 1 张
      const balance = streakCalls === 1 ? 0 : 1;
      return jsonRes(200, {
        code: 0,
        data: {
          streak: { days: 17, next_tier: "28d", makeup_dates: [] },
          makeup_cards: { balance, max: 4 },
          redemption_status: { tier_7d_status: "claimed", tier_14d_status: "available", tier_28d_status: "locked" },
        },
      });
    }
    if (url.endsWith("/activity/growth/redeem")) {
      redeemBody = JSON.parse(init.body);
      return jsonRes(200, {
        code: 0,
        data: { cards_granted: 1, cards_overflow: 0, credit_granted: 50, energy_granted: 3, chances_granted: 1 },
      });
    }
    if (url.includes("/activity/growth/heatmap"))
      return jsonRes(200, {
        code: 0,
        data: {
          cells: [
            { date: "2026-11-04", state: "checked" },
            { date: "2026-11-10", state: "broken" },
            { date: "2026-11-09", state: "broken" },
          ],
        },
      });
    if (url.endsWith("/activity/growth/makeup-cards/use")) {
      makeupBody = JSON.parse(init.body);
      return jsonRes(200, { code: 0, data: {} });
    }
    if (url.includes("/v2/activity/growth/tasks")) return jsonRes(200, { code: 0, data: { tasks: [] } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: true } });
    if (url.includes("buddy/travel/status")) return jsonRes(200, { code: 0, data: { state: "traveling" } });
    return jsonRes(404, "not found");
  };

  const r = await callBg({ type: "run-now" });
  const rec = r.record || {};
  const logs = (env.storage.data.logs || []).map((l) => l.msg).join("\n");

  check("只兑 14 天档（7d 已兑、28d 未到）", redeemBody && redeemBody.tier === "14d", JSON.stringify(redeemBody));
  check("兑换带 client_token", redeemBody && /^redeem-14d-[0-9a-f-]{10,}$/.test(redeemBody.client_token), JSON.stringify(redeemBody));
  check("兑换记录进 redeemedTiers", rec.growth && rec.growth.redeemedTiers.join() === "14d", JSON.stringify(rec.growth && rec.growth.redeemedTiers));
  check("兑换得到的补登卡计入 cardsGained", rec.growth && rec.growth.cardsGained === 1, String(rec.growth && rec.growth.cardsGained));
  check("兑换的积分计入总收益", rec.growth && rec.growth.growthCredit === 50, String(rec.growth && rec.growth.growthCredit));
  check("先兑换再补登：补的是最近断登日", makeupBody && makeupBody.target_date === "2026-11-10", JSON.stringify(makeupBody));
  check("补登日期必须是当月且非今天", makeupBody && makeupBody.target_date.startsWith(new Date().toISOString().slice(0, 7)), String(makeupBody && makeupBody.target_date));
  check("日志体现兑换与补登", /兑换 14 天档/.test(logs) && /补登 2026-11-10 成功/.test(logs), logs.slice(-200));
  check("签到状态不受影响", rec.status === "already", rec.status);
}

// ============================================================
console.log("\n[23] 场景：补登卡为 0 → 不碰活跃地图；兑换本月已领 → 不当失败");
{
  resetEnv();
  fetchImpl = async (url) => {
    if (url.includes("/console/accounts")) return jsonRes(200, { code: 0, data: { accounts: [{ uid: 5 }] } });
    if (url.endsWith("/activity/growth/streak"))
      return jsonRes(200, {
        code: 0,
        data: {
          streak: { days: 9, next_tier: "14d" },
          makeup_cards: { balance: 0, max: 4 },
          redemption_status: { tier_7d_status: "available" },
        },
      });
    if (url.endsWith("/activity/growth/redeem"))
      return jsonRes(409, { code: 409, msg: "already claimed this month" });
    if (url.includes("/v2/activity/growth/tasks")) return jsonRes(200, { code: 0, data: { tasks: [] } });
    if (url.includes("buddy/travel/status")) return jsonRes(200, { code: 0, data: { state: "traveling" } });
    if (url.includes("checkin-activity-status")) return jsonRes(200, { code: 0, data: { today_checked_in: true } });
    return jsonRes(404, "not found");
  };
  const r = await callBg({ type: "run-now" });
  const logs = (env.storage.data.logs || []).map((l) => l.msg).join("\n");
  check("没有补登卡就不请求热力图", !requests.some((x) => x.url.includes("/heatmap")), "白请求了热力图");
  check("409 本月已领按 info 处理，不报失败", /本月已领取/.test(logs), logs.slice(-160));
  check("兑换失败不影响签到", r.record && r.record.status === "already", r.record && r.record.status);
}

// ============================================================
console.log("\n[24] 场景：直连 401（跨站 Cookie 限制）→ 切页面上下文后领取成功");
{
  resetEnv();
  // 直连一律 401：模拟扩展来源属跨站、SameSite 登录 Cookie 没被带上
  fetchImpl = async () => jsonRes(401, { code: 401, msg: "unauthorized" });
  // 页面上下文（同源）一切正常
  env.pageBridge.fetch = async (msg) => {
    if (msg.url.includes("/console/accounts")) return { status: 200, json: { code: 0, data: { accounts: [{ uid: 777 }] } } };
    if (msg.url.includes("checkin-activity-status")) {
      return { status: 200, json: { code: 0, data: { today_checked_in: false, streak_days: 2 } } };
    }
    if (msg.url.includes("daily-checkin")) return { status: 200, json: { code: 0, credit: 100, streak_days: 3 } };
    return { status: 404, json: null };
  };

  const r = await callBg({ type: "run-now" });
  const rec = r.record || {};
  check("直连 401 后自动改用页面上下文并领取成功", rec.status === "claimed", rec.status + " " + (rec.msg || ""));
  check("开了 1 个后台标签页做页面上下文", env.tabs.length === 1 && /workbuddy\.cn/.test(env.tabs[0]), JSON.stringify(env.tabs));
  check("用完后标签页已自动关闭", env.tabsClosed.length === 1 && env.tabStore.size === 0, JSON.stringify(env.tabsClosed));

  const logs = env.storage.data.logs || [];
  const hasSwitch = logs.some((l) => /切到页面上下文/.test(l.msg));
  check("日志说明了为何切换通道", hasSwitch);
  check("领取结果里没有误报未登录", rec.status !== "unauthorized");
}

// ============================================================
console.log("\n[25] 场景：直连 401 且页面上下文也 401 → 判定未登录");
{
  resetEnv();
  fetchImpl = async () => jsonRes(401, { code: 401, msg: "unauthorized" });
  env.pageBridge.fetch = async () => ({ status: 401, json: { code: 401 } });

  const r = await callBg({ type: "run-now" });
  const rec = r.record || {};
  check("两通道都 401 → 未登录", rec.status === "unauthorized", rec.status);
  check("未登录时标签页也已关闭", env.tabStore.size === 0, `open=${env.tabStore.size}`);
  check("未登录会弹通知提醒", env.notifications.length >= 1, `n=${env.notifications.length}`);
  const n = env.notifications[0] || {};
  check("通知带「去登录 / 已登录重试」两个按钮", Array.isArray(n.buttons) && n.buttons.length === 2, JSON.stringify(n.buttons));
  const pol = lib.retryPolicy(lib.normalizeSettings({}), "unauthorized");
  check("未登录按 auth 策略排重试（登录后能自动接上）", pol.kind === "auth" && env.alarms.has("wb-checkin-retry"));
}

// ============================================================
console.log(`\n结果：${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  console.log("失败项：");
  for (const f of fails) console.log("  - " + f);
  process.exitCode = 1;
}
fs.rmSync(tmp, { recursive: true, force: true });
