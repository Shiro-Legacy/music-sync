// Metro config for the Expo app.
//
// The `@music-sync/shared` workspace package is TypeScript source that uses
// NodeNext-style relative imports with an explicit `.js` extension
// (e.g. `export * from './manifest.js'`). Those resolve fine under Node/tsx
// (the server) but Metro does not strip a trailing `.js` to find the `.ts`
// source. This resolveRequest maps relative `./x.js` -> `./x` so Metro's own
// sourceExts (`.ts`, `.tsx`, ...) resolution takes over.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    typeof moduleName === 'string' &&
    moduleName.startsWith('.') &&
    moduleName.endsWith('.js') &&
    !moduleName.endsWith('.d.js')
  ) {
    const stripped = moduleName.slice(0, -3);
    try {
      return context.resolveRequest(context, stripped, platform);
    } catch {
      // fall through to normal resolution below
    }
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
