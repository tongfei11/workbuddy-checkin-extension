// ============================================================
// lib.js —— 纯逻辑，不依赖任何 chrome.* API
// 目的：可以被 Node 直接 import 做单元测试（tools/test-extension.mjs）
// ============================================================

export const DEFAULT_SETTINGS = {
  enabled: true,
  time: "09:00",        // 每天触发时间（本地时区，HH:MM）
  jitterMin: 10,        // 在触发时间后随机延迟 0~N 分钟，避免整点扎堆
  retryTimes: 2,        // 网络/服务端失败的重试次数
  retryGapMin: 30,      // 网络失败的重试间隔（分钟）
  authRetryTimes: 4,    // 未登录时的轮询次数（用户登录后能自动接上）
  authRetryGapMin: 30,  // 未登录的轮询间隔（分钟）
  notifyOnSuccess: false, // 成功也弹通知（默认只弹失败）
  notifyOnFailure: true,
  domain: "auto",       // auto | www.workbuddy.cn | copilot.tencent.com
  logRetain: 300,       // 日志保留条数

  // ---------- 成长体系（任务中心 / 猫猫旅行）----------
  growth: true,         // 签到后顺带跑成长体系（任务中心 + 猫猫）
  autoAccept: true,     // 自动接受 not_accepted 的任务（否则只领已完成）
  travel: true,         // 猫猫：有奖就领、没出门就派一趟
  redeem: true,         // 连登兑换：7/14/28 天档奖励（补登卡就来自这里）
  makeup: true,         // 断登时用补登卡补上（保住连续天数）
  travelFollowUp: true, // 猫猫回程后按 arrive_at 再跑一次，专程领奖（否则要等明天）
};

export const API_BASES = {
  "www.workbuddy.cn": "https://www.workbuddy.cn",
  "copilot.tencent.com": "https://copilot.tencent.com",
};

// 端点：网页版/桌面端一致，桌面端在前缀上加 /v2（见 checkin.ps1 的旧实现）
export const ACCOUNTS_PATH = "/console/accounts";
export const STATUS_PATH = "/billing/meter/checkin-activity-status";
export const CHECKIN_PATH = "/billing/meter/daily-checkin";
export const V2_PREFIX = "/v2";

// ---------- 成长体系接口（逆向自 www.workbuddy.cn/profile/growth-center 的前端分包）----------
// 注意前缀不对称：任务清单带 /v2，领取/接受不带 —— 照抄前端，别自作聪明统一。
export const TASKS_PATH = "/v2/activity/growth/tasks";
export const TASK_ACCEPT_PATH = "/activity/growth/tasks/accept";
export const taskClaimPath = (code) => `/activity/growth/tasks/${encodeURIComponent(code)}/claim`;
export const TRAVEL_STATUS_PATH = "/activity/growth/buddy/travel/status";
export const TRAVEL_CONFIG_PATH = "/activity/growth/buddy/travel/config";
export const TRAVEL_DEPART_PATH = "/activity/growth/buddy/travel/depart";
export const TRAVEL_CLAIM_PATH = "/activity/growth/buddy/travel/claim";
// 连登兑换 / 补登卡（逆向自 growthSpace 的 store）
export const STREAK_PATH = "/activity/growth/streak";
export const REDEEM_PATH = "/activity/growth/redeem";
export const HEATMAP_PATH = "/activity/growth/heatmap";
export const MAKEUP_PATH = "/activity/growth/makeup-cards/use";
// 兑换档位（前端默认值：7d 给 1 张补登卡，14d/28d 另有积分）
export const REDEEM_TIERS = [
  { tier: "7d", days: 7 },
  { tier: "14d", days: 14 },
  { tier: "28d", days: 28 },
];

// 任务状态（前端枚举原样）
export const TASK_STATE = {
  NOT_ACCEPTED: "not_accepted",
  ACCEPTED: "accepted",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  CLAIMED: "claimed",
};

// 业务码：1001 是当前客户端 QJo() 的映射（AlreadyClaimed）；
// 10001 是旧桌面端/早期脚本的写法，一并认，避免误报失败。
export const BIZ = {
  ALREADY: new Set([1001, 10001]),
  NOT_ELIGIBLE: 1002,
  EVENT_ENDED: 1003,
};

// ---------- 设置归一化 ----------
export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === "object" ? raw : {}) };
  const out = { ...DEFAULT_SETTINGS };

  out.enabled = s.enabled !== false;

  out.time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.time || "")) ? String(s.time) : DEFAULT_SETTINGS.time;

  out.jitterMin = clampInt(s.jitterMin, 0, 120, DEFAULT_SETTINGS.jitterMin);
  out.retryTimes = clampInt(s.retryTimes, 0, 5, DEFAULT_SETTINGS.retryTimes);
  out.retryGapMin = clampInt(s.retryGapMin, 5, 240, DEFAULT_SETTINGS.retryGapMin);
  out.authRetryTimes = clampInt(s.authRetryTimes, 0, 12, DEFAULT_SETTINGS.authRetryTimes);
  out.authRetryGapMin = clampInt(s.authRetryGapMin, 5, 240, DEFAULT_SETTINGS.authRetryGapMin);
  out.logRetain = clampInt(s.logRetain, 50, 2000, DEFAULT_SETTINGS.logRetain);

  out.notifyOnSuccess = s.notifyOnSuccess === true;
  out.notifyOnFailure = s.notifyOnFailure !== false;

  out.domain = Object.prototype.hasOwnProperty.call(API_BASES, s.domain) ? s.domain : "auto";

  out.growth = s.growth !== false;
  out.autoAccept = s.autoAccept !== false;
  out.travel = s.travel !== false;
  out.redeem = s.redeem !== false;
  out.makeup = s.makeup !== false;
  out.travelFollowUp = s.travelFollowUp !== false;
  return out;
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ---------- 域名候选 ----------
// auto：先试 WorkBuddy 主站，再试旧 CodeBuddy 站（谁的 Cookie 在就认谁）
export function domainCandidates(domain) {
  if (domain in API_BASES) return [API_BASES[domain]];
  return [API_BASES["www.workbuddy.cn"], API_BASES["copilot.tencent.com"]];
}

// ---------- 端点候选 ----------
// 先打无前缀（网页版），404 再打 /v2（桌面端旧路径）
export function endpointCandidates(base, path) {
  return [
    { url: base + path, path, prefix: "" },
    { url: base + V2_PREFIX + path, path: V2_PREFIX + path, prefix: V2_PREFIX },
  ];
}

// ---------- 时间计算 ----------
export function parseTimeOfDay(time) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time || ""));
  if (!m) return { h: 9, m: 0 };
  return { h: Number(m[1]), m: Number(m[2]) };
}

// 下一次运行的时间戳。触发时间已过（或正好等于 now）就排到明天。
// rand 注入便于测试；jitter 只加不减，保证“每天几点之后”的语义。
export function nextRunAt(settings, fromTs = Date.now(), rand = Math.random) {
  const s = normalizeSettings(settings);
  const { h, m } = parseTimeOfDay(s.time);
  const jitterMs = Math.floor(rand() * (s.jitterMin + 1)) * 60000;

  const d = new Date(fromTs);
  let at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
  if (at + jitterMs <= fromTs) {
    at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m, 0, 0).getTime();
  }
  return at + jitterMs;
}

// 两类失败分开对待：
// - net（网络/5xx）：短间隔、少量次数，抖动一下自己就好了
// - auth（未登录）：长间隔轮询，用户中途登录后下一次轮询就能领到
export function retryPolicy(settings, status) {
  const s = normalizeSettings(settings);
  if (status === "unauthorized") {
    return { kind: "auth", max: s.authRetryTimes, gapMin: s.authRetryGapMin, label: "未登录" };
  }
  if (status === "error") {
    return { kind: "net", max: s.retryTimes, gapMin: s.retryGapMin, label: "请求失败" };
  }
  return null;
}

export function retryAt(settings, status, fromTs = Date.now()) {
  const p = retryPolicy(settings, status);
  const gap = p ? p.gapMin : normalizeSettings(settings).retryGapMin;
  return fromTs + gap * 60000;
}

export function fmtDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 响应解析 ----------
// checkin-activity-status：{code:0, data:{today_checked_in, streak_days, ...}}
export function parseStatusResponse(json) {
  const data = json && typeof json === "object" ? json.data : null;
  if (!json || typeof json !== "object" || json.code !== 0 || !data) {
    return {
      ok: false,
      code: json && json.code,
      msg: (json && (json.msg || json.message)) || "状态接口返回异常",
    };
  }
  const n = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
  return {
    ok: true,
    active: data.active === true,
    todayCheckedIn: data.today_checked_in === true,
    streakDays: n(data.streak_days),
    dailyCredit: n(data.daily_credit),
    todayCredit: n(data.today_credit),
    totalCredits: data.total_credits == null ? null : n(data.total_credits),
    nextStreakDay: data.next_streak_day == null ? null : n(data.next_streak_day),
    isStreakDay: data.is_streak_day === true,
    activityName: typeof data.activity_name === "string" ? data.activity_name : "",
    claimButtonText: typeof data.claim_button_text === "string" ? data.claim_button_text : "",
  };
}

// daily-checkin：{code:0, credit, streak_days, is_streak_day}（字段在顶层，不在 data 里）
export function parseCheckinResponse(json) {
  if (!json || typeof json !== "object") {
    return { status: "error", code: null, msg: "响应不是 JSON" };
  }
  const code = typeof json.code === "number" ? json.code : null;
  const msg = typeof json.msg === "string" ? json.msg : typeof json.message === "string" ? json.message : "";

  if (code && code !== 0) {
    if (BIZ.ALREADY.has(code)) return { status: "already", code, msg: msg || "今日已签到" };
    if (code === BIZ.NOT_ELIGIBLE) return { status: "notEligible", code, msg: msg || "当前账号不符合签到条件" };
    if (code === BIZ.EVENT_ENDED) return { status: "ended", code, msg: msg || "活动已结束" };
    return { status: "error", code, msg: msg || `业务错误码 ${code}` };
  }

  // 顶层优先，data 兜底（历史上两种形态都出现过）
  const src = [json, json.data].find((o) => o && (o.credit != null || o.streak_days != null)) || json;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    status: "claimed",
    code: 0,
    credit: num(src.credit),
    streakDays: num(src.streak_days),
    isStreakDay: src.is_streak_day === true,
    msg,
  };
}

// ---------- 成长体系：任务中心 ----------
// GET /v2/activity/growth/tasks 的形态：
//   {code:0, data:{tasks:[{task_code,title,status,credit,...}]}} 或 {code:0,data:[...]}
// 字段名做了宽容处理（task_code/taskCode/code，status/task_status/state），
// 因为这类活动的响应字段会随运营配置变；解析失败不抛错，交给调用方跳过。
export function parseTasksResponse(json) {
  if (!json || typeof json !== "object") return { ok: false, msg: "响应不是 JSON", tasks: [] };
  const code = typeof json.code === "number" ? json.code : 0;
  if (code !== 0) {
    return { ok: false, code, msg: json.msg || json.message || `业务错误码 ${code}`, tasks: [] };
  }
  const data = json.data;
  const raw = Array.isArray(data) ? data : (data && (data.tasks || data.list || data.items)) || [];
  if (!Array.isArray(raw)) return { ok: true, tasks: [] };

  const tasks = raw
    .map((t) => {
      if (!t || typeof t !== "object") return null;
      const taskCode = t.task_code || t.taskCode || t.code || t.id;
      if (!taskCode) return null;
      // 真实字段是 acceptStatus（camelCase）。之前只认 status，导致「待接受」永远是 0，
      // 于是「去完成」的任务一个都没被接受 —— 任务进不了进行中，自然也就领不到奖励。
      const status = String(t.acceptStatus || t.accept_status || t.status || t.task_status || t.state || "").toLowerCase();
      const taskType = String(t.taskType || t.task_type || "").toLowerCase();
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
      return {
        taskCode: String(taskCode),
        title: String(t.title || t.name || t.task_name || taskCode),
        status,
        taskType,
        hasReward: t.hasReward === undefined && t.has_reward === undefined
          ? true
          : t.hasReward === true || t.has_reward === true,
        credit: num(t.rewardCredit ?? t.reward_credit ?? t.credit ?? t.reward),
        progress: num(t.progress),
        target: num(t.total ?? t.target ?? t.progress_target),
      };
    })
    .filter(Boolean);

  return {
    ok: true,
    tasks,
    // 已完成且「有奖励」才领；没奖励的已完成任务点了也没用
    claimable: tasks.filter((t) => t.status === TASK_STATE.COMPLETED && t.hasReward),
    // auto / beginner 类型的前端不调 accept（会自动接受），只跳转；这里也不碰，避免无谓请求
    acceptable: tasks.filter(
      (t) => t.status === TASK_STATE.NOT_ACCEPTED && t.taskType !== "auto" && t.taskType !== "beginner"
    ),
    autoAccepted: tasks.filter(
      (t) => t.status === TASK_STATE.NOT_ACCEPTED && (t.taskType === "auto" || t.taskType === "beginner")
    ),
  };
}

// 单个任务领取结果：0=领到（credit 可能没有），其余码按「已领过」或失败区分
export function parseClaimResult(json) {
  if (!json || typeof json !== "object") return { status: "error", msg: "响应不是 JSON" };
  const code = typeof json.code === "number" ? json.code : 0;
  const msg = json.msg || json.message || "";
  if (code === 0) {
    const src = json.data && typeof json.data === "object" ? json.data : json;
    const credit = Number.isFinite(Number(src.credit)) ? Number(src.credit) : null;
    return { status: "claimed", code, credit, msg };
  }
  if (BIZ.ALREADY.has(code)) return { status: "claimed", code, credit: null, msg: msg || "已领取" };
  return { status: "error", code, msg: msg || `业务错误码 ${code}` };
}

// ---------- 成长体系：猫猫旅行 ----------
// 真实形态（逆向自 GrowthCenterPage 的 travel store）：
//   travel/status -> {code:0, data:{ state:"idle"|"traveling"|"arrived",
//                                   location:{id,name}, depart_at, arrive_at,
//                                   daily_limit_reached:boolean, reward_credit }}
//   前端状态机：state==="traveling" → 倒计时页；state==="arrived" → 拆信页（可领）；
//              state==="idle" 且 !daily_limit_reached → 选地点页（可派）。
export function parseTravelStatus(json) {
  if (!json || typeof json !== "object") return { ok: false, msg: "响应不是 JSON" };
  const code = typeof json.code === "number" ? json.code : 0;
  if (code !== 0) return { ok: false, code, msg: json.msg || json.message || `业务错误码 ${code}` };

  const d = (json.data && typeof json.data === "object" ? json.data : json) || {};
  const state = String(d.state || d.travel_status || d.status || "").toLowerCase();
  const dailyLimitReached = d.daily_limit_reached === true;
  const locName = d.location && typeof d.location === "object" ? String(d.location.name || d.location.title || "") : "";

  // 没给 state 时退回启发式（老版本/字段改名时不至于完全失效）
  const traveling = state ? state === "traveling" : d.traveling === true;
  const arrived = state ? state === "arrived" : d.arrived === true;

  return {
    ok: true,
    state: state || (traveling ? "traveling" : arrived ? "arrived" : "idle"),
    traveling,
    arrived,
    canClaim: arrived,
    // 只有「在家 + 今天额度没用完」才能派；额度用完时前端按钮也是 disabled
    canDepart: !traveling && !arrived && !dailyLimitReached,
    dailyLimitReached,
    locationName: locName,
    arriveAt: Number(d.arrive_at) || 0,
    raw: d,
  };
}

// 从 travel/config 挑一个可派的地点。
// 严格按前端来：locations 在 data.locations[]，每个地点用它自己的 id。
// 之前用「递归收集所有带 id 的对象」会误抓 preview_photos[].id / intro_slogan_items[].expert_id，
// 派出去就是 400 invalid request（服务端只认地点 id）。
export function pickDepartLocation(configJson, rand = Math.random) {
  if (!configJson || typeof configJson !== "object") return null;
  const d = (configJson.data && typeof configJson.data === "object" ? configJson.data : configJson) || {};
  const list = Array.isArray(d.locations) ? d.locations : [];

  const usable = list
    .filter((l) => l && typeof l === "object" && l.id != null && typeof l.id !== "object")
    .map((l) => ({
      // rawId 保留原始类型（数字就发数字）：服务端对 location_id 做类型校验时，
      // 把 123 变成 "123" 会被判成 invalid request。
      rawId: l.id,
      name: String(l.name || l.title || l.city || l.location_name || ""),
      raw: l,
    }));
  if (!usable.length) return null;

  const idx = Math.min(usable.length - 1, Math.floor(rand() * usable.length));
  return { ...usable[idx], total: usable.length, firstRawId: usable[0].rawId };
}

// 派遣参数候选：前端传的是 locations[].id，但服务端字段可能叫别的（历史上这类活动改过 key）。
// 400 invalid request 是没有副作用的安全失败，所以按「id → location_code → code → city_id」依次试，
// 第一个成功就停。全部失败时上游会打诊断日志。
export function departCandidates(loc) {
  const raw = (loc && loc.raw) || {};
  const out = [];
  const seen = new Set();
  const push = (field, v) => {
    if (v == null || typeof v === "object") return;
    const key = `${typeof v}:${String(v)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ field, value: v });
  };
  push("id", raw.id);
  push("location_code", raw.location_code ?? raw.locationCode);
  push("code", raw.code);
  push("city_id", raw.city_id ?? raw.cityId);
  push("key", raw.key ?? raw.slug);
  return out.slice(0, 4);
}

// 服务端错误文案 → 人话。前端的 toast 逻辑就是这么分类的。
export function explainGrowthError(msg) {
  const m = String(msg || "").toLowerCase();
  if (m.includes("daily limit")) return "今天这一趟额度已用完，明天再来";
  if (m.includes("no active buddy")) return "还没有 Buddy，先在成长计划里领一只";
  if (m.includes("already traveling")) return "Buddy 已经在路上";
  if (m.includes("location not available")) return "这个地点暂不可用";
  if (m.includes("not arrived yet")) return "Buddy 还没回来";
  if (m.includes("no unclaimed travel")) return "没有待领取的旅行奖励";
  if (m.includes("not completed")) return "任务还没真正完成（服务端会校验）";
  if (m.includes("invalid request")) return "请求参数无效";
  return "";
}

// ---------- 成长体系：连登兑换 / 补登卡 ----------
// GET /activity/growth/streak 的真实形态（来自 growthSpace 的 store）：
//   {code:0, data:{
//     streak:{days, next_tier, makeup_dates:[]},
//     makeup_cards:{balance, max},
//     redemption_status:{tier_7d_status, tier_14d_status, tier_28d_status}}}
// 前端兑换成功后把对应 tier_*_status 置为 "claimed"，所以这里按「不是 claimed」判断可兑。
export function parseStreak(json) {
  if (!json || typeof json !== "object") return { ok: false, msg: "响应不是 JSON" };
  const code = typeof json.code === "number" ? json.code : 0;
  if (code !== 0) return { ok: false, code, msg: json.msg || json.message || `业务错误码 ${code}` };

  const d = (json.data && typeof json.data === "object" ? json.data : null) || {};
  const streak = d.streak || {};
  const cards = d.makeup_cards || {};
  const rs = d.redemption_status || {};
  const n = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt);

  const tierStatus = {};
  for (const { tier } of REDEEM_TIERS) {
    tierStatus[tier] = String(rs[`tier_${tier}_status`] || "").toLowerCase();
  }

  return {
    ok: true,
    days: n(streak.days),
    nextTier: String(streak.next_tier || ""),
    makeupBalance: n(cards.balance),
    makeupMax: n(cards.max, 4),
    makeupDates: Array.isArray(streak.makeup_dates) ? streak.makeup_dates.map(String) : [],
    tierStatus,
    raw: d,
  };
}

// 哪些档位该去兑：连登天数够了且这个月还没兑过。
// 服务端仍会再校验（409 = 本月已领/重复），所以这里只是少打无谓请求。
export function redeemCandidates(streak) {
  if (!streak || !streak.ok) return [];
  return REDEEM_TIERS.filter(({ tier, days }) => streak.days >= days && streak.tierStatus[tier] !== "claimed").map(
    ({ tier, days }) => ({ tier, days })
  );
}

// redeem 结果：成功返回发放明细；409 duplicate 说明重复提交（幂等，当成功）；409 其他=本月已领；403=连登不够
export function parseRedeemResult(json, httpStatus) {
  const code = json && typeof json === "object" && typeof json.code === "number" ? json.code : 0;
  const msg = (json && (json.msg || json.message)) || "";
  if (httpStatus === 403) return { status: "notEligible", msg: msg || "连续登录天数不足" };
  if (httpStatus === 409) {
    // 409 都是「已经领过」：duplicate 是同一 client_token 重放，其余是本月已领。
    // 统一说人话，原始英文放 rawMsg 留档。
    if (/duplicate/i.test(msg)) return { status: "already", msg: "重复提交，已按已领取处理", rawMsg: msg };
    return { status: "already", msg: "本月已领取", rawMsg: msg };
  }
  if (httpStatus >= 400 || code !== 0) return { status: "error", msg: msg || `HTTP ${httpStatus}` };

  const d = (json && json.data) || {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    status: "claimed",
    msg,
    cardsGranted: n(d.cards_granted),
    cardsOverflow: n(d.cards_overflow),
    creditGranted: n(d.credit_granted),
    energyGranted: n(d.energy_granted),
    chancesGranted: n(d.chances_granted),
  };
}

// 热力图：{data:{cells:[{date, state}], today}}
// state: checked / today / broken / todo / other
export function parseHeatmap(json) {
  if (!json || typeof json !== "object") return { ok: false, msg: "响应不是 JSON", brokenDates: [] };
  const code = typeof json.code === "number" ? json.code : 0;
  if (code !== 0) return { ok: false, code, msg: json.msg || json.message || `业务错误码 ${code}`, brokenDates: [] };
  const d = (json.data && typeof json.data === "object" ? json.data : {}) || {};
  const cells = Array.isArray(d.cells) ? d.cells : [];
  const brokenDates = cells
    .filter((c) => c && String(c.state) === "broken" && c.date)
    .map((c) => String(c.date));
  return { ok: true, cells, brokenDates, today: d.today ? String(d.today) : "" };
}

// 挑一个可补的日期：只能是「当月、非今天、非未来」的断登日。
// 服务端还会校验（future date / history month / date not broken / already made up），
// 这里先自己筛一遍，避免明知会失败的请求。
export function pickMakeupDate(brokenDates, today = new Date()) {
  const list = Array.isArray(brokenDates) ? brokenDates.filter(Boolean).map(String) : [];
  const p = (n) => String(n).padStart(2, "0");
  const todayStr = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  const monthPrefix = todayStr.slice(0, 7);

  const usable = list.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d.startsWith(monthPrefix) && d < todayStr);
  if (!usable.length) return null;
  // 补最近的一天：对连续天数最有价值
  return usable.sort().pop();
}

export function explainMakeupError(msg) {
  const m = String(msg || "").toLowerCase();
  if (m.includes("no makeup card")) return "没有补登卡（先兑换 7 天档奖励才有）";
  if (m.includes("future date")) return "不能补未来日期";
  if (m.includes("cannot makeup history month")) return "只能补当月，历史月份不行";
  if (m.includes("before launch")) return "该日期早于活动上线日";
  if (m.includes("date not broken")) return "那天没断，无需补登";
  if (m.includes("already made up")) return "那天已经补过了";
  return "";
}

// ---------- 日志 ----------
export function trimLogs(logs, retain) {
  const list = Array.isArray(logs) ? logs : [];
  const keep = clampInt(retain, 10, 5000, DEFAULT_SETTINGS.logRetain);
  return list.length > keep ? list.slice(list.length - keep) : list;
}

export function formatLogLine(entry) {
  const lvl = String((entry && entry.lvl) || "info").toUpperCase().padEnd(4, " ");
  const msg = String((entry && entry.msg) || "").replace(/\s+/g, " ").trim();
  return `[${fmtDateTime((entry && entry.t) || Date.now())}] ${lvl} ${msg}`;
}

export function exportLogText(logs) {
  const list = Array.isArray(logs) ? logs : [];
  if (!list.length) return "";
  return list.map(formatLogLine).join("\n") + "\n";
}

// ---------- 结果文案 ----------
export function describeResult(last) {
  if (!last) return { title: "还没有运行记录", detail: "点「立即签到」试一次" };
  // 成长体系的收益挂在同一条记录上，拼进 detail 让通知/弹窗一次说清
  const g = last.growth;
  const extra = g && g.growthCredit ? ` · 成长 +${g.growthCredit} 积分` : "";
  switch (last.status) {
    case "claimed":
      return {
        title: "今日签到成功",
        detail: `+${last.credit == null ? "?" : last.credit} 积分` +
          (last.streakDays != null ? ` · 累计 ${last.streakDays} 天` : "") + extra,
      };
    case "already":
      return { title: "今日已签到", detail: (last.msg || "无需重复领取") + extra };
    case "unauthorized":
      return { title: "未登录", detail: "请在浏览器里登录 www.workbuddy.cn 后重试" };
    case "notEligible":
      return { title: "不符合条件", detail: last.msg || "当前账号无签到资格" };
    case "ended":
      return { title: "活动已结束", detail: last.msg || "签到活动已下线" };
    case "error":
      return { title: "签到失败", detail: last.msg || "未知错误" };
    default:
      return { title: last.status || "未知状态", detail: last.msg || "" };
  }
}
