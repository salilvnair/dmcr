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

# Global JSON mode flag — when 1, log functions redirect to stderr to keep stdout clean JSON
_JSON_MODE=0

# =============================================================================
# ANSI COLORS
# =============================================================================
_ansi_enabled() {
    [[ "${DMCR_ANSI_OUTPUT:-1}" != "0" ]] && [[ -t 1 || "${DMCR_ANSI_OUTPUT:-1}" == "1" ]]
}

log_info()   { [[ "$_JSON_MODE" == "1" ]] && { printf "  ›  %s\n" "$*" >&2; return; }; _ansi_enabled && printf "  \033[36m›\033[0m  %s\n"           "$*" || printf "  ›  %s\n" "$*"; }
log_init()   { [[ "$_JSON_MODE" == "1" ]] && { printf "  ◆  %s\n" "$*" >&2; return; }; _ansi_enabled && printf "  \033[93m◆\033[0m  %s\n"           "$*" || printf "  ◆  %s\n" "$*"; }
log_apply()  { [[ "$_JSON_MODE" == "1" ]] && { printf "  ●  %s\n" "$*" >&2; return; }; _ansi_enabled && printf "  \033[92m●\033[0m  \033[97m%s\033[0m\n" "$*" || printf "  ●  %s\n" "$*"; }
log_verify() { [[ "$_JSON_MODE" == "1" ]] && { printf "  ◌  %s\n" "$*" >&2; return; }; _ansi_enabled && printf "  \033[95m◌\033[0m  %s\n"           "$*" || printf "  ◌  %s\n" "$*"; }
log_revert() { [[ "$_JSON_MODE" == "1" ]] && { printf "  ↺  %s\n" "$*" >&2; return; }; _ansi_enabled && printf "  \033[91m↺\033[0m  %s\n"           "$*" || printf "  ↺  %s\n" "$*"; }
log_skip()   { [[ "$_JSON_MODE" == "1" ]] && { printf "  ○  %s\n" "$*" >&2; return; }; _ansi_enabled && printf "  \033[90m○\033[0m  \033[90m%s\033[0m\n" "$*" || printf "  ○  %s\n" "$*"; }
log_done()   { [[ "$_JSON_MODE" == "1" ]] && { printf "  ✓  %s\n" "$*" >&2; return; }; _ansi_enabled && printf "  \033[92m✓\033[0m  \033[92m%s\033[0m\n" "$*" || printf "  ✓  %s\n" "$*"; }
log_warn()   { [[ "$_JSON_MODE" == "1" ]] && { printf "  ▲  %s\n" "$*" >&2; return; }; _ansi_enabled && printf "  \033[93m▲\033[0m  \033[93m%s\033[0m\n" "$*" || printf "  ▲  %s\n" "$*"; }
log_error()  { _ansi_enabled && printf "  \033[91m✗\033[0m  \033[91m%s\033[0m\n" "$*" >&2    || printf "  ✗  %s\n" "$*" >&2; }
log_debug()  { [[ "${DMCR_DEBUG:-0}" == "1" ]] && { _ansi_enabled && printf "  \033[90m·\033[0m  \033[90m%s\033[0m\n" "$*" || printf "  ·  %s\n" "$*"; } || true; }

# =============================================================================
# TEMP FILE TRACKING & CLEANUP
# =============================================================================
DMCR_TMPFILES=()

dmcr_mktemp() {
    local prefix="${1:-dmcr_tx_}"
    local f
    f="$(mktemp "/tmp/${prefix}XXXXXX")"
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
    # A failing command exits through this trap; don't leave the dmcr.deploy_lock row behind.
    if [[ -n "${DMCR_DB_LOCK_HOLDER:-}" ]]; then
        release_advisory_lock >/dev/null 2>&1 || true
    fi
    if [[ -n "$DMCR_LOCK_FD" ]]; then
        eval "exec ${DMCR_LOCK_FD}>&-" 2>/dev/null || true
        DMCR_LOCK_FD=""
    fi
}

# What the registry holds (see registry_cache_load), kept in a file so subshells share it
DMCR_REG_CACHE="/tmp/dmcr_reg_$$"

dmcr_cleanup() {
    cleanup_lock
    cleanup_tmpfiles
    rm -f "$DMCR_REG_CACHE" "${DMCR_REG_CACHE}.held" 2>/dev/null || true
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
    find "$tmp_dir" -maxdepth 1 \( -name "dmcr_tx_*" -o -name "dmcr_verify_*" -o -name "dmcr_parse_*" \) \
        -mmin +"$cutoff_mins" -delete 2>/dev/null || true
    # Stale lock files — only ones no running process holds
    local lock_dir="/tmp/dmcr_locks" lf
    if [[ -d "$lock_dir" ]]; then
        while IFS= read -r lf; do
            [[ -n "$lf" ]] || continue
            if command -v flock >/dev/null 2>&1; then
                flock -n "$lf" true 2>/dev/null && rm -f "$lf" 2>/dev/null || true
            else
                rm -f "$lf" 2>/dev/null || true
            fi
        done < <(find "$lock_dir" -maxdepth 1 -name "dmcr_*.lock" -mmin +"$cutoff_mins" 2>/dev/null)
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

# Move the password out of CFG_CONN into PGPASSWORD so it never appears in psql's
# command line (process arguments are visible to every user on the machine).
split_conn_password() {
    local re='^([A-Za-z][A-Za-z0-9+.-]*://[^:/@[:space:]]+):([^@[:space:]]*)@(.*)$'
    if [[ "$CFG_CONN" =~ $re ]]; then
        local pw="${BASH_REMATCH[2]}"
        CFG_CONN="${BASH_REMATCH[1]}@${BASH_REMATCH[3]}"
        PGPASSWORD="$(printf '%s' "$pw" | perl -pe 's/%([0-9A-Fa-f]{2})/chr(hex($1))/ge')"
        export PGPASSWORD
        return 0
    fi
    local split
    split="$(perl -e '
        my $c = shift;
        if ($c =~ /(^|\s)password\s*=\s*(\x27(?:[^\x27\\]|\\.)*\x27|\S+)/i) {
            my $p = $2;
            substr($c, $-[0], $+[0] - $-[0]) = "";
            if ($p =~ /^\x27/) { $p = substr($p, 1, -1); $p =~ s/\\(.)/$1/g; }
            $c =~ s/^\s+|\s+$//g;
            print "$p\n$c";
        }' "$CFG_CONN")"
    if [[ -n "$split" ]]; then
        PGPASSWORD="${split%%$'\n'*}"
        CFG_CONN="${split#*$'\n'}"
        export PGPASSWORD
    fi
}

load_config() {
    local config_path="$1"
    CFG_CONFIG_PATH="$config_path"

    ini_parse "$config_path"

    if ! ini_has_section "dmcr"; then
        log_error "Missing [dmcr] section in config: $config_path"
        exit 1
    fi

    # [dmcr] env, else the first name in [envs] names
    local first_env
    first_env="$(ini_get "envs" "names" "" | cut -d, -f1 | tr -d ' ')"
    CFG_ENV="$(ini_get "dmcr" "env" "${first_env:-dev}")"

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
    split_conn_password

    # changes_dir — resolve relative paths against config file directory
    local raw_changes_dir
    raw_changes_dir="$(ini_get "dmcr" "changes_dir" "")"
    if [[ -n "$raw_changes_dir" && "$raw_changes_dir" != /* ]]; then
        # Relative paths resolve against DMCR_BASE_DIR (workspace root, set by the extension),
        # otherwise against the config file's folder.
        local config_dir
        config_dir="${DMCR_BASE_DIR:-$(dirname "$config_path")}"
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
    # key=value style: password=xxx (use , as delimiter to avoid conflict with | in alternation)
    s="$(echo "$s" | sed -E 's,(password|pwd)=([^;& ]+),\1=****,gi')"
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

# The checksums of many files, one per line in the same order: one shasum / sha256sum run for all of them
# (one run per file is thousands of processes at 1,000 changes).
file_checksums() {
    [[ $# -gt 0 ]] || return 0
    if command -v shasum >/dev/null 2>&1; then
        printf '%s\0' "$@" | xargs -0 shasum -a 256 | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then
        printf '%s\0' "$@" | xargs -0 sha256sum | awk '{ sub(/^\\/, "", $1); print $1 }'
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

# Deployment ids: every deploy / revert run gets one, like a git commit id (40 hex, shown as 7).
# It is written on the change_log rows the run applies and on every event it records.
DMCR_DEPLOY_ID="" DMCR_DID_SQL="NULL"
new_deployment_id() {
    DMCR_DEPLOY_ID="$(string_checksum "${CFG_ENV:-}|$(get_dmcr_actor 2>/dev/null)|$(date +%s%N 2>/dev/null || date +%s)|$$|${RANDOM}${RANDOM}${RANDOM}|${CFG_CHANGES_DIR:-}" | cut -c1-40)"
    DMCR_DID_SQL="'${DMCR_DEPLOY_ID}'"
}
short_did() { printf '%s' "${1:0:7}"; }

# A deployment id or a unique prefix of one (4+ hex characters) -> the full id, else exits
resolve_deployment_id() {
    local p="${1,,}" ids
    if [[ ! "$p" =~ ^[0-9a-f]{4,40}$ ]]; then log_error "'$1' is not a deployment id (4 to 40 hex characters, e.g. 3f9a1c2)"; exit 1; fi
    ids="$(exec_psql_scalar "SELECT coalesce(string_agg(DISTINCT deploy_id, ','), '') FROM dmcr.event_log WHERE deploy_id LIKE '${p}%';")" || exit 1
    if [[ -z "$ids" ]]; then log_error "No deployment '$1' in $CFG_ENV. List them with: dmcr deployments"; exit 1; fi
    if [[ "$ids" == *,* ]]; then log_error "Deployment id '$1' is ambiguous: $(for i in ${ids//,/ }; do printf '%s ' "$(short_did "$i")"; done)- give more characters"; exit 1; fi
    printf '%s' "$ids"
}

# ── git-style views: diff / show ──────────────────────────────────────────────
# Colours like git: red for what only the left side has, green for the right, yellow for changed
_gc() { if _ansi_enabled; then printf '\033[%sm%s\033[0m' "$1" "$2"; else printf '%s' "$2"; fi; }

# An environment's registry, one change per line: id|deploy|verify|revert checksum|applied_at|deploy_id
# (deploy_id read through to_jsonb, so an older registry without the column reads too)
env_registry_rows() {
    local e="$1" c
    local sql="SELECT coalesce(string_agg(concat_ws('|', c.change_id, coalesce(c.deploy_checksum, ''), coalesce(c.verify_checksum, ''), coalesce(c.revert_checksum, ''), to_char(c.applied_at, 'YYYY-MM-DD HH24:MI'), coalesce(to_jsonb(c) ->> 'deploy_id', ''), coalesce(c.git_commit, '')), E'\x1e' ORDER BY c.change_id), '') FROM dmcr.change_log c;"
    # rows joined by \x1e (exec_psql_scalar keeps one line), split back into lines here
    if [[ "$e" == "$CFG_ENV" ]]; then exec_psql_scalar "$sql" | tr '\036' '\n'; return "${PIPESTATUS[0]}"; fi
    c="$(ini_get "$e" "conn" "")"
    if [[ -z "$c" ]]; then log_error "No connection for environment '$e' ([$e] conn in dmcr.cfg)"; return 1; fi
    # Subshell: the other connection and its password never replace this one
    ( CFG_CONN="$c"; split_conn_password; exec_psql_scalar "$sql" | tr '\036' '\n'; exit "${PIPESTATUS[0]}" )
}
is_env_name() { [[ "$1" == "$CFG_ENV" || -n "$(ini_get "$1" "conn" "")" ]]; }

# dmcr diff                  this environment vs the change files (like git diff): not applied yet,
#                            edited since applied, applied but missing here
# dmcr diff <env> [<env>]    two environments' registries (like git diff a b): only on one, applied with different files
# dmcr diff <change_id>      that change's files since the commit it was applied from (git diff <commit> -- <id>)
cmd_diff() {
    local json_out="$1" a="$2" b="$3"
    if [[ -n "$a" && ! -d "$CFG_CHANGES_DIR/$a" ]] && is_env_name "$a"; then
        local left right
        if [[ -n "$b" ]]; then left="$a"; right="$b"; else left="$CFG_ENV"; right="$a"; fi
        is_env_name "$right" || { log_error "Unknown environment '$right'. Environments are the sections of dmcr.cfg with a conn"; exit 1; }
        local lrows rrows
        lrows="$(env_registry_rows "$left")" || exit 1
        rrows="$(env_registry_rows "$right")" || exit 1
        declare -A L=() Rr=()
        local line id
        while IFS= read -r line; do [[ -n "$line" ]] && L["${line%%|*}"]="$line"; done <<< "$lrows"
        while IFS= read -r line; do [[ -n "$line" ]] && Rr["${line%%|*}"]="$line"; done <<< "$rrows"
        local ids=() only_l=() only_r=() differ=() same=0
        while IFS= read -r id; do [[ -n "$id" ]] && ids+=("$id"); done < <(printf '%s\n' "${!L[@]}" "${!Rr[@]}" | sort -u | sort_change_ids)
        local lf rf names k files
        for id in "${ids[@]+"${ids[@]}"}"; do
            if [[ -z "${Rr[$id]+x}" ]]; then only_l+=("$id"); continue; fi
            if [[ -z "${L[$id]+x}" ]]; then only_r+=("$id"); continue; fi
            IFS='|' read -r -a lf <<< "${L[$id]}"; IFS='|' read -r -a rf <<< "${Rr[$id]}"
            files=""; names=(deploy verify revert)
            for k in 0 1 2; do [[ -n "${lf[$((k+1))]:-}" && -n "${rf[$((k+1))]:-}" && "${lf[$((k+1))]}" != "${rf[$((k+1))]}" ]] && files+="${files:+,}${names[$k]}.sql"; done
            if [[ -n "$files" ]]; then differ+=("$id:$files"); else same=$((same+1)); fi
        done
        if [[ "$json_out" == "1" ]]; then
            local jl="" jr="" jd="" x
            for x in "${only_l[@]+"${only_l[@]}"}"; do jl+="${jl:+,}$(printf '{"change_id":%s,"applied_at":%s}' "$(json_s "$x")" "$(json_s "$(cut -d'|' -f5 <<< "${L[$x]}")")")"; done
            for x in "${only_r[@]+"${only_r[@]}"}"; do jr+="${jr:+,}$(printf '{"change_id":%s,"applied_at":%s}' "$(json_s "$x")" "$(json_s "$(cut -d'|' -f5 <<< "${Rr[$x]}")")")"; done
            for x in "${differ[@]+"${differ[@]}"}"; do
                local fj="" ff; for ff in ${x#*:}; do :; done
                for ff in ${x#*:}; do :; done
                fj="$(printf '%s' "${x#*:}" | sed 's/[^,]*/"&"/g')"
                jd+="${jd:+,}$(printf '{"change_id":%s,"files":[%s]}' "$(json_s "${x%%:*}")" "$fj")"
            done
            printf '{"mode":"envs","left":%s,"right":%s,"only_left":[%s],"only_right":[%s],"differ":[%s],"same":%s}\n' "$(json_s "$left")" "$(json_s "$right")" "$jl" "$jr" "$jd" "$same"
            return 0
        fi
        printf '%s\n' "$(_gc 1 "diff $left..$right")"
        printf '%s\n%s\n' "$(_gc 31 "--- $left")" "$(_gc 32 "+++ $right")"
        for x in "${only_l[@]+"${only_l[@]}"}"; do printf '%s  %s\n' "$(_gc 31 "- $(printf '%-44s' "$x")")" "$(_gc 90 "only on $left (applied $(cut -d'|' -f5 <<< "${L[$x]}"))")"; done
        for x in "${only_r[@]+"${only_r[@]}"}"; do printf '%s  %s\n' "$(_gc 32 "+ $(printf '%-44s' "$x")")" "$(_gc 90 "only on $right (applied $(cut -d'|' -f5 <<< "${Rr[$x]}"))")"; done
        for x in "${differ[@]+"${differ[@]}"}"; do printf '%s  %s\n' "$(_gc 33 "~ $(printf '%-44s' "${x%%:*}")")" "$(_gc 90 "applied on both, with different ${x#*:}")"; done
        printf '%s\n' "$(_gc 90 "  ${same} change(s) identical on both · ${#only_l[@]} only on $left · ${#only_r[@]} only on $right · ${#differ[@]} different")"
        return 0
    fi
    if [[ -n "$a" ]]; then
        # one change: its files since the commit it was applied from
        [[ -d "$CFG_CHANGES_DIR/$a" ]] || { log_error "No change folder '$a' and no environment '$a' in dmcr.cfg"; exit 1; }
        local row gc applied=0 edited=""
        row="$(exec_psql_scalar "SELECT concat_ws('|', change_id, coalesce(deploy_checksum, ''), coalesce(verify_checksum, ''), coalesce(revert_checksum, ''), to_char(applied_at, 'YYYY-MM-DD HH24:MI'), coalesce(git_commit, '')) FROM dmcr.change_log WHERE change_id = '$(escape_sql "$a")';")" || exit 1
        local rf=(); [[ -n "$row" ]] && { applied=1; IFS='|' read -r -a rf <<< "$row"; }
        gc="${rf[5]:-}"
        if [[ $applied -eq 1 ]]; then
            local n k=1; for n in deploy verify revert; do
                [[ -n "${rf[$k]:-}" && -f "$CFG_CHANGES_DIR/$a/$n.sql" && "$(file_checksum "$CFG_CHANGES_DIR/$a/$n.sql")" != "${rf[$k]}" ]] && edited+="${edited:+,}$n.sql"
                k=$((k+1)); done
        fi
        local patch="" note
        if [[ $applied -eq 0 ]]; then note="not applied on $CFG_ENV: the whole change is new there"
        elif [[ -z "$edited" ]]; then note="unchanged since it was applied on $CFG_ENV (${rf[4]})"
        elif [[ -z "$gc" ]] || ! git -C "$CFG_CHANGES_DIR" rev-parse --verify -q "$gc^{commit}" >/dev/null 2>&1; then note="edited since applied on $CFG_ENV ($edited), but the commit it was applied from is not recorded or not in this repository"
        else
            note="edited since applied on $CFG_ENV ($edited): the lines since commit $gc"
            patch="$(git -C "$CFG_CHANGES_DIR" diff $([[ "$json_out" != "1" ]] && _ansi_enabled && echo --color=always || echo --no-color) "$gc" -- "$a" 2>/dev/null)"
        fi
        if [[ "$json_out" == "1" ]]; then
            printf '{"mode":"change","change_id":%s,"environment":%s,"applied":%s,"applied_at":%s,"git_commit":%s,"edited":[%s],"note":%s,"patch":%s}\n' \
                "$(json_s "$a")" "$(json_s "$CFG_ENV")" "$([[ $applied -eq 1 ]] && echo true || echo false)" "$(json_s "${rf[4]:-}")" "$(json_s "$gc")" \
                "$(printf '%s' "$edited" | sed 's/[^,][^,]*/"&"/g')" "$(json_s "$note")" "$(json_s "$patch")"
            return 0
        fi
        printf '%s\n' "$(_gc 1 "diff $a ($CFG_ENV)")"
        printf '%s\n' "$(_gc 90 "$note")"
        [[ -n "$patch" ]] && printf '\n%s\n' "$patch"
        return 0
    fi
    # this environment vs the change files
    load_change_infos
    local rows; rows="$(env_registry_rows "$CFG_ENV")" || exit 1
    declare -A A=()
    local line; while IFS= read -r line; do [[ -n "$line" ]] && A["${line%%|*}"]="$line"; done <<< "$rows"
    local pending=() dropped=() missing=() edited=() f id d
    while IFS= read -r f; do
        [[ -n "$f" ]] || continue; id="${f##*/}"
        [[ -n "${A[$id]+x}" ]] && continue
        if [[ "${CI_DROPPED[$id]:-0}" == "1" ]]; then dropped+=("$id"); else pending+=("$id"); fi
    done < <(get_change_folders "$CFG_CHANGES_DIR")
    for id in $(printf '%s\n' "${!A[@]}" | sort_change_ids); do [[ -d "$CFG_CHANGES_DIR/$id" ]] || missing+=("$id"); done
    declare -A E=()
    while IFS= read -r d; do [[ -n "$d" ]] && E["${d%% *}"]+="${E[${d%% *}]:+,}${d#* }"; done < <(list_drifted_changes)
    for id in $(printf '%s\n' "${!E[@]}" | sort_change_ids); do edited+=("$id:${E[$id]}"); done
    if [[ "$json_out" == "1" ]]; then
        local jp="" jd="" jm="" je="" x
        for x in "${pending[@]+"${pending[@]}"}"; do jp+="${jp:+,}$(printf '{"change_id":%s,"project":%s,"release":%s,"kind":%s}' "$(json_s "$x")" "$(json_s "${CI_PROJECT[$x]:-}")" "$(json_s "${CI_RELEASE[$x]:-}")" "$(json_s "${CI_KIND[$x]:-}")")"; done
        for x in "${dropped[@]+"${dropped[@]}"}"; do jd+="${jd:+,}$(json_s "$x")"; done
        for x in "${missing[@]+"${missing[@]}"}"; do jm+="${jm:+,}$(json_s "$x")"; done
        for x in "${edited[@]+"${edited[@]}"}"; do je+="${je:+,}$(printf '{"change_id":%s,"files":[%s]}' "$(json_s "${x%%:*}")" "$(printf '%s' "${x#*:}" | sed 's/[^,][^,]*/"&"/g')")"; done
        printf '{"mode":"work","environment":%s,"applied":%s,"pending":[%s],"edited":[%s],"missing":[%s],"not_going":[%s]}\n' "$(json_s "$CFG_ENV")" "${#A[@]}" "$jp" "$je" "$jm" "$jd"
        return 0
    fi
    printf '%s\n' "$(_gc 1 "diff $CFG_ENV..files")  $(_gc 90 "($CFG_CHANGES_DIR)")"
    printf '%s\n%s\n' "$(_gc 31 "--- $CFG_ENV (applied)")" "$(_gc 32 "+++ change files")"
    for x in "${pending[@]+"${pending[@]}"}"; do printf '%s  %s\n' "$(_gc 32 "+ $(printf '%-44s' "$x")")" "$(_gc 90 "not applied on $CFG_ENV yet${CI_PROJECT[$x]:+ · project ${CI_PROJECT[$x]}}${CI_KIND[$x]:+ · ${CI_KIND[$x]}}")"; done
    for x in "${edited[@]+"${edited[@]}"}"; do printf '%s  %s\n' "$(_gc 33 "~ $(printf '%-44s' "${x%%:*}")")" "$(_gc 90 "edited since applied: ${x#*:} (dmcr diff ${x%%:*} shows the lines)")"; done
    for x in "${missing[@]+"${missing[@]}"}"; do printf '%s  %s\n' "$(_gc 31 "- $(printf '%-44s' "$x")")" "$(_gc 90 "applied on $CFG_ENV, but its folder is not in the change files")"; done
    for x in "${dropped[@]+"${dropped[@]}"}"; do printf '%s  %s\n' "$(_gc 90 "  $(printf '%-44s' "$x")")" "$(_gc 90 "not going (skipped by deploys)")"; done
    if [[ ${#pending[@]} -eq 0 && ${#edited[@]} -eq 0 && ${#missing[@]} -eq 0 ]]; then printf '%s\n' "$(_gc 32 "  nothing to deploy: $CFG_ENV matches the change files (${#A[@]} applied)")"
    else printf '%s\n' "$(_gc 90 "  ${#A[@]} applied · ${#pending[@]} not applied · ${#edited[@]} edited · ${#missing[@]} missing")"; fi
}

# dmcr show <change_id>: the change (like git show <commit>): who and what, its state here, then deploy.sql
cmd_show_change() {
    local json_out="$1" id="$2"
    load_change_infos
    local row rf=()
    row="$(exec_psql_scalar "SELECT concat_ws('|', to_char(c.applied_at, 'YYYY-MM-DD HH24:MI'), coalesce(c.actor, c.applied_by, ''), coalesce(to_jsonb(c) ->> 'deploy_id', ''), coalesce(c.git_commit, '')) FROM dmcr.change_log c WHERE c.change_id = '$(escape_sql "$id")';")" || exit 1
    [[ -n "$row" ]] && IFS='|' read -r -a rf <<< "$row"
    local state="pending"; [[ -n "$row" ]] && state="applied"; [[ -z "$row" && "${CI_DROPPED[$id]:-0}" == "1" ]] && state="not going"
    local dep="" ver="" rev=""
    [[ -f "$CFG_CHANGES_DIR/$id/deploy.sql" ]] && dep="$(cat "$CFG_CHANGES_DIR/$id/deploy.sql")"
    [[ -f "$CFG_CHANGES_DIR/$id/verify.sql" ]] && ver="$(cat "$CFG_CHANGES_DIR/$id/verify.sql")"
    [[ -f "$CFG_CHANGES_DIR/$id/revert.sql" ]] && rev="$(cat "$CFG_CHANGES_DIR/$id/revert.sql")"
    if [[ "$json_out" == "1" ]]; then
        printf '{"change_id":%s,"environment":%s,"state":%s,"project":%s,"project_type":%s,"release":%s,"kind":%s,"requested_by":%s,"created_by":%s,"ticket":%s,"requires":%s,"applied_at":%s,"applied_by":%s,"deploy_id":%s,"git_commit":%s,"deploy_sql":%s,"verify_sql":%s,"revert_sql":%s}\n' \
            "$(json_s "$id")" "$(json_s "$CFG_ENV")" "$(json_s "$state")" "$(json_s "${CI_PROJECT[$id]:-}")" "$(json_s "${CI_PTYPE[$id]:-}")" "$(json_s "${CI_RELEASE[$id]:-}")" "$(json_s "${CI_KIND[$id]:-}")" \
            "$(json_s "${CI_REQ_BY[$id]:-}")" "$(json_s "${CI_CREATED_BY[$id]:-}")" "$(json_s "${CI_TICKET[$id]:-}")" "$(json_s "${CI_REQUIRES[$id]:-}")" \
            "$(json_s "${rf[0]:-}")" "$(json_s "${rf[1]:-}")" "$(json_s "${rf[2]:-}")" "$(json_s "${rf[3]:-}")" "$(json_s "$dep")" "$(json_s "$ver")" "$(json_s "$rev")"
        return 0
    fi
    printf '%s\n' "$(_gc 33 "change $id")"
    printf 'Project:  %s%s\n' "${CI_PROJECT[$id]:--}" "${CI_PTYPE[$id]:+ (${CI_PTYPE[$id]})}"
    printf 'Release:  %s\nKind:     %s\n' "${CI_RELEASE[$id]:--}" "${CI_KIND[$id]:--}"
    printf 'Asked by: %s\nBuilt by: %s\n' "${CI_REQ_BY[$id]:--}" "${CI_CREATED_BY[$id]:--}"
    [[ -n "${CI_TICKET[$id]:-}" ]] && printf 'Ticket:   %s\n' "${CI_TICKET[$id]}"
    if [[ "$state" == "applied" ]]; then printf 'On %s:  applied %s by %s%s%s\n' "$CFG_ENV" "${rf[0]}" "${rf[1]}" "${rf[2]:+ in deployment $(short_did "${rf[2]}")}" "${rf[3]:+ (commit ${rf[3]})}"
    else printf 'On %s:  %s\n' "$CFG_ENV" "$state"; fi
    printf '\n%s\n' "$(_gc 36 "deploy.sql")"
    printf '%s\n' "$dep" | sed 's/^/    /'
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
    # Any other psql call may write the registry, so the applied-state cache is read again after it
    [[ -n "${DMCR_KEEP_REG_CACHE:-}" ]] || rm -f "$DMCR_REG_CACHE" 2>/dev/null || true
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
    # Strip blank lines and "SET" lines. `|| true`: grep exits 1 when nothing is left
    # (e.g. DELETE/INSERT with no output), which pipefail would turn into a failure.
    local result
    result="$(printf '%s\n' "$out" | { grep -v -e '^$' -e '^SET$' || true; } | tail -1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
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

# Run a .sql file WITHOUT a transaction: each statement commits on its own (psql autocommit).
# Only for changes that opt in with meta.json "transaction": false.
exec_psql_file_notx() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        log_error "Missing file: $file"
        return 1
    fi
    local tmp
    tmp="$(dmcr_mktemp "dmcr_notx_")"
    local file_content
    file_content="$(cat "$file")"
    if [[ ${#CFG_PLACEHOLDERS[@]} -gt 0 ]]; then
        file_content="$(resolve_placeholders "$file_content")"
    fi
    cat > "$tmp" <<SQLNOTX
SET lock_timeout = '${CFG_LOCK_TIMEOUT}';
SET statement_timeout = '${CFG_STMT_TIMEOUT}';
${file_content}
SQLNOTX
    log_debug "PSQL file (no transaction): $file (wrapper: $tmp)"
    local psql_exe
    psql_exe="$(get_psql_exe)"
    local out exit_code=0
    out="$("$psql_exe" "$CFG_CONN" -q -v ON_ERROR_STOP=1 -X -f "$tmp" 2>&1)" || exit_code=$?
    rm -f "$tmp" 2>/dev/null || true
    if [[ $exit_code -ne 0 ]]; then
        local err_detail
        err_detail="$(echo "$out" | grep -E '(ERROR|FATAL|PANIC):' | head -1 || echo "$out")"
        log_error "psql failed for: $file — $err_detail"
        return 1
    fi
    return 0
}

# Run only SQL text in a transaction (registry row + verify for a non-transactional change)
exec_psql_sql_tx() {
    local sql="$1"
    local tmp
    tmp="$(dmcr_mktemp "dmcr_reg_")"
    printf -- '-- DMCR registry update\n' > "$tmp"
    local rc=0
    exec_psql_file_tx "$tmp" "$sql" || rc=1
    rm -f "$tmp" 2>/dev/null || true
    return $rc
}

# Applied changes whose deploy.sql, verify.sql or revert.sql no longer match the checksums
# recorded at deploy time. Prints "<id> <file>" per edited file. Silent if the registry
# can't be read. (A stored checksum that is empty — older rows — is not compared.)
list_drifted_changes() {
    local rows
    rows="$(exec_psql_scalar "SELECT string_agg(change_id || ':' || coalesce(deploy_checksum, '') || ':' || coalesce(verify_checksum, '') || ':' || coalesce(revert_checksum, ''), ' ' ORDER BY change_id) FROM dmcr.change_log;" 2>/dev/null || echo "")"
    local row id rest d v r name chk f
    local files=() expect=()
    for row in $rows; do
        id="${row%%:*}"; rest="${row#*:}"
        d="${rest%%:*}"; rest="${rest#*:}"
        v="${rest%%:*}"; r="${rest#*:}"
        [[ -n "$id" ]] || continue
        for name in deploy verify revert; do
            case "$name" in deploy) chk="$d" ;; verify) chk="$v" ;; revert) chk="$r" ;; esac
            [[ -n "$chk" ]] || continue
            f="${CFG_CHANGES_DIR}/${id}/${name}.sql"
            [[ -f "$f" ]] || continue
            files+=("$f"); expect+=("$chk|$id ${name}.sql")
        done
    done
    # every file hashed in one run, compared in order
    local i=0 sum
    while IFS= read -r sum; do
        [[ "$sum" == "${expect[$i]%%|*}" ]] || echo "${expect[$i]#*|}"
        i=$((i + 1))
    done < <(file_checksums "${files[@]+"${files[@]}"}")
}

# checksum_policy=repair: accept the edited files of one applied change and log it.
accept_change_checksums() {
    local id="$1" files="$2" f sid
    f="${CFG_CHANGES_DIR}/${id}"
    sid="$(escape_sql "$id")"
    exec_psql_scalar "UPDATE dmcr.change_log SET deploy_checksum = '$(escape_sql "$([[ -f "$f/deploy.sql" ]] && file_checksum "$f/deploy.sql")")', verify_checksum = '$(escape_sql "$([[ -f "$f/verify.sql" ]] && file_checksum "$f/verify.sql")")', revert_checksum = '$(escape_sql "$([[ -f "$f/revert.sql" ]] && file_checksum "$f/revert.sql")")' WHERE change_id = '${sid}';" >/dev/null
    exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,message,environment,actor) VALUES ('repair','${sid}','success','$(escape_sql "Accepted edited ${files} (checksum_policy=repair)")','$(escape_sql "$CFG_ENV")','$(escape_sql "$(get_dmcr_actor)")');" >/dev/null 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# ROUND-TRIP TEST (dmcr test)
# Every pending change, in order, inside ONE transaction that always ends in ROLLBACK:
# deploy → verify (applied) → revert → verify (reverted) → schema and data must match the
# state before deploy → deploy again so the next change builds on it. Nothing is kept.
# ---------------------------------------------------------------------------
_rt_remove_concurrently() {  # stdin → stdout, CONCURRENTLY dropped from index builds/drops/reindex
    perl -0777 -pe 's/\b(CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|REINDEX\s+(?:\(\s*[^)]*\)\s*)?(?:INDEX|TABLE|SCHEMA|DATABASE|SYSTEM))\s+CONCURRENTLY\b/$1/gi'
}

_rt_file_sql() {  # file content with placeholders resolved
    local c
    c="$(cat "$1")"
    if [[ ${#CFG_PLACEHOLDERS[@]} -gt 0 ]]; then c="$(resolve_placeholders "$c")"; fi
    printf '%s' "$c"
}

# Args: stop_at_id json_out. Prints results; returns 0 if every tested change passed.
# only_ids (comma-separated): round-trip only these; every other pending change up to stop_at_id is
# deployed as setup (deploy + registry record, no checks), so the changes it builds on are there.
run_roundtrip_test() {
    local stop_at_id="$1" json_out="$2" only_ids="${3:-}"
    local helpers="${SCRIPT_DIR}/dmcr_roundtrip.sql"
    [[ -f "$helpers" ]] || { log_error "Missing $helpers"; return 1; }

    local folders=() tested=() no_tx_tested=() stopped_reason="" stopped_id=""
    local planned=() setup_ids=" " only=" "
    [[ -n "$only_ids" ]] && only=" $(printf '%s' "$only_ids" | tr ',' ' ' | xargs) "
    while IFS= read -r f; do [[ -n "$f" ]] && folders+=("$f"); done < <(get_change_folders "$CFG_CHANGES_DIR")

    local tmp
    tmp="$(dmcr_mktemp "dmcr_rt_")"
    {
        printf 'BEGIN;\nSET LOCAL lock_timeout = %s;\nSET LOCAL statement_timeout = %s;\n' "'${CFG_LOCK_TIMEOUT}'" "'${CFG_STMT_TIMEOUT}'"
        cat "$helpers"
        printf '\n'
    } > "$tmp"

    local f id
    for f in "${folders[@]+"${folders[@]}"}"; do
        id="${f##*/}"
        is_applied "$id" 2>/dev/null && continue
        if echo "$id" | grep -qiE '(^|_)danger_'; then stopped_id="$id"; stopped_reason="manual-only (danger_) change — later changes were not tested"; break; fi
        # "transaction": false — CREATE/DROP INDEX CONCURRENTLY and REINDEX CONCURRENTLY end in the
        # same state as their plain forms, which are transactional: test those inside the rolled-
        # back transaction without CONCURRENTLY. Anything else non-transactional stops the test.
        local no_tx=0
        if read_meta_no_tx "$f"; then
            no_tx=1
            if strip_sql_comments "$(_rt_file_sql "$f/deploy.sql")"$'\n'"$(_rt_file_sql "$f/revert.sql")" | _rt_remove_concurrently \
               | grep -qiE '\bCONCURRENTLY\b|\bVACUUM\b|\b(CREATE|DROP)[[:space:]]+DATABASE\b|\bALTER[[:space:]]+SYSTEM\b|\bCREATE[[:space:]]+TABLESPACE\b'; then
                stopped_id="$id"; stopped_reason="runs outside a transaction (\"transaction\": false), so it can't be tested and rolled back — later changes were not tested"; break
            fi
        fi
        if ! assert_safe_change "$id" "$f" "deploy" >/dev/null 2>&1 \
           || ! assert_no_tx_control "$id" "$f/deploy.sql" >/dev/null 2>&1 \
           || ! assert_no_tx_control "$id" "$f/revert.sql" >/dev/null 2>&1 \
           || ! assert_no_tx_control "$id" "$f/verify.sql" >/dev/null 2>&1; then
            stopped_id="$id"; stopped_reason="blocked by the deploy guards (danger rules or transaction control) — run deploy to see why"; break
        fi
        if [[ ! -f "$f/revert.sql" ]]; then stopped_id="$id"; stopped_reason="has no revert.sql"; break; fi
        local sid deploy revert record verify
        sid="$(escape_sql "$id")"
        deploy="$(_rt_file_sql "$f/deploy.sql")"
        revert="$(_rt_file_sql "$f/revert.sql")"
        if [[ $no_tx -eq 1 ]]; then
            deploy="$(printf '%s' "$deploy" | _rt_remove_concurrently)"
            revert="$(printf '%s' "$revert" | _rt_remove_concurrently)"
            no_tx_tested+=("$id")
        fi
        record="INSERT INTO dmcr.change_log(change_id, deploy_checksum, environment, actor) VALUES ('${sid}', '$(escape_sql "$(file_checksum "$f/deploy.sql")")', '$(escape_sql "$CFG_ENV")', 'dmcr test');"
        planned+=("$id")
        if [[ "$only" != " " && "$only" != *" $id "* ]]; then
            # not picked: deployed as setup for the changes after it, without the round-trip checks
            setup_ids+="$id "
            {
                printf '\n-- ===== %s (setup) =====\n' "$id"
                printf "SELECT pg_temp.dmcr_rt_setup('%s');\n" "$sid"
                printf '%s\n;\n%s\n' "$deploy" "$record"
            } >> "$tmp"
            [[ -n "$stop_at_id" && "$id" == "$stop_at_id" ]] && break
            continue
        fi
        verify="$(tx_verify_sql "$f/verify.sql")"
        {
            printf '\n-- ===== %s =====\n' "$id"
            printf "SELECT pg_temp.dmcr_rt_start('%s');\n" "$sid"
            printf 'SAVEPOINT dmcr_rt_probe;\n%s\n;\n%s\n;\nROLLBACK TO SAVEPOINT dmcr_rt_probe;\nRELEASE SAVEPOINT dmcr_rt_probe;\n' "$deploy" "$revert"
            printf "SELECT pg_temp.dmcr_rt_before('%s');\n" "$sid"
            printf '%s\n;\n%s\n%s\n' "$deploy" "$record" "$verify"
            printf "%s\n;\nDELETE FROM dmcr.change_log WHERE change_id = '%s';\n%s\n" "$revert" "$sid" "$verify"
            printf "SELECT pg_temp.dmcr_rt_after('%s');\n" "$sid"
            printf '%s\n;\n%s\n' "$deploy" "$record"
        } >> "$tmp"
        tested+=("$id")
        [[ -n "$stop_at_id" && "$id" == "$stop_at_id" ]] && break
    done
    printf '\nROLLBACK;\n' >> "$tmp"
    local o
    for o in $only; do
        if [[ " ${planned[*]+"${planned[*]}"} " != *" $o "* ]]; then
            rm -f "$tmp" 2>/dev/null || true
            log_error "--only names $o, which is not a pending change up to ${stop_at_id:-the last pending one}"
            return 1
        fi
    done

    local out="" rc=0
    if [[ ${#tested[@]} -gt 0 ]]; then
        local psql_exe
        psql_exe="$(get_psql_exe)"
        out="$("$psql_exe" "$CFG_CONN" -q -v ON_ERROR_STOP=1 -X -f "$tmp" 2>&1)" || rc=$?
    fi
    rm -f "$tmp" 2>/dev/null || true

    # Parse NOTICE lines: DMCR_RT|<id>|<kind>|<detail>
    local -A status=() details=()
    local last_started="" line kind rid detail
    while IFS= read -r line; do
        [[ "$line" == *"DMCR_RT|"* ]] || continue
        line="${line#*DMCR_RT|}"
        rid="${line%%|*}"; line="${line#*|}"
        kind="${line%%|*}"; detail="${line#*|}"
        case "$kind" in
            start|setup) last_started="$rid"; status[$rid]="running" ;;
            pass)  status[$rid]="pass"; details[$rid]+="${detail}"$'\n' ;;
            fail)  status[$rid]="fail"; details[$rid]+="${detail}"$'\n' ;;
            note)  details[$rid]+="note: ${detail}"$'\n' ;;
        esac
    done <<< "$out"
    if [[ $rc -ne 0 ]]; then
        local err
        err="$(echo "$out" | grep -E '(ERROR|FATAL):' | head -1 | sed 's/^psql:[^:]*:[0-9]*: //')"
        if [[ -n "$last_started" ]]; then
            status[$last_started]="fail"
            details[$last_started]+="${err:-psql failed}"$'\n'
        else
            log_error "Round-trip test could not start: ${err:-psql failed}"
            return 1
        fi
    fi

    # Setup changes that ran (deployed for the changes after them, not checked)
    for rid in $setup_ids; do
        if [[ "${status[$rid]:-}" == "running" ]] && ! [[ $rc -ne 0 && "$rid" == "$last_started" ]]; then
            status[$rid]="setup"; details[$rid]="not tested (not in --only): only applied inside the test for the changes after it, and rolled back"
        fi
    done

    # Changes after a failure never ran (the round trip stops at the first error)
    local failed_at=""
    for rid in "${planned[@]+"${planned[@]}"}"; do
        [[ "${status[$rid]:-}" == "fail" || "${status[$rid]:-}" == "running" ]] && { failed_at="$rid"; break; }
    done
    for rid in "${planned[@]+"${planned[@]}"}"; do
        if [[ -z "${status[$rid]:-}" ]]; then
            status[$rid]="not_run"
            details[$rid]="not run — the round trip stopped at ${failed_at:-an earlier change}"
        fi
    done

    for rid in "${no_tx_tested[@]+"${no_tx_tested[@]}"}"; do
        [[ "${status[$rid]:-}" == "pass" ]] && details[$rid]+="note: tested without CONCURRENTLY (same end state, inside the rolled-back transaction); deploy runs it CONCURRENTLY outside a transaction"$'\n'
    done

    local all_ok=0
    if [[ $json_out -eq 1 ]]; then
        local body="" st d
        for rid in "${planned[@]+"${planned[@]}"}"; do
            st="${status[$rid]:-not_run}"
            [[ "$st" == "running" ]] && st="fail"
            [[ "$st" == "pass" || "$st" == "setup" ]] || all_ok=1
            d="$(printf '%s' "${details[$rid]:-}" | perl -0777 -pe 's/\\/\\\\/g; s/"/\\"/g; s/\n$//; s/\n/\\n/g')"
            [[ -n "$body" ]] && body+=","
            body+="$(printf '{"change_id":"%s","status":"%s","details":"%s"}' "$rid" "$st" "$d")"
        done
        printf '{"status":"%s","changes":[%s]' "$([[ $all_ok -eq 0 ]] && echo passed || echo failed)" "$body"
        [[ -n "$stopped_id" ]] && printf ',"stopped_at":{"change_id":"%s","reason":"%s"}' "$stopped_id" "$(printf '%s' "$stopped_reason" | sed 's/"/\\"/g')"
        printf '}\n'
    else
        if [[ ${#tested[@]} -eq 0 ]]; then
            log_info "No pending changes to test"
        fi
        local st
        for rid in "${planned[@]+"${planned[@]}"}"; do
            st="${status[$rid]:-not_run}"
            [[ "$st" == "running" ]] && st="fail"
            if [[ "$st" == "setup" ]]; then
                log_info "$rid — ${details[$rid]}"
            elif [[ "$st" == "pass" ]]; then
                log_done "$rid — $(printf '%s' "${details[$rid]}" | grep -v '^note:' | head -1)"
                printf '%s' "${details[$rid]}" | grep '^note:' | sed 's/^/       /' || true
            elif [[ "$st" == "not_run" ]]; then
                all_ok=1
                log_skip "$rid — ${details[$rid]}"
            else
                all_ok=1
                log_error "$rid — round trip FAILED"
                printf '%s' "${details[$rid]:-}" | sed '/^$/d; s/^/       /'
            fi
        done
        [[ -n "$stopped_id" ]] && log_warn "Stopped at $stopped_id: $stopped_reason"
        log_info "Everything above ran in one transaction that was rolled back — the database is unchanged."
    fi
    return $all_ok
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

# verify.sql inside the change transaction. Wrapped in a savepoint that is rolled back,
# so verify side effects are never kept, while an error in verify aborts (and rolls back)
# the whole deploy / revert.
# The dmcr.change_log row for a change, as deploy records it: checksums of deploy / verify / revert (so later
# edits are caught), the environment, project / release / people and the ticket from meta.json.
# $2 is an SQL expression for the actor (a quoted literal, or current_user for a script run by hand).
change_log_insert_sql() {
    local id="$1" actor_sql="$2" dir="${CFG_CHANGES_DIR}/$1" n dchk="" vchk="" rchk=""
    [[ -f "$dir/deploy.sql" ]] && dchk="$(file_checksum "$dir/deploy.sql")"
    [[ -f "$dir/verify.sql" ]] && vchk="$(file_checksum "$dir/verify.sql")"
    [[ -f "$dir/revert.sql" ]] && rchk="$(file_checksum "$dir/revert.sql")"
    load_change_infos
    local scope_sql="" scols="" svals="" ticket
    if [[ -n "${CI_KIND[$id]+x}" ]]; then
        scope_sql="$(scope_record_sql "$id")"
        scols="$(printf '%s\n' "$scope_sql" | sed -n 1p)"; svals="$(printf '%s\n' "$scope_sql" | sed -n 2p)"
    fi
    ticket="$(read_meta_ticket "$dir")"
    if [[ -n "$ticket" ]]; then scols+=", ticket_id"; svals+=", '$(escape_sql "$ticket")'"; fi
    printf "INSERT INTO dmcr.change_log(change_id, deploy_checksum, verify_checksum, revert_checksum, environment, actor%s) VALUES ('%s', '%s', '%s', '%s', '%s', %s%s);" \
        "$scols" "$(escape_sql "$id")" "$(escape_sql "$dchk")" "$(escape_sql "$vchk")" "$(escape_sql "$rchk")" "$(escape_sql "$CFG_ENV")" "$actor_sql" "$svals"
}

# A manual-only (danger_) change as ONE script a DBA runs by hand (DBeaver, psql): it refuses if the change is
# already applied, runs deploy.sql, writes the same registry row repair --mark-applied writes, then runs verify.sql;
# all in one transaction, so a failure anywhere leaves nothing behind.
manual_script() {
    local id="$1" dir="${CFG_CHANGES_DIR}/$1" sid senv deploy
    [[ -f "$dir/deploy.sql" ]] || { log_error "No change folder with a deploy.sql: $dir"; return 1; }
    sid="$(escape_sql "$id")"; senv="$(escape_sql "$CFG_ENV")"
    deploy="$(cat "$dir/deploy.sql")"
    if [[ ${#CFG_PLACEHOLDERS[@]} -gt 0 ]]; then deploy="$(resolve_placeholders "$deploy")"; fi
    printf -- '-- DMCR manual change: %s\n' "$id"
    printf -- '-- Environment: %s. Generated %s by dmcr manual-script.\n' "$CFG_ENV" "$(date '+%Y-%m-%d %H:%M')"
    printf -- '-- Run it as ONE script (DBeaver: Execute SQL Script, Alt+X; psql: -f). It is one transaction:\n'
    printf -- '-- deploy.sql, the DMCR registry record and verify.sql commit together, or nothing is applied.\n'
    printf 'BEGIN;\n'
    printf "SET LOCAL lock_timeout = '%s';\n" "$CFG_LOCK_TIMEOUT"
    printf "DO \$dmcr\$ BEGIN IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '%s') THEN RAISE EXCEPTION 'DMCR: %s is already applied on this database'; END IF; END \$dmcr\$;\n" "$sid" "$sid"
    approval_policy || return 1
    if [[ "$APPROVAL_REQUIRED" == "1" ]]; then
        local sums state
        sums="$(change_sums "$dir")"
        load_approvals
        if [[ -z "${APPROVAL_BY[$id]+x}" ]]; then state="NOT APPROVED yet; this script refuses to run until it is (dmcr approve)"
        elif [[ "${APPROVAL_SUMS[$id]}" != "$sums" ]]; then state="approved by ${APPROVAL_BY[$id]}, but the files changed since; it must be approved again"
        else state="approved by ${APPROVAL_BY[$id]} on ${APPROVAL_AT[$id]}"; fi
        printf -- '-- approval = required on %s: %s\n' "$CFG_ENV" "$state"
        printf 'DO $dmcr$ BEGIN\n'
        printf "  IF to_regclass('dmcr.approval') IS NULL THEN RAISE EXCEPTION 'DMCR: %s is not approved for %s'; END IF;\n" "$sid" "$senv"
        printf "  IF NOT EXISTS (SELECT 1 FROM dmcr.approval WHERE change_id = '%s' AND environment = '%s' AND checksums = '%s') THEN RAISE EXCEPTION 'DMCR: %s is not approved for %s (or its files changed since it was approved)'; END IF;\n" "$sid" "$senv" "$(escape_sql "$sums")" "$sid" "$senv"
        printf 'END $dmcr$;\n'
    fi
    printf '\n'
    printf -- '-- ===== deploy.sql =====\n%s\n;\n\n' "$deploy"
    printf -- '-- ===== record it in the DMCR registry (what dmcr repair --mark-applied writes) =====\n'
    change_log_insert_sql "$id" "current_user || ' (by hand)'"; printf '\n'
    printf "INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor) VALUES ('manual', '%s', 'success', 'Run by hand from dmcr manual-script', '%s', current_user);\n\n" "$sid" "$senv"
    printf -- '-- ===== verify.sql: an error here rolls everything above back =====\n'
    tx_verify_sql "$dir/verify.sql"
    printf '\nCOMMIT;\n'
}

tx_verify_sql() {
    local file="$1"
    [[ -f "$file" ]] || return 0
    local v
    v="$(cat "$file")"
    if [[ ${#CFG_PLACEHOLDERS[@]} -gt 0 ]]; then
        v="$(resolve_placeholders "$v")"
    fi
    printf '\nSAVEPOINT dmcr_verify;\n-- verify.sql\n%s\n;\nROLLBACK TO SAVEPOINT dmcr_verify;\nRELEASE SAVEPOINT dmcr_verify;\n' "$v"
}

# Refuse change files that would escape the runner's transaction wrapper:
# COMMIT / BEGIN / END / ROLLBACK (not ROLLBACK TO) / ABORT / START TRANSACTION, or psql
# meta-commands such as \c or \i. Comments, quoted strings and $$-bodies are ignored.
assert_no_tx_control() {
    local id="$1" file="$2"
    [[ -f "$file" ]] || return 0
    local found
    found="$(perl -0777 -ne '
        s{/\*.*?\*/}{ }gs;
        s{--[^\n]*}{ }g;
        s{\$([A-Za-z_][A-Za-z_0-9]*|)\$.*?\$\1\$}{ }gs;
        s{\x27(?:[^\x27]|\x27\x27)*\x27}{ }gs;
        for my $l (split /\n/) { if ($l =~ /^\s*(\\\S*)/) { print "the psql meta-command $1"; exit } }
        for my $st (split /;/) {
            if ($st =~ /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK(?!\s+TO\b))\b/i) { print uc($1); exit }
        }' "$file")"
    if [[ -n "$found" ]]; then
        log_error "BLOCKED: $id/$(basename "$file") contains $found. DMCR wraps each change in its own transaction; remove explicit transaction control and psql backslash commands."
        return 1
    fi
    return 0
}

# =============================================================================
# REGISTRY GUARD
# =============================================================================
require_registry() {
    log_debug "Checking DMCR registry (dmcr.change_log)"
    # One query: change_log, repeatable_log, change_log.created_by (v1.2.0), deploy_lock (v1.1.1)
    local have v11 v12
    have="$(exec_psql_scalar "SELECT (to_regclass('dmcr.change_log') IS NOT NULL)::int || '' || (to_regclass('dmcr.repeatable_log') IS NOT NULL)::int || '' || (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dmcr' AND table_name='change_log' AND column_name='created_by'))::int || '' || (to_regclass('dmcr.deploy_lock') IS NOT NULL)::int || '' || (to_regclass('dmcr.approval') IS NOT NULL)::int || '' || (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='dmcr' AND table_name='event_log' AND column_name='deploy_id'))::int;" 2>/dev/null || echo "")"
    if [[ ${#have} -ne 6 || "${have:0:1}" != "1" ]]; then
        log_error "DMCR registry not found. Run: dmcr init"
        exit 1
    fi
    [[ "${have:3:1}" == "1" ]] && DMCR_DEPLOY_LOCK_TABLE_OK=1
    [[ "${have:4:1}" == "1" ]] && DMCR_APPROVAL_TABLE_OK=1
    v11="${have:1:1}"; v12="${have:2:1}"
    if [[ "${have:5:1}" != "1" ]]; then
        exec_psql_scalar "SET client_min_messages = warning;
ALTER TABLE dmcr.change_log ADD COLUMN IF NOT EXISTS deploy_id text NULL;
ALTER TABLE dmcr.event_log  ADD COLUMN IF NOT EXISTS deploy_id text NULL;
CREATE INDEX IF NOT EXISTS ix_dmcr_event_log_deploy_id ON dmcr.event_log (deploy_id);" >/dev/null
        log_info "Registry upgraded to v1.3.0 (deployment ids)"
    fi
    if [[ -n "$v12" && "$v12" != "1" ]]; then
        exec_psql_scalar "
ALTER TABLE dmcr.change_log ADD COLUMN IF NOT EXISTS project_id   text NULL;
ALTER TABLE dmcr.change_log ADD COLUMN IF NOT EXISTS project_type text NULL;
ALTER TABLE dmcr.change_log ADD COLUMN IF NOT EXISTS release_id   text NULL;
ALTER TABLE dmcr.change_log ADD COLUMN IF NOT EXISTS change_kind  text NULL;
ALTER TABLE dmcr.change_log ADD COLUMN IF NOT EXISTS requested_by text NULL;
ALTER TABLE dmcr.change_log ADD COLUMN IF NOT EXISTS created_by   text NULL;" >/dev/null
        log_info "Registry upgraded to v1.2.0 (project, release, kind, requested_by, created_by)"
    fi
    if [[ -n "$v11" && "$v11" != "1" ]]; then
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
DMCR_DB_LOCK_HOLDER=""
DMCR_DEPLOY_LOCK_TABLE_OK=""

ensure_deploy_lock_table() {
    # Registries created before v1.1.1 have no dmcr.deploy_lock. Create it only when missing,
    # so routine deploys never need CREATE rights on schema dmcr.
    [[ -n "$DMCR_DEPLOY_LOCK_TABLE_OK" ]] && return 0
    local missing
    missing="$(exec_psql_scalar "SELECT to_regclass('dmcr.deploy_lock') IS NULL;")" || return 1
    if [[ "$missing" == "t" ]]; then
        exec_psql_scalar "SET client_min_messages = warning; CREATE TABLE IF NOT EXISTS dmcr.deploy_lock (lock_id integer PRIMARY KEY DEFAULT 1 CHECK (lock_id = 1), holder text NOT NULL, environment text, acquired_at timestamptz NOT NULL DEFAULT now());" >/dev/null || return 1
        log_info "Registry upgraded: created dmcr.deploy_lock"
    fi
    DMCR_DEPLOY_LOCK_TABLE_OK=1
}

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

    if command -v flock >/dev/null 2>&1; then
        if ! flock -n "$fd" 2>/dev/null; then
            log_error "Another DMCR process is running (lock: $DMCR_LOCK_FILE). Wait or remove the lock file."
            exit 1
        fi
    else
        # macOS has no flock by default; the database lock below is the real guard.
        log_debug "flock not available — relying on the database lock"
    fi
    echo "PID=$$ at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&"$fd" 2>/dev/null || true

    # Database lock (cross-machine, cross-user): one row in dmcr.deploy_lock.
    # Each psql call is its own session, so a session-level pg advisory lock would be
    # released immediately; a committed row survives between calls.
    # The lock event is written in the same round trip when this run got the lock; its failure never
    # fails the lock. Only deploy_lock / event_log change, so the applied-state cache stays valid.
    local holder current safe_holder
    holder="$(get_dmcr_actor) pid=$$ run=$(date +%s)$RANDOM$RANDOM"
    safe_holder="$(escape_sql "$holder")"
    if ! ensure_deploy_lock_table || ! current="$(DMCR_KEEP_REG_CACHE=1 exec_psql_scalar "
INSERT INTO dmcr.deploy_lock(lock_id, holder, environment) VALUES (1, '${safe_holder}', '$(escape_sql "$CFG_ENV")') ON CONFLICT (lock_id) DO NOTHING;
DO \$dmcr\$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.deploy_lock WHERE lock_id = 1 AND holder = '${safe_holder}') THEN
    INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor)
    VALUES ('lock', '*', 'success', 'Lock acquired (file + database)', '$(escape_sql "$CFG_ENV")', '$(escape_sql "$(get_dmcr_actor)")');
  END IF;
EXCEPTION WHEN others THEN NULL;
END \$dmcr\$;
SELECT holder || ' @@ ' || acquired_at::text FROM dmcr.deploy_lock WHERE lock_id = 1;")"; then
        release_file_lock
        log_error "Could not take the DMCR database lock"
        exit 1
    fi
    if [[ "${current%% @@ *}" != "$holder" ]]; then
        release_file_lock
        log_error "Another DMCR run holds the database lock (${current%% @@ *}, since ${current#* @@ }). Wait for it to finish. If that run crashed, clear the lock with: dmcr repair --unlock"
        exit 1
    fi
    DMCR_DB_LOCK_HOLDER="$holder"

    local elapsed=$(( SECONDS - t_start ))
    log_info "Lock acquired in ${elapsed}s"
}

release_file_lock() {
    if [[ -n "$DMCR_LOCK_FD" ]]; then
        flock -u "$DMCR_LOCK_FD" 2>/dev/null || true
        eval "exec ${DMCR_LOCK_FD}>&-" 2>/dev/null || true
        DMCR_LOCK_FD=""
        log_debug "File lock released"
    fi
}

release_advisory_lock() {
    release_file_lock

    # Release the database lock (only if this run holds it)
    [[ -n "$DMCR_DB_LOCK_HOLDER" ]] || return 0
    # The unlock event rides along; its failure never keeps the lock (the applied-state cache stays valid)
    if DMCR_KEEP_REG_CACHE=1 exec_psql_scalar "DELETE FROM dmcr.deploy_lock WHERE lock_id = 1 AND holder = '$(escape_sql "$DMCR_DB_LOCK_HOLDER")';
DO \$dmcr\$ BEGIN
  INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor)
  VALUES ('unlock', '*', 'success', 'Lock released', '$(escape_sql "$CFG_ENV")', '$(escape_sql "$(get_dmcr_actor)")');
EXCEPTION WHEN others THEN NULL;
END \$dmcr\$;" >/dev/null 2>&1; then
        DMCR_DB_LOCK_HOLDER=""
        log_debug "Database lock released"
    else
        log_warn "Could not release the database lock. If the next run reports the lock as held, run: dmcr repair --unlock"
    fi
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
    # List dirs matching [0-9]*_*, in folder-number order
    find "$dir" -maxdepth 1 -mindepth 1 -type d -name '[0-9]*_*' | sort_change_ids
}

# Change ids or folder paths in folder-number order: 001 < 099 < 999 < 1000. A plain sort puts 1000_ before
# 101_, so after the 999th change the order (and a 3-digit-only match) would go wrong.
sort_change_ids() {
    awk '{ n = $0; sub(/.*\//, "", n); k = 999999999999; if (match(n, /^[0-9]+_/)) k = substr(n, 1, RLENGTH - 1) + 0; printf "%015d\t%s\n", k, $0 }' \
        | LC_ALL=C sort -t "$(printf '\t')" -k1,1 -k2 | cut -f2-
}

get_repeatable_folders() {
    local dir="$1"
    [[ -d "$dir" ]] || return 0
    # an R__ folder named danger_ is never re-run automatically (danger_ changes are manual-only)
    find "$dir" -maxdepth 1 -mindepth 1 -type d -name 'R__*' | { grep -viE '/R__(.*_)?danger_' || true; } | sort
}

# =============================================================================
# REGISTRY QUERIES
# =============================================================================
# ---------------------------------------------------------------------------
# Deploy plan guards, per environment section in dmcr.cfg:
#   promote_from = test     only changes already applied in [test], with byte-identical deploy,
#                           verify and revert files, may be deployed here (promotion gate).
#                           The source registry is read over DMCR_PROMOTE_FROM_CONN (set by the
#                           extension, password from the keychain) or [test] conn.
#   out_of_order = block    refuse a pending change that sorts before an applied one (allow by default).
# With --release/--project/--kind only applied changes in the same scope count for out_of_order,
# so a project moved to a later release can still go out after the others. Dropped changes and
# changes outside the scope are not in the plan; a planned change whose meta.json `requires`
# names one of them (and it is not applied) is refused.
# Checked for the whole plan before anything runs. Args: stop_at_id folder...
# ---------------------------------------------------------------------------
# =============================================================================
# APPROVALS: [env] approval = required, approvers = a, b, self_approval = block | allow
# =============================================================================
# The names are DBA names (Settings > DMCR Config): a sign-off record, not authentication;
# who may write dmcr.approval is up to the database grants.
DMCR_APPROVAL_TABLE_OK=""
APPROVAL_REQUIRED=0 APPROVAL_SELF="block"
APPROVERS=()
declare -A APPROVAL_SUMS=() APPROVAL_BY=() APPROVAL_AT=() APPROVAL_NOTE=()
APPROVALS_LOADED=0

approval_policy() {
    local mode self list a
    mode="$(ini_get "$CFG_ENV" "approval" "" | tr '[:upper:]' '[:lower:]' | tr -d ' ')"
    case "$mode" in ""|none) APPROVAL_REQUIRED=0 ;; required) APPROVAL_REQUIRED=1 ;; *) log_error "Invalid approval='$mode' for [$CFG_ENV] — use required or none"; return 1 ;; esac
    self="$(ini_get "$CFG_ENV" "self_approval" "block" | tr '[:upper:]' '[:lower:]' | tr -d ' ')"
    case "$self" in block|allow) APPROVAL_SELF="$self" ;; *) log_error "Invalid self_approval='$self' for [$CFG_ENV] — use block or allow"; return 1 ;; esac
    APPROVERS=()
    list="$(ini_get "$CFG_ENV" "approvers" "")"
    IFS=',' read -ra _appr <<< "$list"
    for a in "${_appr[@]+"${_appr[@]}"}"; do a="$(printf '%s' "$a" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"; [[ -n "$a" ]] && APPROVERS+=("$a"); done
    return 0
}

# deploy / verify / revert checksums of a change folder, as one string (what an approval covers)
change_sums() {
    local dir="$1" n out=""
    for n in deploy verify revert; do
        [[ -n "$out" || "$n" != "deploy" ]] && out+=":"
        [[ -f "$dir/$n.sql" ]] && out+="$(file_checksum "$dir/$n.sql")"
    done
    printf '%s' "$out"
}

# APPROVAL_* for this environment (one query; empty before the first approval)
load_approvals() {
    [[ "$APPROVALS_LOADED" == "1" ]] && return 0
    APPROVALS_LOADED=1
    [[ -n "$DMCR_APPROVAL_TABLE_OK" ]] || return 0
    local raw rec id sums by at note
    raw="$(exec_psql_scalar "SELECT coalesce(string_agg(change_id || chr(29) || checksums || chr(29) || approved_by || chr(29) || to_char(approved_at, 'YYYY-MM-DD HH24:MI') || chr(29) || coalesce(note, ''), chr(31)), '') FROM dmcr.approval WHERE environment = '$(escape_sql "$CFG_ENV")';")" || return 1
    while IFS= read -r rec || [[ -n "$rec" ]]; do
        [[ -n "$rec" ]] || continue
        IFS=$'\x1d' read -r id sums by at note <<< "$rec"
        APPROVAL_SUMS["$id"]="$sums"; APPROVAL_BY["$id"]="$by"; APPROVAL_AT["$id"]="$at"; APPROVAL_NOTE["$id"]="${note:-}"
    done < <(printf '%s' "$raw" | tr '\037' '\n')
}

# Why each change folder given may not deploy yet (one line each): never approved, or changed since
approval_problems() {
    load_approvals
    local who="" f id
    [[ ${#APPROVERS[@]} -gt 0 ]] && who=" (approvers: $(IFS=,; printf '%s' "${APPROVERS[*]}" | sed 's/,/, /g'))"
    for f in "$@"; do
        id="${f##*/}"
        if [[ -z "${APPROVAL_BY[$id]+x}" ]]; then echo "$id is not approved for $CFG_ENV$who — dmcr approve $id --env $CFG_ENV"; continue; fi
        [[ "${APPROVAL_SUMS[$id]}" != "$(change_sums "$f")" ]] && echo "$id changed since ${APPROVAL_BY[$id]} approved it (${APPROVAL_AT[$id]}) — approve it again"
    done
    return 0
}

ensure_approval_table() {
    [[ -n "$DMCR_APPROVAL_TABLE_OK" ]] && return 0
    exec_psql_scalar "SET client_min_messages = warning; CREATE TABLE IF NOT EXISTS dmcr.approval (change_id text NOT NULL, environment text NOT NULL, checksums text NOT NULL, approved_by text NOT NULL, approved_at timestamptz NOT NULL DEFAULT now(), note text, PRIMARY KEY (change_id, environment));" >/dev/null || return 1
    log_info "Registry upgraded: created dmcr.approval"
    DMCR_APPROVAL_TABLE_OK=1
}

# The change folders an approve / approvals command is about: one id, or the pending changes of a --release / --project / --kind
approval_targets() {
    local id="$1" f fid
    if [[ -n "$id" ]]; then
        [[ -d "$CFG_CHANGES_DIR/$id" ]] || { log_error "No change folder named '$id' in $CFG_CHANGES_DIR"; return 1; }
        echo "$CFG_CHANGES_DIR/$id"; return 0
    fi
    load_change_infos
    while IFS= read -r f; do
        [[ -n "$f" ]] || continue
        fid="${f##*/}"
        in_scope "$fid" || continue
        is_applied "$fid" && continue
        echo "$f"
    done < <(get_change_folders "$CFG_CHANGES_DIR")
}

assert_deploy_plan() {
    local stop_at_id="$1"; shift
    local folders=("$@")
    local promote_from out_of_order
    promote_from="$(ini_get "$CFG_ENV" "promote_from" "")"
    out_of_order="$(ini_get "$CFG_ENV" "out_of_order" "$(ini_get "dmcr" "out_of_order" "allow")")"
    case "$out_of_order" in allow|block) ;; *) log_error "Invalid out_of_order='$out_of_order' for [$CFG_ENV] — use allow or block"; return 1 ;; esac
    load_change_infos
    local scoped=0 sf
    scope_active && scoped=1
    for sf in "${folders[@]+"${folders[@]}"}"; do [[ "${CI_DROPPED[$(basename "$sf")]:-0}" == "1" ]] && scoped=1; done
    approval_policy || return 1
    [[ -z "$promote_from" && "$out_of_order" == "allow" && $scoped -eq 0 && "$APPROVAL_REQUIRED" != "1" ]] && return 0

    local applied_csv
    applied_csv="$(exec_psql_scalar "SELECT coalesce(string_agg(change_id, ',' ORDER BY change_id), '') FROM dmcr.change_log;")" || return 1
    local -A applied=()
    local a
    for a in ${applied_csv//,/ }; do applied["$a"]=1; done

    local i last_applied=-1 n=${#folders[@]}
    local lid
    for (( i=0; i<n; i++ )); do
        lid="$(basename "${folders[$i]}")"
        [[ -n "${applied[$lid]:-}" ]] && in_scope "$lid" 1 && last_applied=$i
    done
    local plan=() problems=() id
    for (( i=0; i<n; i++ )); do
        id="$(basename "${folders[$i]}")"
        if [[ -z "${applied[$id]:-}" ]] && ! echo "$id" | grep -qiE '(^|_)danger_' && in_scope "$id"; then
            plan+=("${folders[$i]}")
            if [[ "$out_of_order" == "block" && $i -lt $last_applied ]]; then
                problems+=("$id is out of order: $(basename "${folders[$last_applied]}") is already applied (out_of_order=block)")
            fi
        fi
        [[ -n "$stop_at_id" && "$id" == "$stop_at_id" ]] && break
    done

    # meta.json `requires` must be applied already or deployed in this run
    local -A plan_ids=()
    local pf req
    for pf in "${plan[@]+"${plan[@]}"}"; do plan_ids["$(basename "$pf")"]=1; done
    for pf in "${plan[@]+"${plan[@]}"}"; do
        id="$(basename "$pf")"
        for req in ${CI_REQUIRES[$id]//,/ }; do
            [[ -n "${applied[$req]:-}" || -n "${plan_ids[$req]:-}" ]] && continue
            [[ -n "${CI_KIND[$req]+x}" ]] || continue   # missing folder: reported by the preflight
            if [[ "${CI_DROPPED[$req]:-0}" == "1" ]]; then
                problems+=("$id requires $req, which is not applied and is dropped (${CI_DROP_REASON[$req]})")
            else
                problems+=("$id requires $req, which is not applied and is not in this deploy (project ${CI_PROJECT[$req]:-(none)}, release ${CI_RELEASE[$req]:-(none)})")
            fi
        done
    done

    if [[ -n "$promote_from" && ${#plan[@]} -gt 0 ]]; then
        if [[ "$promote_from" == "$CFG_ENV" ]]; then log_error "promote_from for [$CFG_ENV] names the environment itself"; return 1; fi
        local src_conn="${DMCR_PROMOTE_FROM_CONN:-$(ini_get "$promote_from" "conn" "")}"
        if [[ -z "$src_conn" ]]; then
            log_error "BLOCKED by promotion gate: [$CFG_ENV] promote_from = $promote_from, but there is no connection for '$promote_from' (DMCR_PROMOTE_FROM_CONN or [$promote_from] conn)"
            return 1
        fi
        local src_csv
        # Subshell: the source connection and its password never replace the target's
        if ! src_csv="$(CFG_CONN="$src_conn"; split_conn_password; exec_psql_scalar "SELECT coalesce(string_agg(change_id || ':' || coalesce(deploy_checksum,'') || ':' || coalesce(verify_checksum,'') || ':' || coalesce(revert_checksum,''), ','), '') FROM dmcr.change_log;")"; then
            log_error "BLOCKED by promotion gate: cannot read the DMCR registry of '$promote_from'"
            return 1
        fi
        local -A src=()
        local r
        for r in ${src_csv//,/ }; do src["${r%%:*}"]="${r#*:}"; done
        local f row k name chk
        for f in "${plan[@]}"; do
            id="${f##*/}"
            if [[ -z "${src[$id]+x}" ]]; then problems+=("$id is not applied in $promote_from"); continue; fi
            row="${src[$id]}:"
            for name in deploy verify revert; do
                chk="${row%%:*}"; row="${row#*:}"
                if [[ -n "$chk" && -f "$f/$name.sql" && "$(file_checksum "$f/$name.sql")" != "$chk" ]]; then
                    problems+=("$id/$name.sql differs from the one applied in $promote_from")
                fi
            done
        done
    fi

    # approval = required: every change in the plan is approved for this environment, with the files approved
    local n_before=${#problems[@]} ap
    if [[ "$APPROVAL_REQUIRED" == "1" && ${#plan[@]} -gt 0 ]]; then
        while IFS= read -r ap; do [[ -n "$ap" ]] && problems+=("$ap"); done < <(approval_problems "${plan[@]}")
    fi

    if [[ ${#problems[@]} -gt 0 ]]; then
        if [[ -n "$promote_from" ]]; then log_error "BLOCKED by promotion gate ($promote_from -> $CFG_ENV):"
        elif [[ $n_before -eq 0 ]]; then log_error "BLOCKED by approval gate ($CFG_ENV):"
        else log_error "BLOCKED by deploy plan:"; fi
        local p
        for p in "${problems[@]}"; do log_error "  >> $p"; done
        return 1
    fi
    [[ -n "$promote_from" && ${#plan[@]} -gt 0 ]] && log_info "Promotion gate OK — ${#plan[@]} change(s) applied in '$promote_from' with identical files"
    return 0
}

# A repeatable (R__) change has been applied at least once (dmcr.repeatable_log has its row).
is_repeatable_applied() {
    local change_id="$1"
    [[ "$change_id" == R__* ]] || return 1
    if registry_cache_load; then grep -q "^R $change_id " "$DMCR_REG_CACHE"; return; fi
    local safe_id result
    safe_id="$(escape_sql "$change_id")"
    result="$(exec_psql_scalar "SELECT 1 FROM dmcr.repeatable_log WHERE change_id = '${safe_id}' LIMIT 1;" 2>/dev/null || echo "")"
    [[ "$result" == "1" ]]
}

# What the registry holds, read with one query into $DMCR_REG_CACHE and kept until the next psql
# call (which may write it): lines "A <change_log id>" and "R <repeatable id> <last checksum>".
# Fails when the registry cannot be read that way; callers then ask per change as before.
registry_cache_load() {
    [[ -f "$DMCR_REG_CACHE" ]] && return 0
    local raw
    raw="$(DMCR_KEEP_REG_CACHE=1 exec_psql_scalar "SELECT coalesce((SELECT string_agg('A ' || change_id, chr(31)) FROM dmcr.change_log), '') || chr(31) || coalesce((SELECT string_agg('R ' || change_id || ' ' || coalesce(last_checksum, ''), chr(31)) FROM dmcr.repeatable_log), '');" 2>/dev/null)" || return 1
    # one record per line, ending in a newline: registry_cache_add appends to it
    { printf '%s' "$raw" | tr '\037' '\n'; echo; } > "$DMCR_REG_CACHE" || return 1
}

# Keep the cache across a deploy transaction: registry_cache_add restores it with the committed change
registry_cache_hold() {
    rm -f "${DMCR_REG_CACHE}.held" 2>/dev/null || true
    [[ -f "$DMCR_REG_CACHE" ]] && cp "$DMCR_REG_CACHE" "${DMCR_REG_CACHE}.held" 2>/dev/null || true
}
registry_cache_add() {
    if [[ -f "${DMCR_REG_CACHE}.held" ]]; then
        mv -f "${DMCR_REG_CACHE}.held" "$DMCR_REG_CACHE" && printf 'A %s\n' "$1" >> "$DMCR_REG_CACHE"
    fi
    return 0
}

is_applied() {
    local change_id="$1"
    log_debug "CHECK $change_id"
    if registry_cache_load; then grep -qxF "A $change_id" "$DMCR_REG_CACHE"; return; fi
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
    local stored
    if registry_cache_load; then
        stored="$(grep "^R $id " "$DMCR_REG_CACHE" | head -1 | cut -d' ' -f3 || true)"
    else
        local safe_id
        safe_id="$(escape_sql "$id")"
        stored="$(exec_psql_scalar "SELECT last_checksum FROM dmcr.repeatable_log WHERE change_id = '${safe_id}' LIMIT 1;" 2>/dev/null || echo "")"
    fi
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
        perl -MJSON::PP -0777 -ne 'my $j = eval { decode_json($_) } or exit; print "$_\n" for @{ $j->{requires} || [] }' "$meta" 2>/dev/null || true
    fi
}

read_meta_ticket() {
    local folder_path="$1"
    local meta="$folder_path/meta.json"
    [[ -f "$meta" ]] || { echo ""; return; }
    if command -v jq >/dev/null 2>&1; then
        jq -r '.ticket // empty' "$meta" 2>/dev/null || echo ""
    else
        perl -MJSON::PP -0777 -ne 'my $j = eval { decode_json($_) } or exit; print $j->{ticket} // ""' "$meta" 2>/dev/null || echo ""
    fi
}

# A non-transactional change can stop part-way, so it must be safe to run again:
# CREATE INDEX CONCURRENTLY needs IF NOT EXISTS, DROP INDEX CONCURRENTLY needs IF EXISTS.
assert_rerunnable_notx() {
    local id="$1" folder="$2" problems
    problems="$(perl -0777 -ne '
        my $file = $ARGV; $file =~ s{.*/}{};
        s{/\*.*?\*/}{ }gs; s{--[^\n]*}{ }g;
        for my $st (split /;/) {
            print "$file: CREATE INDEX CONCURRENTLY without IF NOT EXISTS\n" if $st =~ /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i && $st !~ /\bIF\s+NOT\s+EXISTS\b/i;
            print "$file: DROP INDEX CONCURRENTLY without IF EXISTS\n" if $st =~ /\bDROP\s+INDEX\s+CONCURRENTLY\b/i && $st !~ /\bIF\s+EXISTS\b/i;
        }' "$folder/deploy.sql" "$folder/revert.sql" 2>/dev/null)"
    if [[ -n "$problems" ]]; then
        log_error "BLOCKED: $id runs outside a transaction, so it must be safe to run again after a partial failure:"
        printf '%s\n' "$problems" | sed 's/^/        /' >&2
        return 1
    fi
    return 0
}

# meta.json "transaction": false → the change runs outside a transaction (needed for
# CREATE INDEX CONCURRENTLY, ALTER TYPE ... ADD VALUE on old servers, VACUUM, etc.)
read_meta_no_tx() {
    local folder_path="$1"
    local meta="$folder_path/meta.json"
    [[ -f "$meta" ]] || return 1
    local v
    v="$(perl -MJSON::PP -0777 -ne 'my $j = eval { decode_json($_) } or exit; print((exists $j->{transaction} && !$j->{transaction}) ? "no" : "yes")' "$meta" 2>/dev/null || true)"
    [[ "$v" == "no" ]]
}

read_meta_app_name() {
    local folder_path="$1"
    local meta="$folder_path/meta.json"
    [[ -f "$meta" ]] || { echo ""; return; }
    if command -v jq >/dev/null 2>&1; then
        jq -r '.app_name // empty' "$meta" 2>/dev/null || echo ""
    else
        perl -MJSON::PP -0777 -ne 'my $j = eval { decode_json($_) } or exit; print $j->{app_name} // ""' "$meta" 2>/dev/null || echo ""
    fi
}

# =============================================================================
# RELEASES, PROJECTS AND CHANGE KINDS  (same rules and messages as dmcr.ps1)
# =============================================================================
# <changes_dir>/releases.json (optional) lists the releases and the projects in them:
# {
#   "releases": [ { "id": "2026-07-10", "name": "July release", "date": "2026-07-10", "status": "planned" } ],
#   "projects": [ { "id": "PRJ-B", "name": "Lookup custom fields", "type": "cr", "release": "2026-07-10", "status": "active" } ]
# }
# A change joins a project with meta.json "project"; its release is the project's release, so moving a
# project to another release moves all of its changes. A dropped change (meta.json "status": "dropped")
# or a change of a dropped project keeps its folder for audit, but deploy skips it in every environment.
# meta.json may also carry "kind", "requested_by" (developer), "created_by" (DBA) and "created_at".
CHANGE_KINDS="insert update delete dml ddl function type other"
declare -A CI_PROJECT=() CI_PTYPE=() CI_RELEASE=() CI_KIND=() CI_REQ_BY=() CI_CREATED_BY=() CI_CREATED_AT=() CI_TICKET=() CI_DROPPED=() CI_DROP_REASON=() CI_REQUIRES=()
CI_LOADED=0
SCOPE_RELEASE="" SCOPE_PROJECTS="" SCOPE_KINDS=""   # comma lists; release/projects in the catalog's spelling

# One perl program for everything that reads releases.json / meta.json.
#   info                 one line per change folder, fields separated by \x1f
#   issues               preflight problems in releases.json and in each change's project / kind
#   resolve REL PROJS    "OK\x1fREL\x1fP1,P2" in the catalog's spelling, or "ERR\x1fmessage"
#   release ENV JSON [ID] release list / show; applied changes on stdin as "id=YYYY-MM-DD HH:MI"
_DMCR_SCOPE_PL="$(cat <<'PERL'
use strict; use warnings; use JSON::PP;
binmode STDOUT, ':encoding(UTF-8)';
my ($dir, $mode, @rest) = @ARGV;
my @TYPES = qw(new bugfix cr hotfix other);
my @KINDS = qw(insert update delete dml ddl function type other);
sub rd { my $p = shift; open my $fh, '<:raw', $p or return undef; local $/; my $c = <$fh>; close $fh; $c =~ s/^\xEF\xBB\xBF//; return $c; }
sub fld { my ($h, $k) = @_; return '' unless ref $h eq 'HASH' && defined $h->{$k} && !ref $h->{$k}; my $v = "$h->{$k}"; $v =~ s/^\s+|\s+$//g; $v =~ s/[\x1f\r\n\t]/ /g; return $v; }
my ($cat, $caterr, %rel, %proj, @relk, @projk, @dups) = (undef, '');
if (-f "$dir/releases.json") {
    $cat = eval { JSON::PP->new->utf8->decode(rd("$dir/releases.json")) };
    if (!$cat || ref $cat ne 'HASH') { ($caterr = $@ || 'not a JSON object') =~ s/\s+at \S+ line \d+.*//s; $cat = undef; }
}
if ($cat) {
    for my $r (@{ ref $cat->{releases} eq 'ARRAY' ? $cat->{releases} : [] }) {
        my $id = fld($r, 'id'); next unless length $id; my $k = lc $id;
        if ($rel{$k}) { push @dups, "release '$id'" } else { push @relk, $k }
        $rel{$k} = $r;
    }
    for my $p (@{ ref $cat->{projects} eq 'ARRAY' ? $cat->{projects} : [] }) {
        my $id = fld($p, 'id'); next unless length $id; my $k = lc $id;
        if ($proj{$k}) { push @dups, "project '$id'" } else { push @projk, $k }
        $proj{$k} = $p;
    }
}
sub kind_of {
    my $s = shift // '';
    $s =~ s{/\*.*?\*/}{ }gs; $s =~ s{--[^\r\n]*}{ }g;
    $s =~ s/'(?:[^']|'')*'/''/g;
    $s =~ s/\$((?:[A-Za-z_]\w*)?)\$.*?\$\1\$/ /gs;
    my (%ddl, %dml);
    for my $t (split /;/, $s) {
        $t =~ s/^\s+|\s+$//g; next unless length $t;
        # DMCR's own bookkeeping (dmcr.bak_* backups a data change keeps for its revert) is not the change's kind
        next if $t =~ /^(?:CREATE\s+(?:UNLOGGED\s+)?TABLE|INSERT\s+INTO|DROP\s+TABLE|ALTER\s+TABLE|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?"?dmcr"?\./i;
        if    ($t =~ /^(CREATE|ALTER|DROP)\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE|AGGREGATE)\b/i) { $ddl{function} = 1 }
        elsif ($t =~ /^(CREATE|ALTER|DROP)\s+(TYPE|DOMAIN)\b/i) { $ddl{type} = 1 }
        elsif ($t =~ /^(CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE|REFRESH)\b/i) { $ddl{ddl} = 1 }
        elsif ($t =~ /^INSERT\b/i) { $dml{insert} = 1 }
        elsif ($t =~ /^UPDATE\b/i) { $dml{update} = 1 }
        elsif ($t =~ /^(DELETE|TRUNCATE)\b/i) { $dml{delete} = 1 }
        elsif ($t =~ /^MERGE\b/i) { $dml{dml} = 1 }
        elsif ($t =~ /^WITH\b/i) { for my $k (qw(insert update delete)) { $dml{$k} = 1 if $t =~ /\b$k\b/i } }
    }
    return (keys %ddl)[0] if keys %ddl == 1;
    return 'ddl' if keys %ddl > 1;
    return (keys %dml)[0] if keys %dml == 1;
    return 'dml' if keys %dml > 1;
    return 'other';
}
opendir(my $dh, $dir) or die "changes_dir not found: $dir\n";
my @entries = readdir $dh;
# folder-number order: 1000_ after 999_ (a plain sort puts it before 101_)
my @ids = sort { (($a =~ /^(\d+)_/)[0] <=> ($b =~ /^(\d+)_/)[0]) || $a cmp $b } grep { /^\d{3,}_/ && -d "$dir/$_" } @entries;
my @rids = sort grep { /^R__/ && -d "$dir/$_" } @entries;
closedir $dh;
my %meta;
for my $id (@ids, @rids) { my $m = -f "$dir/$id/meta.json" ? eval { JSON::PP->new->utf8->decode(rd("$dir/$id/meta.json")) } : undef; $meta{$id} = ref $m eq 'HASH' ? $m : {}; }
sub info {
    my $id = shift; my $m = $meta{$id};
    my %i = (id => $id, project => fld($m, 'project'), ptype => '', release => '', rname => '', rdate => '',
             kind => lc fld($m, 'kind'), req_by => fld($m, 'requested_by'), created_by => fld($m, 'created_by'),
             created_at => fld($m, 'created_at'), ticket => fld($m, 'ticket'), dropped => 0, reason => '',
             requires => join(',', grep { defined && !ref } @{ ref $m->{requires} eq 'ARRAY' ? $m->{requires} : [] }),
             danger => ($id =~ /(^|_)danger_/i ? 1 : 0));
    $i{kind} = kind_of(rd("$dir/$id/deploy.sql")) unless length $i{kind};
    if (lc fld($m, 'status') eq 'dropped') { my $w = fld($m, 'dropped_reason'); $i{dropped} = 1; $i{reason} = 'change not going' . (length $w ? ": $w" : ''); }
    if (length $i{project} && $proj{lc $i{project}}) {
        my $p = $proj{lc $i{project}};
        $i{project} = fld($p, 'id'); $i{ptype} = lc fld($p, 'type'); $i{release} = fld($p, 'release');
        if (length $i{release} && $rel{lc $i{release}}) { my $r = $rel{lc $i{release}}; $i{release} = fld($r, 'id'); $i{rname} = fld($r, 'name'); $i{rdate} = fld($r, 'date'); }
        if (!$i{dropped} && lc fld($p, 'status') eq 'dropped') { my $w = fld($p, 'dropped_reason'); $i{dropped} = 1; $i{reason} = "project $i{project} not going" . (length $w ? ": $w" : ''); }
    }
    return \%i;
}
if ($mode eq 'info') {
    for my $id (@ids, @rids) { my $i = info($id); print join("\x1f", @$i{qw(id project ptype release kind req_by created_by created_at ticket dropped reason requires)}), "\n"; }
} elsif ($mode eq 'issues') {
    if (length $caterr) { print "RELEASES  releases.json could not be read: $caterr\n"; exit 0; }
    if ($cat) {
        print "RELEASES  releases.json lists $_ more than once\n" for @dups;
        for my $k (@projk) {
            my $p = $proj{$k}; my $r = fld($p, 'release'); my $t = lc fld($p, 'type');
            print "PROJECT  " . fld($p, 'id') . ": release '$r' is not in releases.json\n" if length $r && !$rel{lc $r};
            print "PROJECT  " . fld($p, 'id') . ": type '$t' (use " . join(', ', @TYPES) . ")\n" if length $t && !grep { $_ eq $t } @TYPES;
        }
    }
    for my $id (@ids) {
        my $pr = fld($meta{$id}, 'project'); my $k = lc fld($meta{$id}, 'kind');
        if (length $pr) {
            if (!$cat) { print "PROJECT  $id: project '$pr' but there is no releases.json\n" }
            elsif (!$proj{lc $pr}) { print "PROJECT  $id: project '$pr' is not in releases.json\n" }
        }
        print "KIND  $id: kind '$k' (use " . join(', ', @KINDS) . ")\n" if length $k && !grep { $_ eq $k } @KINDS;
    }
} elsif ($mode eq 'resolve') {
    my ($r, $ps) = @rest; $r //= ''; $ps //= '';
    my @ps = grep { length } map { s/^\s+|\s+$//gr } split /,/, $ps;
    if (!length $r && !@ps) { print "OK\x1f\x1f\n"; exit 0; }
    if (!$cat && !length $caterr) { print "ERR\x1f--release/--project need $dir/releases.json, which does not exist\n"; exit 0; }
    if (length $caterr) { print "ERR\x1freleases.json could not be read: $caterr\n"; exit 0; }
    # --release like git revert's commits: a list (a,b) and ranges in release order (by date):
    # a..b = after a up to b, a^..b = a up to b, a.. = everything after a, ..b = up to b
    my @ord = map { $_->[1] } sort { $a->[0] cmp $b->[0] || $a->[2] <=> $b->[2] }
              map { my $x = $rel{$relk[$_]}; [ (length fld($x, 'date') ? fld($x, 'date') : fld($x, 'id')), $relk[$_], $_ ] } 0 .. $#relk;
    my %pos; @pos{@ord} = 0 .. $#ord;
    my $known = join(', ', map { fld($rel{$_}, 'id') } @ord);
    my (%want);
    for my $t (grep { length } map { s/^\s+|\s+$//gr } split /,/, $r) {
        if ($t =~ /^(.*?)(\^?)\.\.(.*)$/) {
            my ($from, $inc, $to) = ($1, $2, $3); s/^\s+|\s+$//g for $from, $to;
            for my $e (grep { length } $from, $to) { if (!exists $pos{lc $e}) { print "ERR\x1fUnknown release '$e' in '$t'. Releases in release order: $known\n"; exit 0; } }
            my $i = length $from ? $pos{lc $from} + (length $inc ? 0 : 1) : 0;
            my $j = length $to ? $pos{lc $to} : $#ord;
            if ($i > $j) { print "ERR\x1fRelease range '$t' holds no releases. Releases in release order: $known\n"; exit 0; }
            $want{$ord[$_]} = 1 for $i .. $j;
        } else {
            if (!exists $pos{lc $t}) { print "ERR\x1fUnknown release '$t'. Releases in releases.json: $known\n"; exit 0; }
            $want{lc $t} = 1;
        }
    }
    for my $p (@ps) { if (!$proj{lc $p}) { print "ERR\x1fUnknown project '$p'. Projects in releases.json: " . join(', ', map { fld($proj{$_}, 'id') } @projk) . "\n"; exit 0; } }
    print "OK\x1f" . join(',', map { fld($rel{$_}, 'id') } grep { $want{$_} } @ord) . "\x1f" . join(',', map { fld($proj{lc $_}, 'id') } @ps) . "\n";
} elsif ($mode eq 'release') {
    my ($env, $json, $show) = @rest; $show //= '';
    if (!$cat && !length $caterr) { print STDERR "No releases.json in $dir. Create releases and projects in DMCR (Releases) or add the file by hand.\n"; exit 2; }
    if (length $caterr) { print STDERR "releases.json could not be read: $caterr\n"; exit 2; }
    my %at; while (my $l = <STDIN>) { chomp $l; next unless $l =~ /=/; my ($a, $b) = split /=/, $l, 2; $at{$a} = $b; }
    my @infos = map { info($_) } @ids;
    my $state = sub { my $i = shift; exists $at{$i->{id}} ? 'applied' : $i->{dropped} ? 'dropped' : $i->{danger} ? 'manual' : 'pending' };
    my $js = JSON::PP->new->canonical;
    if (length $show) {
        my $r = $rel{lc $show};
        if (!$r) { print STDERR "Unknown release '$show'. Releases: " . join(', ', map { fld($rel{$_}, 'id') } @relk) . "\n"; exit 2; }
        my $rid = fld($r, 'id');
        my @rows = grep { $_->{release} eq $rid } @infos;
        if ($json) {
            my @ch = map { my $i = $_; my $st = $state->($i); my %e = (change_id => $i->{id}, project => $i->{project}, project_type => $i->{ptype}, kind => $i->{kind}, status => $st);
                $e{requested_by} = $i->{req_by} if length $i->{req_by}; $e{created_by} = $i->{created_by} if length $i->{created_by};
                $e{created_at} = $i->{created_at} if length $i->{created_at}; $e{ticket} = $i->{ticket} if length $i->{ticket};
                $e{applied_at} = $at{$i->{id}} if exists $at{$i->{id}}; $e{dropped_reason} = $i->{reason} if $i->{dropped}; \%e } @rows;
            print $js->encode({ release => $rid, name => fld($r, 'name'), date => fld($r, 'date'), status => fld($r, 'status'), environment => $env, changes => \@ch }), "\n";
            exit 0;
        }
        my $name = fld($r, 'name');
        print "TITLE\x1fRelease $rid" . (length $name ? " - $name" : '') . " on $env\n";
        for my $i (@rows) { my $st = $state->($i);
            print join("\t", $i->{id}, $i->{project} . (length $i->{ptype} ? " ($i->{ptype})" : ''), $i->{kind}, (length $i->{req_by} ? $i->{req_by} : '-'), (length $i->{created_by} ? $i->{created_by} : '-'), ($st eq 'applied' ? "applied $at{$i->{id}}" : $st)), "\n"; }
        exit 0;
    }
    my @groups;
    for my $k (@relk) { my $r = $rel{$k}; my $rid = fld($r, 'id');
        push @groups, { key => $rid, r => $r, rows => [ grep { $_->{release} eq $rid } @infos ], projects => [ grep { fld($_, 'release') eq $rid } map { $proj{$_} } @projk ] }; }
    my @uns = grep { length $_->{project} && !length $_->{release} } @infos;
    push @groups, { key => '(unscheduled)', rows => \@uns, projects => [] } if @uns;
    my @nop = grep { !length $_->{project} } @infos;
    push @groups, { key => '(no project)', rows => \@nop, projects => [] } if @nop;
    my @sum;
    for my $g (@groups) {
        my @st = map { $state->($_) } @{ $g->{rows} };
        my @times = sort map { $at{$_->{id}} } grep { exists $at{$_->{id}} } @{ $g->{rows} };
        push @sum, { release => $g->{key}, name => ($g->{r} ? fld($g->{r}, 'name') : ''), date => ($g->{r} ? fld($g->{r}, 'date') : ''), status => ($g->{r} ? fld($g->{r}, 'status') : ''),
            projects => [ map { { id => fld($_, 'id'), name => fld($_, 'name'), type => fld($_, 'type'), status => (length fld($_, 'status') ? fld($_, 'status') : 'active') } } @{ $g->{projects} } ],
            total => scalar(@st), applied => scalar(grep { $_ eq 'applied' } @st), pending => scalar(grep { $_ eq 'pending' || $_ eq 'manual' } @st),
            dropped => scalar(grep { $_ eq 'dropped' } @st), first_applied => ($times[0] // ''), last_applied => ($times[-1] // '') };
    }
    if ($json) { print $js->encode({ environment => $env, releases => \@sum }), "\n"; exit 0; }
    print "TITLE\x1fReleases on $env\n";
    for my $s (@sum) {
        print join("\t", $s->{release} . (length $s->{name} ? " $s->{name}" : ''), (length $s->{date} ? $s->{date} : '-'),
            (@{ $s->{projects} } ? join(', ', map { "$_->{id} ($_->{type})" . ($_->{status} eq 'dropped' ? ' dropped' : '') } @{ $s->{projects} }) : '-'),
            "$s->{applied}/$s->{total}", $s->{pending}, $s->{dropped}, (length $s->{last_applied} ? $s->{last_applied} : '-')), "\n";
    }
}
PERL
)"

_scope_perl() { perl -e "$_DMCR_SCOPE_PL" "$CFG_CHANGES_DIR" "$@"; }

load_change_infos() {
    [[ "$CI_LOADED" == "1" ]] && return 0
    CI_LOADED=1
    local id project ptype release kind req_by created_by created_at ticket dropped reason requires
    while IFS=$'\x1f' read -r id project ptype release kind req_by created_by created_at ticket dropped reason requires; do
        [[ -n "$id" ]] || continue
        CI_PROJECT["$id"]="$project"; CI_PTYPE["$id"]="$ptype"; CI_RELEASE["$id"]="$release"; CI_KIND["$id"]="$kind"
        CI_REQ_BY["$id"]="$req_by"; CI_CREATED_BY["$id"]="$created_by"; CI_CREATED_AT["$id"]="$created_at"; CI_TICKET["$id"]="$ticket"
        CI_DROPPED["$id"]="$dropped"; CI_DROP_REASON["$id"]="$reason"; CI_REQUIRES["$id"]="$requires"
    done < <(_scope_perl info)
}

json_s() {
    local s="$1"
    s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\r'/}"; s="${s//$'\t'/\\t}"
    printf '"%s"' "$s"
}

SCOPE_CHANGES="" SCOPE_DEPLOYS=""   # revert <deployment id>: the changes those deployments applied (still applied)
scope_active() { [[ -n "$SCOPE_RELEASE" || -n "$SCOPE_PROJECTS" || -n "$SCOPE_KINDS" || -n "$SCOPE_CHANGES" ]]; }

format_scope() {
    local parts=()
    if [[ "$SCOPE_DEPLOYS" == *,* ]]; then parts+=("deployments ${SCOPE_DEPLOYS//,/ }"); elif [[ -n "$SCOPE_DEPLOYS" ]]; then parts+=("deployment $SCOPE_DEPLOYS"); fi
    if [[ "$SCOPE_RELEASE" == *,* ]]; then parts+=("releases ${SCOPE_RELEASE//,/ }"); elif [[ -n "$SCOPE_RELEASE" ]]; then parts+=("release $SCOPE_RELEASE"); fi
    [[ -n "$SCOPE_PROJECTS" ]] && parts+=("project $SCOPE_PROJECTS")
    [[ -n "$SCOPE_KINDS" ]] && parts+=("kind $SCOPE_KINDS")
    local IFS=','; local s="${parts[*]+"${parts[*]}"}"; printf '%s' "${s//,/, }"
}

_csv_has() { [[ ",$1," == *",$2,"* ]]; }

# dml matches insert/update/delete/dml; ddl matches ddl/function/type
kind_match() {
    local kind="$1" k
    for k in ${SCOPE_KINDS//,/ }; do
        [[ "$k" == "$kind" ]] && return 0
        [[ "$k" == "dml" && " insert update delete dml " == *" $kind "* ]] && return 0
        [[ "$k" == "ddl" && " ddl function type " == *" $kind "* ]] && return 0
    done
    return 1
}

# in_scope <id> [include_dropped]. Dropped changes are never in scope for a deploy; a revert includes them.
in_scope() {
    local id="$1" incl="${2:-0}"
    [[ "${CI_DROPPED[$id]:-0}" == "1" && "$incl" != "1" ]] && return 1
    scope_active || return 0
    if [[ -n "$SCOPE_CHANGES" ]] && ! _csv_has "$SCOPE_CHANGES" "$id"; then return 1; fi
    if [[ -n "$SCOPE_RELEASE" ]] && ! _csv_has "$SCOPE_RELEASE" "${CI_RELEASE[$id]:-}"; then return 1; fi
    if [[ -n "$SCOPE_PROJECTS" ]] && ! _csv_has "$SCOPE_PROJECTS" "${CI_PROJECT[$id]:-}"; then return 1; fi
    if [[ -n "$SCOPE_KINDS" ]] && ! kind_match "${CI_KIND[$id]:-other}"; then return 1; fi
    return 0
}

# --release / --project must exist in releases.json; switches them to the catalog's spelling
resolve_scope() {
    [[ -n "$SCOPE_RELEASE" || -n "$SCOPE_PROJECTS" ]] || return 0
    local out st rel projs
    out="$(_scope_perl resolve "$SCOPE_RELEASE" "$SCOPE_PROJECTS")"
    IFS=$'\x1f' read -r st rel projs <<< "$out"
    if [[ "$st" != "OK" ]]; then log_error "$rel"; exit 1; fi
    SCOPE_RELEASE="$rel"; SCOPE_PROJECTS="$projs"
}

# Registry columns for the project/release/people of a change: prints ", col…" then a line ", 'val'…"
scope_record_sql() {
    local id="$1" cols="" vals="" pair name val
    for pair in "project_id:${CI_PROJECT[$id]:-}" "project_type:${CI_PTYPE[$id]:-}" "release_id:${CI_RELEASE[$id]:-}" \
                "change_kind:${CI_KIND[$id]:-}" "requested_by:${CI_REQ_BY[$id]:-}" "created_by:${CI_CREATED_BY[$id]:-}"; do
        name="${pair%%:*}"; val="${pair#*:}"
        [[ -n "$val" ]] || continue
        cols+=", $name"; vals+=", '$(escape_sql "$val")'"
    done
    printf '%s\n%s\n' "$cols" "$vals"
}

# Objects whose structure a deploy.sql changes (CREATE/ALTER/DROP targets only)
get_ddl_objects() {
    [[ -f "$1" ]] || return 0
    # ${schema}.t is matched as dmcr_ph__schema.t (an identifier) and reported as ${schema}.t again
    strip_sql_comments "$(cat "$1")" | perl -0777 -ne '
        s/\$\{([A-Za-z_]\w*)\}/dmcr_ph__$1/g;
        my %seen;
        while (/\b(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|TYPE|DOMAIN|SEQUENCE|TRIGGER\s+\S+\s+ON)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?("?[A-Za-z_][\w\$]*"?\s*\.\s*"?[A-Za-z_][\w\$]*"?)/gi) {
            (my $n = lc $1) =~ s/[\s"]//g;
            $n =~ s/^dmcr_ph__(\w+?)\./\${$1}./;
            print "$n\n" unless $seen{$n}++;
        }'
}

# Reverts the applied changes in a scope (project / release / kind), newest first. Refuses when a
# change applied later outside the scope requires one of them or builds on a structure one of them
# changed; a later change that only writes the same table's data is reported as a warning.
invoke_scoped_revert() {
    local dry_run="$1" json_out="$2"
    resolve_scope
    load_change_infos
    local label csv
    label="$(format_scope)"
    csv="$(exec_psql_scalar "SELECT coalesce(string_agg(change_id, ',' ORDER BY applied_at DESC, change_id DESC), '') FROM dmcr.change_log;")" || exit 1
    local applied=() a
    for a in ${csv//,/ }; do applied+=("$a"); done
    local targets=() id
    declare -A tset=()
    for id in "${applied[@]+"${applied[@]}"}"; do
        [[ -d "$CFG_CHANGES_DIR/$id" ]] || continue
        if in_scope "$id" 1; then targets+=("$id"); tset["$id"]=1; fi
    done
    if [[ ${#targets[@]} -eq 0 ]]; then
        if [[ "$json_out" == "1" ]]; then printf '{"status":"nothing_to_revert","scope":%s,"changes":[]}\n' "$(json_s "$label")"; else log_info "No applied changes in scope ($label)"; fi
        return 0
    fi
    declare -A written=() ddl=()
    for id in "${applied[@]}"; do
        [[ -d "$CFG_CHANGES_DIR/$id" ]] || continue
        written["$id"]="$(get_written_objects "$CFG_CHANGES_DIR/$id/deploy.sql")"
        ddl["$id"]="$(get_ddl_objects "$CFG_CHANGES_DIR/$id/deploy.sql")"
    done
    local problems=() warnings=() i j n=${#applied[@]} t later common structural
    for (( i = 0; i < n; i++ )); do
        t="${applied[$i]}"
        [[ -n "${tset[$t]:-}" ]] || continue
        if echo "$t" | grep -qiE '(^|_)danger_'; then problems+=("$t is a manual-only (danger_) change; the DBA reverts it by hand"); continue; fi
        for (( j = 0; j < i; j++ )); do
            later="${applied[$j]}"
            [[ -n "${tset[$later]:-}" ]] && continue
            [[ -d "$CFG_CHANGES_DIR/$later" ]] || continue
            if _csv_has "${CI_REQUIRES[$later]:-}" "$t"; then problems+=("$later (applied later, outside the scope) requires $t"); continue; fi
            [[ -n "${written[$t]}" && -n "${written[$later]}" ]] || continue
            common="$(grep -Fxf <(printf '%s\n' "${written[$t]}") <(printf '%s\n' "${written[$later]}") || true)"
            [[ -n "$common" ]] || continue
            structural=""
            [[ -n "${ddl[$t]}" ]] && structural="$(grep -Fxf <(printf '%s\n' "${ddl[$t]}") <(printf '%s\n' "$common") || true)"
            if [[ -n "$structural" ]]; then
                problems+=("$later (applied later, outside the scope) uses $(printf '%s' "$structural" | paste -sd, - | sed 's/,/, /g'), whose structure $t changed")
            else
                warnings+=("$later (applied later, outside the scope) also writes $(printf '%s' "$common" | paste -sd, - | sed 's/,/, /g'); check that reverting $t does not touch its rows or columns")
            fi
        done
    done
    local plan_json="" w p
    for t in "${targets[@]}"; do
        plan_json+="$([[ -n "$plan_json" ]] && printf ',')$(printf '{"change_id":%s,"project":%s,"release":%s,"kind":%s}' "$(json_s "$t")" "$(json_s "${CI_PROJECT[$t]:-}")" "$(json_s "${CI_RELEASE[$t]:-}")" "$(json_s "${CI_KIND[$t]:-}")")"
    done
    local warn_json="" prob_json=""
    for w in "${warnings[@]+"${warnings[@]}"}"; do warn_json+="$([[ -n "$warn_json" ]] && printf ',')$(json_s "$w")"; done
    for p in "${problems[@]+"${problems[@]}"}"; do prob_json+="$([[ -n "$prob_json" ]] && printf ',')$(json_s "$p")"; done
    if [[ "$json_out" == "1" && ( "$dry_run" == "1" || ${#problems[@]} -gt 0 ) ]]; then
        printf '{"status":"%s","action":"revert_scope","scope":%s,"changes":[%s],"warnings":[%s],"problems":[%s]}\n' \
            "$([[ ${#problems[@]} -gt 0 ]] && echo blocked || echo dry_run)" "$(json_s "$label")" "$plan_json" "$warn_json" "$prob_json"
        [[ ${#problems[@]} -gt 0 ]] && exit 1
        return 0
    fi
    log_info "Scoped revert ($label): ${#targets[@]} change(s), newest first: $(IFS=,; echo "${targets[*]}" | sed 's/,/, /g')"
    for w in "${warnings[@]+"${warnings[@]}"}"; do log_warn "$w"; done
    if [[ ${#problems[@]} -gt 0 ]]; then
        log_error "BLOCKED scoped revert ($label):"
        for p in "${problems[@]}"; do log_error "  >> $p"; done
        exit 1
    fi
    if [[ "$dry_run" == "1" ]]; then log_warn "DRY RUN — nothing was reverted"; return 0; fi
    acquire_advisory_lock
    for t in "${targets[@]}"; do
        if ! revert_change "$t" 1; then release_advisory_lock; exit 1; fi
    done
    release_advisory_lock
    log_done "Scoped revert ($label) complete — ${#targets[@]} change(s) reverted"
    log_info "Deployment $(short_did "$DMCR_DEPLOY_ID") on $CFG_ENV: revert of ${#targets[@]} change(s)  (dmcr deployments $(short_did "$DMCR_DEPLOY_ID"))"
    if [[ "$json_out" == "1" ]]; then
        printf '{"status":"ok","action":"revert_scope","deploy_id":%s,"scope":%s,"changes":[%s],"warnings":[%s]}\n' "$(json_s "$DMCR_DEPLOY_ID")" "$(json_s "$label")" "$plan_json" "$warn_json"
    fi
}

cmd_release() {
    local action="$1" show_id="$2" json_out="$3"
    if [[ -n "$action" && "$action" != "list" && "$action" != "show" ]]; then
        log_error "Unknown release action '$action'. Use: dmcr release [list] | dmcr release show <id>"; exit 1
    fi
    if [[ "$action" == "show" && -z "$show_id" ]]; then log_error "Usage: dmcr release show <release_id>"; exit 1; fi
    [[ "$action" == "show" ]] || show_id=""
    local applied_csv
    applied_csv="$(exec_psql_scalar "SELECT coalesce(string_agg(change_id || '=' || to_char(applied_at, 'YYYY-MM-DD HH24:MI'), ','), '') FROM dmcr.change_log;")" || exit 1
    local out rc=0
    out="$(printf '%s\n' "${applied_csv//,/$'\n'}" | _scope_perl release "$CFG_ENV" "$json_out" "$show_id" 2>&1)" || rc=$?
    if [[ $rc -ne 0 ]]; then log_error "$out"; exit 1; fi
    if [[ "$json_out" == "1" ]]; then printf '%s\n' "$out"; return 0; fi
    local title rows=() line
    while IFS= read -r line; do
        if [[ "$line" == TITLE$'\x1f'* ]]; then title="${line#TITLE$'\x1f'}"; continue; fi
        [[ -n "$line" ]] && rows+=("$line")
    done <<< "$out"
    if [[ ${#rows[@]} -eq 0 ]]; then log_info "${title}: no changes"; return 0; fi
    if [[ -n "$show_id" ]]; then
        print_boxed_table "$title" "Change|Project|Kind|Requested by|Created by|Status" "${rows[@]}"
    else
        print_boxed_table "$title" "Release|Date|Projects|Applied|Pending|Dropped|Deployed" "${rows[@]}"
    fi
}

# =============================================================================
# DANGEROUS SQL GATE
# =============================================================================
# DMCR_DANGER_RULES (set by the VS Code extension) wins over the copy next to the script
DANGER_JSON="${DMCR_DANGER_RULES:-${SCRIPT_DIR}/dmcr_danger.json}"

# Same regexes as dmcr.ps1 / dmcr_danger.json (.NET syntax, matched with perl).
_DANGER_DEPLOY_PATTERNS=(
    '(?i)\bDROP\s+TABLE\b'
    '(?i)\bDROP\s+SCHEMA\b'
    '(?i)\bDROP\s+DATABASE\b'
    '(?i)\bDROP\s+FUNCTION\b'
    '(?i)\bDROP\s+PROCEDURE\b'
    '(?i)\bDROP\s+VIEW\b'
    '(?i)\bDROP\s+TRIGGER\b'
    '(?i)\bDROP\s+INDEX\b'
    '(?i)\bDROP\s+SEQUENCE\b'
    '(?i)\bDROP\s+TYPE\b'
    '(?i)\bDROP\s+EXTENSION\b'
    '(?i)\bDROP\s+COLUMN\b'
)
_DANGER_DEPLOY_LABELS=(
    "DROP TABLE" "DROP SCHEMA" "DROP DATABASE" "DROP FUNCTION" "DROP PROCEDURE"
    "DROP VIEW" "DROP TRIGGER" "DROP INDEX" "DROP SEQUENCE" "DROP TYPE" "DROP EXTENSION" "DROP COLUMN"
)
_DANGER_ALWAYS_PATTERNS=('(?i)\bTRUNCATE\b')
_DANGER_ALWAYS_LABELS=("TRUNCATE")
_DANGER_DELETE_WITHOUT_WHERE=1
_DANGER_UPDATE_WITHOUT_WHERE=0

# Load dmcr_danger.json (same semantics as dmcr.ps1): a pattern array present in the file
# replaces the built-in list; entries with "enabled": false are skipped; the two flags
# override the defaults. Parsed with perl's core JSON::PP, so jq is not needed.
load_danger_rules() {
    [[ -f "$DANGER_JSON" ]] || return 0
    local parsed
    if ! parsed="$(perl -MJSON::PP -0777 -ne '
        my $j = eval { decode_json($_) } or exit 2;
        for my $k (qw(deployOnlyPatterns alwaysPatterns)) {
            next unless ref $j->{$k} eq "ARRAY";
            print "ARR\t$k\n";
            for my $r (@{ $j->{$k} }) {
                next if exists $r->{enabled} && !$r->{enabled};
                next unless defined $r->{regex} && length $r->{regex};
                my $label = defined $r->{label} ? $r->{label} : $r->{regex};
                print "RULE\t$k\t$label\t$r->{regex}\n";
            }
        }
        for my $k (qw(deleteWithoutWhereEnabled updateWithoutWhereEnabled)) {
            print "FLAG\t$k\t", ($j->{$k} ? 1 : 0), "\n" if exists $j->{$k};
        }' "$DANGER_JSON" 2>/dev/null)"; then
        log_warn "Could not parse $DANGER_JSON — using built-in danger rules"
        return 0
    fi
    local kind key a b
    while IFS=$'\t' read -r kind key a b; do
        case "$kind" in
            ARR)
                if [[ "$key" == "deployOnlyPatterns" ]]; then _DANGER_DEPLOY_PATTERNS=(); _DANGER_DEPLOY_LABELS=()
                else _DANGER_ALWAYS_PATTERNS=(); _DANGER_ALWAYS_LABELS=(); fi ;;
            RULE)
                if [[ "$key" == "deployOnlyPatterns" ]]; then _DANGER_DEPLOY_PATTERNS+=("$b"); _DANGER_DEPLOY_LABELS+=("$a")
                else _DANGER_ALWAYS_PATTERNS+=("$b"); _DANGER_ALWAYS_LABELS+=("$a"); fi ;;
            FLAG)
                if [[ "$key" == "deleteWithoutWhereEnabled" ]]; then _DANGER_DELETE_WITHOUT_WHERE="$a"
                else _DANGER_UPDATE_WITHOUT_WHERE="$a"; fi ;;
        esac
    done <<< "$parsed"
    log_debug "Loaded danger rules from: $DANGER_JSON"
}
load_danger_rules

# Schema-qualified objects a deploy.sql writes: CREATE/ALTER/DROP targets, INSERT INTO,
# UPDATE, DELETE FROM, TRUNCATE (reads and index builds are ignored). Lowercase, quotes removed, one per line.
get_written_objects() {
    [[ -f "$1" ]] || return 0
    # ${schema}.t is matched as dmcr_ph__schema.t (an identifier) and reported as ${schema}.t again
    strip_sql_comments "$(cat "$1")" | perl -0777 -ne '
        s/\$\{([A-Za-z_]\w*)\}/dmcr_ph__$1/g;
        my %seen;
        while (/\b(?:(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|TYPE|DOMAIN|SEQUENCE|TRIGGER\s+\S+\s+ON)|INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?("?[A-Za-z_][\w\$]*"?\s*\.\s*"?[A-Za-z_][\w\$]*"?)/gi) {
            (my $n = lc $1) =~ s/[\s"]//g;
            $n =~ s/^dmcr_ph__(\w+?)\./\${$1}./;
            next if $n =~ /^(dmcr|pg_catalog|information_schema)\./;
            print "$n\n" unless $seen{$n}++;
        }'
}

strip_sql_comments() {
    # Remove /* */ block comments and -- line comments
    local sql="$1"
    # Strip block comments (simple approach)
    # (perl for both: BSD sed treats [^\n] as "not backslash or n")
    printf '%s\n' "$sql" | perl -0777 -pe 's{/\*.*?\*/}{ }gs; s{--[^\n]*}{ }g' 2>/dev/null || printf '%s\n' "$sql"
}

# Match one danger regex (.NET / perl syntax, e.g. (?i)\bDROP\s+TABLE\b) against SQL text.
_danger_match() {
    printf '%s' "$2" | perl -0777 -e 'my $p = shift; my $s = <STDIN>; exit(($s =~ /$p/) ? 0 : 1)' "$1" 2>/dev/null
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
        if _danger_match "${_DANGER_ALWAYS_PATTERNS[$i]}" "$stripped"; then
            findings+=("${_DANGER_ALWAYS_LABELS[$i]}")
        fi
    done

    # Deploy-only patterns
    if [[ "$mode" == "deploy" ]]; then
        for i in "${!_DANGER_DEPLOY_PATTERNS[@]}"; do
            if _danger_match "${_DANGER_DEPLOY_PATTERNS[$i]}" "$stripped"; then
                findings+=("${_DANGER_DEPLOY_LABELS[$i]}")
            fi
        done
    fi

    # DELETE / UPDATE without WHERE — a real DELETE FROM / UPDATE <table> SET statement, checked
    # per statement like dmcr.ps1 (ON DELETE CASCADE, REVOKE ... FROM, DO UPDATE SET are not)
    if [[ $_DANGER_DELETE_WITHOUT_WHERE -eq 1 ]] && printf '%s' "$stripped" | perl -0777 -e '
        my $s = <STDIN>; for (split /;/, $s) { exit 0 if /\bDELETE\s+FROM\b(.*)/is && $1 !~ /\bWHERE\b/i } exit 1'; then
        findings+=("DELETE without WHERE")
    fi
    if [[ $_DANGER_UPDATE_WITHOUT_WHERE -eq 1 ]] && printf '%s' "$stripped" | perl -0777 -e '
        my $s = <STDIN>; for (split /;/, $s) { exit 0 if /\bUPDATE\s+(?:ONLY\s+)?(?:"[^"]+"|[A-Za-z_][\w\$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w\$]*))?(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s+SET\b(.*)/is && $1 !~ /\bWHERE\b/i } exit 1'; then
        findings+=("UPDATE without WHERE")
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
        id="${f##*/}"
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
        id="${f##*/}"
        local prefix
        prefix="$(echo "$id" | grep -oE '^[0-9]{3,}' || true)"
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
        id="${f##*/}"
        echo "$id" | grep -qE '^[0-9]{3,}_[[:alnum:]]' || issues+=("MALFORMED  $id — expected: 001_descriptive_name (1000_ and up after 999)")
    done

    # 4. Prefix gaps
    local prev_num=-1
    for f in "${folders[@]+"${folders[@]}"}"; do
        local id
        id="${f##*/}"
        local num
        num="$(echo "$id" | grep -oE '^[0-9]{3,}' || true)"
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

    # 5. releases.json and the project / kind of each change
    local ci
    while IFS= read -r ci; do [[ -n "$ci" ]] && issues+=("$ci"); done < <(_scope_perl issues 2>/dev/null || true)

    # 6. Dependency validation (a name table, not a scan of every folder per requires entry)
    local -A folder_names=()
    for f in "${folders[@]+"${folders[@]}"}"; do folder_names["${f##*/}"]=1; done
    for f in "${folders[@]+"${folders[@]}"}"; do
        local id
        id="${f##*/}"
        while IFS= read -r dep; do
            [[ -n "$dep" ]] || continue
            [[ -n "${folder_names[$dep]+x}" ]] || issues+=("DEPENDENCY  $id requires '$dep' which does not exist")
        done < <(read_meta_requires "$f")
    done

    printf '%s\n' "${issues[@]+"${issues[@]}"}"
}

# =============================================================================
# DEPENDENCY-AWARE PLANNER (topological sort — Kahn's algorithm)
# =============================================================================
cmd_plan() {
    local json_out="${1:-0}"
    load_change_infos

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
        id="${f##*/}"
        ids+=("$id")
        graph_requires["$id"]=""
        in_degree["$id"]="${in_degree[$id]:-0}"
        adj["$id"]="${adj[$id]:-}"
    done

    for f in "${folders[@]+"${folders[@]}"}"; do
        local id
        id="${f##*/}"
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
    IFS=$'\n' queue=($(printf '%s\n' "${queue[@]+"${queue[@]}"}" | sort_change_ids))

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
                    IFS=$'\n' queue=($(printf '%s\n' "${queue[@]}" | sort_change_ids))
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
            printf '{"change_id":"%s","status":"%s","requires":%s,"kind":"%s"%s%s%s}\n' "$oid" "$status" "$reqs_json" "${CI_KIND[$oid]:-other}" \
                "$([[ -n "${CI_PROJECT[$oid]:-}" ]] && printf ',"project":%s' "$(json_s "${CI_PROJECT[$oid]}")" || true)" \
                "$([[ -n "${CI_RELEASE[$oid]:-}" ]] && printf ',"release":%s' "$(json_s "${CI_RELEASE[$oid]}")" || true)" \
                "$([[ "${CI_DROPPED[$oid]:-0}" == "1" ]] && printf ',"dropped":true,"dropped_reason":%s' "$(json_s "${CI_DROP_REASON[$oid]}")" || true)"
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
# verify all: the verify.sql of many changes in ONE psql session instead of one psql per change (1,000
# changes: minutes -> seconds). Each still runs in its own BEGIN ... ROLLBACK, exactly like verify_change;
# psql stops at the first failure (ON_ERROR_STOP), that change gets its real error, and the next session
# goes on from the change after it. Fills VERIFY_ERR[<id>] with '' (ok) or the error.
declare -A VERIFY_ERR=()
verify_batch() {
    local ids=("$@") n=$# start=0 i end id file body tmp out exit_code psql_exe
    psql_exe="$(get_psql_exe)"
    while [[ $start -lt $n ]]; do
        tmp="$(dmcr_mktemp "dmcr_verify_all_")"
        : > "$tmp"
        for (( i = start; i < n; i++ )); do
            id="${ids[$i]}"
            file="${CFG_CHANGES_DIR}/${id}/verify.sql"
            [[ -f "$file" ]] || break   # the per-change path reports the missing file
            body="$(cat "$file")"
            if [[ ${#CFG_PLACEHOLDERS[@]} -gt 0 ]]; then body="$(resolve_placeholders "$body")"; fi
            printf 'BEGIN;\nSET LOCAL lock_timeout = '"'"'%s'"'"';\nSET LOCAL statement_timeout = '"'"'%s'"'"';\n%s\n;\nROLLBACK;\n\\echo DMCR_VERIFY_OK %s\n' \
                "$CFG_LOCK_TIMEOUT" "$CFG_STMT_TIMEOUT" "$body" "$id" >> "$tmp"
        done
        end=$i
        if [[ $end -eq $start ]]; then
            rm -f "$tmp" 2>/dev/null || true
            if verify_change "${ids[$start]}" 2>/dev/null; then VERIFY_ERR["${ids[$start]}"]=''; else VERIFY_ERR["${ids[$start]}"]="Missing file: ${CFG_CHANGES_DIR}/${ids[$start]}/verify.sql"; fi
            start=$((start + 1)); continue
        fi
        exit_code=0
        out="$("$psql_exe" "$CFG_CONN" -q -v ON_ERROR_STOP=1 -X -f "$tmp" 2>&1)" || exit_code=$?
        rm -f "$tmp" 2>/dev/null || true
        local -A ok=()
        while IFS= read -r line; do ok["${line#DMCR_VERIFY_OK }"]=1; done < <(printf '%s\n' "$out" | grep -E '^DMCR_VERIFY_OK [^ ]+$' | tr -d '\r')
        local next=$start
        while [[ $next -lt $end && -n "${ok[${ids[$next]}]+x}" ]]; do VERIFY_ERR["${ids[$next]}"]=''; next=$((next + 1)); done
        if [[ $next -ge $end ]]; then start=$end; unset ok; continue; fi
        local detail
        detail="$(printf '%s\n' "$out" | grep -E '(ERROR|FATAL|PANIC):' | head -1 | sed -E 's/.*((ERROR|FATAL|PANIC):)/\1/' || true)"
        [[ -n "$detail" ]] || detail="$(printf '%s\n' "$out" | head -3)"
        VERIFY_ERR["${ids[$next]}"]="verify.sql failed: ${CFG_CHANGES_DIR}/${ids[$next]}/verify.sql: ${detail}"
        start=$((next + 1))
        unset ok
    done
}

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
    local allow_non_latest="${2:-0}"   # 1 = scoped revert (invoke_scoped_revert checked later changes)
    if [[ "$allow_non_latest" == "1" ]]; then
        if ! is_applied "$change_id" 2>/dev/null; then log_error "'$change_id' is not applied"; return 1; fi
    else
        local latest
        latest="$(last_applied)"
        log_debug "Latest applied (from DB): '$latest'"

        if [[ "$latest" != "$change_id" ]]; then
            log_error "Refusing to revert non-latest change. Latest is '$latest'. To revert a project, release, kind of change or deployment out of order use: dmcr revert --project <id> | --release <id> [--kind <kind>] | dmcr revert <deployment id>"
            return 1
        fi
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
                        accept_change_checksums "$change_id" "deploy.sql"
                        log_warn "deploy.sql for '$change_id' was edited after it was applied — accepted (checksum_policy=repair, recorded in dmcr.event_log)"
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
    assert_no_tx_control "$change_id" "$revert_path" || return 1
    assert_no_tx_control "$change_id" "$folder_path/verify.sql" || return 1

    # revert.sql + registry delete + verify.sql in ONE transaction. verify.sql (DMCR guard
    # pattern) asserts the reverted state once the row is gone; if it fails, nothing is reverted.
    local safe_id
    safe_id="$(escape_sql "$change_id")"
    local delete_sql="DELETE FROM dmcr.change_log WHERE change_id = '${safe_id}';"
    if read_meta_no_tx "$folder_path"; then
        log_warn "$change_id reverts OUTSIDE a transaction (meta.json \"transaction\": false)"
        if ! exec_psql_file_notx "$revert_path"; then
            log_error "revert.sql failed for '$change_id'. It ran outside a transaction, so earlier statements may have been applied; '$change_id' is still recorded as applied. Fix the database or revert.sql and try again."
            exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,deploy_id,message,environment,actor) VALUES ('revert','${safe_id}','failure',${DMCR_DID_SQL},'non-transactional revert.sql failed; may be partially applied','$(escape_sql "$CFG_ENV")','$(escape_sql "$actor")');" >/dev/null 2>/dev/null || true
            return 1
        fi
        if ! exec_psql_sql_tx "${delete_sql}$(tx_verify_sql "$folder_path/verify.sql")"; then
            log_error "revert.sql for '$change_id' ran, but verify.sql failed, so the change is still recorded as applied. Check the database."
            return 1
        fi
        local elapsed=$(( SECONDS - t_start ))
        exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,deploy_id,environment,actor,duration_ms) VALUES ('revert','${safe_id}','success',${DMCR_DID_SQL},'$(escape_sql "$CFG_ENV")','$(escape_sql "$actor")',${elapsed});" >/dev/null 2>/dev/null || true
        log_done "$change_id reverted successfully (${elapsed}s, no transaction)"
        return 0
    fi
    log_info "Executing revert.sql + removing record (single transaction)"
    log_verify "$change_id (inside the revert transaction)"
    if ! exec_psql_file_tx "$revert_path" "${delete_sql}$(tx_verify_sql "$folder_path/verify.sql")"; then
        local elapsed=$(( SECONDS - t_start ))
        log_error "revert.sql or verify.sql failed — the revert was rolled back, '$change_id' is still applied"
        local safe_actor safe_env safe_msg
        safe_actor="$(escape_sql "$actor")"
        safe_env="$(escape_sql "$CFG_ENV")"
        safe_msg="$(escape_sql "revert or verify failed; rolled back")"
        exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,deploy_id,message,environment,actor,duration_ms) VALUES ('revert','${safe_id}','failure',${DMCR_DID_SQL},'${safe_msg}','${safe_env}','${safe_actor}',${elapsed});" >/dev/null 2>/dev/null || true
        return 1
    fi

    local elapsed=$(( SECONDS - t_start ))
    local safe_actor safe_env
    safe_actor="$(escape_sql "$actor")"
    safe_env="$(escape_sql "$CFG_ENV")"
    exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,deploy_id,environment,actor,duration_ms) VALUES ('revert','${safe_id}','success',${DMCR_DID_SQL},'${safe_env}','${safe_actor}',${elapsed});" >/dev/null 2>/dev/null || true
    log_done "$change_id reverted successfully (${elapsed}s)"
}

revert_to() {
    local target="$1"
    local keep_target="${2:-0}"   # 1 = stop before reverting the target (used for @tags)
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
        [[ "$keep_target" == "1" && "$last" == "$target" ]] && break
        [[ "$last" == "$prev_last" ]] && { log_error "Revert-to is stuck: last='$last' unchanged. Aborting."; return 1; }
        prev_last="$last"
        revert_change "$last" || return 1
        [[ "$last" == "$target" ]] && break
    done
    if [[ "$keep_target" == "1" ]]; then log_done "Reverted to $target (kept applied)"; else log_done "Reverted to $target"; fi
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
    msg="$(printf '%s\n' "$out" | sed -n 's/^.*ERROR:  //p' | head -1)"
    [[ -n "$msg" ]] || msg="$(printf '%s\n' "$out" | head -1)"
    local line_num=""
    line_num="$(printf '%s\n' "$out" | sed -n 's/^LINE \([0-9][0-9]*\).*/\1/p' | head -1)"

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
    local json_out="${1:-0}"
    local conn_redacted
    conn_redacted="$(redact_conn "$CFG_CONN")"
    local ph_count=${#CFG_PLACEHOLDERS[@]}
    local ph_str="none"
    [[ $ph_count -gt 0 ]] && ph_str="$ph_count defined"

    if [[ "$json_out" == "1" ]]; then
        local psql_path_val="${CFG_PSQL_PATH:-auto}"
        printf '{"command":"show_config","path":"%s","env":"%s","changes_dir":"%s","psql_path":"%s","lock_timeout":"%s","stmt_timeout":"%s","checksum_policy":"%s","placeholders":"%s","conn":"%s"}\n' \
            "$CFG_CONFIG_PATH" "$CFG_ENV" "$CFG_CHANGES_DIR" "$psql_path_val" \
            "$CFG_LOCK_TIMEOUT" "$CFG_STMT_TIMEOUT" "$CFG_CHECKSUM_POLICY" \
            "$ph_str" "$conn_redacted"
        return 0
    fi

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
    printf "${y}    test [--to <id|@tag>] ${gr}  Round-trip pending changes (deploy, verify, revert, verify; schema and data must match) in one transaction, then roll back.${r}\n"
    printf "${y}    test --only <id,id,...> ${gr}  Round-trip only these; the other pending changes up to --to are only applied inside the test (no checks) and rolled back too.${r}\n"
    printf "${y}    status                ${gr}  Show APPLIED / PENDING for every change folder.${r}\n"
    printf "${y}    verify                ${gr}  Run verify.sql for the last applied change.${r}\n"
    printf "${y}    verify all            ${gr}  Run verify.sql for every applied change.${r}\n"
    printf "${y}    verify <change_id>    ${gr}  Run verify.sql for a specific change.${r}\n"
    printf "${y}    parse [sql]           ${gr}  Validate SQL inside a rolled-back transaction.${r}\n"
    printf "${y}    repeatable            ${gr}  Apply all R__* migrations with changed checksums.${r}\n"
    printf "${y}    manual-script <id>    ${gr}  One-transaction script a DBA runs by hand for a danger_ change.${r}\n"
    printf "${y}    approve <id>|--release${gr}  Sign off pending changes for --env (--by, --note, --revoke); [env] approval = required gates deploy.${r}\n"
    printf "${y}    approvals             ${gr}  Pending changes and their approval on --env.${r}\n"
    printf "\n"
    printf "${g}  REVERT COMMANDS${r}\n"
    printf "${y}    revert <change_id>    ${gr}  Revert a specific change (must be latest).${r}\n"
    printf "${y}    revert to <id|@tag>   ${gr}  Revert all changes down to and including target.${r}\n"
    printf "${y}    revert list           ${gr}  List all applied changes in reverse order.${r}\n"
    printf "${y}    revertLast            ${gr}  Revert the most recently applied change.${r}\n"
    printf "${y}    revert --project <id> ${gr}  Revert every applied change of a project, newest first (any position).${r}\n"
    printf "${y}    diff [<env> [<env>]] | diff <change_id> ${gr}  Like git diff: this env vs the change files; two envs; or one change's lines since it was applied.${r}\n"
    printf "${y}    show <change_id|deploy-id> ${gr}  Like git show: a change (who, what, state here, deploy.sql) or a deployment.${r}\n"
    printf "${y}    log [--oneline] [<id>] ${gr}  Deploy / revert runs, newest first, like git log (--oneline: one line each); <id>: one run, like git show.${r}\n"
    printf "${y}    deployments [<id>]    ${gr}  Deploy / revert runs, newest first, each with its id (like git log); one run change by change (like git show).${r}\n"
    printf "${y}    revert <deploy-id> [<id> ...] ${gr}  Revert what those deployments applied, newest first (like git revert <commit>); a unique prefix is enough.${r}\n"
    printf "${y}    revert --release <id> ${gr}  Revert every applied change of a release, newest first.${r}\n"
    printf "${y}    revert --release a,b | a..b | a^..b | a.. ${gr}  Several releases, like git revert: a list, or a range in release (date) order (a..b = after a up to b; a^..b includes a).${r}\n"
    printf "${y}      ... --kind <kind>   ${gr}  Only changes of this kind, e.g. --project B --kind update. Add --dry-run to preview.${r}\n"
    printf "\n"
    printf "${g}  RELEASE COMMANDS${r}\n"
    printf "${y}    release [list]        ${gr}  Releases in releases.json with applied / pending / dropped counts here.${r}\n"
    printf "${y}    release show <id>     ${gr}  Every change of a release: project, kind, requested by, created by, status.${r}\n"
    printf "${y}    deploy --release <id> ${gr}  Deploy only that release's changes (dropped changes are always skipped).${r}\n"
    printf "${y}    deploy --project <id> ${gr}  Deploy only that project's changes (comma-separate several).${r}\n"
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
    printf "${y}    repair --unlock              ${gr}  Clear the deploy lock left by a crashed run.${r}\n"
    printf "\n"
    printf "${g}  GLOBAL OPTIONS${r}\n"
    printf "${y}    --dry-run             ${gr}  (deploy) Print pending SQL without executing.${r}\n"
    printf "${y}    --allow-prod          ${gr}  (test) Allow 'test' against an environment named prod.${r}\n"
    printf "${y}    --to <id|@tag>        ${gr}  Stop at a specific change_id or release tag.${r}\n"
    printf "${y}    --release <id>        ${gr}  (deploy/revert/status) Only changes whose project is in this release.${r}\n"
    printf "${y}    --project <id[,id]>   ${gr}  (deploy/revert/status) Only changes of these projects.${r}\n"
    printf "${y}    --kind <kind[,kind]>  ${gr}  insert, update, delete, dml, ddl, function, type, other (dml/ddl match their family).${r}\n"
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
    local test_only=""
    local allow_prod=0
    local config_path="${DMCR_CONFIG:-${SCRIPT_DIR}/dmcr.cfg}"
    local env_override=""
    local scope_release="" scope_project="" scope_kind=""
    local approve_by="" approve_note="" revoke=0
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
            --allow-prod) allow_prod=1 ;;
            --revoke)    revoke=1 ;;
            --by|--note)
                i=$((i+1))
                [[ $i -gt $# ]] && { log_error "Missing value for $t"; exit 1; }
                if [[ "$t" == "--by" ]]; then approve_by="${!i}"; else approve_note="${!i}"; fi
                ;;
            --json)      json_out=1; _JSON_MODE=1 ;;
            --to)
                i=$((i+1))
                [[ $i -gt $# ]] && { log_error "Missing value for --to"; exit 1; }
                deploy_to="${!i}"
                ;;
            --only)
                i=$((i+1))
                [[ $i -gt $# ]] && { log_error "Missing value for --only"; exit 1; }
                test_only="${!i}"
                ;;
            --env)
                i=$((i+1))
                [[ $i -gt $# ]] && { log_error "Missing value for --env"; exit 1; }
                env_override="${!i}"
                ;;
            --release|--project|--kind)
                i=$((i+1))
                [[ $i -gt $# ]] && { log_error "Missing value for $t"; exit 1; }
                case "$t" in --release) scope_release="${!i}" ;; --project) scope_project="${!i}" ;; --kind) scope_kind="${!i}" ;; esac
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

    # --release / --project / --kind
    SCOPE_RELEASE="$(printf '%s' "$scope_release" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    SCOPE_PROJECTS="$(printf '%s' "$scope_project" | tr -d ' ')"
    SCOPE_KINDS="$(printf '%s' "$scope_kind" | tr -d ' ' | tr '[:upper:]' '[:lower:]')"
    local sk
    for sk in ${SCOPE_KINDS//,/ }; do
        [[ " $CHANGE_KINDS " == *" $sk "* ]] || { log_error "Unknown --kind '$sk'. Use: ${CHANGE_KINDS// /, }"; exit 1; }
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
        split_conn_password
        log_debug "--env override applied: CFG_ENV=$CFG_ENV"
    fi

    # The environment's schema (e.g. [test] schema = zp_st) is the ${schema} placeholder; DMCR_PLACEHOLDER_SCHEMA still wins
    local env_schema
    env_schema="$(ini_get "$CFG_ENV" "schema" "")"
    if [[ -n "$env_schema" && -z "${DMCR_PLACEHOLDER_SCHEMA:-}" ]]; then
        CFG_PLACEHOLDERS["schema"]="$env_schema"
    fi

    if [[ "$DMCR_DEBUG" == "1" ]]; then
        cmd_show_config 0
        log_debug "Command=$command arg1=$arg1 arg2=$arg2"
    fi

    case "$command" in deploy|revert) new_deployment_id ;; esac
    # dmcr show <deployment id> is dmcr log <id> (like git show <commit>)
    if [[ "$command" == "show" && "$arg1" =~ ^[0-9a-fA-F]{4,40}$ && ! -d "$CFG_CHANGES_DIR/$arg1" ]]; then command="log"; positional=(log "$arg1"); fi

    case "$command" in
        show)
            # dmcr show config | dmcr show <deployment id> (like git show <commit>) | dmcr show <change_id>
            if [[ "$arg1" == "config" ]]; then cmd_show_config "$json_out"
            elif [[ -n "$arg1" && -d "$CFG_CHANGES_DIR/$arg1" ]]; then require_registry; cmd_show_change "$json_out" "$arg1"
            else show_help; fi
            return 0
            ;;
        init)
            log_init "Creating DMCR registry"
            local ddl_file="${SCRIPT_DIR}/dmcr_change_log_ddl.sql"
            if [[ ! -f "$ddl_file" ]]; then
                log_error "DDL file not found: $ddl_file"
                if [[ $json_out -eq 1 ]]; then printf '{"command":"init","status":"error","message":"DDL file not found: %s"}\n' "$ddl_file"; fi
                exit 1
            fi
            exec_psql_file_tx "$ddl_file" ""
            log_done "DMCR registry ready"
            if [[ $json_out -eq 1 ]]; then printf '{"command":"init","status":"ok","message":"DMCR registry ready"}\n'; fi
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
            # the registry in one query, not one per change (each psql call starts a process)
            local applied_csv
            applied_csv="$(exec_psql_scalar "SELECT coalesce(string_agg(change_id, ','), '') FROM dmcr.change_log;" 2>/dev/null || echo "")"
            local folders=()
            while IFS= read -r f; do [[ -n "$f" ]] && folders+=("$f"); done \
                < <(get_change_folders "$CFG_CHANGES_DIR")

            resolve_scope
            load_change_infos
            if [[ $json_out -eq 1 ]]; then
                printf '[\n'
                local first=1
                for f in "${folders[@]+"${folders[@]}"}"; do
                    local id
                    id="${f##*/}"
                    scope_active && ! in_scope "$id" 1 && continue
                    local status="pending"
                    [[ ",$applied_csv," == *",$id,"* ]] && status="applied" || true
                    [[ $first -eq 0 ]] && printf ','
                    local extra="" pair
                    for pair in "project:${CI_PROJECT[$id]:-}" "project_type:${CI_PTYPE[$id]:-}" "release:${CI_RELEASE[$id]:-}" "requested_by:${CI_REQ_BY[$id]:-}" "created_by:${CI_CREATED_BY[$id]:-}" "ticket:${CI_TICKET[$id]:-}"; do
                        [[ -n "${pair#*:}" ]] && extra+=",\"${pair%%:*}\":$(json_s "${pair#*:}")"
                    done
                    [[ "${CI_DROPPED[$id]:-0}" == "1" ]] && extra+=",\"dropped\":true,\"dropped_reason\":$(json_s "${CI_DROP_REASON[$id]}")"
                    printf '{"change_id":"%s","status":"%s","kind":"%s"%s}\n' "$id" "$status" "${CI_KIND[$id]:-other}" "$extra"
                    first=0
                done
                printf ']\n'
                return 0
            fi

            if [[ ${#folders[@]} -eq 0 ]]; then log_info "No change folders in $CFG_CHANGES_DIR"; return 0; fi
            local rows=()
            for f in "${folders[@]+"${folders[@]}"}"; do
                local id
                id="${f##*/}"
                scope_active && ! in_scope "$id" 1 && continue
                local mark="PENDING"
                # not applied and not going (change or project dropped): deploy skips it
                [[ "${CI_DROPPED[$id]:-0}" == "1" ]] && mark="NOT GOING"
                [[ ",$applied_csv," == *",$id,"* ]] && mark="APPLIED" || true
                rows+=("${mark}	${id}")
            done
            print_boxed_table "Change Status" "Status|Change" "${rows[@]+"${rows[@]}"}"
            ;;

        # ---- DEPLOY ----
        test)
            if echo "$CFG_ENV" | grep -qi 'prod' && [[ $allow_prod -eq 0 ]]; then
                log_error "Refusing to run 'test' against environment '$CFG_ENV': it holds locks on the tables it changes until it rolls back. Run it against staging or a copy of production, or add --allow-prod."
                exit 1
            fi
            require_registry
            local test_to=""
            if [[ -n "$deploy_to" ]]; then
                if [[ "$deploy_to" == @* ]]; then test_to="$(get_tag_change_id "${deploy_to:1}")"; else test_to="$deploy_to"; fi
            fi
            [[ $json_out -eq 1 ]] || log_info "Round-trip test of pending changes on '$CFG_ENV' (rolled back at the end)"
            run_roundtrip_test "$test_to" "$json_out" "$test_only" || exit 1
            ;;

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

            # Release / project / kind scope; dropped changes are skipped with or without one
            resolve_scope
            load_change_infos
            if scope_active; then
                local in_count=0
                for f in "${folders[@]+"${folders[@]}"}"; do in_scope "${f##*/}" && in_count=$((in_count+1)); done
                log_info "Scope: $(format_scope) — ${in_count} of ${#folders[@]} change(s) in scope"
            fi

            # Dry run
            if [[ $dry_run -eq 1 ]]; then
                local pending=() dropped_json="" reached_to=0
                for f in "${folders[@]+"${folders[@]}"}"; do
                    local id
                    id="${f##*/}"
                    # up to --to, as the deploy itself stops there
                    [[ $reached_to -eq 1 ]] && break
                    [[ -n "$stop_at_id" && "$id" == "$stop_at_id" ]] && reached_to=1
                    # only the dropped changes of this --release/--project/--kind, not every dropped change
                    if [[ "${CI_DROPPED[$id]:-0}" == "1" ]] && in_scope "$id" 1; then
                        dropped_json+="$([[ -n "$dropped_json" ]] && printf ',')$(printf '{"change_id":%s,"reason":%s}' "$(json_s "$id")" "$(json_s "${CI_DROP_REASON[$id]}")")"
                    fi
                    echo "$id" | grep -qiE '(^|_)danger_' && continue
                    in_scope "$id" || continue
                    is_applied "$id" 2>/dev/null && continue
                    pending+=("$f")
                done
                # repeatables (R__) in scope whose deploy.sql changed: deploy re-applies them after the changes
                local r_pending=() rf rid
                while IFS= read -r rf; do
                    [[ -n "$rf" && -f "$rf/deploy.sql" ]] || continue
                    rid="$(basename "$rf")"
                    if scope_active; then load_change_infos; in_scope "$rid" || continue; fi
                    repeatable_needs_run "$rf" 2>/dev/null || continue
                    r_pending+=("$rid")
                done < <(get_repeatable_folders "$CFG_CHANGES_DIR" 2>/dev/null || true)
                # The guards a real deploy runs first (promotion gate, out of order, requires, edited
                # applied files): a dry run reports whether the deploy would be refused
                local blockers=() plan_out
                if ! plan_out="$(assert_deploy_plan "$stop_at_id" "${folders[@]+"${folders[@]}"}" 2>&1)"; then
                    blockers+=("$(printf '%s\n' "$plan_out" | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'BLOCKED|>>' | sed 's/^[^A-Za-z0-9>]*//' | paste -sd' ' -)")
                fi
                if [[ "$CFG_CHECKSUM_POLICY" != "warn" && "$CFG_CHECKSUM_POLICY" != "repair" ]]; then
                    local dd=() d
                    while IFS= read -r d; do [[ -n "$d" ]] && dd+=("${d// //}"); done < <(list_drifted_changes)
                    [[ ${#dd[@]} -gt 0 ]] && blockers+=("applied change files edited since they were deployed: ${dd[*]} (checksum_policy=${CFG_CHECKSUM_POLICY})")
                fi
                if [[ ${#pending[@]} -eq 0 && ${#r_pending[@]} -eq 0 && ${#blockers[@]} -eq 0 ]]; then
                    [[ $json_out -eq 1 ]] && printf '{"status":"ok","message":"Nothing to deploy","changes":[]}\n' || log_info "Dry-run: nothing to deploy"
                    return 0
                fi
                if [[ $json_out -eq 1 ]]; then
                    printf '{"status":"dry_run","count":%d,"scope":%s,"changes":[' "${#pending[@]}" "$(json_s "$(format_scope)")"
                    local first=1
                    for f in "${pending[@]}"; do
                        local id
                        id="${f##*/}"
                        [[ $first -eq 0 ]] && printf ','
                        printf '{"change_id":"%s","project":%s,"release":%s,"kind":%s}\n' "$id" "$(json_s "${CI_PROJECT[$id]:-}")" "$(json_s "${CI_RELEASE[$id]:-}")" "$(json_s "${CI_KIND[$id]:-}")"
                        first=0
                    done
                    local r_json="" r
                    for r in "${r_pending[@]+"${r_pending[@]}"}"; do r_json+="$([[ -n "$r_json" ]] && printf ',')$(json_s "$r")"; done
                    local b_json="" b
                    for b in "${blockers[@]+"${blockers[@]}"}"; do b_json+="$([[ -n "$b_json" ]] && printf ',')$(json_s "$b")"; done
                    printf '],"dropped":[%s],"repeatable":[%s],"blocked":[%s]}\n' "$dropped_json" "$r_json" "$b_json"
                    return 0
                fi
                [[ ${#pending[@]} -gt 0 ]] && log_warn "DRY RUN — ${#pending[@]} change(s) would be deployed:"
                for f in "${pending[@]}"; do
                    local id
                    id="${f##*/}"
                    log_info "--- $id ---"
                    [[ -f "$f/deploy.sql" ]] && cat "$f/deploy.sql" || log_warn "  deploy.sql not found"
                done
                for rid in "${r_pending[@]+"${r_pending[@]}"}"; do log_warn "DRY RUN — repeatable $rid would be re-applied (its deploy.sql changed)"; done
                local blk
                for blk in "${blockers[@]+"${blockers[@]}"}"; do log_error "DRY RUN — the deploy would be BLOCKED: $blk"; done
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

            if [[ -n "$stop_at_id" ]]; then
                local to_found=0 tf
                for tf in "${folders[@]+"${folders[@]}"}"; do [[ "$(basename "$tf")" == "$stop_at_id" ]] && to_found=1; done
                if [[ $to_found -eq 0 ]]; then
                    log_error "--to target '$stop_at_id' does not match any change folder in $CFG_CHANGES_DIR"
                    exit 1
                fi
            fi

            assert_deploy_plan "$stop_at_id" "${folders[@]+"${folders[@]}"}" || exit 1

            acquire_advisory_lock
            local deploy_results=()
            local deploy_failed=0

            # Applied changes must still match what was deployed (checksum_policy)
            local drifted=() d
            while IFS= read -r d; do [[ -n "$d" ]] && drifted+=("${d// //}"); done < <(list_drifted_changes)
            if [[ ${#drifted[@]} -gt 0 ]]; then
                case "$CFG_CHECKSUM_POLICY" in
                    warn)
                        log_warn "Applied change files edited since they were deployed: ${drifted[*]} (checksum_policy=warn — continuing)" ;;
                    repair)
                        local did
                        for did in $(printf '%s\n' "${drifted[@]}" | sed 's#/.*##' | sort -u); do
                            accept_change_checksums "$did" "$(printf '%s\n' "${drifted[@]}" | grep "^${did}/" | sed 's#^[^/]*/##' | paste -sd, -)"
                        done
                        log_warn "Accepted edited applied change files: ${drifted[*]} (checksum_policy=repair — recorded in dmcr.event_log)" ;;
                    *)
                        log_error "BLOCKED: applied change files edited since they were deployed: ${drifted[*]}. Restore them, or accept the edit with: dmcr repair --checksums (checksum_policy=${CFG_CHECKSUM_POLICY})"
                        release_advisory_lock
                        exit 1 ;;
                esac
            fi

            local f
            for f in "${folders[@]+"${folders[@]}"}"; do
                local id
                id="${f##*/}"
                log_info "Evaluating change: $id"

                if is_applied "$id" 2>/dev/null; then
                    log_skip "$id already applied"
                    if [[ -n "$stop_at_id" && "$id" == "$stop_at_id" ]]; then
                        log_info "Reached --to target '$stop_at_id' (already applied) — stopping"
                        break
                    fi
                    continue
                fi

                # Dropped changes and changes outside --release/--project/--kind
                if ! in_scope "$id"; then
                    if [[ "${CI_DROPPED[$id]:-0}" == "1" ]] && in_scope "$id" 1; then
                        log_skip "$id — ${CI_DROP_REASON[$id]}"
                        deploy_results+=("{\"change_id\":\"${id}\",\"status\":\"dropped\",\"reason\":$(json_s "${CI_DROP_REASON[$id]}")}")
                    else
                        log_skip "$id — outside the scope (project ${CI_PROJECT[$id]:-(none)}, release ${CI_RELEASE[$id]:-(none)}, kind ${CI_KIND[$id]:-other})"
                    fi
                    if [[ -n "$stop_at_id" && "$id" == "$stop_at_id" ]]; then
                        log_info "Reached --to target '$stop_at_id' — stopping deploy"
                        break
                    fi
                    continue
                fi

                if echo "$id" | grep -qiE '(^|_)danger_'; then
                    log_skip "$id — manual-only (danger_): the DBA runs it by hand; script: dmcr manual-script $id --env $CFG_ENV"
                    deploy_results+=("{\"change_id\":\"${id}\",\"status\":\"manual\",\"reason\":\"danger_ change: the DBA runs deploy.sql by hand\"}")
                    if [[ -n "$stop_at_id" && "$id" == "$stop_at_id" ]]; then
                        log_info "Reached --to target '$stop_at_id' — stopping deploy"
                        break
                    fi
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

                # Dependencies: every meta.json `requires` must already be applied
                local req req_missing=""
                while IFS= read -r req; do
                    [[ -n "$req" ]] || continue
                    if ! is_applied "$req" 2>/dev/null; then req_missing="$req"; break; fi
                done < <(read_meta_requires "$f")
                if [[ -n "$req_missing" ]]; then
                    log_error "'$id' requires '$req_missing', which is not applied. Deploy '$req_missing' first (folders deploy in number order), or fix meta.json."
                    deploy_failed=1
                    break
                fi

                # Transaction guard: no COMMIT/BEGIN/\c inside change files
                if ! assert_no_tx_control "$id" "$f/deploy.sql" || ! assert_no_tx_control "$id" "$f/verify.sql"; then
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
                local scope_sql
                scope_sql="$(scope_record_sql "$id")"
                insert_cols+="$(printf '%s\n' "$scope_sql" | sed -n 1p)"
                insert_vals+="$(printf '%s\n' "$scope_sql" | sed -n 2p)"

                insert_cols+=", deploy_id"; insert_vals+=", ${DMCR_DID_SQL}"
                local record_sql="INSERT INTO dmcr.change_log(${insert_cols}) VALUES (${insert_vals});"
                # The success event commits with the change; its duration is the time so far plus this transaction
                local event_sql="INSERT INTO dmcr.event_log(action,change_id,status,deploy_id,environment,actor,duration_ms) VALUES ('deploy','${safe_id}','success',${DMCR_DID_SQL},'${safe_env}','${safe_actor}',$(( (SECONDS - t_start) * 1000 )) + (extract(epoch FROM clock_timestamp() - now()) * 1000)::int);"
                # The applied-state cache stays valid: this change is added once it committed
                registry_cache_hold

                if read_meta_no_tx "$f"; then
                    # meta.json "transaction": false — deploy.sql runs statement by statement
                    # (e.g. CREATE INDEX CONCURRENTLY), then registry row + verify in a transaction.
                    # If anything fails, revert.sql (re-runnable by rule) puts the database back.
                    if ! assert_rerunnable_notx "$id" "$f"; then deploy_failed=1; break; fi
                    log_warn "$id runs OUTSIDE a transaction (meta.json \"transaction\": false)"
                    if ! exec_psql_file_notx "$deploy_file"; then
                        local elapsed=$(( SECONDS - t_start ))
                        local cleanup="cleaned up with revert.sql"
                        if ! exec_psql_file_notx "$revert_file"; then cleanup="CLEANUP FAILED — revert.sql also failed; inspect the database"; fi
                        log_error "deploy.sql failed for $id outside a transaction; ${cleanup}. Nothing was recorded."
                        exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,deploy_id,message,environment,actor,duration_ms) VALUES ('deploy','${safe_id}','failure',${DMCR_DID_SQL},'$(escape_sql "non-transactional deploy.sql failed; ${cleanup}")','${safe_env}','${safe_actor}',${elapsed});" >/dev/null 2>/dev/null || true
                        deploy_results+=("{\"change_id\":\"${id}\",\"status\":\"failure\"}")
                        deploy_failed=1
                        break
                    fi
                    log_verify "$id (with the registry update)"
                    if ! exec_psql_sql_tx "${record_sql}${event_sql}$(tx_verify_sql "$verify_file")"; then
                        local elapsed=$(( SECONDS - t_start ))
                        local cleanup="cleaned up with revert.sql"
                        if ! exec_psql_file_notx "$revert_file"; then cleanup="CLEANUP FAILED — revert.sql also failed; inspect the database"; fi
                        log_error "verify.sql failed for $id; ${cleanup}. Nothing was recorded."
                        exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,deploy_id,message,environment,actor,duration_ms) VALUES ('deploy','${safe_id}','failure',${DMCR_DID_SQL},'$(escape_sql "non-transactional change failed verify; ${cleanup}")','${safe_env}','${safe_actor}',${elapsed});" >/dev/null 2>/dev/null || true
                        deploy_results+=("{\"change_id\":\"${id}\",\"status\":\"failure\"}")
                        deploy_failed=1
                        break
                    fi
                    local elapsed=$(( SECONDS - t_start ))
                    registry_cache_add "$id"
                    deploy_results+=("{\"change_id\":\"${id}\",\"status\":\"success\",\"duration_s\":${elapsed}}")
                    log_done "$id applied successfully (${elapsed}s, no transaction)"
                    if [[ -n "$stop_at_id" && "$id" == "$stop_at_id" ]]; then
                        log_info "Reached --to target '$stop_at_id' — stopping deploy"
                        break
                    fi
                    continue
                fi

                # deploy.sql + registry row + verify.sql commit together, or not at all.
                log_info "Executing deploy.sql + recording change (single transaction)"
                log_verify "$id (inside the deploy transaction)"
                if ! exec_psql_file_tx "$deploy_file" "${record_sql}${event_sql}$(tx_verify_sql "$verify_file")"; then
                    local elapsed=$(( SECONDS - t_start ))
                    log_error "deploy.sql or verify.sql failed for $id — the whole change was rolled back, nothing was applied"
                    exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,deploy_id,message,environment,actor,duration_ms) VALUES ('deploy','${safe_id}','failure',${DMCR_DID_SQL},'deploy or verify failed; rolled back','${safe_env}','${safe_actor}',${elapsed});" >/dev/null 2>/dev/null || true
                    deploy_results+=("{\"change_id\":\"${id}\",\"status\":\"failure\"}")
                    deploy_failed=1
                    break
                fi

                local elapsed=$(( SECONDS - t_start ))
                registry_cache_add "$id"
                deploy_results+=("{\"change_id\":\"${id}\",\"status\":\"success\",\"duration_s\":${elapsed}}")
                log_done "$id applied successfully (${elapsed}s)"

                if [[ -n "$stop_at_id" && "$id" == "$stop_at_id" ]]; then
                    log_info "Reached --to target '$stop_at_id' — stopping deploy"
                    break
                fi
            done

            release_advisory_lock

            local did_n=0 did_r
            for did_r in "${deploy_results[@]+"${deploy_results[@]}"}"; do [[ "$did_r" == *'"status":"success"'* ]] && did_n=$((did_n+1)); done
            if [[ $did_n -gt 0 || $deploy_failed -eq 1 ]]; then
                log_info "Deployment $(short_did "$DMCR_DEPLOY_ID") on $CFG_ENV: ${did_n} change(s) applied$([[ $deploy_failed -eq 1 ]] && printf ', then a failure')  (dmcr deployments $(short_did "$DMCR_DEPLOY_ID"); undo with dmcr revert $(short_did "$DMCR_DEPLOY_ID"))"
            fi

            [[ $deploy_failed -eq 1 ]] && exit 1

            # Repeatable migrations
            local r_folders=()
            while IFS= read -r rf; do [[ -n "$rf" ]] && r_folders+=("$rf"); done \
                < <(get_repeatable_folders "$CFG_CHANGES_DIR" 2>/dev/null || true)

            # Lock only when a repeatable in scope changed (checked again under the lock)
            local r_needed=0
            for rf in "${r_folders[@]+"${r_folders[@]}"}"; do
                if scope_active; then load_change_infos; in_scope "$(basename "$rf")" || continue; fi
                if repeatable_needs_run "$rf" 2>/dev/null; then r_needed=1; break; fi
            done
            [[ ${#r_folders[@]} -gt 0 && $r_needed -eq 0 ]] && log_info "Repeatable migrations unchanged"
            if [[ $r_needed -eq 1 ]]; then
                log_info "Checking repeatable migrations..."
                acquire_advisory_lock
                for rf in "${r_folders[@]}"; do
                    local rid
                    rid="$(basename "$rf")"
                    local rfile="$rf/deploy.sql"
                    [[ -f "$rfile" ]] || continue
                    # a --project / --release / --kind deploy re-applies only the repeatables in its scope
                    if scope_active; then
                        load_change_infos
                        if ! in_scope "$rid"; then log_skip "$rid — outside $(format_scope)"; continue; fi
                    fi
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
                    assert_no_tx_control "$rid" "$rfile" || continue
                    assert_no_tx_control "$rid" "$rf/verify.sql" || continue
                    local safe_rid safe_rchk safe_renv safe_ractor
                    safe_rid="$(escape_sql "$rid")"
                    safe_rchk="$(escape_sql "$rchk")"
                    safe_renv="$(escape_sql "$CFG_ENV")"
                    safe_ractor="$(escape_sql "$ractor")"
                    # deploy.sql + checksum record + verify.sql commit together
                    local r_upsert="INSERT INTO dmcr.repeatable_log(change_id,last_checksum,applied_at,environment,actor) VALUES ('${safe_rid}','${safe_rchk}',now(),'${safe_renv}','${safe_ractor}') ON CONFLICT (change_id) DO UPDATE SET last_checksum=EXCLUDED.last_checksum,applied_at=EXCLUDED.applied_at,environment=EXCLUDED.environment,actor=EXCLUDED.actor;"
                    exec_psql_file_tx "$rfile" "${r_upsert}$(tx_verify_sql "$rf/verify.sql")" || { log_error "Repeatable $rid failed — rolled back"; continue; }
                    local relapsed=$(( SECONDS - rt_start ))
                    deploy_results+=("{\"change_id\":\"${rid}\",\"status\":\"applied\",\"duration_s\":${relapsed}}")
                    log_done "$rid applied (${relapsed}s)"
                done
                release_advisory_lock
            fi

            if [[ $json_out -eq 1 && ${#deploy_results[@]} -gt 0 ]]; then
                printf '{"status":"ok","deploy_id":%s,"changes":[%s]}\n' "$([[ ${did_n:-0} -gt 0 ]] && json_s "$DMCR_DEPLOY_ID" || echo null)" "$(IFS=,; echo "${deploy_results[*]}")"
            fi
            ;;

        # ---- VERIFY ----
        verify)
            if [[ "$arg1" == "all" ]]; then
                local folders=()
                while IFS= read -r f; do [[ -n "$f" ]] && folders+=("$f"); done \
                    < <(get_change_folders "$CFG_CHANGES_DIR")
                local vresults=() applied_f=()
                for f in "${folders[@]+"${folders[@]}"}"; do
                    is_applied "${f##*/}" 2>/dev/null && applied_f+=("$f")
                done
                # A failing verify whose objects a later applied change rewrote is "superseded":
                # its verify.sql describes an older state (seed later updated, function replaced).
                local ai bi n=${#applied_f[@]}
                # one psql session for all of them (one more per failure), each verify in its own rolled-back transaction
                local vids=() vf
                for vf in "${applied_f[@]+"${applied_f[@]}"}"; do vids+=("${vf##*/}"); done
                verify_batch "${vids[@]+"${vids[@]}"}"
                for (( ai = 0; ai < n; ai++ )); do
                    local f="${applied_f[$ai]}" id
                    id="${f##*/}"
                    log_verify "$id"
                    if [[ -z "${VERIFY_ERR[$id]-x}" ]]; then
                        log_done "$id verified OK"
                        vresults+=("{\"change_id\":\"${id}\",\"status\":\"ok\"}")
                        continue
                    fi
                    local mine later=() common
                    mine="$(get_written_objects "$f/deploy.sql")"
                    for (( bi = ai + 1; bi < n; bi++ )); do
                        [[ -n "$mine" ]] || break
                        common="$(grep -Fxf <(printf '%s\n' "$mine") <(get_written_objects "${applied_f[$bi]}/deploy.sql") | paste -sd, - | sed 's/,/, /g' || true)"
                        [[ -n "$common" ]] && later+=("$(basename "${applied_f[$bi]}") (${common})")
                    done
                    if [[ ${#later[@]} -gt 0 ]]; then
                        local joined jl
                        joined="$(printf '%s; ' "${later[@]}")"; joined="${joined%; }"
                        jl="$(printf '"%s",' "${later[@]}")"; jl="${jl%,}"
                        log_skip "$id superseded — later changes rewrote the same objects: $joined"
                        vresults+=("{\"change_id\":\"${id}\",\"status\":\"superseded\",\"superseded_by\":[${jl}]}")
                    else
                        log_error "$id verify FAILED"
                        vresults+=("{\"change_id\":\"${id}\",\"status\":\"failed\"}")
                    fi
                done
                if [[ $json_out -eq 1 ]]; then printf '[%s]\n' "$(IFS=,; echo "${vresults[*]+"${vresults[*]}"}")"; fi
                return 0
            fi
            if [[ -n "$arg1" ]]; then
                # Repeatable (R__) changes are recorded in dmcr.repeatable_log, not dmcr.change_log
                is_applied "$arg1" 2>/dev/null || is_repeatable_applied "$arg1" || { log_error "Change '$arg1' is not applied"; exit 1; }
                log_verify "$arg1"
                verify_change "$arg1"
                log_done "$arg1 verified OK"
                if [[ $json_out -eq 1 ]]; then printf '{"change_id":"%s","status":"ok"}\n' "$arg1"; fi
                return 0
            fi
            local last
            last="$(last_applied)"
            if [[ -z "$last" ]]; then log_info "No applied changes"; return 0; fi
            verify_change "$last"
            log_done "$last verified OK"
            if [[ $json_out -eq 1 ]]; then printf '{"change_id":"%s","status":"ok"}\n' "$last"; fi
            ;;

        # ---- HISTORY ----
        manual-script)
            # dmcr manual-script <change_id> [--env X]: the script a DBA runs by hand for a danger_ change
            [[ -n "$arg1" ]] || { log_error "Usage: dmcr manual-script <change_id> [--env <env>]"; exit 1; }
            if is_applied "$arg1" 2>/dev/null; then log_error "'$arg1' is already applied on $CFG_ENV"; exit 1; fi
            if [[ $json_out -eq 1 ]]; then
                local ms; ms="$(manual_script "$arg1")" || exit 1
                printf '{"change_id":%s,"environment":%s,"script":%s}\n' "$(json_s "$arg1")" "$(json_s "$CFG_ENV")" "$(json_s "$ms")"
            else
                manual_script "$arg1" || exit 1
            fi
            return 0
            ;;
        approve)
            # dmcr approve <id> | --release R | --project P [--env X] [--by NAME] [--note TEXT] [--revoke]
            if [[ -z "$arg1" ]] && ! scope_active; then log_error "Usage: dmcr approve <change_id> | --release <id> | --project <id> [--env <env>] [--by <dba name>] [--note <text>] [--revoke]"; exit 1; fi
            approval_policy || exit 1
            local by="${approve_by:-$(get_dmcr_actor)}" ok_by=1 ap
            if [[ ${#APPROVERS[@]} -gt 0 ]]; then
                ok_by=0
                for ap in "${APPROVERS[@]}"; do [[ "${ap,,}" == "${by,,}" ]] && ok_by=1; done
            fi
            if [[ $ok_by -eq 0 ]]; then log_error "'$by' is not an approver for $CFG_ENV (approvers: $(IFS=,; printf '%s' "${APPROVERS[*]}" | sed 's/,/, /g'))"; exit 1; fi
            load_change_infos
            [[ $revoke -eq 1 ]] && load_approvals
            local targets=() t
            while IFS= read -r t; do [[ -n "$t" ]] && targets+=("$t"); done < <(approval_targets "$arg1") || exit 1
            local done_ids=() skipped=() sql="" tid env_sql by_sql note_sql cby rby
            env_sql="$(escape_sql "$CFG_ENV")"; by_sql="$(escape_sql "$by")"
            note_sql="NULL"; [[ -n "$approve_note" ]] && note_sql="'$(escape_sql "$approve_note")'"
            for t in "${targets[@]+"${targets[@]}"}"; do
                tid="$(basename "$t")"
                if is_applied "$tid"; then skipped+=("$tid"$'\t'"already applied on $CFG_ENV"); continue; fi
                if [[ $revoke -eq 1 ]]; then
                    if [[ -z "${APPROVAL_BY[$tid]+x}" ]]; then skipped+=("$tid"$'\t'"not approved for $CFG_ENV"); continue; fi
                    sql+="DELETE FROM dmcr.approval WHERE change_id = '$(escape_sql "$tid")' AND environment = '${env_sql}';"$'\n'
                    sql+="INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor) VALUES ('unapprove', '$(escape_sql "$tid")', 'success', 'Approval revoked', '${env_sql}', '${by_sql}');"$'\n'
                    done_ids+=("$tid"); continue
                fi
                if [[ "${CI_DROPPED[$tid]:-0}" == "1" ]]; then skipped+=("$tid"$'\t'"${CI_DROP_REASON[$tid]}"); continue; fi
                cby="${CI_CREATED_BY[$tid]:-}"; rby="${CI_REQ_BY[$tid]:-}"
                if [[ "$APPROVAL_SELF" == "block" ]] && { [[ -n "$cby" && "${cby,,}" == "${by,,}" ]] || [[ -n "$rby" && "${rby,,}" == "${by,,}" ]]; }; then
                    local what="requested"; [[ -n "$cby" && "${cby,,}" == "${by,,}" ]] && what="created"
                    skipped+=("$tid"$'\t'"$by $what it: someone else approves it (self_approval = block)"); continue
                fi
                sql+="INSERT INTO dmcr.approval(change_id, environment, checksums, approved_by, approved_at, note) VALUES ('$(escape_sql "$tid")', '${env_sql}', '$(escape_sql "$(change_sums "$t")")', '${by_sql}', now(), ${note_sql}) ON CONFLICT (change_id, environment) DO UPDATE SET checksums = EXCLUDED.checksums, approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at, note = EXCLUDED.note;"$'\n'
                local msg="'Approved'"; [[ -n "$approve_note" ]] && msg="'Approved: ' || ${note_sql}"
                sql+="INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor) VALUES ('approve', '$(escape_sql "$tid")', 'success', ${msg}, '${env_sql}', '${by_sql}');"$'\n'
                done_ids+=("$tid")
            done
            if [[ ${#done_ids[@]} -gt 0 ]]; then
                [[ $revoke -eq 1 ]] || ensure_approval_table || exit 1
                exec_psql_sql_tx "$sql" || exit 1
            fi
            local sk
            if [[ $json_out -eq 1 ]]; then
                local cj="" sj=""
                for t in "${done_ids[@]+"${done_ids[@]}"}"; do cj+="${cj:+,}$(json_s "$t")"; done
                for sk in "${skipped[@]+"${skipped[@]}"}"; do sj+="${sj:+,}{\"change_id\":$(json_s "${sk%%$'\t'*}"),\"reason\":$(json_s "${sk#*$'\t'}")}"; done
                printf '{"status":"%s","environment":%s,"by":%s,"revoked":%s,"changes":[%s],"skipped":[%s]}\n' "$([[ ${#done_ids[@]} -gt 0 ]] && echo ok || echo nothing)" "$(json_s "$CFG_ENV")" "$(json_s "$by")" "$([[ $revoke -eq 1 ]] && echo true || echo false)" "$cj" "$sj"
            else
                for t in "${done_ids[@]+"${done_ids[@]}"}"; do log_done "$t $([[ $revoke -eq 1 ]] && echo 'approval revoked' || echo approved) for $CFG_ENV by $by"; done
                for sk in "${skipped[@]+"${skipped[@]}"}"; do log_skip "${sk%%$'\t'*} — ${sk#*$'\t'}"; done
            fi
            if [[ ${#done_ids[@]} -eq 0 ]]; then
                local why=""
                for sk in "${skipped[@]+"${skipped[@]}"}"; do why+="${why:+; }${sk%%$'\t'*}: ${sk#*$'\t'}"; done
                log_error "Nothing $([[ $revoke -eq 1 ]] && echo revoked || echo approved) on $CFG_ENV${why:+: $why}"
                exit 1
            fi
            return 0
            ;;
        approvals)
            # dmcr approvals [--env X] [--release R | --project P]: the pending changes and their approval on X
            approval_policy || exit 1
            load_approvals
            local targets=() t tid state rows="" alist=""
            while IFS= read -r t; do [[ -n "$t" ]] && targets+=("$t"); done < <(approval_targets "$arg1") || exit 1
            [[ -z "$arg1" ]] && ! scope_active && { local kept=() ; load_change_infos; for t in "${targets[@]+"${targets[@]}"}"; do [[ "${CI_DROPPED[$(basename "$t")]:-0}" == "1" ]] || kept+=("$t"); done; targets=("${kept[@]+"${kept[@]}"}"); }
            [[ $json_out -eq 1 ]] || log_info "Approval on $CFG_ENV: $([[ "$APPROVAL_REQUIRED" == "1" ]] && echo required || echo 'not required')$([[ ${#APPROVERS[@]} -gt 0 ]] && printf ' — approvers: %s' "$(IFS=,; printf '%s' "${APPROVERS[*]}" | sed 's/,/, /g')")"
            for t in "${targets[@]+"${targets[@]}"}"; do
                tid="$(basename "$t")"
                if [[ -z "${APPROVAL_BY[$tid]+x}" ]]; then state="missing"
                elif [[ "${APPROVAL_SUMS[$tid]}" != "$(change_sums "$t")" ]]; then state="stale"
                else state="approved"; fi
                rows+="${rows:+,}{\"change_id\":$(json_s "$tid"),\"state\":\"$state\",\"by\":$(json_s "${APPROVAL_BY[$tid]:-}"),\"at\":$(json_s "${APPROVAL_AT[$tid]:-}"),\"note\":$(json_s "${APPROVAL_NOTE[$tid]:-}")}"
                if [[ $json_out -ne 1 ]]; then
                    case "$state" in
                        approved) log_done "$tid — approved by ${APPROVAL_BY[$tid]} (${APPROVAL_AT[$tid]})" ;;
                        stale) log_warn "$tid — changed since ${APPROVAL_BY[$tid]} approved it (${APPROVAL_AT[$tid]})" ;;
                        *) log_skip "$tid — not approved" ;;
                    esac
                fi
            done
            if [[ $json_out -eq 1 ]]; then
                for t in "${APPROVERS[@]+"${APPROVERS[@]}"}"; do alist+="${alist:+,}$(json_s "$t")"; done
                printf '{"environment":%s,"required":%s,"approvers":[%s],"self_approval":"%s","changes":[%s]}\n' "$(json_s "$CFG_ENV")" "$([[ "$APPROVAL_REQUIRED" == "1" ]] && echo true || echo false)" "$alist" "$APPROVAL_SELF" "$rows"
            fi
            return 0
            ;;
        history)
            local hist_sql="SELECT change_id, applied_at, applied_by, deploy_checksum, ticket_id, git_commit, environment, actor, project_id, release_id, change_kind, requested_by, created_by, deploy_id FROM dmcr.change_log ORDER BY applied_at DESC, change_id DESC;"
            if [[ $json_out -eq 1 ]]; then
                local psql_exe
                psql_exe="$(get_psql_exe)"
                local raw
                raw="$("$psql_exe" "$CFG_CONN" -q -v ON_ERROR_STOP=1 -X -t -A -F '|' \
                    -c "SET lock_timeout='${CFG_LOCK_TIMEOUT}'; ${hist_sql}" 2>&1)"
                printf '[\n'
                local first=1
                while IFS='|' read -r cid aat aby dchk tid gc env act hpid hrid hkind hreq hcby hdid; do
                    [[ -z "$cid" || "$cid" == "SET" ]] && continue
                    [[ $first -eq 0 ]] && printf ','
                    local hx="" hp
                    for hp in "project_id:$hpid" "release_id:$hrid" "change_kind:$hkind" "requested_by:$hreq" "created_by:$hcby" "deploy_id:$hdid"; do
                        [[ -n "${hp#*:}" ]] && hx+=",\"${hp%%:*}\":$(json_s "${hp#*:}")"
                    done
                    printf '{"change_id":"%s","applied_at":"%s","applied_by":"%s","deploy_checksum":"%s","ticket_id":"%s","git_commit":"%s","environment":"%s","actor":"%s"%s}\n' \
                        "$cid" "$aat" "$aby" "$dchk" "$tid" "$gc" "$env" "$act" "$hx"
                    first=0
                done <<< "$raw"
                printf ']\n'
                return 0
            fi
            log_info "Change history (most recent first):"
            exec_psql "$hist_sql"
            ;;

        # ---- DIFF ----
        diff)
            cmd_diff "$json_out" "$arg1" "$arg2"
            ;;

        # ---- DEPLOYMENTS ----
        deployments|log)
            # dmcr log                    every deploy / revert run, newest first, in full (like git log)
            # dmcr log --oneline          one line per run (like git log --oneline); dmcr deployments is the same
            # dmcr log <id>               what one run did, change by change (like git show); so is dmcr deployments <id>
            local oneline=0 lid="" lx
            [[ "$command" == "deployments" ]] && oneline=1
            for lx in "${positional[@]:1}"; do case "$lx" in --oneline) oneline=1 ;; *) lid="$lx" ;; esac; done
            if [[ -n "$lid" ]]; then
                local dfull
                dfull="$(resolve_deployment_id "$lid")" || exit 1
                local draw
                draw="$(exec_psql_scalar "SELECT string_agg(concat_ws(E'\x1f', e.change_id, e.action, e.status, to_char(e.event_ts, 'YYYY-MM-DD HH24:MI:SS'), coalesce(e.environment, ''), coalesce(e.actor, ''), coalesce(e.message, ''), (c.change_id IS NOT NULL)::int::text, coalesce(c.git_commit, ''), coalesce(c.release_id, ''), coalesce(c.project_id, '')), E'\x1e' ORDER BY e.id) FROM dmcr.event_log e LEFT JOIN dmcr.change_log c ON c.change_id = e.change_id AND c.deploy_id = e.deploy_id WHERE e.deploy_id = '${dfull}';")" || exit 1
                local rows=() row cid act st at denv dact msg still gc rel prj d_act="" d_env="" d_actor="" d_at="" d_gc="" cj=""
                IFS=$'\x1e' read -r -d '' -a rows <<< "$draw" || true
                for row in "${rows[@]+"${rows[@]}"}"; do
                    row="${row%$'\n'}"; [[ -n "$row" ]] || continue
                    IFS=$'\x1f' read -r cid act st at denv dact msg still gc rel prj <<< "$row"
                    [[ -z "$d_act" ]] && { d_act="$act"; d_env="$denv"; d_actor="$dact"; d_at="$at"; }
                    [[ -n "$gc" && -z "$d_gc" ]] && d_gc="$gc"
                    cj+="${cj:+,}$(printf '{"change_id":%s,"status":%s,"at":%s,"still_applied":%s,"release":%s,"project":%s,"message":%s}' "$(json_s "$cid")" "$(json_s "$st")" "$(json_s "$at")" "$([[ "$still" == "1" ]] && echo true || echo false)" "$(json_s "$rel")" "$(json_s "$prj")" "$(json_s "$msg")")"
                done
                if [[ $json_out -eq 1 ]]; then
                    printf '{"deploy_id":%s,"short":%s,"action":%s,"environment":%s,"actor":%s,"started_at":%s,"git_commit":%s,"changes":[%s]}\n' \
                        "$(json_s "$dfull")" "$(json_s "$(short_did "$dfull")")" "$(json_s "$d_act")" "$(json_s "$d_env")" "$(json_s "$d_actor")" "$(json_s "$d_at")" "$(json_s "$d_gc")" "$cj"
                    return 0
                fi
                printf 'deployment %s\n' "$dfull"
                printf 'Action:  %s on %s\nBy:      %s\nDate:    %s\n' "$d_act" "$d_env" "$d_actor" "$d_at"
                [[ -n "$d_gc" ]] && printf 'Commit:  %s\n' "$d_gc"
                printf '\n'
                for row in "${rows[@]+"${rows[@]}"}"; do
                    row="${row%$'\n'}"; [[ -n "$row" ]] || continue
                    IFS=$'\x1f' read -r cid act st at denv dact msg still gc rel prj <<< "$row"
                    printf '    %-8s %-40s %s%s\n' "$st" "$cid" "$([[ "$act" == "deploy" && "$st" == "success" ]] && { [[ "$still" == "1" ]] && printf 'still applied' || printf 'reverted or redeployed since'; })" "$([[ -n "$msg" ]] && printf '  (%s)' "$msg")"
                done
                return 0
            fi
            local lraw
            lraw="$(exec_psql_scalar "SELECT coalesce(string_agg(concat_ws(E'\x1f', d.deploy_id, d.at, d.action, d.env, d.actor, d.ok::text, d.failed::text, d.ids, d.gc, d.still::text), E'\x1e' ORDER BY d.first_ts DESC, d.deploy_id), '') FROM (SELECT e.deploy_id, min(e.event_ts) AS first_ts, to_char(min(e.event_ts), 'YYYY-MM-DD HH24:MI') AS at, min(e.action) AS action, coalesce(max(e.environment), '') AS env, coalesce(max(e.actor), '') AS actor, count(*) FILTER (WHERE e.status = 'success') AS ok, count(*) FILTER (WHERE e.status = 'failure') AS failed, string_agg(e.change_id, ',' ORDER BY e.id) AS ids, coalesce((SELECT max(c.git_commit) FROM dmcr.change_log c WHERE c.deploy_id = e.deploy_id), '') AS gc, (SELECT count(*) FROM dmcr.change_log c WHERE c.deploy_id = e.deploy_id) AS still FROM dmcr.event_log e WHERE e.deploy_id IS NOT NULL GROUP BY e.deploy_id ORDER BY min(e.event_ts) DESC LIMIT 200) d;")" || exit 1
            local lrows=() lr ld lat lact lenv lactor lok lfail lids lgc lstill lj=""
            IFS=$'\x1e' read -r -d '' -a lrows <<< "$lraw" || true
            if [[ $json_out -eq 1 ]]; then
                for lr in "${lrows[@]+"${lrows[@]}"}"; do
                    lr="${lr%$'\n'}"; [[ -n "$lr" ]] || continue
                    IFS=$'\x1f' read -r ld lat lact lenv lactor lok lfail lids lgc lstill <<< "$lr"
                    local idj="" x; for x in ${lids//,/ }; do idj+="${idj:+,}$(json_s "$x")"; done
                    lj+="${lj:+,}$(printf '{"deploy_id":%s,"short":%s,"at":%s,"action":%s,"environment":%s,"actor":%s,"ok":%s,"failed":%s,"still_applied":%s,"git_commit":%s,"changes":[%s]}' "$(json_s "$ld")" "$(json_s "$(short_did "$ld")")" "$(json_s "$lat")" "$(json_s "$lact")" "$(json_s "$lenv")" "$(json_s "$lactor")" "$lok" "$lfail" "$lstill" "$(json_s "$lgc")" "$idj")"
                done
                printf '{"environment":%s,"deployments":[%s]}\n' "$(json_s "$CFG_ENV")" "$lj"
                return 0
            fi
            if [[ ${#lrows[@]} -eq 0 || -z "${lrows[0]%$'\n'}" ]]; then log_info "No deployments recorded in $CFG_ENV yet"; return 0; fi
            log_info "Deployments in $CFG_ENV, newest first (dmcr deployments <id> for one; dmcr revert <id> undoes a deploy)"
            for lr in "${lrows[@]}"; do
                lr="${lr%$'\n'}"; [[ -n "$lr" ]] || continue
                IFS=$'\x1f' read -r ld lat lact lenv lactor lok lfail lids lgc lstill <<< "$lr"
                if [[ $oneline -eq 1 ]]; then
                    printf '%s  %s  %-6s  %-12s  %s change(s)%s  %s\n' "$(short_did "$ld")" "$lat" "$lact" "$lactor" "$lok" "$([[ "$lfail" != "0" ]] && printf ', %s failed' "$lfail")" "$(printf '%s' "$lids" | sed 's/,/, /g')"
                    continue
                fi
                if _ansi_enabled; then printf '\033[33mdeployment %s\033[0m\n' "$ld"; else printf 'deployment %s\n' "$ld"; fi
                printf 'Action:  %s on %s\nBy:      %s\nDate:    %s\n' "$lact" "$lenv" "$lactor" "$lat"
                [[ -n "$lgc" ]] && printf 'Commit:  %s\n' "$lgc"
                printf '\n    %s change(s)%s%s\n' "$lok" "$([[ "$lfail" != "0" ]] && printf ', %s failed' "$lfail")" "$([[ "$lact" == "deploy" ]] && printf ', %s still applied' "$lstill")"
                for lx in ${lids//,/ }; do printf '    %s\n' "$lx"; done
                printf '\n'
            done
            ;;

        # ---- INFO ----
        info)
            local folders=()
            while IFS= read -r f; do [[ -n "$f" ]] && folders+=("$f"); done \
                < <(get_change_folders "$CFG_CHANGES_DIR" 2>/dev/null || true)
            local applied_count=0 pending_count=0 danger_count=0
            for f in "${folders[@]+"${folders[@]}"}"; do
                local id
                id="${f##*/}"
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
            local drift_line
            while IFS= read -r drift_line; do
                [[ -n "$drift_line" ]] && issues+=("CHECKSUM  ${drift_line%% *} — ${drift_line#* } was edited after it was applied (restore it, or accept with: dmcr repair --checksums)")
            done < <(list_drifted_changes)
            # manual-only (danger_) changes still waiting here: deploy never runs them, so they are easy to forget
            local applied_here mf mid
            applied_here="$(exec_psql_scalar "SELECT coalesce(string_agg(change_id, ','), '') FROM dmcr.change_log;" 2>/dev/null || echo "")"
            load_change_infos
            while IFS= read -r mf; do
                [[ -n "$mf" ]] || continue
                mid="$(basename "$mf")"
                echo "$mid" | grep -qiE '(^|_)danger_' || continue
                [[ ",$applied_here," == *",$mid,"* ]] && continue
                [[ "${CI_DROPPED[$mid]:-0}" == "1" ]] && continue
                issues+=("MANUAL  $mid — waiting on $CFG_ENV: the DBA runs it by hand; get the one-transaction script with: dmcr manual-script $mid --env $CFG_ENV")
            done < <(get_change_folders "$CFG_CHANGES_DIR")

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
                id="${f##*/}"
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
                --unlock)
                    local existing
                    ensure_deploy_lock_table || exit 1
                    existing="$(exec_psql_scalar "
SELECT coalesce((SELECT holder || ' since ' || acquired_at::text FROM dmcr.deploy_lock WHERE lock_id = 1), '');")"
                    exec_psql_scalar "DELETE FROM dmcr.deploy_lock WHERE lock_id = 1;" >/dev/null
                    if [[ -n "$existing" ]]; then
                        log_done "Cleared DMCR database lock held by $existing"
                        exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,message,environment,actor) VALUES ('repair','*','success','$(escape_sql "Lock cleared (was: $existing)")','$(escape_sql "$CFG_ENV")','$(escape_sql "$(get_dmcr_actor)")');" >/dev/null 2>/dev/null || true
                    else
                        log_info "No DMCR database lock was held"
                    fi
                    if [[ $json_out -eq 1 ]]; then
                        printf '{"action":"unlock","status":"ok","cleared":%s}\n' "$([[ -n "$existing" ]] && echo true || echo false)"
                    fi
                    ;;
                --mark-applied)
                    [[ -z "$arg2" ]] && { log_error "Usage: dmcr repair --mark-applied <change_id>"; exit 1; }
                    local id="$arg2"
                    is_applied "$id" 2>/dev/null && { log_error "'$id' is already marked as applied"; exit 1; }
                    local safe_id safe_env safe_actor
                    safe_id="$(escape_sql "$id")"
                    safe_env="$(escape_sql "$CFG_ENV")"
                    safe_actor="$(escape_sql "$(get_dmcr_actor)")"
                    exec_psql_scalar "$(change_log_insert_sql "$id" "'${safe_actor}'")" >/dev/null
                    exec_psql_scalar "INSERT INTO dmcr.event_log(action,change_id,status,message,environment,actor) VALUES ('repair','${safe_id}','success','Manually marked as applied','${safe_env}','${safe_actor}');" >/dev/null 2>/dev/null || true
                    log_done "'$id' marked as applied"
                    if [[ $json_out -eq 1 ]]; then printf '{"change_id":"%s","action":"mark-applied","status":"ok"}\n' "$id"; fi
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
                    if [[ $json_out -eq 1 ]]; then printf '{"change_id":"%s","action":"mark-reverted","status":"ok"}\n' "$id"; fi
                    ;;
                --checksums)
                    log_info "Reconciling checksums for all applied changes..."
                    local folders=()
                    while IFS= read -r f; do [[ -n "$f" ]] && folders+=("$f"); done \
                        < <(get_change_folders "$CFG_CHANGES_DIR")
                    local repaired=()
                    for f in "${folders[@]+"${folders[@]}"}"; do
                        local id
                        id="${f##*/}"
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
                    log_error "Unknown repair action: $arg1. Use --mark-applied, --mark-reverted, --checksums, or --unlock."
                    exit 1
                    ;;
            esac
            ;;

        # ---- REVERT ----
        revertLast|revert-last)
            local last
            last="$(last_applied)"
            if [[ -z "$last" ]]; then
                [[ $json_out -eq 1 ]] && printf '{"status":"nothing_to_revert","change_id":null}\n' || log_info "Nothing to revert"
                return 0
            fi
            log_info "Reverting latest applied change: $last"
            acquire_advisory_lock
            revert_change "$last"
            release_advisory_lock
            if [[ $json_out -eq 1 ]]; then printf '{"status":"ok","change_id":"%s","action":"revert"}\n' "$last"; fi
            ;;

        revert)
            if [[ "$arg1" =~ ^[0-9a-fA-F]{4,40}(,[0-9a-fA-F]{4,40})*$ ]]; then
                # dmcr revert <deployment id> [<id> ...] — like git revert <commit>...: reverts what those
                # deployments applied that is still applied from them, newest first, with the scoped-revert guards
                local dspec="" dp did dfull dact dlist=""
                for dp in "${positional[@]:1}"; do dspec+="${dspec:+,}$dp"; done
                for did in ${dspec//,/ }; do
                    dfull="$(resolve_deployment_id "$did")" || exit 1
                    dact="$(exec_psql_scalar "SELECT min(action) FROM dmcr.event_log WHERE deploy_id = '${dfull}';")"
                    if [[ "$dact" == "revert" ]]; then log_error "Deployment $(short_did "$dfull") is a revert; to put its changes back, deploy them (dmcr deploy)"; exit 1; fi
                    _csv_has "$dlist" "$dfull" || dlist+="${dlist:+,}$dfull"
                done
                SCOPE_DEPLOYS="$(for did in ${dlist//,/ }; do printf '%s,' "$(short_did "$did")"; done | sed 's/,$//')"
                local din=""; for did in ${dlist//,/ }; do din+="${din:+,}'${did}'"; done
                SCOPE_CHANGES="$(exec_psql_scalar "SELECT coalesce(string_agg(change_id, ','), '') FROM dmcr.change_log WHERE deploy_id IN (${din});")" || exit 1
                if [[ -z "$SCOPE_CHANGES" ]]; then
                    if [[ $json_out -eq 1 ]]; then printf '{"status":"nothing_to_revert","scope":%s,"changes":[]}\n' "$(json_s "$(format_scope)")"
                    else log_info "Nothing to revert: no change applied by $(format_scope) is still applied from it"; fi
                    return 0
                fi
                invoke_scoped_revert "$dry_run" "$json_out"
                return 0
            fi
            if [[ -n "$SCOPE_RELEASE" || -n "$SCOPE_PROJECTS" || -n "$SCOPE_KINDS" ]]; then
                # dmcr revert --project B [--kind update] | --release <id> [--dry-run]
                if [[ -n "$arg1" ]]; then
                    log_error "--release/--project/--kind revert a whole scope; leave out '$arg1'. Usage: dmcr revert --project <id> | --release <id> [--kind <kind>] [--dry-run]"
                    exit 1
                fi
                invoke_scoped_revert "$dry_run" "$json_out"
                return 0
            fi
            if [[ "$arg1" == "list" ]]; then
                if [[ $json_out -eq 1 ]]; then
                    local psql_exe
                    psql_exe="$(get_psql_exe)"
                    local raw
                    raw="$("$psql_exe" "$CFG_CONN" -q -v ON_ERROR_STOP=1 -X -t -A -F '|' \
                        -c "SELECT change_id, applied_at FROM dmcr.change_log ORDER BY applied_at DESC, change_id DESC;" 2>&1)"
                    printf '[\n'
                    local first=1
                    while IFS='|' read -r cid aat; do
                        [[ -z "$cid" || "$cid" == "SET" ]] && continue
                        [[ $first -eq 0 ]] && printf ','
                        printf '{"change_id":"%s","applied_at":"%s"}\n' "$cid" "$aat"
                        first=0
                    done <<< "$raw"
                    printf ']\n'
                else
                    log_info "Listing applied changes"
                    exec_psql "SELECT change_id, applied_at FROM dmcr.change_log ORDER BY applied_at DESC, change_id DESC;"
                fi
                return 0
            fi
            if [[ "$arg1" == "to" ]]; then
                local revert_target="$arg2" keep_target=0
                [[ -z "$revert_target" ]] && { log_error "Usage: dmcr revert to <change_id|@tag>"; exit 1; }
                if [[ "$revert_target" == @* ]]; then
                    local tag_name="${revert_target:1}"
                    local resolved
                    resolved="$(get_tag_change_id "$tag_name")"
                    [[ -z "$resolved" ]] && { log_error "Tag '@${tag_name}' not found."; exit 1; }
                    log_info "Tag '@${tag_name}' resolves to: $resolved"
                    revert_target="$resolved"
                    # A tag marks a state to return TO: keep the tagged change applied.
                    keep_target=1
                fi
                if [[ $dry_run -eq 1 ]]; then
                    # --dry-run: list what would be reverted (newest first, as revert_to goes), change nothing
                    is_applied "$revert_target" 2>/dev/null || { log_error "Target change '$revert_target' is not applied"; exit 1; }
                    local plan=() a csv
                    csv="$(exec_psql_scalar "SELECT coalesce(string_agg(change_id, ',' ORDER BY applied_at DESC, change_id DESC), '') FROM dmcr.change_log;")"
                    for a in ${csv//,/ }; do
                        [[ $keep_target -eq 1 && "$a" == "$revert_target" ]] && break
                        plan+=("$a")
                        [[ "$a" == "$revert_target" ]] && break
                    done
                    if [[ $json_out -eq 1 ]]; then
                        local pj="" p
                        for p in "${plan[@]+"${plan[@]}"}"; do pj+="$([[ -n "$pj" ]] && printf ',')$(json_s "$p")"; done
                        printf '{"status":"dry_run","target":%s,"action":"revert_to","changes":[%s]}\n' "$(json_s "$revert_target")" "$pj"
                    else
                        log_warn "DRY RUN — revert to $revert_target would revert ${#plan[@]} change(s), newest first:"
                        local p; for p in "${plan[@]+"${plan[@]}"}"; do log_info "  $p"; done
                        log_warn "DRY RUN — nothing was reverted"
                    fi
                    return 0
                fi
                if [[ $keep_target -eq 1 ]]; then
                    log_info "Reverting changes applied after $revert_target (keeping $revert_target)"
                else
                    log_info "Reverting down to and including: $revert_target"
                fi
                acquire_advisory_lock
                revert_to "$revert_target" "$keep_target"
                release_advisory_lock
                log_info "Deployment $(short_did "$DMCR_DEPLOY_ID") on $CFG_ENV: revert to $revert_target"
                if [[ $json_out -eq 1 ]]; then printf '{"status":"ok","deploy_id":"%s","target":"%s","action":"revert_to"}\n' "$DMCR_DEPLOY_ID" "$revert_target"; fi
                return 0
            fi
            [[ -z "$arg1" ]] && { log_error "Usage: dmcr revert <change_id>"; exit 1; }
            if [[ $dry_run -eq 1 ]]; then
                # --dry-run: only the latest applied change can be reverted by id; change nothing
                is_applied "$arg1" 2>/dev/null || { log_error "'$arg1' is not applied"; exit 1; }
                local latest_now; latest_now="$(last_applied)"
                [[ "$latest_now" == "$arg1" ]] || { log_error "Refusing to revert non-latest change. Latest is '$latest_now'."; exit 1; }
                if [[ $json_out -eq 1 ]]; then printf '{"status":"dry_run","action":"revert","changes":[%s]}\n' "$(json_s "$arg1")"
                else log_warn "DRY RUN — would revert $arg1 (its revert.sql, then verify)"; log_warn "DRY RUN — nothing was reverted"; fi
                return 0
            fi
            log_info "Reverting change: $arg1"
            acquire_advisory_lock
            revert_change "$arg1"
            release_advisory_lock
            log_info "Deployment $(short_did "$DMCR_DEPLOY_ID") on $CFG_ENV: revert of $arg1"
            if [[ $json_out -eq 1 ]]; then printf '{"status":"ok","deploy_id":"%s","change_id":"%s","action":"revert"}\n' "$DMCR_DEPLOY_ID" "$arg1"; fi
            ;;

        # ---- RELEASE ----
        release)
            cmd_release "$arg1" "$arg2" "$json_out"
            ;;

        # ---- TAG ----
        tag)
            if [[ -z "$arg1" || "$arg1" == "list" ]]; then
                if [[ $json_out -eq 1 ]]; then
                    local psql_exe
                    psql_exe="$(get_psql_exe)"
                    local raw
                    raw="$("$psql_exe" "$CFG_CONN" -q -v ON_ERROR_STOP=1 -X -t -A -F '|' \
                        -c "SELECT t.tag_name, t.change_id, t.created_at, (EXISTS (SELECT 1 FROM dmcr.change_log c WHERE c.change_id = t.change_id))::int AS applied, t.description FROM dmcr.tags t ORDER BY t.created_at DESC;" 2>&1)"
                    printf '[\n'
                    local first=1
                    while IFS='|' read -r tn cid cat app desc; do
                        [[ -z "$tn" || "$tn" == "SET" ]] && continue
                        [[ $first -eq 0 ]] && printf ','
                        # applied=false: the tagged change was reverted (the tag row stays)
                        printf '{"tag_name":"%s","change_id":"%s","created_at":"%s","applied":%s,"description":"%s"}\n' "$tn" "$cid" "$cat" "$([[ "$app" == 1 ]] && echo true || echo false)" "$desc"
                        first=0
                    done <<< "$raw"
                    printf ']\n'
                else
                    log_info "Release tags:"
                    exec_psql "SELECT t.tag_name, t.change_id, t.created_at, (EXISTS (SELECT 1 FROM dmcr.change_log c WHERE c.change_id = t.change_id))::int AS applied, t.description FROM dmcr.tags t ORDER BY t.created_at DESC;"
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
                if [[ $json_out -eq 1 ]]; then printf '{"status":"ok","applied":[]}\n'; fi
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
                assert_no_tx_control "$rid" "$rfile" || continue
                assert_no_tx_control "$rid" "$rf/verify.sql" || continue
                local safe_rid safe_rchk safe_renv safe_ractor
                safe_rid="$(escape_sql "$rid")"
                safe_rchk="$(escape_sql "$rchk")"
                safe_renv="$(escape_sql "$CFG_ENV")"
                safe_ractor="$(escape_sql "$ractor")"
                # deploy.sql + checksum record + verify.sql commit together
                local r_upsert="INSERT INTO dmcr.repeatable_log(change_id,last_checksum,applied_at,environment,actor) VALUES ('${safe_rid}','${safe_rchk}',now(),'${safe_renv}','${safe_ractor}') ON CONFLICT (change_id) DO UPDATE SET last_checksum=EXCLUDED.last_checksum,applied_at=EXCLUDED.applied_at,environment=EXCLUDED.environment,actor=EXCLUDED.actor;"
                [[ -f "$rf/verify.sql" ]] && log_verify "$rid (inside the transaction)"
                if exec_psql_file_tx "$rfile" "${r_upsert}$(tx_verify_sql "$rf/verify.sql")"; then
                    local relapsed=$(( SECONDS - rt_start ))
                    rresults+=("{\"change_id\":\"${rid}\",\"status\":\"applied\",\"duration_s\":${relapsed}}")
                    log_done "$rid applied (${relapsed}s)"
                else
                    local relapsed=$(( SECONDS - rt_start ))
                    log_error "Repeatable $rid failed"
                    rresults+=("{\"change_id\":\"${rid}\",\"status\":\"failed\"}")
                fi
            done
            release_advisory_lock
            if [[ $json_out -eq 1 ]]; then printf '{"status":"ok","applied":[%s]}\n' "$(IFS=,; echo "${rresults[*]+"${rresults[*]}"}")"; fi
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
