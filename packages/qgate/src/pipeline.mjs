// Pipeline facade (§7 lists `src/pipeline.mjs`). Implements the ordered
// five-stage scheduler on top of the core evaluator, so both the layout contract
// and a single orchestration implementation hold.
export {
  runPipeline,
  stripRuntimeFields,
  runtimeFields,
  resolvePolicyRoot,
} from './core.mjs';

export { stageOrder } from './contract.mjs';
