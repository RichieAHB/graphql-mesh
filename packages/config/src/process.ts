import { resolve } from 'path';
import { MeshResolvedSource } from '@graphql-mesh/runtime';
import {
  ImportFn,
  Logger,
  MeshHandlerLibrary,
  MeshMerger,
  MeshMergerLibrary,
  MeshPubSub,
  MeshTransform,
  MeshTransformLibrary,
  SyncImportFn,
  YamlConfig,
} from '@graphql-mesh/types';
import { IResolvers, Source } from '@graphql-tools/utils';
import { KeyValueCache } from 'fetchache';
import { DocumentNode, print } from 'graphql';
import {
  getPackage,
  resolveAdditionalTypeDefs,
  resolveCache,
  resolvePubSub,
  resolveDocuments,
  resolveLogger,
} from './utils';
import { FsStoreStorageAdapter, MeshStore, InMemoryStoreStorageAdapter } from '@graphql-mesh/store';
import { env } from 'process';
import { pascalCase } from 'pascal-case';
import { camelCase } from 'camel-case';
import { getDefaultImport, getDefaultSyncImport, resolveAdditionalResolvers } from '@graphql-mesh/utils';

export type ConfigProcessOptions = {
  dir?: string;
  importFn?: ImportFn;
  syncImportFn?: SyncImportFn;
  store?: MeshStore;
};

export type ProcessedConfig = {
  sources: MeshResolvedSource<any>[];
  transforms: MeshTransform[];
  additionalTypeDefs: DocumentNode[];
  additionalResolvers: IResolvers[];
  cache: KeyValueCache<string>;
  merger: MeshMerger;
  pubsub: MeshPubSub;
  config: YamlConfig.Config;
  documents: Source[];
  logger: Logger;
  store: MeshStore;
  code: string;
};

function getDefaultMeshStore(dir: string, importFn: ImportFn) {
  const isProd = env.NODE_ENV?.toLowerCase() === 'production';
  const storeStorageAdapter = isProd
    ? new FsStoreStorageAdapter({
        cwd: dir,
        importFn,
      })
    : new InMemoryStoreStorageAdapter();
  return new MeshStore(resolve(dir, '.mesh'), storeStorageAdapter, {
    /**
     * TODO:
     * `mesh start` => { readonly: true, validate: false }
     * `mesh dev` => { readonly: false, validate: true } => validation error should show a prompt for confirmation
     * `mesh validate` => { readonly: true, validate: true } => should fetch from remote and try to update
     * readonly
     */
    readonly: isProd,
    validate: false,
  });
}

export async function processConfig(
  config: YamlConfig.Config,
  options?: ConfigProcessOptions
): Promise<ProcessedConfig> {
  if (config.skipSSLValidation) {
    env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  const importCodes: string[] = [
    `import { GetMeshOptions } from '@graphql-mesh/runtime';`,
    `import { YamlConfig } from '@graphql-mesh/types';`,
  ];
  const codes: string[] = [
    `export const rawConfig: YamlConfig.Config = ${JSON.stringify(config)}`,
    `export function getMeshOptions(): GetMeshOptions {`,
  ];

  const {
    dir,
    importFn = getDefaultImport(dir),
    syncImportFn = getDefaultSyncImport(dir),
    store: providedStore,
  } = options || {};

  if (config.require) {
    await Promise.all(config.require.map(mod => importFn(mod)));
    for (const mod of config.require) {
      importCodes.push(`import '${mod}';`);
    }
  }

  const rootStore = providedStore || getDefaultMeshStore(dir, importFn);

  const {
    cache,
    importCode: cacheImportCode,
    code: cacheCode,
  } = await resolveCache(config.cache, importFn, rootStore, dir);
  importCodes.push(cacheImportCode);
  codes.push(cacheCode);

  const { pubsub, importCode: pubsubImportCode, code: pubsubCode } = await resolvePubSub(config.pubsub, importFn, dir);
  importCodes.push(pubsubImportCode);
  codes.push(pubsubCode);

  const sourcesStore = rootStore.child('sources');
  codes.push(`const sourcesStore = rootStore.child('sources');`);

  const { logger, importCode: loggerImportCode, code: loggerCode } = await resolveLogger(config.logger, importFn, dir);
  importCodes.push(loggerImportCode);
  codes.push(loggerCode);

  codes.push(`const sources = [];`);
  codes.push(`const transforms = [];`);

  const [sources, transforms, additionalTypeDefs, additionalResolvers, merger, documents] = await Promise.all([
    Promise.all(
      config.sources.map<Promise<MeshResolvedSource>>(async (source, sourceIndex) => {
        const handlerName = Object.keys(source.handler)[0].toString();
        const handlerConfig = source.handler[handlerName];
        const handlerVariableName = camelCase(`${source.name}_Handler`);
        const transformsVariableName = camelCase(`${source.name}_Transforms`);
        codes.push(`const ${transformsVariableName} = [];`);
        const [handler, transforms] = await Promise.all([
          await getPackage<MeshHandlerLibrary>({ name: handlerName, type: 'handler', importFn, cwd: dir }).then(
            ({ resolved: HandlerCtor, moduleName }) => {
              const handlerImportName = pascalCase(handlerName + '_Handler');
              importCodes.push(`import ${handlerImportName} from '${moduleName}'`);
              codes.push(`const ${handlerVariableName} = new ${handlerImportName}({
              name: rawConfig.sources[${sourceIndex}].name,
              config: rawConfig.sources[${sourceIndex}].handler.${handlerName},
              baseDir,
              cache,
              pubsub,
              store: sourcesStore.child(rawConfig.sources[${sourceIndex}].name),
              logger: logger.child(rawConfig.sources[${sourceIndex}].name),
              importFn
            });`);
              return new HandlerCtor({
                name: source.name,
                config: handlerConfig,
                baseDir: dir,
                cache,
                pubsub,
                store: sourcesStore.child(source.name),
                logger: logger.child(source.name),
                importFn,
              });
            }
          ),
          Promise.all(
            (source.transforms || []).map(async (t, transformIndex) => {
              const transformName = Object.keys(t)[0].toString();
              const transformConfig = t[transformName];
              const { resolved: TransformCtor, moduleName } = await getPackage<MeshTransformLibrary>({
                name: transformName,
                type: 'transform',
                importFn,
                cwd: dir,
              });

              const transformImportName = pascalCase(transformName + '_Transform');
              importCodes.push(`import ${transformImportName} from '${moduleName}';`);
              codes.push(`${transformsVariableName}.push(
                new ${transformImportName}({
                  apiName: rawConfig.sources[${sourceIndex}].name,
                  config: rawConfig.sources[${sourceIndex}].transforms[${transformIndex}].${transformName},
                  baseDir,
                  cache,
                  pubsub,
                  syncImportFn
                })
              );`);

              return new TransformCtor({
                apiName: source.name,
                config: transformConfig,
                baseDir: dir,
                cache,
                pubsub,
                syncImportFn,
              });
            })
          ),
        ]);

        codes.push(`sources.push({
          name: '${source.name}',
          handler: ${handlerVariableName},
          transforms: ${transformsVariableName}
        })`);

        return {
          name: source.name,
          handler,
          transforms,
        };
      })
    ),
    Promise.all(
      config.transforms?.map(async (t, transformIndex) => {
        const transformName = Object.keys(t)[0].toString();
        const transformConfig = t[transformName];
        const { resolved: TransformLibrary, moduleName } = await getPackage<MeshTransformLibrary>({
          name: transformName,
          type: 'transform',
          importFn,
          cwd: dir,
        });

        const transformImportName = pascalCase(transformName + '_Transform');
        importCodes.push(`import ${transformImportName} from '${moduleName}';`);

        codes.push(`transforms.push(
          new ${transformImportName}({
            apiName: '',
            config: rawConfig.transforms[${transformIndex}].${transformName},
            baseDir,
            cache,
            pubsub,
            syncImportFn
          })
        )`);
        return new TransformLibrary({
          apiName: '',
          config: transformConfig,
          baseDir: dir,
          cache,
          pubsub,
          syncImportFn,
        });
      }) || []
    ),
    resolveAdditionalTypeDefs(dir, config.additionalTypeDefs).then(additionalTypeDefs => {
      codes.push(
        `const additionalTypeDefs = [${(additionalTypeDefs || []).map(
          parsedTypeDefs => `parse(/* GraphQL */\`${print(parsedTypeDefs)}\`),`
        )}] as any[];`
      );
      return additionalTypeDefs;
    }),
    resolveAdditionalResolvers(dir, config.additionalResolvers, syncImportFn, pubsub),
    getPackage<MeshMergerLibrary>({ name: config.merger || 'stitching', type: 'merger', importFn, cwd: dir }).then(
      ({ resolved: Merger, moduleName }) => {
        const mergerImportName = pascalCase(`${config.merger || 'stitching'}Merger`);
        importCodes.push(`import ${mergerImportName} from '${moduleName}';`);
        codes.push(`const merger = new(${mergerImportName} as any)({
        cache,
        pubsub,
        logger: logger.child('${mergerImportName}'),
        store: rootStore.child('${config.merger || 'stitching'}Merger')
      })`);
        return new Merger({
          cache,
          pubsub,
          logger: logger.child(mergerImportName),
          store: rootStore.child(`${config.merger || 'stitching'}Merger`),
        });
      }
    ),
    resolveDocuments(config.documents, dir),
  ]);

  importCodes.push(`import { resolveAdditionalResolvers } from '@graphql-mesh/utils';`);
  codes.push(`const additionalResolvers = resolveAdditionalResolvers(
      baseDir,
      rawConfig.additionalResolvers,
      syncImportFn,
      pubsub
  )`);

  codes.push(`const liveQueryInvalidations = rawConfig.liveQueryInvalidations;`);

  codes.push(`
  return {
    sources,
    transforms,
    additionalTypeDefs,
    additionalResolvers,
    cache,
    pubsub,
    merger,
    logger,
    liveQueryInvalidations,
  };
}`);
  return {
    sources,
    transforms,
    additionalTypeDefs,
    additionalResolvers,
    cache,
    merger,
    pubsub,
    config,
    documents,
    logger,
    store: rootStore,
    code: [...new Set([...importCodes, ...codes])].join('\n'),
  };
}
