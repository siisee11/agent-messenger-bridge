import { describe, expect, it } from 'vitest';
import type { ProjectState } from '../../src/types/index.js';
import {
  buildNextInstanceId,
  findProjectInstanceByChannel,
  getPrimaryInstanceForAgent,
  listProjectAgentTypes,
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

describe('discordChannelId backward compatibility', () => {
  it('reads legacy discordChannelId field from instance state', () => {
    // Simulates state saved before the discordChannelId → channelId rename.
    // The raw JSON would have { discordChannelId: "ch-old" } instead of { channelId: "ch-old" }.
    const project: ProjectState = {
      projectName: 'legacy',
      projectPath: '/tmp/legacy',
      tmuxSession: 'bridge',
      agents: { claude: true },
      discordChannels: { claude: 'ch-old' },
      createdAt: new Date(),
      lastActive: new Date(),
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          tmuxWindow: 'legacy-claude',
          // Simulate old field name by casting
          discordChannelId: 'ch-old',
        } as any,
      },
    };

    const normalized = normalizeProjectState(project);
    expect(normalized.instances?.claude?.channelId).toBe('ch-old');
  });

  it('prefers channelId over discordChannelId when both present', () => {
    const project: ProjectState = {
      projectName: 'both',
      projectPath: '/tmp/both',
      tmuxSession: 'bridge',
      agents: { claude: true },
      discordChannels: {},
      createdAt: new Date(),
      lastActive: new Date(),
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          channelId: 'new-ch',
          discordChannelId: 'old-ch',
        } as any,
      },
    };

    const normalized = normalizeProjectState(project);
    expect(normalized.instances?.claude?.channelId).toBe('new-ch');
  });

  it('finds instance by channel when using legacy discordChannelId', () => {
    const project: ProjectState = {
      projectName: 'legacy-find',
      projectPath: '/tmp/legacy-find',
      tmuxSession: 'bridge',
      agents: { claude: true },
      discordChannels: {},
      createdAt: new Date(),
      lastActive: new Date(),
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          discordChannelId: 'ch-legacy',
        } as any,
      },
    };

    const found = findProjectInstanceByChannel(project, 'ch-legacy');
    expect(found?.instanceId).toBe('claude');
  });

  it('rebuilds discordChannels legacy map from migrated instances', () => {
    const project: ProjectState = {
      projectName: 'rebuild',
      projectPath: '/tmp/rebuild',
      tmuxSession: 'bridge',
      agents: {},
      discordChannels: {},
      createdAt: new Date(),
      lastActive: new Date(),
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          discordChannelId: 'ch-rebuild',
        } as any,
      },
    };

    const normalized = normalizeProjectState(project);
    expect(normalized.discordChannels).toEqual({ claude: 'ch-rebuild' });
  });
});

describe('normalizeProjectState', () => {
  it('handles project with no instances and no legacy fields', () => {
    const project: ProjectState = {
      projectName: 'empty',
      projectPath: '/tmp/empty',
      tmuxSession: 'bridge',
      agents: {},
      discordChannels: {},
      createdAt: new Date(),
      lastActive: new Date(),
    };

    const normalized = normalizeProjectState(project);
    expect(Object.keys(normalized.instances || {})).toHaveLength(0);
    expect(normalized.discordChannels).toEqual({});
  });

  it('normalizes multi-instance project with different agents', () => {
    const project: ProjectState = {
      projectName: 'multi',
      projectPath: '/tmp/multi',
      tmuxSession: 'bridge',
      agents: {},
      discordChannels: {},
      createdAt: new Date(),
      lastActive: new Date(),
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          channelId: 'ch-claude',
          tmuxWindow: 'multi-claude',
          eventHook: true,
        },
        codex: {
          instanceId: 'codex',
          agentType: 'codex',
          channelId: 'ch-codex',
          tmuxWindow: 'multi-codex',
          eventHook: true,
        },
      },
    };

    const normalized = normalizeProjectState(project);
    expect(listProjectAgentTypes(normalized)).toEqual(expect.arrayContaining(['claude', 'codex']));
    expect(normalized.discordChannels).toEqual({ claude: 'ch-claude', codex: 'ch-codex' });
    expect(getPrimaryInstanceForAgent(normalized, 'claude')?.channelId).toBe('ch-claude');
    expect(getPrimaryInstanceForAgent(normalized, 'codex')?.channelId).toBe('ch-codex');
  });

  it('skips instances with empty agentType', () => {
    const project: ProjectState = {
      projectName: 'skip',
      projectPath: '/tmp/skip',
      tmuxSession: 'bridge',
      agents: {},
      discordChannels: {},
      createdAt: new Date(),
      lastActive: new Date(),
      instances: {
        bad: {
          instanceId: 'bad',
          agentType: '',
          channelId: 'ch-bad',
        },
        good: {
          instanceId: 'good',
          agentType: 'claude',
          channelId: 'ch-good',
        },
      },
    };

    const instances = listProjectInstances(project);
    expect(instances).toHaveLength(1);
    expect(instances[0].instanceId).toBe('good');
  });

  it('derives eventHooks map from instances', () => {
    const project: ProjectState = {
      projectName: 'hooks',
      projectPath: '/tmp/hooks',
      tmuxSession: 'bridge',
      agents: {},
      discordChannels: {},
      createdAt: new Date(),
      lastActive: new Date(),
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          eventHook: true,
        },
      },
    };

    const normalized = normalizeProjectState(project);
    expect(normalized.eventHooks).toEqual({ claude: true });
  });
});
