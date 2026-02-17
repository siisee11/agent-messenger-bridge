import { installOpencodePlugin } from '../opencode/plugin-installer.js';
import { installClaudePlugin } from '../claude/plugin-installer.js';
import { installGeminiHook } from '../gemini/hook-installer.js';

export type AgentIntegrationMode = 'install' | 'reinstall';

export type AgentIntegrationResult = {
  agentType: string;
  eventHookInstalled: boolean;
  claudePluginDir?: string;
  infoMessages: string[];
  warningMessages: string[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function installAgentIntegration(
  agentType: string,
  projectPath: string,
  mode: AgentIntegrationMode = 'install',
): AgentIntegrationResult {
  const infoMessages: string[] = [];
  const warningMessages: string[] = [];

  const ok = (message: string) => {
    infoMessages.push(message);
  };
  const fail = (message: string) => {
    warningMessages.push(message);
  };

  if (agentType === 'opencode') {
    try {
      const pluginPath = installOpencodePlugin(projectPath);
      ok(mode === 'install'
        ? `🧩 Installed OpenCode plugin: ${pluginPath}`
        : `Reinstalled OpenCode plugin: ${pluginPath}`);
      return { agentType, eventHookInstalled: true, infoMessages, warningMessages };
    } catch (error) {
      fail(mode === 'install'
        ? `Failed to install OpenCode plugin: ${errorMessage(error)}`
        : `Could not reinstall OpenCode plugin: ${errorMessage(error)}`);
      return { agentType, eventHookInstalled: false, infoMessages, warningMessages };
    }
  }

  if (agentType === 'claude') {
    try {
      const pluginPath = installClaudePlugin(projectPath);
      ok(mode === 'install'
        ? `🪝 Installed Claude Code plugin: ${pluginPath}`
        : `Reinstalled Claude Code plugin: ${pluginPath}`);
      return {
        agentType,
        eventHookInstalled: true,
        claudePluginDir: pluginPath,
        infoMessages,
        warningMessages,
      };
    } catch (error) {
      fail(mode === 'install'
        ? `Failed to install Claude Code plugin: ${errorMessage(error)}`
        : `Could not reinstall Claude Code plugin: ${errorMessage(error)}`);
      return { agentType, eventHookInstalled: false, infoMessages, warningMessages };
    }
  }

  if (agentType === 'gemini') {
    try {
      const hookPath = installGeminiHook(projectPath);
      ok(mode === 'install'
        ? `🪝 Installed Gemini CLI hook: ${hookPath}`
        : `Reinstalled Gemini CLI hook: ${hookPath}`);
      return { agentType, eventHookInstalled: true, infoMessages, warningMessages };
    } catch (error) {
      fail(mode === 'install'
        ? `Failed to install Gemini CLI hook: ${errorMessage(error)}`
        : `Could not reinstall Gemini CLI hook: ${errorMessage(error)}`);
      return { agentType, eventHookInstalled: false, infoMessages, warningMessages };
    }
  }

  return { agentType, eventHookInstalled: false, infoMessages, warningMessages };
}
