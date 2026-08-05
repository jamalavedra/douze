/**
 * A store-only ZIP writer. An `.mcpb` is a zip (ADR-008) and this is the whole of what Recon
 * needs to produce one — Node ships no zip writer, and a compression dependency would be a new
 * piece of supply chain for a format that is a header, a payload, and a footer.
 */
export interface ZipEntry {
  path: string
  data: Buffer
}

export function zip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.path.replace(/\\/g, '/'), 'utf8')
    const crc = crc32(entry.data)
    const size = entry.data.length

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(0, 6) // flags
    header.writeUInt16LE(0, 8) // method: stored
    header.writeUInt16LE(0, 10) // mod time
    header.writeUInt16LE(0x0021, 12) // mod date — fixed, so a rebuild is byte-identical
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(size, 18)
    header.writeUInt32LE(size, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)
    local.push(header, name, entry.data)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4) // version made by
    record.writeUInt16LE(20, 6) // version needed
    record.writeUInt16LE(0, 8)
    record.writeUInt16LE(0, 10)
    record.writeUInt16LE(0, 12)
    record.writeUInt16LE(0x0021, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(size, 20)
    record.writeUInt32LE(size, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt16LE(0, 30) // extra length
    record.writeUInt16LE(0, 32) // comment length
    record.writeUInt16LE(0, 34) // disk number
    record.writeUInt16LE(0, 36) // internal attributes
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38) // external attributes: regular file, 0644
    record.writeUInt32LE(offset, 42)
    central.push(record, name)

    offset += header.length + name.length + size
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...local, directory, end])
}

const TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()

export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
