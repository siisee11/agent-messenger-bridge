import { describe, expect, it } from 'vitest';
import type { ProjectState } from '../../src/types/index.js';
import {
  buildNextInstanceId,
  findProjectInstanceByChannel,
  listProjectInstances,
  normalizeProjectState,
} from '../../src/state/instances.js';

function makeLegacyProject(): ProjectState {
  return {
    projectName: 'demo',
    projectPath: '/tmp/demo',
    tmuxSession: 'bridge',
    agents: { gemini: true },
    discordChannels: { gemini: 'ch-1' },
    tmuxWindows: { gemini: 'demo-gemini' },
    createdAt: new Date(),
    lastActive: new Date(),
  };
}

describe('state instances helpers', () => {
  it('normalizes legacy project into instances', () => {
    const normalized = normalizeProjectState(makeLegacyProject());
    expect(normalized.instances?.gemini).toEqual(
      expect.objectContaining({
        instanceId: 'gemini',
        agentType: 'gemini',
        channelId: 'ch-1',
        tmuxWindow: 'demo-gemini',
      }),
    );
  });

  it('builds next instance ID for same agent', () => {
    const project = normalizeProjectState(makeLegacyProject());
    expect(buildNextInstanceId(project, 'gemini')).toBe('gemini-2');
  });

  it('finds instance by channel ID', () => {
    const project = normalizeProjectState({
      ...makeLegacyProject(),
      instances: {
        gemini: {
          instanceId: 'gemini',
          agentType: 'gemini',
          channelId: 'ch-1',
        },
        'gemini-2': {
          instanceId: 'gemini-2',
          agentType: 'gemini',
          channelId: 'ch-2',
        },
      },
    });

    const instances = listProjectInstances(project);
    expect(instances).toHaveLength(2);
    expect(findProjectInstanceByChannel(project, 'ch-2')?.instanceId).toBe('gemini-2');
  });
});
