import { z } from 'zod'

const ssoUrlTextSchema = z.string().trim().max(2_048)
const ssoFieldPathTextSchema = z.string().trim().max(512)
const ssoDisplayTextSchema = z.string().trim().min(1).max(512)

export const ssoUrlMatcherSchema = z.object({
  mode: z.enum(['exact', 'regex']),
  value: ssoUrlTextSchema,
}).strict()
export type SsoUrlMatcher = z.infer<typeof ssoUrlMatcherSchema>

export const ssoConfigurationSchema = z.object({
  enabled: z.boolean(),
  loginPageUrl: ssoUrlTextSchema,
  platformUrlMatcher: ssoUrlMatcherSchema,
  userInfoUrlMatcher: ssoUrlMatcherSchema,
  employeeIdField: ssoFieldPathTextSchema,
  nameField: ssoFieldPathTextSchema,
}).strict()
export type SsoConfiguration = z.infer<typeof ssoConfigurationSchema>

export const ssoSaveIntentSchema = z.enum(['draft', 'continue', 'workbench'])
export type SsoSaveIntent = z.infer<typeof ssoSaveIntentSchema>

export const ssoDocumentSchema = z.object({
  version: z.literal(1),
  sso: ssoConfigurationSchema,
  // Model profiles are co-located in the user-config file.  SSO consumers
  // intentionally treat this section as opaque; the main-process model
  // repository validates and updates it with its own schema.
  models: z.unknown().optional(),
}).strict()
export type SsoDocument = z.infer<typeof ssoDocumentSchema>

export const ssoIdentitySchema = z.object({
  employeeId: ssoDisplayTextSchema,
  name: ssoDisplayTextSchema,
}).strict()
export type SsoIdentity = z.infer<typeof ssoIdentitySchema>

export const ssoAuthStateSchema = z.enum([
  'configuration-required',
  'login-required',
  'authenticating',
  'authenticated',
  'login-disabled',
  'error',
])
export type SsoAuthState = z.infer<typeof ssoAuthStateSchema>

export const ssoAuthSnapshotSchema = z.object({
  state: ssoAuthStateSchema,
  identity: ssoIdentitySchema.optional(),
  errorMessage: z.string().trim().min(1).max(512).optional(),
}).strict()
export type SsoAuthSnapshot = z.infer<typeof ssoAuthSnapshotSchema>

export function createDefaultSsoConfiguration(): SsoConfiguration {
  return {
    enabled: true,
    loginPageUrl: '',
    platformUrlMatcher: { mode: 'exact', value: '' },
    userInfoUrlMatcher: { mode: 'exact', value: '' },
    employeeIdField: '',
    nameField: '',
  }
}
