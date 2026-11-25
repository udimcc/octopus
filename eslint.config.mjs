import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import boundaries from 'eslint-plugin-boundaries'
import eslintConfigPrettier from 'eslint-config-prettier'
import globals from 'globals'

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
    // Plain-JS Node tooling (build/install scripts, native + probe harnesses)
    // runs under Node, not the browser — give it Node globals so `no-undef`
    // doesn't flag process/require/module. These live outside src/ and are not
    // part of the layered dependency rule.
    files: ['scripts/**/*.{mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    // The .cjs probe uses CommonJS module semantics (require/module.exports) —
    // required to run under ELECTRON_RUN_AS_NODE, which has no ESM app context.
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs'
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      // `resources/` (the packaged app icon) sits outside src/ entirely, so it
      // matches none of the layer elements below; `main`'s electron-vite `?asset`
      // import of it is a build-asset reference, not a layering dependency, so it's
      // excluded from the boundaries analysis rather than modeled as a fake element.
      'boundaries/ignore': ['resources/**'],
      'boundaries/elements': [
        { type: 'domain', pattern: 'src/domain/**' },
        { type: 'ports', pattern: 'src/ports/**' },
        { type: 'application', pattern: 'src/application/**' },
        { type: 'adapters', pattern: 'src/adapters/**' },
        { type: 'main', pattern: 'src/main/**' },
        { type: 'preload', pattern: 'src/preload/**' },
        { type: 'renderer', pattern: 'src/renderer/**' },
        // The out-of-process `octopusd` daemon (§6.2): a separate process that owns
        // PTYs. It may import ONLY `shared` (wire types + pure node helpers) — never
        // application/domain/adapters — so the two processes share contracts, not code.
        { type: 'daemon', pattern: 'src/daemon/**' },
        // `octopus-cli` (control-socket client): its own process; imports only `shared`.
        { type: 'cli', pattern: 'src/cli/**' },
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
            // Daemon is its own process; it shares only the transport-agnostic `shared` layer.
            layerPolicy('daemon', ['daemon', 'shared']),
            layerPolicy('cli', ['cli', 'shared']),
            layerPolicy('shared', ['shared'])
          ]
        }
      ]
    }
  },
  {
    // OS layer (`.claude/rules/os-layer.md`): every Linux/macOS/Windows difference lives
    // in `src/shared/os/` as `OsProfile` data. Only the host readers below may look at
    // the platform; everything else receives a profile and switches on its capability
    // keys, never on an OS name.
    files: ['**/*.{ts,tsx,mjs,cjs,js}'],
    ignores: ['src/shared/os/**', 'src/shared/node/os/host.ts', 'scripts/lib/host.mjs'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'platform',
          message:
            'Read the OS via hostOs()/hostProfile() (src/shared/node/os/host.ts) or rendererOs(), then use OsProfile capabilities.'
        }
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: ['os', 'node:os'].map((name) => ({
            name,
            importNames: ['platform', 'type'],
            message: 'Use hostOs()/hostProfile() from src/shared/node/os/host.ts.'
          }))
        }
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'BinaryExpression > Literal[value=/^(darwin|linux|win32)$/]',
          message:
            'Do not compare against an OS name; add a capability to OsProfile (src/shared/os/) instead.'
        },
        {
          selector: 'SwitchCase > Literal[value=/^(darwin|linux|win32)$/]',
          message:
            'Do not switch on an OS name; add a capability to OsProfile (src/shared/os/) instead.'
        }
      ]
    }
  },
  eslintConfigPrettier
)
