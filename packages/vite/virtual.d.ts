declare module 'virtual:app-version' {
  export const runningBuild: import('@app-version/core').BuildFacts
  export const versionUrl: string
}
