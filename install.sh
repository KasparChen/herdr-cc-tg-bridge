#!/bin/sh
# One-step installer for herdr-cc-tg-bridge on macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/KasparChen/herdr-cc-tg-bridge/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/KasparChen/herdr-cc-tg-bridge/main/install.sh | sh -s -- --lang zh
#   ./install.sh [--lang zh|en] [--yes] [--dry-run] [--uninstall]
# It checks and installs what is missing (Bun, Herdr, Claude Code), gets the code, asks for the bot token, finds the
# group and your account by itself, writes .env, and starts the bridge in the background.
# Environment: TG_BRIDGE_HOME (where the code goes, default ~/.local/share/herdr-cc-tg-bridge),
#   TG_BRIDGE_REPO (git URL, for forks), TG_BRIDGE_LABEL (launchd label, default local.tg-bridge),
#   TELEGRAM_BOT_TOKEN (skips the token prompt), TG_BRIDGE_LANG (zh | en).
# Every variable is written as ${NAME}: macOS /bin/sh is bash 3.2, which in a UTF-8 locale reads a full-width
# character right after $NAME as part of the name.
# Everything runs inside main, so a download cut short never runs half a script.
set -eu

main() {
REPO_URL="${TG_BRIDGE_REPO:-https://github.com/KasparChen/herdr-cc-tg-bridge.git}"
SERVICE="herdr-cc-tg-bridge"
WORKSPACE="Telegram"
L="" YES=0 DRY=0 ACTION=install
while [ $# -gt 0 ]; do
  case "$1" in
    --lang) L="${2:-}"; shift ;;
    --lang=*) L="${1#--lang=}" ;;
    -y|--yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    --uninstall) ACTION=uninstall ;;
    -h|--help) ACTION=help ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done
if [ -z "${L}" ]; then
  case "${TG_BRIDGE_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}" in zh*) L=zh ;; *) L=en ;; esac
fi
[ "${L}" = zh ] || L=en

if [ -t 1 ]; then B="$(printf '\033[1m')" G="$(printf '\033[32m')" Y="$(printf '\033[33m')" R="$(printf '\033[31m')" N="$(printf '\033[0m')"
else B="" G="" Y="" R="" N=""; fi

OS="$(uname -s)"
case "${OS}" in Darwin|Linux) ;; *) die "只支持 macOS 和 Linux（当前是 ${OS}）" "Only macOS and Linux are supported (this is ${OS})" ;; esac
# where the Bun, Herdr and Claude installers put their binaries, so they are found right after installing
export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"

# Code: the clone this script is in, otherwise ~/.local/share (outside the folders macOS privacy-protects,
# which a background job cannot read without Full Disk Access). Piped through sh, $0 is the shell itself.
HERE=/nonexistent
case "$0" in *install.sh) HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo /nonexistent)" ;; esac
if [ -f "${HERE}/src/main.ts" ] && [ -f "${HERE}/bin/tg-bridge" ]; then ROOT="${HERE}"; FROM_CLONE=1
else ROOT="${TG_BRIDGE_HOME:-${HOME}/.local/share/${SERVICE}}"; FROM_CLONE=0; fi
LABEL="${TG_BRIDGE_LABEL:-local.tg-bridge}"
STATE="${TG_BRIDGE_STATE_DIR:-${HOME}/.tg-bridge}"
UNIT="${HOME}/.config/systemd/user/${SERVICE}.service"
PORT="$(env_value TG_BRIDGE_PORT)"
[ -n "${PORT}" ] || PORT=18820

case "${ACTION}" in
  help) usage; exit 0 ;;
  uninstall) uninstall; exit 0 ;;
esac

[ "${DRY}" = 1 ] || [ -r /dev/tty ] || die "需要在终端里运行（要输入 bot token）" "Run this in a terminal (it asks for the bot token)"
printf '\n%sherdr-cc-tg-bridge%s  %s\n' "${B}" "${N}" "$(t "在 Telegram 群话题里用电脑上的 Claude Code" "Use Claude Code on your computer from Telegram topics")"

check_tools
get_code
setup_herdr
connect_telegram
start_bridge
next_steps
}

# --- helpers -----------------------------------------------------------------------------------------------------
t() { if [ "${L}" = zh ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
say() { printf '%s\n' "$(t "$1" "$2")"; }
step() { printf '\n%s%s%s\n' "${B}" "$(t "$1" "$2")" "${N}"; }
ok() { printf '  %s✓%s %s\n' "${G}" "${N}" "$(t "$1" "$2")"; }
warn() { printf '  %s!%s %s\n' "${Y}" "${N}" "$(t "$1" "$2")"; }
die() { printf '  %s✗%s %s\n' "${R}" "${N}" "$(t "$1" "$2")" >&2; exit 1; }
run() { if [ "${DRY}" = 1 ]; then printf '  [dry-run] %s\n' "$*" >&2; else "$@"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }
ask_yes() {
  [ "${YES}" = 1 ] && return 0
  [ "${DRY}" = 1 ] && return 0
  printf '  %s [Y/n] ' "$(t "$1" "$2")"
  read -r a </dev/tty || a=n
  case "${a}" in ""|y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
env_value() { [ -f "${ROOT}/.env" ] && sed -n "s/^$1=//p" "${ROOT}/.env" | tail -1 || true; }
# the Herdr server answers over its socket; any JSON with "workspaces" in it means it is up
herdr_up() { herdr workspace list 2>/dev/null | grep -q '"workspaces"'; }

usage() {
  say "用法：install.sh [--lang zh|en] [--yes] [--dry-run] [--uninstall]" "Usage: install.sh [--lang zh|en] [--yes] [--dry-run] [--uninstall]"
  say "  --yes        缺的工具直接安装，不再确认" "  --yes        install missing tools without asking"
  say "  --dry-run    只打印会执行的操作" "  --dry-run    only print what would be done"
  say "  --uninstall  停止并移除后台服务" "  --uninstall  stop and remove the background service"
}

stop_service() {
  if [ "${OS}" = Darwin ]; then
    if [ -f "${ROOT}/bin/install-launchd" ]; then TG_BRIDGE_LABEL="${LABEL}" run "${ROOT}/bin/install-launchd" uninstall >/dev/null; fi
  elif have systemctl && [ -f "${UNIT}" ]; then
    run systemctl --user disable --now "${SERVICE}" >/dev/null 2>&1 || true
    run rm -f "${UNIT}"
    run systemctl --user daemon-reload || true
  fi
  return 0
}

uninstall() {
  step "卸载后台服务" "Removing the background service"
  stop_service
  ok "已停止并移除后台服务" "Stopped and removed the background service"
  say "  代码和配置还在 ${ROOT}，状态和日志在 ${STATE}，不需要了可以手动删除。" \
      "  The code and settings remain in ${ROOT}, state and logs in ${STATE}. Delete them by hand if you no longer need them."
  say "  Herdr 的 Claude 集成仍保留，要移除就运行 herdr integration uninstall claude。" \
      "  Herdr's Claude integration stays; remove it with herdr integration uninstall claude."
}

# The Herdr and Claude installers put their commands in ~/.local/bin but do not add it to PATH for new terminals.
profile_file() {
  case "${SHELL:-}" in
    */zsh) echo "${HOME}/.zprofile" ;;
    */bash) if [ "${OS}" = Darwin ]; then echo "${HOME}/.bash_profile"; else echo "${HOME}/.profile"; fi ;;
    *) echo "${HOME}/.profile" ;;
  esac
}
ensure_path() {
  for f in "${HOME}/.zprofile" "${HOME}/.zshrc" "${HOME}/.bash_profile" "${HOME}/.bashrc" "${HOME}/.profile"; do
    [ -f "${f}" ] && grep -qs '\.local/bin' "${f}" && return 0
  done
  case ":${PATH_BEFORE}:" in *":${HOME}/.local/bin:"*) return 0 ;; esac
  pf="$(profile_file)"
  say "  新开的终端里找不到 ~/.local/bin 里的命令（herdr、claude 装在这里）。" \
      "  New terminals will not find the commands in ~/.local/bin (where herdr and claude live)."
  if ask_yes "在 ${pf} 末尾加一行，把 ~/.local/bin 加进 PATH？" "Add a line at the end of ${pf} to put ~/.local/bin on PATH?"; then
    if [ "${DRY}" = 1 ]; then echo "  [dry-run] append PATH line to ${pf}" >&2
    else printf '\n# added by herdr-cc-tg-bridge install.sh\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"${pf}"; fi
    ok "已写入 ${pf}，新开的终端生效" "Written to ${pf}; new terminals pick it up"
  else
    warn "没有改 PATH，下面的提示都用完整路径" "PATH left as is; the steps below use full paths"
  fi
}

# --- 1. tools ----------------------------------------------------------------------------------------------------
check_tools() {
step "1/5 检查环境" "1/5 Checking the environment"
have curl || die "缺少 curl，请先用系统的包管理器安装" "curl is missing. Install it with your package manager first"
if [ "${OS}" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then
  die "缺少命令行工具（git 和 python3 都要用）。运行 xcode-select --install，装完后重跑本脚本" \
      "Command Line Tools are missing (needed for git and python3). Run xcode-select --install, then run this script again"
fi
have git || die "缺少 git，请先用系统的包管理器安装" "git is missing. Install it with your package manager first"
# Herdr's Claude hook is a python3 script; without python3 it quietly does nothing and no session can be followed
have python3 || die "缺少 python3（Herdr 报告会话要用），请先用系统的包管理器安装" "python3 is missing (Herdr needs it to report sessions). Install it with your package manager first"
if [ "${OS}" = Linux ] && ! have bun && ! have unzip; then
  die "安装 Bun 需要 unzip，请先用系统的包管理器安装" "Installing Bun needs unzip. Install it with your package manager first"
fi

MISSING=""
for x in bun herdr claude; do
  if have "${x}"; then
    v="$("${x}" --version 2>/dev/null | head -1 | sed "s/^${x} //")"
    ok "${x} ${v}" "${x} ${v}"
  else
    MISSING="${MISSING} ${x}"
  fi
done
if [ -n "${MISSING}" ]; then
  say "  还没装，下面会用各自的官方安装脚本安装：" "  Not installed yet; each is installed with its official install script:"
  for x in ${MISSING}; do
    case "${x}" in
      bun) echo "    bun     curl -fsSL https://bun.sh/install | bash" ;;
      herdr) echo "    herdr   curl -fsSL https://herdr.dev/install.sh | sh" ;;
      claude) echo "    claude  curl -fsSL https://claude.ai/install.sh | bash" ;;
    esac
  done
  ask_yes "现在安装？" "Install them now?" || die "已取消" "Cancelled"
  have bash || die "官方安装脚本需要 bash" "The official installers need bash"
  for x in ${MISSING}; do
    case "${x}" in
      bun) run sh -c 'curl -fsSL https://bun.sh/install | bash' ;;
      herdr) run sh -c 'curl -fsSL https://herdr.dev/install.sh | sh' ;;
      claude) run sh -c 'curl -fsSL https://claude.ai/install.sh | bash' ;;
    esac
    [ "${DRY}" = 1 ] || have "${x}" || die "${x} 装完了但找不到命令，打开一个新终端再重跑本脚本" "${x} was installed but is not on PATH. Open a new terminal and run this script again"
    ok "${x} 已安装" "${x} installed"
  done
fi
ensure_path
}

# --- 2. code -----------------------------------------------------------------------------------------------------
get_code() {
step "2/5 获取代码" "2/5 Getting the code"
if [ "${FROM_CLONE}" = 1 ]; then
  ok "使用当前目录 ${ROOT}" "Using this clone: ${ROOT}"
elif [ -d "${ROOT}/.git" ]; then
  run git -C "${ROOT}" pull --ff-only --quiet || die "更新 ${ROOT} 失败，检查里面有没有本地改动" "Updating ${ROOT} failed. Check it for local changes"
  ok "已更新 ${ROOT}" "Updated ${ROOT}"
elif [ -e "${ROOT}" ]; then
  die "${ROOT} 已存在但不是 git 仓库。换个位置：TG_BRIDGE_HOME=/路径 重跑" "${ROOT} exists but is not a git clone. Choose another place with TG_BRIDGE_HOME=/path"
else
  run mkdir -p "$(dirname "${ROOT}")"
  run git clone --quiet --depth 1 "${REPO_URL}" "${ROOT}"
  ok "已下载到 ${ROOT}" "Downloaded to ${ROOT}"
fi
if [ "${OS}" = Darwin ]; then
  case "${ROOT}" in "${HOME}"/Desktop*|"${HOME}"/Documents*|"${HOME}"/Downloads*)
    warn "代码在 macOS 受保护的目录里。后台服务经 /bin/bash 启动，要在「系统设置 > 隐私与安全性 > 完全磁盘访问权限」里加入 /bin/bash，否则读不到文件" \
         "The code is in a folder macOS protects. The background job starts through /bin/bash: add /bin/bash under System Settings > Privacy & Security > Full Disk Access, or it cannot read the files" ;;
  esac
fi
}

# --- 3. Herdr ----------------------------------------------------------------------------------------------------
setup_herdr() {
step "3/5 配置 Herdr" "3/5 Setting up Herdr"
# the integration reports each Claude session's id to Herdr; it needs the Claude config directory to exist.
# Installing again is how Herdr migrates it after an upgrade, so it always runs.
run mkdir -p "${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
run herdr integration install claude >/dev/null
ok "Herdr 的 Claude 集成已安装" "Herdr's Claude integration is installed"
if [ "${DRY}" = 0 ] && ! herdr_up; then
  mkdir -p "${STATE}"
  nohup herdr server >"${STATE}/herdr-server.log" 2>&1 &
  i=0; while [ "${i}" -lt 20 ] && ! herdr_up; do sleep 1; i=$((i + 1)); done
  herdr_up || die "Herdr 服务没有启动，日志在 ${STATE}/herdr-server.log" "The Herdr server did not start; see ${STATE}/herdr-server.log"
fi
ok "Herdr 服务在运行" "The Herdr server is running"
if [ "${DRY}" = 0 ] && ! herdr workspace list 2>/dev/null | WS="${WORKSPACE}" bun -e 'const j = JSON.parse(await Bun.stdin.text()); process.exit((j.result?.workspaces ?? []).some(w => w.label === process.env.WS) ? 0 : 1)'; then
  herdr workspace create --label "${WORKSPACE}" --cwd "${HOME}" >/dev/null
fi
ok "Herdr 工作区 ${WORKSPACE}，Telegram 里开的会话都放在这里" "Herdr workspace ${WORKSPACE}, where sessions opened from Telegram go"
}

# --- 4. Telegram -------------------------------------------------------------------------------------------------
connect_telegram() {
step "4/5 连接 Telegram" "4/5 Connecting Telegram"
if [ "${DRY}" = 1 ]; then echo "  [dry-run] bun scripts/setup.ts" >&2; return 0; fi
# a bridge that is already running reads the same bot's updates; stop it while the group is being found
if curl -s -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  if { [ "${OS}" = Darwin ] && launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; } || { [ "${OS}" = Linux ] && [ -f "${UNIT}" ]; }; then
    stop_service
    ok "已停止正在运行的 bridge，配置完会重新启动" "Stopped the running bridge; it starts again once set up"
  else
    die "端口 ${PORT} 上已经有一个 bridge 在运行，但不是本脚本装的服务。先停掉它再重跑" \
        "A bridge is already running on port ${PORT}, not as the service this script installs. Stop it, then run this again"
  fi
fi
trap 'stty echo </dev/tty 2>/dev/null || true' EXIT INT TERM
TOKEN="${TELEGRAM_BOT_TOKEN:-}"
if [ -z "${TOKEN}" ]; then
  say "  还没有 bot 的话：在 Telegram 里找 @BotFather，发 /newbot，按提示取名，最后会给你一串 token。最好专门新建一个 bot 给 bridge 用。" \
      "  No bot yet? In Telegram, open @BotFather, send /newbot, pick a name, and it gives you a token. Best use a new bot just for the bridge."
fi
while :; do
  if [ -z "${TOKEN}" ]; then
    printf '  %s' "$(t "粘贴 bot token（输入时不显示）：" "Paste the bot token (hidden): ")"
    stty -echo </dev/tty; read -r TOKEN </dev/tty || TOKEN=""; stty echo </dev/tty; echo
    [ -n "${TOKEN}" ] || continue
  fi
  set +e
  TG_SETUP_TOKEN="${TOKEN}" TG_SETUP_LANG="${L}" TG_SETUP_ROOT="${ROOT}" TG_SETUP_WORKSPACE="${WORKSPACE}" bun "${ROOT}/scripts/setup.ts" </dev/tty
  code=$?
  set -e
  [ "${code}" -eq 0 ] && break
  [ "${code}" -eq 2 ] || die "Telegram 配置没有完成，重跑本脚本即可从这里继续" "Telegram setup did not finish. Run this script again to continue from here"
  TOKEN=""
done
}

# --- 5. start ----------------------------------------------------------------------------------------------------
start_bridge() {
step "5/5 启动 bridge" "5/5 Starting the bridge"
if [ "${OS}" = Darwin ]; then
  TG_BRIDGE_LABEL="${LABEL}" run "${ROOT}/bin/install-launchd" >/dev/null
  ok "已设为登录后自动运行（launchd 标签 ${LABEL}）" "Set to start at login (launchd label ${LABEL})"
elif have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
  if [ "${DRY}" = 1 ]; then echo "  [dry-run] write ${UNIT}; systemctl --user enable --now ${SERVICE}" >&2
  else
    mkdir -p "$(dirname "${UNIT}")" "${STATE}"
    cat >"${UNIT}" <<EOF
[Unit]
Description=herdr-cc-tg-bridge
After=network-online.target

[Service]
WorkingDirectory=${ROOT}
ExecStart=${ROOT}/bin/tg-bridge
Environment=PATH=$(dirname "$(command -v bun)"):$(dirname "$(command -v herdr)"):/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5
StandardOutput=append:${STATE}/bridge.log
StandardError=append:${STATE}/bridge.log

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "${SERVICE}" >/dev/null 2>&1
  fi
  ok "已设为登录后自动运行（systemd 用户服务 ${SERVICE}）" "Set to start at login (systemd user service ${SERVICE})"
  warn "退出登录后也要运行的话，执行 loginctl enable-linger $(id -un)" "To keep it running after you log out, run: loginctl enable-linger $(id -un)"
else
  warn "没有找到 systemd 用户服务，请在 Herdr 的一个标签页里前台运行 ${ROOT}/bin/tg-bridge" \
       "No systemd user session found. Run ${ROOT}/bin/tg-bridge in the foreground in a Herdr tab"
fi

if [ "${DRY}" = 0 ] && { [ "${OS}" = Darwin ] || [ -f "${UNIT}" ]; }; then
  printf '  %s' "$(t "等 bridge 上线（最多 90 秒）" "Waiting for the bridge to come online (up to 90 s)")"
  i=0; online=0
  while [ "${i}" -lt 45 ]; do
    if curl -s -m 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null | grep -q '"online":true'; then online=1; break; fi
    printf '.'; sleep 2; i=$((i + 1))
  done
  echo
  if [ "${online}" = 1 ]; then ok "bridge 已上线" "The bridge is online"
  else warn "90 秒内没有上线，看日志 ${STATE}/bridge.log" "Not online after 90 s. See the log: ${STATE}/bridge.log"; fi
fi
}

# --- done --------------------------------------------------------------------------------------------------------
next_steps() {
CLAUDE_BIN="$(command -v claude || echo claude)"
HERDR_BIN="$(command -v herdr || echo herdr)"
WORKDIR="$(env_value TG_BRIDGE_WORKDIR)"
WORKDIR="${WORKDIR:-~/tg-sessions}"
step "完成。还剩三件事要你自己做：" "Done. Three things are left for you:"
say "  1. 登录 Claude Code，并信任会话目录。运行下面这行，按提示登录，看到「是否信任此文件夹」选信任，然后输入 /exit 退出：" \
    "  1. Log in to Claude Code and trust the session folder. Run the line below, log in, choose to trust the folder when asked, then type /exit:"
echo "       cd ${WORKDIR} && ${CLAUDE_BIN}"
say "  2. 打开群，General 里有一条置顶的 🟢 状态消息。发 /new 新建第一个会话，会出现一个新话题。" \
    "  2. Open the group. General has a pinned 🟢 status message. Send /new to start the first session; it opens a new topic."
say "  3. Herdr 服务不会开机自启。电脑重启后先运行一次 ${HERDR_BIN}，bridge 才能操作会话。" \
    "  3. The Herdr server does not start at boot. After a restart, run ${HERDR_BIN} once so the bridge can reach the sessions."
echo
say "  在电脑上看会话    ${HERDR_BIN}（打开 ${WORKSPACE} 工作区）" "  See the sessions  ${HERDR_BIN} (open the ${WORKSPACE} workspace)"
say "  全部命令          在话题里发 /help" "  All commands      send /help in a topic"
say "  查看状态          ${ROOT}/bin/tg-bridge status" "  Status            ${ROOT}/bin/tg-bridge status"
say "  日志              ${STATE}/bridge.log" "  Log               ${STATE}/bridge.log"
say "  更新              重跑本脚本" "  Update            run this script again"
say "  卸载              sh ${ROOT}/install.sh --uninstall" "  Uninstall         sh ${ROOT}/install.sh --uninstall"
}

PATH_BEFORE="${PATH}"
main "$@"
