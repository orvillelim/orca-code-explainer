// A streamable-HTTP MCP server on loopback that answers an agent's project reads from one project
// folder. Each agent run gets its own bearer token, bound to that folder.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { listProjectFiles, readProjectFile, searchProjectCode } from './project-reader.mjs'

const BODY_MAX_BYTES = 256 * 1024

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const TOOLS = [
  {
    name: 'read_project_file',
    description:
      'Read a project file as saved, with line numbers. Paths are relative to the project root. Use bounded ranges (default 200 lines, at most 400).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 }
      },
      required: ['path'],
      additionalProperties: false
    },
    annotations: READ_ONLY
  },
  {
    name: 'list_project_files',
    description: 'List up to 3000 project files, relative to the root, without dependency folders.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY
  },
  {
    name: 'search_project_code',
    description:
      'Find literal text in project files. Returns at most 40 matches as path:line: text.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false
    },
    annotations: READ_ONLY
  }
]

function sameToken(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function createWorkspaceMcp() {
  /** @type {Map<string, { root: string, onTool: (summary: string) => void }>} */
  const bindings = new Map()
  let server = null
  let listening = null

  const tools = {
    read_project_file: (root, args) => {
      if (typeof args.path !== 'string') {
        throw new Error('path is required')
      }
      const startLine = Number.isInteger(args.startLine) ? args.startLine : 1
      return readProjectFile(
        root,
        args.path,
        startLine,
        Number.isInteger(args.endLine) ? args.endLine : startLine + 199
      )
    },
    list_project_files: (root) => listProjectFiles(root),
    search_project_code: (root, args) => searchProjectCode(root, args.query)
  }

  async function dispatch(binding, method, params = {}) {
    if (method === 'initialize') {
      return {
        protocolVersion:
          typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'orca-code-explainer', version: '0.1.0' }
      }
    }
    if (method === 'ping') {
      return {}
    }
    if (method === 'tools/list') {
      return { tools: TOOLS }
    }
    if (method !== 'tools/call') {
      throw Object.assign(new Error(`Unsupported method ${method}`), { rpcCode: -32601 })
    }
    const tool = tools[params.name]
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool ${params.name}` }] }
    }
    try {
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
      const { text, summary } = await tool(binding.root, args)
      binding.onTool(summary)
      return { content: [{ type: 'text', text }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      binding.onTool(`refused ${params.name}: ${message}`)
      return { isError: true, content: [{ type: 'text', text: message }] }
    }
  }

  async function answer(binding, message) {
    if (message.id === undefined || message.id === null) {
      return null
    }
    try {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: await dispatch(binding, message.method, message.params)
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: error.rpcCode ?? -32603,
          message: error instanceof Error ? error.message : 'failed'
        }
      }
    }
  }

  function bindingFor(request) {
    const header = request.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    for (const [known, binding] of bindings) {
      if (token && sameToken(token, known)) {
        return binding
      }
    }
    return null
  }

  function handle(request, response) {
    // Why the Host check: a web page cannot reach this server by DNS rebinding.
    const hostHeader = request.headers.host ?? ''
    if (!/^127\.0\.0\.1:\d+$/.test(hostHeader) || request.url !== '/mcp') {
      response.writeHead(404).end()
      return
    }
    const binding = bindingFor(request)
    if (!binding) {
      response.writeHead(401).end()
      return
    }
    if (request.method !== 'POST') {
      // No server-initiated stream; the client falls back to plain POSTs.
      response.writeHead(request.method === 'DELETE' ? 200 : 405).end()
      return
    }
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        response.writeHead(413).end()
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', async () => {
      let parsed
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        response.writeHead(400).end()
        return
      }
      const batch = Array.isArray(parsed) ? parsed : [parsed]
      const answers = (await Promise.all(batch.map((message) => answer(binding, message)))).filter(
        Boolean
      )
      if (answers.length === 0) {
        response.writeHead(202).end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]))
    })
  }

  async function ensureListening() {
    if (listening) {
      return listening
    }
    server = createServer(handle)
    listening = new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    })
    return listening
  }

  return {
    /** A token and URL for one agent run; `release` revokes it. */
    async bind(root, onTool) {
      const port = await ensureListening()
      const token = randomBytes(32).toString('hex')
      bindings.set(token, { root, onTool })
      return { url: `http://127.0.0.1:${port}/mcp`, token, release: () => bindings.delete(token) }
    },
    close() {
      bindings.clear()
      server?.close()
      server = null
      listening = null
    }
  }
}
