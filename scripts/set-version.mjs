// Sets the app version in package.json, tauri.conf.json and Cargo.toml.
// Used by the release workflow: node scripts/set-version.mjs 1.2.3
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error(`Not a version like 1.2.3: ${version}`);
  process.exit(1);
}

for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.version = version;
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}

const cargo = "src-tauri/Cargo.toml";
writeFileSync(cargo, readFileSync(cargo, "utf8").replace(/^version = ".*"/m, `version = "${version}"`));
console.log(`Version set to ${version}`);
