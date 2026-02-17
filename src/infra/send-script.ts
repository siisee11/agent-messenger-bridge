/**
 * Generate and install the `discode-send` helper script.
 *
 * Agents call `discode-send <file1> [file2] ...` to send files to
 * Discord/Slack without embedding absolute paths in their response text.
 *
 * The script has the project name and port **hardcoded** so agents can
 * use it immediately without checking environment variables or settings.
 * Instance-level values (agentType, instanceId) are still read from env
 * vars because a single project may have multiple agent instances.
 */

import { mkdirSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';

export interface SendScriptConfig {
  projectName: string;
  port: number;
}

/**
 * Return the source code for the `discode-send` Node.js script.
 *
 * Project-level values (projectName, port) are baked into the script.
 * Instance-level values (agentType, instanceId) fall back to env vars.
 *
 * The generated script is self-contained (no external dependencies) and
 * compatible with Node 16+.
 */
export function getDiscodeSendScriptSource(config: SendScriptConfig): string {
  return `#!/usr/bin/env node
"use strict";

var path = require("path");
var http = require("http");

// Pre-configured by discode — just run this script, no setup needed.
var project  = ${JSON.stringify(config.projectName)};
var port     = ${config.port};
var agent    = process.env.AGENT_DISCORD_AGENT || "";
var instance = process.env.AGENT_DISCORD_INSTANCE || "";

var files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: discode-send <file1> [file2] ...");
  process.exit(1);
}

var resolved = files.map(function (f) { return path.resolve(f); });

var payload = JSON.stringify({
  projectName: project,
  agentType: agent || undefined,
  instanceId: instance || undefined,
  files: resolved,
});

var req = http.request(
  {
    hostname: "127.0.0.1",
    port: port,
    path: "/send-files",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  },
  function (res) {
    var body = "";
    res.on("data", function (chunk) { body += chunk; });
    res.on("end", function () {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log("discode-send: sent " + resolved.length + " file(s)");
      } else {
        console.error("discode-send: server returned " + res.statusCode + ": " + body);
        process.exit(1);
      }
    });
  }
);

req.on("error", function (err) {
  console.error("discode-send: " + err.message);
  process.exit(1);
});

req.write(payload);
req.end();
`;
}

/**
 * Install (or update) the `discode-send` script into the project.
 *
 * The script is placed at `{projectPath}/.discode/bin/discode-send` and
 * made executable.  The function is idempotent — it always overwrites
 * with the latest version.
 *
 * @returns The absolute path to the installed script.
 */
export function installDiscodeSendScript(projectPath: string, config: SendScriptConfig): string {
  const binDir = join(projectPath, '.discode', 'bin');
  mkdirSync(binDir, { recursive: true });

  // Ensure the script runs as CommonJS even when the parent project has
  // "type": "module" in its package.json.  Without this, Node.js treats
  // the extensionless `discode-send` file as ESM and `require()` fails.
  const pkgJsonPath = join(binDir, 'package.json');
  writeFileSync(pkgJsonPath, '{"type":"commonjs"}\n', 'utf-8');

  const scriptPath = join(binDir, 'discode-send');
  writeFileSync(scriptPath, getDiscodeSendScriptSource(config), 'utf-8');
  chmodSync(scriptPath, 0o755);

  return scriptPath;
}
