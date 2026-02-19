/**
 * Tests for container-related additions to agent-launch policy.
 */

import { describe, expect, it } from 'vitest';
import { buildContainerEnv, buildAgentLaunchEnv } from '../../src/policy/agent-launch.js';

describe('buildContainerEnv', () => {
  it('sets AGENT_DISCORD_HOSTNAME to host.docker.internal', () => {
    const env = buildContainerEnv({
      projectName: 'my-project',
      port: 18470,
      agentType: 'claude',
      instanceId: 'claude',
      permissionAllow: false,
    });

    expect(env.AGENT_DISCORD_HOSTNAME).toBe('host.docker.internal');
  });

  it('includes all standard bridge env vars', () => {
    const env = buildContainerEnv({
      projectName: 'my-project',
      port: 19999,
      agentType: 'claude',
      instanceId: 'claude-2',
      permissionAllow: false,
    });

    expect(env.AGENT_DISCORD_PROJECT).toBe('my-project');
    expect(env.AGENT_DISCORD_PORT).toBe('19999');
    expect(env.AGENT_DISCORD_AGENT).toBe('claude');
    expect(env.AGENT_DISCORD_INSTANCE).toBe('claude-2');
  });

  it('includes OPENCODE_PERMISSION when permissionAllow is true', () => {
    const env = buildContainerEnv({
      projectName: 'test',
      port: 18470,
      agentType: 'opencode',
      instanceId: 'opencode',
      permissionAllow: true,
    });

    expect(env.OPENCODE_PERMISSION).toBe('{"*":"allow"}');
  });

  it('omits OPENCODE_PERMISSION when permissionAllow is false', () => {
    const env = buildContainerEnv({
      projectName: 'test',
      port: 18470,
      agentType: 'claude',
      instanceId: 'claude',
      permissionAllow: false,
    });

    expect(env.OPENCODE_PERMISSION).toBeUndefined();
  });
});

describe('buildAgentLaunchEnv with hostname', () => {
  it('includes AGENT_DISCORD_HOSTNAME when provided', () => {
    const env = buildAgentLaunchEnv({
      projectName: 'test',
      port: 18470,
      agentType: 'claude',
      instanceId: 'claude',
      permissionAllow: false,
      hostname: 'host.docker.internal',
    });

    expect(env.AGENT_DISCORD_HOSTNAME).toBe('host.docker.internal');
  });

  it('omits AGENT_DISCORD_HOSTNAME when not provided', () => {
    const env = buildAgentLaunchEnv({
      projectName: 'test',
      port: 18470,
      agentType: 'claude',
      instanceId: 'claude',
      permissionAllow: false,
    });

    expect(env.AGENT_DISCORD_HOSTNAME).toBeUndefined();
  });
});
