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
  type ModelEntry,
  type ModelsCatalog,
  type OAuthProviderConfig,
  type PluginsConfig,
  type ProviderEntry,
  type ResolvedConfig,
  type TenantConfig,
  type WorkerSettings,
} from "./config.js";

export { DbPool, getDefaultPool } from "./db-pool.js";
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
  type RequestCtx,
  type TenantMiddlewareOpts,
} from "./middleware.js";

export {
  buildModel,
  findModel,
  getDefaultModel,
  listModels,
  resolveApiKey,
  type ResolvedModelInfo,
} from "./llm.js";
