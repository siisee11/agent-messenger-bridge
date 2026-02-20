#!/usr/bin/env node

/**
 * Codex notify hook for discode.
 *
 * Codex passes JSON as process.argv[2] (not stdin).
 * Fires on `agent-turn-complete` events and POSTs the last assistant
 * message to the discode bridge HTTP endpoint.
 */

async function postToBridge(hostname, port, payload) {
  await fetch('http://' + hostname + ':' + port + '/opencode-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(process.argv[2] || '{}');
  } catch {
    input = {};
  }

  if (input.type !== 'agent-turn-complete') {
    return;
  }

  const projectName = process.env.AGENT_DISCORD_PROJECT || '';
  if (!projectName) return;

  const agentType = process.env.AGENT_DISCORD_AGENT || 'codex';
  const instanceId = process.env.AGENT_DISCORD_INSTANCE || '';
  const port = process.env.AGENT_DISCORD_PORT || '18470';
  const hostname = process.env.AGENT_DISCORD_HOSTNAME || '127.0.0.1';
  const text = typeof input['last-assistant-message'] === 'string'
    ? input['last-assistant-message'].trim()
    : '';

  try {
    await postToBridge(hostname, port, {
      projectName,
      agentType,
      ...(instanceId ? { instanceId } : {}),
      type: 'session.idle',
      text,
    });
  } catch {
    // ignore bridge delivery failures
  }
}

main().catch(() => {});
