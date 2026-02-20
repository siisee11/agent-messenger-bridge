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

async function postToBridge(hostname, port, payload) {
  await fetch('http://' + hostname + ':' + port + '/opencode-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function main() {
  const inputRaw = await readStdin();
  let input = {};
  try {
    input = inputRaw ? JSON.parse(inputRaw) : {};
  } catch {
    input = {};
  }

  const projectName = process.env.AGENT_DISCORD_PROJECT || '';
  if (!projectName) {
    process.stdout.write('{}');
    return;
  }

  const agentType = process.env.AGENT_DISCORD_AGENT || 'gemini';
  const instanceId = process.env.AGENT_DISCORD_INSTANCE || '';
  const port = process.env.AGENT_DISCORD_PORT || '18470';
  const hostname = process.env.AGENT_DISCORD_HOSTNAME || '127.0.0.1';

  const message = typeof input.message === 'string' ? input.message.trim() : '';
  const notificationType = typeof input.notification_type === 'string' ? input.notification_type : 'unknown';

  console.error(`[discode-notification-hook] project=${projectName} type=${notificationType} message=${message.substring(0, 100)}`);

  try {
    await postToBridge(hostname, port, {
      projectName,
      agentType,
      ...(instanceId ? { instanceId } : {}),
      type: 'session.notification',
      notificationType,
      text: message,
    });
  } catch {
    // ignore bridge delivery failures
  }

  process.stdout.write('{}');
}

main().catch(() => {
  process.stdout.write('{}');
});
