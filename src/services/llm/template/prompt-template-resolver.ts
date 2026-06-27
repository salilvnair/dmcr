/**
 * Prompt Template Resolver — ConvEngine-style {{variable}} substitution.
 *
 * Instead of code auto-appending toolList, userInput, schema context etc. via
 * string concatenation, callers build a PromptVarMap and the resolver
 * substitutes all {{varName}} placeholders in both system and user prompts.
 *
 * Pattern inspired by ConvEngine's ThymeleafTemplateRenderer / @PromptVar.
 *
 * Supports function-style variables:
 *   {{agentPool}}                → full agent pool (resolved from vars['agentPool'])
 *   {{agentPool['SQL_REFINE']}} → filtered pool (resolved via functionResolvers)
 *   {{agentPool['SQL_REFINE', 'WIKI']}} → multiple agents
 */

export type PromptVarMap = Record<string, string | undefined>;

/** A function resolver handles function-style vars like agentPool['X','Y'] */
export type FunctionResolver = (args: string[]) => string;

/**
 * Resolve {{varName}} placeholders in a prompt template.
 * Variables whose value is undefined or not in the map are left as-is
 * (in strict mode, throws instead).
 *
 * Also resolves function-style variables:
 *   {{fnName['arg1', 'arg2']}} — calls the registered function resolver
 */
export function resolvePromptTemplate(
  template: string,
  vars: PromptVarMap,
  opts?: { strict?: boolean; functionResolvers?: Record<string, FunctionResolver> },
): string {
  if (!template) return template;

  // First pass: resolve function-style vars like {{agentPool['SQL_REFINE', 'WIKI']}}
  let resolved = template.replace(
    /\{\{\s*(\w+)\s*\[\s*([^\]]+)\s*\]\s*\}\}/g,
    (match, fnName: string, argsRaw: string) => {
      const resolver = opts?.functionResolvers?.[fnName];
      if (!resolver) {
        if (opts?.strict) throw new Error(`No function resolver for: {{${fnName}[...]}}`);
        return match;
      }
      // Parse args: 'SQL_REFINE', 'WIKI' → ['SQL_REFINE', 'WIKI']
      const args = argsRaw.split(/\s*,\s*/).map(a => a.replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
      return resolver(args);
    },
  );

  // Second pass: resolve simple {{varName}} placeholders
  resolved = resolved.replace(/\{\{\s*([^{}[\]]+?)\s*\}\}/g, (match, key) => {
    const value = vars[key.trim()];
    if (value !== undefined) return value;
    if (opts?.strict) {
      throw new Error(`Unresolved prompt variable: {{${key.trim()}}}`);
    }
    return match; // leave placeholder intact
  });

  return resolved;
}

/**
 * Resolve both system + user prompts in one shot.
 */
export function resolvePromptPair(
  systemPrompt: string,
  userPrompt: string,
  vars: PromptVarMap,
  opts?: { strict?: boolean; functionResolvers?: Record<string, FunctionResolver> },
): { system: string; user: string } {
  return {
    system: resolvePromptTemplate(systemPrompt, vars, opts),
    user: resolvePromptTemplate(userPrompt, vars, opts),
  };
}
