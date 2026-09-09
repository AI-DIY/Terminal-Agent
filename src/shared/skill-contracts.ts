import { z } from 'zod'

/**
 * A standard Skill name doubles as its directory name and as the stable ID
 * persisted in the user profile.  Keeping it deliberately path-safe means a
 * renderer payload can never turn a skill file request into a traversal.
 */
export const skillIdSchema = z.string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'Skill id must be a safe directory name')

export type SkillId = z.infer<typeof skillIdSchema>

export const skillDescriptionSchema = z.string().trim().min(1).max(4_000)

/** Public, lightweight projection used by the Skills page and model prompt. */
export const skillSummarySchema = z.object({
  id: skillIdSchema,
  name: skillIdSchema,
  description: skillDescriptionSchema,
  enabled: z.boolean(),
}).strict()
export type SkillSummary = z.infer<typeof skillSummarySchema>

/** Diagnostics are intentionally descriptive without exposing a full path. */
export const skillDiagnosticSchema = z.object({
  directory: z.string().trim().min(1).max(256),
  code: z.enum(['missing-skill-file', 'unreadable-skill-file', 'invalid-frontmatter', 'invalid-name', 'name-mismatch', 'duplicate-name', 'unreadable-directory', 'state-unavailable']),
  message: z.string().trim().min(1).max(2_000),
}).strict()
export type SkillDiagnostic = z.infer<typeof skillDiagnosticSchema>

export const skillCatalogSchema = z.object({
  skills: z.array(skillSummarySchema).max(512),
  diagnostics: z.array(skillDiagnosticSchema).max(1_024),
}).strict()
export type SkillCatalog = z.infer<typeof skillCatalogSchema>

export const skillSetEnabledRequestSchema = z.object({
  id: skillIdSchema,
  enabled: z.boolean(),
}).strict()
export type SkillSetEnabledRequest = z.infer<typeof skillSetEnabledRequestSchema>

export const skillLoadRequestSchema = z.object({ id: skillIdSchema }).strict()
export type SkillLoadRequest = z.infer<typeof skillLoadRequestSchema>

export const skillFileReadRequestSchema = z.object({
  id: skillIdSchema,
  /** Relative to the selected skill directory; never an OS path. */
  path: z.string().trim().min(1).max(512),
}).strict()
export type SkillFileReadRequest = z.infer<typeof skillFileReadRequestSchema>

export const skillDocumentSchema = z.object({
  id: skillIdSchema,
  name: skillIdSchema,
  description: skillDescriptionSchema,
  content: z.string().min(1).max(2_000_000),
}).strict()
export type SkillDocument = z.infer<typeof skillDocumentSchema>

export const skillFileSchema = z.object({
  id: skillIdSchema,
  path: z.string().trim().min(1).max(512),
  content: z.string().max(2_000_000),
}).strict()
export type SkillFile = z.infer<typeof skillFileSchema>

/**
 * Commands are model-authored only after the model has selected a skill.  The
 * transport supports an executable/argument form (preferred) and a shell
 * command form for standard Skill documentation that contains shell syntax.
 */
export const skillCommandRequestSchema = z.object({
  id: skillIdSchema,
  invocationId: z.string().uuid(),
  command: z.string().trim().min(1).max(32_000).optional(),
  executable: z.string().trim().min(1).max(512).optional(),
  args: z.array(z.string().max(8_192)).max(128).optional(),
  timeoutMs: z.number().int().min(100).max(10 * 60_000).optional(),
}).strict().refine(value => Boolean(value.command) !== Boolean(value.executable), {
  message: 'Specify exactly one of command or executable',
})
export type SkillCommandRequest = z.infer<typeof skillCommandRequestSchema>

export const skillCommandResultSchema = z.object({
  id: skillIdSchema,
  invocationId: z.string().uuid(),
  exitCode: z.number().int().nullable(),
  stdout: z.string().max(1_000_000),
  stderr: z.string().max(1_000_000),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
}).strict()
export type SkillCommandResult = z.infer<typeof skillCommandResultSchema>

export const skillRuntimeStageSchema = z.enum(['loading', 'reading', 'executing', 'organizing', 'completed', 'skipped', 'failed', 'cancelled'])
export type SkillRuntimeStage = z.infer<typeof skillRuntimeStageSchema>

/** A transient chat event; the renderer must not persist it as a transcript message. */
export const skillRuntimeEventSchema = z.object({
  kind: z.literal('chat:skill'),
  chatId: z.string().trim().min(1).max(128),
  runId: z.string().uuid(),
  invocationId: z.string().uuid(),
  skillId: skillIdSchema,
  stage: skillRuntimeStageSchema,
  detail: z.string().trim().min(1).max(512),
}).strict()
export type SkillRuntimeEvent = z.infer<typeof skillRuntimeEventSchema>

/**
 * The model's one-at-a-time internal tool protocol.  It is kept separate
 * from the user-visible reply/plan protocol so a final answer can retain the
 * existing JSON shape.
 */
export const skillActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('load_skill'), skillId: skillIdSchema }).strict(),
  z.object({ type: z.literal('read_skill_file'), skillId: skillIdSchema, path: z.string().trim().min(1).max(512) }).strict(),
  z.object({
    type: z.literal('run_skill_command'),
    skillId: skillIdSchema,
    invocationId: z.string().uuid(),
    command: z.string().trim().min(1).max(32_000).optional(),
    executable: z.string().trim().min(1).max(512).optional(),
    args: z.array(z.string().max(8_192)).max(128).optional(),
    timeoutMs: z.number().int().min(100).max(10 * 60_000).optional(),
  }).strict().refine(value => Boolean(value.command) !== Boolean(value.executable), {
    message: 'Specify exactly one of command or executable',
  }),
])
export type SkillAction = z.infer<typeof skillActionSchema>

/** Optional action envelope accepted from a model turn. */
export const skillActionEnvelopeSchema = z.object({
  action: skillActionSchema,
}).strict()
export type SkillActionEnvelope = z.infer<typeof skillActionEnvelopeSchema>

export const selectedSkillIdsSchema = z.array(skillIdSchema).max(32).superRefine((ids, context) => {
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'selectedSkillIds must be unique' })
  }
})
export type SelectedSkillIds = z.infer<typeof selectedSkillIdsSchema>
