// Ambient types for static image imports handled by Vite (bundled to URLs).
declare module '*.png' {
  const src: string
  export default src
}
