#!/bin/bash
# ============================================================
# WorkBuddy 每日签到 - 环境安装脚本（通用版）
# 检测运行时并验证令牌读取链路是否可用。
#
# v5.3.8+ 新版登录态为明文 JSON，纯 Node 即可读取，无需 Electron。
# 仅当使用旧版 WorkBuddy/CodeBuddy（state.vscdb 加密登录态）时才需要 Electron。
#
# 用法：./setup.sh [--token <accessToken> | --from-clipboard] [--electron <路径>]
#   node tools/token-login.js         本机打开令牌获取页（走网页端登录，推荐）
#   --token <token>   把令牌保存到 ~/.workbuddy-checkin/token（权限 600）后继续检查
#                     —— 新版桌面端静态加密登录态下，这是唯一可用路径
#   --from-clipboard  从剪贴板读取令牌再保存（避免令牌留在 shell 历史里）
#   （默认）自动探测：显式令牌 → 明文登录态 → 旧版账户缺 Electron 时提示安装
#   --electron auto   检测已有运行时，缺失则通过 npm 下载
#   --electron <path> 指定已安装的 Electron 二进制（旧版账户用）
# ============================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(dirname "$SCRIPT_DIR")"
RUNTIME_DIR="$SKILL_ROOT/.runtime"
ELECTRON_BIN="$RUNTIME_DIR/electron/Electron.app/Contents/MacOS/Electron"

echo "== WorkBuddy 每日签到 · 环境检查 =="

# ---------- 探测 Node（v5.3.8+ 新版明文登录态优先用 Node 直读）----------
find_node() {
  local cands=(
    "$(command -v node 2>/dev/null)"
    "$HOME/.local/bin/node"
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "$HOME/.nvm/versions/node"/*/bin/node
  )
  for c in "${cands[@]}"; do
    if [ -n "$c" ] && [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  return 1
}

# ---------- 探测已存在的 Electron（仅旧版 state.vscdb 回退需要）----------
detect_electron() {
  local cands=(
    "$HOME/.workbuddy/tools/electron/Electron.app/Contents/MacOS/Electron"
    "$ELECTRON_BIN"
    "$(command -v electron 2>/dev/null)"
  )
  for c in "${cands[@]}"; do
    if [ -n "$c" ] && [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  return 1
}

# ---------- 用 Node 探测令牌链路是否可用（不输出 token 内容）----------
# 结果写入全局变量：PROBE_CODE=0 表示拿到令牌；7 表示检测到静态加密登录态；
# 其他值需要走旧版 Electron 流程。
PROBE_OUT=""
PROBE_CODE=0
probe_token_with_node() {
  local node_bin
  node_bin="$(find_node)" || { PROBE_CODE=3; return 3; }
  PROBE_OUT="$("$node_bin" "$SCRIPT_DIR/decrypt-token.js" 2>/dev/null)"
  PROBE_CODE=$?
  return "$PROBE_CODE"
}

# ---------- 令牌文件路径（与 decrypt-token.js 保持一致）----------
token_file_path() {
  if [ -n "${WB_CHECKIN_TOKEN_FILE:-}" ]; then echo "$WB_CHECKIN_TOKEN_FILE"; return; fi
  echo "$HOME/.workbuddy-checkin/token"
}

# ---------- 读取剪贴板（--from-clipboard 用）----------
read_clipboard() {
  if command -v pbpaste >/dev/null 2>&1; then
    pbpaste
  elif command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command Get-Clipboard 2>/dev/null
  elif command -v wl-paste >/dev/null 2>&1; then
    wl-paste --no-newline
  elif command -v xclip >/dev/null 2>&1; then
    xclip -selection clipboard -o
  else
    return 1
  fi
}

# ---------- 保存显式令牌（--token / --from-clipboard）----------
save_token() {
  local token dir file
  # 容错：允许整行粘贴 "Authorization: Bearer xxx" 或带换行/空格的复制结果
  token="$(printf '%s' "$1" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  token="${token#Bearer }"
  token="${token#bearer }"
  token="$(printf '%s' "$token" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -n "$token" ] || { echo "❌ 没有读取到令牌（--token 需要一个值，或剪贴板为空）"; exit 1; }
  case "$token" in
    *[[:space:]]*) echo "❌ 令牌中不能包含空白字符"; exit 1;;
  esac
  if [ "${#token}" -lt 16 ]; then
    echo "❌ 令牌长度不足（${#token} 字符），疑似复制不完整"
    exit 1
  fi
  file="$(token_file_path)"
  dir="$(dirname "$file")"
  mkdir -p "$dir"
  chmod 700 "$dir" 2>/dev/null
  # umask 077 + 重定向，避免令牌在写入瞬间对其他用户可读
  ( umask 077; printf 'TOKEN=%s\n' "$token" > "$file" ) || { echo "❌ 写入失败：$file"; exit 1; }
  chmod 600 "$file" 2>/dev/null
  echo "✅ 令牌已保存：${file}（权限 600）"
  # 顺手把签发域名写进令牌文件：签到接口要按域名选
  # （WorkBuddy 账户是 www.workbuddy.cn，旧 CodeBuddy 账户是 copilot.tencent.com）
  augment_token_file_domain
}

augment_token_file_domain() {
  local file node_bin dom
  file="$(token_file_path)"
  [ -f "$file" ] || return 0
  grep -qE '^[[:space:]]*DOMAIN[[:space:]]*=' "$file" 2>/dev/null && return 0
  node_bin="$(find_node)" || return 0
  dom="$("$node_bin" "$SCRIPT_DIR/decrypt-token.js" 2>/dev/null \
    | sed -n 's/^AUTH_DOMAIN://p' | grep -v '^[[:space:]]*$' | head -1)"
  [ -n "$dom" ] || return 0
  printf 'DOMAIN=%s\n' "$dom" >> "$file"
  echo "ℹ️ 已记录接口域名：$dom"
}


chmod +x "$SCRIPT_DIR/checkin.sh" 2>/dev/null

# ============================================================
# 参数：--token <令牌> / --from-clipboard 先把令牌存盘，再继续检查
# ============================================================
if [ "${1:-}" = "--token" ]; then
  save_token "${2:-}"
  echo ""
elif [ "${1:-}" = "--from-clipboard" ]; then
  CLIP_TOKEN="$(read_clipboard)" || { echo "❌ 当前系统没有可用的剪贴板工具"; exit 1; }
  save_token "$CLIP_TOKEN"
  echo ""
fi

# ============================================================
# 路径 A：令牌链路可用（显式令牌 / 明文登录态）→ 无需 Electron
# ============================================================
if probe_token_with_node; then
  NODE_BIN="$(find_node)"
  if [ -f "$(token_file_path)" ]; then
    echo "✅ 使用显式令牌：$(token_file_path)"
  else
    echo "✅ 检测到新版登录态（明文存储），Node 可直接读取。"
  fi
  echo "✅ 令牌读取链路可用（运行时：${NODE_BIN}）"
  echo ""
  echo "== 完成 =="
  echo "运行签到：  $SCRIPT_DIR/checkin.sh"
  echo "设置定时：  每天 09:00 示例 → crontab -e 添加："
  echo "  0 9 * * * $SCRIPT_DIR/checkin.sh >> $SKILL_ROOT/logs/checkin.log 2>&1"
  exit 0
fi

# ============================================================
# 路径 A2：静态加密登录态 → 必须显式提供令牌
# ============================================================
if [ "$PROBE_CODE" = "7" ]; then
  echo "⚠️ 当前 WorkBuddy 桌面端已启用「静态加密登录态」："
  echo "   auth.accessToken 存的是 \$wbEncrypted 信封，密钥由桌面端原生模块持有，"
  echo "   磁盘上没有明文，任何外部脚本都解不出来（这是上游有意为之）。"
  echo ""
  echo "   因此需要显式提供一次令牌，三选一："
  echo "   1) node tools/token-login.js       # 推荐：本机打开一个令牌获取页，点几下就好"
  echo "   2) $0 --from-clipboard             # 令牌已在剪贴板时用（不留在 shell 历史里）"
  echo "   3) $0 --token <accessToken> / export WB_CHECKIN_TOKEN=<accessToken>"
  echo ""
  echo "   令牌有效期约 30 天，过期后重新提供一次即可。"
  echo "   手动获取（注意：桌面端帮助菜单里没有「开发者工具」，生产构建把它隐藏了）："
  echo "   A. 推荐：浏览器打开 https://www.workbuddy.cn/app 登录（WorkBuddy 网页版）→ F12 →"
  echo "      Network 过滤 api → 任选请求 → Request Headers → 复制 Authorization: Bearer 后面那串"
  echo "      （旧 CodeBuddy 账户用 https://copilot.tencent.com，同一个办法）"
  echo "   B. 桌面端远程调试（网页端登不上时用）：完全退出 WorkBuddy，然后执行"
  echo "      env -u ELECTRON_RUN_AS_NODE \"/Applications/WorkBuddy.app/Contents/MacOS/Electron\" --remote-debugging-port=9222"
  echo "      浏览器打开 http://127.0.0.1:9222 ，点进窗口即得到完整 DevTools"
  echo ""
  echo "   ⚠️ 令牌等同账号密码，不要粘贴到群聊、别提交进仓库。"
  exit 1
fi

# ============================================================
# 路径 B：旧版 state.vscdb 加密登录态 → 需要 Electron 运行时
# ============================================================
echo "（未检测到新版明文登录态，按旧版 state.vscdb 流程处理，需要 Electron 运行时。）"
echo ""

MODE="${1:-auto}"
ELECTRON=""

# 供应链安全：自动从 npm 下载第三方运行时（约 100MB）默认关闭，需显式开启。
# 推荐手动指定已校验的 Electron：setup.sh --electron /path/to/electron
if [ -z "${WB_CHECKIN_AUTO_INSTALL_ELECTRON:-}" ] && [ "$MODE" = "auto" ]; then
  if ELECTRON="$(detect_electron)"; then
    echo "✅ 已检测到 Electron：$ELECTRON"
  else
    echo "⚠️ 未检测到 Node 可读的新版登录态，也未找到 Electron 运行时。"
    echo "   大多数用户应先确认：已安装 WorkBuddy 桌面端 v5.3.8+ 并登录（新版登录态优先用 Node 读取）。"
    echo "   仅旧版 WorkBuddy/CodeBuddy（state.vscdb）账户才需要 Electron，二选一："
    echo "   1) 手动指定已校验的 Electron：  setup.sh --electron /path/to/electron"
    echo "   2) 确认要从官方 npm 下载（约 100MB），先执行："
    echo "        export WB_CHECKIN_AUTO_INSTALL_ELECTRON=1"
    echo "      再运行本脚本。"
    echo "   （手动放置后也可用环境变量 WB_CHECKIN_ELECTRON=<path> 直接运行 checkin.sh）"
    exit 1
  fi
else
  case "$MODE" in
    auto)
      if ELECTRON="$(detect_electron)"; then
        echo "✅ 已检测到 Electron：$ELECTRON"
      else
        echo "⚠️ 未检测到 Electron 运行时，尝试通过 npm 下载（约 100MB，需要 node/npm）..."
        echo "   ⚠️ 供应链提示：将从官方 npm registry 下载 electron@37 并执行，请确认网络可信。"
        command -v npm >/dev/null 2>&1 || { echo "❌ 未找到 npm，请先安装 Node.js，或手动放置 Electron 后重试"; exit 1; }
        mkdir -p "$RUNTIME_DIR"
        cd "$RUNTIME_DIR"
        npm init -y >/dev/null 2>&1
        npm install electron@37 >/dev/null 2>&1 || { echo "❌ Electron 下载失败（网络/代理问题），请手动安装"; exit 1; }
        mv node_modules/electron/dist "$RUNTIME_DIR/electron"
        rm -rf node_modules package.json package-lock.json
        ELECTRON="$ELECTRON_BIN"
        echo "✅ Electron 安装完成：$ELECTRON"
      fi
      ;;
    --electron)
      ELECTRON="$2"
      [ -x "$ELECTRON" ] || { echo "❌ 指定的 Electron 不存在：$ELECTRON"; exit 1; }
      echo "✅ 使用指定 Electron：$ELECTRON"
      ;;
    *)
      echo "用法：$0 [--token <accessToken> | --from-clipboard] [--electron <path>]"; exit 1;;
  esac
fi

# ---------- 验证旧版解密链路 ----------
echo "== 验证令牌解密 =="
TOKEN=$(env -u ELECTRON_RUN_AS_NODE "$ELECTRON" "$SCRIPT_DIR/decrypt-token.js" 2>/dev/null \
  | grep "^DECRYPT_RESULT:" | sed 's/^DECRYPT_RESULT://')

if [ -z "$TOKEN" ] || [[ "$TOKEN" == ERR* ]]; then
  echo "❌ 解密失败（${TOKEN:-未知原因}）。请确认：1) 已安装并登录 WorkBuddy 桌面端；2) 旧版账户应用名为 WorkBuddy（老版本 CodeBuddy 设 WB_CHECKIN_APP_NAME=CodeBuddy）；3) 新版 v5.3.8+ 账户应安装 Node.js 用 Node 直读。"
  exit 1
fi

echo "✅ 令牌解密成功（长度 ${#TOKEN}）"
echo ""
echo "== 完成 =="
echo "运行签到：  $SCRIPT_DIR/checkin.sh"
echo "设置定时：  每天 09:00 示例 → crontab -e 添加："
echo "  0 9 * * * $SCRIPT_DIR/checkin.sh >> $SKILL_ROOT/logs/checkin.log 2>&1"
