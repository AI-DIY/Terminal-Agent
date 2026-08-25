type InspectorResponse = {
  id?: number
  result?: {
    result?: { value?: unknown; description?: string }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }
  error?: { message?: string }
}

function inspectorEndpoint(frontendUrl: string): string {
  const frontend = new URL(frontendUrl)
  const target = frontend.searchParams.get('ws')
  if (!target) throw new Error('Node Inspector frontend does not expose a WebSocket target')
  return `ws://${target}`
}

export async function evaluateNodeInspector<T>(frontendUrl: string, expression: string): Promise<T> {
  const socket = new WebSocket(inspectorEndpoint(frontendUrl))
  const pending = new Map<number, { resolve: (value: InspectorResponse) => void; reject: (reason: Error) => void }>()
  let nextId = 0
  let closed = false

  const rejectPending = (reason: Error): void => {
    for (const request of pending.values()) request.reject(reason)
    pending.clear()
  }
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('Unable to connect to Node Inspector')), { once: true })
  })
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return
    const response = JSON.parse(event.data) as InspectorResponse
    if (response.id === undefined) return
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    request.resolve(response)
  })
  socket.addEventListener('error', () => rejectPending(new Error('Node Inspector connection failed')))
  socket.addEventListener('close', () => {
    closed = true
    rejectPending(new Error('Node Inspector connection closed'))
  })

  const request = async (method: string, params?: Record<string, unknown>): Promise<InspectorResponse> => {
    await opened
    if (closed || socket.readyState !== WebSocket.OPEN) throw new Error('Node Inspector connection is not open')
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Node Inspector ${method} timed out`))
      }, 10_000)
      pending.set(id, {
        resolve: response => {
          clearTimeout(timeout)
          resolve(response)
        },
        reject: error => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  try {
    await request('Runtime.enable')
    const response = await request('Runtime.evaluate', {
      expression,
      returnByValue: true,
      throwOnSideEffect: true,
    })
    if (response.error?.message) throw new Error(response.error.message)
    const exception = response.result?.exceptionDetails
    if (exception) throw new Error(exception.exception?.description ?? exception.text ?? 'Node Inspector evaluation failed')
    return response.result?.result?.value as T
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
  }
}
