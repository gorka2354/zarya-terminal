# Zarya shell integration for bash (incl. Git Bash on Windows).
# Emits OSC 133 (A/B/C/D), OSC 7 cwd and OSC 6973;E (base64 command + nonce).
# Loaded via: bash --rcfile <this file> -i

# Load the user's normal rc first so we augment, not replace, their setup.
if [[ -f "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
fi

[[ $- == *i* ]] || return 0
[[ -n "${__zarya_loaded:-}" ]] && return 0
__zarya_loaded=1

__zarya_nonce="${ZARYA_NONCE:-}"
unset ZARYA_NONCE

__zarya_ps1_base="${PS1:-'\u@\h:\w\$ '}"
__zarya_bash_ver=$(( BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] ))
__zarya_ran_once=0

__zarya_cwd() {
  local p="${PWD// /%20}"
  printf '\e]7;file://localhost%s\a' "$p"
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
