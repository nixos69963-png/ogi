/**
 * The tool registry.
 *
 * One place lists what the agent can do, so a capability is switched as a group
 * and a test can assert a tool exists without starting a model.
 */
import { toolSchema } from "#core/schemas.ts";
import type { ProviderTool } from "#core/provider.ts";
import type { ToolSpec } from "#core/types.ts";
import { BROWSER_TOOLS } from "./browser.ts";
import { finish, planUpdate, requestInput } from "./control.ts";
import { delegate } from "./delegate.ts";
import { FILE_TOOLS } from "./files.ts";
import { GITHUB_TOOLS } from "./github.ts";
import { SEARCH_TOOLS } from "./search.ts";
import { SHELL_TOOLS } from "./shell.ts";
import { verify } from "./verify.ts";
import { WEB_TOOLS } from "./web.ts";

export const CONTROL_TOOLS: ToolSpec[] = [planUpdate, finish, requestInput];

export interface ToolGroups {
  files?: boolean;
  shell?: boolean;
  web?: boolean;
  browser?: boolean;
  github?: boolean;
}

export function buildTools(groups: ToolGroups = {}): ToolSpec[] {
  const { files = true, shell = true, web = true, browser = true, github = true } = groups;
  return [
    ...CONTROL_TOOLS,
    verify,
    delegate,
    ...(files ? FILE_TOOLS : []),
    ...(files ? SEARCH_TOOLS : []),
    ...(shell ? SHELL_TOOLS : []),
    ...(web ? WEB_TOOLS : []),
    ...(browser ? BROWSER_TOOLS : []),
    ...(github ? GITHUB_TOOLS : []),
  ];
}

export function toolMap(specs: ToolSpec[]): Map<string, ToolSpec> {
  const map = new Map<string, ToolSpec>();
  for (const spec of specs) map.set(spec.name, spec);
  return map;
}

export function providerTools(specs: ToolSpec[]): ProviderTool[] {
  return specs.map((spec) => toolSchema(spec.name, spec.description, spec.inputSchema) as ProviderTool);
}
