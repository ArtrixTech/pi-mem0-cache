#!/usr/bin/env bash
# Store an API key for pi-mem0-cache without it ever transiting an LLM or a
# shell history file.
#
# The key is read with `read -s` (hidden input, no echo), piped straight into
# macOS Keychain, and never written to an env file or a repo. The plugin reads
# it back via `readKeyFromKeychain()` in src/index.ts.
#
# Usage:
#   ./scripts/setup-key.sh                    # interactive: pick a provider
#   ./scripts/setup-key.sh openrouter         # skip the picker
#   ./scripts/setup-key.sh --list             # show which keys are stored
#   ./scripts/setup-key.sh --delete KEY_NAME  # remove one

set -euo pipefail

# provider -> keychain service name, and the env var that also works as a
# fallback source for people who prefer exporting in their shell.
declare -a PROVIDERS=(
  "openrouter|pi-mem0-cache.openrouter|OPENROUTER_API_KEY|embed (qwen3-embedding-8b) + rerank (voyage rerank-2.5-lite)"
  "jina|pi-mem0-cache.jina|JINA_API_KEY|embed only (legacy) + jina-reranker-v3 if desired"
  "mem0|pi-mem0-cache.mem0|MEM0_API_KEY|mem0 cloud API (already in mem0-config.json)"
)

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "Stored providers:"
  for entry in "${PROVIDERS[@]}"; do
    IFS='|' read -r name service _env desc <<<"$entry"
    if security find-generic-password -s "$service" >/dev/null 2>&1; then
      status="SET"
    else
      status="-"
    fi
    printf '  %-12s %-4s %s\n' "$name" "$status" "$desc"
  done
}

list_keys() {
  echo "Keychain entries for pi-mem0-cache:"
  found=0
  for entry in "${PROVIDERS[@]}"; do
    IFS='|' read -r name service _env _desc <<<"$entry"
    if security find-generic-password -s "$service" >/dev/null 2>&1; then
      # Show only metadata; never print the secret.
      printf '  %-12s SET  (service: %s)\n' "$name" "$service"
      found=1
    else
      printf '  %-12s -\n' "$name"
    fi
  done
  [ "$found" -eq 0 ] && echo "  (none — run without arguments to add one)"
  return 0
}

delete_key() {
  local target="$1"
  for entry in "${PROVIDERS[@]}"; do
    IFS='|' read -r name service _env _desc <<<"$entry"
    if [ "$name" = "$target" ] || [ "$service" = "$target" ]; then
      if security find-generic-password -s "$service" >/dev/null 2>&1; then
        security delete-generic-password -s "$service" >/dev/null
        echo "deleted: $service"
      else
        echo "not found: $service"
      fi
      return 0
    fi
  done
  echo "unknown provider: $target" >&2
  return 1
}

store_key() {
  local name="$1" service="$2" envvar="$3" desc="$4"

  echo
  echo "Provider: $name  ($desc)"
  echo "Env fallback: \$$envvar"
  echo
  echo "Paste the key and press Enter. Input is hidden — it is not echoed, not"
  echo "written to disk, and not passed as a command argument."
  echo

  local key=""
  # -r: no backslash mangling; -s: no echo. Read from the controlling terminal
  # so a pipeline can never feed this.
  if [ -t 0 ]; then
    read -r -s -p "key: " key </dev/tty
  else
    echo "error: needs an interactive terminal (stdin is not a TTY)" >&2
    exit 1
  fi
  echo

  if [ -z "${key:-}" ]; then
    echo "error: empty input, nothing stored" >&2
    exit 1
  fi

  # Sanity-check the shape without revealing the value.
  local len=${#key}
  local prefix=${key:0:8}
  echo "input length: $len, prefix: ${prefix}…"

  if [ "$name" = "openrouter" ] && [ "$len" -lt 20 ]; then
    echo "warning: that looks short for an OpenRouter key (expecting sk-or-v1-…)" >&2
  fi

  # Overwrite any existing entry rather than failing.
  security delete-generic-password -s "$service" >/dev/null 2>&1 || true
  printf '%s' "$key" | security add-generic-password -a "$USER" -s "$service" -w - >/dev/null
  unset key

  if security find-generic-password -s "$service" >/dev/null 2>&1; then
    echo "stored in Keychain: $service"
    echo
    echo "Verify with:"
    echo "  ./scripts/setup-key.sh --list"
    echo "  # then in pi:  /mem0-cache provider"
  else
    echo "error: write failed" >&2
    exit 1
  fi
}

main() {
  case "${1:-}" in
    -h | --help) usage; return 0 ;;
    -l | --list) list_keys; return 0 ;;
    -d | --delete)
      [ -n "${2:-}" ] || { echo "error: --delete needs a provider name" >&2; exit 1; }
      delete_key "$2"
      return 0
      ;;
    "")
      # Interactive picker.
      echo "Which provider?"
      i=0
      for entry in "${PROVIDERS[@]}"; do
        IFS='|' read -r name _service _env desc <<<"$entry"
        i=$((i + 1))
        printf '  %d) %-12s %s\n' "$i" "$name" "$desc"
      done
      echo
      read -r -p "number: " choice </dev/tty
      chosen="${PROVIDERS[$((choice - 1))]:-}"
      if [ -z "$chosen" ]; then
        echo "error: invalid selection" >&2
        exit 1
      fi
      IFS='|' read -r name service envvar desc <<<"$chosen"
      store_key "$name" "$service" "$envvar" "$desc"
      ;;
    *)
      for entry in "${PROVIDERS[@]}"; do
        IFS='|' read -r name service envvar desc <<<"$entry"
        if [ "$1" = "$name" ]; then
          store_key "$name" "$service" "$envvar" "$desc"
          return 0
        fi
      done
      echo "unknown provider: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
