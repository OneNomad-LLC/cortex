import type {
  ClassificationContext,
  ClassifiedItem,
  NormalizedItem,
} from "@onenomad/cortex-core";

export type ProjectMapper = (item: NormalizedItem) => {
  projects: string[];
  confidence: number;
} | null;

/**
 * Rule-based classifier for adapters with deterministic mappings.
 * Examples:
 *   - Confluence: space key -> project slug
 *   - Bitbucket: repo name -> project slug
 *   - Obsidian: path prefix -> project slug
 *
 * Returns unclassified if no rule matches; callers can chain to an
 * LLMClassifier for the long tail.
 */
export class RuleClassifier {
  constructor(private readonly mappers: ProjectMapper[]) {}

  async classify(
    item: NormalizedItem,
    _cctx: ClassificationContext,
  ): Promise<ClassifiedItem> {
    for (const mapper of this.mappers) {
      const hit = mapper(item);
      if (hit && hit.projects.length > 0) {
        return {
          ...item,
          projects: hit.projects,
          confidence: hit.confidence,
          classificationMethod: "rule",
        };
      }
    }
    return {
      ...item,
      projects: [],
      confidence: 0,
      classificationMethod: "rule",
    };
  }
}
