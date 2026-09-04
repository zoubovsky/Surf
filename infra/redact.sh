#!/usr/bin/env bash
# Redact anything that looks like a credential before it reaches an Actions log.
# Usage: some-command 2>&1 | bash infra/redact.sh
# The daemon never logs secrets; this is belt-and-braces. Note that any 64-hex
# string (Strike keys, but also sha256 hashes) is redacted as a side effect.
set -euo pipefail
exec sed -E \
  -e 's/sk-ant-[A-Za-z0-9_-]{10,}/[REDACTED_ANTHROPIC_KEY]/g' \
  -e 's/github_pat_[A-Za-z0-9_]{20,}/[REDACTED_GITHUB_PAT]/g' \
  -e 's/gh[pousr]_[A-Za-z0-9]{20,}/[REDACTED_GITHUB_TOKEN]/g' \
  -e 's/[0-9]{8,12}:[A-Za-z0-9_-]{30,}/[REDACTED_TELEGRAM_TOKEN]/g' \
  -e 's/\b[0-9a-fA-F]{64}\b/[REDACTED_HEX64]/g' \
  -e 's/(Bearer[[:space:]]+)[A-Za-z0-9._~+\/-]+=*/\1[REDACTED]/g' \
  -e 's/((KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL)[A-Za-z0-9_]*["'"'"'[:space:]]*[=:][[:space:]"'"'"']*)[^[:space:]"'"'"',}]+/\1[REDACTED]/gI'
