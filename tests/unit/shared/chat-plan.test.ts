import { describe, expect, it } from 'vitest'
import {
  assistantPlanOutputSchema,
  chatExecutionPlanSchema,
  chatPlanCancelRequestSchema,
  chatPlanEditStepRequestSchema,
  chatPlanExecuteRequestSchema,
  chatPlanRemoveStepRequestSchema,
  parseAssistantPlanOutput,
} from '../../../src/shared/chat-plan'

const output = JSON.stringify({
  version: 1,
  reply: '准备执行。',
  plan: { title: '清理缓存', steps: [{ target: 'web-02', explanation: '仅供复核', command: 'rm -rf /srv/cache/*' }] },
})

describe('assistant plan output', () => {
  it('accepts the final AI JSON only when every plan step has a hostname and executable command', () => {
    expect(parseAssistantPlanOutput(output)).toMatchObject({ plan: { steps: [{ target: 'web-02' }] } })
    expect(() => parseAssistantPlanOutput('{"version":1,"reply":"x","plan":{"title":"x","steps":[]}}')).toThrow()
    expect(() => assistantPlanOutputSchema.parse({ version: 1, reply: 'x', plan: { title: 'x', steps: [{ target: 'web-02', explanation: 'x', command: '```sh\nid\n```' }] } })).toThrow()
    expect(() => assistantPlanOutputSchema.parse({ version: 1, reply: 'x', plan: { title: 'x', steps: [{ target: 'web-02', explanation: 'x', command: 'echo\0unsafe' }] } })).toThrow()
  })

  it('rejects Markdown fences and trailing text around the required JSON object', () => {
    expect(() => parseAssistantPlanOutput(`\`\`\`json\n${output}\n\`\`\``)).toThrow()
    expect(() => parseAssistantPlanOutput(`${output}\n额外说明`)).toThrow()
  })

  it('rejects Markdown fences anywhere in an executable command and hostnames with whitespace', () => {
    const baseStep = { target: 'web-02', explanation: '查看状态', command: 'echo ready' }
    expect(() => assistantPlanOutputSchema.parse({
      version: 1,
      reply: 'x',
      plan: { title: 'x', steps: [{ ...baseStep, command: 'echo ready\n```' }] },
    })).toThrow()
    expect(() => assistantPlanOutputSchema.parse({
      version: 1,
      reply: 'x',
      plan: { title: 'x', steps: [{ ...baseStep, target: 'web 02' }] },
    })).toThrow()
  })
})

describe('execution plans', () => {
  it('persists plan and step state with only bounded application-owned fields', () => {
    expect(chatExecutionPlanSchema.parse({
      id: 'EP-1', title: '检查服务', status: 'pending_review',
      steps: [{ id: 'step-1', target: 'web-02', explanation: '查看状态', originalCommand: 'systemctl status api', sendState: 'pending' }],
    })).toMatchObject({ id: 'EP-1', status: 'pending_review' })
    expect(() => chatExecutionPlanSchema.parse({
      id: 'EP-1', title: '检查服务', status: 'executed',
      steps: [{ id: 'step-1', target: 'web-02', explanation: '查看状态', originalCommand: 'id', sendState: 'sent', extra: true }],
    })).toThrow()
  })

  it('allows only restricted plan edit, remove, cancel and execute requests from the renderer', () => {
    const identity = { requestId: 'r1', chatId: 'c1', messageId: 'm1' }
    expect(chatPlanEditStepRequestSchema.parse({ ...identity, stepId: 's1', command: 'systemctl restart api' })).toBeDefined()
    expect(chatPlanRemoveStepRequestSchema.parse({ ...identity, stepId: 's1' })).toBeDefined()
    expect(chatPlanCancelRequestSchema.parse(identity)).toBeDefined()
    expect(chatPlanExecuteRequestSchema.parse(identity)).toBeDefined()
    expect(() => chatPlanExecuteRequestSchema.parse({ ...identity, sessionId: 'forged' })).toThrow()
    expect(() => chatPlanEditStepRequestSchema.parse({ ...identity, stepId: 's1', command: 'echo\0unsafe' })).toThrow()
  })
})
