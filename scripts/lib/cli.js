import { parseArgs } from 'node:util';

/**
 * Parses command-line flags; on a mistake prints the problem and the usage text, then exits 2
 * (instead of dumping a stack trace).
 *
 * @param {import('node:util').ParseArgsConfig['options']} options
 * @param {string} usage
 */
export function parseCliArgs(options, usage) {
  try {
    return parseArgs({ options }).values;
  } catch (error) {
    console.error(`${error.message}\n\n${usage}`);
    process.exit(2);
  }
}
