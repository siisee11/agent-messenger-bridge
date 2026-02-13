# Development Notes

## Switching Discode Runtime (Local vs Release)

By default, `discode` should point to your local binary during development.

Add this patch to `~/.zshrc`:

```zsh
# --- Discode runtime switchers ---
export DISCODE_REPO="/Users/dev/git/discode"
export DISCODE_LOCAL_BIN="$DISCODE_REPO/dist/release/discode-darwin-arm64/bin/discode"

# Force globally installed release runtime
discode-rel() {
  env -u DISCODE_BIN_PATH command discode "$@"
}

# Force local compiled runtime
discode-local() {
  DISCODE_BIN_PATH="$DISCODE_LOCAL_BIN" command discode "$@"
}

# Run TypeScript source directly
discode-src() {
  (cd "$DISCODE_REPO" && bun run tsx ./bin/discode.ts "$@")
}

# Default `discode` to local runtime
alias discode='discode-local'
```

Helpers:

- `discode`: local compiled binary (default alias)
- `discode-local`: local compiled binary from this repo
- `discode-rel`: global installed release runtime (ignores `DISCODE_BIN_PATH`)
- `discode-src`: local TypeScript source runtime

After updating `~/.zshrc`, reload shell config:

```bash
source ~/.zshrc
```

### Commands

```bash
# Release (global installed package)
discode-rel onboard

# Local compiled binary
discode-local onboard

# Local source (tsx)
discode-src onboard
```

### Build local binary (when needed)

```bash
cd /Users/dev/git/discode
npm run build:release:binaries:single
```

The `discode-local` helper expects:

```text
/Users/dev/git/discode/dist/release/discode-darwin-arm64/bin/discode
```
