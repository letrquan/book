export interface CommandAlias {
  name: string;
  description?: string;
  argumentHint?: string;
  isHidden?: boolean;
}

export interface CommandInvocation {
  name: string;
  rawArguments: string;
}

export type CommandAvailability<Context> =
  boolean | ((context: Context) => boolean | { available: false; reason: string });

export interface CommandDefinition<Context, Effect> {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: CommandAlias[];
  isHidden?: boolean;
  availability?: CommandAvailability<Context>;
  execute(invocation: CommandInvocation, context: Context): Effect;
}

export interface ResolvedCommand<Context, Effect> {
  definition: CommandDefinition<Context, Effect>;
  invokedName: string;
  available: boolean;
  unavailableReason?: string;
}

export type CommandCollisionPolicy = 'error' | 'keep-existing' | 'replace';

function commandNames<Context, Effect>(definition: CommandDefinition<Context, Effect>): string[] {
  return [definition.name, ...(definition.aliases ?? []).map((alias) => alias.name)];
}

function validateDefinition<Context, Effect>(definition: CommandDefinition<Context, Effect>): void {
  const names = commandNames(definition);
  if (names.some((name) => !name || /\s|\//.test(name))) {
    throw new Error(`Invalid command name in definition: ${definition.name}`);
  }
  if (new Set(names).size !== names.length) {
    throw new Error(`Command definition contains a duplicate name or alias: ${definition.name}`);
  }
}

export class CommandRegistry<Context, Effect> {
  private readonly definitions = new Map<string, CommandDefinition<Context, Effect>>();
  private readonly byName = new Map<string, CommandDefinition<Context, Effect>>();

  register(
    definition: CommandDefinition<Context, Effect>,
    collisionPolicy: CommandCollisionPolicy = 'error',
  ): boolean {
    validateDefinition(definition);
    const names = commandNames(definition);
    const collisions = names.filter((name) => this.byName.has(name));
    if (collisions.length > 0) {
      if (collisionPolicy === 'keep-existing') return false;
      if (collisionPolicy === 'error') {
        throw new Error(`Command name collision: ${collisions.join(', ')}`);
      }
      for (const name of collisions) {
        const existing = this.byName.get(name);
        if (!existing) continue;
        this.definitions.delete(existing.name);
        for (const existingName of commandNames(existing)) this.byName.delete(existingName);
      }
    }

    this.definitions.set(definition.name, definition);
    for (const name of names) this.byName.set(name, definition);
    return true;
  }

  registerAll(
    definitions: Array<CommandDefinition<Context, Effect>>,
    collisionPolicy: CommandCollisionPolicy = 'error',
  ): void {
    for (const definition of definitions) this.register(definition, collisionPolicy);
  }

  resolve(name: string, context: Context): ResolvedCommand<Context, Effect> | undefined {
    const definition = this.byName.get(name);
    if (!definition) return undefined;
    const availability = definition.availability;
    const result =
      typeof availability === 'function' ? availability(context) : (availability ?? true);
    if (typeof result === 'object') {
      return {
        definition,
        invokedName: name,
        available: false,
        unavailableReason: result.reason,
      };
    }
    return { definition, invokedName: name, available: result };
  }

  execute(name: string, rawArguments: string, context: Context): Effect | undefined {
    const resolved = this.resolve(name, context);
    if (!resolved) return undefined;
    if (!resolved.available) {
      throw new Error(resolved.unavailableReason ?? `Command /${name} is unavailable.`);
    }
    return resolved.definition.execute({ name: resolved.invokedName, rawArguments }, context);
  }

  getDefinitions(): Array<CommandDefinition<Context, Effect>> {
    return Array.from(this.definitions.values());
  }
}
