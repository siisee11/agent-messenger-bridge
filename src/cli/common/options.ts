import type { Argv } from 'yargs';

export function addTmuxOptions<T>(y: Argv<T>) {
  return y
    .option('tmux-shared-session-name', {
      type: 'string',
      describe: 'shared tmux session name (without prefix)',
    });
}
