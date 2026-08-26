import { z } from 'zod'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_COUNT = 8
const MAX_DATA_URL_CHARACTERS = 8_000_000
const dataUrlPattern = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i

export const chatTextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string().max(100_000),
}).strict()
export type ChatTextPart = z.infer<typeof chatTextPartSchema>

export const chatImageUrlPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string().regex(dataUrlPattern),
  }).strict(),
}).strict().superRefine((part, context) => {
  if (decodedDataUrlByteLength(part.image_url.url) > MAX_IMAGE_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['image_url', 'url'], message: 'Image Data URL exceeds 5 MiB' })
  }
})
export type ChatImageUrlPart = z.infer<typeof chatImageUrlPartSchema>

export const chatContentPartSchema = z.union([chatTextPartSchema, chatImageUrlPartSchema])
export type ChatContentPart = z.infer<typeof chatContentPartSchema>

const chatContentPartsSchema = z.array(chatContentPartSchema).min(1).max(MAX_IMAGE_COUNT).superRefine((parts, context) => {
  const imageParts = parts.filter((part): part is ChatImageUrlPart => part.type === 'image_url')
  if (imageParts.length > MAX_IMAGE_COUNT) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Chat content may contain at most 8 images' })
  }
  const dataUrlLength = imageParts.reduce((total, part) => total + part.image_url.url.length, 0)
  if (dataUrlLength > MAX_DATA_URL_CHARACTERS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Chat image Data URLs exceed 8,000,000 characters' })
  }
})

export const chatMessageContentSchema = z.union([
  z.string().max(1_000_000),
  chatContentPartsSchema,
])
export type ChatMessageContent = z.infer<typeof chatMessageContentSchema>
type ChatMessageContentView = string | readonly ChatContentPart[]

export function chatContentHasImages(content: ChatMessageContentView): boolean {
  return Array.isArray(content) && content.some(part => part.type === 'image_url')
}

export function chatHistoryHasImages(messages: readonly { content: ChatMessageContentView }[]): boolean {
  return messages.some(message => chatContentHasImages(message.content))
}

export function chatContentText(content: ChatMessageContentView): string {
  return typeof content === 'string' ? content : content
    .filter((part): part is ChatTextPart => part.type === 'text')
    .map(part => part.text)
    .join('')
}

export function chatImageCount(content: ChatMessageContentView): number {
  return typeof content === 'string' ? 0 : content.filter(part => part.type === 'image_url').length
}

function decodedDataUrlByteLength(url: string): number {
  const base64 = url.slice(url.indexOf(',') + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor(base64.length * 3 / 4) - padding
}
