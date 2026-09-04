/**
 * @surf/ingestion — Loop A plumbing: detect new More Crypto Online long-form Bitcoin videos
 * and retrieve their transcripts. No LLM calls live here; everything fetched is untrusted data.
 */
export * from "./feed.js";
export * from "./filter.js";
export * from "./watcher.js";
export * from "./transcripts/index.js";
