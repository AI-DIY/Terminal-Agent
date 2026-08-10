import { contextBridge, ipcRenderer } from 'electron'
import { createTerminalAgentApi, terminalAgentNamespace } from './api'

contextBridge.exposeInMainWorld(terminalAgentNamespace, createTerminalAgentApi(ipcRenderer))
