#!/usr/bin/env tsx

import { installClaudePlugin } from '../src/claude/plugin-installer.js';

function main(): void {
  try {
    const pluginPath = installClaudePlugin();
    console.log(`✅ Claude Code plugin installed at: ${pluginPath}`);
    console.log('ℹ️ Claude sessions launched by discode will load this plugin automatically.');
  } catch (error) {
    console.error(`❌ Failed to install Claude Code plugin: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
