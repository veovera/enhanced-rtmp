import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { parseFlvFile, mergeFlvFiles } from '../flv/parser.js';

export const mergeCommand = new Command('merge')
  .description('Merge two FLV/E-FLV files into one')
  .argument('<a>', 'first FLV file')
  .argument('<b>', 'second FLV file')
  .requiredOption('-o, --output <out>', 'output file path (.flv)')
  .option('--multitrack', 'use E-FLV multitrack extensions')
  .action(async (a: string, b: string, options: { output: string; multitrack?: boolean }) => {
    if (!options.output.endsWith('.flv')) {
      console.error('Error: output file must have .flv extension');
      process.exit(1);
    }

    let flvA, flvB;
    try {
      flvA = await parseFlvFile(a, { includeData: true });
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    try {
      flvB = await parseFlvFile(b, { includeData: true });
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    const merged = mergeFlvFiles(flvA, flvB, { multitrack: options.multitrack });
    await writeFile(options.output, merged);

    console.log(`Merged ${a} + ${b} -> ${options.output}`);
  });
