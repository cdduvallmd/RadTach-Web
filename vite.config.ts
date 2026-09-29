import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// Build ID: <short git hash>-<UTC build time YYYYMMDDHHmmss>. The build time
// makes every build unique, so any redeploy is detected by the version check
// on Start Session (see src/utils/versionCheck.ts). Vercel builds may not have
// .git, so prefer its commit env var.
function computeBuildId(): string {
  let sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7)
  if (!sha) {
    try {
      sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    } catch {
      sha = 'nogit'
    }
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `${sha}-${stamp}`
}

const BUILD_ID = computeBuildId()

// Emit dist/version.json so both hosts (Firebase + Vercel mirror) publish the
// deployed build ID with no extra deploy step. Build only; dev has none.
function versionJson(): Plugin {
  return {
    name: 'radtach-version-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ buildId: BUILD_ID, builtAt: new Date().toISOString() }),
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), versionJson()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
})
