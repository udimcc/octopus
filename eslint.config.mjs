import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import boundaries from 'eslint-plugin-boundaries'
import eslintConfigPrettier from 'eslint-config-prettier'

// Enforces the DESIGN §2 dependency rule (UI → Application → Domain; adapters
// depend inward on ports; only the composition root in `main` knows concrete
// adapters). Each element type maps 1:1 to a source folder; the default policy
// is disallow, with an explicit allow-list per type.
//
// Uses eslint-plugin-boundaries v7 API: the `dependencies` rule with `policies`
// and object selectors.
const layerPolicy = (from, allow) => ({
  from: { element: { type: from } },
  allow: { to: { element: { types: { anyOf: allow } } } }
})

export default tseslint.config(
  {
    ignores: ['out/**', 'release/**', 'dist/**', 'coverage/**', 'node_modules/**', '**/*.d.ts']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'domain', pattern: 'src/domain/**' },
        { type: 'ports', pattern: 'src/ports/**' },
        { type: 'application', pattern: 'src/application/**' },
        { type: 'adapters', pattern: 'src/adapters/**' },
        { type: 'main', pattern: 'src/main/**' },
        { type: 'preload', pattern: 'src/preload/**' },
        { type: 'renderer', pattern: 'src/renderer/**' },
        { type: 'shared', pattern: 'src/shared/**' }
      ],
      'import/resolver': {
        typescript: {
          project: ['tsconfig.node.json', 'tsconfig.web.json'],
          noWarnOnMultipleProjects: true
        }
      }
    },
    rules: {
      'boundaries/no-unknown-dependencies': 'error',
      'boundaries/no-unknown-files': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            layerPolicy('domain', ['domain']),
            layerPolicy('ports', ['ports', 'domain']),
            layerPolicy('application', ['application', 'ports', 'domain']),
            layerPolicy('adapters', ['adapters', 'ports', 'domain', 'shared']),
            // Composition root: the only place that may reference any layer.
            layerPolicy('main', ['main', 'application', 'ports', 'domain', 'adapters', 'shared']),
            layerPolicy('preload', ['preload', 'shared']),
            layerPolicy('renderer', ['renderer', 'application', 'shared']),
            layerPolicy('shared', ['shared'])
          ]
        }
      ]
    }
  },
  eslintConfigPrettier
)
