// Provided by the appVersion() Vite plugin. Apps get these types via `@app-version/core/client`.
declare module 'virtual:app-version' {
  export const appVersion: import('@app-version/core').VersionInfo
  export const versionUrl: string
}
