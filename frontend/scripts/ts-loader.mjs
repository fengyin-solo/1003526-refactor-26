/**
 * 极简 ESM loader：用 typescript 转译 .ts/.mts，并解析 @/ 别名到 src/。
 * 仅供本地不变量验证脚本使用，不参与前端构建。
 */
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as ts from 'typescript'

const require = createRequire(import.meta.url)
const root = process.cwd()

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const base = `${root}/src/${specifier.slice(2)}`
    const candidates = [base, `${base}.ts`, `${base}.mts`, `${base}/index.ts`]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true }
      }
    }
  }
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    try {
      const baseUrl = new URL(specifier, context.parentURL)
      const basePath = fileURLToPath(baseUrl)
      const candidates = [basePath, `${basePath}.ts`, `${basePath}.mts`, `${basePath}/index.ts`]
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true }
        }
      }
    } catch {
      // 落到默认解析
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && /\.(ts|mts|cts)$/.test(url)) {
    const filePath = fileURLToPath(url)
    const source = await ts.sys.readFile(filePath)
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        esModuleInterop: true,
        sourceMap: false,
      },
      fileName: filePath,
    })
    return { format: 'module', source: outputText, shortCircuit: true }
  }
  return nextLoad(url, context)
}

void URL
