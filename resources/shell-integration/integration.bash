# Zarya shell integration for bash (incl. Git Bash on Windows and WSL).
# Emits OSC 133 (A/B/C/D), cwd (OSC 7 / 9;9) and OSC 6973;E (base64 cmd + nonce).
#
# Loaded two ways:
#   bash --rcfile <this file> -i     — Git Bash, plain Linux
#   PROMPT_COMMAND=… source <file>   — WSL, where wsl.exe starts the shell for
#                                      us and no argument of ours reaches it
#                                      (ZARYA_SI_BOOTSTRAP marks this case)

# --rcfile REPLACES the user's rc, so we load it ourselves — we augment their
# setup, never replace it. In bootstrap mode the shell has already read the rc
# on its own, and reading it twice would double PATH and re-run their hooks.
if [[ -z "${ZARYA_SI_BOOTSTRAP:-}" && -f "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
fi
unset ZARYA_SI_BOOTSTRAP

[[ $- == *i* ]] || return 0
[[ -n "${__zarya_loaded:-}" ]] && return 0
__zarya_loaded=1

__zarya_nonce="${ZARYA_NONCE:-}"
unset ZARYA_NONCE

__zarya_ps1_base="${PS1:-'\u@\h:\w\$ '}"
__zarya_bash_ver=$(( BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] ))
__zarya_ran_once=0

# WSL: the shell speaks Linux paths, Zarya is a Windows program.
#
# The cwd is not a caption — it is handed to the agent as its working directory
# and shown wherever a folder is shown. Reporting /home/egor to a Windows-side
# agent would be worse than reporting nothing. So under WSL we report the same
# directory the way WINDOWS addresses it: /mnt/c/x -> C:\x, and anything inside
# the distro -> \\wsl.localhost\<distro>\...  Both are real, openable paths.
#
# We ask `wslpath` instead of rewriting the string ourselves: the /mnt root is
# configurable (/etc/wsl.conf), so a hand-rolled prefix would be a guess. One
# fork per prompt would be a waste, though, and the answer only changes on `cd`
# — so the last one is remembered.
__zarya_win_src=''
__zarya_win_out=''
__zarya_win_path() {
  if [[ "$1" != "$__zarya_win_src" ]]; then
    __zarya_win_src="$1"
    __zarya_win_out=$(wslpath -w "$1" 2>/dev/null) || __zarya_win_out=''
  fi
  printf '%s' "$__zarya_win_out"
}

__zarya_cwd() {
  local native="$PWD"
  if [[ -n "${ZARYA_WSL_HOST:-}" ]]; then
    native=$(__zarya_win_path "$PWD")
    # No Windows form (deleted directory, wslpath missing) — say nothing at all.
    # A stale cwd is a smaller lie than a path this machine cannot open.
    [[ -n "$native" ]] || return 0
    # OSC 9;9 takes a raw Windows path; OSC 7's file:// URL cannot carry a UNC
    # one (\\wsl.localhost\…) without inventing an encoding for it.
    printf '\e]9;9;%s\a' "$native"
  else
    local p="${PWD// /%20}"
    printf '\e]7;file://localhost%s\a' "$p"
  fi
  # SECURITY: cwd is a trust boundary (it becomes the agent's working directory
  # and the root its filesystem access is confined to), and the report above can
  # be forged by any program's output. Report it again on the private nonced
  # channel — the terminal prefers that one and ignores un-nonced cwd reports
  # while this integration is active. The nonce is a shell variable, never
  # exported, so child processes cannot read it.
  if [[ -n "$__zarya_nonce" ]]; then
    printf '\e]6973;C;%s;%s\a' \
      "$(printf '%s' "$native" | base64 | tr -d '\n')" "$__zarya_nonce"
  fi
}

__zarya_precmd() {
  local exit_code=$?          # must be the first statement
  if (( __zarya_ran_once )); then
    printf '\e]133;D;%s\a' "$exit_code"
  fi
  __zarya_ran_once=1
  __zarya_cwd
  PS1='\[\e]133;A\a\]'"${__zarya_ps1_base}"'\[\e]133;B\a\]'
}
PROMPT_COMMAND=__zarya_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}

__zarya_preexec() {
  # PS0 expands after the command line is accepted, before execution.
  printf '\e]133;C\a'
  local cmd
  cmd=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null | sed 's/^ *[0-9]* *//')
  if [[ -n "$cmd" ]]; then
    local b64
    b64=$(printf '%s' "$cmd" | base64 2>/dev/null | tr -d '\n')
    printf '\e]6973;E;%s;%s\a' "$b64" "$__zarya_nonce"
  fi
}

if (( __zarya_bash_ver >= 404 )); then
  PS0='$(__zarya_preexec)'"${PS0-}"
fi

# Report the cwd ONCE right now, before the first prompt is even drawn.
#
# Not cosmetic: the terminal trusts un-nonced cwd reports only until it has seen
# one valid nonced one. Under WSL this script is loaded from PROMPT_COMMAND, so
# the first prompt is already on screen by the time our hook takes over — and in
# that gap a program could forge a cwd report and be believed. One line closes
# the gap.
__zarya_cwd
