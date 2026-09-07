type SsoConfigHomeEnvironment = {
  TERMINAL_AGENT_E2E?: string
  TERMINAL_AGENT_TEST_SSO_HOME?: string
}

/**
 * Keeps the production configuration location anchored to Electron's home
 * directory.  Electron E2E launches opt into an isolated home explicitly so
 * Windows tests never write the real user's `.terminal-agent/user-config`
 * file.
 */
export function resolveSsoConfigHomeDirectory(
  electronHomeDirectory: string,
  environment: SsoConfigHomeEnvironment = process.env,
  isPackaged = false,
): string {
  if (isPackaged || environment.TERMINAL_AGENT_E2E !== '1') return electronHomeDirectory
  const testHomeDirectory = environment.TERMINAL_AGENT_TEST_SSO_HOME?.trim()
  return testHomeDirectory || electronHomeDirectory
}
