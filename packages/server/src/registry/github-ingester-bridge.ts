import type { Logger, SourceAdapter } from "@onenomad/przm-cortex-core";
import { GithubAdapter } from "@onenomad/przm-cortex-adapter-github";
import type { ToolContext } from "../mcp/tool.js";
import { ingestRepo } from "../mcp/tools/ingest-repo.js";

export function wireGithubRepoIngester(args: {
  adapters: Record<string, SourceAdapter>;
  toolContext: ToolContext;
  logger: Logger;
}): void {
  const { adapters, toolContext, logger } = args;
  let wired = 0;

  for (const [id, adapter] of Object.entries(adapters)) {
    if (!(adapter instanceof GithubAdapter)) continue;

    adapter.setRepoIngester(async (req) => {
      const input = ingestRepo.inputSchema.parse({
        path: req.path,
        mode: req.mode,
        project: req.project,
        tags: req.tags,
        skipIfUnchanged: req.skipIfUnchanged,
        async: true,
      });
      const result = await ingestRepo.handler(input, toolContext);

      return {
        ...(result.skipped !== undefined ? { skipped: result.skipped } : {}),
        ...(result.filesIngested !== undefined
          ? { filesIngested: result.filesIngested }
          : {}),
        ...(result.chunksIngested !== undefined
          ? { chunksIngested: result.chunksIngested }
          : {}),
        ...(result.memories?.brief !== undefined ||
        result.memories?.decisions !== undefined ||
        result.memories?.references !== undefined
          ? {
              dossierSections:
                (result.memories?.brief ?? 0) +
                (result.memories?.decisions ?? 0) +
                (result.memories?.references ?? 0),
            }
          : {}),
      };
    });
    wired += 1;
    logger.info("github.ingester_wired", { adapter: id });
  }

  if (wired === 0) {
    logger.debug("github.ingester_skipped", { reason: "no_github_adapter" });
  }
}
