#!/usr/bin/env bash
set -euo pipefail

SWITCHBOARD_CLI_REF="${SWITCHBOARD_CLI_REF:-main}"
SWITCHBOARD_NODE_VERSION="${SWITCHBOARD_NODE_VERSION:-v22.21.1}"
SWITCHBOARD_INSTALL_HOME="${SWITCHBOARD_INSTALL_HOME:-$HOME/.local/share/switchboard}"
SWITCHBOARD_BIN_DIR="${SWITCHBOARD_BIN_DIR:-$HOME/.local/bin}"
SWITCHBOARD_NPM_PREFIX="${SWITCHBOARD_NPM_PREFIX:-$SWITCHBOARD_INSTALL_HOME/npm}"
SWITCHBOARD_NPM_CACHE="${SWITCHBOARD_NPM_CACHE:-$SWITCHBOARD_INSTALL_HOME/npm-cache}"
SWITCHBOARD_CLI_PACKAGE_URL="${SWITCHBOARD_CLI_PACKAGE_URL:-https://github.com/proof-computer/switchboard-cli/archive/${SWITCHBOARD_CLI_REF}.tar.gz}"

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  log "error: $*"
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

ensure_cmd() {
  have "$1" || fail "missing required command: $1"
}

node_major() {
  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0'
}

platform_name() {
  case "$(uname -s)" in
    Linux) printf 'linux' ;;
    Darwin) printf 'darwin' ;;
    *) fail "unsupported OS: $(uname -s)" ;;
  esac
}

arch_name() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
}

sha256_verify() {
  local expected="$1"
  local file="$2"
  if have sha256sum; then
    printf '%s  %s\n' "$expected" "$file" | sha256sum -c - >/dev/null
  elif have shasum; then
    printf '%s  %s\n' "$expected" "$file" | shasum -a 256 -c - >/dev/null
  else
    log "warning: neither sha256sum nor shasum is available; skipping Node archive checksum verification"
  fi
}

install_node_runtime() {
  local os arch node_name node_base node_dir tmp tarball shasums expected
  os="$(platform_name)"
  arch="$(arch_name)"
  node_name="node-${SWITCHBOARD_NODE_VERSION}-${os}-${arch}"
  node_base="$SWITCHBOARD_INSTALL_HOME/node"
  node_dir="$node_base/$node_name"

  if [ -x "$node_dir/bin/node" ] && [ "$("$node_dir/bin/node" -p 'Number(process.versions.node.split(".")[0])')" -ge 22 ]; then
    printf '%s\n' "$node_dir/bin"
    return
  fi

  ensure_cmd curl
  ensure_cmd tar
  tmp="$(mktemp -d)"
  tarball="$tmp/$node_name.tar.xz"
  shasums="$tmp/SHASUMS256.txt"

  log "Installing Node ${SWITCHBOARD_NODE_VERSION} under $node_base"
  curl -fsSL "https://nodejs.org/dist/${SWITCHBOARD_NODE_VERSION}/$node_name.tar.xz" -o "$tarball"
  curl -fsSL "https://nodejs.org/dist/${SWITCHBOARD_NODE_VERSION}/SHASUMS256.txt" -o "$shasums"
  expected="$(awk -v file="$node_name.tar.xz" '$2 == file { print $1 }' "$shasums")"
  [ -n "$expected" ] || fail "could not find checksum for $node_name.tar.xz"
  sha256_verify "$expected" "$tarball"

  mkdir -p "$node_base"
  rm -rf "$node_dir"
  tar -xJf "$tarball" -C "$node_base"
  rm -rf "$tmp"
  printf '%s\n' "$node_dir/bin"
}

resolve_node_bin() {
  if have node && have npm && [ "$(node_major)" -ge 22 ]; then
    dirname "$(command -v node)"
    return
  fi
  install_node_runtime
}

write_wrapper() {
  local node_bin="$1"
  local npm_prefix="$2"
  local bin_dir="$3"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/switchboard" <<EOF
#!/usr/bin/env sh
export PATH="$node_bin:$npm_prefix/bin:\$PATH"
exec "$npm_prefix/bin/switchboard" "\$@"
EOF
  chmod 0755 "$bin_dir/switchboard"
}

install_cli_package() {
  local node_bin="$1"
  local npm="$2"
  local tmp tarball
  tmp="$(mktemp -d)"
  tarball="$tmp/switchboard-cli.tar.gz"

  log "Downloading Switchboard CLI from $SWITCHBOARD_CLI_PACKAGE_URL"
  curl -fsSL "$SWITCHBOARD_CLI_PACKAGE_URL" -o "$tarball"

  log "Installing Switchboard CLI under $SWITCHBOARD_NPM_PREFIX"
  PATH="$node_bin:$PATH" "$npm" uninstall --global --prefix "$SWITCHBOARD_NPM_PREFIX" --cache "$SWITCHBOARD_NPM_CACHE" switchboard-cli >/dev/null 2>&1 || true
  PATH="$node_bin:$PATH" "$npm" install --global --force --prefix "$SWITCHBOARD_NPM_PREFIX" --cache "$SWITCHBOARD_NPM_CACHE" "$tarball"

  rm -rf "$tmp"
}

main() {
  ensure_cmd curl
  local node_bin npm
  node_bin="$(resolve_node_bin)"
  npm="$node_bin/npm"
  [ -x "$npm" ] || npm="$(command -v npm)"
  [ -x "$npm" ] || fail "npm was not found after Node setup"

  mkdir -p "$SWITCHBOARD_NPM_PREFIX" "$SWITCHBOARD_NPM_CACHE"
  install_cli_package "$node_bin" "$npm"

  write_wrapper "$node_bin" "$SWITCHBOARD_NPM_PREFIX" "$SWITCHBOARD_BIN_DIR"

  log ""
  log "Switchboard CLI installed:"
  "$SWITCHBOARD_BIN_DIR/switchboard" --help >/dev/null
  log "  $SWITCHBOARD_BIN_DIR/switchboard"
  log ""
  case ":$PATH:" in
    *":$SWITCHBOARD_BIN_DIR:"*) ;;
    *)
      log "Add this to your shell profile if switchboard is not on PATH:"
      log "  export PATH=\"$SWITCHBOARD_BIN_DIR:\$PATH\""
      ;;
  esac
  log "Run: switchboard --help"
}

main "$@"
