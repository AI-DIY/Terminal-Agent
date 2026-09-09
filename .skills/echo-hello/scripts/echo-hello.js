const value = process.argv.slice(2).join(' ').trim()
const normalized = value.replace(/\s+/g, ' ').slice(0, 200)
process.stdout.write(normalized ? `echo: ${normalized}\n` : 'echo: (empty)\n')
