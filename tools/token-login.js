#!/usr/bin/env node
/**
 * WorkBuddy 每日签到 · 网页端令牌获取页
 *
 * 用法：
 *   node tools/token-login.js            # 启动本地页面并自动打开浏览器
 *   node tools/token-login.js --port 8800 --no-open
 *
 * 原理：
 *   新版 WorkBuddy 桌面端把 accessToken 静态加密（$wbEncrypted 信封），密钥在原生
 *   模块里，外部脚本解不出来。但 WorkBuddy 网页版（www.workbuddy.cn/app）登录后，
 *   浏览器里持有可用的登录态。本工具在 127.0.0.1 起一个只监听本机的极小服务，
 *   页面给出一个「书签脚本」：在已登录的 WorkBuddy 页面上点一下，书签脚本会
 *
 *     1) 调 /console/accounts 确认登录态，取出 uid / 域名；
 *     2) 从 document.cookie 与 localStorage/sessionStorage 里搜集候选凭据
 *        （JWT 形态优先，其次 token/auth/session 类键名）；
 *     3) 顺手在网页端把当日签到做掉（Cookie 同源请求，不依赖 Bearer）；
 *     4) 把结果 POST 回本机服务 → 直接写入 ~/.workbuddy-checkin/token（权限 600）。
 *
 *   拿得到长期令牌就用令牌跑定时任务；拿不到（网页版可能用 httpOnly Cookie，
 *   JS 读不到）也至少当场把积分领了，并在页面里说明后续怎么办。
 *
 * 安全：
 *   - 只监听 127.0.0.1，不对外网开放；
 *   - 页面与接口都要求本次启动生成的随机口令（?k=...），进程退出即失效；
 *   - 令牌只写本地文件（600），服务端日志不回显令牌内容。
 */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");

// ============================================================
// 参数
// ============================================================
const argv = process.argv.slice(2);
function argOf(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const PORT = Number(argOf("--port", process.env.WB_TOKEN_LOGIN_PORT || 8777));
const NO_OPEN = argv.includes("--no-open");
const SECRET = crypto.randomBytes(12).toString("hex");

const TOKEN_DIR = path.join(os.homedir(), ".workbuddy-checkin");
const TOKEN_FILE = process.env.WB_CHECKIN_TOKEN_FILE || path.join(TOKEN_DIR, "token");

// 会话状态（仅内存）
const state = {
  phase: "waiting", // waiting | extracted | no-token | checkin-only | error
  message: "",
  detail: "",
  at: "",
  checkin: null,
};

function nowText() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ============================================================
// 写令牌文件（600 / 目录 700）
// ============================================================
function writeTokenFile({ token, cookie, uid, domain }) {
  const lines = [];
  if (token) lines.push("TOKEN=" + token);
  if (cookie) lines.push("COOKIE=" + cookie);
  if (uid) lines.push("UID=" + uid);
  if (domain) lines.push("DOMAIN=" + domain);
  lines.push("# 由 tools/token-login.js 写入 " + nowText());
  if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, lines.join("\n") + "\n", { mode: 0o600 });
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (_) {}
  return TOKEN_FILE;
}

// ============================================================
// 书签脚本：在已登录的 WorkBuddy 页面上执行
// ============================================================
function buildBookmarklet() {
  const code = `(function(){
var PORT=${PORT},KEY=${JSON.stringify(SECRET)};
var out={port:PORT,key:KEY,href:location.href,cands:[],accounts:[],uid:"",domain:location.hostname,shot:null,errs:[]};
function jwtlike(v){return /^ey[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\./.test(v||"")}
function push(k,v,src){if(!v||v.length<12||v.length>4000)return;out.cands.push({k:k,v:v,src:src})}
try{
  var i,c;
  var cs=document.cookie?document.cookie.split(";"):[];
  for(i=0;i<cs.length;i++){
    c=cs[i].trim();var eq=c.indexOf("=");if(eq<1)continue;
    var k=c.slice(0,eq),v=decodeURIComponent(c.slice(eq+1));
    if(jwtlike(v))push(k,v,"cookie-jwt");
    else if(/token|auth|session|ticket|credential|sso/i.test(k))push(k,v,"cookie");
  }
}catch(e){out.errs.push("cookie:"+e)}
try{
  var sts=[localStorage,sessionStorage];
  for(var s=0;s<sts.length;s++){
    var st=sts[s];
    for(var j=0;j<st.length;j++){
      var kk=st.key(j);var vv="";
      try{vv=st.getItem(kk)||""}catch(e2){continue}
      if(jwtlike(vv))push(kk,vv,"storage-jwt");
      else if(/token|auth|credential/i.test(kk)&&vv.length>20)push(kk,vv,"storage");
      else if(vv.length<4000){
        var m=/"access_?token"\\s*:\\s*"([^"]{16,})"/i.exec(vv);
        if(m&&jwtlike(m[1]))push(kk+".accessToken",m[1],"storage-json");
      }
    }
  }
}catch(e){out.errs.push("storage:"+e)}
function done(){
  var body=JSON.stringify(out);
  try{
    fetch("http://127.0.0.1:"+PORT+"/api/save",{method:"POST",mode:"cors",credentials:"omit",
      headers:{"Content-Type":"text/plain;charset=UTF-8"},body:body})
    .then(function(r){return r.json()})
    .then(function(j){alert("WorkBuddy 签到助手\\n\\n"+j.message+((j.detail)?"\\n\\n"+j.detail:""))})
    .catch(function(e){
      var t=out.cands.length?out.cands[0].v:"";
      if(t&&navigator.clipboard){navigator.clipboard.writeText(t).then(function(){alert("已复制凭据到剪贴板，请回到令牌页粘贴。")},function(){prompt("请手动复制：",t)})}
      else if(t)prompt("请手动复制：",t);
      else alert("无法回传到本地页面（"+e+"），也没抓到可用凭据。");
    });
  }catch(e){alert("请求本地页面失败："+e)}
}
fetch("/console/accounts",{credentials:"include",headers:{Accept:"application/json"}})
.then(function(r){return r.json()})
.then(function(j){
  var a=(j&&j.data&&j.data.accounts)||[];
  out.accounts=a;
  if(a.length){out.uid=String(a[0].uid||"");if(a[0].domain)out.domain=a[0].domain}
  if(!a.length){out.errs.push("未取到 accounts（可能未登录）")}
  // 顺手在网页端签到：同源 Cookie 请求，不依赖 Bearer
  return fetch("/billing/meter/checkin-activity-status",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"}})
    .then(function(r){return r.json().catch(function(){return null})})
    .then(function(st){
      var d=(st&&st.data)||{};
      var checked=(d.today_checked_in===true)||(d.todayCheckedIn===true);
      if(checked){out.shot={status:"already",raw:d};return}
      return fetch("/billing/meter/daily-checkin",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"}})
        .then(function(r){return r.json().catch(function(){return null})})
        .then(function(ck){out.shot={status:(ck&&ck.code===0)?"claimed":"fail",raw:ck}});
    })
    .catch(function(e){out.errs.push("checkin:"+e)});
})
.catch(function(e){out.errs.push("accounts:"+e)})
.then(done, done);
})();`;
  return "javascript:" + encodeURIComponent(code);
}

// ============================================================
// 页面
// ============================================================
function renderPage() {
  const bm = buildBookmarklet();
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>WorkBuddy 令牌获取页</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--line:#2a2f3a;--txt:#e6e9ef;--dim:#98a2b3;--ok:#3ecf8e;--warn:#f7b955;--err:#ff6b6b;--brand:#4f8cff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:40px 24px 80px}
  h1{font-size:22px;margin:0 0 6px;font-weight:650}
  .sub{color:var(--dim);font-size:13px;margin-bottom:28px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:16px}
  .step{display:flex;gap:14px;align-items:flex-start}
  .num{flex:0 0 26px;height:26px;border-radius:50%;background:var(--brand);color:#fff;font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:center;margin-top:2px}
  .step h3{margin:0 0 6px;font-size:15px}
  .step p{margin:4px 0;color:var(--dim);font-size:13.5px}
  a{color:var(--brand);text-decoration:none}
  a:hover{text-decoration:underline}
  .bm{display:inline-block;margin:10px 0 4px;padding:9px 18px;background:var(--brand);color:#fff;border-radius:9px;font-weight:600;cursor:grab;text-decoration:none}
  .bm:active{cursor:grabbing}
  .status{display:flex;gap:10px;align-items:center;font-size:13.5px}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--warn);flex:0 0 auto}
  .dot.ok{background:var(--ok)}
  .dot.err{background:var(--err)}
  pre{background:#0b0d11;border:1px solid var(--line);border-radius:9px;padding:12px 14px;overflow:auto;font-size:12.5px;line-height:1.55;margin:10px 0 0;max-height:280px;white-space:pre-wrap;word-break:break-all}
  input[type=text]{width:100%;background:#0b0d11;border:1px solid var(--line);color:var(--txt);border-radius:9px;padding:11px 13px;font-size:13px;font-family:ui-monospace,Menlo,monospace}
  button{background:transparent;border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer}
  button:hover{border-color:var(--brand);color:var(--brand)}
  code{background:#0b0d11;border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:12.5px}
  .tip{font-size:12.5px;color:var(--dim);border-left:2px solid var(--line);padding-left:12px;margin-top:12px}
  .warn{color:var(--warn)}
</style></head>
<body><div class="wrap">
  <h1>WorkBuddy 令牌获取页</h1>
  <div class="sub">在浏览器里登录一次，把可复用的登录态交给签到脚本。本页只在 <code>127.0.0.1:${PORT}</code> 监听，关闭进程即失效。</div>

  <div class="card">
    <div class="step"><div class="num">1</div><div>
      <h3>登录 WorkBuddy 网页版</h3>
      <p>用和桌面端<b>同一个账号</b>登录，登录后停在任意页面即可。</p>
      <p><a href="https://www.workbuddy.cn/app" target="_blank" rel="noopener">打开 www.workbuddy.cn/app →</a></p>
    </div></div>
  </div>

  <div class="card">
    <div class="step"><div class="num">2</div><div>
      <h3>把下面这个书签拖到书签栏</h3>
      <p>拖不动的话：右键复制链接，在书签管理器里新建书签、把地址粘进去。</p>
      <a class="bm" href="${bm}" onclick="event.preventDefault();alert('请把这个按钮拖到书签栏，或在书签管理器里新建书签粘贴它的地址。');return false;">WB 取令牌</a>
      <p class="tip">书签里不包含任何账号信息，只有一个回传地址和本次会话的随机口令。</p>
    </div></div>
  </div>

  <div class="card">
    <div class="step"><div class="num">3</div><div>
      <h3>回到 WorkBuddy 网页版，点这个书签</h3>
      <p>它会做三件事：确认登录态 → 顺手在网页端把今天的签到领掉 → 把凭据回传到本页并写入 <code>${TOKEN_FILE}</code>。</p>
      <p>手边没有书签栏的话，也可以在这页按 <code>Option+Cmd+B</code>（Windows <code>Ctrl+Shift+B</code>）先显示书签栏。</p>
    </div></div>
  </div>

  <div class="card">
    <div class="status"><span class="dot" id="dot"></span><span id="line">等待书签回传…</span></div>
    <pre id="detail" style="display:none"></pre>
  </div>

  <div class="card">
    <h3 style="margin:0 0 10px;font-size:15px">兜底：手动粘贴令牌</h3>
    <p style="margin:0 0 10px;color:var(--dim);font-size:13.5px">如果书签抓不到可复用令牌，就在 WorkBuddy 页面按 <code>F12</code> → Network → 过滤 <code>api</code> → 任选请求 → Request Headers 里的 <code>Authorization: Bearer</code> 后面那串，粘到这里。</p>
    <input type="text" id="manual" placeholder="粘贴 accessToken（可带 Bearer 前缀）">
    <div style="margin-top:10px;display:flex;gap:10px;align-items:center">
      <button id="save">保存到令牌文件</button>
      <span id="msg" style="font-size:12.5px;color:var(--dim)"></span>
    </div>
  </div>

  <div class="tip warn">令牌等同账号密码：只写在本机 <code>${TOKEN_FILE}</code>（权限 600），别贴到群聊、别提交进仓库。不想用了就 <code>rm ${TOKEN_FILE}</code>。</div>
</div>
<script>
var K=${JSON.stringify(SECRET)};
function paint(s){
  var dot=document.getElementById("dot"),line=document.getElementById("line"),d=document.getElementById("detail");
  dot.className="dot"+(s.phase==="extracted"?" ok":(s.phase==="error"?" err":""));
  line.textContent=s.message||"等待书签回传…";
  if(s.detail){d.style.display="block";d.textContent=s.detail}else{d.style.display="none"}
}
function poll(){
  fetch("/api/state?k="+K).then(function(r){return r.json()}).then(paint).catch(function(){});
}
setInterval(poll,1500);poll();
document.getElementById("save").onclick=function(){
  var v=document.getElementById("manual").value.trim();
  var m=document.getElementById("msg");
  if(!v){m.textContent="先粘贴令牌";return}
  fetch("/api/manual?k="+K,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:v})})
    .then(function(r){return r.json()}).then(function(j){
      m.textContent=j.message;
      m.style.color=j.ok?"#3ecf8e":"#ff6b6b";
      poll();
    }).catch(function(e){m.textContent="保存失败："+e});
};
</script>
</body></html>`;
}

// ============================================================
// 选最优候选凭据
// ============================================================
// 只认能当 Bearer 用的凭据：JWT 形态，或从 localStorage/storage JSON 里挖出来的串。
// Cookie 里的非 JWT 值（如会话 ID）**不能**当 Bearer 用，写进去只会让签到稳定 401，
// 所以这里直接排除，交给页面提示走手动粘贴。
function pickCredential(cands) {
  if (!Array.isArray(cands) || !cands.length) return null;
  const jwt = cands.find((c) => /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(c.v || ""));
  if (jwt) return jwt;
  const storageToken = cands.find(
    (c) => /^storage/.test(c.src || "") && /access_?token|^token$|\.accessToken$/i.test(c.k || "")
  );
  return storageToken || null;
}

// ============================================================
// HTTP 服务
// ============================================================
function corsHeaders(origin) {
  const ok = /^https:\/\/([a-z0-9-]+\.)*workbuddy\.(cn|ai)$/i.test(origin || "");
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
  };
  if (ok) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { req.destroy(); resolve(""); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function json(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  }, extra || {}));
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const cors = corsHeaders(origin);
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    if (url.searchParams.get("k") !== SECRET) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("口令无效。请用启动时打印的完整地址打开本页。");
      return;
    }
    const html = renderPage();
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
      "Cache-Control": "no-store",
    });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    if (url.searchParams.get("k") !== SECRET) return json(res, 403, { ok: false });
    return json(res, 200, state);
  }

  if (req.method === "POST" && url.pathname === "/api/manual") {
    if (url.searchParams.get("k") !== SECRET) return json(res, 403, { ok: false, message: "口令无效" });
    let body;
    try { body = JSON.parse(await readBody(req) || "{}"); } catch (_) { return json(res, 400, { ok: false, message: "请求格式错误" }); }
    let token = String(body.token || "").trim().replace(/^Bearer\s+/i, "").replace(/\s+/g, "");
    if (token.length < 16) return json(res, 400, { ok: false, message: "令牌太短，疑似复制不完整" });
    const info = state.lastExtract || {};
    const file = writeTokenFile({ token, uid: info.uid, domain: info.domain || "www.workbuddy.cn" });
    state.phase = "extracted";
    state.message = "✅ 令牌已写入 " + file;
    state.detail = "来源：手动粘贴；域名：" + (info.domain || "www.workbuddy.cn");
    state.at = nowText();
    return json(res, 200, { ok: true, message: "已保存，可以回到终端跑 scripts/checkin.sh" });
  }

  if (req.method === "POST" && url.pathname === "/api/save") {
    let raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw || "{}"); } catch (_) { return json(res, 400, { ok: false, message: "请求格式错误" }, cors); }
    if (body.key !== SECRET) return json(res, 403, { ok: false, message: "口令无效，请重新从令牌页拖一次书签" }, cors);

    const uid = String(body.uid || "");
    const domain = String(body.domain || "www.workbuddy.cn");
    const cands = Array.isArray(body.cands) ? body.cands : [];
    const best = pickCredential(cands);
    const shot = body.shot || null;
    state.lastExtract = { uid, domain, cands: cands.length };

    // 签到结果文案
    let shotText = "";
    if (shot && shot.status === "claimed") {
      const c = shot.raw || {};
      shotText = "网页端签到成功，领取 " + (c.credit != null ? c.credit : "?") + " 积分（连续 " + (c.streak_days != null ? c.streak_days : "?") + " 天）";
    } else if (shot && shot.status === "already") {
      shotText = "网页端显示今日已签到";
    } else if (shot && shot.status === "fail") {
      const c = (shot && shot.raw) || {};
      shotText = "网页端签到未成功（code=" + (c.code != null ? c.code : "?") + " msg=" + (c.msg || "-") + "）";
    } else if (shot) {
      shotText = "网页端签到接口无有效响应";
    }

    if (best) {
      const file = writeTokenFile({ token: best.v, uid, domain });
      state.phase = "extracted";
      state.message = "✅ 已抓取凭据并写入 " + file;
      state.detail = [
        "来源：" + best.src + "  键名：" + best.k,
        shotText ? "签到：" + shotText : "",
        "UID：" + (uid || "-") + "　域名：" + domain,
        "下一步：bash scripts/checkin.sh 验证一次",
      ].filter(Boolean).join("\n");
    } else if (shotText) {
      state.phase = "checkin-only";
      state.message = "✅ " + shotText + "（但没抓到可复用令牌）";
      state.detail = [
        cands.length
          ? "抓到 " + cands.length + " 个 cookie/存储项，但都不是能当 Bearer 用的令牌（网页版很可能用 httpOnly Cookie 鉴权，JS 读不到）。"
          : "网页版很可能是 httpOnly Cookie 鉴权，JS 读不到，所以没法导出成脚本能用的令牌。",
        "",
        "可选做法：",
        "1) 每天在网页端点这个书签 —— 一样能领到积分，只是要开着浏览器；",
        "2) 想全自动：用桌面端那条路（本机登录态明文/静态加密状态见 scripts/setup.sh 提示）；",
        "3) 用上方「手动粘贴令牌」：在 WorkBuddy 页面 F12 → Network 复制 Bearer。",
      ].join("\n");
    } else {
      state.phase = "no-token";
      state.message = "⚠️ 没抓到凭据，也没完成签到";
      state.detail = [
        "检查清单：",
        "1) 是不是在 www.workbuddy.cn 上点的书签（不是本地令牌页）；",
        "2) 网页版是否已登录；",
        "3) 本地服务是否还在运行（端口 " + PORT + "）。",
        body.errs && body.errs.length ? "\n内部信息：" + body.errs.join(" | ") : "",
      ].filter(Boolean).join("\n");
    }
    state.at = nowText();
    state.checkin = shot;
    return json(res, 200, { ok: true, message: state.message, detail: state.detail }, cors);
  }

  json(res, 404, { ok: false, message: "not found" });
});

// ============================================================
// 启动
// ============================================================
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`❌ 端口 ${PORT} 已被占用。换一个：node tools/token-login.js --port ${PORT + 1}`);
  } else {
    console.error("❌ 启动失败：", e.message);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/?k=${SECRET}`;
  console.log("");
  console.log("  WorkBuddy 令牌获取页已启动");
  console.log("  ─────────────────────────────────────────────");
  console.log("  本机地址： " + url);
  console.log("  令牌写入： " + TOKEN_FILE);
  console.log("");
  console.log("  步骤：1. 在页面里点开 www.workbuddy.cn/app 登录");
  console.log("        2. 把「WB 取令牌」拖到书签栏");
  console.log("        3. 回 WorkBuddy 页面点该书签");
  console.log("");
  console.log("  Ctrl+C 结束。");
  console.log("");
  if (!NO_OPEN) {
    const cmd = process.platform === "darwin" ? `open "${url}"`
      : process.platform === "win32" ? `start "" "${url}"`
      : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
