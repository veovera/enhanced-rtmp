import { Command } from 'commander';
import { dumpCommand } from './commands/dump.js';
import { mergeCommand } from './commands/merge.js';

const program = new Command();

program
  .name('eflv')
  .description('CLI tool for inspecting and merging FLV/E-FLV files')
  .version('0.1.0');

program.addCommand(dumpCommand);
program.addCommand(mergeCommand);

program.parse();
