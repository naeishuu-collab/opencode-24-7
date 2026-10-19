#!/usr/bin/env node
// Fails when a run directory still contains secret-like values. CI runs this
// before uploading artifacts: a leaked artifact must never ship, so the scan
// fails closed (unknown/undecidable counts as a leak only for known patterns).
import fs from "node:fs";
import path from "node:path";
import { makeRedactor } from "../runner/lib/util.mjs";

const dir = path.resolve(process.argv[2] ?? "runs");
if (!fs.existsSync(dir)) {
  console.log(`scan: ${dir} does not exist; nothing to scan`);
  process.exit(0);
}

const redact = makeRedactor(process.env);
const offenders = [];
let files = 0;

function scanFile(file) {
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) return; // binary
  const before = redact.count;
  redact.redact(buf.toString("utf8"));
  files++;
  if (redact.count > before) offenders.push(path.relative(dir, file));
}

function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) scanFile(p);
  }
}

walk(dir);
if (offenders.length) {
  console.error(`scan: secret-like value found in ${offenders.length} file(s): ${offenders.join(", ")}`);
  process.exit(1);
}
console.log(`scan: ${files} text file(s) in ${dir} scanned, no secret-like value found`);
