import chalk from 'chalk';
import { resolve } from 'path';
import { defaultDaemonManager } from '../../daemon.js';
import { ensureTmuxInstalled } from '../common/tmux.js';

export async function daemonCommand(action: string) {
  const port = defaultDaemonManager.getPort();

  switch (action) {
    case 'start': {
      ensureTmuxInstalled();
      const running = await defaultDaemonManager.isRunning();
      if (running) {
        console.log(chalk.green(`✅ Daemon already running (port ${port})`));
        return;
      }
      console.log(chalk.gray('Starting daemon...'));
      const entryPoint = resolve(import.meta.dirname, '../../daemon-entry.js');
      defaultDaemonManager.startDaemon(entryPoint);
      const ready = await defaultDaemonManager.waitForReady();
      if (ready) {
        console.log(chalk.green(`✅ Daemon started (port ${port})`));
      } else {
        console.log(chalk.yellow(`⚠️  Daemon may not be ready. Check logs: ${defaultDaemonManager.getLogFile()}`));
      }
      break;
    }
    case 'stop': {
      if (defaultDaemonManager.stopDaemon()) {
        console.log(chalk.green('✅ Daemon stopped'));
      } else {
        console.log(chalk.gray('Daemon was not running'));
      }
      break;
    }
    case 'status': {
      const running = await defaultDaemonManager.isRunning();
      if (running) {
        console.log(chalk.green(`✅ Daemon running (port ${port})`));
      } else {
        console.log(chalk.gray('Daemon not running'));
      }
      console.log(chalk.gray(`   Log: ${defaultDaemonManager.getLogFile()}`));
      console.log(chalk.gray(`   PID: ${defaultDaemonManager.getPidFile()}`));
      break;
    }
    default:
      console.error(chalk.red(`Unknown action: ${action}`));
      console.log(chalk.gray('Available actions: start, stop, status'));
      process.exit(1);
  }
}
