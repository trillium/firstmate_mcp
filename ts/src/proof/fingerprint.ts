/**
 * Fingerprint barrel (slice 26, task-8pqjb). Implementations live in
 * ./ast-parse.ts, ./normalize.ts, ./find-units.ts, ./units.ts;
 * re-exported here so the `./proof/fingerprint.js` public surface is unchanged.
 */
export { AstGrepNode, AstGrepRoot, ParseApi, getAstGrep, parseTypeScript } from "./ast-parse.js";
export { serializeAstNormalized, sha256Hex, fingerprintAstNode } from "./normalize.js";
export { findTargetUnitNode, findTestUnitNode } from "./find-units.js";
export { fingerprintTargetUnit, fingerprintTestUnit } from "./units.js";
