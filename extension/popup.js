import { normalizeSettings, describeResult, fmtDateTime, formatLogLine } from "./lib.js";

const ALARM_DAILY = "wb-checkin-daily";
const LOGIN_URL = "https://www.workbuddy.cn/app";
const $ = (id) => document.getElementById(id);

function pillClass(last) {
  if (!last) return "";
  if (last.status === "claimed" || last.status === "already") return "ok";
  if (last.status === "unauthorized" || last.status === "error") return "bad";
  return "warn";
}

function pillText(last, settings) {
  if (!last) return "未运行";
  if (last.status === "claimed") return "已签到";
  if (last.status === "already") return "今日已签";
  if (last.status === "unauthorized") return "未登录";
  if (last.status === "error") return "失败";
  if (last.status === "notEligible") return "无资格";
  if (last.status === "ended") return "已结束";
  return settings.enabled ? "待运行" : "已关闭";
}

async function render() {
  const got = await chrome.storage.local.get(["settings", "last", "logs"]);
  const s = normalizeSettings(got.settings);
  const last = got.last || null;
  const logs = Array.isArray(got.logs) ? got.logs : [];

  const d = describeResult(last);
  $("headline").textContent = d.title;
  $("subline").textContent = d.detail || "";

  const pill = $("pill");
  pill.className = "pill " + pillClass(last);
  pill.textContent = pillText(last, s);

  $("streak").textContent = last && last.streakDays != null ? `${last.streakDays} 天` : "—";
  // 今日积分 = 签到 + 成长体系（任务 / 猫猫）合计，一眼看到今天到底进账多少
  const gc = last && last.growth && Number.isFinite(Number(last.growth.growthCredit)) ? Number(last.growth.growthCredit) : 0;
  const baseCredit = last && Number.isFinite(Number(last.credit)) ? Number(last.credit) : 0;
  $("credit").textContent =
    last && (last.credit != null || gc > 0)
      ? `+${baseCredit + gc}`
      : last && last.status === "already"
      ? "已领"
      : "—";
  $("last").textContent = last && last.at ? fmtDateTime(last.at).slice(5, 16) : "—";

  let alarm = null;
  try {
    alarm = await chrome.alarms.get(ALARM_DAILY);
  } catch {
    alarm = null;
  }
  $("next").textContent = !s.enabled
    ? "已关闭"
    : alarm && alarm.scheduledTime
    ? fmtDateTime(alarm.scheduledTime).slice(5, 16)
    : "待安排";

  $("logList").textContent = logs.length ? logs.slice(-6).map(formatLogLine).join("\n") : "（暂无日志）";

  const unauth = Boolean(last && last.status === "unauthorized");
  $("login").classList.toggle("hidden", !unauth);

  $("foot").textContent = s.enabled
    ? `每天 ${s.time} 自动签到${s.jitterMin ? `（+0~${s.jitterMin} 分钟随机）` : ""} · 需浏览器保持运行`
    : "定时签到已关闭，只能手动触发";
}

$("run").addEventListener("click", async () => {
  const btn = $("run");
  btn.disabled = true;
  btn.textContent = "签到中…";
  try {
    const r = await chrome.runtime.sendMessage({ type: "run-now" });
    if (!r || !r.ok) throw new Error((r && r.error) || "后台无响应");
  } catch (e) {
    $("subline").textContent = "运行失败：" + (e && e.message ? e.message : e);
  } finally {
    btn.disabled = false;
    btn.textContent = "立即签到";
    await render();
  }
});

$("login").addEventListener("click", () => {
  chrome.tabs.create({ url: LOGIN_URL });
});

$("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") render();
});

render();
