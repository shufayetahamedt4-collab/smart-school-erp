/** Exact single-occurrence string replacement for the mutation proofs. */
import { readFileSync, writeFileSync } from "node:fs";

const [file, find, replace] = process.argv.slice(2);
const src = readFileSync(file, "utf8");
const parts = src.split(find);
if (parts.length !== 2) {
  console.error(`EXPECTED exactly one occurrence of the needle in ${file}, found ${parts.length - 1}`);
  process.exit(2);
}
writeFileSync(file, parts.join(replace));
console.log(`mutated ${file}: 1 occurrence replaced`);
