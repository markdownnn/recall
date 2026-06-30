import type { AppSettings, SettingsPort } from '../core/ports'

// In-memory SettingsPort: the pure test/double for the denylist + pause settings, mirroring
// MemoryVectorStore. Production uses WorkerSettingsStore (SQLite `settings` + `user_denylist`
// tables); this keeps the SAME contract so the denylist list/add/remove behaviour can be
// exercised without a worker. Denied hosts are a SET (add is idempotent), matching the SQL
// table's PRIMARY KEY.
export class MemorySettingsStore implements SettingsPort {
  private paused = false
  private denyHosts = new Set<string>()
  private embedVersion: string | null = null

  async get(): Promise<AppSettings> {
    return { paused: this.paused, userDenyHosts: [...this.denyHosts] }
  }

  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused
  }

  async addDenyHost(host: string): Promise<void> {
    this.denyHosts.add(host)
  }

  async removeDenyHost(host: string): Promise<void> {
    this.denyHosts.delete(host)
  }

  async getEmbedVersion(): Promise<string | null> {
    return this.embedVersion
  }

  async setEmbedVersion(version: string): Promise<void> {
    this.embedVersion = version
  }
}
