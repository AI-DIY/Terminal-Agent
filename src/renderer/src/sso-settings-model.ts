import { parseSsoFieldPath } from '../../main/sso/sso-field-path'
import { normalizeSsoUrl, validateSsoMatcher } from '../../main/sso/sso-url-matcher'
import type { SsoConfiguration } from '../../shared/sso-contracts'

export type SsoDraftErrors = Partial<Record<'loginPageUrl' | 'platformUrlMatcher' | 'userInfoUrlMatcher' | 'employeeIdField' | 'nameField', string>>

export function getSsoDraftErrors(config: SsoConfiguration): SsoDraftErrors {
  const errors: SsoDraftErrors = {}
  if (config.loginPageUrl.trim()) {
    try { normalizeSsoUrl(config.loginPageUrl) } catch (error) { errors.loginPageUrl = errorMessage(error, 'URL 格式无效') }
  }
  if (config.platformUrlMatcher.value.trim()) {
    try { validateSsoMatcher(config.platformUrlMatcher) } catch (error) { errors.platformUrlMatcher = errorMessage(error, '匹配规则无效') }
  }
  if (config.userInfoUrlMatcher.value.trim()) {
    try { validateSsoMatcher(config.userInfoUrlMatcher) } catch (error) { errors.userInfoUrlMatcher = errorMessage(error, '匹配规则无效') }
  }
  if (config.employeeIdField.trim()) {
    try { parseSsoFieldPath(config.employeeIdField) } catch (error) { errors.employeeIdField = errorMessage(error, 'Object Path 格式无效') }
  }
  if (config.nameField.trim()) {
    try { parseSsoFieldPath(config.nameField) } catch (error) { errors.nameField = errorMessage(error, 'Object Path 格式无效') }
  }
  return errors
}

export function isEnabledContinueReady(config: SsoConfiguration): boolean {
  return config.enabled && hasCompleteFields(config) && Object.keys(getSsoDraftErrors(config)).length === 0
}

export function isDisabledWorkbenchReady(config: SsoConfiguration): boolean {
  return !config.enabled && Object.keys(getSsoDraftErrors(config)).length === 0
}

function hasCompleteFields(config: SsoConfiguration): boolean {
  return Boolean(config.loginPageUrl.trim() && config.platformUrlMatcher.value.trim() && config.userInfoUrlMatcher.value.trim() && config.employeeIdField.trim() && config.nameField.trim())
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
