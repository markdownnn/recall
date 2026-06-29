import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Build the extension to dist-ext/ before any test runs.
// This must happen here (globalSetup) and not in the spec itself because
// the Playwright webServer (npm run dev) starts after globalSetup and writes
// CRXJS dev-mode stubs to dist/.  The production build goes to dist-ext/
// so the dev server cannot overwrite it.
export default function globalSetup() {
  execSync('npm run build', { cwd: root, stdio: 'inherit' })
}
