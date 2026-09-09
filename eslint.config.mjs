import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Skills are user-extensible runtime content. Their optional scripts run
    // in the Skill's own environment and are intentionally not application
    // source files subject to this repository's TypeScript ESLint rules.
    ignores: ['node_modules/**', 'out/**', 'dist/**', 'coverage/**', 'playwright-report/**', 'test-results/**', '.skills/**']
  },
  js.configs.recommended,
  tseslint.configs.recommended
)
