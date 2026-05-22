export * from "./types.js";
export {
  createCodeDossierPipeline,
  codeDossierPipeline,
  inferSourceType,
  renderStructuralAsDossier,
  stripDossierPreamble,
} from "./pipeline.js";
export { buildStructuralPayload } from "./structural.js";
export { computeInputsSha, shaOfStructural } from "./sha.js";
export { loadPrompt, renderPrompt } from "./prompts.js";

// Default export so a caller can write:
//   `import codeDossierPipeline from "@onenomad/przm-cortex-pipeline-code-dossier";`
// per the design brief's contract.
export { codeDossierPipeline as default } from "./pipeline.js";
