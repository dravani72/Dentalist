/* Loads a billing code set into the database (owner connection).
 *   npm run codes:load -- --synthetic
 *   npm run codes:load -- --cdt "CDT 2027" --codes cdt-2027.csv --rules cdt-2027-rules.csv
 * The CDT files come from the practice's ADA license and are never committed.
 */
import { Client } from 'pg';
import { loadConfig } from '../config';
import { loadLicensedCdt, loadSyntheticCodes } from '../billing/code-loader';

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const owner = new Client({ connectionString: loadConfig().databaseOwnerUrl });
  await owner.connect();
  try {
    if (args.includes('--synthetic')) {
      await loadSyntheticCodes(owner);
      console.log('Synthetic code set loaded.');
    } else if (arg('--cdt') && arg('--codes') && arg('--rules')) {
      const r = await loadLicensedCdt(owner, arg('--cdt')!, arg('--codes')!, arg('--rules')!);
      console.log(`Loaded ${r.codes} codes and ${r.rules} rules as ${arg('--cdt')}.`);
    } else {
      console.log('Usage: --synthetic | --cdt <version> --codes <file.csv> --rules <file.csv>');
      process.exitCode = 1;
    }
  } finally {
    await owner.end();
  }
}

void main();
