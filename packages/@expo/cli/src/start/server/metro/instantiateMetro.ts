import { ExpoConfig, getConfig } from '@expo/config';
import { getDefaultConfig, LoadOptions } from '@expo/metro-config';
import chalk from 'chalk';
import { Server as ConnectServer } from 'connect';
import http from 'http';
import type Metro from 'metro';
import { loadConfig, resolveConfig, ConfigT } from 'metro-config';
import { Terminal } from 'metro-core';
import semver from 'semver';
import { URL } from 'url';

import { MetroBundlerDevServer } from './MetroBundlerDevServer';
import { MetroTerminalReporter } from './MetroTerminalReporter';
import { createDebugMiddleware } from './debugging/createDebugMiddleware';
import { runServer } from './runServer-fork';
import { withMetroMultiPlatformAsync } from './withMetroMultiPlatform';
import { MetroDevServerOptions } from '../../../export/fork-bundleAsync';
import { Log } from '../../../log';
import { getMetroProperties } from '../../../utils/analytics/getMetroProperties';
import { createDebuggerTelemetryMiddleware } from '../../../utils/analytics/metroDebuggerMiddleware';
import { logEventAsync } from '../../../utils/analytics/rudderstackClient';
import { env } from '../../../utils/env';
import { getMetroServerRoot } from '../middleware/ManifestMiddleware';
import { createJsInspectorMiddleware } from '../middleware/inspector/createJsInspectorMiddleware';
import { prependMiddleware, replaceMiddlewareWith } from '../middleware/mutations';
import { remoteDevtoolsCorsMiddleware } from '../middleware/remoteDevtoolsCorsMiddleware';
import { remoteDevtoolsSecurityHeadersMiddleware } from '../middleware/remoteDevtoolsSecurityHeadersMiddleware';
import { ServerNext, ServerRequest, ServerResponse } from '../middleware/server.types';
import { suppressRemoteDebuggingErrorMiddleware } from '../middleware/suppressErrorMiddleware';
import { getPlatformBundlers } from '../platformBundlers';

// From expo/dev-server but with ability to use custom logger.
type MessageSocket = {
  broadcast: (method: string, params?: Record<string, any> | undefined) => void;
};

function gteSdkVersion(exp: Pick<ExpoConfig, 'sdkVersion'>, sdkVersion: string): boolean {
  if (!exp.sdkVersion) {
    return false;
  }

  if (exp.sdkVersion === 'UNVERSIONED') {
    return true;
  }

  try {
    return semver.gte(exp.sdkVersion, sdkVersion);
  } catch {
    throw new Error(`${exp.sdkVersion} is not a valid version. Must be in the form of x.y.z`);
  }
}

export async function loadMetroConfigAsync(
  projectRoot: string,
  options: LoadOptions,
  {
    exp = getConfig(projectRoot, { skipSDKVersionRequirement: true }).exp,
    isExporting,
  }: { exp?: ExpoConfig; isExporting: boolean }
) {
  let reportEvent: ((event: any) => void) | undefined;
  const serverRoot = getMetroServerRoot(projectRoot);

  const terminal = new Terminal(process.stdout);
  const terminalReporter = new MetroTerminalReporter(serverRoot, terminal);

  const hasConfig = await resolveConfig(options.config, projectRoot);
  let config: ConfigT = {
    ...(await loadConfig(
      { cwd: projectRoot, projectRoot, ...options },
      // If the project does not have a metro.config.js, then we use the default config.
      hasConfig.isEmpty ? getDefaultConfig(projectRoot) : undefined
    )),
    reporter: {
      update(event: any) {
        terminalReporter.update(event);
        if (reportEvent) {
          reportEvent(event);
        }
      },
    },
  };

  if (
    // Requires SDK 50 for expo-assets hashAssetPlugin change.
    !exp.sdkVersion ||
    gteSdkVersion(exp, '50.0.0')
  ) {
    if (isExporting) {
      // This token will be used in the asset plugin to ensure the path is correct for writing locally.
      // @ts-expect-error: typed as readonly.
      config.transformer.publicPath = `/assets?export_path=${
        (exp.experiments?.baseUrl ?? '') + '/assets'
      }`;
    } else {
      // @ts-expect-error: typed as readonly
      config.transformer.publicPath = '/assets/?unstable_path=.';
    }
  } else {
    if (isExporting && exp.experiments?.baseUrl) {
      // This token will be used in the asset plugin to ensure the path is correct for writing locally.
      // @ts-expect-error: typed as readonly.
      config.transformer.publicPath = exp.experiments?.baseUrl;
    }
  }

  const platformBundlers = getPlatformBundlers(exp);

  config = await withMetroMultiPlatformAsync(projectRoot, {
    config,
    platformBundlers,
    isTsconfigPathsEnabled: exp.experiments?.tsconfigPaths ?? true,
    webOutput: exp.web?.output ?? 'single',
    isFastResolverEnabled: env.EXPO_USE_FAST_RESOLVER,
    isExporting,
  });

  if (process.env.NODE_ENV !== 'test') {
    logEventAsync('metro config', getMetroProperties(projectRoot, exp, config));
  }

  return {
    config,
    setEventReporter: (logger: (event: any) => void) => (reportEvent = logger),
    reporter: terminalReporter,
  };
}

/** The most generic possible setup for Metro bundler. */
export async function instantiateMetroAsync(
  metroBundler: MetroBundlerDevServer,
  options: Omit<MetroDevServerOptions, 'logger'>,
  { isExporting }: { isExporting: boolean }
): Promise<{
  metro: Metro.Server;
  server: http.Server;
  middleware: any;
  messageSocket: MessageSocket;
}> {
  const projectRoot = metroBundler.projectRoot;

  // TODO: When we bring expo/metro-config into the expo/expo repo, then we can upstream this.
  const { exp } = getConfig(projectRoot, {
    skipSDKVersionRequirement: true,
  });

  const { config: metroConfig, setEventReporter } = await loadMetroConfigAsync(
    projectRoot,
    options,
    { exp, isExporting }
  );

  const { createDevServerMiddleware, securityHeadersMiddleware } =
    require('@react-native-community/cli-server-api') as typeof import('@react-native-community/cli-server-api');

  const { middleware, messageSocketEndpoint, eventsSocketEndpoint, websocketEndpoints } =
    createDevServerMiddleware({
      port: metroConfig.server.port,
      watchFolders: metroConfig.watchFolders,
    });

  // securityHeadersMiddleware does not support cross-origin requests for remote devtools to get the sourcemap.
  // We replace with the enhanced version.
  replaceMiddlewareWith(
    middleware as ConnectServer,
    securityHeadersMiddleware,
    remoteDevtoolsSecurityHeadersMiddleware
  );

  middleware.use(remoteDevtoolsCorsMiddleware);

  prependMiddleware(middleware, suppressRemoteDebuggingErrorMiddleware);

  // TODO: We can probably drop this now.
  const customEnhanceMiddleware = metroConfig.server.enhanceMiddleware;
  // @ts-expect-error: can't mutate readonly config
  metroConfig.server.enhanceMiddleware = (metroMiddleware: any, server: Metro.Server) => {
    if (customEnhanceMiddleware) {
      metroMiddleware = customEnhanceMiddleware(metroMiddleware, server);
    }
    return middleware.use(metroMiddleware);
  };

  const original = metroConfig.serializer.customSerializer;

  const bundles: any[] = [];
  metroConfig.serializer.customSerializer = (
    entryPoint: string,
    preModules: any, //ReadonlyArray<Module>,
    graph: any, // ReadOnlyGraph,
    options: any // SerializerOptions,
  ) => {
    // console.log('push bundle', entryPoint);
    bundles.push(toJson(projectRoot, entryPoint, preModules, graph, options));
    return original(entryPoint, preModules, graph, options);
  };

  function allowCrossOrigin(req: ServerRequest, res: ServerResponse) {
    const origin = (() => {
      if (req.headers['origin']) {
        return req.headers['origin'];
      }

      if (req.headers['referer']) {
        return req.headers['referer'];
      }

      try {
        return new URL(req.url!).origin;
      } catch {
        return null;
      }
    })();

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }

  middleware.use(
    // Current Metro stats for devtools endpoint
    '/_expo/last-metro-stats',
    async (req, res, next) => {
      if (!bundles.length) {
        // Not found
        res.statusCode = 404;

        res.end();
        return;
      }

      try {
        allowCrossOrigin(req, res);

        const jsonResults = JSON.stringify(
          {
            version: 1,
            graphs: bundles.slice(0, 1).map((bundle) => bundle),
          },
          null,
          2
        );
        // console.log(jsonResults);
        res.setHeader('Content-Type', 'application/json');
        res.end(jsonResults);
        return;
      } catch (error) {
        console.log('ERROR:', error);
        res.statusCode = 500;
        res.end();
        return;
      }
    }
  );

  middleware.use(createDebuggerTelemetryMiddleware(projectRoot, exp));

  // Initialize all React Native debug features
  const { debugMiddleware, debugWebsocketEndpoints } = createDebugMiddleware(metroBundler);
  prependMiddleware(middleware, debugMiddleware);
  middleware.use('/_expo/debugger', createJsInspectorMiddleware());

  const { server, metro } = await runServer(metroBundler, metroConfig, {
    // @ts-expect-error: Inconsistent `websocketEndpoints` type between metro and @react-native-community/cli-server-api
    websocketEndpoints: {
      ...websocketEndpoints,
      ...debugWebsocketEndpoints,
    },
    watch: !isExporting && isWatchEnabled(),
  });

  prependMiddleware(middleware, (req: ServerRequest, res: ServerResponse, next: ServerNext) => {
    // If the URL is a Metro asset request, then we need to skip all other middleware to prevent
    // the community CLI's serve-static from hosting `/assets/index.html` in place of all assets if it exists.
    // /assets/?unstable_path=.
    if (req.url) {
      const url = new URL(req.url!, 'http://localhost:8000');
      if (url.pathname.match(/^\/assets\/?/) && url.searchParams.get('unstable_path') != null) {
        return metro.processRequest(req, res, next);
      }
    }
    return next();
  });

  setEventReporter(eventsSocketEndpoint.reportEvent);

  return {
    metro,
    server,
    middleware,
    messageSocket: messageSocketEndpoint,
  };
}

/**
 * Simplify and communicate if Metro is running without watching file updates,.
 * Exposed for testing.
 */
export function isWatchEnabled() {
  if (env.CI) {
    Log.log(
      chalk`Metro is running in CI mode, reloads are disabled. Remove {bold CI=true} to enable watch mode.`
    );
  }

  return !env.CI;
}

const sourceMapString = require('metro/src/DeltaBundler/Serializers/sourceMapString');
import path from 'path';
import { Module, ReadOnlyGraph, SerializerOptions } from 'metro';

// function storeFixture(name: string, obj: any) {
//   const filePath = path.join(
//     __dirname.replace('metro-config/build/', 'metro-config/src/'),
//     `${name}.json`
//   );
//   fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
// }

function toJson(
  projectRoot: string,
  entryFile: string,
  preModules: Module[],
  graph: ReadOnlyGraph,
  options: SerializerOptions
) {
  const dropSource = false;

  function modifyDep(mod: Module) {
    // if (!mod.path.match(/src\/app\/_layout/)) {
    //   return null;
    // }
    return {
      dependencies: [...mod.dependencies.entries()].map(([key, value]) => {
        return path.relative(projectRoot, value.absolutePath);
      }),
      // dependencies: Object.fromEntries(
      //   [...mod.dependencies.entries()].map(([key, value]) => {
      //     return [key, value];
      //   })
      // ),
      getSource: mod.getSource().toString(),
      size: mod.output.reduce((acc, { data }) => acc + data.code.length, 0),
      inverseDependencies: Array.from(mod.inverseDependencies)
        .filter((fp) => {
          return graph.dependencies.get(fp) != null;
        })
        .map((fp) => path.relative(projectRoot, fp)),
      path: path.relative(projectRoot, mod.path),
      output: mod.output.map((output) => ({
        type: output.type,
        data: {
          ...output.data,
          ...(dropSource
            ? { map: [], code: '...', functionMap: {} }
            : {
                map: sourceMapString([mod], {
                  processModuleFilter: () => true,
                  excludeSource: false,
                  shouldAddToIgnoreList: options.shouldAddToIgnoreList,
                }),
              }),
        },
      })),

      absolutePath: mod.path,
      isNodeModule: mod.path.match(/node_modules/) != null,
      isEntry:
        entryFile === mod.path || options.runBeforeMainModule.includes(mod.path) || undefined,
    };
  }

  function simplifyGraph({ ...graph }) {
    console.log('transformOptions', graph.transformOptions);
    return {
      ...graph,

      dependencies: [...graph.dependencies.entries()].map(([key, value]) => {
        return modifyDep(value);
      }),
      entryPoints: [...graph.entryPoints.entries()],
    };
  }

  return [
    entryFile,
    preModules.map((mod) => modifyDep(mod, options)),
    simplifyGraph(graph),
    {
      ...options,
      processModuleFilter: undefined,
      createModuleId: undefined,
      getRunModuleStatement: undefined,
      shouldAddToIgnoreList: undefined,
    },
  ];
}
