import {
  NumberParamSpec,
  SelectParamSpec,
  ToolParamSpec,
  ToolbarToolContribution,
} from '../contracts/toolbar-tool.contract';

/** The open parameter dialog, as its template binds it. */
export interface OpenToolParams {
  tool: ToolbarToolContribution;
  /** The tool's live values; the dialog edits them in place. */
  values: Record<string, unknown>;
  /** Each field's spec, already narrowed for the template (an `*ngSwitchCase` does not
   *  narrow a union in the template type checker). */
  fields: { spec: ToolParamSpec; number: NumberParamSpec | null; select: SelectParamSpec | null }[];
}

/**
 * Checkpoint choice and parameter values of the contributed no-prompt tools
 * (`TOOLBAR_TOOLS`), and the generic parameter dialog over them.
 *
 * Values are seeded from the tool's defaults with the active checkpoint's own
 * `ToolModelOption.defaults` on top — they encode the scale and crowding the
 * checkpoint was trained for — lazily, on first use, and re-seeded when the
 * checkpoint changes or the user resets.
 */
export class ToolParamsModel {
  /** Active checkpoint per tool; replaced (not mutated) so the toolbar sees a new reference. */
  toolModelIds: Record<string, string> = {};
  /** Parameter values per tool. */
  toolParams: Record<string, Record<string, unknown>> = {};
  /** The open dialog, built once on open so change detection only reads properties. Null while closed. */
  openParams: OpenToolParams | null = null;

  constructor(readonly tools: ToolbarToolContribution[]) {}

  /** A tool's current values, seeded on first use. */
  paramsFor(toolId: string): Record<string, unknown> {
    const tool = this.find(toolId);
    if (!tool) return {};
    // Through `seed`, never `defaultParams` directly: the first run must already
    // carry the checkpoint's overrides, not only after a checkpoint switch.
    this.toolParams[toolId] ??= this.seed(tool, this.modelIdFor(tool));
    return this.toolParams[toolId]!;
  }

  /** Active checkpoint for a tool, falling back to the tool's own default. */
  modelIdFor(tool: ToolbarToolContribution): string {
    return this.toolModelIds[tool.id] ?? tool.defaultModelId();
  }

  /** Switching checkpoint re-seeds the parameters: the defaults belong to the model. */
  setModel(toolId: string, modelId: string): void {
    const tool = this.find(toolId);
    if (!tool) return;
    this.toolModelIds = { ...this.toolModelIds, [toolId]: modelId };
    tool.onModelChange?.(modelId);
    this.toolParams[toolId] = this.seed(tool, modelId);
    this.rebind(toolId);
  }

  reset(toolId: string): void {
    const tool = this.find(toolId);
    if (!tool) return;
    this.toolParams[toolId] = this.seed(tool, this.modelIdFor(tool));
    this.rebind(toolId);
  }

  open(toolId: string): void {
    const tool = this.find(toolId);
    if (!tool) return;
    this.openParams = {
      tool,
      values: this.paramsFor(toolId),
      fields: tool.params.map((spec) => ({
        spec,
        number: spec.type === 'number' ? spec : null,
        select: spec.type === 'select' ? spec : null,
      })),
    };
  }

  close(): void {
    this.openParams = null;
  }

  /** The values to run a tool with: its parameters plus the active checkpoint. */
  runParams(tool: ToolbarToolContribution): Record<string, unknown> {
    return { ...this.paramsFor(tool.id), modelId: this.modelIdFor(tool) };
  }

  find(toolId: string): ToolbarToolContribution | undefined {
    return this.tools.find((t) => t.id === toolId);
  }

  /** A tool's defaults for a checkpoint, with that checkpoint's own overrides on top. */
  private seed(tool: ToolbarToolContribution, modelId: string): Record<string, unknown> {
    const model = tool.models().find((m) => m.id === modelId);
    return { ...tool.defaultParams(modelId), ...(model?.defaults ?? {}) };
  }

  /** A tool's values object was replaced: point an open dialog for it at the new one. */
  private rebind(toolId: string): void {
    if (this.openParams?.tool.id === toolId) {
      this.openParams = { ...this.openParams, values: this.paramsFor(toolId) };
    }
  }
}
