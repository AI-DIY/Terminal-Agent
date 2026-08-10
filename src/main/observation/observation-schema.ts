export type HostProcess = {
  name: string
  status: string
}

export type HostFacts = {
  hostname: string
  observedAt: string
  software: Record<string, string>
  processes: HostProcess[]
  installLocations: Record<string, string>
  services: Record<string, string>
  logLocations: string[]
  configurationHashes: Record<string, string>
}

export type ObservationPlatform = 'linux'
