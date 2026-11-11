import { normalizeSettings, fmtDateTime, exportLogText, describeResult, todayKey } from "./lib.js";

const $ = (id) => document.getElementById(id);
const ALARM_DAILY = "wb-checkin-daily";
const SITE_URL = "https://www.workbuddy.cn/app";

const FIELDS = [
  "enabled",
  "time",
  "jitterMin",
  "retryTimes",
  "retryGapMin",
  "authRetryTimes",
  "authRetryGapMin",
  "notifyOnFailure",
  "notifyOnSuccess",
  "domain",
  "logRetain",
  "growth",
  "autoAccept",
  "travel",
  "travelFollowUp",
  "redeem",
  "makeup",
];

let flashTimer = null;
function flash(msg) {
  $("saveMsg").textContent = msg;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    $("saveMsg").textContent = "";
  }, 5000);
}

function renderLogs(logs) {
  const list = Array.isArray(logs) ? logs : [];
  $("logView").textContent = list.length
    ? exportLogText(list).trimEnd()
    : "（暂无日志）";
  $("logCount").textContent = list.length
    ? `共 ${list.length} 条，最近一次 ${fmtDateTime(list[list.length - 1].t)}`
    : "";
}

async function renderState(last, s) {
  const d = describeResult(last);
  const parts = [last ? `上次：${fmtDateTime(last.at).slice(5, 16)} ${d.title}` : "还没有运行记录"];

  if (!s.enabled) {
    parts.push("定时已关闭");
    $("stateLine").textContent = parts.join(" · ");
    return;
  }
  try {
    const alarm = await chrome.alarms.get(ALARM_DAILY);
    parts.push(alarm && alarm.scheduledTime ? `下次：${fmtDateTime(alarm.scheduledTime).slice(5, 16)}` : "下次：待安排");
  } catch {
    parts.push("下次：未知");
  }
  $("stateLine").textContent = parts.join(" · ");
}

async function load() {
  const got = await chrome.storage.local.get(["settings", "last", "logs"]);
  const s = normalizeSettings(got.settings);
  for (const k of FIELDS) {
    const el = $(k);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = Boolean(s[k]);
    else el.value = s[k];
  }
  renderLogs(got.logs);
  await renderState(got.last, s);
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = {};
  for (const k of FIELDS) {
    const el = $(k);
    if (!el) continue;
    raw[k] = el.type === "checkbox" ? el.checked : el.value;
  }
  const s = normalizeSettings(raw);
  await chrome.storage.local.set({ settings: s });

  let next = null;
  try {
    const r = await chrome.runtime.sendMessage({ type: "settings-changed" });
    if (r && r.ok) next = r.next;
  } catch {
    // 后台未唤醒时忽略，设置已落盘，下次唤醒会重排
  }

  flash(!s.enabled ? "已保存：定时已关闭" : next ? `已保存，下次运行 ${fmtDateTime(next)}` : "已保存");
  await load();
});

$("runNow").addEventListener("click", async () => {
  const btn = $("runNow");
  btn.disabled = true;
  btn.textContent = "签到中…";
  try {
    const r = await chrome.runtime.sendMessage({ type: "run-now" });
    if (r && r.ok && r.record) {
      const d = describeResult(r.record);
      flash(`${d.title}：${d.detail}`);
    } else {
      flash("运行失败：" + ((r && r.error) || "后台无响应"));
    }
  } catch (err) {
    flash("运行失败：" + (err && err.message ? err.message : err));
  } finally {
    btn.disabled = false;
    btn.textContent = "立即签到";
    await load();
  }
});

$("openSite").addEventListener("click", () => {
  chrome.tabs.create({ url: SITE_URL });
});

$("exportLog").addEventListener("click", async () => {
  const got = await chrome.storage.local.get(["logs"]);
  const text = exportLogText(got.logs);
  if (!text) {
    flash("没有日志可导出");
    return;
  }
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `workbuddy-checkin-${todayKey()}.log`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flash("已导出日志");
});

$("copyLog").addEventListener("click", async () => {
  const got = await chrome.storage.local.get(["logs"]);
  const text = exportLogText(got.logs);
  if (!text) {
    flash("没有日志可复制");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    flash("日志已复制到剪贴板");
  } catch {
    flash("复制失败，请用「导出 .log」");
  }
});

$("clearLog").addEventListener("click", async () => {
  if (!confirm("清空全部日志？导出过的文件不受影响。")) return;
  try {
    await chrome.runtime.sendMessage({ type: "clear-logs" });
  } catch {
    await chrome.storage.local.set({ logs: [] });
  }
  await load();
  flash("日志已清空");
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") load();
});

load();
