#!/usr/bin/env node
/**
 * WorkBuddy 每日签到 - 令牌读取脚本（通用版，可分发）
 *
 * 令牌来源优先级（从上到下，先命中先返回）：
 *   1. 环境变量 WB_CHECKIN_TOKEN（显式指定，最高优先级）
 *   2. 令牌文件（WB_CHECKIN_TOKEN_FILE，默认 ~/.workbuddy-checkin/token，权限 600）
 *   3. WorkBuddy v5.3.8+ 的明文登录态文件（accessToken 为字符串）
 *   4. 旧版 state.vscdb + Electron safeStorage 解密
 * 注意：3 之后若检测到「静态加密登录态」（accessToken 为 {$wbEncrypted:1,envelope}），
 * 会直接给出明确指引并以退出码 7 结束，不再误报「未找到明文文件」。
 *
 * 安全警示（务必阅读）：
 *   - 本脚本输出的 accessToken 等同 WorkBuddy 账号密码，属于高敏感凭据。
 *   - token 仅通过 stdout 的 DECRYPT_RESULT:<token> 首行输出，由调用方经管道立即消费；
 *     切勿 tee/重定向到文件、切勿粘贴分享、切勿提交到任何仓库。
 *   - 日志只记录签到结果（积分/连续天数），绝不记录 token 原文。
 *   - 读取/解密成功时会向 stderr 打印一行安全提示（不进入 stdout，不会污染 token 管道）。
 *
 * 依赖：
 *   - 新版明文分支：仅需 Node.js（无版本特殊要求），纯 Node 读取 JSON。
 *   - 旧版 state.vscdb 分支：需要 Electron 运行时（≥ 30，使用 node:sqlite + safeStorage）。
 *
 * 运行方式（两种都支持，调用方按运行时可用性选择）：
 *   node decrypt-token.js                                          # 新版明文优先，纯 Node 即可
 *   env -u ELECTRON_RUN_AS_NODE <electron二进制> decrypt-token.js  # 旧版回退需要 Electron
 *
 * 输出：stdout 首行 DECRYPT_RESULT:<accessToken>；失败输出 DECRYPT_RESULT:ERR ...
 *   随后追加三行账号字段（供 checkin 脚本拼装鉴权头，逆向自客户端 buildHeaders）：
 *     ACCOUNT_UID:<account.uid>
 *     AUTH_DOMAIN:<auth.domain>
 *     ENTERPRISE_ID:<account.enterpriseId>
 *   注意：调用方必须按行前缀过滤（grep '^DECRYPT_RESULT:' / Select-String），
 *   不可整段捕获 stdout，否则账号字段会混入 token。
 *
 * 退出码：0 成功 / 2 未找到登录态 / 3 系统加密不可用 / 4 解密失败
 *         / 6 纯 Node 且无明文（旧版账户）/ 7 检测到静态加密登录态（需显式提供令牌）
 *
 * 跨平台登录态位置：
 *   新版明文（v5.3.8+，主路径）：
 *     - macOS:   ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
 *     - Windows: %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
 *                （旧实现只探 %APPDATA%，实测当前桌面端写在 LOCALAPPDATA；APPDATA 保留为回退）
 *     - Linux:   ~/.config/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
 *   旧版 state.vscdb（回退路径，兼容 WorkBuddy / CodeBuddy 早期版本）：
 *     - macOS:   ~/Library/Application Support/{WorkBuddy,CodeBuddy}/User/globalStorage/state.vscdb
 *     - Windows: %APPDATA%\{WorkBuddy,CodeBuddy}\User\globalStorage\state.vscdb
 *     - Linux:   ~/.config/{WorkBuddy,CodeBuddy}/User/globalStorage/state.vscdb
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// Electron 仅旧版 state.vscdb 分支需要；try/catch 使脚本可在纯 node 下执行。
// 新版明文分支不依赖 Electron，require 失败时自动跳过旧版分支。
let app = null;
let safeStorage = null;
try {
  const electron = require("electron");
  app = electron.app || null;
  safeStorage = electron.safeStorage || null;
} catch (e) {
  // 纯 Node 运行（无 Electron）：仅新版明文分支可用，旧版 state.vscdb 分支自动禁用。
}

// 统一输出：先 flush stdout，延迟退出。
// 旧实现 console.log 后立即 app.exit() 在某些环境下会截断未 flush 的 stdout，
// 改为 process.stdout.write 后延迟约 200ms 再退出，确保 token 完整送达调用方管道。
function emitAndExit(code, line) {
  process.stdout.write(line + "\n");
  const exitFn = app ? () => app.exit(code) : () => process.exit(code);
  setTimeout(exitFn, 200);
}

// 新版明文认证文件候选路径（按平台）
function desktopAuthFileCandidates() {
  const home = os.homedir();
  const ap = process.env.APPDATA || "";
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const rel = path.join(
    "CodeBuddyExtension",
    "Data",
    "Public",
    "auth",
    "workbuddy-desktop.info",
  );
  if (process.platform === "darwin") {
    return [path.join(home, "Library", "Application Support", rel)];
  }
  if (process.platform === "win32") {
    const localAp = process.env.LOCALAPPDATA || "";
    // 当前 WorkBuddy 桌面端把明文登录态写在 %LOCALAPPDATA%（非 %APPDATA%），
    // 优先探测 LOCALAPPDATA，缺失时回退 APPDATA，确保 Windows 能读到令牌。
    return [path.join(localAp, rel), path.join(ap, rel)];
  }
  return [path.join(xdg, rel)];
}

// 旧版 state.vscdb 会话库候选路径（按优先级）
function legacyVscdbCandidates() {
  const home = os.homedir();
  const ap = process.env.APPDATA || "";
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const apps = ["WorkBuddy", "CodeBuddy"];
  const roots =
    process.platform === "darwin"
      ? apps.map((a) => path.join(home, "Library", "Application Support", a))
      : process.platform === "win32"
        ? apps.map((a) => path.join(ap, a))
        : apps.map((a) => path.join(xdg, a));
  return roots.map((r) => path.join(r, "User", "globalStorage", "state.vscdb"));
}

// 旧版会话 key 候选
const SESSION_KEYS = [
  'secret://{"extensionId":"tencent-cloud.coding-copilot","key":"planning-genie.new.accessTokencn"}',
];

// ============================================================
// 显式令牌源：环境变量 / 令牌文件
// 用途：新版桌面端把 accessToken 静态加密后（见 $wbEncrypted），第三方脚本无法
// 解出令牌；此时允许用户显式提供一次令牌，其余流程完全不变。
// 令牌文件格式（# 开头为注释，可省略）：
//   TOKEN=<accessToken>          # 也可只写一行裸令牌
//   UID=<account.uid>            # 可选，用于 X-User-Id
//   DOMAIN=<auth.domain>         # 可选，用于 X-Domain
//   ENTERPRISE_ID=<enterpriseId> # 可选
// ============================================================

function tokenFilePath() {
  const explicit = (process.env.WB_CHECKIN_TOKEN_FILE || "").trim();
  if (explicit) return explicit;
  return path.join(os.homedir(), ".workbuddy-checkin", "token");
}

// 令牌合法性下限：拒绝明显不是令牌的内容（防呆），不校验具体字符集
function looksLikeToken(v) {
  return typeof v === "string" && v.length >= 16 && !/\s/.test(v);
}

function parseTokenFile(text) {
  const out = { token: "", uid: "", domain: "", eid: "" };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) {
      // 裸令牌行：只在尚未取到令牌时生效
      if (!out.token && looksLikeToken(line)) out.token = line;
      continue;
    }
    const key = line.slice(0, eq).trim().toUpperCase();
    const val = line.slice(eq + 1).trim();
    if (!val) continue;
    if (key === "TOKEN" || key === "ACCESS_TOKEN" || key === "WB_CHECKIN_TOKEN") {
      if (looksLikeToken(val)) out.token = val;
    } else if (key === "UID" || key === "USER_ID") {
      out.uid = val;
    } else if (key === "DOMAIN") {
      out.domain = val;
    } else if (key === "ENTERPRISE_ID") {
      out.eid = val;
    }
  }
  return out;
}

// 解析显式令牌源；命中返回 {token,uid,domain,eid,source}，否则返回 null
function resolveExplicitToken() {
  const envToken = (process.env.WB_CHECKIN_TOKEN || "").trim();
  if (envToken) {
    if (!looksLikeToken(envToken)) {
      process.stderr.write("[提示] 环境变量 WB_CHECKIN_TOKEN 内容不合法（过短或含空白），已忽略。\n");
    } else {
      return { token: envToken, uid: "", domain: "", eid: "", source: "环境变量 WB_CHECKIN_TOKEN" };
    }
  }
  const file = tokenFilePath();
  if (fs.existsSync(file)) {
    try {
      const parsed = parseTokenFile(fs.readFileSync(file, "utf8"));
      if (parsed.token) {
        return { ...parsed, source: "令牌文件 " + file };
      }
      process.stderr.write("[提示] 令牌文件存在但未解析出令牌：" + file + "\n");
    } catch (e) {
      process.stderr.write("[提示] 读取令牌文件失败：" + e.message + "\n");
    }
  }
  return null;
}

// 从本地登录态（明文 JSON）读取 auth.domain / account.uid 等**明文元数据**。
// 用途：显式提供令牌时令牌来源里通常没有域名信息，但签名接口要按域名选
// （WorkBuddy 账户是 www.workbuddy.cn，旧 CodeBuddy 账户是 copilot.tencent.com）。
// 这些字段即便 accessToken 被静态加密也仍是明文，所以总能读到。
function loginMeta() {
  for (const f of desktopAuthFileCandidates()) {
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      const a = j && j.auth;
      const acct = j && j.account;
      return {
        domain: a && a.domain != null ? String(a.domain) : "",
        uid: acct && acct.uid != null ? String(acct.uid) : "",
        eid: acct && acct.enterpriseId != null ? String(acct.enterpriseId) : "",
      };
    } catch (e) {
      // 解析失败继续看下一个候选
    }
  }
  return { domain: "", uid: "", eid: "" };
}

function emitToken(src, how) {
  process.stderr.write(
    "[安全提示] 已从" + how + "读取 accessToken，仅用于 WorkBuddy 官方签到接口；" +
    "请勿将其写入日志、分享或提交。\n"
  );
  // 令牌来源未提供域名/UID 时，用本地登录态的明文元数据补齐（不涉及解密）
  const meta = src.domain && src.uid ? { domain: src.domain, uid: src.uid, eid: src.eid } : loginMeta();
  emitAndExit(
    0,
    "DECRYPT_RESULT:" + src.token +
    "\nACCOUNT_UID:" + (src.uid || meta.uid || "") +
    "\nAUTH_DOMAIN:" + (src.domain || meta.domain || "") +
    "\nENTERPRISE_ID:" + (src.eid || meta.eid || "")
  );
}

// 读取 vscdb（node:sqlite 优先，失败回退 python3，需显式开启）
// 安全说明：python3 回退会扩展本地执行信任边界（调用外部解释器读取凭据库）。
// 默认关闭；仅在确需回退时设置 WB_CHECKIN_ALLOW_PY_FALLBACK=1 启用。
function readValue(dbPath, key) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
    db.close();
    return row ? row.value : null;
  } catch (e) {
    if (process.env.WB_CHECKIN_ALLOW_PY_FALLBACK !== "1") {
      throw new Error(
        "无法用 node:sqlite 读取会话数据库，且未开启 python3 回退。" +
        "如需回退请设置 WB_CHECKIN_ALLOW_PY_FALLBACK=1（会调用外部 python3 解释器）"
      );
    }
    try {
      // node:sqlite 不可用时，用 python3 读（macOS/Linux 一般自带）
      const script =
        "import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);r=c.execute('SELECT value FROM ItemTable WHERE key=?',(sys.argv[2],)).fetchone();print(json.dumps(r[0]) if r else '')";
      const out = execFileSync("python3", [ "-c", script, dbPath, key ], {
        encoding: "utf8",
        timeout: 15000,
      }).trim();
      return out ? JSON.parse(out) : null;
    } catch (e2) {
      throw new Error("无法读取会话数据库(需要 node:sqlite 或 python3): " + e2.message);
    }
  }
}

function toBuffer(parsed) {
  if (parsed && parsed.type === "Buffer" && Array.isArray(parsed.data)) return Buffer.from(parsed.data);
  if (typeof parsed === "string") return Buffer.from(parsed, "base64");
  if (Buffer.isBuffer(parsed)) return parsed;
  return null;
}

// ============================================================
// 主流程：显式令牌源 → 新版明文文件 → 旧版 state.vscdb 回退
// ============================================================

// 0. 显式令牌源（环境变量 / 令牌文件）。静态加密登录态下这是唯一可用路径。
{
  const explicit = resolveExplicitToken();
  if (explicit) {
    emitToken(explicit, explicit.source);
    return;
  }
}

// 1. 新版明文认证文件（WorkBuddy v5.3.8+，纯 Node 读取，优先）
// 命中且含 accessToken 即输出；文件缺失 / 无 token / 解析失败均不硬失败，
// 统一落入下方旧版 state.vscdb 分支兜底（覆盖升级中途、文件写入中等场景）。
// 例外：若 accessToken 是静态加密信封（$wbEncrypted），记录后单独报错，
// 不再走旧版分支（旧版分支只会给出误导性的「未找到明文」）。
let encryptedAtRest = null;
for (const f of desktopAuthFileCandidates()) {
  if (!fs.existsSync(f)) continue;
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const token = j && j.auth && j.auth.accessToken;
    if (token && typeof token === "string") {
      const acct = j && j.account;
      const authObj = j && j.auth;
      const uid = acct && acct.uid != null ? String(acct.uid) : "";
      const domain = authObj && authObj.domain != null ? String(authObj.domain) : "";
      const eid = acct && acct.enterpriseId != null ? String(acct.enterpriseId) : "";
      process.stderr.write(
        "[安全提示] 已从本地登录态读取 accessToken（新版明文存储），仅用于 WorkBuddy 官方签到接口；" +
        "请勿将其写入日志、分享或提交。\n"
      );
      // 额外输出 uid/domain/enterpriseId，供 checkin 脚本拼装 X-User-Id 等鉴权头（逆向自客户端 buildHeaders）
      emitAndExit(0, "DECRYPT_RESULT:" + token + "\nACCOUNT_UID:" + uid + "\nAUTH_DOMAIN:" + domain + "\nENTERPRISE_ID:" + eid);
      return;
    }
    // 静态加密登录态：新版桌面端把 auth.accessToken 换成了 {$wbEncrypted:1, envelope}
    // （AES-256-GCM 信封，密钥由桌面端原生模块经 Electron 主进程注入，磁盘上无明文）。
    // 第三方脚本拿不到该密钥，因此这里只能明确报错，引导用户显式提供令牌。
    if (token && typeof token === "object" && token.$wbEncrypted === 1) {
      // auth.domain 是明文元数据，即使令牌解不出来也能读到：调用方据此选择签到接口域名
      // （token 由 www.workbuddy.cn 签发就该打 www.workbuddy.cn，由 copilot.tencent.com 签发就打它）
      const acctMeta = j && j.account;
      const authMeta = j && j.auth;
      encryptedAtRest = {
        file: f,
        keyId: "",
        domain: authMeta && authMeta.domain != null ? String(authMeta.domain) : "",
        uid: acctMeta && acctMeta.uid != null ? String(acctMeta.uid) : "",
      };
      const env = token.envelope;
      try {
        const hdr = JSON.parse(Buffer.from(env, "base64").toString("utf8"));
        if (hdr && typeof hdr.keyId === "string") encryptedAtRest.keyId = hdr.keyId;
      } catch (e) {
        // 信封头解析失败不影响结论，只是少一条 keyId 线索
      }
    }
    // 文件存在但无 accessToken：落入旧版分支兜底
  } catch (e) {
    // 解析失败（文件损坏 / 写入中）：忽略，落入旧版分支兜底
  }
}

// 1.5 静态加密登录态：给出可执行指引，退出码 7 供调用方区分
if (encryptedAtRest) {
  emitAndExit(
    7,
    "DECRYPT_RESULT:ERR 检测到静态加密登录态（accessToken 为 $wbEncrypted 信封" +
    (encryptedAtRest.keyId ? "，keyId=" + encryptedAtRest.keyId : "") +
    "）。该密钥由 WorkBuddy 桌面端原生模块持有，磁盘上无明文，本脚本无法解出令牌。" +
    "请显式提供一次令牌：设置环境变量 WB_CHECKIN_TOKEN，或写入 " + tokenFilePath() +
    "（格式：TOKEN=<accessToken>，权限 600）。" +
    // domain/uid 是明文元数据，仍需输出：checkin.sh 用它决定打哪个域名的签到接口
    "\nACCOUNT_UID:" + (encryptedAtRest.uid || "") +
    "\nAUTH_DOMAIN:" + (encryptedAtRest.domain || "")
  );
  return;
}

// 2. 回退：旧版 state.vscdb + Electron safeStorage
if (!app || !safeStorage) {
  // 纯 Node 运行且无新版明文文件：无法走 safeStorage 分支，给出明确指引。
  emitAndExit(
    6,
    "DECRYPT_RESULT:ERR 未找到新版明文认证文件，且当前为纯 Node 运行（无 Electron）无法解密旧版 state.vscdb。" +
    "请确认已安装并登录 WorkBuddy 桌面端 v5.3.8+；旧版账户请改用 Electron 运行时执行本脚本；" +
    "或直接显式提供令牌（WB_CHECKIN_TOKEN 环境变量 / " + tokenFilePath() + "）。"
  );
  return;
}

// 注意：app.setName 必须在 ready 之前调用，否则 safeStorage 会以默认应用名
// 绑定钥匙串服务，导致解不到 WorkBuddy 的密钥。旧版应用名可通过环境变量覆盖。
const APP_NAME = process.env.WB_CHECKIN_APP_NAME || "WorkBuddy";
app.setName(APP_NAME);

let dbPath = null;
let raw = null;
let legacyReadErr = null;
for (const p of legacyVscdbCandidates()) {
  if (!fs.existsSync(p)) continue;
  for (const k of SESSION_KEYS) {
    try {
      const v = readValue(p, k);
      if (v) { dbPath = p; raw = v; break; }
    } catch (e) {
      legacyReadErr = e; // 记录但不中断，继续尝试其他候选 key/库
    }
  }
  if (raw) break;
}
if (!raw) {
  // 读取旧版库本身报错时附带原因，避免「未知原因」式失败（issue #68 投诉点）
  const hint = legacyReadErr ? "（读取旧版 state.vscdb 失败：" + legacyReadErr.message + "）" : "";
  emitAndExit(2, "DECRYPT_RESULT:ERR 未找到 WorkBuddy 本地登录态（新版明文文件与旧版 state.vscdb 均未命中" + hint + "，请先安装并登录 WorkBuddy 桌面端，或显式提供令牌：" + tokenFilePath() + "）");
  return;
}

app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) {
    emitAndExit(3, "DECRYPT_RESULT:ERR 系统加密不可用");
    return;
  }
  try {
    const buf = toBuffer(JSON.parse(raw));
    if (!buf) throw new Error("未知的存储格式");
    const decrypted = safeStorage.decryptString(buf);
    const session = JSON.parse(decrypted);
    const token = session && session.auth && session.auth.accessToken;
    if (token) {
      const acct = session && session.account;
      const authObj = session && session.auth;
      const uid = acct && acct.uid != null ? String(acct.uid) : "";
      const domain = authObj && authObj.domain != null ? String(authObj.domain) : "";
      const eid = acct && acct.enterpriseId != null ? String(acct.enterpriseId) : "";
      process.stderr.write(
        "[安全提示] 已从本地会话解密 accessToken（旧版 state.vscdb），仅用于 WorkBuddy 官方签到接口；" +
        "请勿将其写入日志、分享或提交。\n"
      );
      emitAndExit(0, "DECRYPT_RESULT:" + token + "\nACCOUNT_UID:" + uid + "\nAUTH_DOMAIN:" + domain + "\nENTERPRISE_ID:" + eid);
      return;
    }
    emitAndExit(4, "DECRYPT_RESULT:ERR 会话中无 accessToken");
  } catch (e) {
    emitAndExit(
      4,
      "DECRYPT_RESULT:ERR 解密失败(" + e.message +
      ")。若为旧版应用（CodeBuddy），请设置环境变量 WB_CHECKIN_APP_NAME=CodeBuddy 后重试；" +
      "或打开 WorkBuddy 桌面端刷新登录态"
    );
  }
});
