// electron-vite's asset import for main-process code (used for the app icon): `import icon
// from '../../resources/icon.png?asset'` resolves to the built file's absolute path
// at runtime. electron-vite ships this declaration (plus others) in
// `electron-vite/node`, but that module also marks `NodeJS.ProcessEnv.
// ELECTRON_RENDERER_URL` readonly, which conflicts with `window.test.ts` assigning
// to it for dev-origin tests — so only the one declaration actually used here is
// hand-rolled instead of pulling in the whole module.
declare module '*?asset' {
  const src: string
  export default src
}
