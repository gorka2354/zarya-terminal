# Zarya shell integration for zsh.
# Emits OSC 133 (A/B/C/D), OSC 7 cwd and OSC 6973;E (base64 command + nonce).
# Loaded via ZDOTDIR/.zshrc which sources the user rc first, then this file.

[[ -n "${__zarya_loaded:-}" ]] && return 0
typeset -g __zarya_loaded=1

typeset -g __zarya_nonce="${ZARYA_NONCE:-}"
unset ZARYA_NONCE

autoload -Uz add-zsh-hook

typeset -g __zarya_ps1_base=${PS1}
typeset -g __zarya_ran_once=0
typeset -g __zarya_a=$'\e]133;A\a'
typeset -g __zarya_b=$'\e]133;B\a'

__zarya_cwd() {
  local p="${PWD// /%20}"
  printf '\e]7;file://localhost%s\a' "$p"
  # SECURITY: cwd is a trust boundary (it becomes the agent's working directory
  # and the root its filesystem access is confined to), and OSC 7 above can be
  # forged by any program's output. Report it again on the private nonced
  # channel — the terminal prefers that one and ignores un-nonced cwd reports
  # while this integration is active. The nonce is never exported.
  if [[ -n "$__zarya_nonce" ]]; then
    printf '\e]6973;C;%s;%s\a' \
      "$(printf '%s' "$PWD" | base64 | tr -d '\n')" "$__zarya_nonce"
  fi
}

__zarya_precmd() {
  local exit_code=$?
  if (( __zarya_ran_once )); then
    printf '\e]133;D;%s\a' "$exit_code"
  fi
  __zarya_ran_once=1
  __zarya_cwd
  PS1="%{${__zarya_a}%}${__zarya_ps1_base}%{${__zarya_b}%}"
}

__zarya_preexec() {
  printf '\e]133;C\a'
  local b64
  b64=$(printf '%s' "$1" | base64 | tr -d '\n')
  printf '\e]6973;E;%s;%s\a' "$b64" "$__zarya_nonce"
}

add-zsh-hook precmd  __zarya_precmd
add-zsh-hook preexec __zarya_preexec
add-zsh-hook chpwd   __zarya_cwd
