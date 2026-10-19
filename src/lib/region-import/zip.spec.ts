import { inflateRawSync } from 'zlib';

import { crc32, expandZips, readZip } from './zip';
import { importFile } from './region-import';

const inflateRaw = async (b: Uint8Array) => new Uint8Array(inflateRawSync(b));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Written by Python's zipfile: a folder entry, deflated and stored members, a UTF-8 name, macOS
 *  metadata, and a member forced to ZIP64 (sizes in its local header's extra field). */
const PYTHON_ZIP = Buffer.from(
  'UEsDBBQAAAAIAEVUU13VLbgFMwAAAIQDAAAVAAAAYXRsYXMvc2xpY2VfMC5nZW9qc29uq1YqqSxIVbJSUHJLTSwpLUp1zs/JSU0uyczPU9JRUEqDCBYDFUTH1laPKh5VPKqY2ooBUEsDBBQAAAAAAAAAIQAAAAAAAAAAAAAAAAAGAAAAYXRsYXMvUEsDBBQAAAAAAEVUU10AUTncIwAAACMAAAAUAAAAYXRsYXMvcmVnaW9uc2V0Lmpzb257ImNsYXNzSGllcmFyY2h5IjpbeyJuYW1lIjoiSFBGIn1dfVBLAwQUAAAACABFVFNdOZz7BgYAAAAEAAAAIAAAAF9fTUFDT1NYL2F0bGFzLy5fc2xpY2VfMC5nZW9qc29uyyrNywYAUEsDBBQAAAgIAEVUU11gtLHTCQAAAAcAAAAMAAAAYXRsYXMvw6kudHh0K83LTM5PSQUAUEsDBC0AAAAIAAAAIQAmTAu3//////////8NABQAYXRsYXMvYmlnLmJpbgEAEAAABAAAAAAAABgBAAAAAAAAY2BkYmZhZWPn4OTi5uHl4xcQFBIWERUTl5CUkpaRlZNXUFRSVlFVU9fQ1NLW0dXTNzA0MjYxNTO3sLSytrG1s3dwdHJ2cXVz9/D08vbx9fMPCAwKDgkNC4+IjIqOiY2LT0hMSk5JTUvPyMzKzsnNyy8oLCouKS0rr6isqq6pratvaGxqbmlta+/o7Oru6e3rnzBx0uQpU6dNnzFz1uw5c+fNX7Bw0eIlS5ctX7Fy1eo1a9et37Bx0+YtW7dt37Fz1+49e/ftP3Dw0OEjR48dP3Hy1OkzZ8+dv3Dx0uUrV69dv3Hz1u07d+/df/Dw0eMnT589f/Hy1es3b9+9//Dx0+cvX799//Hz1+8/f//9Zxj1/6j/R7D/AVBLAQIUAxQAAAAIAEVUU13VLbgFMwAAAIQDAAAVAAAAAAAAAAAAAACAAQAAAABhdGxhcy9zbGljZV8wLmdlb2pzb25QSwECFAMUAAAAAAAAACEAAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAgAFmAAAAYXRsYXMvUEsBAhQDFAAAAAAARVRTXQBROdwjAAAAIwAAABQAAAAAAAAAAAAAAIABigAAAGF0bGFzL3JlZ2lvbnNldC5qc29uUEsBAhQDFAAAAAgARVRTXTmc+wYGAAAABAAAACAAAAAAAAAAAAAAAIAB3wAAAF9fTUFDT1NYL2F0bGFzLy5fc2xpY2VfMC5nZW9qc29uUEsBAhQDFAAACAgARVRTXWC0sdMJAAAABwAAAAwAAAAAAAAAAAAAAIABIwEAAGF0bGFzL8OpLnR4dFBLAQItAy0AAAAIAAAAIQAmTAu3GAEAAAAEAAANAAAAAAAAAAAAAACAAVYBAABhdGxhcy9iaWcuYmluUEsFBgAAAAAGAAYAfAEAAK0CAAAAAA==',
  'base64',
);

/** One stored member whose central record defers its sizes and offset to a ZIP64 extra field. */
function zip64Central(name: string, data: Uint8Array): Uint8Array {
  const enc = new TextEncoder().encode(name);
  const local = new DataView(new ArrayBuffer(30 + enc.length));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(26, enc.length, true);
  const central = new DataView(new ArrayBuffer(46 + enc.length + 28));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(8, 0x800, true);
  central.setUint32(16, crc32(data), true);
  central.setUint32(20, 0xffffffff, true);
  central.setUint32(24, 0xffffffff, true);
  central.setUint16(28, enc.length, true);
  central.setUint16(30, 28, true);
  central.setUint32(42, 0xffffffff, true);
  new Uint8Array(central.buffer).set(enc, 46);
  const x = 46 + enc.length;
  central.setUint16(x, 0x0001, true);
  central.setUint16(x + 2, 24, true);
  central.setUint32(x + 4, data.length, true); // uncompressed
  central.setUint32(x + 12, data.length, true); // compressed
  central.setUint32(x + 20, 0, true); // local header offset
  const dirAt = local.byteLength + data.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, central.byteLength, true);
  end.setUint32(16, dirAt, true);
  const out = new Uint8Array(dirAt + central.byteLength + 22);
  out.set(new Uint8Array(local.buffer), 0);
  out.set(data, local.byteLength);
  out.set(new Uint8Array(central.buffer), dirAt);
  out.set(new Uint8Array(end.buffer), dirAt + central.byteLength);
  return out;
}

describe('readZip', () => {
  it("reads an archive's members, leaving folders and macOS metadata out", async () => {
    const entries = readZip(new Uint8Array(PYTHON_ZIP), inflateRaw);
    expect(entries.map((e) => e.name)).toEqual([
      'atlas/slice_0.geojson',
      'atlas/regionset.json',
      'atlas/é.txt',
      'atlas/big.bin',
    ]);
    const [slice, set, unicode, big] = entries;
    const geojson = text(await slice.bytes());
    expect(geojson.length).toBe(900); // inflated whole: 20 copies of a 45-character collection
    expect(JSON.parse(geojson.slice(0, 45))).toEqual({ type: 'FeatureCollection', features: [] });
    expect(text(await set.bytes())).toBe('{"classHierarchy":[{"name":"HPF"}]}');
    expect(text(await unicode.bytes())).toBe('unicode');
    const bin = await big.bytes();
    expect(bin.length).toBe(1024);
    expect(bin[257]).toBe(1);
  });

  it('reads sizes and offsets a central record defers to its ZIP64 extra field', async () => {
    const data = new TextEncoder().encode('zip64 member');
    const [entry] = readZip(zip64Central('labels/0/.zarray', data), inflateRaw);
    expect(entry.name).toBe('labels/0/.zarray');
    expect(entry.size).toBe(data.length);
    expect(text(await entry.bytes())).toBe('zip64 member');
  });

  it('refuses a member that fails its CRC, and bytes that are no archive', async () => {
    const bytes = new Uint8Array(PYTHON_ZIP);
    const [, set] = readZip(bytes, inflateRaw);
    const corrupt = bytes.slice();
    const local = new TextDecoder('latin1').decode(corrupt).indexOf('{"classHierarchy"');
    corrupt[local + 1] ^= 0xff;
    await expect(readZip(corrupt, inflateRaw)[1].bytes()).rejects.toThrow(/CRC/);
    await expect(set.bytes()).resolves.toBeDefined();
    expect(() => readZip(new TextEncoder().encode('not a zip'), inflateRaw)).toThrow(/not a zip/);
  });
});

describe('expandZips', () => {
  it('replaces each zip among the files with its members, keeping the others', async () => {
    const files = await expandZips(
      [importFile(new Uint8Array(PYTHON_ZIP), 'atlas.zip'), importFile('{}', 'other.json')],
      inflateRaw,
    );
    expect(files.map((f) => f.name)).toEqual([
      'atlas/slice_0.geojson',
      'atlas/regionset.json',
      'atlas/é.txt',
      'atlas/big.bin',
      'other.json',
    ]);
    expect(await files[1].text()).toBe('{"classHierarchy":[{"name":"HPF"}]}');
  });
});
