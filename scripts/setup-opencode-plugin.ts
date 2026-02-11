#!/usr/bin/env tsx

import { resolve } from 'path';
import { installOpencodePlugin } from '../src/opencode/plugin-installer.js';

function main(): void {
  const targetPath = resolve(process.argv[2] || process.cwd());

  try {
    const pluginPath = installOpencodePlugin(targetPath);
    console.log(`✅ OpenCode plugin installed at: ${pluginPath}`);
    console.log('ℹ️ Restart opencode session to load the plugin.');
  } catch (error) {
    console.error(`❌ Failed to install OpenCode plugin: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
