const fs = require('node:fs')
const path = process.argv[2]
if (!path) {
  console.error('usage: node inspect-json.js <file>')
  process.exitCode = 2
} else {
  try {
    const value = JSON.parse(fs.readFileSync(path, 'utf8'))
    const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []
    process.stdout.write(JSON.stringify({ type: Array.isArray(value) ? 'array' : typeof value, keys }) + '\n')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
