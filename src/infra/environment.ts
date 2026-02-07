/**
 * Default IEnvironment implementation using process.env and os
 */

import { homedir } from 'os';
import type { IEnvironment } from '../types/interfaces.js';

export class SystemEnvironment implements IEnvironment {
  get(key: string): string | undefined {
    return process.env[key];
  }

  homedir(): string {
    return homedir();
  }

  platform(): string {
    return process.platform;
  }
}
