import { cpSync, mkdirSync } from 'fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/daemon-entry.ts', 'bin/discode.ts', 'bin/tui.tsx', 'bin/onboard-tui.tsx'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  shims: true,
  onSuccess: async () => {
    cpSync('src/claude/plugin', 'dist/claude/plugin', { recursive: true });
    cpSync('src/gemini/hook', 'dist/gemini/hook', { recursive: true });
    cpSync('src/opencode/plugin', 'dist/opencode/plugin', { recursive: true });
    mkdirSync('dist/container', { recursive: true });
    cpSync('src/container/chrome-mcp-bridge.cjs', 'dist/container/chrome-mcp-bridge.cjs');
  },
});
