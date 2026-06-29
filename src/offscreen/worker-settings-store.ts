import type { AppSettings, SettingsPort } from '../core/ports'
import type { SqliteWorkerClient } from './sqlite-worker-client'

export class WorkerSettingsStore implements SettingsPort {
  constructor(private readonly c: SqliteWorkerClient) {}
  get = () => this.c.request<AppSettings>('getSettings')
  setPaused = (paused: boolean) => this.c.request<void>('setPaused', paused)
  addDenyHost = (host: string) => this.c.request<void>('addDenyHost', host)
}
