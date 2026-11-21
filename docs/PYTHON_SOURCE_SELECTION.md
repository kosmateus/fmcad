# Python source selection: analysis tools

## Required analysis

The CAD runtime is a sequence of source units sharing a Python namespace. An
import graph alone does not describe its dependencies. Selection must account
for lexical bindings, executable initialization, callable references, type
annotations, ordered handler registration, and captures of previous handlers.
The checker must inspect the selected executable source, not substitute stubs.

## Library assessment

- **CPython `ast` and `symtable`** provide the parser, node positions, source
  segments, and compiler-derived lexical scope information. These are reusable
  analysis primitives, not a reachability or effect analysis. `symtable` does
  not determine the runtime targets of arbitrary attribute accesses.
  Sources: [AST](https://docs.python.org/3/library/ast.html),
  [symbol tables](https://docs.python.org/3/library/symtable.html).
- **LibCST** supplies formatting-preserving transformations, byte spans, scope
  assignments/accesses, and qualified names. Its scope documentation explicitly
  excludes arbitrary attribute-name resolution and describes limitations for
  string forward annotations. It would improve complex source rewriting, but
  would not remove the need for registry, initialization, or reachability policy.
  Source: [metadata providers and limitations](https://libcst.readthedocs.io/en/latest/metadata.html).
- **astroid** supplies richer static inference, including multiple possible
  values and `Uninferable`. An inference result is not a certificate that deleting
  other definitions preserves behavior. Its manager also supports loading and
  inspecting extension modules; an offline adapter would need to constrain those
  paths rather than inherit them accidentally.
  Sources: [inference](https://pylint.readthedocs.io/projects/astroid/en/latest/inference.html),
  [manager implementation](https://github.com/pylint-dev/astroid/blob/main/astroid/manager.py).
- **modulegraph** computes dependencies between imported modules, primarily from
  import bytecode. That granularity does not solve selection of definitions in
  the shared CAD namespace.
  Source: [modulegraph](https://modulegraph.readthedocs.io/en/latest/).
- **Vulture** finds unused names but explicitly ignores scopes. It assigns only
  60% confidence to unused functions, classes, methods, and attributes, and its
  documented reflection example incorrectly marks a called method as unused.
  Its whitelist approach is unsuitable for automatic dependency selection.
  Source: [algorithm, confidence, and example](https://github.com/jendrikseipp/vulture/blob/main/README.md).

## Recommendation

Reuse CPython's parser and compiler symbol tables behind the existing offline
Python adapter. Keep selection policy in the pure application core. Do not
replace those primitives with a hand-written parser, or treat a linter's unused
name report as permission to remove source. Introduce LibCST only if the actual
rewrite requirements justify a second parser and its packaging dependency;
source-span extraction alone does not require it.

The application still needs an explicit dependency closure over parser facts.
That closure must preserve initialization and ordered registry effects, retain
dependencies of annotations in the exact checked source, and report conservative
retention when targets cannot be resolved. No evaluated library supplies a
drop-in semantics-preserving minimum for arbitrary dynamic Python. Selection is
therefore relative to proven dependencies, with unresolved reflection retaining
the affected namespace. Lossless transport encoding is a separate step and is
not evidence that source selection is complete.

## Selection boundaries

The public CAD wrapper carries the operation as a literal call argument, so the
same dependency analysis can inspect every operation without an operation-specific
allowlist. Arbitrary user scripts keep the stricter reflection and namespace-escape
checks; a generated-wrapper flag is internal to the preparation adapter.

`prepareCadBundle` is the shared selection boundary for generated CAD, native
actions, atomic programs, and SDK probes. `prepareRunScript` uses the same selector
for helper-enabled user code. Unversioned user code keeps its existing identity
runtime instead of receiving the CAD library. These adapters are shared by the
CLI and MCP worker service. Embedded user source is analysed as user code rather
than inheriting trust from its enclosing generated wrapper. An incomplete source
fragment without an executable entrypoint retains the inventory because its
future callers are not known.

`cadBundleUnits` remains the complete source inventory used by identity and ABI
checks. It is distinct from outgoing program preparation. Selection repeatedly
analyses the remaining declarations until stable, so references from deleted
bodies cannot keep additional units alive. Lossless encoding and final-wire
fencing remain at the common native transport boundary.

Declaration selection keeps executable initializers as roots. It can remove an
unreferenced plain declaration or binding only when its construction is inert;
unknown decorators, evaluated defaults and class initialization remain roots.
Type-checking-only declarations participate in the same reference closure.
Standard `typing.Protocol` declarations and built-in descriptors are modelled
only when their names have not been rebound in the source inventory.

Literal registry entries are individually selectable when their values are
references or provably inert closure factories. Retained entries and source units
keep their original order. Reads that capture predecessor handlers retain the
referenced definitions; there is no last-definition-only shortcut. Registry
expressions outside this proven subset are retained. Original UTF-8 source spans
are removed without reparsing text heuristically, and source hashes identify the
resulting code supplied to the checker and transport.

Finite registry comprehensions with inert closure values can be lowered to
individual literal entries. Closed direct calls then supply literal argument
bindings through `inspect.Signature.bind`, including captured factory parameters.
A function is specialized only where every observed caller agrees and no alias,
rebinding, or unresolved call invalidates the binding. Recognized closure
decorators additionally require proof that the relevant argument is forwarded
unchanged. Bindings decide branch feasibility; they do not replace argument
objects, evaluated defaults, or their identities. Unknown conditions retain their
branches, including side effects in short-circuit prefixes. The compiler symbol
tables veto a rewrite that would change the binding of a retained reference;
generator-shape changes are also rejected.

Method selection starts from explicit construction and propagates receiver sets
through assignments and closed direct calls. Method receiver parameters are
qualified by their owning class. Other names are conservatively unioned across
scopes, so uncertainty can increase retention but cannot prove a method dead.
Aliases passed to unknown code, reflective access, unknown subtypes, class-object
escapes, decorators, and ambiguous receivers retain the class. Implicit special
methods and effectful method declarations remain roots. In particular, the
existing CAD dispatch callbacks can still prevent trimming `CadContext`; the
selector does not pretend those calls have a proven closed receiver graph.

Source rewrites and declaration deletion share a pass over original UTF-8 spans.
Identical preparation requests reuse an immutable result keyed by the complete
source inventory, exact submitted source, generated/user mode, and parser bytes.
This reduces repeated analysis, not cold preparation cost. Every prepared program
still enters the exact-source checker and transport fence. These are conservative
boundaries, not claims that every retained byte is necessary for one execution.
