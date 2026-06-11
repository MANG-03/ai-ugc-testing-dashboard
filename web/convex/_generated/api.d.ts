/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as gemini from "../gemini.js";
import type * as geminiPlans from "../geminiPlans.js";
import type * as generate from "../generate.js";
import type * as generations from "../generations.js";
import type * as models from "../models.js";
import type * as pegasus from "../pegasus.js";
import type * as planSchema from "../planSchema.js";
import type * as promptSkills from "../promptSkills.js";
import type * as sourceVideos from "../sourceVideos.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  gemini: typeof gemini;
  geminiPlans: typeof geminiPlans;
  generate: typeof generate;
  generations: typeof generations;
  models: typeof models;
  pegasus: typeof pegasus;
  planSchema: typeof planSchema;
  promptSkills: typeof promptSkills;
  sourceVideos: typeof sourceVideos;
  workspaces: typeof workspaces;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
