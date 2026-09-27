#!/usr/bin/env bash
# Store an API key for pi-mem0-cache without it ever transiting an LLM or a
# shell history file.
#
# This wrapper delegates to scripts/ask-secret.mjs. The shell version it replaced
# read the key with `read -r -s -p "key: " key </dev/tty`, which under several
# terminal wrappers returned a single stray byte and stored it silently — the
# Keychain held a one-character key named `pi-mem0-cache.openrouter` for days
# while every embeddings call failed on it. The Node version owns the terminal
# through readline, verifies the stored value by reading it back, and refuses a
# value that fails its shape check.
#
# Usage:
#   ./scripts/setup-key.sh                      # interactive: pick a provider
#   ./scripts/setup-key.sh openrouter           # skip the picker
#   ./scripts/setup-key.sh --list               # show which keys are stored
#   ./scripts/setup-key.sh --verify openrouter  # read back and check the shape
#   ./scripts/setup-key.sh --delete KEY_NAME    # remove one

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/ask-secret.mjs" "$@"
