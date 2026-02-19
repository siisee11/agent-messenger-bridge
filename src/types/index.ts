/**
 * TypeScript type definitions
 */

export * from './interfaces.js';

export interface DiscordConfig {
  token: string;
  channelId?: string;
  guildId?: string;
}

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
  created: Date;
}

export interface AgentMessage {
  type: 'tool-output' | 'agent-output' | 'error';
  content: string;
  timestamp: Date;
  sessionName?: string;
  agentName?: string;
}

export interface SlackConfig {
  botToken: string;
  appToken: string;
}

export type MessagingPlatform = 'discord' | 'slack';

export interface BridgeConfig {
  discord: DiscordConfig;
  slack?: SlackConfig;
  /** Which messaging platform to use. Defaults to 'discord'. */
  messagingPlatform?: MessagingPlatform;
  /** Runtime backend for agent window/process management. */
  runtimeMode?: 'tmux' | 'pty';
  tmux: {
    sessionPrefix: string;
    /**
     * Shared tmux session name without prefix.
     * Full session name becomes `${sessionPrefix}${sharedSessionName}`.
     */
    sharedSessionName?: string;
  };
  hookServerPort?: number;
  /**
   * Preferred AI CLI for `discode new` when agent is not explicitly specified.
   */
  defaultAgentCli?: string;
  opencode?: {
    /**
     * OpenCode permission mode applied at launch time.
     * - 'allow': set OPENCODE_PERMISSION='{"*":"allow"}' for launched OpenCode sessions.
     * - 'default': do not override OpenCode permission behavior.
     */
    permissionMode?: 'allow' | 'default';
  };
  /** Container isolation settings. */
  container?: {
    /** Enable container isolation for agent processes. */
    enabled: boolean;
    /** Docker socket path override (auto-detected if omitted). */
    socketPath?: string;
    /** File sync interval in milliseconds (default: 30000). */
    syncIntervalMs?: number;
  };
}

export interface ProjectAgents {
  [agentType: string]: boolean;
}

export interface ProjectInstanceState {
  instanceId: string;
  agentType: string;
  tmuxWindow?: string;
  /** Platform-agnostic channel ID (Discord channel ID or Slack channel ID). */
  channelId?: string;
  eventHook?: boolean;
  /** Whether this instance runs inside a Docker container. */
  containerMode?: boolean;
  /** Docker container ID (short hash). */
  containerId?: string;
  /** Docker container name for display/logging. */
  containerName?: string;
}

export interface ProjectState {
  projectName: string;
  projectPath: string;
  tmuxSession: string;
  /**
   * Multi-instance state keyed by instance ID.
   *
   * Example keys:
   * - "gemini"
   * - "gemini-2"
   */
  instances?: {
    [instanceId: string]: ProjectInstanceState | undefined;
  };
  /**
   * Optional mapping from agentType -> tmux window target.
   *
   * Examples:
   * - `gemini` (window name; manager will target pane `.0`)
   * - `gemini.1` (explicit pane target)
   *
   * If omitted, agentType is treated as the window name (legacy behavior).
   */
  tmuxWindows?: {
    [agentType: string]: string | undefined;
  };
  /**
   * Optional mapping from agentType -> whether outbound Discord messages are
   * delivered by agent-native event hooks.
   */
  eventHooks?: {
    [agentType: string]: boolean | undefined;
  };
  discordChannels: {
    [agentType: string]: string | undefined;
  };
  agents: ProjectAgents;
  createdAt: Date;
  lastActive: Date;
}

/**
 * Platform-agnostic message attachment (image, file, etc.)
 */
export interface MessageAttachment {
  /** CDN / download URL for the attachment */
  url: string;
  /** Original filename (e.g. "screenshot.png") */
  filename: string;
  /** MIME content type (e.g. "image/png") */
  contentType: string | null;
  /** File size in bytes */
  size: number;
  /** Optional auth headers required to download (e.g. Slack Bearer token) */
  authHeaders?: Record<string, string>;
}

/** File MIME types that agents can process */
export const SUPPORTED_FILE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/json',
  'text/plain',
] as const;

export type AgentType = string;
