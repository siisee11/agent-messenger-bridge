/**
 * Default ICommandExecutor implementation using child_process.execSync
 */

import { execSync } from 'child_process';
import type { ICommandExecutor } from '../types/interfaces.js';

export class ShellCommandExecutor implements ICommandExecutor {
  exec(command: string, options?: { encoding?: string; stdio?: any }): string {
    return execSync(command, {
      encoding: (options?.encoding || 'utf-8') as BufferEncoding,
      stdio: options?.stdio,
    }) as string;
  }

  execVoid(command: string, options?: { stdio?: any }): void {
    execSync(command, { stdio: options?.stdio || 'ignore' });
  }
}
