/** List every published version of the dataset, newest first. */
import { listVersions } from '../data/discover.ts';

const versions = await listVersions();
console.log(`${versions.length} published versions\n`);
for (const [i, v] of versions.entries()) {
  console.log(`${i === 0 ? '*' : ' '} ${v.quarter}  ${v.date}  ${v.uddi}  ${v.title}`);
}
console.log('\n* = used by default');
