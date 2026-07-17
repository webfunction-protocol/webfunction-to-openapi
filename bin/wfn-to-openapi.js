#!/usr/bin/env node
/**
 * CLI for webfunction-to-openapi.
 *
 * Usage:
 *   wfn-to-openapi <input.json> [-o output.json] [--include-private] [--pretty]
 *   cat package.json | wfn-to-openapi > openapi.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { convertPackageJsonToOpenApi } from '../index.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-o' || arg === '--output') {
      args.output = argv[++i];
    } else if (arg === '--include-private') {
      args.includePrivate = true;
    } else if (arg === '--pretty') {
      args.pretty = true;
    } else if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      [
        'Usage: wfn-to-openapi [input.json] [options]',
        '',
        'Reads a Web Function package definition (from a file, or stdin if no',
        'file is given) and writes an OpenAPI 3.1 document to stdout or a file.',
        '',
        'Options:',
        '  -o, --output <file>   Write the result to a file instead of stdout',
        '  --include-private     Include endpoints flagged as "private"',
        '  --pretty              Pretty-print the JSON output (2-space indent)',
        '  -h, --help            Show this help message',
      ].join('\n')
    );
    return;
  }

  const input = args._[0] ? readFileSync(args._[0], 'utf8') : readStdin();
  const openapi = convertPackageJsonToOpenApi(input, { includePrivate: !!args.includePrivate });
  const output = JSON.stringify(openapi, null, args.pretty ? 2 : undefined);

  if (args.output) {
    writeFileSync(args.output, output + '\n');
  } else {
    console.log(output);
  }
}

main();
