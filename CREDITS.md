# Credits and third-party notices

## Context inspection ideas

The context receipts, explicit context preparation and retrieval diagnostics were informed by [Paseo Context](https://github.com/kogekiplay/paseo-context), maintained by kogekiplay, and its upstream [dsh-context](https://github.com/bowenliang123/dsh-context), by bowenliang123.

Reference inspected: Paseo Context 0.2.8, revision [`f93dbe7d815d3c84bd00472ebffbe7d23b9be468`](https://github.com/kogekiplay/paseo-context/tree/f93dbe7d815d3c84bd00472ebffbe7d23b9be468), distributed under Apache-2.0. This release contains an original implementation using Contextualise's existing producers and Paseo components. It does not incorporate Paseo Context's code, screenshots, UI bundle, native log parsers or upstream vendored assets. Referencing that project's license does not relicense Contextualise.

## History recovery

The history-recovery feature was adapted from the recovery half of [pi-context-paging](https://pi.dev/packages/@rochecompaan/pi-context-paging), as documented in the README and changelog. This release does not introduce additional copied implementation from that package.

## Language grammars

The tree-sitter grammars retain their original license texts with their distributions:

- [JavaScript grammar license](grammars/javascript/LICENSE)
- [TypeScript grammar license](grammars/typescript/LICENSE)
- [Python grammar license](grammars/python/LICENSE)
- [Go grammar license](grammars/go/LICENSE)

## Dependencies

Dependencies retain their own licenses in their installed packages. This release adds no runtime dependencies. Paseo supplies its plugin SDK and client runtime components; this plugin does not redistribute Paseo itself.
