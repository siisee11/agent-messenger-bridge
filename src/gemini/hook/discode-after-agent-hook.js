#!/usr/bin/env node

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => {
      resolve(raw);
    });
    process.stdin.on('error', () => {
      resolve('');
    });
  });
}

async function postToBridge(port, payload) {
  await fetch('http://127.0.0.1:' + port + '/opencode-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function main() {
  const raw = await readStdin();

  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }

  if (input.stop_hook_active === true) {
    process.stdout.write('{}');
    return;
  }

  if (typeof input.hook_event_name === 'string' && input.hook_event_name !== 'AfterAgent') {
    process.stdout.write('{}');
    return;
  }

  const projectName = process.env.AGENT_DISCORD_PROJECT || '';
  if (!projectName) {
    process.stdout.write('{}');
    return;
  }

  const agentType = process.env.AGENT_DISCORD_AGENT || 'gemini';
  const instanceId = process.env.AGENT_DISCORD_INSTANCE || '';
  const port = process.env.AGENT_DISCORD_PORT || '18470';
  const text = typeof input.prompt_response === 'string' ? input.prompt_response.trim() : '';

  try {
    await postToBridge(port, {
      projectName,
      agentType,
      ...(instanceId ? { instanceId } : {}),
      type: 'session.idle',
      text,
    });
  } catch {
    // ignore bridge delivery failures
  }

  process.stdout.write('{}');
}

main().catch(() => {
  process.stdout.write('{}');
});
