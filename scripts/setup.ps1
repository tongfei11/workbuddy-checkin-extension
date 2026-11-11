# ============================================================
# WorkBuddy 每日签到 - 环境安装脚本（Windows PowerShell 版）
# 检测运行时并验证令牌读取链路。
#
# v5.3.8+ 新版登录态为明文 JSON，纯 Node 即可读取，无需 Electron。
# 仅当使用旧版 WorkBuddy/CodeBuddy（state.vscdb 加密登录态）时才需要 Electron。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Token <accessToken>
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -ElectronPath C:\path\to\electron.exe
#
# -Token：把令牌保存到 %USERPROFILE%\.workbuddy-checkin\token 后继续检查。
# 新版桌面端（静态加密登录态）下必须显式提供令牌，否则任何外部脚本都读不到明文。
# ============================================================
param(
    [string]$ElectronPath = "",
    [string]$Token = ""
)

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillRoot = Split-Path -Parent $ScriptDir
$RuntimeDir = Join-Path $SkillRoot ".runtime"
$DefaultElectron = Join-Path $RuntimeDir "electron\electron.exe"
$DecryptJs = Join-Path $ScriptDir "decrypt-token.js"

Write-Output "== WorkBuddy 每日签到 · 环境检查 =="

# ---------- 探测 Node（v5.3.8+ 新版明文登录态优先用 Node 直读）----------
function Find-Node {
    if ($env:WB_CHECKIN_NODE -and (Test-Path $env:WB_CHECKIN_NODE)) { return $env:WB_CHECKIN_NODE }
    $cands = @(
        (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
        (Join-Path $env:ProgramFiles "nodejs\node.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
    )
    foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
    return ""
}

function Find-Electron {
    if ($ElectronPath -and (Test-Path $ElectronPath)) { return $ElectronPath }
    if ($env:WB_CHECKIN_ELECTRON -and (Test-Path $env:WB_CHECKIN_ELECTRON)) { return $env:WB_CHECKIN_ELECTRON }
    $cands = @(
        (Join-Path $HOME ".workbuddy\tools\electron\electron.exe"),
        $DefaultElectron,
        (Join-Path $HOME ".workbuddy\skills\workbuddy-checkin\.runtime\electron\electron.exe")
    )
    foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
    return ""
}

# ---------- 保存显式令牌（-Token 参数）----------
function Save-Token {
    param([string]$Value)
    if (-not $Value) { Write-Output "❌ -Token 需要一个令牌值"; exit 1 }
    if ($Value -match "\s") { Write-Output "❌ 令牌中不能包含空白字符"; exit 1 }
    if ($Value.Length -lt 16) { Write-Output "❌ 令牌长度不足（$($Value.Length) 字符），疑似复制不完整"; exit 1 }
    $file = if ($env:WB_CHECKIN_TOKEN_FILE) { $env:WB_CHECKIN_TOKEN_FILE } else { Join-Path $HOME ".workbuddy-checkin\token" }
    $dir = Split-Path -Parent $file
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Set-Content -Path $file -Value "TOKEN=$Value" -Encoding ASCII -NoNewline
    # 仅当前用户可读写（对应 POSIX 的 600）
    try {
        $acl = Get-Acl $file
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            [System.Security.Principal.WindowsIdentity]::GetCurrent().Name, "FullControl", "Allow")
        $acl.SetAccessRule($rule)
        Set-Acl -Path $file -AclObject $acl
    } catch { Write-Output "⚠️ 未能收紧文件权限（ACL 设置失败），请手动确认该文件不可被他人读取：$file" }
    Write-Output "✅ 令牌已保存：$file（仅当前用户可读）"
    return $file
}

if ($Token) {
    $null = Save-Token -Value $Token
    Write-Output ""
}

# ---------- 用 Node 探测令牌链路是否可用（不输出 token 内容） ----------
# 退出码 7 = 检测到静态加密登录态（需显式提供令牌）
$NodeBin = Find-Node
$ProbeToken = ""
$ProbeCode = 0
if ($NodeBin) {
    try {
        $out = & $NodeBin $DecryptJs 2>$null | Select-String "^DECRYPT_RESULT:"
        $ProbeCode = $LASTEXITCODE
        if ($out) { $ProbeToken = (($out | Select-Object -First 1).Line -replace "^DECRYPT_RESULT:", "").Trim() }
    } catch { $ProbeToken = "" }
}

# ============================================================
# 路径 A：令牌链路可用（显式令牌 / 新版明文登录态）→ 无需 Electron
# ============================================================
if ($NodeBin -and $ProbeToken -and -not $ProbeToken.StartsWith("ERR")) {
    $TokenFile = if ($env:WB_CHECKIN_TOKEN_FILE) { $env:WB_CHECKIN_TOKEN_FILE } else { Join-Path $HOME ".workbuddy-checkin\token" }
    if (Test-Path $TokenFile) {
        Write-Output "✅ 使用显式令牌：$TokenFile"
    } else {
        Write-Output "✅ 检测到新版登录态（WorkBuddy v5.3.8+ 明文存储），Node 可直接读取。"
    }
    Write-Output "✅ 令牌读取链路可用（运行时：$NodeBin）"
    Write-Output ""
    Write-Output "== 完成 =="
    $CheckinPs1 = Join-Path $ScriptDir "checkin.ps1"
    Write-Output "运行签到：  powershell -ExecutionPolicy Bypass -File `"$CheckinPs1`""
    exit 0
}

# ============================================================
# 路径 A2：静态加密登录态 → 必须显式提供令牌
# ============================================================
if ($ProbeCode -eq 7) {
    Write-Output "⚠️ 当前 WorkBuddy 桌面端已启用「静态加密登录态」："
    Write-Output "   auth.accessToken 存的是 `$wbEncrypted 信封，密钥由桌面端原生模块持有，"
    Write-Output "   磁盘上没有明文，任何外部脚本都解不出来（这是上游有意为之）。"
    Write-Output ""
    Write-Output "   因此需要显式提供一次令牌，二选一："
    Write-Output "   1) powershell -ExecutionPolicy Bypass -File setup.ps1 -Token <accessToken>"
    Write-Output "   2) `$env:WB_CHECKIN_TOKEN = `<accessToken>`"
    Write-Output ""
    Write-Output "   令牌有效期约 30 天，过期后重新提供一次即可。"
    Write-Output "   获取方式（注意：桌面端帮助菜单里没有「开发者工具」，生产构建把它隐藏了）："
    Write-Output "   A. 推荐：浏览器打开 https://www.workbuddy.cn/space 登录 -> F12 -> Network 过滤 api ->"
    Write-Output "      任选请求 -> Request Headers -> 复制 Authorization: Bearer 后面那串"
    Write-Output "      （旧 CodeBuddy 账户用 https://copilot.tencent.com，同一个办法）"
    Write-Output "   B. 桌面端远程调试：完全退出 WorkBuddy，然后执行"
    Write-Output "      WorkBuddy.exe --remote-debugging-port=9222"
    Write-Output "      浏览器打开 http://127.0.0.1:9222 ，点进窗口即得到完整 DevTools"
    Write-Output ""
    Write-Output "   ⚠️ 令牌等同账号密码，不要粘贴到群聊、别提交进仓库。"
    exit 1
}

# ============================================================
# 路径 B：旧版 state.vscdb 加密登录态 → 需要 Electron 运行时
# ============================================================
Write-Output "（未检测到新版明文登录态，按旧版 state.vscdb 流程处理，需要 Electron 运行时。）"
Write-Output ""

$Electron = Find-Electron
if (-not $Electron) {
    # 供应链安全：自动从 npm 下载第三方运行时（约 100MB）默认关闭，需显式开启。
    if (-not $env:WB_CHECKIN_AUTO_INSTALL_ELECTRON) {
        Write-Output "⚠️ 未检测到 Node 可读的新版登录态，也未找到 Electron 运行时。"
        Write-Output "   大多数用户应先确认：已安装 WorkBuddy 桌面端 v5.3.8+ 并登录（新版登录态优先用 Node 读取）。"
        Write-Output "   仅旧版 WorkBuddy/CodeBuddy（state.vscdb）账户才需要 Electron，二选一："
        Write-Output "   1) 手动指定已校验的 Electron：  setup.ps1 -ElectronPath C:\path\to\electron.exe"
        Write-Output "   2) 确认要从官方 npm 下载（约 100MB），先执行："
        Write-Output "        `$env:WB_CHECKIN_AUTO_INSTALL_ELECTRON=1"
        Write-Output "      再运行本脚本。"
        exit 1
    }
    Write-Output "⚠️ 未检测到 Electron，尝试通过 npm 下载（约 100MB，需要 Node.js）..."
    Write-Output "   ⚠️ 供应链提示：将从官方 npm registry 下载 electron@37 并执行，请确认网络可信。"
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) {
        Write-Output "❌ 未找到 npm。请先安装 Node.js（https://nodejs.org 下载 LTS 版），"
        Write-Output "   或手动下载 Electron 并执行 setup.ps1 -ElectronPath <electron.exe>。"
        exit 1
    }
    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    Push-Location $RuntimeDir
    npm init -y | Out-Null
    npm install electron@37 2>$null | Out-Null
    if (-not (Test-Path (Join-Path $RuntimeDir "node_modules\electron\dist\electron.exe"))) {
        Write-Output "❌ Electron 下载失败（网络/代理问题）。可配置 npm 镜像后重试："
        Write-Output "   npm config set registry https://registry.npmmirror.com"
        Pop-Location
        exit 1
    }
    Move-Item -Force (Join-Path $RuntimeDir "node_modules\electron\dist") (Join-Path $RuntimeDir "electron")
    Remove-Item -Recurse -Force (Join-Path $RuntimeDir "node_modules") -ErrorAction SilentlyContinue
    Remove-Item -Force (Join-Path $RuntimeDir "package.json"), (Join-Path $RuntimeDir "package-lock.json") -ErrorAction SilentlyContinue
    Pop-Location
    $Electron = $DefaultElectron
    Write-Output "✅ Electron 安装完成：$Electron"
} else {
    Write-Output "✅ 已检测到 Electron：$Electron"
}

# ---------- 验证旧版解密链路 ----------
Write-Output "== 验证令牌解密 =="
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$Token = ""
try {
    $out = & $Electron $DecryptJs 2>$null | Select-String "^DECRYPT_RESULT:"
    if ($out) { $Token = (($out | Select-Object -First 1).Line -replace "^DECRYPT_RESULT:", "").Trim() }
} catch { $Token = "" }

if (-not $Token -or $Token.StartsWith("ERR")) {
    Write-Output "❌ 解密失败（$Token）。请确认：1) 已安装并登录 WorkBuddy 桌面端；"
    Write-Output "   2) 旧版账户应用名若为 CodeBuddy，设置环境变量 WB_CHECKIN_APP_NAME=CodeBuddy 后重试；"
    Write-Output "   3) 新版 v5.3.8+ 账户应安装 Node.js 用 Node 直读。"
    exit 1
}

Write-Output "✅ 令牌解密成功（长度 $($Token.Length)）"
Write-Output ""
Write-Output "== 完成 =="
$CheckinPs1 = Join-Path $ScriptDir "checkin.ps1"
Write-Output "运行签到：  powershell -ExecutionPolicy Bypass -File `"$CheckinPs1`""
Write-Output "设置定时（每天 09:00，示例）："
Write-Output "  schtasks /Create /TN WorkBuddyDailyCheckin /TR `"powershell -ExecutionPolicy Bypass -File `"$CheckinPs1`"`" /SC DAILY /ST 09:00 /F"
