// Public surface of the tenant infrastructure layer.
//
// Higher-level code (routes, middleware, CLI) should import from this
// barrel rather than reaching into individual files. Anything not
// re-exported here is internal and may change without notice.

export {
  ensureInside,
  getDeletedTenantPath,
  getGlobalConfigPath,
  getTenantConfigPath,
  getTenantDbPath,
  getTenantRoot,
  getTenantSecretsDir,
  getTenantSharedDir,
  getTenantUsersDir,
  getTenantsRoot,
  getTenantWorkspaceDir,
  getTianshuHome,
  getUserHomeDir,
  isSoftDeletedDirName,
  isSystemReserved,
  SOFT_DELETE_SUFFIX,
} from "./paths.js";

export {
  InvalidTenantIdError,
  isValidTenantId,
  validateTenantId,
} from "./tenant-id.js";

export {
  DEFAULTS,
  loadGlobalConfig,
  loadTenantConfig,
  mergeConfigs,
  resolveTenantConfig,
  TenantConfigForbiddenFieldError,
  writeGlobalConfig,
  writeTenantConfig,
  type BrandingConfig,
  type GlobalConfig,
  type McpServerEntry,
  type McpUserConfig,
  type ModelEntry,
  type ModelsCatalog,
  type ModelResilienceConfig,
  type OAuthProviderConfig,
  type PluginsConfig,
  type ProviderEntry,
  type ResolvedConfig,
  type TenantConfig,
  type WorkerSettings,
} from "./config.js";

export { McpManager, type McpUserToolsetSnapshot } from "./mcp-manager.js";

export { DbPool, getDefaultPool } from "./db-pool.js";

export {
  buildTenantUserUrl,
  computeServerEffectivePublicUrl,
  DEFAULT_SERVER_PORT,
  DEFAULT_WEB_PORT,
  detectInstallMode,
  resolveLocalServerBaseUrl,
  resolvePublicBaseUrl,
  resolveServerPort,
  resolveWebPort,
  type InstallMode,
  type UrlContext,
} from "./urls.js";
export { runMigrations, MIGRATIONS } from "./migrations/index.js";

export { TenantContext, buildTenantContext } from "./tenant-context.js";

export {
  GlobalOps,
  TenantAlreadyExistsError,
  TenantNotFoundError,
  type GlobalOpsOptions,
} from "./global-ops.js";

export {
  getTemplatesDir,
  ensureTenantConfigDefaults,
  seedTenantWorkspace,
  seedUserWorkspace,
  TENANT_TEMPLATE,
  USER_TEMPLATE,
} from "./templates.js";

export {
  bootstrapDevTenantIfNeeded,
  DEV_TENANT_ID,
  DEV_USER_EXTERNAL_ID,
  DEV_USER_ID,
  DEV_USER_PROVIDER,
  type BootstrapResult,
} from "./dev-mode.js";

export {
  tenantMiddleware,
  DEV_RESOLVER_CHAIN,
  runIdentityChain,
  cookieResolver,
  envResolver,
  defaultDevResolver,
  type RequestCtx,
  type TenantMiddlewareOpts,
  type IdentityResolver,
  type IdentityResolution,
} from "./middleware.js";

export {
  buildResolverChain,
  assertAuthArmable,
  sessionResolver,
  denyResolver,
} from "./auth/resolvers.js";

export {
  buildModel,
  findModel,
  getDefaultModel,
  listModels,
  resolveApiKey,
  type ResolvedModelInfo,
} from "./llm.js";

export { buildModels, type BuildModelsOptions } from "./pi-models.js";
export {
  resolveResilience,
  wrapStreamFn,
  retryCompletion,
  classifyError,
  backoffDelayMs,
  type ResolvedResilience,
  type RetryClassification,
  type RetryNotice,
  type WrapStreamDeps,
} from "./model-retry.js";
