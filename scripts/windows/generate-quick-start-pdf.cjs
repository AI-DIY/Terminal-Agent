/* global __dirname, __filename, console, module, process, require, setTimeout, clearTimeout */
/* eslint-disable @typescript-eslint/no-require-imports */

// The release guide is authored in Markdown, but the standalone ZIP also
// carries a printable PDF.  Electron is already a build dependency, so use its
// bundled Chromium renderer instead of requiring a separate converter on the
// release machine.  The renderer is intentionally small and only implements
// the Markdown constructs used by the guide (headings, lists, code, links and
// images).

const { existsSync } = require('node:fs')
const { mkdir, mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises')
const { join, relative, resolve, sep } = require('node:path')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const GUIDE_NAME = '快速安装手册.md'
const PDF_NAME = '快速安装手册.pdf'
const RENDERER_FLAG = '--electron-render-markdown-pdf'
const DEFAULT_TIMEOUT_MS = 60_000

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#96;')
}

function localImageUrl(source, rootDirectory) {
  const unwrapped = String(source).trim().replace(/^<|>$/g, '')
  if (!unwrapped || /^(?:https?:|data:|javascript:)/i.test(unwrapped)) return undefined
  const candidate = resolve(rootDirectory, unwrapped)
  const fromRoot = relative(resolve(rootDirectory), candidate)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return undefined
  if (!existsSync(candidate)) return undefined
  return pathToFileURL(candidate).href
}

function renderInline(value, rootDirectory) {
  let rendered = escapeHtml(value)
  // Replace images before links.  The source has already been escaped, but
  // Markdown URLs do not contain HTML-significant characters in this guide.
  rendered = rendered.replace(/!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+['"][^'"]*['"])?\)/g, (_match, alt, wrappedSource, plainSource) => {
    const source = wrappedSource ?? plainSource
    const url = localImageUrl(source, rootDirectory)
    return url
      ? `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(alt)}" loading="eager">`
      : escapeHtml(alt)
  })
  rendered = rendered.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_match, label, url) => `<a href="${escapeAttribute(url)}">${label}</a>`)
  rendered = rendered.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  rendered = rendered.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  rendered = rendered.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
  rendered = rendered.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  rendered = rendered.replace(/_([^_\n]+)_/g, '<em>$1</em>')
  return rendered
}

function markdownToHtml(markdown, { rootDirectory } = {}) {
  const root = resolve(rootDirectory ?? process.cwd())
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = line.match(/^\s*(```+|~~~+)\s*([^ ]*)\s*$/)
    if (fence) {
      const marker = fence[1]
      const code = []
      index += 1
      while (index < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push(`<pre><code class="language-${escapeAttribute(fence[2] || 'text')}">${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      const level = heading[1].length
      blocks.push(`<h${level}>${renderInline(heading[2], root)}</h${level}>`)
      index += 1
      continue
    }

    const image = line.match(/^\s*!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+['"][^'"]*['"])?\)\s*$/)
    if (image) {
      const source = image[2] ?? image[3]
      const url = localImageUrl(source, root)
      if (url) blocks.push(`<figure><img src="${escapeAttribute(url)}" alt="${escapeAttribute(image[1])}" loading="eager"><figcaption>${renderInline(image[1], root)}</figcaption></figure>`)
      else blocks.push(`<p>${renderInline(image[1], root)}</p>`)
      index += 1
      continue
    }

    const list = line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/)
    if (list) {
      const ordered = /^\d/.test(list[1])
      const items = []
      while (index < lines.length) {
        const item = lines[index].match(/^\s*([-+*]|\d+[.)])\s+(.+)$/)
        if (!item || /^\d/.test(item[1]) !== ordered) break
        items.push(`<li>${renderInline(item[2], root)}</li>`)
        index += 1
      }
      blocks.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }

    const paragraph = [line.trim()]
    index += 1
    while (index < lines.length && lines[index].trim()) {
      if (/^\s*(#{1,6})\s+/.test(lines[index]) || /^\s*([-+*]|\d+[.)])\s+/.test(lines[index]) || /^\s*(```+|~~~+)/.test(lines[index]) || /^\s*!\[/.test(lines[index])) break
      paragraph.push(lines[index].trim())
      index += 1
    }
    blocks.push(`<p>${renderInline(paragraph.join(' '), root)}</p>`)
  }

  return blocks.join('\n')
}

function documentHtml(markdown, { rootDirectory, title = PDF_NAME } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
@page { size: A4; margin: 16mm 15mm 17mm; }
* { box-sizing: border-box; }
html { background: #fff; }
body { color: #263241; font-family: "Microsoft YaHei", "Noto Sans CJK SC", "Segoe UI", sans-serif; font-size: 11pt; line-height: 1.72; margin: 0; overflow-wrap: anywhere; }
h1, h2, h3, h4, h5, h6 { color: #4d2d76; line-height: 1.3; margin: 1.15em 0 .45em; break-after: avoid; }
h1 { color: #24133d; font-size: 25pt; text-align: center; margin-top: .1em; }
h2 { border-bottom: 1px solid #ded2ec; font-size: 17pt; padding-bottom: .16em; }
h3 { font-size: 13pt; }
p { margin: .35em 0 .75em; }
ul, ol { margin: .35em 0 .85em 1.35em; padding: 0; }
li { margin: .2em 0; }
code { background: #f2eef8; border: 1px solid #d9cce8; border-radius: 2px; color: #392253; font-family: Consolas, "Microsoft YaHei", monospace; font-size: .92em; padding: .08em .28em; }
pre { background: #f2eef8; border: 1px solid #d9cce8; border-radius: 2px; padding: 9px 11px; white-space: pre-wrap; word-break: break-word; break-inside: avoid; }
pre code { background: transparent; border: 0; padding: 0; }
a { color: #4d2d76; }
figure { margin: 1em 0; text-align: center; break-inside: avoid; }
figure img { display: block; margin: 0 auto; max-height: 115mm; max-width: 100%; object-fit: contain; }
figcaption { color: #5d6876; font-size: 9.5pt; margin-top: .35em; }
img { max-width: 100%; }
</style>
</head>
<body>${markdownToHtml(markdown, { rootDirectory })}</body>
</html>`
}

function electronExecutable(explicitPath) {
  if (explicitPath) return explicitPath
  try {
    const electron = require('electron')
    if (typeof electron === 'string' && electron) return electron
  }
  catch {
    // The caller receives a focused error below when Electron is unavailable.
  }
  throw new Error('Electron is required to convert the quick-install Markdown guide to PDF.')
}

function waitForChild(child, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* the renderer may have exited during timeout handling */ }
      reject(new Error(`Timed out after ${timeoutMs} ms while rendering the quick-install PDF.`))
    }, timeoutMs)
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`Electron PDF renderer exited with status ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim()}` : '.'}`))
    })
  })
}

async function requireNonEmptyFile(path, label) {
  let details
  try { details = await stat(path) }
  catch { throw new Error(`Expected ${label} at ${path}.`) }
  if (!details.isFile() || details.size === 0) throw new Error(`Expected non-empty ${label} at ${path}.`)
  return details
}

async function generateQuickStartPdf({
  projectRoot = resolve(__dirname, '..', '..'),
  markdownPath = join(projectRoot, GUIDE_NAME),
  outputPath = join(projectRoot, 'release', PDF_NAME),
  electronPath,
  spawnProcess = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const sourcePath = resolve(markdownPath)
  const destinationPath = resolve(outputPath)
  await requireNonEmptyFile(sourcePath, 'quick-install Markdown guide')
  const markdown = await readFile(sourcePath, 'utf8')
  if (!markdown.trim()) throw new Error(`Quick-install Markdown guide is empty at ${sourcePath}.`)

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-guide-'))
  const htmlPath = join(temporaryDirectory, 'guide.html')
  try {
    await writeFile(htmlPath, documentHtml(markdown, { rootDirectory: projectRoot, title: PDF_NAME }), 'utf8')
    await mkdir(resolve(destinationPath, '..'), { recursive: true })
    const child = spawnProcess(electronExecutable(electronPath), [
      `--user-data-dir=${join(temporaryDirectory, 'profile')}`,
      '--disable-gpu',
      '--no-sandbox',
      __filename,
      RENDERER_FLAG,
      htmlPath,
      destinationPath,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
    })
    await waitForChild(child, { timeoutMs })
    const pdf = await requireNonEmptyFile(destinationPath, 'generated quick-install PDF')
    const header = (await readFile(destinationPath)).subarray(0, 5).toString('ascii')
    if (header !== '%PDF-') throw new Error(`Generated quick-install PDF has an invalid header at ${destinationPath}.`)
    return { path: destinationPath, bytes: pdf.size, sourcePath }
  }
  finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function renderInElectron(htmlPath, outputPath) {
  const { app, BrowserWindow } = require('electron')
  console.error('PDF renderer: starting', htmlPath, outputPath)
  app.disableHardwareAcceleration()
  console.error('PDF renderer: waiting ready')
  await app.whenReady()
  console.error('PDF renderer: ready')
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { sandbox: false },
  })
  try {
    console.error('PDF renderer: loading')
    await window.loadFile(resolve(htmlPath))
    console.error('PDF renderer: loaded')
    await window.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map(image => image.complete
        ? Promise.resolve()
        : new Promise(resolve => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); })));
    })()`)
    console.error('PDF renderer: resources ready')
    const pdf = await window.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    })
    console.error('PDF renderer: printed', pdf.length)
    await writeFile(resolve(outputPath), pdf)
  }
  finally {
    window.destroy()
    app.quit()
  }
}

async function main() {
  const rendererFlagIndex = process.argv.indexOf(RENDERER_FLAG)
  if (rendererFlagIndex >= 0) {
    // Electron moves command-line switches ahead of the application path, so
    // argv can be either [electron, flag, script, html, output] or
    // [electron, script, flag, html, output]. Filter the known script path and
    // consume the two paths that follow the flag.
    const rendererPaths = process.argv
      .slice(rendererFlagIndex + 1)
      .filter(argument => resolve(argument) !== resolve(__filename))
    if (rendererPaths.length < 2) throw new Error('Electron PDF renderer requires an HTML input and PDF output path.')
    await renderInElectron(rendererPaths[0], rendererPaths[1])
    return
  }
  const projectRoot = resolve(__dirname, '..', '..')
  const markdownPath = process.argv.includes('--markdown') ? resolve(process.argv[process.argv.indexOf('--markdown') + 1]) : join(projectRoot, GUIDE_NAME)
  const outputPath = process.argv.includes('--output') ? resolve(process.argv[process.argv.indexOf('--output') + 1]) : join(projectRoot, 'release', PDF_NAME)
  const result = await generateQuickStartPdf({ projectRoot, markdownPath, outputPath })
  process.stdout.write(`${result.path}\n`)
}

// Electron loads the entry script as the app's main module, but its CommonJS
// loader does not always set `require.main` to this file.  Recognize the
// private renderer flag explicitly so the child process cannot sit idle until
// the parent timeout expires.
if (require.main === module || (process.versions.electron && process.argv.includes(RENDERER_FLAG))) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  GUIDE_NAME,
  PDF_NAME,
  documentHtml,
  generateQuickStartPdf,
  markdownToHtml,
  renderInline,
}
