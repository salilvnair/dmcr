#!/usr/bin/env bash
# =============================================================================
# dmcr.sh — Database Management & Change Request Tracker for PostgreSQL
# Bash port of dmcr.ps1 — macOS and Linux compatible
# Requires: bash 4.0+ (for associative arrays)
#   macOS: brew install bash  (system bash is 3.2 which lacks declare -A)
#   Linux: bash 4+ is standard
# =============================================================================
set -Eeuo pipefail

# Bash version guard (associative arrays require bash 4+)
if [[ "${BASH_VERSINFO[0]:-0}" -lt 4 ]]; then
    printf '  ✗  dmcr.sh requires bash 4.0 or later.\n' >&2
    printf '     macOS ships bash 3.2 — install a newer bash:\n' >&2
    printf '       brew install bash\n' >&2
    printf '     Then invoke: /opt/homebrew/bin/bash %s "$@"\n' "$0" >&2
    printf '     Or add /opt/homebrew/bin to the front of your PATH.\n' >&2
    exit 1
fi

DMCR_VERSION="1.1.0"
# BASH_SOURCE[0] is always set when bash 4+ executes this file
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# =============================================================================
# ANSI COLORS
# =============================================================================
_ansi_enabled() {
    [[ "${DMCR_ANSI_OUTPUT:-1}" != "0" ]] && [[ -t 1 || "${DMCR_ANSI_OUTPUT:-1}" == "1" ]]
}

log_info()   { _ansi_enabled && printf "  \033[36m›\033[0m  %s\n"                             "$*" || printf "  ›  %s\n" "$*"; }
log_init()   { _ansi_enabled && printf "  \033[93m◆\033[0m  %s\n"                             "$*" || printf "  ◆  %s\n" "$*"; }
log_apply()  { _ansi_enabled && printf "  \033[92m●\033[0m  \033[97m%s\033[0m\n"              "$*" || printf "  ●  %s\n" "$*"; }
log_verify() { _ansi_enabled && printf "  \033[95m◌\033[0m  %s\n"                             "$*" || printf "  ◌  %s\n" "$*"; }
log_revert() { _ansi_enabled && printf "  \033[91m↺\033[0m  %s\n"                             "$*" || printf "  ↺  %s\n" "$*"; }
log_skip()   { _ansi_enabled && printf "  \033[90m○\033[0m  \033[90m%s\033[0m\n"              "$*" || printf "  ○  %s\n" "$*"; }
log_done()   { _ansi_enabled && printf "  \033[92m✓\033[0m  \033[92m%s\033[0m\n"              "$*" || printf "  ✓  %s\n" "$*"; }
log_warn()   { _ansi_enabled && printf "  \033[93m▲\033[0m  \033[93m%s\033[0m\n"              "$*" || printf "  ▲  %s\n" "$*"; }
log_error()  { _ansi_enabled && printf "  \033[91m✗\033[0m  \033[91m%s\033[0m\n" "$*" >&2    || printf "  ✗  %s\n" "$*" >&2; }
log_debug()  { [[ "${DMCR_DEBUG:-0}" == "1" ]] && { _ansi_enabled && printf "  \033[90m·\033[0m  \033[90m%s\033[0m\n" "$*" || printf "  ·  %s\n" "$*"; } || true; }

# =============================================================================
# TEMP FILE TRACKING & CLEANUP
# =============================================================================
DMCR_TMPFILES=()

dmcr_mktemp() {
    local prefix="${1:-dmcr_tx_}"
    local f
    f="$(mktemp "/tmp/${prefix}XXXXXX.sql")"
    DMCR_TMPFILES+=("$f")
    echo "$f"
}

cleanup_tmpfiles() {
    local f
    for f in "${DMCR_TMPFILES[@]+"${DMCR_TMPFILES[@]}"}"; do
        [[ -f "$f" ]] && rm -f "$f" 2>/dev/null || true
    done
}

# File lock fd and path (set by acquire_advisory_lock)
DMCR_LOCK_FD=""
DMCR_LOCK_FILE=""

cleanup_lock() {
    if [[ -n "$DMCR_LOCK_FD" ]]; then
        eval "exec ${DMCR_LOCK_FD}>&-" 2>/dev/null || true
        DMCR_LOCK_FD=""
    fi
}

dmcr_cleanup() {
    cleanup_lock
    cleanup_tmpfiles
}

trap dmcr_cleanup EXIT

dmcr_err_handler() {
    local lineno="$1" exitcode="$2"
    if _ansi_enabled; then
        printf '\033[91m✗  Command failed at line %s (exit %s)\033[0m\n' "$lineno" "$exitcode" >&2
        printf '\033[93mStack trace:\033[0m\n' >&2
        local i
        for (( i=1; i<${#FUNCNAME[@]}; i++ )); do
            printf '\033[90m  at %s (%s:%s)\033[0m\n' \
                "${FUNCNAME[$i]:-main}" \
                "${BASH_SOURCE[$i]:-unknown}" \
                "${BASH_LINENO[$i-1]}" >&2
        done
    else
        printf '✗  Command failed at line %s (exit %s)\n' "$lineno" "$exitcode" >&2
        printf 'Stack trace:\n' >&2
        local i
        for (( i=1; i<${#FUNCNAME[@]}; i++ )); do
            printf '  at %s (%s:%s)\n' \
                "${FUNCNAME[$i]:-main}" \
                "${BASH_SOURCE[$i]:-unknown}" \
                "${BASH_LINENO[$i-1]}" >&2
        done
    fi
}
# errtrace (-E, set above) makes this trap propagate into functions — without it,
# ERR never fires for failures inside cmd_* functions, which is nearly the whole script.
trap 'dmcr_err_handler $LINENO $?' ERR

# =============================================================================
# STARTUP: remove orphaned temp files older than 1 hour
# =============================================================================
cleanup_orphaned_tmpfiles() {
    local tmp_dir="/tmp"
    local cutoff_mins=60
    find "$tmp_dir" -maxdepth 1 -name "dmcr_tx_*.sql" -o \
                                -name "dmcr_verify_*.sql" -o \
                                -name "dmcr_parse_*.sql" 2>/dev/null | \
        xargs -I{} find {} -mmin +"$cutoff_mins" -delete 2>/dev/null || true
    # Stale lock files
    local lock_dir="/tmp/dmcr_locks"
    if [[ -d "$lock_dir" ]]; then
        find "$lock_dir" -maxdepth 1 -name "dmcr_*.lock" -mmin +"$cutoff_mins" -delete 2>/dev/null || true
    fi
}
cleanup_orphaned_tmpfiles

# =============================================================================
# INI CONFIG PARSER
# =============================================================================
# Stores INI data in associative arrays named CFG__<section>__<key>
declare -A _INI_DATA=()

ini_parse() {
    local path="$1"
    local section=""
    if [[ ! -f "$path" ]]; then
        log_error "Config file not found: $path"
        exit 1
    fi
    _INI_DATA=()
    while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
        local line
        line="${raw_line#"${raw_line%%[![:space:]]*}"}"  # ltrim
        line="${line%"${line##*[![:space:]]}"}"           # rtrim
        [[ -z "$line" || "$line" == \#* || "$line" == \;* ]] && continue
        if [[ "$line" =~ ^\[(.+)\]$ ]]; then
            section="${BASH_REMATCH[1]}"
            continue
        fi
        if [[ "$line" == *=* ]]; then
            local key="${line%%=*}"
            local val="${line#*=}"
            key="${key%"${key##*[![:space:]]}"}"
            val="${val#"${val%%[![:space:]]*}"}"
            val="${val%"${val##*[![:space:]]}"}"
            _INI_DATA["${section}__${key}"]="$val"
        fi
    done < "$path"
}

ini_get() {
    local section="$1" key="$2" default="${3:-}"
    local k="${section}__${key}"
    # Use ${!k+x} trick for bash 3.2 compatibility (no -v flag on arrays)
    local val="${_INI_DATA[$k]+__SET__}"
    if [[ "$val" == "__SET__" ]]; then
        echo "${_INI_DATA[$k]}"
    else
        echo "$default"
    fi
}

ini_has_section() {
    local section="$1"
    local k
    for k in "${!_INI_DATA[@]}"; do
        [[ "$k" == "${section}__"* ]] && return 0
    done
    return 1
}

# =============================================================================
# CONFIG LOADING
# =============================================================================
# Global config variables (set by load_config)
CFG_ENV=""
CFG_CONN=""
CFG_CHANGES_DIR=""
CFG_PSQL_PATH=""
CFG_LOCK_TIMEOUT=""
CFG_STMT_TIMEOUT=""
CFG_CHECKSUM_POLICY=""
CFG_CONFIG_PATH=""
declare -A CFG_PLACEHOLDERS=()

load_config() {
    local config_path="$1"
    CFG_CONFIG_PATH="$config_path"

    ini_parse "$config_path"

    if ! ini_has_section "dmcr"; then
        log_error "Missing [dmcr] section in config: $config_path"
        exit 1
    fi

    CFG_ENV="$(ini_get "dmcr" "env" "dev")"

    if ! ini_has_section "$CFG_ENV"; then
        log_error "Missing [$CFG_ENV] section in config: $config_path"
        exit 1
    fi

    # Connection: env var overrides config
    local config_conn
    config_conn="$(ini_get "$CFG_ENV" "conn" "")"
    CFG_CONN="${DMCR_CONN:-$config_conn}"
    if [[ -z "$CFG_CONN" ]]; then
        log_error "No connection string found in [$CFG_ENV] section or DMCR_CONN env var"
        exit 1
    fi

    # changes_dir — resolve relative paths against config file directory
    local raw_changes_dir
    raw_changes_dir="$(ini_get "dmcr" "changes_dir" "")"
    if [[ -n "$raw_changes_dir" && "$raw_changes_dir" != /* ]]; then
        local config_dir
        config_dir="$(dirname "$config_path")"
        CFG_CHANGES_DIR="$(cd "$config_dir" && realpath -m "$raw_changes_dir" 2>/dev/null || echo "$config_dir/$raw_changes_dir")"
    else
        CFG_CHANGES_DIR="$raw_changes_dir"
    fi

    CFG_PSQL_PATH="$(ini_get "dmcr" "psql_path" "")"
    CFG_LOCK_TIMEOUT="$(ini_get "dmcr" "lock_timeout" "5s")"
    CFG_STMT_TIMEOUT="$(ini_get "dmcr" "statement_timeout" "5min")"
    CFG_CHECKSUM_POLICY="$(ini_get "dmcr" "checksum_policy" "warn")"

    case "$CFG_CHECKSUM_POLICY" in
        warn|block|repair) ;;
        *)
            log_warn "Invalid checksum_policy='$CFG_CHECKSUM_POLICY' — defaulting to 'warn'"
            CFG_CHECKSUM_POLICY="warn"
            ;;
    esac

    # Build placeholders from [placeholders] section
    CFG_PLACEHOLDERS=()
    local k
    for k in "${!_INI_DATA[@]}"; do
        if [[ "$k" == "placeholders__"* ]]; then
            local ph_key="${k#placeholders__}"
            CFG_PLACEHOLDERS["$ph_key"]="${_INI_DATA[$k]}"
        fi
    done
    # DMCR_PLACEHOLDER_* env vars override config
    while IFS='=' read -r envkey envval; do
        local ph_name="${envkey#DMCR_PLACEHOLDER_}"
        ph_name="${ph_name,,}"  # lowercase
        CFG_PLACEHOLDERS["$ph_name"]="$envval"
    done < <(env | grep '^DMCR_PLACEHOLDER_' || true)

    log_debug "Config loaded: env=$CFG_ENV changes_dir=$CFG_CHANGES_DIR checksum_policy=$CFG_CHECKSUM_POLICY"
}

# =============================================================================
# PSQL DISCOVERY
# =============================================================================
find_psql() {
    # Priority: DMCR_PSQL env > psql_path config > known paths > which
    if [[ -n "${DMCR_PSQL:-}" ]]; then
        echo "$DMCR_PSQL"; return 0
    fi
    if [[ -n "$CFG_PSQL_PATH" && -x "$CFG_PSQL_PATH" ]]; then
        echo "$CFG_PSQL_PATH"; return 0
    fi
    local candidates=("/opt/homebrew/bin/psql" "/usr/local/bin/psql" "/usr/bin/psql")
    local c
    for c in "${candidates[@]}"; do
        [[ -x "$c" ]] && { echo "$c"; return 0; }
    done
    local found
    found="$(command -v psql 2>/dev/null || true)"
    if [[ -n "$found" ]]; then
        echo "$found"; return 0
    fi
    log_error "psql not found. Set DMCR_PSQL, psql_path in config, or install PostgreSQL client."
    exit 1
}

# =============================================================================
# REDACT CONNECTION STRING (for log output)
# =============================================================================
redact_conn() {
    local s="$1"
    # URL style: postgres://user:pass@host
    s="$(echo "$s" | sed -E 's|://([^:/@]+):([^@]+)@|://\1:****@|g')"
    # key=value style: password=xxx
    s="$(echo "$s" | sed -E 's|(password|pwd)=([^;& ]+)|\1=****|gi')"
    echo "$s"
}

# =============================================================================
# CHECKSUM
# =============================================================================
file_checksum() {
    local file="$1"
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file" | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file" | awk '{print $1}'
    else
        log_error "No sha256 tool found (shasum or sha256sum)"
        exit 1
    fi
}

string_checksum() {
    local s="$1"
    if command -v shasum >/dev/null 2>&1; then
        printf '%s' "$s" | shasum -a 256 | awk '{print $1}'
    else
        printf '%s' "$s" | sha256sum | awk '{print $1}'
    fi
}

# =============================================================================
# SQL LITERAL ESCAPING
# =============================================================================
escape_sql() {
    # Double single-quotes for PostgreSQL standard_conforming_strings
    echo "${1//\'/\'\'}"
}

# =============================================================================
# PLACEHOLDER SUBSTITUTION
# =============================================================================
resolve_placeholders() {
    local sql="$1"
    local key val token
    for key in "${!CFG_PLACEHOLDERS[@]}"; do
        val="${CFG_PLACEHOLDERS[$key]}"
        token="\${${key}}"
        sql="${sql//$token/$val}"
    done
    # Check for unresolved
    if echo "$sql" | grep -qE '\$\{[a-zA-Z_][a-zA-Z0-9_]*\}'; then
        local unresolved
        unresolved="$(echo "$sql" | grep -oE '\$\{[a-zA-Z_][a-zA-Z0-9_]*\}' | sort -u | tr '\n' ' ')"
        log_error "Unresolved placeholder(s): $unresolved — define them in [placeholders] section or DMCR_PLACEHOLDER_<name> env vars."
        exit 1
    fi
    printf '%s' "$sql"
}

# =============================================================================
# PSQL EXECUTION HELPERS
# =============================================================================
_psql_exe=""
get_psql_exe() {
    if [[ -z "$_psql_exe" ]]; then
        _psql_exe="$(find_psql)"
    fi
    echo "$_psql_exe"
}

# Run SQL and return scalar result (single value, trimmed, no headers)
exec_psql_scalar() {
    local sql="$1"
    local timed_sql="SET lock_timeout = '${CFG_LOCK_TIMEOUT}'; SET statement_timeout = '${CFG_STMT_TIMEOUT}'; ${sql}"
    log_debug "PSQL scalar: $sql"
    local psql_exe
    psql_exe="$(get_psql_exe)"
    local out exit_code=0
    out="$("$psql_exe" "$CFG_CONN" -q -v ON_ERROR_STOP=1 -X -t -A -c "$timed_sql" 2>&1)" || exit_code=$?
    if [[ $exit_code -ne 0 ]]; then
        local err_detail
        err_detail="$(echo "$out" | grep -E '(ERROR|FATAL|PANIC):' | head -1 || echo "$out")"
        log_error "psql failed: $err_detail"
        return 1
    fi
    # Strip blank lines and "SET" lines
    local result
    result="$(echo "$out" | grep -v '^$' | grep -v '^SET$' | tail -1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    log_debug "PSQL scalar result: '$result'"
    echo "$result"
}

# Run SQL with table output (for display)
exec_psql() {
    local sql="$1"
    log_debug "PSQL: $sql"
    local psql_exe
    psql_exe="$(get_psql_exe)"
    "$psql_exe" "$CFG_CONN" -q -v ON_ERROR_STOP=1 -X -P pager=off \
        -c "SET lock_timeout = '${CFG_LOCK_TIMEOUT}'; SET statement_timeout = '${CFG_STMT_TIMEOUT}'; ${sql}"
}

# Run a .sql file + optional post-SQL in a single transaction (BEGIN/COMMIT)
exec_psql_file_tx() {
    local file="$1"
    local post_sql="${2:-}"
    if [[ ! -f "$file" ]]; then
        log_error "Missing file: $file"
        return 1
    fi
    local tmp
    tmp="$(dmcr_mktemp "dmcr_tx_")"
    local file_content
    file_content="$(cat "$file")"
    # Apply placeholders
    if [[ ${#CFG_PLACEHOLDERS[@]} -gt 0 ]]; then
        file_content="$(resolve_placeholders "$file_content")"
    fi
    cat > "$tmp" <<SQLTX
BEGIN;
SET LOCAL lock_timeout = '${CFG_LOCK_TIMEOUT}';
SET LOCAL statement_timeout = '${CFG_STMT_TIMEOUT}';
${file_content}
${post_sql}
COMMIT;
SQLTX
    log_debug "PSQL file-tx: $file (wrapper: $tmp)"
    local psql_exe
    psql_exe="$(get_psql_exe)"
    local out exit_code=0
    out="$("$psql_exe" "$CFG_CONN" -q -v ON_ERROR_STOP=1 -X -f "$tmp" 2>&1)" || exit_code=$?
    rm -f "$tmp" 2>/dev/null || true
    if [[ $exit_code -ne 0 ]]; then
        local err_detail
        err_detail="$(echo "$out" | grep -E '(ERROR|FATAL|PANIC):' | head -1 || echo "$out")"
        log_error "psql transaction failed for: $file — $err_detail"
        return 1
    fi
    [[ -n "$out" ]] && log_debug "PSQL file-tx output: $out"
    return 0
}

# Run a .sql file in BEGIN/ROLLBACK (verify — no side effects)
exec_psql_file_tx_rollback() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        log_error "Missing file: $file"
        return 1
    fi
    local tmp
    tmp="$(dmcr_mktemp "dmcr_verify_")"
    local file_content
    file_content="$(cat "$file")"
    if [[ ${#CFG_PLACEHOLDERS[@]} -gt 0 ]]; then
        file_content="$(resolve_placeholders "$file_content")"
    fi
    cat > "$tmp" <<SQLVERIFY
BEGIN;
SET LOCAL lock_timeout = '${CFG_LOCK_TIMEOUT}';
SET LOCAL statement_timeout = '${CFG_STMT_TIMEOUT}';
${file_content}
ROLLBACK;
SQLVERIFY
    log_debug "PSQL verify-tx (rollback): $file (wrapper: $tmp)"
    local psql_exe
    psql_exe="$(get_psql_exe)"
    local out exit_code=0
    out="$("$psql_exe" "$CFG_CONN" -q -v ON_ERROR_STOP=1 -X -f "$tmp" 2>&1)" || exit_code=$?
    rm -f "$tmp" 2>/dev/null || true
    if [[ $exit_code -ne 0 ]]; then
        local err_detail
        err_detail="$(echo "$out" | grep -E '(ERROR|FATAL|PANIC):' | head -1 || echo "$out" | head -3)"
        log_error "verify.sql failed: $file — $err_detail"
        return 1
    fi
    [[ -n "$out" ]] && log_debug "PSQL verify output: $out"
    return 0
}

# =============================================================================
# REGISTRY GUARD
# =============================================================================
require_registry() {
    log_debug "Checking DMCR registry (dmcr.change_log)"
    local ok
    ok="$(exec_psql_scalar "SELECT 1 FROM information_schema.tables WHERE table_schema='dmcr' AND table_name='change_log';" 2>/dev/null || echo "")"
    if [[ "$ok" != "1" ]]; then
        log_error "DMCR registry not found. Run: dmcr init"
        exit 1
    fi
    # Ensure v1.1.0 tables exist
    local v11
    v11="$(exec_psql_scalar "SELECT 1 FROM information_schema.tables WHERE table_schema='dmcr' AND table_name='repeatable_log';" 2>/dev/null || echo "")"
    if [[ "$v11" != "1" ]]; then
        log_info "Upgrading registry to v1.1.0..."
        exec_psql_scalar "
CREATE TABLE IF NOT EXISTS dmcr.tags (
    tag_name TEXT PRIMARY KEY, change_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_by TEXT, description TEXT
);
CREATE TABLE IF NOT EXISTS dmcr.repeatable_log (
    change_id TEXT PRIMARY KEY, last_checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_by TEXT, environment TEXT, actor TEXT
);" >/dev/null
        log_info "Registry upgraded to v1.1.0"
    fi
}

# =============================================================================
# ADVISORY LOCKING
# =============================================================================
DMCR_LOCK_KEY="3735928559"  # 0xDEADBEEF

acquire_advisory_lock() {
    log_info "Acquiring lock..."
    local t_start=$SECONDS

    # File lock (same-machine)
    local lock_dir="/tmp/dmcr_locks"
    mkdir -p "$lock_dir"
    local conn_hash
    conn_hash="$(string_checksum "$CFG_CONN" | cut -c1-16)"
    DMCR_LOCK_FILE="$lock_dir/dmcr_${conn_hash}.lock"

    # Find a free fd (9 and up)
    local fd=9
    while [[ $fd -lt 200 ]]; do
        if ! { true >&${fd}; } 2>/dev/null; then
            break
        fi
        fd=$((fd + 1))
    done
    DMCR_LOCK_FD="$fd"

    eval "exec ${fd}>'${DMCR_LOCK_FILE}'" 2>/dev/null || {
        log_error "Cannot open lock file: $DMCR_LOCK_FILE"
        exit 1
    }

    if ! flock -n "$fd" 2>/dev/null; then
        log_error "Another DMCR process is running (lock: $DMCR_LOCK_FILE). Wait or remove the lock file."
        exit 1
    fi
    echo "PID=$$ at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&"$fd" 2>/dev/null || true

    # PostgreSQL advisory lock (best-effort)
    local pg_result
    pg_result="$(exec_psql_scalar "SELECT pg_try_advisory_lock(${DMCR_LOCK_KEY});" 2>/dev/null || echo "f")"
    if [[ "$pg_result" != "t" ]]; then
        log_warn "Another DMCR session may hold the PostgreSQL advisory lock. Proceeding with file lock."
    fi

    local elapsed=$(( SECONDS - t_start ))
    log_info "Lock acquired in ${elapsed}s"

    # Log lock event (best-effort)
    local actor
    actor="$(get_dmcr_actor)"
    exec_psql_scalar "
INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor)
VALUES ('lock', '*', 'success', 'Lock acquired (file + advisory)', '$(escape_sql "$CFG_ENV")', '$(escape_sql "$actor")');" >/dev/null 2>/dev/null || true
}

release_advisory_lock() {
    # Release file lock
    if [[ -n "$DMCR_LOCK_FD" ]]; then
        flock -u "$DMCR_LOCK_FD" 2>/dev/null || true
        eval "exec ${DMCR_LOCK_FD}>&-" 2>/dev/null || true
        DMCR_LOCK_FD=""
        log_debug "File lock released"
    fi

    # Release pg advisory lock (best-effort)
    exec_psql_scalar "SELECT pg_advisory_unlock(${DMCR_LOCK_KEY});" >/dev/null 2>/dev/null || true

    local actor
    actor="$(get_dmcr_actor)"
    exec_psql_scalar "
INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor)
VALUES ('unlock', '*', 'success', 'Lock released', '$(escape_sql "$CFG_ENV")', '$(escape_sql "$actor")');" >/dev/null 2>/dev/null || true
}

# =============================================================================
# ACTOR & GIT
# =============================================================================
get_dmcr_actor() {
    if [[ -n "${DMCR_ACTOR:-}" ]]; then
        echo "$DMCR_ACTOR"
    else
        echo "${USER:-unknown}@$(hostname 2>/dev/null || echo "localhost")"
    fi
}

get_git_commit() {
    local dir="$1"
    local sha
    sha="$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || true)"
    echo "${sha:-}"
}

# =============================================================================
# CHANGE FOLDERS
# =============================================================================
get_change_folders() {
    local dir="$1"
    if [[ -z "$dir" ]]; then
        log_error "changes_dir is empty in config"
        exit 1
    fi
    if [[ ! -d "$dir" ]]; then
        log_error "changes_dir not found: $dir"
        exit 1
    fi
    # List dirs matching [0-9]*_* sorted
    find "$dir" -maxdepth 1 -mindepth 1 -type d -name '[0-9]*_*' | sort
}

get_repeatable_folders() {
    local dir="$1"
    [[ -d "$dir" ]] || return 0
    find "$dir" -maxdepth 1 -mindepth 1 -type d -name 'R__*' | sort
}

# =============================================================================
# REGISTRY QUERIES
# =============================================================================
is_applied() {
    local change_id="$1"
    log_debug "CHECK $change_id"
    local safe_id
    safe_id="$(escape_sql "$change_id")"
    local result
    result="$(exec_psql_scalar "SELECT 1 FROM dmcr.change_log WHERE change_id = '${safe_id}' LIMIT 1;" 2>/dev/null || echo "")"
    [[ "$result" == "1" ]]
}

last_applied() {
    exec_psql_scalar "SELECT change_id FROM dmcr.change_log ORDER BY applied_at DESC, change_id DESC LIMIT 1;" 2>/dev/null || echo ""
}

get_tag_change_id() {
    local tag_name="$1"
    local safe_tag
    safe_tag="$(escape_sql "$tag_name")"
    exec_psql_scalar "SELECT change_id FROM dmcr.tags WHERE tag_name = '${safe_tag}' LIMIT 1;" 2>/dev/null || echo ""
}

repeatable_needs_run() {
    local folder_path="$1"
    local id
    id="$(basename "$folder_path")"
    local deploy_file="$folder_path/deploy.sql"
    [[ -f "$deploy_file" ]] || return 1
    local current_checksum
    current_checksum="$(file_checksum "$deploy_file")"
    local safe_id
    safe_id="$(escape_sql "$id")"
    local stored
    stored="$(exec_psql_scalar "SELECT last_checksum FROM dmcr.repeatable_log WHERE change_id = '${safe_id}' LIMIT 1;" 2>/dev/null || echo "")"
    [[ -z "$stored" || "$stored" != "$current_checksum" ]]
}

# =============================================================================
# META.JSON READER (pure bash, no jq required — falls back gracefully)
# =============================================================================
read_meta_requires() {
    local folder_path="$1"
    local meta="$folder_path/meta.json"
    [[ -f "$meta" ]] || return 0
    # Extract requires array values using grep/sed (no jq dependency)
    if command -v jq >/dev/null 2>&1; then
        jq -r '.requires // [] | .[]' "$meta" 2>/dev/null || true
    else
        # Naive parser: extract strings from requires array
        grep -oE '"[^"]*"' "$meta" | tr -d '"' | grep -vE '^\s*$' || true
    fi
}

read_meta_ticket() {
    local folder_path="$1"
    local meta="$folder_path/meta.json"
    [[ -f "$meta" ]] || { echo ""; return; }
    if command -v jq >/dev/null 2>&1; then
        jq -r '.ticket // empty' "$meta" 2>/dev/null || echo ""
    else
        grep -oP '"ticket"\s*:\s*"\K[^"]+' "$meta" 2>/dev/null || echo ""
    fi
}

read_meta_app_name() {
    local folder_path="$1"
    local meta="$folder_path/meta.json"
    [[ -f "$meta" ]] || { echo ""; return; }
    if command -v jq >/dev/null 2>&1; then
        jq -r '.app_name // empty' "$meta" 2>/dev/null || echo ""
    else
        grep -oP '"app_name"\s*:\s*"\K[^"]+' "$meta" 2>/dev/null || echo ""
    fi
}

# =============================================================================
# DANGEROUS SQL GATE
# =============================================================================
DANGER_JSON="${SCRIPT_DIR}/dmcr_danger.json"

_DANGER_DEPLOY_PATTERNS=(
    'DROP[[:space:]]+TABLE'
    'DROP[[:space:]]+SCHEMA'
    'DROP[[:space:]]+DATABASE'
    'DROP[[:space:]]+FUNCTION'
    'DROP[[:space:]]+PROCEDURE'
    'DROP[[:space:]]+VIEW'
    'DROP[[:space:]]+TRIGGER'
    'DROP[[:space:]]+INDEX'
    'DROP[[:space:]]+SEQUENCE'
    'DROP[[:space:]]+TYPE'
    'DROP[[:space:]]+EXTENSION'
)
_DANGER_DEPLOY_LABELS=(
    "DROP TABLE" "DROP SCHEMA" "DROP DATABASE" "DROP FUNCTION" "DROP PROCEDURE"
    "DROP VIEW" "DROP TRIGGER" "DROP INDEX" "DROP SEQUENCE" "DROP TYPE" "DROP EXTENSION"
)
_DANGER_ALWAYS_PATTERNS=('TRUNCATE')
_DANGER_ALWAYS_LABELS=("TRUNCATE")
_DANGER_DELETE_WITHOUT_WHERE=1
_DANGER_UPDATE_WITHOUT_WHERE=0

# Load overrides from dmcr_danger.json if jq is available
load_danger_rules() {
    [[ -f "$DANGER_JSON" ]] || return 0
    if ! command -v jq >/dev/null 2>&1; then
        log_debug "jq not found — using built-in danger rules (cannot parse dmcr_danger.json)"
        return 0
    fi
    local val
    val="$(jq -r '.deleteWithoutWhereEnabled // true' "$DANGER_JSON" 2>/dev/null || echo "true")"
    [[ "$val" == "false" ]] && _DANGER_DELETE_WITHOUT_WHERE=0 || _DANGER_DELETE_WITHOUT_WHERE=1
    val="$(jq -r '.updateWithoutWhereEnabled // false' "$DANGER_JSON" 2>/dev/null || echo "false")"
    [[ "$val" == "true" ]] && _DANGER_UPDATE_WITHOUT_WHERE=1 || _DANGER_UPDATE_WITHOUT_WHERE=0
    log_debug "Loaded danger rules from: $DANGER_JSON"
}
load_danger_rules

strip_sql_comments() {
    # Remove /* */ block comments and -- line comments
    local sql="$1"
    # Strip block comments (simple approach)
    sql="$(echo "$sql" | perl -0777 -pe 's|/\*.*?\*/| |gs' 2>/dev/null || echo "$sql")"
    # Strip line comments
    sql="$(echo "$sql" | sed 's/--[^\n]*/ /g')"
    echo "$sql"
}

get_dangerous_ops() {
    local sql="$1"
    local mode="$2"  # deploy or revert
    local stripped
    stripped="$(strip_sql_comments "$sql")"
    local findings=()

    # Always patterns
    local i
    for i in "${!_DANGER_ALWAYS_PATTERNS[@]}"; do
        local pat="${_DANGER_ALWAYS_PATTERNS[$i]}"
        local lbl="${_DANGER_ALWAYS_LABELS[$i]}"
        if echo "$stripped" | grep -qiE "[[:space:]]*(${pat})[[:space:]]"; then
            findings+=("$lbl")
        fi
    done

    # Deploy-only patterns
    if [[ "$mode" == "deploy" ]]; then
        for i in "${!_DANGER_DEPLOY_PATTERNS[@]}"; do
            local pat="${_DANGER_DEPLOY_PATTERNS[$i]}"
            local lbl="${_DANGER_DEPLOY_LABELS[$i]}"
            if echo "$stripped" | grep -qiE "[[:space:]]*(${pat})[[:space:]]"; then
                findings+=("$lbl")
            fi
        done
    fi

    # DELETE without WHERE
    if [[ $_DANGER_DELETE_WITHOUT_WHERE -eq 1 ]]; then
        if echo "$stripped" | grep -qiE '\bDELETE\b' && \
           echo "$stripped" | grep -qiE '\bFROM\b' && \
           ! echo "$stripped" | grep -qiE '\bWHERE\b'; then
            findings+=("DELETE without WHERE")
        fi
    fi

    # UPDATE without WHERE
    if [[ $_DANGER_UPDATE_WITHOUT_WHERE -eq 1 ]]; then
        if echo "$stripped" | grep -qiE '\bUPDATE\b' && \
           echo "$stripped" | grep -qiE '\bSET\b' && \
           ! echo "$stripped" | grep -qiE '\bWHERE\b'; then
            findings+=("UPDATE without WHERE")
        fi
    fi

    printf '%s\n' "${findings[@]+"${findings[@]}"}"
}

assert_safe_change() {
    local folder_id="$1"
    local folder_path="$2"
    local mode="$3"  # deploy or revert

    # danger_ folders are handled upstream
    echo "$folder_id" | grep -qiE '(^|_)danger_' && return 0

    local findings=()
    if [[ "$mode" == "deploy" && -f "$folder_path/deploy.sql" ]]; then
        local sql
        sql="$(cat "$folder_path/deploy.sql")"
        while IFS= read -r op; do
            [[ -n "$op" ]] && findings+=("deploy.sql: $op")
        done < <(get_dangerous_ops "$sql" "deploy")
    fi

    if [[ "$mode" == "revert" && -f "$folder_path/revert.sql" ]]; then
        local sql
        sql="$(cat "$folder_path/revert.sql")"
        while IFS= read -r op; do
            [[ -n "$op" ]] && findings+=("revert.sql: $op")
        done < <(get_dangerous_ops "$sql" "revert")
    fi

    if [[ ${#findings[@]} -eq 0 ]]; then
        return 0
    fi

    local suggested
    suggested="$(echo "$folder_id" | sed -E 's/^([0-9]+_)/\1danger_/')"
    log_error "BLOCKED: Dangerous SQL detected in '$folder_id':"
    local f
    for f in "${findings[@]}"; do
        log_error "  >> $f"
    done
    log_error "Rename the folder so a DBA can run it manually:"
    log_error "  Current : $folder_id"
    log_error "  Renamed : $suggested"
    return 1
}

# =============================================================================
# PREFLIGHT
# =============================================================================
invoke_enhanced_preflight() {
    local changes_dir="$1"
    local issues=()

    # Read folders into array
    local folders=()
    while IFS= read -r f; do
        [[ -n "$f" ]] && folders+=("$f")
    done < <(get_change_folders "$changes_dir" 2>/dev/null || true)

    # 1. Required files
    local f
    for f in "${folders[@]+"${folders[@]}"}"; do
        local id
        id="$(basename "$f")"
        echo "$id" | grep -qiE '(^|_)danger_' && continue
        local req
        for req in deploy.sql verify.sql revert.sql; do
            [[ -f "$f/$req" ]] || issues+=("MISSING  ${id}/${req}")
        done
    done

    # 2. Duplicate prefix detection
    declare -A prefix_map=()
    for f in "${folders[@]+"${folders[@]}"}"; do
        local id
        id="$(basename "$f")"
        local prefix
        prefix="$(echo "$id" | grep -oE '^[0-9]{3}' || true)"
        [[ -n "$prefix" ]] || continue
        local _pm_val="${prefix_map[$prefix]+__SET__}"
        if [[ "$_pm_val" == "__SET__" ]]; then
            issues+=("DUPLICATE PREFIX ${prefix}: ${prefix_map[$prefix]}, $id")
        else
            prefix_map["$prefix"]="$id"
        fi
    done

    # 3. Malformed names
    for f in "${folders[@]+"${folders[@]}"}"; do
        local id
        id="$(basename "$f")"
        echo "$id" | grep -qE '^[0-9]{3}_[[:alnum:]]' || issues+=("MALFORMED  $id — expected: 001_descriptive_name")
    done

    # 4. Prefix gaps
    local prev_num=-1
    for f in "${folders[@]+"${folders[@]}"}"; do
        local id
        id="$(basename "$f")"
        local num
        num="$(echo "$id" | grep -oE '^[0-9]{3}' || true)"
        [[ -n "$num" ]] || continue
        num=$((10#$num))
        if [[ $prev_num -ge 0 ]]; then
            local gap=$(( num - prev_num ))
            if [[ $gap -gt 1 ]]; then
                issues+=("GAP  prefix gap between $(printf '%03d' $prev_num) and $(printf '%03d' $num)")
            fi
        fi
        prev_num=$num
    done

    # 5. Dependency validation
    for f in "${folders[@]+"${folders[@]}"}"; do
        local id
        id="$(basename "$f")"
        while IFS= read -r dep; do
            [[ -n "$dep" ]] || continue
            local found=0
            local f2
            for f2 in "${folders[@]+"${folders[@]}"}"; do
                [[ "$(basename "$f2")" == "$dep" ]] && { found=1; break; }
            done
            [[ $found -eq 1 ]] || issues+=("DEPENDENCY  $id requires '$dep' which does not exist")
        done < <(read_meta_requires "$f")
    done

    printf '%s\n' "${issues[@]+"${issues[@]}"}"
}

# =============================================================================
# DEPENDENCY-AWARE PLANNER (topological sort — Kahn's algorithm)
# =============================================================================
cmd_plan() {
    local json_out="${1:-0}"

    local folders=()
    while IFS= read -r f; do
        [[ -n "$f" ]] && folders+=("$f")
    done < <(get_change_folders "$CFG_CHANGES_DIR")

    # Build adjacency and in-degree maps
    declare -A graph_requires=()   # id -> space-separated deps
    declare -A in_degree=()
    declare -A adj=()              # id -> space-separated successors
    local ids=()

    local f
    for f in "${folders[@]+"${folders[@]}"}"; do
        local id
        id="$(basename "$f")"
        ids+=("$id")
        graph_requires["$id"]=""
        in_degree["$id"]="${in_degree[$id]:-0}"
        adj["$id"]="${adj[$id]:-}"
    done

    for f in "${folders[@]+"${folders[@]}"}"; do
        local id
        id="$(basename "$f")"
        local dep
        while IFS= read -r dep; do
            [[ -n "$dep" ]] || continue
            if [[ -z "${in_degree[$dep]+x}" ]]; then
                log_warn "Change '$id' requires '$dep' which does not exist"
                continue
            fi
            graph_requires["$id"]="${graph_requires[$id]} $dep"
            adj["$dep"]="${adj[$dep]} $id"
            in_degree["$id"]=$(( ${in_degree[$id]:-0} + 1 ))
        done < <(read_meta_requires "$f")
    done

    # Kahn's
    local queue=()
    local id
    for id in "${ids[@]+"${ids[@]}"}"; do
        [[ "${in_degree[$id]:-0}" -eq 0 ]] && queue+=("$id")
    done
    # Sort seeds for determinism
    IFS=$'\n' queue=($(printf '%s\n' "${queue[@]+"${queue[@]}"}" | sort))

    local order=()
    while [[ ${#queue[@]} -gt 0 ]]; do
        local current="${queue[0]}"
        queue=("${queue[@]:1}")
        order+=("$current")
        if [[ -n "${adj[$current]:-}" ]]; then
            local neighbor
            for neighbor in ${adj[$current]}; do
                in_degree["$neighbor"]=$(( in_degree[$neighbor] - 1 ))
                if [[ "${in_degree[$neighbor]}" -eq 0 ]]; then
                    queue+=("$neighbor")
                    IFS=$'\n' queue=($(printf '%s\n' "${queue[@]}" | sort))
                fi
            done
        fi
    done

    if [[ ${#order[@]} -ne ${#ids[@]} ]]; then
        log_error "Circular dependency detected in change folders"
        exit 1
    fi

    if [[ "$json_out" == "1" ]]; then
        printf '[\n'
        local first=1 idx
        for idx in "${!order[@]}"; do
            local oid="${order[$idx]}"
            local status="pending"
            is_applied "$oid" 2>/dev/null && status="applied" || true
            local reqs="${graph_requires[$oid]:-}"
            reqs="${reqs#" "}"
            local reqs_json="[]"
            if [[ -n "$reqs" ]]; then
                reqs_json='['
                local r first_r=1
                for r in $reqs; do
                    [[ $first_r -eq 0 ]] && reqs_json+=","
                    reqs_json+="\"$r\""
                    first_r=0
                done
                reqs_json+=']'
            fi
            [[ $first -eq 0 ]] && printf ','
            printf '{"change_id":"%s","status":"%s","requires":%s}\n' "$oid" "$status" "$reqs_json"
            first=0
        done
        printf ']\n'
        return 0
    fi

    log_info "Dependency-aware execution plan:"
    print_table "Execution Plan" \
        "Order|Change|Status|Requires" \
        "$(local i=1; for oid in "${order[@]+"${order[@]}"}"; do
            local st="PENDING"
            is_applied "$oid" 2>/dev/null && st="APPLIED" || true
            local reqs="${graph_requires[$oid]:-}"
            reqs="${reqs#" "}"
            [[ -z "$reqs" ]] && reqs="—"
            printf '%d\t%s\t%s\t%s\n' "$i" "$oid" "$st" "$reqs"
            i=$((i+1))
        done)"
}

# =============================================================================
# SIMPLE TABLE PRINTER
# =============================================================================
print_table() {
    local title="$1"
    local headers="$2"  # pipe-separated
    shift 2

    # Use printf for a simple ASCII table
    _ansi_enabled && printf "\033[93m" || true
    printf "\n  === %s ===\n" "$title"
    _ansi_enabled && printf "\033[0m" || true

    IFS='|' read -ra cols <<< "$headers"
    local header_line=""
    local sep_line=""
    for col in "${cols[@]}"; do
        header_line+="  ${col}"
        sep_line+="  $(printf '%.0s-' $(seq 1 ${#col}))"
    done
    _ansi_enabled && printf "\033[93m%s\033[0m\n" "$header_line" || printf "%s\n" "$header_line"
    printf "%s\n" "$sep_line"
}

# =============================================================================
# BOXED TABLE (unicode borders)
# =============================================================================
print_boxed_table() {
    local title="$1"
    shift
    # Columns: pipe-separated header names
    local headers="$1"
    shift
    # Rows: each arg is a tab-separated row of values
    local -a col_names=()
    IFS='|' read -ra col_names <<< "$headers"
    local ncols=${#col_names[@]}

    local -a rows=("$@")
    local -a col_widths=()

    # Init widths from header names
    local i
    for i in "${!col_names[@]}"; do
        col_widths[$i]="${#col_names[$i]}"
    done

    # Measure data widths
    local row
    for row in "${rows[@]+"${rows[@]}"}"; do
        IFS=$'\t' read -ra cells <<< "$row"
        for i in "${!cells[@]}"; do
            local len="${#cells[$i]}"
            [[ $i -lt $ncols && ${col_widths[$i]:-0} -lt $len ]] && col_widths[$i]=$len
        done
    done

    # Add padding
    for i in "${!col_widths[@]}"; do
        col_widths[$i]=$(( col_widths[$i] + 2 ))
    done

    # Build border strings
    local top="┌" sep="├" bot="└"
    for i in "${!col_names[@]}"; do
        local w=${col_widths[$i]}
        local dashes
        dashes="$(printf '%*s' $w '' | tr ' ' '─')"
        top+="${dashes}"
        sep+="${dashes}"
        bot+="${dashes}"
        if [[ $i -lt $((ncols-1)) ]]; then
            top+="┬"; sep+="┼"; bot+="┴"
        else
            top+="┐"; sep+="┤"; bot+="┘"
        fi
    done

    # Title row border
    local total_inner=0
    for i in "${!col_names[@]}"; do
        total_inner=$(( total_inner + col_widths[$i] ))
        [[ $i -lt $((ncols-1)) ]] && total_inner=$(( total_inner + 1 ))
    done
    local title_top="┌$(printf '%*s' $total_inner '' | tr ' ' '─')┐"
    local title_sep="├"
    for i in "${!col_names[@]}"; do
        local w=${col_widths[$i]}
        local dashes
        dashes="$(printf '%*s' $w '' | tr ' ' '─')"
        title_sep+="${dashes}"
        if [[ $i -lt $((ncols-1)) ]]; then title_sep+="┬"; else title_sep+="┤"; fi
    done

    local bc="\033[93m" rc="\033[0m"
    _ansi_enabled || bc="" rc=""

    # Top + title
    printf "${bc}%s${rc}\n" "$title_top"
    local tpad=$(( total_inner - ${#title} - 2 ))
    local lpad=$(( tpad / 2 ))
    local rpad=$(( tpad - lpad ))
    printf "${bc}│${rc} \033[92m%s\033[0m%*s${bc} │${rc}\n" "$title" $(( lpad + rpad )) ""
    printf "${bc}%s${rc}\n" "$title_sep"

    # Header row
    local header_row="${bc}│${rc}"
    for i in "${!col_names[@]}"; do
        local w=$(( col_widths[$i] - 2 ))
        header_row+="${bc} \033[93m$(printf "%-${w}s" "${col_names[$i]}") ${rc}${bc}│${rc}"
    done
    printf "%b\n" "$header_row"
    printf "${bc}%s${rc}\n" "$sep"

    # Data rows
    local ridx=0
    for row in "${rows[@]+"${rows[@]}"}"; do
        IFS=$'\t' read -ra cells <<< "$row"
        local data_row="${bc}│${rc}"
        for i in "${!col_names[@]}"; do
            local w=$(( col_widths[$i] - 2 ))
            local cell="${cells[$i]:-}"
            data_row+=" $(printf "%-${w}s" "$cell") ${bc}│${rc}"
        done
        printf "%b\n" "$data_row"
        ridx=$((ridx+1))
        [[ $ridx -lt ${#rows[@]} ]] && printf "${bc}%s${rc}\n" "$sep"
    done

    printf "${bc}%s${rc}\n" "$bot"
}

# =============================================================================
# VERIFY CHANGE
# =============================================================================
verify_change() {
    local change_id="$1"
    local verify_path="${CFG_CHANGES_DIR}/${change_id}/verify.sql"
    log_debug "Verify script: $verify_path"
    exec_psql_file_tx_rollback "$verify_path"
}

# =============================================================================
# REVERT CHANGE
# =============================================================================
revert_change() {
    local change_id="$1"
    local latest
    latest="$(last_applied)"
    log_debug "Latest applied (from DB): '$latest'"

    if [[ "$latest" != "$change_id" ]]; then
        log_error "Refusing to revert non-latest change. Latest is '$latest'"
        return 1
    fi

    if echo "$change_id" | grep -qiE '(^|_)danger_'; then
        log_error "BLOCKED: '$change_id' is a manual-only (danger_) change. Run revert.sql directly."
        return 1
    fi

    local t_start=$SECONDS
    log_revert "$change_id"
    local revert_path="${CFG_CHANGES_DIR}/${change_id}/revert.sql"
    local folder_path="${CFG_CHANGES_DIR}/${change_id}"
    local actor
    actor="$(get_dmcr_actor)"

    # Checksum guard
    local deploy_file="$folder_path/deploy.sql"
    if [[ -f "$deploy_file" ]]; then
        local safe_id
        safe_id="$(escape_sql "$change_id")"
        local stored_chk
        stored_chk="$(exec_psql_scalar "SELECT deploy_checksum FROM dmcr.change_log WHERE change_id = '${safe_id}';" 2>/dev/null || echo "")"
        if [[ -n "$stored_chk" ]]; then
            local current_chk
            current_chk="$(file_checksum "$deploy_file")"
            if [[ "$current_chk" != "$stored_chk" ]]; then
                case "$CFG_CHECKSUM_POLICY" in
                    block)
                        log_error "BLOCKED: deploy.sql for '$change_id' checksum mismatch. Policy=block."
                        return 1
                        ;;
                    repair)
                        log_warn "deploy.sql for '$change_id' checksum mismatch. Policy=repair requires explicit reconciliation."
                        return 1
                        ;;
                    *)
                        log_warn "deploy.sql for '$change_id' has changed since applied (checksum mismatch). Proceeding."
                        ;;
                esac
            else
                log_debug "Checksum verified OK for $change_id"
            fi
        fi
    fi

    assert_safe_change "$change_id" "$folder_path" "revert" || return 1

    local safe_id
    safe_id="$(escape_sql "$change_id")"
    local delete_sql="DELETE FROM dmcr.change_log WHERE change_id = '${safe_id}';"
    log_info "Executing revert.sql + removing record (single transaction)"
    if ! exec_psql_file_tx "$revert_path" "$delete_sql"; then
        local elapsed=$(( SECONDS - t_start ))
        local safe_actor safe_env safe_msg
        safe_actor="$(escape_sql "$actor")"
        safe_env="$(escape_sql "$CFG_ENV")"
        safe_msg="$(escape_sql "revert.sql transaction failed")"
        exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,message,environment,actor,duration_ms) VALUES ('revert','${safe_id}','failure','${safe_msg}','${safe_env}','${safe_actor}',${elapsed});" >/dev/null 2>/dev/null || true
        return 1
    fi

    log_verify "$change_id (after revert)"
    verify_change "$change_id" || {
        log_error "Verify failed after revert of $change_id"
        return 1
    }

    local elapsed=$(( SECONDS - t_start ))
    local safe_actor safe_env
    safe_actor="$(escape_sql "$actor")"
    safe_env="$(escape_sql "$CFG_ENV")"
    exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,environment,actor,duration_ms) VALUES ('revert','${safe_id}','success','${safe_env}','${safe_actor}',${elapsed});" >/dev/null 2>/dev/null || true
    log_done "$change_id reverted successfully (${elapsed}s)"
}

revert_to() {
    local target="$1"
    if ! is_applied "$target"; then
        log_error "Target change '$target' is not applied"
        return 1
    fi
    local max_iter=500 iter=0 prev_last=""
    while true; do
        iter=$((iter+1))
        [[ $iter -gt $max_iter ]] && { log_error "Revert-to safety limit ($max_iter iterations) reached"; return 1; }
        local last
        last="$(last_applied)"
        [[ -z "$last" ]] && { log_error "No applied changes remain but target '$target' was not reached"; return 1; }
        [[ "$last" == "$prev_last" ]] && { log_error "Revert-to is stuck: last='$last' unchanged. Aborting."; return 1; }
        prev_last="$last"
        revert_change "$last" || return 1
        [[ "$last" == "$target" ]] && break
    done
    log_done "Reverted to $target"
}

# =============================================================================
# PARSE SQL (BEGIN/ROLLBACK validation)
# =============================================================================
cmd_parse() {
    local sql_text="$1"
    local trimmed="${sql_text#"${sql_text%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"

    if [[ -z "$trimmed" ]]; then
        printf '{"ok":false,"msg":"SQL is empty."}\n'
        return 0
    fi
    if [[ ${#trimmed} -gt 200000 ]]; then
        printf '{"ok":false,"msg":"SQL is too large (> 200k chars). Split it."}\n'
        return 0
    fi

    # Guard: reject explicit transaction control
    local stripped
    stripped="$(strip_sql_comments "$trimmed")"
    if echo "$stripped" | grep -qiE '^\s*(COMMIT|ROLLBACK|BEGIN|START[[:space:]]+TRANSACTION|END)\s*;?\s*$'; then
        local found
        found="$(echo "$stripped" | grep -oiE '(COMMIT|ROLLBACK|BEGIN|START[[:space:]]+TRANSACTION|END)' | head -1 | tr '[:lower:]' '[:upper:]')"
        printf '{"ok":false,"msg":"SQL contains %s which would escape the validation transaction."}\n' "'$found'"
        return 0
    fi

    local tmp
    tmp="$(dmcr_mktemp "dmcr_parse_")"

    # Ensure trailing semicolon
    local sql_to_run="$trimmed"
    [[ "$sql_to_run" =~ [^[:space:]\;]$ ]] && sql_to_run="${sql_to_run}
;"

    cat > "$tmp" <<SQLPARSE
BEGIN;
SET LOCAL lock_timeout = '${CFG_LOCK_TIMEOUT}';
SET LOCAL statement_timeout = '60s';
${sql_to_run}
ROLLBACK;
SQLPARSE

    local psql_exe
    psql_exe="$(get_psql_exe)"
    local out exit_code=0
    out="$("$psql_exe" "$CFG_CONN" -X -q -v ON_ERROR_STOP=1 -f "$tmp" 2>&1)" || exit_code=$?
    rm -f "$tmp" 2>/dev/null || true

    if [[ $exit_code -eq 0 ]]; then
        printf '{"ok":true,"msg":"Parsed OK."}\n'
        return 0
    fi

    local msg
    msg="$(echo "$out" | grep -oP '(?<=^ERROR:  ).*' | head -1 || echo "$out" | head -1)"
    local line_num=""
    line_num="$(echo "$out" | grep -oP '(?<=LINE )\d+' | head -1 || true)"

    if [[ -n "$line_num" ]]; then
        local adj=$(( line_num > 4 ? line_num - 4 : 1 ))
        printf '{"ok":false,"msg":"%s","line":%d}\n' "$(echo "$msg" | sed 's/"/\\"/g')" "$adj"
    else
        printf '{"ok":false,"msg":"%s"}\n' "$(echo "$msg" | sed 's/"/\\"/g')"
    fi
}

# =============================================================================
# SHOW CONFIG
# =============================================================================
cmd_show_config() {
    local conn_redacted
    conn_redacted="$(redact_conn "$CFG_CONN")"
    local ph_count=${#CFG_PLACEHOLDERS[@]}
    local ph_str="none"
    [[ $ph_count -gt 0 ]] && ph_str="$ph_count defined"

    local rows=(
        "path	${CFG_CONFIG_PATH}"
        "env	${CFG_ENV}"
        "changes_dir	${CFG_CHANGES_DIR}"
        "psql_path	${CFG_PSQL_PATH:-<auto>}"
        "lock_timeout	${CFG_LOCK_TIMEOUT}"
        "stmt_timeout	${CFG_STMT_TIMEOUT}"
        "checksum_policy	${CFG_CHECKSUM_POLICY}"
        "placeholders	${ph_str}"
        "conn	${conn_redacted}"
    )
    print_boxed_table "Config" "Key|Value" "${rows[@]}"
}

# =============================================================================
# HELP
# =============================================================================
show_help() {
    local t="\033[96m" g="\033[92m" y="\033[93m" gr="\033[37m" c="\033[36m" dy="\033[33m" dg="\033[90m" r="\033[0m"
    _ansi_enabled || t="" g="" y="" gr="" c="" dy="" dg="" r=""

    printf "\n"
    printf "${t}  ╔══════════════════════════════════════════════════════════════════════╗${r}\n"
    printf "${t}  ║                                                                      ║${r}\n"
    printf "${t}  ║   DMCR v%s  ─  Database Management & Change Request Tracker       ║${r}\n" "$DMCR_VERSION"
    printf "${t}  ║                    for PostgreSQL                                     ║${r}\n"
    printf "${t}  ║                                                                      ║${r}\n"
    printf "${t}  ╚══════════════════════════════════════════════════════════════════════╝${r}\n"
    printf "\n"
    printf "${g}  USAGE${r}\n"
    printf "${c}    dmcr <command> [args] [--env <name>] [--dry-run] [--json] [--debug] [-c|--config <path>]${r}\n"
    printf "\n"
    printf "${g}  CORE COMMANDS${r}\n"
    printf "${y}    init                  ${gr}  Create the DMCR registry schema and tables.${r}\n"
    printf "${y}    deploy                ${gr}  Apply all pending changes in order.${r}\n"
    printf "${y}    deploy --to <id|@tag> ${gr}  Deploy only up to the specified change or tag.${r}\n"
    printf "${y}    deploy --dry-run      ${gr}  Show pending changes without executing.${r}\n"
    printf "${y}    status                ${gr}  Show APPLIED / PENDING for every change folder.${r}\n"
    printf "${y}    verify                ${gr}  Run verify.sql for the last applied change.${r}\n"
    printf "${y}    verify all            ${gr}  Run verify.sql for every applied change.${r}\n"
    printf "${y}    verify <change_id>    ${gr}  Run verify.sql for a specific change.${r}\n"
    printf "${y}    parse [sql]           ${gr}  Validate SQL inside a rolled-back transaction.${r}\n"
    printf "${y}    repeatable            ${gr}  Apply all R__* migrations with changed checksums.${r}\n"
    printf "\n"
    printf "${g}  REVERT COMMANDS${r}\n"
    printf "${y}    revert <change_id>    ${gr}  Revert a specific change (must be latest).${r}\n"
    printf "${y}    revert to <id|@tag>   ${gr}  Revert all changes down to and including target.${r}\n"
    printf "${y}    revert list           ${gr}  List all applied changes in reverse order.${r}\n"
    printf "${y}    revertLast            ${gr}  Revert the most recently applied change.${r}\n"
    printf "\n"
    printf "${g}  INSPECT COMMANDS${r}\n"
    printf "${y}    history               ${gr}  Show applied changes with timestamps, checksums.${r}\n"
    printf "${y}    info                  ${gr}  Summary of environment, counts, registry health.${r}\n"
    printf "${y}    plan                  ${gr}  Show dependency-aware execution order.${r}\n"
    printf "${y}    check                 ${gr}  Run preflight checks without deploying.${r}\n"
    printf "${y}    show config           ${gr}  Display the active configuration (conn redacted).${r}\n"
    printf "\n"
    printf "${g}  TAG COMMANDS${r}\n"
    printf "${y}    tag [list]            ${gr}  List all release tags.${r}\n"
    printf "${y}    tag create <name>     ${gr}  Tag the current deployment state.${r}\n"
    printf "${y}    tag delete <name>     ${gr}  Remove a tag.${r}\n"
    printf "\n"
    printf "${g}  REPAIR COMMANDS${r}\n"
    printf "${y}    baseline <change_id>  ${gr}  Mark all changes up to <change_id> as applied.${r}\n"
    printf "${y}    repair --mark-applied  <id>  ${gr}  Mark a change as applied without executing.${r}\n"
    printf "${y}    repair --mark-reverted <id>  ${gr}  Remove a change without executing revert.${r}\n"
    printf "${y}    repair --checksums           ${gr}  Reconcile stored checksums with files.${r}\n"
    printf "\n"
    printf "${g}  GLOBAL OPTIONS${r}\n"
    printf "${y}    --dry-run             ${gr}  (deploy) Print pending SQL without executing.${r}\n"
    printf "${y}    --to <id|@tag>        ${gr}  Stop at a specific change_id or release tag.${r}\n"
    printf "${y}    --json                ${gr}  Machine-readable JSON output.${r}\n"
    printf "${y}    --debug               ${gr}  Enable verbose debug logging (or DMCR_DEBUG=1).${r}\n"
    printf "${y}    --env <name>          ${gr}  Override active environment (e.g. --env prod).${r}\n"
    printf "${y}    -c, --config <path>   ${gr}  Path to config file (default: dmcr.cfg next to script).${r}\n"
    printf "${y}    -h, --help            ${gr}  Show this help.${r}\n"
    printf "\n"
    printf "${g}  ENVIRONMENT VARIABLES${r}\n"
    printf "${y}    DMCR_CONN             ${gr}  Override connection string.${r}\n"
    printf "${y}    DMCR_PSQL             ${gr}  Override psql executable path.${r}\n"
    printf "${y}    DMCR_CONFIG           ${gr}  Override config file path.${r}\n"
    printf "${y}    DMCR_ACTOR            ${gr}  Override deploying principal.${r}\n"
    printf "${y}    DMCR_DEBUG            ${gr}  Set to 1 for debug output.${r}\n"
    printf "${y}    DMCR_ANSI_OUTPUT      ${gr}  Set to 0 to disable ANSI colors.${r}\n"
    printf "${y}    DMCR_PLACEHOLDER_<x>  ${gr}  Override [placeholders] value for <x>.${r}\n"
    printf "\n"
    printf "${dg}  DMCR v%s  •  PostgreSQL Change Management  •  Transactional Changes${r}\n" "$DMCR_VERSION"
    printf "\n"
}

# =============================================================================
# MAIN ENTRYPOINT
# =============================================================================
main() {
    local command="help"
    local arg1="" arg2="" arg3=""
    local dry_run=0
    local json_out=0
    local deploy_to=""
    local config_path="${DMCR_CONFIG:-${SCRIPT_DIR}/dmcr.cfg}"
    local env_override=""
    local positional=()

    # Parse DMCR_DEBUG env
    case "${DMCR_DEBUG:-0}" in 1|true|yes|y|on) DMCR_DEBUG=1 ;; *) DMCR_DEBUG=0 ;; esac

    # Arg parsing
    local i=0
    while [[ $i -lt $# ]]; do
        i=$((i+1))
        local t="${!i}"
        case "$t" in
            --debug)     DMCR_DEBUG=1 ;;
            --dry-run)   dry_run=1 ;;
            --json)      json_out=1 ;;
            --to)
                i=$((i+1))
                [[ $i -gt $# ]] && { log_error "Missing value for --to"; exit 1; }
                deploy_to="${!i}"
                ;;
            --env)
                i=$((i+1))
                [[ $i -gt $# ]] && { log_error "Missing value for --env"; exit 1; }
                env_override="${!i}"
                ;;
            -c|--config)
                i=$((i+1))
                [[ $i -gt $# ]] && { log_error "Missing value for $t"; exit 1; }
                config_path="${!i}"
                ;;
            -h|--help|help|/?) positional+=("help") ;;
            *) positional+=("$t") ;;
        esac
    done

    command="${positional[0]:-help}"
    arg1="${positional[1]:-}"
    arg2="${positional[2]:-}"
    arg3="${positional[3]:-}"

    # Commands that don't need DB
    case "$command" in
        help|-h|--help)
            show_help
            return 0
            ;;
    esac

    # Load config for all other commands
    load_config "$config_path"

    # --env flag overrides the env from config
    if [[ -n "$env_override" ]]; then
        if ! ini_has_section "$env_override"; then
            log_error "Unknown environment '$env_override' — no [$env_override] section in $config_path"
            exit 1
        fi
        CFG_ENV="$env_override"
        local override_conn
        override_conn="$(ini_get "$CFG_ENV" "conn" "")"
        CFG_CONN="${DMCR_CONN:-$override_conn}"
        if [[ -z "$CFG_CONN" ]]; then
            log_error "No connection string found in [$CFG_ENV] section or DMCR_CONN env var"
            exit 1
        fi
        log_debug "--env override applied: CFG_ENV=$CFG_ENV"
    fi

    if [[ "$DMCR_DEBUG" == "1" ]]; then
        cmd_show_config
        log_debug "Command=$command arg1=$arg1 arg2=$arg2"
    fi

    case "$command" in
        show)
            [[ "$arg1" == "config" ]] && cmd_show_config || show_help
            return 0
            ;;
        init)
            log_init "Creating DMCR registry"
            local ddl_file="${SCRIPT_DIR}/dmcr_change_log_ddl.sql"
            if [[ ! -f "$ddl_file" ]]; then
                log_error "DDL file not found: $ddl_file"
                exit 1
            fi
            exec_psql_file_tx "$ddl_file" ""
            log_done "DMCR registry ready"
            return 0
            ;;
        parse)
            local sql_text=""
            if [[ ${#positional[@]} -ge 2 ]]; then
                sql_text="${positional[*]:1}"
            else
                sql_text="$(cat)"
            fi
            cmd_parse "$sql_text"
            return 0
            ;;
    esac

    # All remaining commands require the registry
    require_registry

    case "$command" in
        # ---- STATUS ----
        status)
            local folders=()
            while IFS= read -r f; do [[ -n "$f" ]] && folders+=("$f"); done \
                < <(get_change_folders "$CFG_CHANGES_DIR")

            if [[ $json_out -eq 1 ]]; then
                printf '[\n'
                local first=1
                for f in "${folders[@]+"${folders[@]}"}"; do
                    local id
                    id="$(basename "$f")"
                    local status="pending"
                    is_applied "$id" 2>/dev/null && status="applied" || true
                    [[ $first -eq 0 ]] && printf ','
                    printf '{"change_id":"%s","status":"%s"}\n' "$id" "$status"
                    first=0
                done
                printf ']\n'
                return 0
            fi

            local rows=()
            for f in "${folders[@]+"${folders[@]}"}"; do
                local id
                id="$(basename "$f")"
                local mark="PENDING"
                is_applied "$id" 2>/dev/null && mark="APPLIED" || true
                rows+=("${mark}	${id}")
            done
            print_boxed_table "Change Status" "Status|Change" "${rows[@]+"${rows[@]}"}"
            ;;

        # ---- DEPLOY ----
        deploy)
            log_info "Starting DMCR deploy$([ $dry_run -eq 1 ] && echo ' (DRY RUN)' || true)"
            log_info "Environment: $CFG_ENV"
            log_info "Changes directory: $CFG_CHANGES_DIR"

            # Resolve --to target
            local stop_at_id=""
            if [[ -n "$deploy_to" ]]; then
                if [[ "$deploy_to" == @* ]]; then
                    local tag_name="${deploy_to:1}"
                    local resolved
                    resolved="$(get_tag_change_id "$tag_name")"
                    if [[ -z "$resolved" ]]; then
                        log_error "Tag '@${tag_name}' not found. Use 'dmcr tag list'."
                        exit 1
                    fi
                    log_info "Deploy target: @${tag_name} → $resolved"
                    stop_at_id="$resolved"
                else
                    stop_at_id="$deploy_to"
                    log_info "Deploy target: $stop_at_id"
                fi
            fi

            local folders=()
            while IFS= read -r f; do [[ -n "$f" ]] && folders+=("$f"); done \
                < <(get_change_folders "$CFG_CHANGES_DIR")

            # Dry run
            if [[ $dry_run -eq 1 ]]; then
                local pending=()
                for f in "${folders[@]+"${folders[@]}"}"; do
                    local id
                    id="$(basename "$f")"
                    echo "$id" | grep -qiE '(^|_)danger_' && continue
                    is_applied "$id" 2>/dev/null && continue
                    pending+=("$f")
                done
                if [[ ${#pending[@]} -eq 0 ]]; then
                    [[ $json_out -eq 1 ]] && printf '{"status":"ok","message":"Nothing to deploy","changes":[]}\n' || log_info "Dry-run: nothing to deploy"
                    return 0
                fi
                if [[ $json_out -eq 1 ]]; then
                    printf '{"status":"dry_run","count":%d,"changes":[' "${#pending[@]}"
                    local first=1
                    for f in "${pending[@]}"; do
                        local id
                        id="$(basename "$f")"
                        [[ $first -eq 0 ]] && printf ','
                        printf '{"change_id":"%s"}\n' "$id"
                        first=0
                    done
                    printf ']}\n'
                    return 0
                fi
                log_warn "DRY RUN — ${#pending[@]} change(s) would be deployed:"
                for f in "${pending[@]}"; do
                    local id
                    id="$(basename "$f")"
                    log_info "--- $id ---"
                    [[ -f "$f/deploy.sql" ]] && cat "$f/deploy.sql" || log_warn "  deploy.sql not found"
                done
                log_warn "DRY RUN complete — re-run without --dry-run to apply"
                return 0
            fi

            # Preflight
            local issues=()
            while IFS= read -r issue; do
                [[ -n "$issue" ]] && issues+=("$issue")
            done < <(invoke_enhanced_preflight "$CFG_CHANGES_DIR")
            if [[ ${#issues[@]} -gt 0 ]]; then
                log_error "Pre-flight failed:"
                for issue in "${issues[@]}"; do log_error "  >> $issue"; done
                exit 1
            fi
            log_info "Pre-flight OK — all change folders validated"

            acquire_advisory_lock
            local deploy_results=()
            local deploy_failed=0

            local f
            for f in "${folders[@]+"${folders[@]}"}"; do
                local id
                id="$(basename "$f")"
                log_info "Evaluating change: $id"

                if is_applied "$id" 2>/dev/null; then
                    log_skip "$id already applied"
                    if [[ -n "$stop_at_id" && "$id" == "$stop_at_id" ]]; then
                        log_info "Reached --to target '$stop_at_id' (already applied) — stopping"
                        break
                    fi
                    continue
                fi

                if echo "$id" | grep -qiE '(^|_)danger_'; then
                    log_skip "$id — manual-only (danger_ folder, DBA must run deploy.sql directly)"
                    continue
                fi

                local t_start=$SECONDS
                local actor
                actor="$(get_dmcr_actor)"

                log_apply "$id"
                log_debug "Deploy folder: $f"

                if ! assert_safe_change "$id" "$f" "deploy"; then
                    deploy_failed=1
                    break
                fi

                # Gather metadata
                local ticket_id
                ticket_id="$(read_meta_ticket "$f")"
                local app_name
                app_name="$(read_meta_app_name "$f")"
                local git_commit
                git_commit="$(get_git_commit "$CFG_CHANGES_DIR")"

                local deploy_file="$f/deploy.sql"
                local verify_file="$f/verify.sql"
                local revert_file="$f/revert.sql"

                local deploy_chk verify_chk revert_chk
                deploy_chk="$(file_checksum "$deploy_file")"
                verify_chk="$([[ -f "$verify_file" ]] && file_checksum "$verify_file" || echo "")"
                revert_chk="$([[ -f "$revert_file" ]] && file_checksum "$revert_file" || echo "")"

                # Build INSERT
                local safe_id safe_dchk safe_vchk safe_rchk safe_env safe_actor
                safe_id="$(escape_sql "$id")"
                safe_dchk="$(escape_sql "$deploy_chk")"
                safe_vchk="$(escape_sql "$verify_chk")"
                safe_rchk="$(escape_sql "$revert_chk")"
                safe_env="$(escape_sql "$CFG_ENV")"
                safe_actor="$(escape_sql "$actor")"

                local insert_cols="change_id, deploy_checksum, verify_checksum, revert_checksum, environment, actor"
                local insert_vals="'${safe_id}', '${safe_dchk}', '${safe_vchk}', '${safe_rchk}', '${safe_env}', '${safe_actor}'"

                if [[ -n "$ticket_id" ]]; then
                    insert_cols+=", ticket_id"
                    insert_vals+=", '$(escape_sql "$ticket_id")'"
                fi
                if [[ -n "$git_commit" ]]; then
                    insert_cols+=", git_commit"
                    insert_vals+=", '$(escape_sql "$git_commit")'"
                fi
                if [[ -n "$app_name" ]]; then
                    insert_cols+=", app_name"
                    insert_vals+=", '$(escape_sql "$app_name")'"
                fi

                local record_sql="INSERT INTO dmcr.change_log(${insert_cols}) VALUES (${insert_vals});"

                log_info "Executing deploy.sql + recording change (single transaction)"
                if ! exec_psql_file_tx "$deploy_file" "$record_sql"; then
                    local elapsed=$(( SECONDS - t_start ))
                    exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,message,environment,actor,duration_ms) VALUES ('deploy','${safe_id}','failure','deploy transaction failed','${safe_env}','${safe_actor}',${elapsed});" >/dev/null 2>/dev/null || true
                    deploy_results+=("{\"change_id\":\"${id}\",\"status\":\"failure\"}")
                    deploy_failed=1
                    break
                fi

                # Verify
                log_verify "$id (after deploy)"
                log_info "Running verify.sql"
                if ! verify_change "$id" 2>/dev/null; then
                    log_error "Verify failed for $id — auto-reverting"
                    local revert_sql="DELETE FROM dmcr.change_log WHERE change_id = '${safe_id}';"
                    exec_psql_file_tx "$revert_file" "$revert_sql" 2>/dev/null && \
                        log_warn "$id auto-reverted after verify failure" || \
                        log_error "Auto-revert also failed for $id"
                    deploy_results+=("{\"change_id\":\"${id}\",\"status\":\"failure\",\"error\":\"verify failed\"}")
                    deploy_failed=1
                    break
                fi

                local elapsed=$(( SECONDS - t_start ))
                exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,environment,actor,duration_ms) VALUES ('deploy','${safe_id}','success','${safe_env}','${safe_actor}',${elapsed});" >/dev/null 2>/dev/null || true
                deploy_results+=("{\"change_id\":\"${id}\",\"status\":\"success\",\"duration_s\":${elapsed}}")
                log_done "$id applied successfully (${elapsed}s)"

                if [[ -n "$stop_at_id" && "$id" == "$stop_at_id" ]]; then
                    log_info "Reached --to target '$stop_at_id' — stopping deploy"
                    break
                fi
            done

            release_advisory_lock

            [[ $deploy_failed -eq 1 ]] && exit 1

            # Repeatable migrations
            local r_folders=()
            while IFS= read -r rf; do [[ -n "$rf" ]] && r_folders+=("$rf"); done \
                < <(get_repeatable_folders "$CFG_CHANGES_DIR" 2>/dev/null || true)

            if [[ ${#r_folders[@]} -gt 0 ]]; then
                log_info "Checking repeatable migrations..."
                acquire_advisory_lock
                for rf in "${r_folders[@]}"; do
                    local rid
                    rid="$(basename "$rf")"
                    local rfile="$rf/deploy.sql"
                    [[ -f "$rfile" ]] || continue
                    if ! repeatable_needs_run "$rf" 2>/dev/null; then
                        log_skip "$rid — unchanged"
                        continue
                    fi
                    local rt_start=$SECONDS
                    local ractor
                    ractor="$(get_dmcr_actor)"
                    local rchk
                    rchk="$(file_checksum "$rfile")"
                    assert_safe_change "$rid" "$rf" "deploy" || continue
                    exec_psql_file_tx "$rfile" "" || { log_error "Repeatable $rid failed"; continue; }
                    local safe_rid safe_rchk safe_renv safe_ractor
                    safe_rid="$(escape_sql "$rid")"
                    safe_rchk="$(escape_sql "$rchk")"
                    safe_renv="$(escape_sql "$CFG_ENV")"
                    safe_ractor="$(escape_sql "$ractor")"
                    exec_psql_scalar "INSERT INTO dmcr.repeatable_log(change_id,last_checksum,applied_at,environment,actor) VALUES ('${safe_rid}','${safe_rchk}',now(),'${safe_renv}','${safe_ractor}') ON CONFLICT (change_id) DO UPDATE SET last_checksum=EXCLUDED.last_checksum,applied_at=EXCLUDED.applied_at,environment=EXCLUDED.environment,actor=EXCLUDED.actor;" >/dev/null
                    local relapsed=$(( SECONDS - rt_start ))
                    [[ -f "$rf/verify.sql" ]] && exec_psql_file_tx_rollback "$rf/verify.sql" || true
                    deploy_results+=("{\"change_id\":\"${rid}\",\"status\":\"applied\",\"duration_s\":${relapsed}}")
                    log_done "$rid applied (${relapsed}s)"
                done
                release_advisory_lock
            fi

            if [[ $json_out -eq 1 && ${#deploy_results[@]} -gt 0 ]]; then
                printf '{"status":"ok","changes":[%s]}\n' "$(IFS=,; echo "${deploy_results[*]}")"
            fi
            ;;

        # ---- VERIFY ----
        verify)
            if [[ "$arg1" == "all" ]]; then
                local folders=()
                while IFS= read -r f; do [[ -n "$f" ]] && folders+=("$f"); done \
                    < <(get_change_folders "$CFG_CHANGES_DIR")
                local vresults=()
                for f in "${folders[@]+"${folders[@]}"}"; do
                    local id
                    id="$(basename "$f")"
                    is_applied "$id" 2>/dev/null || continue
                    log_verify "$id"
                    if verify_change "$id" 2>/dev/null; then
                        log_done "$id verified OK"
                        vresults+=("{\"change_id\":\"${id}\",\"status\":\"ok\"}")
                    else
                        log_error "$id verify FAILED"
                        vresults+=("{\"change_id\":\"${id}\",\"status\":\"failed\"}")
                    fi
                done
                [[ $json_out -eq 1 ]] && printf '[%s]\n' "$(IFS=,; echo "${vresults[*]+"${vresults[*]}"}")"
                return 0
            fi
            if [[ -n "$arg1" ]]; then
                is_applied "$arg1" 2>/dev/null || { log_error "Change '$arg1' is not applied"; exit 1; }
                log_verify "$arg1"
                verify_change "$arg1"
                log_done "$arg1 verified OK"
                [[ $json_out -eq 1 ]] && printf '{"change_id":"%s","status":"ok"}\n' "$arg1"
                return 0
            fi
            local last
            last="$(last_applied)"
            if [[ -z "$last" ]]; then log_info "No applied changes"; return 0; fi
            verify_change "$last"
            log_done "$last verified OK"
            [[ $json_out -eq 1 ]] && printf '{"change_id":"%s","status":"ok"}\n' "$last"
            ;;

        # ---- HISTORY ----
        history)
            local hist_sql="SELECT change_id, applied_at, applied_by, deploy_checksum, ticket_id, git_commit, environment, actor FROM dmcr.change_log ORDER BY applied_at DESC, change_id DESC;"
            if [[ $json_out -eq 1 ]]; then
                local psql_exe
                psql_exe="$(get_psql_exe)"
                local raw
                raw="$("$psql_exe" "$CFG_CONN" -q -v ON_ERROR_STOP=1 -X -t -A -F '|' \
                    -c "SET lock_timeout='${CFG_LOCK_TIMEOUT}'; ${hist_sql}" 2>&1)"
                printf '[\n'
                local first=1
                while IFS='|' read -r cid aat aby dchk tid gc env act; do
                    [[ -z "$cid" || "$cid" == "SET" ]] && continue
                    [[ $first -eq 0 ]] && printf ','
                    printf '{"change_id":"%s","applied_at":"%s","applied_by":"%s","deploy_checksum":"%s","ticket_id":"%s","git_commit":"%s","environment":"%s","actor":"%s"}\n' \
                        "$cid" "$aat" "$aby" "$dchk" "$tid" "$gc" "$env" "$act"
                    first=0
                done <<< "$raw"
                printf ']\n'
                return 0
            fi
            log_info "Change history (most recent first):"
            exec_psql "$hist_sql"
            ;;

        # ---- INFO ----
        info)
            local folders=()
            while IFS= read -r f; do [[ -n "$f" ]] && folders+=("$f"); done \
                < <(get_change_folders "$CFG_CHANGES_DIR" 2>/dev/null || true)
            local applied_count=0 pending_count=0 danger_count=0
            for f in "${folders[@]+"${folders[@]}"}"; do
                local id
                id="$(basename "$f")"
                if echo "$id" | grep -qiE '(^|_)danger_'; then
                    danger_count=$((danger_count+1))
                elif is_applied "$id" 2>/dev/null; then
                    applied_count=$((applied_count+1))
                else
                    pending_count=$((pending_count+1))
                fi
            done
            local reg_ok="true"
            exec_psql_scalar "SELECT 1 FROM information_schema.tables WHERE table_schema='dmcr' AND table_name='change_log';" >/dev/null 2>/dev/null || reg_ok="false"

            if [[ $json_out -eq 1 ]]; then
                printf '{"environment":"%s","total_changes":%d,"applied":%d,"pending":%d,"danger":%d,"registry_ok":%s,"checksum_policy":"%s"}\n' \
                    "$CFG_ENV" "${#folders[@]}" "$applied_count" "$pending_count" "$danger_count" "$reg_ok" "$CFG_CHECKSUM_POLICY"
                return 0
            fi

            local reg_label="OK"
            [[ "$reg_ok" == "false" ]] && reg_label="NOT FOUND"
            local rows=(
                "Environment	${CFG_ENV}"
                "Total Changes	${#folders[@]}"
                "Applied	${applied_count}"
                "Pending	${pending_count}"
                "Danger (manual)	${danger_count}"
                "Registry	${reg_label}"
                "Checksum Policy	${CFG_CHECKSUM_POLICY}"
            )
            print_boxed_table "DMCR Info" "Property|Value" "${rows[@]}"
            ;;

        # ---- PLAN ----
        plan)
            cmd_plan "$json_out"
            ;;

        # ---- CHECK ----
        check)
            local issues=()
            while IFS= read -r issue; do
                [[ -n "$issue" ]] && issues+=("$issue")
            done < <(invoke_enhanced_preflight "$CFG_CHANGES_DIR")

            if [[ $json_out -eq 1 ]]; then
                local ok="true"
                [[ ${#issues[@]} -gt 0 ]] && ok="false"
                printf '{"ok":%s,"issues":[' "$ok"
                local first=1
                for issue in "${issues[@]+"${issues[@]}"}"; do
                    [[ $first -eq 0 ]] && printf ','
                    printf '"%s"' "$(echo "$issue" | sed 's/"/\\"/g')"
                    first=0
                done
                printf ']}\n'
                return 0
            fi

            if [[ ${#issues[@]} -eq 0 ]]; then
                log_done "All preflight checks passed"
            else
                log_warn "Preflight issues found:"
                for issue in "${issues[@]}"; do
                    log_warn "  >> $issue"
                done
            fi
            ;;

        # ---- BASELINE ----
        baseline)
            if [[ -z "$arg1" ]]; then
                log_error "Usage: dmcr baseline <change_id>"
                exit 1
            fi
            local target="$arg1"
            local found=0
            local baselined=()
            local folders=()
            while IFS= read -r f; do [[ -n "$f" ]] && folders+=("$f"); done \
                < <(get_change_folders "$CFG_CHANGES_DIR")
            for f in "${folders[@]+"${folders[@]}"}"; do
                local id
                id="$(basename "$f")"
                if is_applied "$id" 2>/dev/null; then
                    log_skip "$id already applied"
                else
                    local deploy_file="$f/deploy.sql"
                    local chk=""
                    [[ -f "$deploy_file" ]] && chk="$(file_checksum "$deploy_file")"
                    local safe_id safe_chk safe_env safe_actor
                    safe_id="$(escape_sql "$id")"
                    safe_chk="$(escape_sql "$chk")"
                    safe_env="$(escape_sql "$CFG_ENV")"
                    safe_actor="$(escape_sql "$(get_dmcr_actor)")"
                    exec_psql_scalar "INSERT INTO dmcr.change_log(change_id,deploy_checksum,environment,actor) VALUES ('${safe_id}','${safe_chk}','${safe_env}','${safe_actor}') ON CONFLICT (change_id) DO NOTHING;" >/dev/null
                    exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,message,environment,actor) VALUES ('baseline','${safe_id}','success','Baselined without execution','${safe_env}','${safe_actor}');" >/dev/null 2>/dev/null || true
                    log_done "$id baselined"
                    baselined+=("$id")
                fi
                if [[ "$id" == "$target" ]]; then found=1; break; fi
            done
            [[ $found -eq 0 ]] && { log_error "Target change '$target' not found in change folders"; exit 1; }
            if [[ $json_out -eq 1 ]]; then
                printf '{"status":"ok","baselined":[%s]}\n' "$(printf '"%s",' "${baselined[@]+"${baselined[@]}"}" | sed 's/,$//')"
            else
                log_done "Baseline complete — ${#baselined[@]} change(s) marked as applied"
            fi
            ;;

        # ---- REPAIR ----
        repair)
            case "$arg1" in
                --mark-applied)
                    [[ -z "$arg2" ]] && { log_error "Usage: dmcr repair --mark-applied <change_id>"; exit 1; }
                    local id="$arg2"
                    is_applied "$id" 2>/dev/null && { log_error "'$id' is already marked as applied"; exit 1; }
                    local deploy_file="${CFG_CHANGES_DIR}/${id}/deploy.sql"
                    local chk=""
                    [[ -f "$deploy_file" ]] && chk="$(file_checksum "$deploy_file")"
                    local safe_id safe_chk safe_env safe_actor
                    safe_id="$(escape_sql "$id")"
                    safe_chk="$(escape_sql "$chk")"
                    safe_env="$(escape_sql "$CFG_ENV")"
                    safe_actor="$(escape_sql "$(get_dmcr_actor)")"
                    exec_psql_scalar "INSERT INTO dmcr.change_log(change_id,deploy_checksum,environment,actor) VALUES ('${safe_id}','${safe_chk}','${safe_env}','${safe_actor}');" >/dev/null
                    exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,message,environment,actor) VALUES ('repair','${safe_id}','success','Manually marked as applied','${safe_env}','${safe_actor}');" >/dev/null 2>/dev/null || true
                    log_done "'$id' marked as applied"
                    [[ $json_out -eq 1 ]] && printf '{"change_id":"%s","action":"mark-applied","status":"ok"}\n' "$id"
                    ;;
                --mark-reverted)
                    [[ -z "$arg2" ]] && { log_error "Usage: dmcr repair --mark-reverted <change_id>"; exit 1; }
                    local id="$arg2"
                    is_applied "$id" 2>/dev/null || { log_error "'$id' is not currently applied"; exit 1; }
                    local safe_id safe_env safe_actor
                    safe_id="$(escape_sql "$id")"
                    safe_env="$(escape_sql "$CFG_ENV")"
                    safe_actor="$(escape_sql "$(get_dmcr_actor)")"
                    exec_psql_scalar "DELETE FROM dmcr.change_log WHERE change_id = '${safe_id}';" >/dev/null
                    exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,message,environment,actor) VALUES ('repair','${safe_id}','success','Manually marked as reverted','${safe_env}','${safe_actor}');" >/dev/null 2>/dev/null || true
                    log_done "'$id' marked as reverted"
                    [[ $json_out -eq 1 ]] && printf '{"change_id":"%s","action":"mark-reverted","status":"ok"}\n' "$id"
                    ;;
                --checksums)
                    log_info "Reconciling checksums for all applied changes..."
                    local folders=()
                    while IFS= read -r f; do [[ -n "$f" ]] && folders+=("$f"); done \
                        < <(get_change_folders "$CFG_CHANGES_DIR")
                    local repaired=()
                    for f in "${folders[@]+"${folders[@]}"}"; do
                        local id
                        id="$(basename "$f")"
                        is_applied "$id" 2>/dev/null || continue
                        local dchk vchk rchk
                        dchk="$([[ -f "$f/deploy.sql" ]] && file_checksum "$f/deploy.sql" || echo "")"
                        vchk="$([[ -f "$f/verify.sql" ]] && file_checksum "$f/verify.sql" || echo "")"
                        rchk="$([[ -f "$f/revert.sql" ]] && file_checksum "$f/revert.sql" || echo "")"
                        local safe_id
                        safe_id="$(escape_sql "$id")"
                        exec_psql_scalar "UPDATE dmcr.change_log SET deploy_checksum='$(escape_sql "$dchk")', verify_checksum='$(escape_sql "$vchk")', revert_checksum='$(escape_sql "$rchk")' WHERE change_id='${safe_id}';" >/dev/null
                        repaired+=("$id")
                        log_done "$id checksums updated"
                    done
                    if [[ $json_out -eq 1 ]]; then
                        printf '{"action":"checksums","repaired":[%s]}\n' "$(printf '"%s",' "${repaired[@]+"${repaired[@]}"}" | sed 's/,$//')"
                    else
                        log_done "${#repaired[@]} change(s) checksums reconciled"
                    fi
                    ;;
                *)
                    log_error "Unknown repair action: $arg1. Use --mark-applied, --mark-reverted, or --checksums."
                    exit 1
                    ;;
            esac
            ;;

        # ---- REVERT ----
        revertLast|revert-last)
            local last
            last="$(last_applied)"
            if [[ -z "$last" ]]; then log_info "Nothing to revert"; return 0; fi
            log_info "Reverting latest applied change: $last"
            acquire_advisory_lock
            revert_change "$last"
            release_advisory_lock
            ;;

        revert)
            if [[ "$arg1" == "list" ]]; then
                log_info "Listing applied changes"
                exec_psql "SELECT change_id, applied_at FROM dmcr.change_log ORDER BY applied_at DESC, change_id DESC;"
                return 0
            fi
            if [[ "$arg1" == "to" ]]; then
                local revert_target="$arg2"
                [[ -z "$revert_target" ]] && { log_error "Usage: dmcr revert to <change_id|@tag>"; exit 1; }
                if [[ "$revert_target" == @* ]]; then
                    local tag_name="${revert_target:1}"
                    local resolved
                    resolved="$(get_tag_change_id "$tag_name")"
                    [[ -z "$resolved" ]] && { log_error "Tag '@${tag_name}' not found."; exit 1; }
                    log_info "Tag '@${tag_name}' resolves to: $resolved"
                    revert_target="$resolved"
                fi
                log_info "Reverting to target: $revert_target"
                acquire_advisory_lock
                revert_to "$revert_target"
                release_advisory_lock
                return 0
            fi
            [[ -z "$arg1" ]] && { log_error "Usage: dmcr revert <change_id>"; exit 1; }
            log_info "Reverting change: $arg1"
            acquire_advisory_lock
            revert_change "$arg1"
            release_advisory_lock
            ;;

        # ---- TAG ----
        tag)
            if [[ -z "$arg1" || "$arg1" == "list" ]]; then
                if [[ $json_out -eq 1 ]]; then
                    local psql_exe
                    psql_exe="$(get_psql_exe)"
                    local raw
                    raw="$("$psql_exe" "$CFG_CONN" -q -v ON_ERROR_STOP=1 -X -t -A -F '|' \
                        -c "SELECT tag_name, change_id, created_at, description FROM dmcr.tags ORDER BY created_at DESC;" 2>&1)"
                    printf '[\n'
                    local first=1
                    while IFS='|' read -r tn cid cat desc; do
                        [[ -z "$tn" || "$tn" == "SET" ]] && continue
                        [[ $first -eq 0 ]] && printf ','
                        printf '{"tag_name":"%s","change_id":"%s","created_at":"%s","description":"%s"}\n' "$tn" "$cid" "$cat" "$desc"
                        first=0
                    done <<< "$raw"
                    printf ']\n'
                else
                    log_info "Release tags:"
                    exec_psql "SELECT tag_name, change_id, created_at, description FROM dmcr.tags ORDER BY created_at DESC;"
                fi
                return 0
            fi

            if [[ "$arg1" == "create" ]]; then
                [[ -z "$arg2" ]] && { log_error "Usage: dmcr tag create <tag_name> [description]"; exit 1; }
                local tag_name="$arg2"
                echo "$tag_name" | grep -qE '^[a-zA-Z0-9._-]+$' || { log_error "Invalid tag name '$tag_name'. Use letters, digits, dots, dashes, underscores."; exit 1; }
                local description="${positional[3]:-}"
                local last_applied_id
                last_applied_id="$(last_applied)"
                [[ -z "$last_applied_id" ]] && { log_error "Cannot create tag — no changes are currently applied."; exit 1; }
                local existing
                existing="$(get_tag_change_id "$tag_name")"
                [[ -n "$existing" ]] && { log_error "Tag '$tag_name' already exists (points to '$existing'). Delete it first."; exit 1; }
                local safe_tag safe_cid safe_desc
                safe_tag="$(escape_sql "$tag_name")"
                safe_cid="$(escape_sql "$last_applied_id")"
                safe_desc="$([[ -n "$description" ]] && echo "'$(escape_sql "$description")'" || echo "NULL")"
                exec_psql_scalar "INSERT INTO dmcr.tags(tag_name, change_id, description) VALUES ('${safe_tag}', '${safe_cid}', ${safe_desc});" >/dev/null
                if [[ $json_out -eq 1 ]]; then
                    printf '{"tag":"%s","change_id":"%s","status":"created"}\n' "$tag_name" "$last_applied_id"
                else
                    log_done "Tag '$tag_name' created → $last_applied_id"
                fi
                return 0
            fi

            if [[ "$arg1" == "delete" ]]; then
                [[ -z "$arg2" ]] && { log_error "Usage: dmcr tag delete <tag_name>"; exit 1; }
                local tag_name="$arg2"
                local existing
                existing="$(get_tag_change_id "$tag_name")"
                [[ -z "$existing" ]] && { log_error "Tag '$tag_name' does not exist."; exit 1; }
                local safe_tag
                safe_tag="$(escape_sql "$tag_name")"
                exec_psql_scalar "DELETE FROM dmcr.tags WHERE tag_name = '${safe_tag}';" >/dev/null
                [[ $json_out -eq 1 ]] && printf '{"tag":"%s","status":"deleted"}\n' "$tag_name" || log_done "Tag '$tag_name' deleted"
                return 0
            fi

            log_error "Unknown tag action '$arg1'. Use: tag [list|create|delete]"
            exit 1
            ;;

        # ---- REPEATABLE ----
        repeatable)
            log_info "Checking repeatable migrations..."
            local r_folders=()
            while IFS= read -r rf; do [[ -n "$rf" ]] && r_folders+=("$rf"); done \
                < <(get_repeatable_folders "$CFG_CHANGES_DIR" 2>/dev/null || true)

            if [[ ${#r_folders[@]} -eq 0 ]]; then
                log_info "No repeatable migration folders (R__*) found"
                [[ $json_out -eq 1 ]] && printf '{"status":"ok","applied":[]}\n'
                return 0
            fi

            acquire_advisory_lock
            local rresults=()
            for rf in "${r_folders[@]}"; do
                local rid
                rid="$(basename "$rf")"
                local rfile="$rf/deploy.sql"
                if [[ ! -f "$rfile" ]]; then
                    log_warn "$rid — missing deploy.sql, skipping"
                    continue
                fi
                if ! repeatable_needs_run "$rf" 2>/dev/null; then
                    log_skip "$rid — unchanged (checksum matches)"
                    rresults+=("{\"change_id\":\"${rid}\",\"status\":\"unchanged\"}")
                    continue
                fi
                local rt_start=$SECONDS
                local rchk
                rchk="$(file_checksum "$rfile")"
                local ractor
                ractor="$(get_dmcr_actor)"
                log_apply "$rid (repeatable)"
                assert_safe_change "$rid" "$rf" "deploy" || continue
                if exec_psql_file_tx "$rfile" ""; then
                    local safe_rid safe_rchk safe_renv safe_ractor
                    safe_rid="$(escape_sql "$rid")"
                    safe_rchk="$(escape_sql "$rchk")"
                    safe_renv="$(escape_sql "$CFG_ENV")"
                    safe_ractor="$(escape_sql "$ractor")"
                    exec_psql_scalar "INSERT INTO dmcr.repeatable_log(change_id,last_checksum,applied_at,environment,actor) VALUES ('${safe_rid}','${safe_rchk}',now(),'${safe_renv}','${safe_ractor}') ON CONFLICT (change_id) DO UPDATE SET last_checksum=EXCLUDED.last_checksum,applied_at=EXCLUDED.applied_at,environment=EXCLUDED.environment,actor=EXCLUDED.actor;" >/dev/null
                    local relapsed=$(( SECONDS - rt_start ))
                    [[ -f "$rf/verify.sql" ]] && { log_verify "$rid"; exec_psql_file_tx_rollback "$rf/verify.sql" || true; }
                    rresults+=("{\"change_id\":\"${rid}\",\"status\":\"applied\",\"duration_s\":${relapsed}}")
                    log_done "$rid applied (${relapsed}s)"
                else
                    local relapsed=$(( SECONDS - rt_start ))
                    log_error "Repeatable $rid failed"
                    rresults+=("{\"change_id\":\"${rid}\",\"status\":\"failed\"}")
                fi
            done
            release_advisory_lock
            [[ $json_out -eq 1 ]] && printf '{"status":"ok","applied":[%s]}\n' "$(IFS=,; echo "${rresults[*]+"${rresults[*]}"}")"
            ;;

        *)
            show_help
            ;;
    esac
}

# =============================================================================
# ENTRY POINT
# =============================================================================
main "$@"
