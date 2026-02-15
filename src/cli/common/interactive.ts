import { createInterface } from 'readline';
import chalk from 'chalk';

export function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function confirmYesNo(question: string, defaultValue: boolean): Promise<boolean> {
  while (true) {
    const answer = (await prompt(question)).trim().toLowerCase();
    if (!answer) return defaultValue;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    console.log(chalk.yellow('Please answer y(es) or n(o).'));
  }
}

export function isInteractiveShell(): boolean {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}
