import { describe, expect, it } from 'vitest'
import {
  chatDocumentSchema,
  chatOperationSchema,
  indexRemoveOperations,
  type ChatDocument,
  type ChatOperation,
} from '../../../src/main/chat/chat-contracts'

const createdAt = '2026-08-16T08:00:00.000Z'
const messageAt = '2026-08-16T08:00:00.001Z'
const updatedAt = '2026-08-16T08:01:00.000Z'
const fingerprint = 'a'.repeat(64)

function validDocument(): ChatDocument {
  return {
    version: 1,
    liveChatId: 'chat-1',
    chats: [{ id: 'chat-1', title: 'Chat', createdAt, updatedAt, mode: 'copilot' }],
    messages: [{
      id: 'message-1', chatId: 'chat-1', requestId: 'message-request-1', role: 'user',
      content: 'hello', createdAt: messageAt, state: 'complete',
    }],
    associations: [{
      id: 'association-1', chatId: 'chat-1', requestId: 'association-request-1',
      historyId: 'history-1', hostname: 'host-1', title: 'Shell', status: 'open', associatedAt: updatedAt,
    }],
    operations: [
      {
        requestId: 'create-request-1', kind: 'create', chatId: 'chat-1', fingerprint,
        appliedAt: createdAt,
        result: { createdAt, updatedAt: createdAt, mode: 'copilot' },
      },
      {
        requestId: 'message-request-1', kind: 'appendMessage', chatId: 'chat-1', fingerprint, resultId: 'message-1',
        appliedAt: messageAt,
        result: { createdAt, updatedAt: messageAt, mode: 'copilot' },
      },
      {
        requestId: 'association-request-1', kind: 'associateShell', chatId: 'chat-1', fingerprint, resultId: 'association-1',
        appliedAt: updatedAt,
        result: { createdAt, updatedAt, mode: 'copilot' },
      },
    ],
  }
}

function findOperation(document: ChatDocument, requestId: string): ChatDocument['operations'][number] {
  return document.operations.find(operation => operation.requestId === requestId)!
}

function closeAssociation(document: ChatDocument): void {
  document.associations[0].status = 'closed'
  document.associations[0].closedAt = updatedAt
  document.associations[0].closeRequestId = 'close-request-1'
  document.operations.push({
    requestId: 'close-request-1',
    kind: 'closeAssociation',
    chatId: 'chat-1',
    fingerprint,
    appliedAt: updatedAt,
    resultId: 'association-1',
    result: { createdAt, updatedAt, mode: 'copilot' },
  })
}

function withAppliedAt(document: ChatDocument): ChatDocument {
  for (const operation of document.operations) {
    const timedOperation = operation as typeof operation & { appliedAt: string }
    timedOperation.appliedAt = operation.result?.updatedAt ?? updatedAt
  }
  return document
}

describe('chatDocumentSchema semantic invariants', () => {
  it('requires the persisted live workspace to reference an active chat', () => {
    const missing = validDocument()
    missing.liveChatId = 'missing-chat'
    expect(chatDocumentSchema.safeParse(missing).success).toBe(false)

    const deleted = validDocument()
    deleted.chats[0].deletedAt = updatedAt
    deleted.chats[0].title = '已删除聊天'
    deleted.liveChatId = deleted.chats[0].id
    expect(chatDocumentSchema.safeParse(deleted).success).toBe(false)
  })

  it('requires a strict lowercase 64-hex request fingerprint on every operation', () => {
    const operation = {
      requestId: 'create-1',
      kind: 'create',
      chatId: 'chat-1',
      appliedAt: createdAt,
      fingerprint: 'a'.repeat(64),
      result: { createdAt, updatedAt: createdAt, mode: 'copilot' },
    }

    expect(chatOperationSchema.safeParse(operation).success).toBe(true)
    expect(chatOperationSchema.safeParse({ ...operation, fingerprint: undefined }).success).toBe(false)
    expect(chatOperationSchema.safeParse({ ...operation, fingerprint: 'a'.repeat(63) }).success).toBe(false)
    expect(chatOperationSchema.safeParse({ ...operation, fingerprint: 'A'.repeat(64) }).success).toBe(false)
    expect(chatOperationSchema.safeParse({ ...operation, fingerprint: 'g'.repeat(64) }).success).toBe(false)
  })

  it('indexes every chat remove count and final remove in one operation pass', () => {
    const operations = [
      { requestId: 'create-1', kind: 'create', chatId: 'chat-1', fingerprint, appliedAt: createdAt },
      { requestId: 'remove-1', kind: 'remove', chatId: 'chat-1', fingerprint, appliedAt: messageAt },
      { requestId: 'remove-2', kind: 'remove', chatId: 'chat-2', fingerprint, appliedAt: updatedAt },
      { requestId: 'remove-3', kind: 'remove', chatId: 'chat-1', fingerprint, appliedAt: updatedAt },
    ] as ChatOperation[]

    expect(indexRemoveOperations(operations)).toEqual(new Map([
      ['chat-1', { count: 2, final: operations[3] }],
      ['chat-2', { count: 1, final: operations[2] }],
    ]))
  })

  it('accepts a semantically consistent document', () => {
    expect(chatDocumentSchema.parse(validDocument())).toEqual(validDocument())
  })

  it('accepts safe fixed-size appliedAt metadata on operations', () => {
    const document = withAppliedAt(validDocument())
    expect(chatDocumentSchema.parse(document)).toEqual(document)
  })

  it('rejects an operation without appliedAt', () => {
    const document = withAppliedAt(validDocument())
    delete (document.operations[1] as unknown as { appliedAt?: string }).appliedAt
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it('rejects operation appliedAt values that move backward globally across chats', () => {
    const document = withAppliedAt(validDocument())
    const secondChat = {
      id: 'chat-2', title: 'Second', createdAt, updatedAt: createdAt, mode: 'copilot' as const,
    }
    document.chats.push(secondChat)
    document.operations.push({
      requestId: 'create-request-2', kind: 'create', chatId: 'chat-2', fingerprint, appliedAt: createdAt,
      result: { createdAt, updatedAt: createdAt, mode: 'copilot' },
    })
    expect(chatDocumentSchema.safeParse(document).success).toBe(false)
  })

  it('rejects adjacent active-chat operations with equal appliedAt', () => {
    const document = validDocument()
    document.messages[0].createdAt = createdAt
    document.operations[1].appliedAt = createdAt
    document.operations[1].result!.updatedAt = createdAt

    expect(chatDocumentSchema.safeParse(document).success).toBe(false)
  })

  it('rejects adjacent operations with equal appliedAt, including tombstone remove then create', () => {
    const document: ChatDocument = {
      version: 1,
      liveChatId: null,
      chats: [{
        id: 'chat-1', title: '已删除聊天', createdAt, updatedAt: createdAt,
        mode: 'copilot', deletedAt: createdAt,
      }],
      messages: [],
      associations: [],
      operations: [
        { requestId: 'remove-request-1', kind: 'remove', chatId: 'chat-1', fingerprint, appliedAt: createdAt },
        { requestId: 'create-request-1', kind: 'create', chatId: 'chat-1', fingerprint, appliedAt: createdAt },
      ],
    }

    expect(chatDocumentSchema.safeParse(document).success).toBe(false)
  })

  it('rejects appliedAt that differs from the operation write-after result', () => {
    const document = withAppliedAt(validDocument())
    const operation = findOperation(document, 'association-request-1') as ReturnType<typeof findOperation> & { appliedAt: string }
    operation.appliedAt = createdAt
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it.each([
    ['chat', (document: ChatDocument) => document.chats.push({ ...document.chats[0] })],
    ['message', (document: ChatDocument) => document.messages.push({ ...document.messages[0], requestId: 'message-request-2' })],
    ['association', (document: ChatDocument) => document.associations.push({ ...document.associations[0], requestId: 'association-request-2' })],
    ['operation request', (document: ChatDocument) => document.operations.push({ ...document.operations[0] })],
  ])('rejects duplicate %s identifiers', (_label, duplicate) => {
    const document = validDocument()
    duplicate(document)
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it.each([
    ['message', (document: ChatDocument) => { document.messages[0].chatId = 'missing-chat' }],
    ['association', (document: ChatDocument) => { document.associations[0].chatId = 'missing-chat' }],
    ['operation', (document: ChatDocument) => { document.operations[0].chatId = 'missing-chat' }],
  ])('rejects a %s that references a missing chat', (_label, makeDangling) => {
    const document = validDocument()
    makeDangling(document)
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it('rejects a chat updated before it was created', () => {
    const document = validDocument()
    document.chats[0].updatedAt = '2026-08-16T07:59:59.999Z'
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it.each([
    ['closedAt', (association: ChatDocument['associations'][number]) => { association.closedAt = updatedAt }],
    ['closeRequestId', (association: ChatDocument['associations'][number]) => { association.closeRequestId = 'close-request-1' }],
  ])('rejects an open association carrying %s', (_label, contradict) => {
    const document = validDocument()
    contradict(document.associations[0])
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it('requires both close fields on a closed association', () => {
    const document = validDocument()
    document.associations[0].status = 'closed'
    document.associations[0].closedAt = updatedAt
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it('rejects an association closed before it was associated', () => {
    const document = validDocument()
    document.associations[0] = {
      ...document.associations[0],
      status: 'closed',
      closedAt: '2026-08-16T07:59:59.999Z',
      closeRequestId: 'close-request-1',
    }
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it.each([
    ['message before chat creation', (document: ChatDocument) => { document.messages[0].createdAt = '2026-08-16T07:59:59.999Z' }],
    ['message after chat update', (document: ChatDocument) => { document.messages[0].createdAt = '2026-08-16T08:01:00.001Z' }],
    ['association before chat creation', (document: ChatDocument) => { document.associations[0].associatedAt = '2026-08-16T07:59:59.999Z' }],
    ['association after chat update', (document: ChatDocument) => { document.associations[0].associatedAt = '2026-08-16T08:01:00.001Z' }],
    ['association close after chat update', (document: ChatDocument) => {
      closeAssociation(document)
      document.associations[0].closedAt = '2026-08-16T08:01:00.001Z'
    }],
  ])('rejects %s', (_label, violateTimeRange) => {
    const document = validDocument()
    violateTimeRange(document)
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it.each([
    ['create', (document: ChatDocument) => { findOperation(document, 'create-request-1').resultId = 'message-1' }],
    ['updateTitle', (document: ChatDocument) => {
      document.operations.push({
        requestId: 'title-request-1', kind: 'updateTitle', chatId: 'chat-1', fingerprint, appliedAt: updatedAt, resultId: 'message-1',
        result: { createdAt, updatedAt, mode: 'copilot' },
      })
    }],
    ['setMode', (document: ChatDocument) => {
      document.operations.push({
        requestId: 'mode-request-1', kind: 'setMode', chatId: 'chat-1', fingerprint, appliedAt: updatedAt, resultId: 'association-1',
        result: { createdAt, updatedAt, mode: 'copilot' },
      })
    }],
    ['remove', (document: ChatDocument) => {
      document.operations.push({ requestId: 'remove-request-1', kind: 'remove', chatId: 'chat-1', fingerprint, appliedAt: updatedAt, resultId: 'message-1' })
    }],
  ])('rejects %s carrying resultId', (_label, addInvalidResultId) => {
    const document = validDocument()
    addInvalidResultId(document)
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it.each([
    ['missing create result', (document: ChatDocument) => { delete findOperation(document, 'create-request-1').result }],
    ['result createdAt different from chat', (document: ChatDocument) => {
      findOperation(document, 'create-request-1').result!.createdAt = '2026-08-16T07:59:59.999Z'
    }],
    ['result updatedAt outside chat range', (document: ChatDocument) => {
      findOperation(document, 'message-request-1').result!.updatedAt = '2026-08-16T08:01:00.001Z'
    }],
    ['non-setMode result changing mode', (document: ChatDocument) => {
      findOperation(document, 'association-request-1').result!.mode = 'autonomous'
    }],
    ['final result differing from chat mode', (document: ChatDocument) => {
      document.chats[0].mode = 'autonomous'
    }],
    ['active remove carrying result', (document: ChatDocument) => {
      document.operations.push({
        requestId: 'remove-request-1', kind: 'remove', chatId: 'chat-1', fingerprint, appliedAt: updatedAt,
        result: { createdAt, updatedAt, mode: 'copilot' },
      })
    }],
  ])('rejects %s', (_label, corruptResultState) => {
    const document = validDocument()
    corruptResultState(document)
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it.each([
    ['missing operation', (document: ChatDocument) => {
      document.operations = document.operations.filter(operation => operation.requestId !== 'message-request-1')
    }],
    ['wrong operation kind', (document: ChatDocument) => {
      findOperation(document, 'message-request-1').kind = 'updateTitle'
    }],
    ['wrong operation chat', (document: ChatDocument) => {
      document.chats.push({ ...document.chats[0], id: 'chat-2' })
      findOperation(document, 'message-request-1').chatId = 'chat-2'
    }],
    ['wrong operation result', (document: ChatDocument) => {
      findOperation(document, 'message-request-1').resultId = 'missing-message'
    }],
  ])('rejects a message with %s', (_label, corrupt) => {
    const document = validDocument()
    corrupt(document)
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it.each([
    ['missing operation', (document: ChatDocument) => {
      document.operations = document.operations.filter(operation => operation.requestId !== 'association-request-1')
    }],
    ['wrong operation kind', (document: ChatDocument) => {
      findOperation(document, 'association-request-1').kind = 'updateTitle'
    }],
    ['wrong operation chat', (document: ChatDocument) => {
      document.chats.push({ ...document.chats[0], id: 'chat-2' })
      findOperation(document, 'association-request-1').chatId = 'chat-2'
    }],
    ['wrong operation result', (document: ChatDocument) => {
      findOperation(document, 'association-request-1').resultId = 'missing-association'
    }],
  ])('rejects an association with %s', (_label, corrupt) => {
    const document = validDocument()
    corrupt(document)
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it.each([
    ['missing operation', (document: ChatDocument) => {
      document.operations = document.operations.filter(operation => operation.requestId !== 'close-request-1')
    }],
    ['wrong operation kind', (document: ChatDocument) => {
      findOperation(document, 'close-request-1').kind = 'updateTitle'
    }],
    ['wrong operation chat', (document: ChatDocument) => {
      document.chats.push({ ...document.chats[0], id: 'chat-2' })
      findOperation(document, 'close-request-1').chatId = 'chat-2'
    }],
    ['wrong operation result', (document: ChatDocument) => {
      findOperation(document, 'close-request-1').resultId = 'message-1'
    }],
  ])('rejects a closed association with %s for closeRequestId', (_label, corrupt) => {
    const document = validDocument()
    closeAssociation(document)
    corrupt(document)
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it.each([
    ['appendMessage without resultId', (document: ChatDocument) => {
      delete findOperation(document, 'message-request-1').resultId
    }],
    ['appendMessage pointing at an association', (document: ChatDocument) => {
      findOperation(document, 'message-request-1').resultId = 'association-1'
    }],
    ['associateShell without resultId', (document: ChatDocument) => {
      delete findOperation(document, 'association-request-1').resultId
    }],
    ['associateShell pointing at a message', (document: ChatDocument) => {
      findOperation(document, 'association-request-1').resultId = 'message-1'
    }],
    ['closeAssociation without resultId', (document: ChatDocument) => {
      closeAssociation(document)
      delete findOperation(document, 'close-request-1').resultId
    }],
    ['closeAssociation pointing at a message', (document: ChatDocument) => {
      closeAssociation(document)
      findOperation(document, 'close-request-1').resultId = 'message-1'
    }],
    ['closeAssociation pointing at a missing association', (document: ChatDocument) => {
      closeAssociation(document)
      findOperation(document, 'close-request-1').resultId = 'missing-association'
    }],
  ])('rejects %s', (_label, corrupt) => {
    const document = validDocument()
    corrupt(document)
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it.each([
    ['messages', (document: ChatDocument) => { document.associations = [] }],
    ['associations', (document: ChatDocument) => { document.messages = [] }],
  ])('rejects a deleted chat that still has %s', (_label, retain) => {
    const document = validDocument()
    document.chats[0] = {
      ...document.chats[0],
      title: '\u5df2\u5220\u9664\u804a\u5929',
      deletedAt: updatedAt,
    }
    retain(document)
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it.each([
    ['resultId', (document: ChatDocument) => {
      document.operations.push({ requestId: 'old-request-1', kind: 'create', chatId: 'chat-1', fingerprint, appliedAt: updatedAt, resultId: 'old-result-1' })
    }],
    ['result snapshot', (document: ChatDocument) => {
      document.operations.push({
        requestId: 'old-request-1',
        kind: 'create',
        chatId: 'chat-1',
        fingerprint,
        appliedAt: updatedAt,
        result: { createdAt, updatedAt, mode: 'copilot' },
      })
    }],
  ])('rejects a deleted chat operation carrying %s', (_label, addUnsafeOperation) => {
    const document = validDocument()
    document.chats[0] = {
      ...document.chats[0],
      title: '\u5df2\u5220\u9664\u804a\u5929',
      deletedAt: updatedAt,
    }
    document.messages = []
    document.associations = []
    document.operations = [{ requestId: 'remove-request-1', kind: 'remove', chatId: 'chat-1', fingerprint, appliedAt: updatedAt }]
    addUnsafeOperation(document)
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it('rejects an active chat carrying a remove operation', () => {
    const document = validDocument()
    document.operations.push({ requestId: 'remove-request-1', kind: 'remove', chatId: 'chat-1', fingerprint, appliedAt: updatedAt })
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it('rejects a tombstone without a remove operation', () => {
    const document = validDocument()
    document.chats[0] = { ...document.chats[0], title: '已删除聊天', deletedAt: updatedAt }
    document.messages = []
    document.associations = []
    document.operations = [{ requestId: 'create-request-1', kind: 'create', chatId: 'chat-1', fingerprint, appliedAt: createdAt }]
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it.each([
    ['before updatedAt', '2026-08-16T08:00:30.000Z'],
    ['after updatedAt', '2026-08-16T08:01:30.000Z'],
  ])('rejects tombstone deletedAt %s', (_label, deletedAt) => {
    const document = validDocument()
    document.chats[0] = { ...document.chats[0], title: '已删除聊天', deletedAt }
    document.messages = []
    document.associations = []
    document.operations = [{ requestId: 'remove-request-1', kind: 'remove', chatId: 'chat-1', fingerprint, appliedAt: deletedAt }]
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })

  it('accepts multiple monotonic remove operations when the last appliedAt equals the tombstone time', () => {
    const document = validDocument()
    document.chats[0] = {
      ...document.chats[0], title: '已删除聊天', updatedAt: '2026-08-16T08:03:00.000Z', deletedAt: '2026-08-16T08:03:00.000Z',
    }
    document.liveChatId = null
    document.messages = []
    document.associations = []
    document.operations = [
      { requestId: 'create-request-1', kind: 'create', chatId: 'chat-1', fingerprint, appliedAt: createdAt },
      { requestId: 'remove-request-1', kind: 'remove', chatId: 'chat-1', fingerprint, appliedAt: updatedAt },
      { requestId: 'remove-request-2', kind: 'remove', chatId: 'chat-1', fingerprint, appliedAt: '2026-08-16T08:03:00.000Z' },
    ]
    const appliedTimes = [createdAt, updatedAt, '2026-08-16T08:03:00.000Z']
    document.operations.forEach((operation, index) => {
      operation.appliedAt = appliedTimes[index]
    })
    expect(chatDocumentSchema.parse(document)).toEqual(document)
  })

  it('rejects a tombstone whose final remove appliedAt differs from deletedAt', () => {
    const document = validDocument()
    document.chats[0] = { ...document.chats[0], title: '已删除聊天', deletedAt: updatedAt }
    document.messages = []
    document.associations = []
    document.operations = [
      { requestId: 'create-request-1', kind: 'create', chatId: 'chat-1', fingerprint, appliedAt: createdAt },
      { requestId: 'remove-request-1', kind: 'remove', chatId: 'chat-1', fingerprint, appliedAt: '2026-08-16T08:00:30.000Z' },
    ]
    const appliedTimes = [createdAt, '2026-08-16T08:00:30.000Z']
    document.operations.forEach((operation, index) => {
      operation.appliedAt = appliedTimes[index]
    })
    expect(() => chatDocumentSchema.parse(document)).toThrow()
  })
})
