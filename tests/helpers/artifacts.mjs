// Build a real (deflate-compressed) zip in memory so artifact handling can be
// tested without a network round trip to GitHub.
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

export function makeZip(files, { store = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    const data = store ? raw : zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(0, 10); // time/date: fixed
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, end]);
}

// A job.json shaped like the one runner/run-job.mjs writes.
export function makeJobJson(overrides = {}) {
  return {
    jobId: "job-test",
    schema: 1,
    status: "success",
    exitCode: 0,
    reason: null,
    attempts: 1,
    maxAttempts: 1,
    model: "opencode/deepseek-v4.1-flash-free",
    agent: "build",
    opencode: { bin: "opencode", version: "2.0.32" },
    usage: {
      steps: 12,
      tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 150 },
      costUsd: 0,
      costReported: false,
    },
    costPolicy: { model: "opencode/deepseek-v4.1-flash-free", modelAllowlisted: true, requireCostReport: false, costReported: false },
    verification: { cmd: "npm test", exitCode: 0, timedOut: false, status: "passed" },
    target: { commitBefore: "abc123", commitAfter: "abc123", dirtyBefore: false, dirtyAfter: true, changedPaths: ["runner/lib/util.mjs"] },
    session: { id: "ses_test" },
    notes: [],
    finalText: "done",
    ...overrides,
  };
}

export function makeArtifactZip(jobJsonOverrides = {}, { diff = "diff --git a/x b/x\n" } = {}) {
  return makeZip({
    "run-base/job-test/job.json": JSON.stringify(makeJobJson(jobJsonOverrides)),
    "run-base/job-test/diff.patch": diff,
    "run-base/job-test/summary.md": "# Job\n\n- status: success\n",
  });
}
