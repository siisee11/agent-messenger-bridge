import chalk from 'chalk';
import { ensureDaemonRunning, getDaemonStatus, stopDaemon } from '../../app/daemon-service.js';
import { config } from '../../config/index.js';
import { ensureTmuxInstalled } from '../common/tmux.js';

export async function daemonCommand(action: string) {
  const runtimeMode = config.runtimeMode || 'tmux';
  const requiresTmux = runtimeMode === 'tmux';

  switch (action) {
    case 'start': {
      if (requiresTmux) {
        ensureTmuxInstalled();
      }
      const result = await ensureDaemonRunning();
      if (result.alreadyRunning) {
        console.log(chalk.green(`✅ Daemon already running (port ${result.port})`));
        return;
      }
      if (result.ready) {
        console.log(chalk.green(`✅ Daemon started (port ${result.port})`));
      } else {
        console.log(chalk.yellow(`⚠️  Daemon may not be ready. Check logs: ${result.logFile}`));
      }
      break;
    }
    case 'restart': {
      if (requiresTmux) {
        ensureTmuxInstalled();
      }

      const stopped = stopDaemon();
      if (stopped) {
        console.log(chalk.gray('🔄 Daemon stopped. Starting again...'));
      } else {
        console.log(chalk.gray('Daemon was not running. Starting fresh...'));
      }

      const result = await ensureDaemonRunning();
      if (result.ready) {
        console.log(chalk.green(`✅ Daemon restarted (port ${result.port})`));
      } else {
        console.log(chalk.yellow(`⚠️  Daemon may not be ready. Check logs: ${result.logFile}`));
      }
      break;
    }
    case 'stop': {
      if (stopDaemon()) {
        console.log(chalk.green('✅ Daemon stopped'));
      } else {
        console.log(chalk.gray('Daemon was not running'));
      }
      break;
    }
    case 'status': {
      const status = await getDaemonStatus();
      if (status.running) {
        console.log(chalk.green(`✅ Daemon running (port ${status.port})`));
      } else {
        console.log(chalk.gray('Daemon not running'));
      }
      console.log(chalk.gray(`   Log: ${status.logFile}`));
      console.log(chalk.gray(`   PID: ${status.pidFile}`));
      break;
    }
    default:
      console.error(chalk.red(`Unknown action: ${action}`));
      console.log(chalk.gray('Available actions: start, restart, stop, status'));
      process.exit(1);
  }
}
