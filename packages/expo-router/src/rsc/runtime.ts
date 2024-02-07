/**
 * Copyright © 2024 650 Industries.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Runtime code for patching Webpack's require function to use Metro.
const rscClientModuleCache = new Map();


/**
 * Must satisfy the requirements of the Metro bundler.
 * https://github.com/react-native-community/discussions-and-proposals/blob/main/proposals/0605-lazy-bundling.md#__loadbundleasync-in-metro
 */
type AsyncRequire = (path: string) => Promise<void>;

/** Create an `loadBundleAsync` function in the expected shape for Metro bundler. */
function buildProdAsyncRequire(): AsyncRequire | null {
  const cache = new Map<string, Promise<void>>();

  const boundaries = require('expo-router/virtual-client-boundaries') as {
    [key: string]: () => Promise<any>;
  };

  if (!boundaries) return null;

  return async function universal_loadBundleAsync(path: string): Promise<void> {
    if (cache.has(path)) {
      return cache.get(path)!;
    }

    debugger
    const promise = boundaries[path]().catch((error) => {
      cache.delete(path);
      debugger
      throw error;
    });

    cache.set(path, promise);

    return promise;
  };
}

const prodFetcher = buildProdAsyncRequire();


globalThis.__webpack_chunk_load__ = (id) => {
  // ID is a URL with the opaque Metro require ID as the hash.
  // http://localhost:8081/node_modules/react-native-web/dist/exports/Text/index.js.bundle?platform=web&dev=true&hot=false&transform.engine=hermes&transform.routerRoot=src%2Fapp&modulesOnly=true&runModule=false#798513620
  // This is generated in a proxy in the server.
  const url = new URL(id, id.startsWith('/') ? 'http://e' : undefined);

  const numericMetroId = parseInt(url.hash.slice(1));
  console.log('__webpack_chunk_load__', id, numericMetroId);
  
  let loadBundlePromise: Promise<void>;
  if (prodFetcher) {
    console.log('__webpack_chunk_load__ > production:', numericMetroId);
    loadBundlePromise = prodFetcher(String(numericMetroId));
  } else {
    const loadBundleAsync = global[`${__METRO_GLOBAL_PREFIX__}__loadBundleAsync`];
    loadBundlePromise = loadBundleAsync(id);
  }

  return loadBundlePromise
    .then(() => {
      const m = __r(numericMetroId);
      rscClientModuleCache.set(id, m);
      console.log(`Remote client module "${id}" >`, m)
      debugger
      return m;
    })
    .catch((e) => {
      console.error('error loading RSC module:', id, e);
      throw e;
    });
};

globalThis.__webpack_require__ = (id) => rscClientModuleCache.get(id);
