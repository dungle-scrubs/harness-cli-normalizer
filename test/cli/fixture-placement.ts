/**
 * Placement helper for disposable CLI fixtures.
 *
 * A disposable CLI fixture allocates its temporary directory under the shared
 * CLI fixture root (`cliFixtureTmpdir()`), which carries the CommonJS package
 * and Git-discovery boundaries those fixtures need. The scanner parses real
 * sources with the TypeScript compiler AST - never a regular expression over
 * code text - so a generated script that merely mentions `mkdtempSync` is not
 * an allocation.
 *
 * A canonical prefix reaches `cliFixtureTmpdir()` as its leading path part:
 * directly, through `join`/`resolve` from `node:path`, through a template or
 * a concatenation, or through a local constant that reaches it the same way.
 * The parts after that leading part must be static and must stay inside the
 * root: a further path argument may not be absolute and may not carry a `..`
 * component, and an unknown dynamic suffix is not canonical.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isNamespaceImport,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isStringLiteral,
  isTemplateExpression,
  isVariableStatement,
  type Node,
  NodeFlags,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/async";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Modules that export the temporary-directory allocation functions. */
const FS_MODULES = new Set(["node:fs", "node:fs/promises"]);

const MKDTEMP_EXPORTS = new Set(["mkdtemp", "mkdtempSync"]);

/** Path builders whose first argument must be the canonical root. */
const PATH_FUNCTIONS = new Set(["join", "resolve"]);

const FIXTURE_MODULE_BASENAME = "fixture-tmpdir";

/** The spellings that module is imported under in this repository. */
const FIXTURE_MODULE_EXTENSIONS = new Set([".js", ".ts", ".mjs", ".cjs"]);

const FIXTURE_EXPORT = "cliFixtureTmpdir";

/** One temporary-directory allocation found in a source file. */
export interface FixtureAllocation {
  /** The file label exactly as the caller passed it. */
  readonly file: string;
  /** The 1-based line of the allocation call. */
  readonly line: number;
  /** The 1-based column of the allocation call. */
  readonly column: number;
  /** The called function, for example `mkdtempSync`. */
  readonly callee: string;
  /** Whether the prefix reaches the shared CLI fixture root. */
  readonly canonical: boolean;
}

/** The import bindings one source file contributes to the analysis. */
interface Bindings {
  /** Local names bound to `mkdtemp` or `mkdtempSync`. */
  readonly mkdtempLocals: Set<string>;
  /** Local names bound to a `node:fs` module namespace. */
  readonly fsNamespaces: Set<string>;
  /** Local names bound to `join` or `resolve` from `node:path`. */
  readonly pathFunctions: Set<string>;
  /** Local names bound to the `node:path` module namespace. */
  readonly pathNamespaces: Set<string>;
  /** Local names bound to `cliFixtureTmpdir`. */
  readonly fixtureLocals: Set<string>;
}

/** The analysis state a prefix expression is resolved against. */
interface PrefixContext {
  readonly bindings: Bindings;
  /** Initializers of local constant declarations, keyed by name. */
  readonly initializers: Map<string, Node | undefined>;
}

/**
 * A prefix expression resolved against the shared CLI fixture root.
 *
 * `root` is the canonical root followed by a known relative suffix, `text` is
 * a fully known string, and `unknown` is everything the scanner cannot show
 * to stay under the root.
 */
type Prefix =
  | { readonly kind: "root"; readonly suffix: string }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "unknown" };

const UNKNOWN: Prefix = { kind: "unknown" };

/** The canonical root, optionally followed by a known relative suffix. */
const rootPrefix = (suffix = ""): Prefix => ({ kind: "root", suffix });

/** A fully known string. */
const textPrefix = (value: string): Prefix => ({ kind: "text", value });

/** Whether a path fragment names a parent directory. */
const hasParentComponent = (value: string): boolean =>
  value.split(/[/\\]/).some((part) => part === "..");

/** Whether a path argument handed to `join` or `resolve` can stay inside a root. */
const isSafePathArgument = (value: string): boolean =>
  !isAbsolute(value) && !hasParentComponent(value);

/**
 * Join two resolved parts, keeping the canonical root in the leading position.
 *
 * A literal in front of the root moves it out of the leading position, so the
 * result is unknown; a literal behind it is a suffix the root absorbs.
 */
const concatPrefix = (left: Prefix, right: Prefix): Prefix => {
  if (left.kind === "unknown" || right.kind === "unknown") return UNKNOWN;
  if (left.kind === "text") {
    if (right.kind === "text") return textPrefix(left.value + right.value);
    return left.value === "" ? right : UNKNOWN;
  }
  return right.kind === "text" ? rootPrefix(left.suffix + right.value) : UNKNOWN;
};

/** Whether a module specifier names the shared CLI fixture helper. */
const isFixtureModule = (specifier: string): boolean => {
  const slash = specifier.lastIndexOf("/");
  const basename = slash === -1 ? specifier : specifier.slice(slash + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return false;
  return (
    basename.slice(0, dot) === FIXTURE_MODULE_BASENAME &&
    FIXTURE_MODULE_EXTENSIONS.has(basename.slice(dot))
  );
};

/** Walk every node of a source file, parents before children. */
const walk = (node: Node, visit: (node: Node) => void): void => {
  node.forEachChild((child) => {
    visit(child);
    walk(child, visit);
  });
};

/** Collect the import bindings a source file declares. */
const collectBindings = (sourceFile: SourceFile): Bindings => {
  const bindings: Bindings = {
    mkdtempLocals: new Set(),
    fsNamespaces: new Set(),
    pathFunctions: new Set(),
    pathNamespaces: new Set(),
    fixtureLocals: new Set(),
  };
  walk(sourceFile, (node) => {
    if (!isImportDeclaration(node)) return;
    const specifier = node.moduleSpecifier;
    if (!isStringLiteral(specifier)) return;
    const spec = specifier.text;
    const clause = node.importClause;
    if (!clause) return;
    if (clause.name) {
      if (FS_MODULES.has(spec)) bindings.fsNamespaces.add(clause.name.text);
      if (spec === "node:path") bindings.pathNamespaces.add(clause.name.text);
    }
    const named = clause.namedBindings;
    if (!named) return;
    if (isNamespaceImport(named)) {
      if (FS_MODULES.has(spec)) bindings.fsNamespaces.add(named.name.text);
      if (spec === "node:path") bindings.pathNamespaces.add(named.name.text);
      return;
    }
    for (const element of named.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      const local = element.name.text;
      if (FS_MODULES.has(spec) && MKDTEMP_EXPORTS.has(imported)) {
        bindings.mkdtempLocals.add(local);
      }
      if (spec === "node:path" && PATH_FUNCTIONS.has(imported)) {
        bindings.pathFunctions.add(local);
      }
      if (isFixtureModule(spec) && imported === FIXTURE_EXPORT) {
        bindings.fixtureLocals.add(local);
      }
    }
  });
  return bindings;
};

/**
 * Collect the initializers of local constant declarations.
 *
 * Only a `const` is followed: a `let` or `var` prefix can be reassigned to a
 * path outside the fixture root after it is initialized, so its value cannot
 * be shown to stay there. A name declared twice is ambiguous, so its
 * initializer is dropped.
 */
const collectInitializers = (sourceFile: SourceFile): Map<string, Node | undefined> => {
  const initializers = new Map<string, Node | undefined>();
  walk(sourceFile, (node) => {
    if (!isVariableStatement(node)) return;
    const list = node.declarationList;
    const isConst = (list.flags & NodeFlags.Const) !== 0;
    for (const declaration of list.declarations) {
      if (!isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      if (initializers.has(name)) {
        initializers.set(name, undefined);
        continue;
      }
      initializers.set(name, isConst ? declaration.initializer : undefined);
    }
  });
  return initializers;
};

/** The allocation function a call expression invokes, when it is one. */
const allocationCallee = (call: Node, bindings: Bindings): string | undefined => {
  if (!isCallExpression(call)) return undefined;
  const callee = call.expression;
  if (isIdentifier(callee)) {
    return bindings.mkdtempLocals.has(callee.text) ? callee.text : undefined;
  }
  if (!isPropertyAccessExpression(callee)) return undefined;
  const name = callee.name.text;
  if (!MKDTEMP_EXPORTS.has(name)) return undefined;
  const object = callee.expression;
  if (isIdentifier(object) && bindings.fsNamespaces.has(object.text)) return name;
  // `fs.promises.mkdtemp` reaches the same function through the namespace.
  if (
    isPropertyAccessExpression(object) &&
    object.name.text === "promises" &&
    isIdentifier(object.expression) &&
    bindings.fsNamespaces.has(object.expression.text)
  ) {
    return name;
  }
  return undefined;
};

/**
 * Resolve a `join` or `resolve` call.
 *
 * The first argument has to be the canonical root; every further argument has
 * to be a static path that is neither absolute nor a parent traversal.
 */
const resolvePathCall = (call: Node, context: PrefixContext, seen: ReadonlySet<string>): Prefix => {
  if (!isCallExpression(call)) return UNKNOWN;
  const [first, ...rest] = call.arguments;
  if (!first) return UNKNOWN;
  const head = resolvePrefix(first, context, seen);
  if (head.kind !== "root") return UNKNOWN;
  let suffix = head.suffix;
  for (const argument of rest) {
    const part = resolvePrefix(argument, context, seen);
    if (part.kind !== "text") return UNKNOWN;
    if (!isSafePathArgument(part.value)) return UNKNOWN;
    suffix += `/${part.value}`;
  }
  return rootPrefix(suffix);
};

/** Resolve a prefix expression against the shared CLI fixture root. */
const resolvePrefix = (
  expression: Node,
  context: PrefixContext,
  seen: ReadonlySet<string>,
): Prefix => {
  if (isParenthesizedExpression(expression)) {
    return resolvePrefix(expression.expression, context, seen);
  }
  if (isAsExpression(expression) || isSatisfiesExpression(expression)) {
    return resolvePrefix(expression.expression, context, seen);
  }
  if (isNonNullExpression(expression)) {
    return resolvePrefix(expression.expression, context, seen);
  }
  if (isStringLiteral(expression)) return textPrefix(expression.text);
  if (isTemplateExpression(expression)) {
    let prefix = textPrefix(expression.head.text);
    for (const span of expression.templateSpans) {
      prefix = concatPrefix(prefix, resolvePrefix(span.expression, context, seen));
      prefix = concatPrefix(prefix, textPrefix(span.literal.text));
    }
    return prefix;
  }
  if (isBinaryExpression(expression)) {
    if (expression.operatorToken.kind !== SyntaxKind.PlusToken) return UNKNOWN;
    return concatPrefix(
      resolvePrefix(expression.left, context, seen),
      resolvePrefix(expression.right, context, seen),
    );
  }
  if (isCallExpression(expression)) {
    const callee = expression.expression;
    if (isIdentifier(callee)) {
      if (context.bindings.fixtureLocals.has(callee.text)) return rootPrefix();
      if (context.bindings.pathFunctions.has(callee.text)) {
        return resolvePathCall(expression, context, seen);
      }
      return UNKNOWN;
    }
    if (
      isPropertyAccessExpression(callee) &&
      PATH_FUNCTIONS.has(callee.name.text) &&
      isIdentifier(callee.expression) &&
      context.bindings.pathNamespaces.has(callee.expression.text)
    ) {
      return resolvePathCall(expression, context, seen);
    }
    return UNKNOWN;
  }
  if (isIdentifier(expression)) {
    const name = expression.text;
    if (seen.has(name)) return UNKNOWN;
    const initializer = context.initializers.get(name);
    if (initializer === undefined) return UNKNOWN;
    const next = new Set(seen);
    next.add(name);
    return resolvePrefix(initializer, context, next);
  }
  return UNKNOWN;
};

/** Whether a prefix expression reaches the shared CLI fixture root. */
const isCanonicalPrefix = (
  expression: Node,
  context: PrefixContext,
  seen: ReadonlySet<string>,
): boolean => {
  const prefix = resolvePrefix(expression, context, seen);
  return prefix.kind === "root" && !hasParentComponent(prefix.suffix);
};

/** Report every allocation in one parsed source file. */
const analyzeSource = (file: string, sourceFile: SourceFile): FixtureAllocation[] => {
  const context: PrefixContext = {
    bindings: collectBindings(sourceFile),
    initializers: collectInitializers(sourceFile),
  };
  const allocations: FixtureAllocation[] = [];
  walk(sourceFile, (node) => {
    const callee = allocationCallee(node, context.bindings);
    if (!callee) return;
    const argument = isCallExpression(node) ? node.arguments[0] : undefined;
    const canonical = argument ? isCanonicalPrefix(argument, context, new Set()) : false;
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    allocations.push({
      file,
      line: start.line + 1,
      column: start.character + 1,
      callee,
      canonical,
    });
  });
  return allocations;
};

/**
 * Scan the given files for temporary-directory allocations.
 *
 * The file labels come back exactly as they were passed in, so a caller
 * decides how a path is spelled in a report.
 *
 * The compiler is reached through its asynchronous client, which speaks the
 * same protocol on Node and on Bun; the synchronous client reads the child's
 * output through Node-only stream internals.
 */
export async function scanFixtureAllocations(
  files: readonly string[],
): Promise<FixtureAllocation[]> {
  if (files.length === 0) return [];
  // The compiler workspace is a disposable fixture too, so it lives under the
  // shared CLI fixture root rather than in the system temp directory.
  const workspace = mkdtempSync(join(cliFixtureTmpdir(), "hcn-fixture-placement-"));
  const api = new API({ cwd: REPO_ROOT });
  try {
    const tsconfig = join(workspace, "tsconfig.json");
    writeFileSync(
      tsconfig,
      `${JSON.stringify(
        {
          compilerOptions: {
            noEmit: true,
            types: [],
            skipLibCheck: true,
            module: "nodenext",
            moduleResolution: "nodenext",
            target: "es2023",
          },
          files: files.map((file) => resolve(REPO_ROOT, file)),
        },
        null,
        2,
      )}\n`,
    );
    const snapshot = await api.updateSnapshot({ openProjects: [tsconfig] });
    const project = snapshot.getProjects()[0];
    if (!project) throw new Error("fixture placement scan: the compiler returned no project");
    const allocations: FixtureAllocation[] = [];
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(resolve(REPO_ROOT, file));
      if (!sourceFile) {
        throw new Error(`fixture placement scan: ${file} is not in the compiler program`);
      }
      allocations.push(...analyzeSource(file, sourceFile));
    }
    return allocations;
  } finally {
    await api.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}
