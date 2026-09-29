#!/usr/bin/env bash
# setup-project.sh — initialize an SFDX project with the sfdx-devops-kit pipeline.
#
# Safe to re-run: existing files are kept unless --force is given, and
# package.json is merged rather than overwritten. Pass --dry-run to see what
# would happen without touching the working tree.
#
#   ./setup-project.sh [target-dir] [--name <project>] [--force] [--dry-run]
#                      [--skip-install] [--skip-rtk-sf] [--python <bin>]
set -euo pipefail

TARGET_DIR="."
PROJECT_NAME=""
FORCE=""
DRY_RUN=""
SKIP_INSTALL=""
SKIP_RTK=""
PYTHON_BIN="python3"

# Resolve the kit root from this script's location so it works when vendored.
KIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '%s\n' "$*"; }
info() { printf '\033[36m--> %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ⚠ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m  ✖ %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --name)         PROJECT_NAME="${2:-}"; shift 2 ;;
    --force)        FORCE="--force"; shift ;;
    --dry-run)      DRY_RUN="--dry-run"; shift ;;
    --skip-install) SKIP_INSTALL="1"; shift ;;
    --skip-rtk-sf)  SKIP_RTK="1"; shift ;;
    --python)       PYTHON_BIN="${2:-python3}"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*)             die "Unknown option: $1" ;;
    *)              TARGET_DIR="$1"; shift ;;
  esac
done

log "=================================================="
log " SFDX DevOps Kit — project initializer"
log "=================================================="

# ---------------------------------------------------------------------------
# Prerequisites. Node is required; the Salesforce CLI is only needed to create a
# new project or to run the pipeline, so its absence is a warning.
# ---------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node is required (>= 18). Install Node.js first."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node >= 18 is required (found $(node --version))."
command -v sf >/dev/null 2>&1 || warn "Salesforce CLI (sf) not found — install it before running the pipeline."

# ---------------------------------------------------------------------------
# Create the SFDX project when the target is not one yet.
# ---------------------------------------------------------------------------
if [ ! -f "${TARGET_DIR}/sfdx-project.json" ]; then
  if [ -n "${DRY_RUN}" ]; then
    warn "${TARGET_DIR} is not an SFDX project; would run \`sf project generate\` (dry run, skipping)."
  else
    command -v sf >/dev/null 2>&1 || die "${TARGET_DIR} is not an SFDX project and sf is unavailable to create one."
    if [ -z "${PROJECT_NAME}" ]; then
      printf 'SFDX project name: '
      read -r PROJECT_NAME
    fi
    [ -n "${PROJECT_NAME}" ] || die "A project name is required to generate a new SFDX project."
    info "Generating SFDX project ${PROJECT_NAME}"
    sf project generate --name "${PROJECT_NAME}" --template standard --output-dir "${TARGET_DIR}"
    TARGET_DIR="${TARGET_DIR%/}/${PROJECT_NAME}"
    ok "Created ${TARGET_DIR}"
  fi
fi

TARGET_DIR="$(cd "${TARGET_DIR}" && pwd)"
[ -z "${PROJECT_NAME}" ] && PROJECT_NAME="$(basename "${TARGET_DIR}")"

# ---------------------------------------------------------------------------
# Install the pipeline. The CLI owns this so the bash script and `init` can
# never drift apart.
# ---------------------------------------------------------------------------
info "Installing pipeline files into ${TARGET_DIR}"
node "${KIT_ROOT}/bin/cli.mjs" init "${TARGET_DIR}" \
  --project-name "${PROJECT_NAME}" ${FORCE} ${DRY_RUN}

# ---------------------------------------------------------------------------
# Dependencies.
# ---------------------------------------------------------------------------
if [ -n "${DRY_RUN}" ]; then
  warn "Dry run: skipping npm install."
elif [ -n "${SKIP_INSTALL}" ]; then
  warn "Skipping npm install (--skip-install). Run it before using the pipeline."
else
  info "Installing npm dependencies"
  ( cd "${TARGET_DIR}" && npm install --no-audit --no-fund ) && ok "Dependencies installed"
  info "Auditing dependencies"
  ( cd "${TARGET_DIR}" && npm audit --omit=dev >/dev/null 2>&1 ) \
    && ok "npm audit: no production vulnerabilities" \
    || warn "npm audit reported findings — review with: (cd ${TARGET_DIR} && npm audit)"
fi

# ---------------------------------------------------------------------------
# rtk-sf: the default AI companion. Missing is a warning, never fatal.
# ---------------------------------------------------------------------------
if [ -n "${SKIP_RTK}" ]; then
  warn "Skipping rtk-sf setup (--skip-rtk-sf)."
elif [ -n "${DRY_RUN}" ]; then
  warn "Dry run: skipping rtk-sf index and MCP registration."
else
  if "${PYTHON_BIN}" -m rtk_sf --version >/dev/null 2>&1; then
    RTK_VERSION="$("${PYTHON_BIN}" -m rtk_sf --version 2>&1 | head -1)"
    ok "rtk-sf detected (${RTK_VERSION})"
    info "Indexing Salesforce metadata with rtk-sf"
    ( cd "${TARGET_DIR}" && "${PYTHON_BIN}" -m rtk_sf index >/dev/null ) \
      && ok "rtk-sf index created (.rtk-sf/)" \
      || warn "rtk-sf index failed — run \`${PYTHON_BIN} -m rtk_sf index\` manually."
    if command -v claude >/dev/null 2>&1; then
      info "Registering the rtk-sf MCP server with Claude Code"
      ( cd "${TARGET_DIR}" && claude mcp add rtk-sf -- "${PYTHON_BIN}" -m rtk_sf serve >/dev/null 2>&1 ) \
        && ok "MCP server registered" \
        || warn "Could not register automatically. Run: claude mcp add rtk-sf -- ${PYTHON_BIN} -m rtk_sf serve"
    else
      warn "claude CLI not found. Register later with: claude mcp add rtk-sf -- ${PYTHON_BIN} -m rtk_sf serve"
    fi
  else
    warn "rtk-sf not installed. It is this kit's default AI companion (compressed"
    warn "metadata specs over MCP + generated system documentation)."
    warn "  pip install \"git+https://github.com/furuCRM-Inc/rtk-sf.git@v0.10.0\""
    warn "Pipeline stages needing it are skipped, not failed, until then."
  fi
fi

log ""
log "=================================================="
log " Done."
log "=================================================="
log " 1. Edit ${TARGET_DIR}/sfdx-pipeline.config.yml"
log "      org aliases, thresholds, Backlog project key"
log " 2. npx sfdx-devops-kit validate     # config + required GitHub Secrets"
log " 3. npx sfdx-devops-kit plan         # what CI will run"
log " 4. Add each SF_<ENV>_AUTH_URL secret in GitHub"
log "=================================================="
