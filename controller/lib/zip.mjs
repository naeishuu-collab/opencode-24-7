// Minimal ZIP reader for GitHub Actions artifacts and logs. Uses the Web
// DecompressionStream so the same code runs in Node and in a Cloudflare Worker.
//
// Limits on purpose (fail closed, no guessing):
//   - zip64 archives are refused (GitHub only uses them beyond 4 GiB)
//   - only store (0) and deflate (8) entries are supported, which is what
//     GitHub produces
export async function readZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const EOCD = 0x06054b50;
  let eocd = -1;
  const minStart = Math.max(0, bytes.byteLength - 22 - 65535);
  for (let i = bytes.byteLength - 22; i >= minStart; i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive: no end-of-central-directory record");

  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  if (off === 0xffffffff) throw new Error("zip64 archives are not supported");

  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > bytes.byteLength || view.getUint32(off, true) !== 0x02014b50) {
      throw new Error("corrupt zip: bad central directory entry");
    }
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    if (compSize === 0xffffffff) throw new Error("zip64 entries are not supported");
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));

    if (localOff + 30 > bytes.byteLength || view.getUint32(localOff, true) !== 0x04034b50) {
      throw new Error(`corrupt zip: bad local header for ${name}`);
    }
    const localNameLen = view.getUint16(localOff + 26, true);
    const localExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    if (!name.endsWith("/")) {
      if (method === 0) entries.set(name, raw);
      else if (method === 8) entries.set(name, await inflateRaw(raw));
      else throw new Error(`unsupported zip compression method ${method} for ${name}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Convenience: find and parse every job.json inside an artifact zip. The upload
// root is the run base, so the path is <runbase>/<job>/job.json (any depth).
export async function readJobJsonFromZip(bytes) {
  const entries = await readZipEntries(bytes);
  const found = [];
  for (const [name, data] of entries) {
    if (!/(^|\/)job\.json$/.test(name)) continue;
    found.push({ name, json: JSON.parse(new TextDecoder().decode(data)) });
  }
  return { entries, jobs: found };
}
