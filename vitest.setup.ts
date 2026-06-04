import * as fc from "fast-check";

// Global fast-check configuration.
//
// Every property-based test in this project must run a minimum of 100
// iterations (see design.md "Testing Strategy"). Configuring it globally here
// means individual `fc.assert(...)` calls inherit the 100-run default without
// having to repeat `{ numRuns: 100 }` everywhere (they may still raise it).
fc.configureGlobal({ numRuns: 100 });
