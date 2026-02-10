import { Command } from 'commander';
import { parseFlvFile } from '../flv/parser.js';

export const dumpCommand = new Command('dump')
  .description('Inspect and dump structural info from an FLV/E-FLV file')
  .argument('<input>', 'path to the FLV file')
  .option('--json', 'output as JSON')
  .option('--verbose', 'show detailed tag information')
  .action(async (input: string, options: { json?: boolean; verbose?: boolean }) => {
    let flv;
    try {
      flv = await parseFlvFile(input);
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(flv, null, 2));
    } else {
      console.log(`FLV Header:`);
      console.log(`  Signature: ${flv.header.signature}`);
      console.log(`  Version: ${flv.header.version}`);
      console.log(`  Audio: ${flv.header.hasAudio}`);
      console.log(`  Video: ${flv.header.hasVideo}`);
      console.log(`  Data Offset: ${flv.header.dataOffset}`);
      console.log(`\nTags: ${flv.tags.length}`);

      if (options.verbose) {
        for (const tag of flv.tags) {
          const typeName =
            tag.tagType === 8 ? 'audio' :
            tag.tagType === 9 ? 'video' :
            tag.tagType === 18 ? 'script' : `unknown(${tag.tagType})`;
          console.log(`  [${typeName}] size=${tag.dataSize} ts=${tag.timestamp}`);
        }
      }
    }
  });
