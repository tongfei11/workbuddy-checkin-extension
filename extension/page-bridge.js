// ============================================================
// page-bridge.js —— 页面上下文桥
//
// 为什么需要它：
//   扩展 service worker 里的 fetch 属于「跨站请求」（发起方是 chrome-extension://），
//   WorkBuddy 的登录 Cookie 是 SameSite=Lax/未声明（默认 Lax），浏览器不会把它
//   附加到跨站请求上。表现就是：用户明明登录着，接口却一直返回 401。
//
// 这个内容脚本运行在 www.workbuddy.cn 页面里（隔离环境但属于页面源），
// 从这里发出的请求是同源的，Cookie 一定带上。后台只把它当「HTTP 通道」用，
// 响应原样回传，解析/判断逻辑仍然全部留在后台（lib.js 里，可单测）。
// ============================================================

(() => {
  const TIMEOUT_MS = 15000;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type === "wb-ping") {
      sendResponse({ ok: true, href: location.href });
      return; // 同步回复即可
    }
    if (msg.type !== "wb-http") return;

    (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const method = String(msg.method || "POST").toUpperCase();
        const init = {
          method,
          credentials: "include", // 同源，Cookie 正常带上
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: ctrl.signal,
        };
        if (method !== "GET" && method !== "HEAD") {
          init.headers["Content-Type"] = "application/json";
          init.body = JSON.stringify(msg.body || {});
        }
        const res = await fetch(msg.url, init);
        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          // 网关错误页/空响应，保留原文
        }
        sendResponse({ ok: true, status: res.status, resOk: res.ok, json, text: String(text).slice(0, 240) });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.name === "AbortError" ? "页面内请求超时" : String((e && e.message) || e) });
      } finally {
        clearTimeout(timer);
      }
    })();

    return true; // 异步响应
  });
})();
